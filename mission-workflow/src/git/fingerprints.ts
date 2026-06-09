import { createHash } from "node:crypto";
import type { MissionFeature, MissionMilestone, MissionPlan, ValidationContractAssertion } from "../core/types.ts";
import { safeName } from "../core/text.ts";

function normalizedText(value: unknown): string {
	return String(value || "").replace(/\s+/g, " ").trim();
}

function hashJson(value: unknown, length: number): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);
}

function normalizedContractAssertion(assertion: Partial<ValidationContractAssertion>) {
	return {
		id: String(assertion.id || ""),
		description: normalizedText(assertion.description),
		priority: String(assertion.priority || ""),
		validationMethod: String(assertion.validationMethod || ""),
		coveredBy: (assertion.coveredBy || []).map(String).sort(),
	};
}

export function expectedFeatureCommitSubject(plan: Pick<MissionPlan, "missionId">, feature: Partial<MissionFeature>, featureId: string): string {
	const title = normalizedText(feature.title || featureId).slice(0, 160) || featureId;
	return `mission(${plan.missionId}): ${title}`;
}

export function missionPlanFingerprint(plan: Partial<MissionPlan>, baseHead = ""): string {
	const normalizedAssertions = (plan.validationContract?.assertions || []).map(normalizedContractAssertion).sort((a, b) => a.id.localeCompare(b.id));
	const milestones = (plan.milestones || []).map((milestone) => ({
		id: String(milestone.id || ""),
		title: normalizedText(milestone.title),
		features: (milestone.features || []).map((feature) => ({
			id: safeName(feature.id || feature.title, "feature"),
			title: normalizedText(feature.title),
			description: feature.repair ? "" : normalizedText(feature.description),
			repair: Boolean(feature.repair),
			assertions: (feature.assertions || []).map(String).sort(),
			localAssertions: (feature.localAssertions || []).map(String).sort(),
		})),
	}));
	return hashJson({ schema: "pi-mission-plan-fingerprint/v1", missionId: String(plan.missionId || ""), baseHead: String(baseHead || ""), validationContract: normalizedAssertions, milestones }, 24);
}

export function parseRepairSignatureFromId(featureId: unknown): string | undefined {
	const match = String(featureId || "").match(/^repair-[^-]+-\d+-([0-9a-f]{10})(?:-|$)/i);
	return match ? match[1].toLowerCase() : undefined;
}

export function repairSignatureFromFeature(feature: Partial<MissionFeature> | undefined, featureId: string): string | undefined {
	if (!feature?.repair) return undefined;
	return String((feature as any).repairSignature || (feature as any).repairHash || parseRepairSignatureFromId(featureId) || "").toLowerCase() || undefined;
}

export function repairSignatureFromRecord(record: any): string | undefined {
	return String(record?.repairSignature || record?.repairHash || parseRepairSignatureFromId(record?.featureId) || "").toLowerCase() || undefined;
}

export function featureFingerprint(plan: Partial<MissionPlan>, milestone: Partial<MissionMilestone> | undefined, feature: Partial<MissionFeature>, featureId: string): string {
	const contract = new Map((plan.validationContract?.assertions || []).map((assertion) => [String(assertion.id), assertion]));
	const assertionIds = (feature.assertions || []).map(String).sort();
	const contractAssertions = assertionIds.map((id) => normalizedContractAssertion(contract.get(id) || { id }));
	return hashJson({
		schema: "pi-mission-feature-fingerprint/v2",
		milestoneId: String(milestone?.id || ""),
		featureId,
		title: normalizedText(feature.title),
		description: feature.repair ? "" : normalizedText(feature.description),
		repair: Boolean(feature.repair),
		assertions: assertionIds,
		contractAssertions,
		localAssertions: (feature.localAssertions || []).map(String).sort(),
	}, 24);
}
