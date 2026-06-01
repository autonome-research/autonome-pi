import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(EXT_DIR, "bin", "code-review-workflow.mjs");
const MAX_TOOL_TEXT = 40_000;

type ReviewMode = "last_commit" | "staged" | "working_tree" | "range";
type ToolAction = "review" | "install_hook" | "status";

function truncate(text: string, max = MAX_TOOL_TEXT): string {
	if (Buffer.byteLength(text, "utf8") <= max) return text;
	let out = text.slice(0, max);
	while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, -1);
	return `${out}\n\n[Tool output truncated. Full report is in details/reportPath when available.]`;
}

function runNodeScript(args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(process.execPath, [SCRIPT, ...args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.stderr.on("data", (d) => (stderr += d.toString()));
		proc.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
		proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
		if (signal) {
			const abort = () => {
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

function parseJsonObject(stdout: string): any {
	const trimmed = stdout.trim();
	if (!trimmed) return undefined;
	return JSON.parse(trimmed);
}

function addSessionArgs(args: string[], ctx: any): string[] {
	const sessionId = ctx.sessionManager?.getSessionId?.();
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (sessionId) args.push("--session-id", sessionId);
	if (sessionFile) args.push("--session-file", sessionFile);
	return args;
}

function makeReviewArgs(params: { mode?: ReviewMode; ref?: string; cwd: string; background?: boolean; model?: string; ctx?: any }) {
	const args = ["review", "--cwd", params.cwd, "--mode", params.mode || "last_commit", "--json"];
	if (params.ref) args.push("--ref", params.ref);
	if (params.background) args.push("--background");
	if (params.model) args.push("--model", params.model);
	return params.ctx ? addSessionArgs(args, params.ctx) : args;
}

function readReportExcerpt(reportPath?: string): string | undefined {
	if (!reportPath || !fs.existsSync(reportPath)) return undefined;
	return truncate(fs.readFileSync(reportPath, "utf8"), 12_000);
}

function commandUsage(): string {
	return [
		"Usage:",
		"  /code-review                 Review HEAD (last commit)",
		"  /code-review staged          Review staged changes",
		"  /code-review working         Review unstaged working-tree diff",
		"  /code-review range A..B      Review a git range",
		"  /code-review install         Install post-commit hook in this repo",
		"  /code-review status          Show hook/report locations",
		"  /code-review --cwd /repo staged",
		"",
		"Default cwd follows simple user-bash cd commands in this Pi session.",
		"Workflow events are emitted to the generic thread-phase visualizer store.",
	].join("\n");
}

function shellUnquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
	return trimmed.replace(/\\ /g, " ");
}

function expandHome(input: string): string {
	if (input === "~") return process.env.HOME || "/";
	if (input.startsWith("~/")) return path.join(process.env.HOME || "/", input.slice(2));
	return input;
}

function directoryExists(candidate: string): boolean {
	try { return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory(); }
	catch { return false; }
}

function resolveAgainstActive(activeCwd: string, maybePath?: string): string {
	if (!maybePath) return activeCwd;
	return path.resolve(activeCwd, expandHome(maybePath));
}

function parseSimpleCd(command: string): string | undefined {
	const trimmed = command.trim().replace(/;\s*$/, "");
	const match = trimmed.match(/^cd(?:\s+(.+))?$/);
	if (!match) return undefined;
	return shellUnquote(match[1] || "~");
}

function optionAfter(parts: string[], name: string): string | undefined {
	const eq = parts.find((part) => part.startsWith(`${name}=`));
	if (eq) return eq.slice(name.length + 1);
	const index = parts.indexOf(name);
	return index >= 0 ? parts[index + 1] : undefined;
}

function stripOption(parts: string[], name: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === name) { i++; continue; }
		if (part.startsWith(`${name}=`)) continue;
		out.push(part);
	}
	return out;
}

function parseCommandArgs(args: string, cwd: string): { action: ToolAction; mode?: ReviewMode; ref?: string; cwd: string } | { error: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const first = parts[0]?.toLowerCase();
	if (!first) return { action: "review", mode: "last_commit", cwd };
	if (["help", "-h", "--help"].includes(first)) return { error: commandUsage() };
	if (["install", "install-hook", "hook"].includes(first)) return { action: "install_hook", cwd };
	if (first === "status") return { action: "status", cwd };
	if (["staged", "stage", "cached"].includes(first)) return { action: "review", mode: "staged", cwd };
	if (["working", "worktree", "working_tree", "dirty"].includes(first)) return { action: "review", mode: "working_tree", cwd };
	if (first === "range") return { action: "review", mode: "range", ref: parts[1], cwd };
	return { action: "review", mode: "last_commit", ref: parts[0], cwd };
}

export default function codeReviewWorkflow(pi: ExtensionAPI) {
	let activeCwd = process.cwd();
	let previousCwd = activeCwd;

	pi.on("session_start", (_event, ctx) => {
		activeCwd = ctx.cwd;
		previousCwd = ctx.cwd;
	});

	pi.on("user_bash", (event, ctx) => {
		const target = parseSimpleCd(event.command);
		if (target === undefined) return;
		const base = activeCwd || event.cwd || ctx.cwd;
		const next = target === "-" ? previousCwd : resolveAgainstActive(base, target);
		if (!directoryExists(next)) return;
		previousCwd = base;
		activeCwd = next;
	});

	pi.registerTool({
		name: "code_review_workflow",
		label: "Code Review Workflow",
		description: "Run the pi code-review workflow on a git commit/diff, install its post-commit hook, or show status. Emits generic thread-phase visualizer events.",
		promptSnippet: "Review git changes for bugs/best-practice issues or install the post-commit review hook",
		promptGuidelines: [
			"Use code_review_workflow when the user asks for code review of recent git changes or wants the post-commit review hook installed.",
			"code_review_workflow is read-only for review actions; use install_hook only when the user explicitly asks to enable automatic reviews.",
		],
		parameters: Type.Object({
			action: Type.Optional(StringEnum(["review", "install_hook", "status"] as const, { default: "review" })),
			mode: Type.Optional(StringEnum(["last_commit", "staged", "working_tree", "range"] as const, { default: "last_commit" })),
			ref: Type.Optional(Type.String({ description: "Commit ref for last_commit, or range like main..HEAD for range mode." })),
			cwd: Type.Optional(Type.String({ description: "Repository directory. Defaults to pi's current cwd." })),
			background: Type.Optional(Type.Boolean({ description: "Start review in the background and return immediately." })),
			model: Type.Optional(Type.String({ description: "Optional pi model pattern for the reviewer subprocess." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const action = (params.action || "review") as ToolAction;
			const cwd = resolveAgainstActive(activeCwd || ctx.cwd, params.cwd);
			onUpdate?.({ content: [{ type: "text", text: `Running code_review_workflow ${action}...` }] });

			let scriptArgs: string[];
			if (action === "install_hook") {
				scriptArgs = addSessionArgs(["install-hook", "--cwd", cwd, "--json"], ctx);
			} else if (action === "status") {
				scriptArgs = addSessionArgs(["status", "--cwd", cwd, "--json"], ctx);
			} else {
				scriptArgs = makeReviewArgs({
					cwd,
					mode: (params.mode || "last_commit") as ReviewMode,
					ref: params.ref,
					background: Boolean(params.background),
					model: params.model,
					ctx,
				});
			}

			const result = await runNodeScript(scriptArgs, cwd, signal);
			if (result.code !== 0) throw new Error(result.stderr || result.stdout || `code_review_workflow exited ${result.code}`);

			const details = parseJsonObject(result.stdout);
			const report = readReportExcerpt(details?.reportPath);
			const text = action === "review"
				? details?.background
					? `Started background code review (pid ${details.pid}). Generic thread-phase visualizer will announce completion.`
					: `Code review ${details?.ok ? "complete" : "failed"}: ${details?.reportPath}\nRun: ${details?.runId}\n\n${report || details?.summary || "No report text available."}`
				: result.stdout.trim();

			return {
				content: [{ type: "text", text: truncate(text) }],
				details: { ...details, reportExcerpt: report },
			};
		},
	});

	pi.registerCommand("code-review", {
		description: "Run/install/status for the post-commit code review workflow",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cwd = resolveAgainstActive(activeCwd || ctx.cwd, optionAfter(parts, "--cwd"));
			const parsed = parseCommandArgs(stripOption(parts, "--cwd").join(" "), cwd);
			if ("error" in parsed) {
				ctx.ui.notify(parsed.error, "info");
				return;
			}
			const action = parsed.action;
			ctx.ui.setStatus("code-review", `${action} running...`);
			try {
				const scriptArgs = action === "install_hook"
					? addSessionArgs(["install-hook", "--cwd", cwd, "--json"], ctx)
					: action === "status"
						? addSessionArgs(["status", "--cwd", cwd, "--json"], ctx)
						: makeReviewArgs({ cwd, mode: parsed.mode, ref: parsed.ref, ctx });
				const result = await runNodeScript(scriptArgs, cwd, ctx.signal);
				if (result.code !== 0) {
					ctx.ui.notify(result.stderr || result.stdout || `code-review exited ${result.code}`, "error");
					return;
				}
				const details = parseJsonObject(result.stdout);
				if (action === "review") {
					ctx.ui.notify(`Code review complete. Run: ${details?.runId || "unknown"}`, details?.ok ? "info" : "warning");
				} else {
					ctx.ui.notify(result.stdout.trim(), "info");
				}
			} finally {
				ctx.ui.setStatus("code-review", undefined);
			}
		},
	});
}
