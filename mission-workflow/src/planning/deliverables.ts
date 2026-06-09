import type { DeliverablesSpec } from "../core/types.ts";

function objectRecord(value: unknown): Record<string, any> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function normalizeDeliverables(value: unknown = {}): Required<DeliverablesSpec> {
	const raw = objectRecord(value);
	return {
		entrypoints: Array.isArray(raw.entrypoints) ? raw.entrypoints : [],
		runtimeArtifacts: Array.isArray(raw.runtimeArtifacts) ? raw.runtimeArtifacts : [],
		runbooks: Array.isArray(raw.runbooks) ? raw.runbooks : [],
	};
}
