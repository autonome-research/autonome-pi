import { DEFAULT_CAPABILITY_POLICY, DEFAULT_PROMPT_POLICY } from "../core/constants.ts";
import type { CapabilityPolicy, PromptPolicy, RolePolicy } from "../core/types.ts";

function objectRecord(value: unknown): Record<string, any> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export interface RolePolicyModels {
	modelPlan?: string;
	modelWorker?: string;
	modelValidator?: string;
	modelDomain?: string;
	modelOps?: string;
}

export function normalizeRolePolicy(value: unknown = {}, models: RolePolicyModels = {}): Required<RolePolicy> {
	const raw = objectRecord(value);
	const role = (name: string, defaults: Record<string, unknown> = {}) => ({ ...defaults, ...objectRecord(raw[name]) });
	const out = {
		planner: role("planner", { profile: "high_reasoning" }),
		worker: role("worker", { profile: "code_fluent" }),
		validator: role("validator", { profile: "adversarial_precise" }),
		domainCritic: role("domainCritic", { profile: "domain_specialist", enabled: false }),
		opsCritic: role("opsCritic", { profile: "sre_operational", enabled: false }),
	} as Required<RolePolicy>;
	if (models.modelPlan) out.planner.model = String(models.modelPlan);
	if (models.modelWorker) out.worker.model = String(models.modelWorker);
	if (models.modelValidator) out.validator.model = String(models.modelValidator);
	if (models.modelDomain) out.domainCritic.model = String(models.modelDomain);
	if (models.modelOps) out.opsCritic.model = String(models.modelOps);
	return out;
}

export function normalizeCapabilityPolicy(value: unknown = {}): Required<CapabilityPolicy> {
	const raw = objectRecord(value);
	const maxCommandTimeoutMs = Number(raw.maxCommandTimeoutMs || DEFAULT_CAPABILITY_POLICY.maxCommandTimeoutMs);
	return {
		...DEFAULT_CAPABILITY_POLICY,
		...raw,
		maxCommandTimeoutMs: Number.isFinite(maxCommandTimeoutMs) && maxCommandTimeoutMs > 0 ? maxCommandTimeoutMs : DEFAULT_CAPABILITY_POLICY.maxCommandTimeoutMs,
	} as Required<CapabilityPolicy>;
}

export function normalizePromptPolicy(value: unknown = {}): Required<PromptPolicy> {
	return { ...DEFAULT_PROMPT_POLICY, ...objectRecord(value) } as Required<PromptPolicy>;
}
