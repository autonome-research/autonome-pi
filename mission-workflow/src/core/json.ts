import { readFileSync } from "node:fs";
import { MAX_PROMPT_CONTEXT_BYTES } from "./constants.ts";
import { compactText } from "./text.ts";

export function compactJson(value: unknown, maxBytes = MAX_PROMPT_CONTEXT_BYTES): string {
	const text = JSON.stringify(value, null, 2);
	if (text === undefined) throw new TypeError("compactJson value is not JSON-serializable");
	return compactText(text, maxBytes);
}

export function readJsonFile<T = unknown>(file: string, fallback?: T): T | undefined {
	try { return JSON.parse(readFileSync(file, "utf8")) as T; }
	catch { return fallback; }
}
