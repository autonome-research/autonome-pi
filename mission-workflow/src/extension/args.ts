import type { MissionToolContextLike, MissionToolParams } from "./types.ts";

export function addSessionArgs(args: string[], ctx: MissionToolContextLike): string[] {
	const sessionId = ctx.sessionManager?.getSessionId?.();
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (sessionId) args.push("--session-id", sessionId);
	if (sessionFile) args.push("--session-file", sessionFile);
	return args;
}

export function splitList(value: unknown): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.flatMap(splitList);
	return String(value).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

export function buildArgs(params: MissionToolParams & { cwd: string }, ctx: MissionToolContextLike): string[] {
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
