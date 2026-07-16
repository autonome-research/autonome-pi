import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Resolve a path and collapse symlinks when the target exists. */
export function canonicalCwd(value, base = process.cwd()) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const expanded = value === "~"
    ? homedir()
    : value.startsWith("~/")
      ? path.join(homedir(), value.slice(2))
      : value;
  const resolved = path.resolve(base, expanded);
  try {
    return realpathSync.native(resolved);
  } catch {
    // Runs may outlive a deleted worktree. Keep path normalization useful even
    // when realpath cannot resolve the old location.
    return resolved;
  }
}

function runCwd(run) {
  const recordedRunCwd = run?.cwd;
  const provenance = run?.workflowStartCwdPresent;

  // A projected workflow_start explicitly records whether cwd existed. Once
  // present, that primary claim is authoritative: invalid/null/blank values
  // fail closed and may not be redirected through descriptive metadata.
  if (provenance === true) {
    return typeof recordedRunCwd === "string" && recordedRunCwd.trim() && path.isAbsolute(recordedRunCwd)
      ? canonicalCwd(recordedRunCwd)
      : undefined;
  }

  // Proven omitted provenance cannot coexist with a concrete primary cwd.
  // Treat contradictory externally supplied summaries as untrusted.
  if (provenance === false && Object.prototype.hasOwnProperty.call(run || {}, "cwd") && recordedRunCwd !== undefined) {
    return undefined;
  }

  // A valid absolute primary cwd remains authoritative for legacy projections.
  if (typeof recordedRunCwd === "string" && recordedRunCwd.trim()) {
    return path.isAbsolute(recordedRunCwd) ? canonicalCwd(recordedRunCwd) : undefined;
  }

  // Metadata fallback is permitted only for a proven omitted workflow_start
  // cwd, or a genuinely legacy object with no primary cwd property at all.
  const legacyOmitted = provenance === false
    || (provenance === undefined && !Object.prototype.hasOwnProperty.call(run || {}, "cwd"));
  if (!legacyOmitted) return undefined;
  const metadata = run?.metadata && typeof run.metadata === "object" ? run.metadata : {};
  for (const value of [metadata.cwdAtLaunch, metadata.cwd]) {
    if (typeof value === "string" && path.isAbsolute(value)) return canonicalCwd(value);
  }
  return undefined;
}

export function matchesRunCwd(run, cwd, base = process.cwd()) {
  return sameCanonicalCwd(runCwd(run), cwd, base);
}

export function sameCanonicalCwd(left, right, base = process.cwd()) {
  // A legacy relative launch path has no trustworthy base. In particular, do
  // not reinterpret it relative to whichever directory happens to be viewing
  // the run; that can expose an unrelated unscoped run after a cwd change.
  if (typeof left !== "string" || !path.isAbsolute(left)) return false;
  const canonicalLeft = canonicalCwd(left);
  const canonicalRight = canonicalCwd(right, base);
  return Boolean(canonicalLeft && canonicalRight && canonicalLeft === canonicalRight);
}

export function runSessionId(run) {
  const sessionId = run?.metadata?.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : undefined;
}

/** Use the same projected/raw status fallback for every scoping decision. */
export function isRunningRun(run, runningStatus = "running") {
  return (run?.normalizedStatus || run?.status) === runningStatus;
}

/**
 * Session ownership always wins. Unowned runs are a narrow live-workflow
 * fallback: they must still be running and their canonical launch cwd must
 * match the active or explicitly requested cwd.
 */
export function canInspectRun(run, sessionId, fallbackCwd, runningStatus = "running") {
  // Store-backed projections explicitly mark a bounded lookup that could not
  // verify workflow_start. Later event metadata/cwd is not ownership evidence.
  if (run?.workflowStartResolved === false) return false;
  const ownerSessionId = runSessionId(run);
  if (ownerSessionId) return Boolean(sessionId && ownerSessionId === sessionId);
  return isRunningRun(run, runningStatus) && sameCanonicalCwd(runCwd(run), fallbackCwd);
}

/**
 * Build the monitor set without leaking another session's runs. Owned runs are
 * visible only to their owner; unowned runs must be running and have a canonical
 * launch cwd matching the monitor cwd.
 */
export function mergeMonitorRuns(runs, cwd, sessionId, runningStatus = "running") {
  const byRun = new Map();
  for (const run of runs || []) {
    if (run?.workflowStartResolved === false) continue;
    const ownerSessionId = runSessionId(run);
    const visible = ownerSessionId
      ? Boolean(sessionId && ownerSessionId === sessionId)
      : isRunningRun(run, runningStatus) && sameCanonicalCwd(runCwd(run), cwd);
    if (visible && run?.runId) byRun.set(run.runId, run);
  }
  return Array.from(byRun.values()).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function shellSegments(command) {
  const segments = [];
  let segment = "";
  let quote;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      segment += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      segment += char;
      escaped = true;
      continue;
    }
    if (quote) {
      segment += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      segment += char;
      continue;
    }
    if (char === ";" || (char === "&" && command[index + 1] === "&")) {
      if (segment.trim()) segments.push(segment.trim());
      segment = "";
      if (char === "&") index++;
      continue;
    }
    segment += char;
  }
  if (quote || escaped) return [];
  if (segment.trim()) segments.push(segment.trim());
  return segments;
}

function shellUnquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed.replace(/\\ /g, " ");
}

/** Return targets only when every shell segment is a simple cd command. */
export function parseCdTargets(command) {
  if (typeof command !== "string") return [];
  const segments = shellSegments(command.trim());
  if (!segments.length) return [];
  const targets = [];
  for (const segment of segments) {
    const match = segment.match(/^cd(?:\s+(.+))?$/);
    if (!match) return [];
    targets.push(shellUnquote(match[1] || "~"));
  }
  return targets;
}

function existingDirectory(value) {
  try {
    return Boolean(value && existsSync(value) && statSync(value).isDirectory());
  } catch {
    return false;
  }
}

export function createCwdState(initialCwd) {
  const activeCwd = canonicalCwd(initialCwd) || path.resolve(initialCwd || process.cwd());
  return { activeCwd, previousCwd: activeCwd };
}

/** Apply one or more chained cd commands, preserving shell-like cd - swaps. */
export function trackCwdCommand(state, command, eventCwd) {
  const targets = parseCdTargets(command);
  if (!targets.length) return state;
  let activeCwd = canonicalCwd(state?.activeCwd || eventCwd) || path.resolve(eventCwd || process.cwd());
  let previousCwd = canonicalCwd(state?.previousCwd || activeCwd) || activeCwd;
  for (const target of targets) {
    const next = target === "-" ? previousCwd : canonicalCwd(target, activeCwd);
    if (!existingDirectory(next)) break;
    previousCwd = activeCwd;
    activeCwd = next;
  }
  return { activeCwd, previousCwd };
}
