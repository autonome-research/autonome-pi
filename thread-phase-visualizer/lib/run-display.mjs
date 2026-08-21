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

export function formatTotalTokens(usage) {
  if (!usage || typeof usage !== "object") return "";
  const declaredTotal = Number(usage.totalTokens);
  const derivedTotal = Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0);
  const total = Number.isFinite(declaredTotal) && declaredTotal > 0 ? declaredTotal : derivedTotal;
  if (!Number.isFinite(total) || total <= 0) return "";
  return `${compactNumber(total)} tok`;
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
