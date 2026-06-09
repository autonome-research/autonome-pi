export type MissionAction = "plan" | "activate" | "resume" | "status";
export type PlannerMode = "pi" | "mock";
export type CompletionTarget = "contract_validated" | "operationally_ready" | "deployment_ready";

export interface MissionToolParams {
	action?: MissionAction;
	goal?: string;
	cwd?: string;
	planPath?: string;
	missionId?: string;
	approved?: boolean;
	background?: boolean;
	planner?: PlannerMode;
	completionTarget?: CompletionTarget;
	validationCommands?: string[];
	userTestCommand?: string;
	maxRepairIterations?: number;
	modelPlan?: string;
	modelWorker?: string;
	modelValidator?: string;
}

export interface MissionToolSessionManager {
	getSessionId?: () => string | undefined;
	getSessionFile?: () => string | undefined;
}

export interface MissionToolContextLike {
	cwd: string;
	signal?: AbortSignal;
	sessionManager?: MissionToolSessionManager;
}

export interface ScriptResult {
	code: number;
	stdout: string;
	stderr: string;
}
