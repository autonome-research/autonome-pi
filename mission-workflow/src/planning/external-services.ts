import { VALIDATION_SKIP_POLICIES } from "../core/constants.ts";
import type { ExternalServiceSpec, ValidationSkipPolicy } from "../core/types.ts";
import { safeName } from "../core/text.ts";
import { normalizeRequiredFor } from "./completion.ts";

function objectRecord(value: unknown): Record<string, any> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function normalizeExternalServices(value: unknown = []): ExternalServiceSpec[] {
	return (Array.isArray(value) ? value : []).map((rawService, index) => {
		const service = objectRecord(rawService);
		if (service.skipPolicy !== undefined && service.skipPolicy !== null && service.skipPolicy !== "" && !VALIDATION_SKIP_POLICIES.includes(String(service.skipPolicy) as ValidationSkipPolicy)) throw new Error(`Unknown external service skipPolicy: ${service.skipPolicy}`);
		return {
			id: safeName(service.id || service.name || `external-service-${index + 1}`, `external-service-${index + 1}`),
			purpose: String(service.purpose || ""),
			requiredFor: normalizeRequiredFor(service.requiredFor, ["operationally_ready"], { strict: true }),
			credentialEnv: Array.isArray(service.credentialEnv) ? service.credentialEnv.map(String).filter(Boolean) : [],
			healthCommand: service.healthCommand ? String(service.healthCommand) : undefined,
			smokeCommand: service.smokeCommand ? String(service.smokeCommand) : undefined,
			skipPolicy: service.skipPolicy ? String(service.skipPolicy) as ValidationSkipPolicy : "fail_when_skipped",
			destructive: Boolean(service.destructive),
			liveExternalAction: Boolean(service.liveExternalAction),
		};
	});
}
