import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildArgs } from "./src/extension/args.ts";
import { directoryExists, parseSimpleCd, resolveAgainstActive } from "./src/extension/cwd.ts";
import { compactDetails, parseJsonObject, runScript, truncate } from "./src/extension/result.ts";
import type { MissionAction } from "./src/extension/types.ts";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(EXT_DIR, "bin", "mission-workflow.mjs");

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
			const result = await runScript(SCRIPT, buildArgs({ ...params, action, cwd }, ctx), cwd, signal);
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
