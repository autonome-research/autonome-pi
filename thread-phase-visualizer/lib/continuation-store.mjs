import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const DEFAULT_CONTINUATION_LIMIT = 500;
export const DEFAULT_PENDING_CONTINUATION_LIMIT = 500;
export const DEFAULT_CONTINUATION_CLAIM_LEASE_MS = 30 * 60 * 1000;
export const DEFAULT_CONTINUATION_RETENTION_MS = 24 * 60 * 60 * 1000;
export const CONTINUED_RUNS_FILENAME = "continued-runs.json";
export const CONTINUATION_TIMESTAMPS_FILENAME = "continued-runs.timestamps.json";
export const CONTINUATION_STATE_FILENAME = "continuations.json";
export const CONTINUATION_STATE_SCHEMA = "thread-phase-continuations/v3";
const LEGACY_CONTINUATION_STATE_SCHEMA = "thread-phase-continuations/v2";

// Remember the contents originally loaded into a Set so persisting that Set can
// append only its new ids. A stale full snapshot must never resurrect ids that
// a competing writer has already pruned or move them behind newer claims.
const loadedSnapshotBaselines = new WeakMap();

/**
 * Background dynamic workflows hand control back to chat after success or
 * failure. Cancellation remains authoritative and never auto-continues.
 * Explicit success-only opt-in remains for non-dynamic integrations until the
 * v2 public schema migration removes the old flag.
 */
export function shouldAutoContinue(run) {
  const status = run?.normalizedStatus;
  if (status === "cancelled" || (status !== "success" && status !== "failed")) return false;
  if (run?.metadata?.continuationMode === "terminal") return true;
  if (status !== "success") return false;
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

export function loadContinuedRuns(options = {}) {
  const records = loadContinuationRecords(options);
  const normalized = continuationRecordSet(records);
  // Remember identity so a stale Set later contributes only its additions;
  // retained claims keep their persisted expiration timestamps on disk.
  rememberLoadedSnapshot(normalized);
  return normalized;
}

/** Pending deliveries are enumerated directly so startup is not limited by an index tail window. */
export function loadPendingContinuations(options = {}) {
  return new Set(loadPendingContinuationRecords(options).map((record) => record.runId));
}

/** Return durable pending records, including the stable delivery id used for history reconciliation. */
export function loadPendingContinuationRecords(options = {}) {
  return loadContinuationRecords(options)
    .filter((record) => record.state === "pending")
    .map((record) => ({ ...record }));
}

/** A per-extension-runtime identity used to relinquish only that runtime's claims. */
export function createContinuationClaimantId() {
  return randomUUID();
}

/** Linux process-start identity prevents a reused live PID from impersonating an old claimant. */
export function currentProcessStartIdentity() {
  return processStartIdentity(process.pid);
}

function loadContinuationRecords({ storeDir, maxEntries = DEFAULT_CONTINUATION_LIMIT, maxAgeMs = DEFAULT_CONTINUATION_RETENTION_MS, now } = {}) {
  const file = continuedRunsFile(storeDir);
  const lockFile = `${file}.lock`;
  mkdirSync(storeDir, { recursive: true });
  const releaseLock = acquireContinuationLock(lockFile);
  try {
    const persisted = readPersistedContinuationRecords(file);
    if (!persisted.exists) return [];
    const records = canonicalContinuationRecords(persisted.values, {
      maxEntries,
      maxAgeMs,
      now,
      legacyTimestamp: persisted.legacyTimestamp,
    });
    if (!persistedStateMatches(persisted, records)) writeContinuationState(file, storeDir, records);
    return records;
  } finally {
    releaseLock();
  }
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
      if (!records.some((record) => record.runId === runId)) records.push({ runId, deliveryId: randomUUID(), continuedAt: claimedAt, state: "delivered" });
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
export function persistContinuationClaim(runId, { storeDir, maxEntries = DEFAULT_CONTINUATION_LIMIT, maxPendingEntries = DEFAULT_PENDING_CONTINUATION_LIMIT, maxAgeMs = DEFAULT_CONTINUATION_RETENTION_MS, claimLeaseMs = DEFAULT_CONTINUATION_CLAIM_LEASE_MS, now, retryPending = false, claimantId, claimantProcessStart = currentProcessStartIdentity() } = {}) {
  if (!isRunId(runId)) throw new Error("a non-empty continuation run id is required");
  const file = continuedRunsFile(storeDir);
  const lockFile = `${file}.lock`;
  const claimedAt = continuationNow(now);
  const leaseDuration = normalizeAge(claimLeaseMs);
  const claimant = {
    claimantPid: process.pid,
    claimantId: isRunId(claimantId) ? claimantId : undefined,
    claimantProcessStart,
    claimantLeaseUntil: new Date(Date.parse(claimedAt) + leaseDuration).toISOString(),
  };
  mkdirSync(storeDir, { recursive: true });
  const releaseLock = acquireContinuationLock(lockFile);
  try {
    const persisted = readPersistedContinuationRecords(file);
    let records = canonicalContinuationRecords(persisted.values, {
      maxAgeMs,
      now: claimedAt,
      legacyTimestamp: persisted.legacyTimestamp,
    });
    const existing = records.find((record) => record.runId === runId);
    if (existing) {
      const retryable = existing.state === "pending" && retryPending
        && (claimIsUnowned(existing) || claimantMatches(existing, claimant) || !claimantIsActive(existing));
      if (!retryable) {
        if (!persistedStateMatches(persisted, records)) writeContinuationState(file, storeDir, records);
        return { claimed: false, state: existing.state, deliveryId: existing.deliveryId, runs: continuationRecordSet(records) };
      }
      existing.continuedAt = claimedAt;
      assignClaimant(existing, claimant);
    } else {
      if (normalizeLimit(maxEntries) === 0 || normalizeLimit(maxPendingEntries) === 0) {
        if (!persistedStateMatches(persisted, records)) writeContinuationState(file, storeDir, records);
        return { claimed: false, runs: continuationRecordSet(records) };
      }
      const pendingLimit = normalizeLimit(maxPendingEntries);
      const pendingCount = records.filter((record) => record.state === "pending").length;
      if (pendingCount >= pendingLimit) {
        throw new Error(`Pending continuation limit reached (${pendingLimit}); resolve or relinquish existing pending deliveries before claiming ${runId}`);
      }
      const record = { runId, deliveryId: randomUUID(), continuedAt: claimedAt, state: "pending" };
      assignClaimant(record, claimant);
      records.push(record);
    }
    records = pruneContinuationRecords(records, maxEntries);
    writeContinuationState(file, storeDir, records);
    const retained = records.find((record) => record.runId === runId);
    return { claimed: retained?.state === "pending", state: retained?.state, deliveryId: retained?.deliveryId, runs: continuationRecordSet(records) };
  } finally {
    releaseLock();
  }
}

/** Durably complete pending -> delivered only after active-branch history proves persistence. */
export function markContinuationDelivered(runId, { storeDir, maxEntries = DEFAULT_CONTINUATION_LIMIT, maxAgeMs = DEFAULT_CONTINUATION_RETENTION_MS, now, deliveryId } = {}) {
  if (!isRunId(runId)) throw new Error("a non-empty continuation run id is required");
  const file = continuedRunsFile(storeDir);
  const lockFile = `${file}.lock`;
  const deliveredAt = continuationNow(now);
  mkdirSync(storeDir, { recursive: true });
  const releaseLock = acquireContinuationLock(lockFile);
  try {
    const persisted = readPersistedContinuationRecords(file);
    let records = canonicalContinuationRecords(persisted.values, { maxAgeMs, now: deliveredAt, legacyTimestamp: persisted.legacyTimestamp });
    const record = records.find((candidate) => candidate.runId === runId);
    if (!record || (deliveryId && record.deliveryId !== deliveryId)) return { delivered: false, runs: continuationRecordSet(records) };
    if (record.state !== "delivered") {
      record.state = "delivered";
      record.continuedAt = deliveredAt;
      clearClaimant(record);
    }
    records = pruneContinuationRecords(records, maxEntries);
    writeContinuationState(file, storeDir, records);
    return { delivered: true, runs: continuationRecordSet(records) };
  } finally {
    releaseLock();
  }
}

/** Relinquish this extension runtime's pending claims without discarding retryable work. */
export function relinquishContinuationClaims({ storeDir, claimantId, claimantPid = process.pid, claimantProcessStart = currentProcessStartIdentity(), maxEntries = DEFAULT_CONTINUATION_LIMIT, maxAgeMs = DEFAULT_CONTINUATION_RETENTION_MS, now } = {}) {
  if (!isRunId(claimantId)) return { relinquished: 0, runs: loadContinuedRuns({ storeDir, maxEntries, maxAgeMs, now }) };
  const file = continuedRunsFile(storeDir);
  const lockFile = `${file}.lock`;
  mkdirSync(storeDir, { recursive: true });
  const releaseLock = acquireContinuationLock(lockFile);
  try {
    const persisted = readPersistedContinuationRecords(file);
    let records = canonicalContinuationRecords(persisted.values, { maxEntries, maxAgeMs, now, legacyTimestamp: persisted.legacyTimestamp });
    let relinquished = 0;
    for (const record of records) {
      if (record.state !== "pending" || record.claimantId !== claimantId || record.claimantPid !== claimantPid) continue;
      if (record.claimantProcessStart && claimantProcessStart && record.claimantProcessStart !== claimantProcessStart) continue;
      clearClaimant(record);
      relinquished++;
    }
    records = pruneContinuationRecords(records, maxEntries);
    if (relinquished || !persistedStateMatches(persisted, records)) writeContinuationState(file, storeDir, records);
    return { relinquished, runs: continuationRecordSet(records) };
  } finally {
    releaseLock();
  }
}

/** @deprecated Compatibility escape hatch; normal failures remain durably pending. */
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
  const stateFile = join(storeDir, CONTINUATION_STATE_FILENAME);
  const ids = records.map((record) => record.runId);
  const timestamps = Object.fromEntries(records.map((record) => [record.runId, record.continuedAt]));
  // The single v3 document is authoritative and makes pending/delivered a
  // crash-safe transition. Legacy mirrors remain readable by older releases.
  writeJsonAtomic(stateFile, storeDir, {
    schema: CONTINUATION_STATE_SCHEMA,
    records: records.map(serializeContinuationRecord),
  });
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
  const stateFile = join(dirname(file), CONTINUATION_STATE_FILENAME);
  try {
    let state;
    try {
      state = JSON.parse(readFileSync(stateFile, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") state = undefined;
      else if (error instanceof SyntaxError) throw new Error(`Invalid authoritative continuation state JSON: ${stateFile}`, { cause: error });
      else throw error;
    }
    if (state !== undefined) {
      if (!((state.schema === CONTINUATION_STATE_SCHEMA || state.schema === LEGACY_CONTINUATION_STATE_SCHEMA) && Array.isArray(state.records))) {
        throw new Error(`Unsupported authoritative continuation state schema or shape: ${stateFile}`);
      }
      validateAuthoritativeContinuationRecords(state.records, stateFile);
      let rawValues = [];
      let timestamps = {};
      try {
        const legacy = JSON.parse(readFileSync(file, "utf8"));
        rawValues = Array.isArray(legacy) ? legacy : [];
        timestamps = readContinuationTimestamps(join(dirname(file), CONTINUATION_TIMESTAMPS_FILENAME));
      } catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      return { exists: true, canonicalState: true, values: state.records, rawState: state, rawValues, timestamps };
    }
  } catch (error) {
    throw error;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const canonicalArray = Array.isArray(parsed);
    const rawValues = canonicalArray ? parsed : [];
    const legacyTimestamp = statSync(file).mtime.toISOString();
    const timestamps = readContinuationTimestamps(join(dirname(file), CONTINUATION_TIMESTAMPS_FILENAME));
    const values = rawValues.map((value) => {
      if (!isRunId(value)) return value;
      return { runId: value, continuedAt: Object.hasOwn(timestamps, value) ? timestamps[value] : legacyTimestamp, state: "delivered" };
    });
    return { exists: true, canonicalArray, rawValues, timestamps, values, legacyTimestamp };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return { exists: false, rawValues: [], timestamps: {}, values: [], legacyTimestamp: undefined };
    }
    throw error;
  }
}

function validateAuthoritativeContinuationRecords(records, stateFile) {
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== "object" || Array.isArray(record) || !isRunId(record.runId)) {
      throw new Error(`Invalid authoritative continuation record ${index} in ${stateFile}: runId is required`);
    }
    if (record.state !== "pending" && record.state !== "delivered") {
      throw new Error(`Invalid authoritative continuation record ${index} in ${stateFile}: state must be pending or delivered`);
    }
    if (!Number.isFinite(Date.parse(String(record.updatedAt || record.continuedAt || "")))) {
      throw new Error(`Invalid authoritative continuation record ${index} in ${stateFile}: updatedAt is required`);
    }
    if (record.deliveryId !== undefined && !isRunId(record.deliveryId)) {
      throw new Error(`Invalid authoritative continuation record ${index} in ${stateFile}: deliveryId must be non-empty`);
    }
    if (record.claimantLeaseUntil !== undefined && !Number.isFinite(Date.parse(String(record.claimantLeaseUntil)))) {
      throw new Error(`Invalid authoritative continuation record ${index} in ${stateFile}: claimantLeaseUntil must be a timestamp`);
    }
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
  if (!persisted.canonicalState) return false;
  const expected = {
    schema: CONTINUATION_STATE_SCHEMA,
    records: records.map(serializeContinuationRecord),
  };
  if (JSON.stringify(persisted.rawState) !== JSON.stringify(expected)) return false;
  const ids = records.map((record) => record.runId);
  const timestamps = Object.fromEntries(records.map((record) => [record.runId, record.continuedAt]));
  return JSON.stringify(persisted.rawValues) === JSON.stringify(ids)
    && JSON.stringify(persisted.timestamps) === JSON.stringify(timestamps);
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
  return !isProcessAlive(pid);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
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
    const candidateTimestamp = isRunId(value) ? legacyTimestamp : value.updatedAt || value.continuedAt;
    const timestampMs = Date.parse(String(candidateTimestamp || ""));
    const state = value?.state === "pending" ? "pending" : "delivered";
    // Delivered history expires; pending work remains retryable across long
    // outages and is never silently converted into a delivered legacy entry.
    if (!Number.isFinite(timestampMs) || (state === "delivered" && timestampMs < cutoff)) continue;
    const claimantPid = state === "pending" && Number.isSafeInteger(value?.claimantPid) && value.claimantPid > 0
      ? value.claimantPid
      : undefined;
    const continuedAt = new Date(timestampMs).toISOString();
    const deliveryId = isRunId(value?.deliveryId) ? value.deliveryId : legacyDeliveryId(runId, continuedAt);
    const claimantId = claimantPid && isRunId(value?.claimantId) ? value.claimantId : undefined;
    const claimantProcessStart = claimantPid && isRunId(value?.claimantProcessStart) ? value.claimantProcessStart : undefined;
    const claimantLeaseUntil = claimantPid && Number.isFinite(Date.parse(String(value?.claimantLeaseUntil || "")))
      ? new Date(Date.parse(value.claimantLeaseUntil)).toISOString()
      : undefined;
    const record = {
      runId,
      deliveryId,
      continuedAt,
      state,
      ...(claimantPid ? { claimantPid } : {}),
      ...(claimantId ? { claimantId } : {}),
      ...(claimantProcessStart ? { claimantProcessStart } : {}),
      ...(claimantLeaseUntil ? { claimantLeaseUntil } : {}),
    };
    byRunId.delete(runId);
    byRunId.set(runId, record);
  }
  return pruneContinuationRecords(Array.from(byRunId.values()), maxEntries);
}

function pruneContinuationRecords(records, maxEntries = DEFAULT_CONTINUATION_LIMIT) {
  const limit = normalizeLimit(maxEntries);
  const pending = records.filter((record) => record.state === "pending");
  if (limit === 0) return pending;
  if (records.length <= limit) return records;
  const deliveredBudget = Math.max(0, limit - pending.length);
  const delivered = records.filter((record) => record.state !== "pending");
  const retainedDelivered = new Set(deliveredBudget === 0 ? [] : delivered.slice(-deliveredBudget));
  return records.filter((record) => record.state === "pending" || retainedDelivered.has(record));
}

function continuationRecordSet(records) {
  return new Set(records.map((record) => record.runId));
}

function serializeContinuationRecord(record) {
  return {
    runId: record.runId,
    deliveryId: record.deliveryId,
    state: record.state,
    updatedAt: record.continuedAt,
    ...(record.claimantPid ? { claimantPid: record.claimantPid } : {}),
    ...(record.claimantId ? { claimantId: record.claimantId } : {}),
    ...(record.claimantProcessStart ? { claimantProcessStart: record.claimantProcessStart } : {}),
    ...(record.claimantLeaseUntil ? { claimantLeaseUntil: record.claimantLeaseUntil } : {}),
  };
}

function legacyDeliveryId(runId, continuedAt) {
  return createHash("sha256").update(`${runId}\0${continuedAt}`).digest("hex").slice(0, 32);
}

function assignClaimant(record, claimant) {
  record.claimantPid = claimant.claimantPid;
  if (claimant.claimantId) record.claimantId = claimant.claimantId;
  else delete record.claimantId;
  if (claimant.claimantProcessStart) record.claimantProcessStart = claimant.claimantProcessStart;
  else delete record.claimantProcessStart;
  if (claimant.claimantLeaseUntil) record.claimantLeaseUntil = claimant.claimantLeaseUntil;
  else delete record.claimantLeaseUntil;
}

function clearClaimant(record) {
  delete record.claimantPid;
  delete record.claimantId;
  delete record.claimantProcessStart;
  delete record.claimantLeaseUntil;
}

function claimIsUnowned(record) {
  return !record.claimantPid;
}

function claimantMatches(record, claimant) {
  if (record.claimantPid !== claimant.claimantPid) return false;
  if ((record.claimantId || claimant.claimantId) && record.claimantId !== claimant.claimantId) return false;
  if ((record.claimantProcessStart || claimant.claimantProcessStart) && record.claimantProcessStart !== claimant.claimantProcessStart) return false;
  return true;
}

function claimantIsActive(record) {
  if (!record.claimantPid || !isProcessAlive(record.claimantPid)) return false;
  if (record.claimantLeaseUntil && Date.parse(record.claimantLeaseUntil) <= Date.now()) return false;
  if (!record.claimantProcessStart) return true;
  const actualStart = processStartIdentity(record.claimantPid);
  // Cross-platform fallback is lease-bounded: a platform that cannot expose
  // process-start identity may protect a live PID only until the durable lease expires.
  return !actualStart || actualStart === record.claimantProcessStart;
}

function processStartIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    const fieldsAfterCommand = stat.slice(closeParen + 2).trim().split(/\s+/);
    const startTicks = fieldsAfterCommand[19]; // proc(5) field 22
    return startTicks ? `linux-proc-start:${startTicks}` : undefined;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") return undefined;
    return undefined;
  }
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
