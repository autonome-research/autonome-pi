import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MissionPlan } from "../core/types.ts";
import { normalizeCompletionTarget } from "../planning/completion.ts";
import { normalizePromptPolicy } from "../planning/policies.ts";

export interface ValidationCursorRuntime {
	commandTimeoutMs?: number;
	piTimeoutMs?: number;
	piIdleTimeoutMs?: number;
}

export interface ValidationCursorMetadata {
	schema: "pi-mission-validation-cursor-metadata/v1";
	planner: string;
	validatorMode: "mock" | "pi";
	requestedModel: string;
	actualModel?: string;
	piBin?: string;
	commandTimeoutMs?: number;
	piTimeoutMs?: number;
	piIdleTimeoutMs?: number;
	promptVersions: ReturnType<typeof normalizePromptPolicy>;
	completionTarget: ReturnType<typeof normalizeCompletionTarget>;
	stableIdentity: boolean;
}

export interface ValidationFeatureResultLike {
	featureId?: unknown;
	featureBranch?: unknown;
	commit?: unknown;
	handoffArtifact?: unknown;
	changedFiles?: unknown[];
	assertions?: unknown[];
	localAssertions?: unknown[];
	featureFingerprint?: unknown;
}

export function defaultPiBin(home = homedir(), env = process.env): string {
	return env.PI_MISSION_WORKFLOW_PI_BIN || (existsSync(join(home, ".npm-global", "bin", "pi")) ? join(home, ".npm-global", "bin", "pi") : "pi");
}

export function validationCursorMetadata(plan: Partial<MissionPlan>, requestedModel = "", actualModel = "", runtime: ValidationCursorRuntime = {}, piBin = defaultPiBin()): ValidationCursorMetadata {
	const planner = String(plan.planner || "pi");
	const validatorMode = planner === "mock" ? "mock" : "pi";
	const requested = String(requestedModel || "");
	return {
		schema: "pi-mission-validation-cursor-metadata/v1",
		planner,
		validatorMode,
		requestedModel: requested,
		actualModel: actualModel ? String(actualModel) : undefined,
		piBin: validatorMode === "pi" ? piBin : undefined,
		commandTimeoutMs: runtime.commandTimeoutMs,
		piTimeoutMs: runtime.piTimeoutMs,
		piIdleTimeoutMs: runtime.piIdleTimeoutMs,
		promptVersions: normalizePromptPolicy(plan.promptPolicy),
		completionTarget: normalizeCompletionTarget(plan.completionTarget),
		stableIdentity: validatorMode === "mock" || Boolean(requested),
	};
}

export function validationFeatureRecord(result: ValidationFeatureResultLike, milestoneId: unknown) {
	return {
		featureId: String(result.featureId || ""),
		milestoneId: String(milestoneId || ""),
		branch: result.featureBranch,
		commit: result.commit,
		handoffArtifact: result.handoffArtifact,
		changedFiles: result.changedFiles || [],
		assertions: result.assertions || [],
		localAssertions: result.localAssertions || [],
		featureFingerprint: result.featureFingerprint,
	};
}
