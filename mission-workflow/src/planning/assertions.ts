import type { ValidationContract } from "../core/types.ts";
import { safeName } from "../core/text.ts";

export type AssertionReferenceValue = string | number | boolean | { id?: unknown; description?: unknown } | null | undefined;

export function canonicalAssertionId(value: AssertionReferenceValue, contract?: Partial<ValidationContract>): string | undefined {
	const assertions = contract?.assertions || [];
	const byId = new Map(assertions.map((assertion) => [String(assertion.id), String(assertion.id)]));
	const byDescription = new Map(assertions.map((assertion) => [String(assertion.description), String(assertion.id)]));
	const candidates: string[] = [];
	if (typeof value === "object" && value) {
		if (value.id) candidates.push(String(value.id));
		if (value.description) candidates.push(String(value.description));
	} else candidates.push(String(value));
	const knownIdsByLength = Array.from(byId.keys()).sort((a, b) => b.length - a.length);
	for (const candidate of candidates) {
		const trimmed = candidate.trim();
		if (byId.has(candidate)) return byId.get(candidate);
		for (const id of knownIdsByLength) {
			if (trimmed === id || trimmed.startsWith(`${id}:`) || trimmed.startsWith(`${id} - `) || trimmed.startsWith(`${id} – `) || trimmed.startsWith(`${id} — `)) return byId.get(id);
		}
		const prefix = candidate.match(/^\s*(assertion-[A-Za-z0-9_.-]+)\s*:/i)?.[1]?.trim();
		if (prefix && byId.has(prefix)) return byId.get(prefix);
		const safe = safeName(candidate, "assertion");
		if (byId.has(safe)) return byId.get(safe);
		if (prefix) {
			const safePrefix = safeName(prefix, "assertion");
			if (byId.has(safePrefix)) return byId.get(safePrefix);
		}
		if (byDescription.has(candidate)) return byDescription.get(candidate);
	}
	return undefined;
}

export function normalizeAssertionReferences(values: unknown, contract?: Partial<ValidationContract>): string[] {
	const list = Array.isArray(values) ? values : values ? [values] : [];
	return Array.from(new Set(list.map((value) => canonicalAssertionId(value as AssertionReferenceValue, contract) || (typeof value === "object" && value ? String((value as any).id || (value as any).description || "") : String(value))).filter(Boolean)));
}

export function normalizeLocalAssertions(values: unknown): string[] {
	const list = Array.isArray(values) ? values : values ? [values] : [];
	return Array.from(new Set(list.map((value) => typeof value === "object" && value ? String((value as any).id || (value as any).description || "") : String(value)).filter(Boolean)));
}
