import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeCompletionTarget } from "../planning/completion.ts";
import { normalizePromptPolicy, normalizeRolePolicy } from "../planning/policies.ts";
import { registryDirFor, registryStatePath } from "./paths.ts";
import type { MissionRegistryState, RegistryPatch, RegistryPlan } from "./types.ts";

export function defaultRegistryState(plan: RegistryPlan, patch: RegistryPatch = {}): MissionRegistryState {
	const now = new Date().toISOString();
	const completionTarget = normalizeCompletionTarget(plan.completionTarget);
	const rolePolicy = normalizeRolePolicy(plan.rolePolicy, { modelPlan: plan.modelPlan, modelWorker: plan.modelWorker, modelValidator: plan.modelValidator });
	const promptPolicy = normalizePromptPolicy(plan.promptPolicy);
	return {
		schema: "pi-mission-workflow/registry/v1",
		missionId: plan.missionId,
		goal: plan.goal,
		status: "planned",
		planPath: patch.planPath,
		branch: patch.branch,
		repoRoot: patch.repoRoot || plan.cwd,
		worktree: patch.worktree,
		worktreeBaseDir: plan.worktreeBaseDir,
		current: {},
		completion: { target: completionTarget, level: "code_complete", categoryResults: [], blockedBy: [] },
		roleModels: { plan: plan.modelPlan, planner: rolePolicy.planner.model || plan.modelPlan, worker: rolePolicy.worker.model || plan.modelWorker, validator: rolePolicy.validator.model || plan.modelValidator, domainCritic: rolePolicy.domainCritic.model, opsCritic: rolePolicy.opsCritic.model },
		roleMetrics: {},
		promptVersions: promptPolicy,
		failureHistory: [],
		repairHistory: [],
		operatorDx: { entrypointsVerified: [], runbooksVerified: [], externalChecksSkipped: [] },
		sharedMissionNotes: { architecturalDecisions: [], assumptions: [], externalServiceAssumptions: [], operatorSteps: [], testsAdded: [], risksNotAddressed: [], broadcastNotes: [] },
		completedFeatures: [],
		trustedBaseHead: patch.trustedBaseHead,
		trustedHead: patch.trustedHead,
		trustedPlanFingerprint: patch.trustedPlanFingerprint,
		trustedCommits: [],
		validationReports: [],
		coverageReports: [],
		timestamps: { createdAt: now, updatedAt: now, startedAt: patch.startedAt },
		...patch,
	};
}

export function writeRegistryState(plan: RegistryPlan, state: MissionRegistryState, root?: string) {
	const dir = registryDirFor(plan.missionId, root);
	mkdirSync(dir, { recursive: true });
	const next = {
		...state,
		timestamps: { ...(state.timestamps || {}), updatedAt: new Date().toISOString() },
	};
	const statePath = registryStatePath(plan.missionId, root);
	const tempPath = `${statePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
	writeFileSync(tempPath, JSON.stringify(next, null, 2), "utf8");
	renameSync(tempPath, statePath);
	return { dir, statePath, state: next };
}

function objectRecord(value: unknown): Record<string, any> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function recordOr(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
	return objectRecord(value) || fallback;
}

function arrayOr<T = unknown>(value: unknown, fallback: T[] = []): T[] {
	return Array.isArray(value) ? value as T[] : fallback;
}

function mergeArrayRecord(base: Record<string, unknown>, existing: unknown): Record<string, unknown[]> {
	const raw = recordOr(existing, {});
	const out: Record<string, unknown[]> = {};
	for (const key of Object.keys(base)) out[key] = arrayOr(raw[key], arrayOr(base[key], []));
	for (const [key, value] of Object.entries(raw)) if (!(key in out)) out[key] = arrayOr(value, []);
	return out;
}

function mergeKnownArrayRecord(base: Record<string, unknown>, existing: unknown): Record<string, unknown> {
	const raw = recordOr(existing, {});
	const out: Record<string, unknown> = { ...raw };
	for (const key of Object.keys(base)) out[key] = arrayOr(raw[key], arrayOr(base[key], []));
	return out;
}

export function readRegistryStateOrDefault(plan: RegistryPlan, root?: string): MissionRegistryState {
	try {
		const parsed = objectRecord(JSON.parse(readFileSync(registryStatePath(plan.missionId, root), "utf8")));
		return parsed ? mergePersistedRegistryState(plan, parsed as Partial<MissionRegistryState>) : defaultRegistryState(plan);
	} catch {
		return defaultRegistryState(plan);
	}
}

function cloneRegistryState(state: MissionRegistryState): MissionRegistryState {
	return typeof structuredClone === "function" ? structuredClone(state) : JSON.parse(JSON.stringify(state));
}

/**
 * Apply a registry update using a cloned JSON-serializable draft.
 * Callers must return the next registry state; void-return draft mutations are rejected.
 */
export function updateRegistryState(plan: RegistryPlan, updater: (state: MissionRegistryState) => MissionRegistryState, root?: string) {
	const existing = readRegistryStateOrDefault(plan, root);
	const next = updater(cloneRegistryState(existing));
	const validNext = objectRecord(next);
	if (!validNext || validNext.missionId !== plan.missionId || !validNext.timestamps || typeof validNext.timestamps !== "object") throw new Error("updateRegistryState updater must return the next registry state");
	return writeRegistryState(plan, validNext as MissionRegistryState, root);
}

export function mergePersistedRegistryState(plan: RegistryPlan, existingValue: Partial<MissionRegistryState> = {}, planPath?: string): MissionRegistryState {
	const existing = (objectRecord(existingValue) || {}) as Partial<MissionRegistryState>;
	const base = defaultRegistryState(plan, { planPath: planPath ? resolve(planPath) : existing.planPath as string | undefined });
	const existingCompletion = recordOr(existing.completion, {});
	return {
		...base,
		...existing,
		schema: "pi-mission-workflow/registry/v1",
		missionId: plan.missionId,
		goal: plan.goal,
		planPath: planPath ? resolve(planPath) : existing.planPath,
		completion: {
			...base.completion,
			...existingCompletion,
			target: normalizeCompletionTarget((existingCompletion as any).target || plan.completionTarget),
			categoryResults: arrayOr(existingCompletion.categoryResults, base.completion.categoryResults),
			blockedBy: arrayOr(existingCompletion.blockedBy, base.completion.blockedBy),
		},
		roleModels: { ...base.roleModels, ...recordOr(existing.roleModels, {}) },
		roleMetrics: { ...base.roleMetrics, ...recordOr(existing.roleMetrics, {}) },
		promptVersions: { ...base.promptVersions, ...recordOr(existing.promptVersions, {}) },
		failureHistory: arrayOr(existing.failureHistory, base.failureHistory),
		repairHistory: arrayOr(existing.repairHistory, base.repairHistory),
		operatorDx: mergeKnownArrayRecord(base.operatorDx, existing.operatorDx),
		sharedMissionNotes: mergeArrayRecord(base.sharedMissionNotes, existing.sharedMissionNotes),
		completedFeatures: arrayOr(existing.completedFeatures, base.completedFeatures),
		trustedCommits: arrayOr(existing.trustedCommits, base.trustedCommits).map(String),
		validationReports: arrayOr(existing.validationReports, base.validationReports),
		coverageReports: arrayOr(existing.coverageReports, base.coverageReports),
		timestamps: { ...(base.timestamps || {}), ...recordOr(existing.timestamps, {}) },
		status: existing.status || "planned",
	} as MissionRegistryState;
}
