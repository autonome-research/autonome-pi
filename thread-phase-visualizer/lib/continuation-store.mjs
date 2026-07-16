import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const DEFAULT_CONTINUATION_LIMIT = 500;
export const DEFAULT_CONTINUATION_RETENTION_MS = 24 * 60 * 60 * 1000;
export const CONTINUED_RUNS_FILENAME = "continued-runs.json";
export const CONTINUATION_TIMESTAMPS_FILENAME = "continued-runs.timestamps.json";

// Remember the contents originally loaded into a Set so persisting that Set can
// append only its new ids. A stale full snapshot must never resurrect ids that
// a competing writer has already pruned or move them behind newer claims.
const loadedSnapshotBaselines = new WeakMap();

/** Only explicitly opted-in successful runs may queue an automatic continuation. */
export function shouldAutoContinue(run) {
  if (run?.normalizedStatus !== "success") return false;
  return run?.metadata?.autoContinue === true || run?.metadata?.autoContinue === "always";
}

export function continuedRunsFile(storeDir) {
  if (!storeDir) throw new Error("thread-phase store directory is required");
  return join(storeDir, CONTINUED_RUNS_FILENAME);
}

export function pruneContinuedRuns(runs, maxEntries = DEFAULT_CONTINUATION_LIMIT) {
  const limit = normalizeLimit(maxEntries);
  const values = Array.from(runs || []).filter(isRunId);
  const retained = limit === 0 ? [] : values.slice(-limit);
  if (runs instanceof Set) {
    runs.clear();
    for (const runId of retained) runs.add(runId);
    return runs;
  }
  return new Set(retained);
}

export function loadContinuedRuns({ storeDir, maxEntries = DEFAULT_CONTINUATION_LIMIT, maxAgeMs = DEFAULT_CONTINUATION_RETENTION_MS, now } = {}) {
  const file = continuedRunsFile(storeDir);
  const lockFile = `${file}.lock`;
  mkdirSync(storeDir, { recursive: true });
  const releaseLock = acquireContinuationLock(lockFile);
  let records;
  try {
    const persisted = readPersistedContinuationRecords(file);
    if (!persisted.exists) return new Set();
    records = canonicalContinuationRecords(persisted.values, {
      maxEntries,
      maxAgeMs,
      now,
      legacyTimestamp: persisted.legacyTimestamp,
    });
    if (!persistedStateMatches(persisted, records)) writeContinuationState(file, storeDir, records);
  } finally {
    releaseLock();
  }
  const normalized = continuationRecordSet(records);
  // Remember identity so a stale Set later contributes only its additions;
  // retained claims keep their persisted expiration timestamps on disk.
  rememberLoadedSnapshot(normalized);
  return normalized;
}

export function persistContinuedRuns(runs, { storeDir, maxEntries = DEFAULT_CONTINUATION_LIMIT, maxAgeMs = DEFAULT_CONTINUATION_RETENTION_MS, now } = {}) {
  const file = continuedRunsFile(storeDir);
  const lockFile = `${file}.lock`;
  const requested = Array.from(runs || []).filter(isRunId);
  const baseline = runs instanceof Set ? loadedSnapshotBaselines.get(runs) : undefined;
  const additions = baseline ? requested.filter((runId) => !baseline.ids.has(runId)) : requested;
  const claimedAt = continuationNow(now);
  mkdirSync(storeDir, { recursive: true });
  const releaseLock = acquireContinuationLock(lockFile);
  let records;
  try {
    const persisted = readPersistedContinuationRecords(file);
    records = canonicalContinuationRecords(persisted.values, {
      maxAgeMs,
      now: claimedAt,
      legacyTimestamp: persisted.legacyTimestamp,
    });
    // Existing ids retain their persisted order and timestamp. Reordering a
    // stale snapshot could otherwise evict a competing writer's newer claim.
    for (const runId of additions) {
      if (!records.some((record) => record.runId === runId)) records.push({ runId, continuedAt: claimedAt });
    }
    records = pruneContinuationRecords(records, maxEntries);
    writeContinuationState(file, storeDir, records);
  } finally {
    releaseLock();
  }

  const normalized = continuationRecordSet(records);
  if (runs instanceof Set) {
    runs.clear();
    for (const runId of normalized) runs.add(runId);
    rememberLoadedSnapshot(runs);
    return runs;
  }
  rememberLoadedSnapshot(normalized);
  return normalized;
}

/**
 * Atomically claim one run before delivering its continuation. The single-id
 * delta avoids stale snapshots resurrecting pruned history, and the returned
 * flag is true only after the claim has been durably renamed into place.
 */
export function persistContinuationClaim(runId, { storeDir, maxEntries = DEFAULT_CONTINUATION_LIMIT, maxAgeMs = DEFAULT_CONTINUATION_RETENTION_MS, now } = {}) {
  if (!isRunId(runId)) throw new Error("a non-empty continuation run id is required");
  const file = continuedRunsFile(storeDir);
  const lockFile = `${file}.lock`;
  const claimedAt = continuationNow(now);
  mkdirSync(storeDir, { recursive: true });
  const releaseLock = acquireContinuationLock(lockFile);
  try {
    const persisted = readPersistedContinuationRecords(file);
    let records = canonicalContinuationRecords(persisted.values, {
      maxAgeMs,
      now: claimedAt,
      legacyTimestamp: persisted.legacyTimestamp,
    });
    if (records.some((record) => record.runId === runId)) {
      if (!persistedStateMatches(persisted, records)) writeContinuationState(file, storeDir, records);
      return { claimed: false, runs: continuationRecordSet(records) };
    }
    records.push({ runId, continuedAt: claimedAt });
    records = pruneContinuationRecords(records, maxEntries);
    writeContinuationState(file, storeDir, records);
    const runs = continuationRecordSet(records);
    // A zero-capacity store cannot durably retain a claim, so callers must not
    // deliver a continuation based merely on the attempted append.
    return { claimed: runs.has(runId), runs };
  } finally {
    releaseLock();
  }
}

/** Release a claim whose synchronous message enqueue failed so it can retry. */
export function releaseContinuationClaim(runId, { storeDir, maxEntries = DEFAULT_CONTINUATION_LIMIT, maxAgeMs = DEFAULT_CONTINUATION_RETENTION_MS, now } = {}) {
  if (!isRunId(runId)) throw new Error("a non-empty continuation run id is required");
  const file = continuedRunsFile(storeDir);
  const lockFile = `${file}.lock`;
  mkdirSync(storeDir, { recursive: true });
  const releaseLock = acquireContinuationLock(lockFile);
  try {
    const persisted = readPersistedContinuationRecords(file);
    let records = canonicalContinuationRecords(persisted.values, {
      maxEntries,
      maxAgeMs,
      now,
      legacyTimestamp: persisted.legacyTimestamp,
    });
    const retained = records.filter((record) => record.runId !== runId);
    const released = retained.length !== records.length;
    records = pruneContinuationRecords(retained, maxEntries);
    if (released || !persistedStateMatches(persisted, records)) writeContinuationState(file, storeDir, records);
    return { released, runs: continuationRecordSet(records) };
  } finally {
    releaseLock();
  }
}

function writeContinuationState(file, storeDir, records) {
  const timestampsFile = join(storeDir, CONTINUATION_TIMESTAMPS_FILENAME);
  const ids = records.map((record) => record.runId);
  const timestamps = Object.fromEntries(records.map((record) => [record.runId, record.continuedAt]));
  // Write timestamp metadata first. If the process stops between renames, the
  // authoritative string array remains valid and its mtime supplies a safe
  // fallback for any id without compatible side metadata.
  writeJsonAtomic(timestampsFile, storeDir, timestamps);
  writeJsonAtomic(file, storeDir, ids);
}

function writeJsonAtomic(file, storeDir, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  renameSync(temporary, file);
  const directoryFd = openSync(storeDir, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function readPersistedContinuationRecords(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const canonicalArray = Array.isArray(parsed);
    const rawValues = canonicalArray ? parsed : [];
    const legacyTimestamp = statSync(file).mtime.toISOString();
    const timestamps = readContinuationTimestamps(join(dirname(file), CONTINUATION_TIMESTAMPS_FILENAME));
    const values = rawValues.map((value) => {
      if (!isRunId(value)) return value;
      return { runId: value, continuedAt: Object.hasOwn(timestamps, value) ? timestamps[value] : legacyTimestamp };
    });
    return { exists: true, canonicalArray, rawValues, timestamps, values, legacyTimestamp };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return { exists: false, rawValues: [], timestamps: {}, values: [], legacyTimestamp: undefined };
    }
    throw error;
  }
}

function readContinuationTimestamps(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

function persistedStateMatches(persisted, records) {
  if (!persisted.canonicalArray) return false;
  const ids = records.map((record) => record.runId);
  if (JSON.stringify(persisted.rawValues) !== JSON.stringify(ids)) return false;
  const timestamps = Object.fromEntries(records.map((record) => [record.runId, record.continuedAt]));
  return JSON.stringify(persisted.timestamps) === JSON.stringify(timestamps);
}

function acquireContinuationLock(lockFile) {
  const timeoutAt = Date.now() + 5_000;
  while (true) {
    try {
      const token = `${process.pid}:${randomUUID()}`;
      const fd = openSync(lockFile, "wx", 0o600);
      try {
        writeFileSync(fd, token, "utf8");
      } catch (error) {
        rmSync(lockFile, { force: true });
        throw error;
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readFileSync(lockFile, "utf8") === token) rmSync(lockFile, { force: true });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const token = readFileSync(lockFile, "utf8");
        if (lockOwnerExited(token) || Date.now() - statSync(lockFile).mtimeMs > 30_000) {
          // Recheck the token before unlinking so a released/reacquired lock is
          // not mistaken for the stale lock that we inspected.
          if (readFileSync(lockFile, "utf8") === token) rmSync(lockFile, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= timeoutAt) throw new Error(`Timed out waiting for continuation store lock: ${lockFile}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function lockOwnerExited(token) {
  const match = /^(\d+):/.exec(token);
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  // Lock sections are synchronous and cannot overlap within one process. A
  // same-PID lock therefore belongs to an abandoned extension instance (for
  // example after an immediate reload) and is safe to reclaim without delay.
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    throw error;
  }
}

function canonicalContinuationRecords(values, { maxEntries, maxAgeMs = DEFAULT_CONTINUATION_RETENTION_MS, now, legacyTimestamp } = {}) {
  const referenceTime = Date.parse(continuationNow(now));
  const retention = normalizeAge(maxAgeMs);
  const cutoff = referenceTime - retention;
  const byRunId = new Map();
  // Last occurrence is authoritative, preserving the established legacy
  // duplicate semantics and making ordering deterministic across reloads.
  for (const value of values || []) {
    const runId = isRunId(value) ? value : value && typeof value === "object" && isRunId(value.runId) ? value.runId : undefined;
    if (!runId) continue;
    const candidateTimestamp = isRunId(value) ? legacyTimestamp : value.continuedAt;
    const timestampMs = Date.parse(String(candidateTimestamp || ""));
    if (!Number.isFinite(timestampMs) || timestampMs < cutoff) continue;
    const record = { runId, continuedAt: new Date(timestampMs).toISOString() };
    byRunId.delete(runId);
    byRunId.set(runId, record);
  }
  return pruneContinuationRecords(Array.from(byRunId.values()), maxEntries);
}

function pruneContinuationRecords(records, maxEntries = DEFAULT_CONTINUATION_LIMIT) {
  const limit = normalizeLimit(maxEntries);
  return limit === 0 ? [] : records.slice(-limit);
}

function continuationRecordSet(records) {
  return new Set(records.map((record) => record.runId));
}

function rememberLoadedSnapshot(runs) {
  loadedSnapshotBaselines.set(runs, { ids: new Set(runs) });
}

function continuationNow(value) {
  if (value === undefined) return new Date(Date.now()).toISOString();
  const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number(value);
  if (!Number.isFinite(time)) throw new Error("continuation store now must be a valid date or timestamp");
  return new Date(time).toISOString();
}

function isRunId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CONTINUATION_LIMIT;
  return Math.max(0, Math.floor(number));
}

function normalizeAge(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CONTINUATION_RETENTION_MS;
  return Math.max(0, number);
}
