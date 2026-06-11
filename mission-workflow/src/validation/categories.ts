import { BEHAVIOR_ADAPTERS, DEFAULT_COMPLETION_TARGET, VALIDATION_CATEGORIES, VALIDATION_SCOPES, VALIDATION_SKIP_POLICIES } from "../core/constants.ts";
import type { BehaviorAdapter, MissionPlan, ValidationCategory, ValidationCategoryKind, ValidationScope, ValidationSkipPolicy } from "../core/types.ts";
import { safeName } from "../core/text.ts";
import { completionLevelAtLeast, normalizeRequiredFor } from "../planning/completion.ts";
import { normalizeDeliverables } from "../planning/deliverables.ts";
import { normalizeExternalServices } from "../planning/external-services.ts";

function objectRecord(value: unknown): Record<string, any> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function normalizeSuccessCriteria(raw: unknown, categoryId = "category"): { mustMatch: string[]; mustNotMatch: string[] } {
	if (raw === undefined || raw === null) return { mustMatch: [], mustNotMatch: [] };
	if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`validation category ${categoryId} successCriteria must be an object with mustMatch/mustNotMatch arrays`);
	const source = raw as Record<string, unknown>;
	const patterns = (value: unknown, field: string): string[] => {
		if (value === undefined || value === null) return [];
		const list = Array.isArray(value) ? value : [value];
		return list.map((item) => {
			const pattern = String(item);
			try { new RegExp(pattern); } catch (error) { throw new Error(`validation category ${categoryId} successCriteria.${field} has an invalid regex (${pattern}): ${(error as Error).message}`); }
			return pattern;
		});
	};
	return { mustMatch: patterns(source.mustMatch, "mustMatch"), mustNotMatch: patterns(source.mustNotMatch, "mustNotMatch") };
}

export type ValidationCategorySource =
	| "plan"
	| "legacy-validation-command"
	| "legacy-user-test"
	| "external-service-health"
	| "external-service-smoke"
	| "deliverable-entrypoint"
	| "deliverable-runtime-artifact"
	| "deliverable-runbook"
	| "implicit-adversarial";

export interface NormalizeValidationCategoriesOptions {
	includeImplicitAdversarial?: boolean;
}

export function normalizeValidationCategory(rawValue: unknown = {}, index = 0, source: ValidationCategorySource = "plan"): ValidationCategory {
	if (rawValue === null || typeof rawValue !== "object" || Array.isArray(rawValue)) throw new Error("validation category must be an object");
	const raw = rawValue as Record<string, any>;
	if (raw.category !== undefined && raw.category !== null && raw.category !== "" && !VALIDATION_CATEGORIES.includes(String(raw.category) as ValidationCategoryKind)) throw new Error(`Unknown validation category: ${raw.category}`);
	if (raw.scope !== undefined && raw.scope !== null && raw.scope !== "" && !VALIDATION_SCOPES.includes(String(raw.scope) as ValidationScope)) throw new Error(`Unknown validation category scope: ${raw.scope}`);
	if (raw.adapter !== undefined && raw.adapter !== null && raw.adapter !== "" && !BEHAVIOR_ADAPTERS.includes(String(raw.adapter) as BehaviorAdapter)) throw new Error(`Unknown validation category adapter: ${raw.adapter}`);
	const category = raw.category ? String(raw.category) as ValidationCategoryKind : "scrutiny";
	const commands = Array.isArray(raw.commands) ? raw.commands.map(String).filter(Boolean) : raw.command ? [String(raw.command)] : [];
	const userTest = Boolean(raw.userTest);
	const idFallback = source === "legacy-validation-command" ? `validation-command-${String(index + 1).padStart(3, "0")}` : source === "legacy-user-test" ? "user-test-command" : `${category}-${index + 1}`;
	if (raw.skipPolicy !== undefined && raw.skipPolicy !== null && raw.skipPolicy !== "" && !VALIDATION_SKIP_POLICIES.includes(String(raw.skipPolicy) as ValidationSkipPolicy)) throw new Error(`Unknown validation category skipPolicy: ${raw.skipPolicy}`);
	const skipPolicy = raw.skipPolicy ? String(raw.skipPolicy) as ValidationSkipPolicy : "fail_when_skipped";
	const scope = raw.scope ? String(raw.scope) as ValidationScope : "milestone";
	const adapter = raw.adapter || (category === "behavior" ? "command" : undefined);
	const timeoutMs = raw.timeoutMs === undefined || raw.timeoutMs === null ? null : (() => {
		const n = Number(raw.timeoutMs);
		if (!Number.isFinite(n) || n <= 0) throw new Error(`validation category ${raw.id || idFallback} timeoutMs must be a positive finite number`);
		return n;
	})();
	const expectation = raw.expectation === undefined || raw.expectation === null ? "" : String(raw.expectation).trim();
	const successCriteria = normalizeSuccessCriteria(raw.successCriteria, String(raw.id || idFallback));
	return {
		id: safeName(raw.id || idFallback, idFallback),
		category,
		title: String(raw.title || (userTest ? "Run user/behavior test command" : commands[0] ? `Run ${category} validation command` : `${category} validation`)),
		scope,
		requiredFor: normalizeRequiredFor(raw.requiredFor, [DEFAULT_COMPLETION_TARGET], { strict: true }),
		commands,
		userTest,
		adversarial: Boolean(raw.adversarial),
		modelRole: String(raw.modelRole || (category === "domain" ? "domainCritic" : ["operational", "deployment"].includes(category) ? "opsCritic" : "validator")),
		credentialGates: Array.isArray(raw.credentialGates) ? raw.credentialGates.map(String).filter(Boolean) : [],
		skipPolicy,
		timeoutMs,
		artifactsRequired: Array.isArray(raw.artifactsRequired) ? raw.artifactsRequired.map(String).filter(Boolean) : [],
		expectation,
		successCriteria,
		...(adapter && BEHAVIOR_ADAPTERS.includes(String(adapter) as BehaviorAdapter) ? { adapter: String(adapter) as BehaviorAdapter } : {}),
	};
}

export function normalizeValidationCategories(planValue: Partial<MissionPlan> = {}, options: NormalizeValidationCategoriesOptions = {}): ValidationCategory[] {
	const plan = objectRecord(planValue);
	const categories: ValidationCategory[] = [];
	const uniqueId = (id: string) => {
		let candidate = String(id || "validation-category");
		let suffix = 2;
		while (categories.some((item) => item.id === candidate)) candidate = `${id}-${suffix++}`;
		return candidate;
	};
	const add = (category: ValidationCategory, opts: { forceUnique?: boolean } = {}) => {
		let key = String(category.id || "");
		if (!key) return;
		if (categories.some((item) => item.id === key)) {
			if (!opts.forceUnique) return;
			key = uniqueId(key);
			category = { ...category, id: key };
		}
		categories.push(category);
	};
	const hasEquivalentLegacyCommand = (command: string) => categories.some((category) => category.category === "scrutiny" && !category.userTest && !category.adversarial && category.scope === "milestone" && category.skipPolicy !== "optional" && (category.requiredFor || []).includes(DEFAULT_COMPLETION_TARGET) && (category.commands || []).length === 1 && category.commands?.[0] === command);
	const hasEquivalentLegacyUserTest = (command: string) => categories.some((category) => category.category === "behavior" && category.userTest === true && !category.adversarial && category.scope === "milestone" && category.skipPolicy !== "optional" && (category.requiredFor || []).includes(DEFAULT_COMPLETION_TARGET) && (category.commands || []).length === 1 && category.commands?.[0] === command);
	const explicitIds = new Set<string>();
	(Array.isArray(plan.validationCategories) ? plan.validationCategories : []).forEach((category, index) => {
		if (category && typeof category === "object" && "generatedFrom" in category && category.generatedFrom) return;
		const normalized = normalizeValidationCategory(category, index, "plan");
		if (explicitIds.has(normalized.id)) throw new Error(`Duplicate validation category id: ${normalized.id}`);
		explicitIds.add(normalized.id);
		add(normalized);
	});
	const addGenerated = (category: ValidationCategory, generatedFrom: string) => {
		if (explicitIds.has(category.id)) throw new Error(`Explicit validation category id conflicts with generated category: ${category.id}`);
		add({ ...category, generatedFrom }, { forceUnique: true });
	};
	normalizeExternalServices(plan.externalServices).forEach((service, index) => {
		if (service.healthCommand) addGenerated(normalizeValidationCategory({ id: `external-${service.id}-health`, category: "operational", title: `External service health: ${service.id}`, commands: [service.healthCommand], requiredFor: service.requiredFor, credentialGates: service.credentialEnv, skipPolicy: service.skipPolicy, adapter: "command" }, index, "external-service-health"), "externalServices.healthCommand");
		if (service.smokeCommand) addGenerated(normalizeValidationCategory({ id: `external-${service.id}-smoke`, category: "integration", title: `External service smoke: ${service.id}`, commands: [service.smokeCommand], requiredFor: service.requiredFor, credentialGates: service.credentialEnv, skipPolicy: service.skipPolicy, adapter: "command" }, index, "external-service-smoke"), "externalServices.smokeCommand");
	});
	const deliverables = normalizeDeliverables(plan.deliverables);
	const deliverableRequiredFor = (item: any) => normalizeRequiredFor(item?.requiredFor, ["operationally_ready"], { strict: true });
	(deliverables.entrypoints || []).forEach((entrypoint: any, index) => {
		if (!entrypoint?.validationCommand) return;
		addGenerated(normalizeValidationCategory({ id: entrypoint.id || `deliverable-entrypoint-${safeName(entrypoint.name || index + 1, `entrypoint-${index + 1}`)}`, category: entrypoint.category || "operational", title: `Deliverable entrypoint: ${entrypoint.name || entrypoint.command || index + 1}`, commands: [String(entrypoint.validationCommand)], requiredFor: deliverableRequiredFor(entrypoint), skipPolicy: entrypoint.skipPolicy, adapter: "command" }, index, "deliverable-entrypoint"), "deliverables.entrypoints");
	});
	(deliverables.runtimeArtifacts || []).forEach((item: any, index) => {
		if (!item?.path) return;
		addGenerated(normalizeValidationCategory({ id: item.id || `deliverable-runtime-${safeName(item.path, `runtime-${index + 1}`)}`, category: item.category || "operational", title: `Runtime artifact: ${item.path}`, commands: [String(item.validationCommand || "true")], artifactsRequired: [String(item.path)], requiredFor: deliverableRequiredFor(item), skipPolicy: item.skipPolicy, adapter: "command" }, index, "deliverable-runtime-artifact"), "deliverables.runtimeArtifacts");
	});
	(deliverables.runbooks || []).forEach((item: any, index) => {
		if (!item?.path) return;
		addGenerated(normalizeValidationCategory({ id: item.id || `deliverable-runbook-${safeName(item.path, `runbook-${index + 1}`)}`, category: item.category || "operational", title: `Runbook artifact: ${item.path}`, commands: [String(item.validationCommand || "true")], artifactsRequired: [String(item.path)], requiredFor: deliverableRequiredFor(item), skipPolicy: item.skipPolicy, adapter: "command" }, index, "deliverable-runbook"), "deliverables.runbooks");
	});
	(Array.isArray(plan.validationCommands) ? plan.validationCommands : []).map(String).filter(Boolean).forEach((command, index) => { if (!hasEquivalentLegacyCommand(command)) add(normalizeValidationCategory({ category: "scrutiny", title: `Validation command: ${command}`, commands: [command] }, index, "legacy-validation-command"), { forceUnique: true }); });
	if (plan.userTestCommand && !hasEquivalentLegacyUserTest(String(plan.userTestCommand))) add(normalizeValidationCategory({ id: "user-test-command", category: "behavior", title: "User/behavior test command", commands: [String(plan.userTestCommand)], userTest: true, adapter: "command" }, 0, "legacy-user-test"), { forceUnique: true });
	if (options.includeImplicitAdversarial && completionLevelAtLeast(plan.completionTarget, DEFAULT_COMPLETION_TARGET)) add(normalizeValidationCategory({ id: "adversarial-scrutiny", category: "scrutiny", title: "Adversarial contract scrutiny", commands: [], adversarial: true, requiredFor: [DEFAULT_COMPLETION_TARGET], modelRole: "validator" }, categories.length, "implicit-adversarial"));
	return categories;
}
