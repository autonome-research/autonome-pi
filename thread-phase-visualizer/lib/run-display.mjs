import { canInspectRun, runSessionId } from "./session-scope.mjs";

export { runSessionId };

export function belongsToSession(run, sessionId, cwd) {
  return canInspectRun(run, sessionId, cwd);
}

export function runOwnerMetadata(run) {
  const metadata = run?.metadata && typeof run.metadata === "object" ? run.metadata : {};
  const sessionId = runSessionId(run);
  const launchSource = nonEmptyString(metadata.launchSource) || nonEmptyString(metadata.source);
  const cwdAtLaunch = nonEmptyString(metadata.cwdAtLaunch) || nonEmptyString(metadata.cwd) || nonEmptyString(run?.cwd);
  return { sessionId, launchSource, cwdAtLaunch };
}

export function formatOwnerMetadata(run) {
  const owner = runOwnerMetadata(run);
  // Low-signal, non-actionable provenance is omit from normal displays (audit
  // MUST): opaque full session IDs and launch cwd. Retain only short launchSource.
  return [owner.launchSource ? `launch source: ${owner.launchSource}` : undefined]
    .filter(Boolean)
    .join("  ");
}

export function formatStaleIndicator(run) {
  if (!run?.stale) return "";
  const reason = nonEmptyString(run.stale.reason) || "unknown";
  return `[STALE] ${reason}`;
}

export function formatElapsedDuration(startedAt, endedAt) {
  const start = startedAt instanceof Date ? startedAt.getTime() : typeof startedAt === "number" ? startedAt : Date.parse(String(startedAt || ""));
  const end = endedAt instanceof Date ? endedAt.getTime() : typeof endedAt === "number" ? endedAt : Date.parse(String(endedAt || ""));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "?";
  const totalSeconds = Math.floor((end - start) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  // For hour-scale durations, seconds are low-signal churn; emit h (+ m) only.
  if (hours > 0) return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
  return [minutes ? `${minutes}m` : undefined, `${seconds}s`].filter(Boolean).join(" ");
}

function tokenValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function processedTokenTotal(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const declaredTotal = tokenValue(usage.totalTokens);
  if (declaredTotal) return declaredTotal;
  // ThreadPhaseUsageSummary is canonical Pi-normalized data: inputTokens is
  // uncached input, so cache read/write traffic belongs in processed total.
  return tokenValue(usage.inputTokens)
    + tokenValue(usage.cachedInputTokens)
    + tokenValue(usage.cacheCreationInputTokens)
    + tokenValue(usage.outputTokens);
}

export function formatTotalTokens(usage) {
  const total = processedTokenTotal(usage);
  return total ? `${compactNumber(total)} cumulative processed tokens` : "";
}

export function formatOutputTokens(usage) {
  const output = tokenValue(usage?.outputTokens);
  return output ? `${compactNumber(output)} output` : "";
}

export function formatTokenSummary(usage) {
  return [formatOutputTokens(usage), formatTotalTokens(usage)].filter(Boolean).join(" · ");
}

export function formatTokenBreakdown(usage) {
  if (!usage || typeof usage !== "object") return [];
  const input = tokenValue(usage.inputTokens);
  const cacheRead = tokenValue(usage.cachedInputTokens);
  const cacheWrite = tokenValue(usage.cacheCreationInputTokens);
  const output = tokenValue(usage.outputTokens);
  const reasoning = Math.min(output, tokenValue(usage.reasoningTokens));
  const total = processedTokenTotal(usage);
  if (!input && !cacheRead && !cacheWrite && !output && !total) return [];
  return [
    `${formatInteger(input)} uncached input · ${formatInteger(cacheRead)} cache-read input · ${formatInteger(cacheWrite)} cache-write input`,
    `${formatInteger(output)} output${reasoning ? ` (${formatInteger(reasoning)} reasoning included)` : ""} · ${formatInteger(total)} cumulative processed tokens`,
  ];
}

function formatInteger(value) {
  return Math.round(value).toLocaleString("en-US");
}

function compactNumber(value) {
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return String(Math.round(value));
}

function trimDecimal(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
