import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const PROGRESS_REVIEW_SCHEMA = "thread-phase-progress-reviews/v1";
export const PROGRESS_REVIEW_FILENAME = "progress-reviews.json";
export const DEFAULT_PROGRESS_REVIEW_CADENCE_MS = 10 * 60 * 1000;
export const DEFAULT_PROGRESS_REVIEW_LIMIT = 500;
export const DEFAULT_PROGRESS_REVIEW_CLAIM_LEASE_MS = 10 * 60 * 1000;
const MAX_STATE_BYTES = 512 * 1024;
const WAIT = new Int32Array(new SharedArrayBuffer(4));

export function progressReviewFile(storeDir) {
  if (!nonEmpty(storeDir)) throw new Error("thread-phase store directory is required");
  return join(storeDir, PROGRESS_REVIEW_FILENAME);
}

export function createProgressReviewClaimantId() {
  return randomUUID();
}

export function loadProgressReviewRecords({ storeDir, maxEntries = DEFAULT_PROGRESS_REVIEW_LIMIT } = {}) {
  return withState(storeDir, maxEntries, (records) => ({ result: records.map((record) => ({ ...record })), records }));
}

/** Create the first schedule from the trusted workflow start, or make an overdue schedule pending. */
export function ensureProgressReview(runId, { storeDir, startedAt, cadenceMs = DEFAULT_PROGRESS_REVIEW_CADENCE_MS, maxEntries = DEFAULT_PROGRESS_REVIEW_LIMIT, now } = {}) {
  validateId(runId, "run id");
  const startMs = timestamp(startedAt, "trusted workflow start");
  const cadence = positiveDuration(cadenceMs, "progress review cadence");
  const nowMs = clock(now);
  return withState(storeDir, maxEntries, (records) => {
    let record = records.find((candidate) => candidate.runId === runId);
    if (record) {
      // A run id has one immutable scheduling anchor. A mismatch is ambiguous and
      // must not silently move an existing deadline. Ordinary activity does not
      // rewrite or postpone the review record.
      if (Date.parse(record.startedAt) !== startMs) throw new Error(`progress review start mismatch for ${runId}`);
      if (record.state === "scheduled" && Date.parse(record.dueAt) <= nowMs) {
        record.state = "pending";
        record.updatedAt = iso(nowMs);
      }
      return { result: { ...record }, records };
    }
    if (records.length >= boundedLimit(maxEntries)) throw new Error(`Progress review limit reached (${boundedLimit(maxEntries)})`);
    const dueMs = startMs + cadence;
    record = {
      runId,
      checkId: randomUUID(),
      sequence: 1,
      startedAt: iso(startMs),
      cadenceMs: cadence,
      dueAt: iso(dueMs),
      state: dueMs <= nowMs ? "pending" : "scheduled",
      attempts: 0,
      updatedAt: iso(nowMs),
    };
    records.push(record);
    return { result: { ...record }, records };
  });
}

/** Explicit operator adjustment only; never rewrite a pending/in-flight review.
 * The check identity and trusted start survive. sequence is the cadence-period
 * index, not an acknowledgement count, so rebase it along with dueAt.
 */
export function rescheduleProgressReview(runId, { storeDir, checkId, cadenceMs, maxEntries = DEFAULT_PROGRESS_REVIEW_LIMIT, now } = {}) {
  validateId(runId, "run id");
  validateId(checkId, "expected check id");
  const cadence = positiveDuration(cadenceMs, "progress review cadence");
  const nowMs = clock(now);
  return withState(storeDir, maxEntries, (records) => {
    const record = records.find((candidate) => candidate.runId === runId && candidate.checkId === checkId);
    if (!record || record.state !== "scheduled" || record.claimantId || record.claimantPid) {
      return { result: { rescheduled: false }, records };
    }
    if (record.cadenceMs === cadence) return { result: { rescheduled: true, record: { ...record } }, records };
    const startMs = Date.parse(record.startedAt);
    record.sequence = Math.max(1, Math.floor((nowMs - startMs) / cadence) + 1);
    record.dueAt = iso(startMs + record.sequence * cadence);
    record.cadenceMs = cadence;
    record.updatedAt = iso(nowMs);
    return { result: { rescheduled: true, record: { ...record } }, records };
  });

}

/** Atomically claim a due review. A scheduled record is promoted to pending at its anchored due time. */
export function claimProgressReview(runId, { storeDir, claimantId, claimantPid = process.pid, claimLeaseMs = DEFAULT_PROGRESS_REVIEW_CLAIM_LEASE_MS, maxEntries = DEFAULT_PROGRESS_REVIEW_LIMIT, now } = {}) {
  validateId(runId, "run id");
  validateId(claimantId, "claimant id");
  const nowMs = clock(now);
  const leaseMs = positiveDuration(claimLeaseMs, "claim lease");
  return withState(storeDir, maxEntries, (records) => {
    const record = records.find((candidate) => candidate.runId === runId);
    if (!record) return { result: { claimed: false }, records };
    if (record.state === "scheduled") {
      if (Date.parse(record.dueAt) > nowMs) return { result: { claimed: false, state: record.state, dueAt: record.dueAt }, records };
      record.state = "pending";
    }
    if (Date.parse(record.notBefore || record.dueAt) > nowMs) return { result: { claimed: false, state: record.state, dueAt: record.dueAt }, records };
    if (claimIsActive(record, nowMs) && !claimMatches(record, claimantId, claimantPid)) {
      return { result: { claimed: false, state: record.state, checkId: record.checkId }, records };
    }
    record.claimantId = claimantId;
    record.claimantPid = claimantPid;
    record.claimLeaseUntil = iso(nowMs + leaseMs);
    record.updatedAt = iso(nowMs);
    return { result: { claimed: true, checkId: record.checkId, dueAt: record.dueAt, record: { ...record } }, records };
  });
}

export function progressReviewClaimIsOwned(runId, { storeDir, checkId, claimantId, claimantPid = process.pid, maxEntries = DEFAULT_PROGRESS_REVIEW_LIMIT, now } = {}) {
  if (!nonEmpty(runId) || !nonEmpty(checkId) || !nonEmpty(claimantId)) return false;
  const nowMs = clock(now);
  return withState(storeDir, maxEntries, (records) => {
    const record = records.find((candidate) => candidate.runId === runId && candidate.checkId === checkId);
    return { result: Boolean(record?.state === "pending" && claimMatches(record, claimantId, claimantPid) && claimIsActive(record, nowMs)), records };
  });
}

/** A synchronous send failure is known not to have enqueued; release it with durable bounded backoff. */
export function deferProgressReview(runId, { storeDir, checkId, claimantId, claimantPid = process.pid, maxEntries = DEFAULT_PROGRESS_REVIEW_LIMIT, now, baseBackoffMs = 100, maxBackoffMs = 5 * 60 * 1000 } = {}) {
  const nowMs = clock(now);
  return withState(storeDir, maxEntries, (records) => {
    const record = records.find((candidate) => candidate.runId === runId && candidate.checkId === checkId);
    if (!record || record.state !== "pending" || !claimMatches(record, claimantId, claimantPid)) return { result: { deferred: false }, records };
    record.attempts = Math.min(30, (record.attempts || 0) + 1);
    const backoff = Math.min(positiveDuration(maxBackoffMs, "maximum backoff"), positiveDuration(baseBackoffMs, "base backoff") * (2 ** Math.min(20, record.attempts - 1)));
    record.notBefore = iso(nowMs + backoff);
    clearClaim(record);
    record.updatedAt = iso(nowMs);
    return { result: { deferred: true, notBefore: record.notBefore, attempts: record.attempts }, records };
  });
}

export function relinquishProgressReviewClaim(runId, { storeDir, checkId, claimantId, claimantPid = process.pid, maxEntries = DEFAULT_PROGRESS_REVIEW_LIMIT, now } = {}) {
  const nowMs = clock(now);
  return withState(storeDir, maxEntries, (records) => {
    const record = records.find((candidate) => candidate.runId === runId && candidate.checkId === checkId);
    if (!record || record.state !== "pending" || !claimMatches(record, claimantId, claimantPid)) return { result: { relinquished: false }, records };
    clearClaim(record);
    record.updatedAt = iso(nowMs);
    return { result: { relinquished: true }, records };
  });
}

/** Active-branch history is the only acknowledgement accepted for pending -> next schedule. */
export function acknowledgeProgressReview(runId, { storeDir, checkId, maxEntries = DEFAULT_PROGRESS_REVIEW_LIMIT, now } = {}) {
  const nowMs = clock(now);
  return withState(storeDir, maxEntries, (records) => {
    const record = records.find((candidate) => candidate.runId === runId && candidate.checkId === checkId);
    if (!record || record.state !== "pending") return { result: { acknowledged: false }, records };
    const startMs = Date.parse(record.startedAt);
    const cadence = record.cadenceMs;
    const nextSequence = Math.max(record.sequence + 1, Math.floor((nowMs - startMs) / cadence) + 1);
    record.sequence = nextSequence;
    record.checkId = randomUUID();
    record.dueAt = iso(startMs + nextSequence * cadence);
    record.state = "scheduled";
    record.attempts = 0;
    delete record.notBefore;
    clearClaim(record);
    record.updatedAt = iso(nowMs);
    return { result: { acknowledged: true, nextCheckId: record.checkId, dueAt: record.dueAt }, records };
  });
}

/** Terminal completion or cancellation supersedes every stale progress check for the run. */
export function discardProgressReview(runId, { storeDir, maxEntries = DEFAULT_PROGRESS_REVIEW_LIMIT } = {}) {
  validateId(runId, "run id");
  return withState(storeDir, maxEntries, (records) => {
    const retained = records.filter((candidate) => candidate.runId !== runId);
    return { result: { discarded: retained.length !== records.length }, records: retained };
  });
}

export function relinquishProgressReviewClaims({ storeDir, claimantId, claimantPid = process.pid, maxEntries = DEFAULT_PROGRESS_REVIEW_LIMIT, now } = {}) {
  if (!nonEmpty(claimantId)) return { relinquished: 0 };
  const nowMs = clock(now);
  return withState(storeDir, maxEntries, (records) => {
    let relinquished = 0;
    for (const record of records) {
      if (!claimMatches(record, claimantId, claimantPid)) continue;
      clearClaim(record);
      record.updatedAt = iso(nowMs);
      relinquished++;
    }
    return { result: { relinquished }, records };
  });
}

function withState(storeDir, maxEntries, operation) {
  const file = progressReviewFile(storeDir);
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(`${file}.lock`);
  try {
    const records = readState(file, maxEntries);
    const before = JSON.stringify(records);
    const transition = operation(records);
    validateRecords(transition.records, maxEntries);
    if (JSON.stringify(transition.records) !== before || !existsSync(file)) writeState(file, storeDir, transition.records);
    return transition.result;
  } finally {
    release();
  }
}

function readState(file, maxEntries) {
  try {
    const size = statSync(file).size;
    if (size > MAX_STATE_BYTES) throw new Error(`Progress review state exceeds ${MAX_STATE_BYTES} bytes`);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.schema !== PROGRESS_REVIEW_SCHEMA || !Array.isArray(parsed.records)) throw new Error(`Unsupported progress review state: ${file}`);
    validateRecords(parsed.records, maxEntries);
    return parsed.records.map((record) => ({ ...record }));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function validateRecords(records, maxEntries) {
  const limit = boundedLimit(maxEntries);
  if (!Array.isArray(records) || records.length > limit) throw new Error(`Progress review state exceeds record limit ${limit}`);
  const ids = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object" || !nonEmpty(record.runId) || Buffer.byteLength(record.runId, "utf8") > 512 || ids.has(record.runId)) throw new Error("Invalid or duplicate progress review run id");
    ids.add(record.runId);
    if (!nonEmpty(record.checkId) || !Number.isSafeInteger(record.sequence) || record.sequence < 1) throw new Error(`Invalid progress review identity for ${record.runId}`);
    if (!Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.dueAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error(`Invalid progress review timestamp for ${record.runId}`);
    if (!Number.isFinite(record.cadenceMs) || record.cadenceMs <= 0 || !["scheduled", "pending"].includes(record.state)) throw new Error(`Invalid progress review policy for ${record.runId}`);
    if (record.notBefore !== undefined && !Number.isFinite(Date.parse(record.notBefore))) throw new Error(`Invalid progress review backoff for ${record.runId}`);
  }
}

function writeState(file, storeDir, records) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify({ schema: PROGRESS_REVIEW_SCHEMA, records })}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_STATE_BYTES) throw new Error(`Progress review state exceeds ${MAX_STATE_BYTES} bytes`);
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    const directory = openSync(storeDir, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function acquireLock(file) {
  const deadline = Date.now() + 5_000;
  while (true) {
    const token = `${process.pid}:${randomUUID()}`;
    try {
      const fd = openSync(file, "wx", 0o600);
      try { writeFileSync(fd, token, "utf8"); } finally { closeSync(fd); }
      return () => {
        try { if (readFileSync(file, "utf8") === token) rmSync(file, { force: true }); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(file).mtimeMs > 30_000) rmSync(file, { force: true });
      } catch (nested) { if (nested?.code !== "ENOENT") throw nested; }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for progress review store lock: ${file}`);
      Atomics.wait(WAIT, 0, 0, 10);
    }
  }
}

function clearClaim(record) {
  delete record.claimantId;
  delete record.claimantPid;
  delete record.claimLeaseUntil;
}

function claimMatches(record, claimantId, claimantPid) {
  return record.claimantId === claimantId && record.claimantPid === claimantPid;
}

function claimIsActive(record, nowMs) {
  if (!record.claimantPid || !record.claimantId || Date.parse(record.claimLeaseUntil || "") <= nowMs) return false;
  try { process.kill(record.claimantPid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function validateId(value, label) {
  if (!nonEmpty(value)) throw new Error(`a non-empty ${label} is required`);
}
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function timestamp(value, label) {
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp`);
  return parsed;
}
function clock(value) { return value === undefined ? Date.now() : timestamp(value, "progress review clock"); }
function positiveDuration(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive finite duration`);
  return Math.floor(number);
}
function boundedLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) throw new Error("progress review record limit must be positive");
  return Math.floor(number);
}
function iso(value) { return new Date(value).toISOString(); }
