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
  return [
    owner.sessionId ? `sessionId: ${owner.sessionId}` : undefined,
    owner.launchSource ? `launch source: ${owner.launchSource}` : undefined,
    owner.cwdAtLaunch ? `cwd at launch: ${owner.cwdAtLaunch}` : undefined,
  ].filter(Boolean).join("  ");
}

export function formatStaleIndicator(run) {
  if (!run?.stale) return "";
  const reason = nonEmptyString(run.stale.reason) || "unknown";
  return `[STALE] ${reason}`;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
