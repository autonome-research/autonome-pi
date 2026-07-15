/**
 * /detach extension for pi
 *
 * Lets an interactive pi session survive an SSH logout by handing it off to tmux.
 *
 * Important behavior:
 * - If pi is already running inside tmux, /detach detaches the current tmux client;
 *   the exact same pi process keeps running.
 * - If pi is not inside tmux, /detach cannot move the running process. Instead it
 *   creates a detached tmux session that waits for this pi process to exit, then
 *   starts a fresh pi process on the same session file with an optional prompt.
 */

import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { execFile as execFileCb } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const DETACH_STATE_TYPE = "detach-state";
const MAX_TMUX_NAME_LENGTH = 80;
const TMUX_TIMEOUT_MS = 5_000;
const WRAPPER_READY_TIMEOUT_MS = 2_000;
const PROCESS_LAUNCH_CWD = process.cwd();

const DEFAULT_RESUME_PROMPT = `The previous pi process was detached mid-turn and may have been interrupted.
Continue the user's current task to completion. Review the existing session context and current workspace state before proceeding. If the last operation may have been interrupted, verify the state before repeating or modifying anything. When finished, summarize what changed and any remaining follow-up.`;

export type DetachOptions = {
	name?: string;
	now?: boolean;
	wait?: boolean;
	prompt: string;
};

type LastDetach = {
	name: string;
	cwd: string;
	sessionFile?: string;
	createdAt: number;
};

let lastDetach: LastDetach | undefined;

export default function detachExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		lastDetach = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === DETACH_STATE_TYPE && isLastDetach(entry.data)) {
				lastDetach = entry.data;
			}
		}
	});

	pi.registerCommand("detach", {
		description: "Detach pi into tmux so work can continue after logout. Usage: /detach [--name <tmux-name>] [--now|--wait] [prompt]",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/detach is only available in interactive TUI mode.", "error");
				return;
			}

			let options: DetachOptions;
			try {
				options = parseArgs(args);
			} catch (error) {
				ctx.ui.notify(`Invalid /detach arguments: ${errorMessage(error)}`, "error");
				return;
			}

			if (process.env.TMUX) {
				await detachCurrentTmuxClient(pi, ctx, options);
				return;
			}

			if (options.now && ctx.hasPendingMessages()) {
				ctx.ui.notify(
					"Cannot use /detach --now while steering or follow-up messages are queued. Wait for them to run, or retrieve them before detaching.",
					"error",
				);
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify(
					"Cannot detach: this pi session is not backed by a session file. Start pi without --no-session, or start pi inside tmux first.",
					"error",
				);
				return;
			}

			const tmuxOk = await hasTmux();
			if (!tmuxOk) {
				ctx.ui.notify("Cannot detach: tmux is not installed or not on PATH.", "error");
				return;
			}

			// Explicit prompts always run. Otherwise the wrapper uses the settled
			// marker to decide whether interrupted work needs a continuation prompt.
			const prompt = options.prompt.trim() || undefined;
			const tmuxName = await chooseTmuxName(options.name, ctx.cwd, sessionFile);
			const piCommandValue = process.env.PI_DETACH_PI_COMMAND || "pi";
			let launchArgs: string[];
			try {
				launchArgs = preservedLaunchArgs(process.argv.slice(2), pi.getActiveTools(), PROCESS_LAUNCH_CWD, {
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					thinking: pi.getThinkingLevel(),
					trusted: ctx.isProjectTrusted(),
				});
			} catch (error) {
				ctx.ui.notify(`Cannot safely preserve this Pi invocation: ${errorMessage(error)}`, "error");
				return;
			}
			try {
				await preflightPiCommand(piCommandValue, ctx.cwd);
			} catch (error) {
				ctx.ui.notify(`Cannot start the resumed Pi command: ${errorMessage(error)}`, "error");
				return;
			}

			let wrapperPath: string;
			let readyPath: string;
			let cancelPath: string;
			let settledPath: string;
			try {
				({ wrapperPath, readyPath, cancelPath, settledPath } = await writeWrapperScript({
					oldPid: process.pid,
					cwd: ctx.cwd,
					sessionFile,
					prompt,
					fallbackOnUnsettled: !prompt,
					piCommandValue,
					launchArgs,
				}));
			} catch (error) {
				ctx.ui.notify(`Failed to prepare tmux handoff: ${errorMessage(error)}`, "error");
				return;
			}

			try {
				const tmuxCommand = `exec ${shellQuote(wrapperPath)}`;
				await execFile("tmux", ["new-session", "-d", "-s", tmuxName, "-c", ctx.cwd, tmuxCommand], {
					timeout: TMUX_TIMEOUT_MS,
				});
			} catch (error) {
				// A timeout can happen after tmux accepted the command. The cancellation
				// marker stops an already-open wrapper; unlinking stops a not-yet-open one.
				await cancelTmuxHandoff(tmuxName, wrapperPath, readyPath, cancelPath, settledPath, false);
				ctx.ui.notify(`Failed to create tmux session: ${errorMessage(error)}`, "error");
				return;
			}

			if (!(await waitForWrapperReady(readyPath))) {
				await cancelTmuxHandoff(tmuxName, wrapperPath, readyPath, cancelPath, settledPath, true);
				ctx.ui.notify("The tmux handoff wrapper did not start; the current Pi process will remain attached.", "error");
				return;
			}
			await unlink(readyPath).catch(() => undefined);

			// Recheck immediately before the synchronous abort/shutdown sequence. A
			// message may have been queued while command preflight or wrapper startup ran.
			if (options.now && ctx.hasPendingMessages()) {
				await cancelTmuxHandoff(tmuxName, wrapperPath, readyPath, cancelPath, settledPath, true);
				ctx.ui.notify(
					"The tmux handoff was cancelled because a steering or follow-up message arrived. Wait for it to run, or retrieve it before detaching.",
					"warning",
				);
				return;
			}

			let interrupted = false;
			try {
				if (!options.now) {
					// Mark graceful completion only after the agent and all queued messages
					// settle. The wrapper falls back to a continuation prompt if this process
					// disappears (for example, on SSH logout) before the marker is durable.
					while (true) {
						await ctx.waitForIdle();
						await writeFile(settledPath, "settled\n", { mode: 0o600 });
						if (ctx.isIdle() && !ctx.hasPendingMessages()) break;
						await unlink(settledPath).catch(() => undefined);
					}
				} else if (ctx.isIdle()) {
					await writeFile(settledPath, "settled\n", { mode: 0o600 });
					interrupted = !ctx.isIdle();
					if (interrupted) await unlink(settledPath).catch(() => undefined);
				} else {
					interrupted = true;
				}
			} catch (error) {
				await cancelTmuxHandoff(tmuxName, wrapperPath, readyPath, cancelPath, settledPath, true);
				ctx.ui.notify(`The tmux handoff was cancelled before shutdown: ${errorMessage(error)}`, "error");
				return;
			}

			// No asynchronous work may occur between this final guard and abort/shutdown.
			if (options.now && ctx.hasPendingMessages()) {
				await cancelTmuxHandoff(tmuxName, wrapperPath, readyPath, cancelPath, settledPath, true);
				ctx.ui.notify("The tmux handoff was cancelled because a queued message arrived.", "warning");
				return;
			}

			lastDetach = {
				name: tmuxName,
				cwd: ctx.cwd,
				sessionFile,
				createdAt: Date.now(),
			};
			try {
				pi.appendEntry(DETACH_STATE_TYPE, lastDetach);
			} catch (error) {
				ctx.ui.notify(`tmux handoff started, but its status could not be saved: ${errorMessage(error)}`, "warning");
			}

			const attachCommand = `tmux attach -t =${tmuxName}`;
			ctx.ui.notify(`Detached handoff started in tmux session '${tmuxName}'. Reattach with: ${attachCommand}`, "info");

			// Outside tmux this is a handoff, not live process migration. The wrapper waits
			// for this process to exit before opening the same session file in tmux.
			if (interrupted) ctx.abort();
			ctx.shutdown();
		},
	});

	pi.registerCommand("detach-status", {
		description: "Show the last tmux session created by /detach",
		handler: async (_args, ctx) => {
			if (!lastDetach) {
				ctx.ui.notify("No /detach handoff has been created by this extension instance.", "info");
				return;
			}

			const exists = await tmuxSessionExists(lastDetach.name);
			ctx.ui.notify(
				[
					`Last detach: ${lastDetach.name}`,
					`Status: ${exists ? "running" : "not found"}`,
					`Attach: tmux attach -t =${lastDetach.name}`,
					`Cwd: ${lastDetach.cwd}`,
					`Session: ${lastDetach.sessionFile ?? "(ephemeral)"}`,
				].join("\n"),
				exists ? "info" : "warning",
			);
		},
	});
}

async function detachCurrentTmuxClient(pi: ExtensionAPI, ctx: ExtensionCommandContext, options: DetachOptions) {
	if (options.now && ctx.hasPendingMessages()) {
		ctx.ui.notify(
			"Cannot use /detach --now while steering or follow-up messages are queued. Wait for them to run, or retrieve them before detaching.",
			"error",
		);
		return;
	}

	if (!ctx.isIdle() && !options.now) {
		ctx.ui.notify("Waiting for Pi to become idle before detaching the tmux client...", "info");
		await ctx.waitForIdle();
	}

	let tmuxName: string | undefined;
	if (options.name) {
		tmuxName = sanitizeTmuxName(options.name);
		try {
			await execFile("tmux", ["rename-session", tmuxName], { timeout: TMUX_TIMEOUT_MS });
		} catch (error) {
			ctx.ui.notify(`Failed to rename the current tmux session: ${errorMessage(error)}`, "error");
			return;
		}
	} else {
		try {
			const result = await execFile("tmux", ["display-message", "-p", "#S"], { timeout: TMUX_TIMEOUT_MS });
			tmuxName = String(result.stdout).trim() || undefined;
		} catch {
			// Detach can still proceed; only the status/attach hint will be less specific.
		}
	}

	const attachCommand = tmuxName ? `tmux attach -t =${tmuxName}` : "tmux attach";
	ctx.ui.notify(`Detaching current tmux client. Reattach with: ${attachCommand}`, "info");

	try {
		await execFile("tmux", ["detach-client"], { timeout: TMUX_TIMEOUT_MS });
	} catch (error) {
		ctx.ui.notify(`Failed to detach tmux client: ${errorMessage(error)}`, "error");
		return;
	}

	if (tmuxName) {
		lastDetach = {
			name: tmuxName,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			createdAt: Date.now(),
		};
		try {
			pi.appendEntry(DETACH_STATE_TYPE, lastDetach);
		} catch {
			// The client is already detached; status persistence is best effort.
		}
	}

	// A queue could appear while detach-client was in flight. Never abort in that
	// case: the same Pi process remains alive in tmux and can drain it safely.
	const interrupted = options.now && !ctx.hasPendingMessages() && !ctx.isIdle();
	if (interrupted) ctx.abort();
	const prompt = choosePrompt(options.prompt, !interrupted);
	if (prompt) {
		if (ctx.isIdle()) {
			pi.sendUserMessage(prompt);
		} else {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		}
	}
}

export function isLastDetach(value: unknown): value is LastDetach {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<LastDetach>;
	return (
		typeof candidate.name === "string" &&
		candidate.name.length > 0 &&
		typeof candidate.cwd === "string" &&
		(candidate.sessionFile === undefined || typeof candidate.sessionFile === "string") &&
		typeof candidate.createdAt === "number"
	);
}

export function parseArgs(raw: string): DetachOptions {
	const tokens = shellishSplit(raw.trim());
	let name: string | undefined;
	let now = false;
	let wait = false;
	let parsingOptions = true;
	const promptParts: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (parsingOptions && token === "--") {
			parsingOptions = false;
			continue;
		}
		if (parsingOptions && token === "--now") {
			now = true;
			continue;
		}
		if (parsingOptions && token === "--wait") {
			wait = true;
			continue;
		}
		if (parsingOptions && (token === "--name" || token === "-n")) {
			const value = tokens[i + 1];
			if (!value || value.startsWith("-")) {
				throw new Error(`${token} requires a tmux session name`);
			}
			name = value;
			i++;
			continue;
		}
		if (parsingOptions && token.startsWith("--name=")) {
			name = token.slice("--name=".length);
			if (!name) throw new Error("--name requires a tmux session name");
			continue;
		}
		if (parsingOptions && token.startsWith("-")) {
			throw new Error(`unknown option: ${token}`);
		}

		parsingOptions = false;
		promptParts.push(token);
	}

	if (now && wait) throw new Error("--now and --wait cannot be used together");
	return { name, now, wait, prompt: promptParts.join(" ") };
}

export function choosePrompt(userPrompt: string, idle: boolean): string | undefined {
	const trimmed = userPrompt.trim();
	if (trimmed) return trimmed;
	return idle ? undefined : DEFAULT_RESUME_PROMPT;
}

async function hasTmux(): Promise<boolean> {
	try {
		await execFile("tmux", ["-V"], { timeout: TMUX_TIMEOUT_MS });
		return true;
	} catch {
		return false;
	}
}

async function chooseTmuxName(requested: string | undefined, cwd: string, sessionFile: string): Promise<string> {
	const base = sanitizeTmuxName(requested || defaultTmuxName(cwd, sessionFile));
	for (let index = 1; ; index++) {
		const candidate = tmuxNameWithSuffix(base, index);
		if (!(await tmuxSessionExists(candidate))) return candidate;
	}
}

export function defaultTmuxName(cwd: string, sessionFile: string): string {
	const project = sanitizeTmuxName(basename(cwd) || "session");
	const hash = createHash("sha1").update(sessionFile).digest("hex").slice(0, 7);
	const prefix = "pi-";
	const suffix = `-${hash}`;
	const projectLimit = MAX_TMUX_NAME_LENGTH - prefix.length - suffix.length;
	return `${prefix}${project.slice(0, projectLimit)}${suffix}`;
}

export function tmuxNameWithSuffix(base: string, index: number): string {
	const suffix = index > 1 ? `-${index}` : "";
	const stemLimit = Math.max(1, MAX_TMUX_NAME_LENGTH - suffix.length);
	return `${base.slice(0, stemLimit)}${suffix}`;
}

export function sanitizeTmuxName(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return (sanitized || "pi-detached").slice(0, MAX_TMUX_NAME_LENGTH);
}

async function tmuxSessionExists(name: string): Promise<boolean> {
	try {
		await execFile("tmux", ["has-session", "-t", `=${name}`], { timeout: TMUX_TIMEOUT_MS });
		return true;
	} catch {
		return false;
	}
}

async function cancelTmuxHandoff(
	name: string,
	wrapperPath: string,
	readyPath: string,
	cancelPath: string,
	settledPath: string,
	killSession: boolean,
): Promise<void> {
	await writeFile(cancelPath, "cancel\n", { mode: 0o600 }).catch(() => undefined);
	await unlink(wrapperPath).catch(() => undefined);
	if (killSession) {
		await execFile("tmux", ["kill-session", "-t", `=${name}`], { timeout: TMUX_TIMEOUT_MS }).catch(() => undefined);
	}
	await Promise.all([
		unlink(readyPath).catch(() => undefined),
		unlink(settledPath).catch(() => undefined),
	]);
	if (killSession) {
		await unlink(cancelPath).catch(() => undefined);
	} else {
		// If tmux never created (or already removed) the session, no wrapper can
		// consume the marker and it is safe to clean up here.
		await delay(100);
		if (!(await tmuxSessionExists(name))) await unlink(cancelPath).catch(() => undefined);
	}
}

async function preflightPiCommand(value: string, cwd: string): Promise<void> {
	const parts = shellishSplit(value);
	const [command = "pi", ...args] = parts;
	await execFile(command, [...args, "--version"], { cwd, timeout: TMUX_TIMEOUT_MS });
}

async function waitForWrapperReady(readyPath: string): Promise<boolean> {
	const deadline = Date.now() + WRAPPER_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			await access(readyPath);
			return true;
		} catch {
			await delay(25);
		}
	}
	return false;
}

async function writeWrapperScript(input: {
	oldPid: number;
	cwd: string;
	sessionFile: string;
	prompt?: string;
	fallbackOnUnsettled: boolean;
	piCommandValue: string;
	launchArgs: string[];
}): Promise<{ wrapperPath: string; readyPath: string; cancelPath: string; settledPath: string }> {
	const dir = join(getAgentDir(), "tmp", "detach");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700).catch(() => undefined);

	const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
	const wrapperPath = join(dir, `detach-${id}.sh`);
	const readyPath = join(dir, `detach-${id}.ready`);
	const cancelPath = join(dir, `detach-${id}.cancel`);
	const settledPath = join(dir, `detach-${id}.settled`);
	const envExports = preservedEnvironmentExports();
	const piCommand = shellCommand(input.piCommandValue);
	const preservedArgs = input.launchArgs.map(shellQuote).join(" ");
	const baseLaunchCommand = `exec ${piCommand}${preservedArgs ? ` ${preservedArgs}` : ""} --session ${shellQuote(input.sessionFile)}`;
	let launchScript = baseLaunchCommand;
	if (input.prompt) {
		launchScript = `rm -f ${shellQuote(settledPath)} 2>/dev/null || true
${baseLaunchCommand} ${shellQuote(safeInitialPrompt(input.prompt))}`;
	} else if (input.fallbackOnUnsettled) {
		launchScript = `if [[ ! -e ${shellQuote(settledPath)} ]]; then
  rm -f ${shellQuote(readyPath)} ${shellQuote(cancelPath)} 2>/dev/null || true
  ${baseLaunchCommand} ${shellQuote(safeInitialPrompt(DEFAULT_RESUME_PROMPT))}
fi
rm -f ${shellQuote(settledPath)} 2>/dev/null || true
${baseLaunchCommand}`;
	}

	const script = `#!/usr/bin/env bash
set -euo pipefail
rm -f "$0" 2>/dev/null || true

# Preserve important environment from the original pi process. This is useful
# for API-key based auth and version-manager PATHs when the tmux server already
# existed before /detach was called. Do not unset TMUX here: tmux sets it
# for panes, and pi uses it to recognize that it is already inside tmux.
${envExports}

check_cancelled() {
  if [[ -e ${shellQuote(cancelPath)} ]]; then
    rm -f ${shellQuote(readyPath)} ${shellQuote(cancelPath)} ${shellQuote(settledPath)} 2>/dev/null || true
    exit 0
  fi
}

check_cancelled
printf 'ready\n' > ${shellQuote(readyPath)}

OLD_PID=${input.oldPid}
while kill -0 "$OLD_PID" 2>/dev/null; do
  check_cancelled
  sleep 0.2
done
check_cancelled

cd ${shellQuote(input.cwd)}
echo "pi /detach handoff starting in tmux."
echo "cwd: ${escapeForDoubleQuotedEcho(input.cwd)}"
echo "session: ${escapeForDoubleQuotedEcho(input.sessionFile)}"
echo
rm -f ${shellQuote(readyPath)} ${shellQuote(cancelPath)} 2>/dev/null || true
${launchScript}
`;

	await writeFile(wrapperPath, script, { mode: 0o700 });
	await chmod(wrapperPath, 0o700).catch(() => undefined);
	return { wrapperPath, readyPath, cancelPath, settledPath };
}

export function preservedEnvironmentExports(environment: NodeJS.ProcessEnv = process.env): string {
	const exact = new Set([
		"HOME",
		"USER",
		"LOGNAME",
		"SHELL",
		"PATH",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"COLORTERM",
		"EDITOR",
		"VISUAL",
		"SSH_AUTH_SOCK",
		"GPG_AGENT_INFO",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"ALL_PROXY",
		"NO_PROXY",
		"http_proxy",
		"https_proxy",
		"all_proxy",
		"no_proxy",
	]);

	const prefixes = [
		"PI_",
		"XDG_",
		"ANTHROPIC_",
		"ANT_LING_",
		"OPENAI_",
		"NVIDIA_",
		"AZURE_",
		"GOOGLE_",
		"GEMINI_",
		"VERTEX_",
		"AWS_",
		"MISTRAL_",
		"GROQ_",
		"CEREBRAS_",
		"CLOUDFLARE_",
		"XAI_",
		"OPENROUTER_",
		"VERCEL_",
		"AI_GATEWAY_",
		"ZAI_",
		"HUGGINGFACE_",
		"HF_",
		"FIREWORKS_",
		"TOGETHER_",
		"KIMI_",
		"MOONSHOT_",
		"MINIMAX_",
		"MIMO_",
		"DEEPSEEK_",
		"GITHUB_",
		"GH_",
		"GITLAB_",
		"COPILOT_",
		"OLLAMA_",
		"OPENCODE_",
		"XIAOMI_",
	];
	for (const key of (environment.PI_DETACH_PRESERVE_ENV || "").split(",")) {
		const trimmed = key.trim();
		if (isSafeEnvKey(trimmed)) exact.add(trimmed);
	}

	const lines: string[] = [];

	for (const [key, value] of Object.entries(environment)) {
		if (value === undefined || key === "TMUX") continue;
		if (!isSafeEnvKey(key)) continue;
		const keep = exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix));
		if (!keep) continue;
		lines.push(`export ${key}=${shellQuote(value)}`);
	}

	return lines.join("\n");
}

function isSafeEnvKey(key: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function safeInitialPrompt(prompt: string): string {
	return `Continuation request after /detach handoff:\n${prompt}`;
}

export function preservedLaunchArgs(
	argv: string[],
	activeTools: string[],
	launchCwd = PROCESS_LAUNCH_CWD,
	effective: { model?: string; thinking?: string; trusted?: boolean } = {},
): string[] {
	const preservedValueFlags = new Set([
		"--system-prompt",
		"--append-system-prompt",
		"--extension",
		"-e",
		"--skill",
		"--prompt-template",
		"--theme",
	]);
	const skippedValueFlags = new Set([
		"--provider",
		"--model",
		"--models",
		"--thinking",
		"--mode",
		"--session",
		"--session-id",
		"--fork",
		"--session-dir",
		"--name",
		"-n",
		"--tools",
		"-t",
		"--exclude-tools",
		"-xt",
		"--export",
	]);
	const preservedBooleanFlags = new Set([
		"--no-extensions",
		"-ne",
		"--no-skills",
		"-ns",
		"--no-prompt-templates",
		"-np",
		"--no-themes",
		"--no-context-files",
		"-nc",
		"--offline",
		"--verbose",
	]);
	const skippedBooleanFlags = new Set([
		"--help",
		"-h",
		"--version",
		"-v",
		"--continue",
		"-c",
		"--resume",
		"-r",
		"--no-session",
		"--no-tools",
		"-nt",
		"--no-builtin-tools",
		"-nbt",
		"--print",
		"-p",
		"--list-models",
		"--approve",
		"-a",
		"--no-approve",
		"-na",
	]);
	const result: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--api-key") {
			throw new Error("--api-key cannot be written to a handoff script; use Pi auth storage or an environment variable");
		}
		if (preservedValueFlags.has(arg) || skippedValueFlags.has(arg)) {
			const value = argv[++index];
			if (value === undefined) throw new Error(`${arg} is missing its value`);
			if (preservedValueFlags.has(arg)) result.push(arg, resolvePreservedResourceArg(arg, value, launchCwd));
			continue;
		}
		if (preservedBooleanFlags.has(arg)) {
			result.push(arg);
			continue;
		}
		if (skippedBooleanFlags.has(arg)) continue;
		if (arg.startsWith("-")) {
			throw new Error(`unsupported launch flag ${arg}; remove it before /detach so its semantics are not lost`);
		}
		// Initial prompts and @file arguments are already represented by the session.
	}

	if (effective.model) result.push("--model", effective.model);
	if (effective.thinking) result.push("--thinking", effective.thinking);
	if (effective.trusted !== undefined) result.push(effective.trusted ? "--approve" : "--no-approve");
	if (activeTools.length === 0) result.push("--no-tools");
	else result.push("--tools", [...new Set(activeTools)].join(","));
	return result;
}

function resolvePreservedResourceArg(flag: string, value: string, launchCwd: string): string {
	if (flag === "--system-prompt" || flag === "--append-system-prompt") return value;
	if (/^(?:npm:|git:|https?:|ssh:|git:)/.test(value)) return value;
	if (flag === "--theme" && !/[\\/]|^\.|^~|\.json$/i.test(value)) return value;
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return isAbsolute(value) ? value : resolve(launchCwd, value);
}

export function shellCommand(value: string): string {
	const parts = shellishSplit(value);
	return (parts.length > 0 ? parts : ["pi"]).map(shellQuote).join(" ");
}

function escapeForDoubleQuotedEcho(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export function shellishSplit(input: string): string[] {
	const result: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}

		if ((char === "'" || char === '"') && !quote) {
			quote = char;
			continue;
		}

		if (char === quote) {
			quote = undefined;
			continue;
		}

		if (!quote && /\s/.test(char)) {
			if (current) {
				result.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (escaping) throw new Error("unterminated escape sequence");
	if (quote) throw new Error("unterminated quoted string");
	if (current) result.push(current);
	return result;
}
