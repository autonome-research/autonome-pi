import type { CompletionTarget, MissionPlan, PromptPolicy } from "../core/types.ts";

export type MissionRegistryStatus = "planned" | "running" | "completed" | "failed" | "cancelled";

export interface MissionRegistryCompletion {
	target: CompletionTarget | string;
	level: string;
	categoryResults: unknown[];
	blockedBy: unknown[];
}

export interface MissionRegistryState {
	schema: "pi-mission-workflow/registry/v1";
	missionId: string;
	goal: string;
	status: MissionRegistryStatus | string;
	planPath?: string;
	branch?: string;
	repoRoot?: string;
	worktree?: string;
	worktreeBaseDir?: string;
	current: Record<string, unknown>;
	completion: MissionRegistryCompletion;
	roleModels: Record<string, unknown>;
	roleMetrics: Record<string, unknown>;
	promptVersions: Required<PromptPolicy> | Record<string, unknown>;
	failureHistory: unknown[];
	repairHistory: unknown[];
	operatorDx: Record<string, unknown>;
	sharedMissionNotes: Record<string, unknown[]>;
	completedFeatures: unknown[];
	trustedBaseHead?: string;
	trustedHead?: string;
	trustedPlanFingerprint?: string;
	trustedCommits: string[];
	validationReports: unknown[];
	coverageReports: unknown[];
	timestamps: Record<string, string | undefined>;
	[key: string]: unknown;
}

export interface RegistryPatch {
	planPath?: string;
	branch?: string;
	repoRoot?: string;
	worktree?: string;
	trustedBaseHead?: string;
	trustedHead?: string;
	trustedPlanFingerprint?: string;
	startedAt?: string;
}

export type RegistryPlan = Pick<MissionPlan, "missionId" | "goal" | "cwd" | "completionTarget" | "rolePolicy" | "promptPolicy" | "modelPlan" | "modelWorker" | "modelValidator" | "worktreeBaseDir">;
