import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(EXT_DIR, "bin", "mission-workflow.mjs");
const MAX_TOOL_TEXT = 30_000;

type MissionAction = "plan" | "activate" | "resume" | "status";
type PlannerMode = "pi" | "mock";

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

function compactDetails(details: any): any {
	if (!details || typeof details !== "object") return details;
	const out = { ...details };
	if (out.plan && typeof out.plan === "object") out.plan = { missionId: out.plan.missionId, goal: out.plan.goal, planPath: out.planPath, milestoneCount: Array.isArray(out.plan.milestones) ? out.plan.milestones.length : undefined };
	if (out.env && typeof out.env === "object") out.env = { missionBranch: out.env.missionBranch, integrationPath: out.env.integrationPath, repoRoot: out.env.repoRoot };
	delete out.missionState;
	return out;
}

function addSessionArgs(args: string[], ctx: any): string[] {
	const sessionId = ctx.sessionManager?.getSessionId?.();
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (sessionId) args.push("--session-id", sessionId);
	if (sessionFile) args.push("--session-file", sessionFile);
	return args;
}

function splitList(value: unknown): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.flatMap(splitList);
	return String(value).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

function buildArgs(params: Record<string, any>, ctx: any): string[] {
	const args = [String(params.action || "plan"), "--cwd", params.cwd];
	if (params.goal) args.push("--goal", params.goal);
	if (params.planPath) args.push("--plan-path", params.planPath);
	if (params.missionId) args.push("--mission-id", params.missionId);
	if (params.approved) args.push("--approved");
	if (params.background) args.push("--background");
	if (params.planner) args.push("--planner", params.planner);
	if (params.completionTarget) args.push("--completion-target", params.completionTarget);
	if (params.modelPlan) args.push("--model-plan", params.modelPlan);
	if (params.modelWorker) args.push("--model-worker", params.modelWorker);
	if (params.modelValidator) args.push("--model-validator", params.modelValidator);
	if (params.maxRepairIterations !== undefined) args.push("--max-repair-iterations", String(params.maxRepairIterations));
	if (params.userTestCommand) args.push("--user-test-command", params.userTestCommand);
	for (const command of splitList(params.validationCommands)) args.push("--validation-command", command);
	return addSessionArgs(args, ctx);
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

export default function missionWorkflow(pi: ExtensionAPI) {
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
		name: "mission_workflow",
		label: "Mission Workflow",
		description: "Plan, approve, and execute Droid/Missions-style long-running software missions with thread-phase observability, per-feature worktrees, commits, validation contracts, and repair loops.",
		promptSnippet: "Plan or activate a long-running mission workflow with workers and validators",
		promptGuidelines: [
			"Use mission_workflow for Droid/Missions-style multi-feature implementation workflows that need planning, validation contracts, worker handoffs, worktrees, and milestone validation.",
			"Always run action='plan' first and ask the user to approve the generated plan before action='activate'.",
			"Once activated with approved=true, the mission runs without further human approval unless cancelled or failed.",
			"Use action='resume' only for an approved mission whose previous activation stopped unexpectedly; it reuses the mission branch/worktrees and skips already-merged feature branches.",
		],
		parameters: Type.Object({
			action: Type.Optional(StringEnum(["plan", "activate", "resume", "status"] as const, { default: "plan" })),
			goal: Type.Optional(Type.String({ description: "Mission goal. Required for action=plan." })),
			cwd: Type.Optional(Type.String({ description: "Repository directory. Defaults to Pi's active cwd." })),
			planPath: Type.Optional(Type.String({ description: "Path to an approved mission-plan.json for action=activate, resume, or status." })),
			missionId: Type.Optional(Type.String({ description: "Mission id for action=status when no planPath is available." })),
			approved: Type.Optional(Type.Boolean({ description: "Required true for action=activate; means the user approved the plan." })),
			background: Type.Optional(Type.Boolean({ description: "Start activation in the background and return immediately." })),
			planner: Type.Optional(StringEnum(["pi", "mock"] as const, { default: "pi", description: "Use pi planner/agents or deterministic mock planner for testing." })),
			completionTarget: Type.Optional(StringEnum(["contract_validated", "operationally_ready", "deployment_ready"] as const, { default: "contract_validated", description: "Requested completion level for planned missions. Higher targets require corresponding validation categories in the approved plan." })),
			validationCommands: Type.Optional(Type.Array(Type.String(), { description: "Scrutiny validation commands run after each milestone." })),
			userTestCommand: Type.Optional(Type.String({ description: "Command-based user-testing validator, e.g. npm run test:e2e." })),
			maxRepairIterations: Type.Optional(Type.Number({ description: "Max milestone repair iterations. Default 10." })),
			modelPlan: Type.Optional(Type.String({ description: "Optional model pattern for planning/orchestration agents." })),
			modelWorker: Type.Optional(Type.String({ description: "Optional model pattern for worker agents." })),
			modelValidator: Type.Optional(Type.String({ description: "Optional model pattern for validator agents." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const action = (params.action || "plan") as MissionAction;
			const cwd = resolveAgainstActive(activeCwd || ctx.cwd, params.cwd);
			onUpdate?.({ content: [{ type: "text", text: `${action === "activate" ? "Activating" : action === "resume" ? "Resuming" : action === "status" ? "Checking" : "Planning"} mission workflow in ${cwd}...` }] });
			const result = await runScript(buildArgs({ ...params, action, cwd }, ctx), cwd, signal);
			let details: any;
			try { details = compactDetails(parseJsonObject(result.stdout)); } catch { details = { stdout: truncate(result.stdout), stderr: truncate(result.stderr) }; }
			if (result.code !== 0 && !(params.background && details?.background)) throw new Error(result.stderr || result.stdout || `mission_workflow exited ${result.code}`);
			const text = details?.background
				? `Started mission workflow in background (pid ${details.pid}). Open ctrl+shift+t to monitor it.`
				: result.stdout || "Mission workflow complete.";
			return { content: [{ type: "text", text: truncate(text) }], details };
		},
	});
}
