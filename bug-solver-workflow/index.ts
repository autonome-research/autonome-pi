import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(EXT_DIR, "bin", "bug-solver-workflow.mjs");
const MAX_TOOL_TEXT = 30_000;

type BugSolverAction = "precheck" | "solve" | "status";

function truncate(text: string, max = MAX_TOOL_TEXT): string {
	if (Buffer.byteLength(text, "utf8") <= max) return text;
	let out = text.slice(0, max);
	while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, -1);
	return `${out}\n\n[Tool output truncated. Full run is available through thread_phase_runs.]`;
}

function runScript(args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(process.execPath, [SCRIPT, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
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

function shellUnquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
	return trimmed.replace(/\\ /g, " ");
}

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
	return input;
}

function parseSimpleCd(command: string): string | undefined {
	const trimmed = command.trim().replace(/;\s*$/, "");
	const match = trimmed.match(/^cd(?:\s+(.+))?$/);
	if (!match) return undefined;
	return shellUnquote(match[1] || "~");
}

function directoryExists(candidate: string): boolean {
	try { return existsSync(candidate) && statSync(candidate).isDirectory(); }
	catch { return false; }
}

function resolveAgainstActive(activeCwd: string, maybePath?: string): string {
	if (!maybePath) return activeCwd;
	return path.resolve(activeCwd, expandHome(maybePath));
}

function splitList(value: unknown): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.flatMap(splitList);
	return String(value).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

function buildArgs(params: Record<string, any>, ctx: any): string[] {
	const args = [String(params.action || "precheck"), "--cwd", params.cwd, "--json"];
	if (params.bug) args.push("--bug", params.bug);
	if (params.transactionId) args.push("--transaction-id", params.transactionId);
	if (params.planPath) args.push("--plan-path", params.planPath);
	if (params.approved) args.push("--approved");
	if (params.background) args.push("--background");
	if (params.userTestCommand) args.push("--user-test-command", params.userTestCommand);
	if (params.maxRepairIterations !== undefined) args.push("--max-repairs", String(params.maxRepairIterations));
	for (const entry of splitList(params.allowlist)) args.push("--allowlist", entry);
	for (const command of splitList(params.validationCommands)) args.push("--validation-command", command);
	return addSessionArgs(args, ctx);
}

export default function bugSolverWorkflow(pi: ExtensionAPI) {
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
		name: "bug_solver_workflow",
		label: "Bug Solver Workflow",
		description: "Run the dedicated one-bug-per-transaction bug-solver workflow scaffold with precheck/approval gates, durable external artifacts, and thread-phase observability.",
		promptSnippet: "Precheck or activate an isolated one-bug solver transaction",
		promptGuidelines: [
			"Use bug_solver_workflow for a focused single-bug transaction, not broad multi-feature missions.",
			"Run action='precheck' first. The precheck is read-only and records durable findings outside the target repository.",
			"Only run action='solve' with approved=true after the user explicitly confirms the precheck result.",
			"If a request names multiple independent bugs, reject or split it before solving.",
		],
		parameters: Type.Object({
			action: Type.Optional(StringEnum(["precheck", "solve", "status"] as const, { default: "precheck" })),
			bug: Type.Optional(Type.String({ description: "Single bug report or transaction goal. Required for precheck/solve." })),
			cwd: Type.Optional(Type.String({ description: "Repository directory. Defaults to Pi's active cwd." })),
			transactionId: Type.Optional(Type.String({ description: "Optional stable transaction id for artifacts/registry lookup." })),
			planPath: Type.Optional(Type.String({ description: "Precheck artifact/plan path produced by action=precheck." })),
			approved: Type.Optional(Type.Boolean({ description: "Required true for action=solve after explicit precheck confirmation." })),
			background: Type.Optional(Type.Boolean({ description: "Start action in the background and return immediately when supported." })),
			validationCommands: Type.Optional(Type.Array(Type.String(), { description: "Candidate broad validation commands to record for baseline-aware solve planning." })),
			userTestCommand: Type.Optional(Type.String({ description: "Optional targeted bug-reproduction/user test command to run before broad validation." })),
			maxRepairIterations: Type.Optional(Type.Number({ description: "Maximum bounded repair attempts for the transaction. Defaults to 8." })),
			allowlist: Type.Optional(Type.Array(Type.String(), { description: "Initial file/path allowlist for implementation scope control." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const action = (params.action || "precheck") as BugSolverAction;
			const cwd = resolveAgainstActive(activeCwd || ctx.cwd, params.cwd);
			onUpdate?.({ content: [{ type: "text", text: `${action === "solve" ? "Activating" : action === "status" ? "Checking" : "Prechecking"} bug_solver_workflow in ${cwd}...` }] });
			const result = await runScript(buildArgs({ ...params, action, cwd }, ctx), cwd, signal);
			let details: any;
			try { details = parseJsonObject(result.stdout); } catch { details = { stdout: truncate(result.stdout), stderr: truncate(result.stderr) }; }
			if (result.code !== 0 && !(params.background && details?.background)) throw new Error(result.stderr || result.stdout || `bug_solver_workflow exited ${result.code}`);
			const text = details?.background
				? `Started bug-solver workflow in background (pid ${details.pid}). Open ctrl+shift+t to monitor it.`
				: result.stdout || "Bug-solver workflow complete.";
			return { content: [{ type: "text", text: truncate(text) }], details };
		},
	});

	pi.registerCommand("bug-solver", {
		description: "Precheck/status/solve a single bug transaction with the bug-solver workflow",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const action = (parts.shift() || "precheck") as BugSolverAction;
			const cwd = resolveAgainstActive(activeCwd || ctx.cwd, undefined);
			ctx.ui.setStatus("bug-solver", `${action} running...`);
			try {
				const scriptArgs = addSessionArgs([action, "--cwd", cwd, "--json", ...(parts.length ? ["--bug", parts.join(" ")] : [])], ctx);
				const result = await runScript(scriptArgs, cwd, ctx.signal);
				if (result.code !== 0) ctx.ui.notify(result.stderr || result.stdout || `bug-solver exited ${result.code}`, "error");
				else ctx.ui.notify(truncate(result.stdout.trim(), 4000), "info");
			} finally {
				ctx.ui.setStatus("bug-solver", undefined);
			}
		},
	});
}
