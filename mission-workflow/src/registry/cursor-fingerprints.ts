import { createHash } from "node:crypto";
import type { MissionMilestone, MissionPlan } from "../core/types.ts";
import { safeName } from "../core/text.ts";
import { normalizeCompletionTarget } from "../planning/completion.ts";
import { normalizeCapabilityPolicy, normalizePromptPolicy } from "../planning/policies.ts";
import { normalizeValidationCategories } from "../validation/categories.ts";
import { milestoneCoverageAssertions } from "../validation/coverage-assertions.ts";
import { featureFingerprint } from "../git/fingerprints.ts";
import type { ValidationCursorMetadata } from "./cursors.ts";

function normalizedText(value: unknown): string {
	return String(value || "").replace(/\s+/g, " ").trim();
}

export function validationCursorFingerprint(plan: Partial<MissionPlan>, milestone: Partial<MissionMilestone>, baseHead = "", validator: Partial<ValidationCursorMetadata> = {}): string {
	const contractAssertions = milestoneCoverageAssertions(plan, milestone, "milestone").map((assertion) => ({
		id: String(assertion.id || ""),
		description: normalizedText(assertion.description),
		priority: String(assertion.priority || ""),
		validationMethod: String(assertion.validationMethod || ""),
		coveredBy: (assertion.coveredBy || []).map(String).sort(),
		local: Boolean(assertion.local),
	})).sort((a, b) => a.id.localeCompare(b.id));
	const features = (milestone.features || []).map((feature) => {
		const featureId = safeName(feature.id || feature.title, "feature");
		return {
			id: featureId,
			fingerprint: featureFingerprint(plan, milestone, feature, featureId),
			assertions: (feature.assertions || []).map(String).sort(),
			localAssertions: (feature.localAssertions || []).map(String).sort(),
		};
	});
	return createHash("sha256").update(JSON.stringify({
		schema: "pi-mission-validation-cursor-fingerprint/v1",
		missionId: String(plan.missionId || ""),
		baseHead: String(baseHead || ""),
		goal: normalizedText(plan.goal),
		workerProcedures: normalizedText(plan.workerProcedures),
		sourceDocs: (plan.sourceDocs || []).map(String).sort(),
		milestoneId: String(milestone.id || ""),
		milestoneTitle: normalizedText(milestone.title),
		planner: String(validator.planner || plan.planner || "pi"),
		validatorMode: String(validator.validatorMode || (String(plan.planner || "pi") === "mock" ? "mock" : "pi")),
		requestedValidatorModel: String(validator.requestedModel || ""),
		validatorPiBin: String(validator.piBin || ""),
		commandTimeoutMs: Number(validator.commandTimeoutMs || 0),
		piTimeoutMs: Number(validator.piTimeoutMs || 0),
		piIdleTimeoutMs: Number(validator.piIdleTimeoutMs || 0),
		validatorStableIdentity: Boolean(validator.stableIdentity),
		completionTarget: normalizeCompletionTarget(plan.completionTarget),
		promptVersions: normalizePromptPolicy(plan.promptPolicy),
		validationCategories: normalizeValidationCategories(plan, { includeImplicitAdversarial: true }).map((category) => ({ id: category.id, category: category.category, scope: category.scope, requiredFor: category.requiredFor, commands: category.commands, userTest: category.userTest, adversarial: category.adversarial, modelRole: category.modelRole, credentialGates: category.credentialGates, skipPolicy: category.skipPolicy, adapter: category.adapter, timeoutMs: category.timeoutMs, artifactsRequired: category.artifactsRequired, expectation: category.expectation, successCriteria: category.successCriteria })),
		capabilityPolicy: normalizeCapabilityPolicy(plan.capabilityPolicy),
		validationCommands: (plan.validationCommands || []).map(String),
		userTestCommand: String(plan.userTestCommand || ""),
		contractAssertions,
		features,
	})).digest("hex").slice(0, 24);
}
