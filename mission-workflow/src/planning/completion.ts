import { COMPLETION_LEVELS, DEFAULT_COMPLETION_TARGET } from "../core/constants.ts";
import type { CompletionLevel, CompletionLevels } from "../core/types.ts";

export interface NormalizeCompletionOptions {
	strict?: boolean;
}

export function normalizeCompletionTarget(value: unknown, options: NormalizeCompletionOptions = {}): CompletionLevel {
	if (value === undefined || value === null || value === "") return DEFAULT_COMPLETION_TARGET;
	const target = String(value).trim();
	if (COMPLETION_LEVELS.includes(target as CompletionLevel)) return target as CompletionLevel;
	if (options.strict) throw new Error(`Unknown completion target: ${target}`);
	return DEFAULT_COMPLETION_TARGET;
}

export function completionLevelAtLeast(value: unknown, target: unknown): boolean {
	return COMPLETION_LEVELS.indexOf(normalizeCompletionTarget(value)) >= COMPLETION_LEVELS.indexOf(normalizeCompletionTarget(target));
}

export function normalizeRequiredFor(value: unknown, fallback: CompletionLevel[] = [DEFAULT_COMPLETION_TARGET], options: NormalizeCompletionOptions = {}): CompletionLevel[] {
	const list = Array.isArray(value) ? value : value ? [value] : fallback;
	const normalized: CompletionLevel[] = [];
	for (const item of list) {
		if (item === undefined || item === null || item === "") continue;
		const text = String(item).trim();
		if (!COMPLETION_LEVELS.includes(text as CompletionLevel)) {
			if (options.strict) throw new Error(`Unknown completion level in requiredFor: ${text}`);
			normalized.push(DEFAULT_COMPLETION_TARGET);
		} else normalized.push(text as CompletionLevel);
	}
	return Array.from(new Set(normalized.length ? normalized : fallback));
}

export function normalizeCompletionLevels(value: unknown, target: unknown = DEFAULT_COMPLETION_TARGET): Required<CompletionLevels> {
	const targetIndex = COMPLETION_LEVELS.indexOf(normalizeCompletionTarget(target));
	const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
	const out = {} as Required<CompletionLevels>;
	COMPLETION_LEVELS.forEach((level, index) => {
		const existing = raw[level] && typeof raw[level] === "object" && !Array.isArray(raw[level]) ? raw[level] : {};
		out[level] = { ...existing, required: typeof existing.required === "boolean" ? existing.required : index <= targetIndex };
	});
	return out;
}
