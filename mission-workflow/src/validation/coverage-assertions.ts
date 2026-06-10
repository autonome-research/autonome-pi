import type { MissionMilestone, MissionPlan, ValidationContractAssertion } from "../core/types.ts";

export type CoverageAssertion = ValidationContractAssertion & { local?: boolean };

export function contractAssertionMap(plan: Partial<MissionPlan>): Map<string, ValidationContractAssertion> {
	return new Map((plan.validationContract?.assertions || []).map((assertion) => [String(assertion.id), assertion]));
}

export function knownContractAssertionIds(plan: Partial<MissionPlan>): Set<string> {
	return new Set((plan.validationContract?.assertions || []).map((assertion) => String(assertion.id)));
}

export function milestoneAssertionIds(plan: Partial<MissionPlan>, milestone: Partial<MissionMilestone>): Set<string> {
	const known = contractAssertionMap(plan);
	const ids = new Set<string>();
	for (const feature of milestone.features || []) for (const id of feature.assertions || []) if (known.has(String(id))) ids.add(String(id));
	return ids;
}

export function milestoneCoverageAssertions(plan: Partial<MissionPlan>, milestone?: Partial<MissionMilestone>, scope = "milestone"): CoverageAssertion[] {
	if (scope === "final" || !milestone) return plan.validationContract?.assertions || [];
	const known = contractAssertionMap(plan);
	const ids = milestoneAssertionIds(plan, milestone);
	const rows = Array.from(ids).map((id) => known.get(id)).filter(Boolean) as CoverageAssertion[];
	const seen = new Set(rows.map((assertion) => String(assertion.id)));
	for (const feature of milestone.features || []) for (const assertion of feature.localAssertions || []) {
		const id = String(assertion);
		if (seen.has(id)) continue;
		seen.add(id);
		rows.push({ id, description: id, priority: "must", local: true });
	}
	return rows;
}
