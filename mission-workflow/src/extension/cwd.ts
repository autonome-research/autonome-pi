import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export function shellUnquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
	return trimmed.replace(/\\ /g, " ");
}

export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
	return input;
}

export function parseSimpleCd(command: string): string | undefined {
	const trimmed = command.trim().replace(/;\s*$/, "");
	const match = trimmed.match(/^cd(?:\s+(.+))?$/);
	if (!match) return undefined;
	return shellUnquote(match[1] || "~");
}

export function directoryExists(candidate: string): boolean {
	try { return existsSync(candidate) && statSync(candidate).isDirectory(); }
	catch { return false; }
}

export function resolveAgainstActive(activeCwd: string, maybePath?: string): string {
	if (!maybePath) return activeCwd;
	return path.resolve(activeCwd, expandHome(maybePath));
}
