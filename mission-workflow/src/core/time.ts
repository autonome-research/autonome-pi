export function parseMillis(value: unknown, fallback: number): number {
	if (value === undefined || value === null || value === "") return fallback;
	const text = String(value).trim().toLowerCase();
	const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
	if (!match) return fallback;
	const number = Number(match[1]);
	if (!Number.isFinite(number) || number <= 0) return fallback;
	const unit = match[2] || "ms";
	const multiplier = unit === "h" ? 60 * 60 * 1000 : unit === "m" ? 60 * 1000 : unit === "s" ? 1000 : 1;
	return Math.max(1, Math.round(number * multiplier));
}
