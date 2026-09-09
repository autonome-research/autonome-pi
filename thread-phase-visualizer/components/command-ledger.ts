import type { CommandLedgerProjection, CommandLedgerRow, CommandPreview, CommandState } from "../lib/command-ledger.mjs";
import { formatElapsedDuration } from "../lib/run-display.mjs";

export const RECENT_COMMAND_LIMIT = 3;

const ACTIVE_STATES = new Set<CommandState>(["preparing", "ready", "executing"]);

export type CommandStatePresentation = {
	glyph: string;
	label: string;
	color: "warning" | "accent" | "success" | "error" | "muted";
};

export function compactCommandStateLabel(state: CommandState | string | undefined): string {
	if (state === "ready") return "ready (unobserved)";
	if (state === "finished") return "finished (unobserved)";
	if (state === "preparing") return "preparing args";
	return state || "unknown";
}

export function commandStatePresentation(state: CommandState | string | undefined): CommandStatePresentation {
	switch (state) {
		case "preparing": return { glyph: "◇", label: "preparing args", color: "warning" };
		case "ready": return { glyph: "◇", label: "args ready · outcome unobserved", color: "warning" };
		case "executing": return { glyph: "▶", label: "executing", color: "accent" };
		case "succeeded": return { glyph: "✓", label: "succeeded", color: "success" };
		case "failed": return { glyph: "✗", label: "failed", color: "error" };
		case "interrupted": return { glyph: "!", label: "interrupted", color: "warning" };
		case "finished": return { glyph: "?", label: "finished · outcome unobserved", color: "muted" };
		default: return { glyph: "?", label: "unknown", color: "muted" };
	}
}

function oneLine(value: unknown): string {
	return String(value ?? "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "�")
		.replace(/\s+/g, " ")
		.trim();
}

function scalar(value: unknown): string | undefined {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		const text = oneLine(value);
		return text || undefined;
	}
	return undefined;
}

/** Derive only a concise display hint from already bounded/redacted arguments. */
export function conciseCommand(row: Pick<CommandLedgerRow, "argsPreview" | "toolName">): string {
	const preview = row?.argsPreview?.text;
	if (!preview) return "";
	if (!row.argsPreview?.truncated && !row.argsPreview?.omitted) {
		try {
			const parsed = JSON.parse(preview);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const args = parsed as Record<string, unknown>;
				const command = scalar(args.command ?? args.cmd);
				if (command) return command;
				const path = scalar(args.path ?? args.file_path ?? args.filePath ?? args.cwd);
				const pattern = scalar(args.pattern ?? args.query);
				if (pattern && path) return `${pattern} @ ${path}`;
				if (path) return path;
				if (pattern) return pattern;
				for (const value of Object.values(args)) {
					const candidate = scalar(value);
					if (candidate) return candidate;
				}
			}
		} catch {
			// Legacy/plain or truncated-looking JSON is still useful as bounded text.
		}
	}
	return oneLine(preview);
}

export function commandElapsed(row: Pick<CommandLedgerRow, "executionStartObserved" | "startedAt" | "endedAt">, now = Date.now()): string {
	if (!row?.executionStartObserved || !row.startedAt) return "";
	const elapsed = formatElapsedDuration(row.startedAt, row.endedAt || now);
	return elapsed === "?" ? "" : elapsed;
}

export function visibleCommandRows(
	ledger: CommandLedgerProjection | undefined,
	options: { ownerRunning?: boolean; showAll?: boolean; recentLimit?: number } = {},
): { rows: CommandLedgerRow[]; hiddenCount: number } {
	const rows = Array.isArray(ledger?.rows) ? ledger.rows : [];
	if (options.showAll) return { rows, hiddenCount: 0 };
	const recentLimit = Number.isSafeInteger(options.recentLimit) && Number(options.recentLimit) >= 0
		? Number(options.recentLimit)
		: RECENT_COMMAND_LIMIT;
	const visibleIndexes = new Set<number>();
	if (options.ownerRunning) {
		rows.forEach((row, index) => {
			if (ACTIVE_STATES.has(row.state)) visibleIndexes.add(index);
		});
	}
	const recent = rows
		.map((row, index) => ({ row, index }))
		.filter(({ index }) => !visibleIndexes.has(index))
		.slice(-recentLimit);
	for (const { index } of recent) visibleIndexes.add(index);
	return {
		rows: rows.filter((_row, index) => visibleIndexes.has(index)),
		hiddenCount: rows.length - visibleIndexes.size,
	};
}

export function previewNotices(preview: CommandPreview | undefined): string[] {
	if (!preview) return [];
	const notices: string[] = [];
	if (preview.omitted) notices.push(`omitted: ${preview.omitted}`);
	if (preview.redacted) notices.push("redacted");
	if (preview.truncated) notices.push(`truncated: ${preview.retainedBytes} of ${preview.bytes} bytes retained`);
	return notices;
}
