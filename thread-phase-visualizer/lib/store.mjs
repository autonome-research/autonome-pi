import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { canonicalCwd } from "./session-scope.mjs";

export const SCHEMA_VERSION = "thread-phase-ui/v1";
export const EVENT_TYPES = Object.freeze({
  WORKFLOW_START: "workflow_start",
  WORKFLOW_END: "workflow_end",
  PHASE_START: "phase_start",
  PHASE_EVENT: "phase_event",
  PHASE_END: "phase_end",
  AGENT_EVENT: "agent_event",
  ARTIFACT: "artifact",
  ERROR: "error",
});
export const STATUSES = Object.freeze({
  RUNNING: "running",
  SUCCESS: "success",
  FAILED: "failed",
  CANCELLED: "cancelled",
  SKIPPED: "skipped",
  UNKNOWN: "unknown",
});
export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const STORE_DIR = process.env.PI_THREAD_PHASE_STORE_DIR || join(AGENT_DIR, "thread-phase");
export const RUNS_DIR = join(STORE_DIR, "runs");
export const ARTIFACTS_DIR = join(STORE_DIR, "artifacts");
export const CANCEL_DIR = join(STORE_DIR, "cancel");
export const INDEX_FILE = join(STORE_DIR, "index.jsonl");
const RUN_START_INDEX_FILE = join(STORE_DIR, "run-starts.jsonl");
const PENDING_INDEX_DIR = join(STORE_DIR, "index-pending");
const QUARANTINED_INDEX_DIR = join(STORE_DIR, "index-quarantine");
const QUARANTINED_START_DIR = join(STORE_DIR, "run-start-quarantine");
const PROCESS_START_TOKEN = processStartToken(process.pid) || "unknown";
const APPEND_LOCK_FILE = join(STORE_DIR, ".append.lock");
const APPEND_RECLAIM_FILE = join(STORE_DIR, ".append.reclaim");
const APPEND_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const ACTIVE_PENDING_MARKERS = new Set();

const KNOWN_STATUSES = new Set(Object.values(STATUSES));
const STATUS_ALIASES = new Map([
  ["ok", STATUSES.SUCCESS],
  ["done", STATUSES.SUCCESS],
  ["complete", STATUSES.SUCCESS],
  ["completed", STATUSES.SUCCESS],
  ["pass", STATUSES.SUCCESS],
  ["passed", STATUSES.SUCCESS],
  ["error", STATUSES.FAILED],
  ["fail", STATUSES.FAILED],
  ["failure", STATUSES.FAILED],
  ["aborted", STATUSES.CANCELLED],
  ["abort", STATUSES.CANCELLED],
  ["canceled", STATUSES.CANCELLED],
  ["cancelled", STATUSES.CANCELLED],
  ["pending", STATUSES.RUNNING],
  ["in_progress", STATUSES.RUNNING],
  ["in-progress", STATUSES.RUNNING],
]);

function quarantinePending(file, name) {
  mkdirSync(QUARANTINED_INDEX_DIR, { recursive: true, mode: 0o700 });
  renameSync(file, join(QUARANTINED_INDEX_DIR, `${randomUUID()}-${name}`));
}

function fileContainsLine(file, line) {
  if (!existsSync(file)) return false;
  const size = statSync(file).size;
  let fd;
  let offset = 0;
  let carry = Buffer.alloc(0);
  const needle = Buffer.from(line);
  try {
    fd = openSync(file, "r");
    while (offset < size) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset));
      const count = readSync(fd, chunk, 0, chunk.length, offset);
      if (count <= 0) break;
      const joined = Buffer.concat([carry, chunk.subarray(0, count)]);
      for (let found = joined.indexOf(needle); found >= 0; found = joined.indexOf(needle, found + 1)) {
        const absolute = offset - carry.length + found;
        if (absolute === 0 || (found > 0 && joined[found - 1] === 10)) return true;
      }
      carry = joined.subarray(Math.max(0, joined.length - needle.length - 1));
      offset += count;
    }
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function runLogContains(event, line) {
  if (!event?.runId || !event?.eventId) return false;
  return fileContainsLine(runFileFor(event.runId), line);
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch (error) {
    // Directory fsync is unavailable on some supported platforms. Operational
    // I/O/resource failures must still abort the durability transition.
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error?.code)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function tryReclaimAppendLock() {
  try {
    linkSync(APPEND_LOCK_FILE, APPEND_RECLAIM_FILE);
  } catch (error) {
    if (["EEXIST", "ENOENT"].includes(error?.code)) return;
    throw error;
  }
  try {
    const owner = JSON.parse(readFileSync(APPEND_RECLAIM_FILE, "utf8"));
    if (!isWriterAlive(owner.pid, owner.processStart)) rmSync(APPEND_LOCK_FILE, { force: true });
  } finally {
    rmSync(APPEND_RECLAIM_FILE, { force: true });
    fsyncDirectory(STORE_DIR);
  }
}

function withAppendLock(operation) {
  const deadline = Date.now() + 30_000;
  const ownerFile = join(STORE_DIR, `.append-owner-${randomUUID()}`);
  writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, processStart: PROCESS_START_TOKEN }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fsyncDirectory(STORE_DIR);
  try {
    while (true) {
      if (!existsSync(APPEND_RECLAIM_FILE)) {
        try {
          linkSync(ownerFile, APPEND_LOCK_FILE);
          fsyncDirectory(STORE_DIR);
          break;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      tryReclaimAppendLock();
      if (Date.now() >= deadline) throw new Error("Timed out waiting for thread-phase append lock");
      Atomics.wait(APPEND_WAIT_ARRAY, 0, 0, 10);
    }
    return operation();
  } finally {
    try {
      const ownerStat = statSync(ownerFile, { bigint: true });
      const lockStat = statSync(APPEND_LOCK_FILE, { bigint: true });
      if (ownerStat.dev === lockStat.dev && ownerStat.ino === lockStat.ino) rmSync(APPEND_LOCK_FILE, { force: true });
    } catch {
      // A dead-owner reclaimer may already have removed the lock.
    }
    rmSync(ownerFile, { force: true });
    fsyncDirectory(STORE_DIR);
  }
}

function appendRecordDurably(file, line) {
  return withAppendLock(() => {
    let fd;
    let prefix = "";
    try {
    const size = existsSync(file) ? statSync(file).size : 0;
    if (size > 0) {
      let readFd;
      try {
        readFd = openSync(file, "r");
        const last = Buffer.allocUnsafe(1);
        if (readSync(readFd, last, 0, 1, size - 1) === 1 && last[0] !== 10) prefix = "\n";
      } finally {
        if (readFd !== undefined) closeSync(readFd);
      }
    }
    fd = openSync(file, "a", 0o600);
    // One O_APPEND write prevents offset races between processes. Prefix a
    // delimiter only when repairing a crash-truncated predecessor.
    const record = Buffer.from(`${prefix}${line}`);
    const written = writeSync(fd, record, 0, record.length);
    if (written !== record.length) throw new Error(`Partial append to ${file}`);
    fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  });
}

function appendIndexDurably(line) {
  appendRecordDurably(INDEX_FILE, line);
}

function processCommittedMarker(file, checkExisting = true) {
  const claimed = join(PENDING_INDEX_DIR, `processing-${process.pid}-${PROCESS_START_TOKEN}-${randomUUID()}.claim`);
  try {
    // Every processor, including recovery of a dead claim, must win a fresh
    // atomic rename before it can inspect or append the marker.
    renameSync(file, claimed);
    ACTIVE_PENDING_MARKERS.delete(file);
    ACTIVE_PENDING_MARKERS.add(claimed);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  fsyncDirectory(PENDING_INDEX_DIR);
  try {
    const line = readFileSync(claimed, "utf8");
    if (!checkExisting || !fileContainsLine(INDEX_FILE, line)) appendIndexDurably(line);
    rmSync(claimed, { force: true });
    ACTIVE_PENDING_MARKERS.delete(claimed);
    fsyncDirectory(PENDING_INDEX_DIR);
    return true;
  } catch (error) {
    if (existsSync(claimed)) {
      const retry = join(PENDING_INDEX_DIR, `committed-${randomUUID()}.jsonl`);
      renameSync(claimed, retry);
      ACTIVE_PENDING_MARKERS.delete(claimed);
      fsyncDirectory(PENDING_INDEX_DIR);
    }
    throw error;
  }
}

function reconcilePendingIndex() {
  if (!existsSync(PENDING_INDEX_DIR)) return;
  for (const name of readdirSync(PENDING_INDEX_DIR)) {
    const processing = /^processing-(\d+)-([^-]+)-.*\.claim$/.exec(name);
    if (!name.endsWith(".jsonl") && !processing) continue;
    const file = join(PENDING_INDEX_DIR, name);
    if (processing && markerWriterActive(file, Number(processing[1]), processing[2])) continue;
    try {
      const bytes = statSync(file).size;
      if (bytes > EVENT_RECORD_MAX_BYTES) {
        quarantinePending(file, name);
        continue;
      }
      const line = readFileSync(file, "utf8");
      let event;
      try { event = JSON.parse(line.endsWith("\n") ? line.slice(0, -1) : ""); }
      catch { event = undefined; }
      if (!event?.eventId || !event?.runId || event.schema !== SCHEMA_VERSION) {
        quarantinePending(file, name);
        continue;
      }
      const prepared = /^prepared-(\d+)-([^-]+)-/.exec(name);
      if (prepared && markerWriterActive(file, Number(prepared[1]), prepared[2])) continue;
      if (prepared && !runLogContains(event, line)) {
        quarantinePending(file, name);
        continue;
      }
      processCommittedMarker(file);
    } catch (error) {
      // A concurrent reconciler may already have claimed the marker. Durable
      // operational failures must remain visible to the caller.
      if (error?.code !== "ENOENT") throw error;
    }
  }
  // Keep the pending directory permanently. Check-then-recursive-delete would
  // race with writers creating a new durable marker.
}

function persistPendingIndex(line) {
  mkdirSync(PENDING_INDEX_DIR, { recursive: true });
  const file = join(PENDING_INDEX_DIR, `prepared-${process.pid}-${PROCESS_START_TOKEN}-${randomUUID()}.jsonl`);
  let fd;
  try {
    fd = openSync(file, "wx", 0o600);
    writeFileSync(fd, line, "utf8");
    fsyncSync(fd);
    fsyncDirectory(PENDING_INDEX_DIR);
    ACTIVE_PENDING_MARKERS.add(file);
    return file;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function commitPendingIndex(file) {
  const committed = join(PENDING_INDEX_DIR, `committed-${randomUUID()}.jsonl`);
  renameSync(file, committed);
  ACTIVE_PENDING_MARKERS.delete(file);
  ACTIVE_PENDING_MARKERS.add(committed);
  fsyncDirectory(PENDING_INDEX_DIR);
  return committed;
}

export function ensureStore() {
  mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(RUNS_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(ARTIFACTS_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(CANCEL_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(PENDING_INDEX_DIR, { recursive: true, mode: 0o700 });
  fsyncDirectory(STORE_DIR);
  for (const file of [INDEX_FILE, RUN_START_INDEX_FILE]) {
    const fd = openSync(file, "a", 0o600);
    closeSync(fd);
    chmodSync(file, 0o600);
  }
  reconcilePendingIndex();
}

export function createRunId(workflow = "workflow") {
  const safeWorkflow = normalizeWorkflowName(workflow);
  return `${safeWorkflow}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export function runFileFor(runId) {
  return join(RUNS_DIR, `${safeRunId(runId)}.jsonl`);
}

function runStartFileFor(runId) {
  return join(RUNS_DIR, `${safeRunId(runId)}.start.json`);
}

export function cancelFileFor(runId) {
  return join(CANCEL_DIR, `${safeRunId(runId)}.json`);
}

export function requestCancellation(runId, options = {}) {
  const safeId = safeRunId(runId);
  const request = {
    runId: safeId,
    requestedAt: new Date().toISOString(),
    reason: options.reason || "cancelled from thread-phase monitor",
    source: options.source || "thread-phase-visualizer",
  };
  const file = cancelFileFor(safeId);
  const content = JSON.stringify(request, null, 2);
  // A unique temporary file plus rename keeps cooperative readers from observing
  // a partial rewrite. Retry once if the store is concurrently recreated.
  for (let attempt = 0; attempt < 2; attempt++) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      ensureStore();
      writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, file);
      return request;
    } catch (error) {
      rmSync(temporary, { force: true });
      if (error?.code !== "ENOENT" || attempt > 0) throw error;
    }
  }
  return request;
}

export function readCancellation(runId) {
  const safeId = safeRunId(runId);
  const file = cancelFileFor(safeId);
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    // A deletion between existsSync and readFileSync means there is no request.
    if (error?.code === "ENOENT") return undefined;
    return { runId: safeId, reason: "cancel requested" };
  }
}

export function safeRunId(runId) {
  const value = String(runId || "").trim();
  if (!/^[a-zA-Z0-9_.:-]+$/.test(value)) throw new Error(`Invalid thread-phase runId: ${value || "(empty)"}`);
  return value;
}

function stringifyValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? nested.toString() : nested);
  } catch (error) {
    return JSON.stringify({ unserializable: true, message: error?.message || String(error), preview: String(value) });
  }
}

function compactValue(value, maxBytes = 200_000) {
  if (value === undefined) return undefined;
  const text = stringifyValue(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return value;
  let out = text.slice(0, maxBytes);
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return {
    truncated: true,
    bytes: Buffer.byteLength(text, "utf8"),
    preview: `${out}\n[truncated]`,
  };
}

function normalizeRun(run) {
  if (!run || typeof run !== "object") throw new Error("run context is required");
  if (!run.runId) throw new Error("run.runId is required");
  if (!run.workflow) throw new Error("run.workflow is required");
  // emit() is also a public entry point, so do not rely on every producer using
  // createRun(). At write time process.cwd() is the known origin for a relative
  // run cwd; persist its canonical absolute form rather than legacy ambiguity.
  const launchCwd = canonicalCwd(run.cwd, process.cwd());
  if (run.cwd !== undefined && launchCwd === undefined) {
    throw new Error("run.cwd must be a non-empty path when provided");
  }
  const canonicalRunFile = runFileFor(String(run.runId));
  if (run.runFile !== undefined && (typeof run.runFile !== "string" || !run.runFile.trim() || resolve(run.runFile) !== resolve(canonicalRunFile))) {
    throw new Error("custom runFile paths are not supported");
  }
  return {
    runId: String(run.runId),
    workflow: String(run.workflow),
    ...(launchCwd === undefined ? {} : { cwd: launchCwd }),
    trigger: run.trigger,
    metadata: normalizeOwnerMetadata(run.metadata, launchCwd, run.trigger),
    runFile: canonicalRunFile,
  };
}

export function createRun(options = {}) {
  ensureStore();
  const workflow = normalizeWorkflowName(options.workflow || "workflow");
  // process.cwd() is the runner's known origin for a relative launch cwd.
  // Owner metadata is descriptive and must not supply a competing origin.
  const launchCwd = canonicalCwd(options.cwd, process.cwd());
  if (options.cwd !== undefined && launchCwd === undefined) {
    throw new Error("cwd must be a non-empty path when provided");
  }
  const run = {
    runId: safeRunId(options.runId || createRunId(workflow)),
    workflow,
    ...(launchCwd === undefined ? {} : { cwd: launchCwd }),
    trigger: options.trigger,
    metadata: normalizeOwnerMetadata(options.metadata, launchCwd, options.trigger),
  };
  run.runFile = runFileFor(run.runId);
  emit(run, {
    type: EVENT_TYPES.WORKFLOW_START,
    status: STATUSES.RUNNING,
    message: options.message || `${workflow} started`,
    data: compactValue(options.input),
    metadata: run.metadata,
  });
  return run;
}

export function emit(runContext, event = {}) {
  ensureStore();
  const run = normalizeRun(runContext);
  let eventData = event.data;
  let eventMessage = event.message;
  const dataKind = eventData && typeof eventData === "object" ? eventData.kind || eventData.type : undefined;
  if (dataKind === "active_io") {
    if (String(process.env.PI_THREAD_PHASE_ACTIVE_IO || "1") === "0") return undefined;
    eventData = redactActiveIo({ ...eventData, kind: "active_io", schema: "thread-phase-active-io/v1", updatedAt: eventData.updatedAt || new Date().toISOString() });
    eventMessage = eventData.message ?? (eventMessage ? compactText(redactSecrets(String(eventMessage)), 1200).content : undefined);
  }
  if (event.eventId !== undefined && (typeof event.eventId !== "string" || !event.eventId.trim())) {
    throw new Error("event.eventId must be a non-empty string when provided");
  }
  const normalized = {
    schema: SCHEMA_VERSION,
    eventId: event.eventId || randomUUID(),
    timestamp: event.timestamp || new Date().toISOString(),
    runId: run.runId,
    workflow: run.workflow,
    cwd: run.cwd,
    trigger: run.trigger,
    type: normalizeEventType(event.type || EVENT_TYPES.PHASE_EVENT),
    phase: event.phase ? String(event.phase) : undefined,
    // Preserve workflow-specific statuses as strings in the event log. Projection helpers
    // expose normalizedStatus for UI decisions.
    status: event.status ? normalizeStatusValue(event.status) : undefined,
    level: event.level,
    message: eventMessage,
    data: compactValue(eventData),
    artifact: compactValue(event.artifact, 20_000),
    error: event.error ? serializeError(event.error) : undefined,
    metadata: compactValue(event.metadata === undefined
      ? undefined
      : normalizeOwnerMetadata(event.metadata, run.cwd, run.trigger)),
  };
  const persistedEvent = dropUndefined(normalized);
  const line = `${JSON.stringify(persistedEvent)}\n`;
  const isWorkflowStart = persistedEvent.type === EVENT_TYPES.WORKFLOW_START;
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (isWorkflowStart && lineBytes > RUN_START_SCAN_MAX_BYTES) {
    throw new Error(`Run ${run.runId} workflow_start exceeds the ${RUN_START_SCAN_MAX_BYTES}-byte verification limit`);
  }
  if (lineBytes > EVENT_RECORD_MAX_BYTES) {
    throw new Error(`Run ${run.runId} event exceeds the ${EVENT_RECORD_MAX_BYTES}-byte persistence limit`);
  }
  if (isWorkflowStart && resolve(run.runFile) !== resolve(runFileFor(run.runId))) {
    throw new Error("workflow_start does not support a custom runFile path");
  }
  const reservation = isWorkflowStart ? reserveRunStartEnvelope(persistedEvent) : undefined;
  let pendingFile;
  try {
    // Write-ahead marker closes the process-exit window between authoritative
    // run publication and global index append.
    pendingFile = persistPendingIndex(line);
  } catch (error) {
    if (reservation?.file) rmSync(reservation.file, { force: true });
    throw error;
  }
  let runWriteCompleted = false;
  let runFileCommitted = false;
  let runFileCreated = false;
  let runTempFile;
  let runFd;
  try {
    withAppendLock(() => {
    if (isWorkflowStart) {
      // Build the complete start privately, then atomically publish a hard link
      // without replacement. Other appenders can never observe an empty file.
      runTempFile = `${run.runFile}.${randomUUID()}.tmp`;
      runFd = openSync(runTempFile, "wx", 0o600);
      const record = Buffer.from(line);
      if (writeSync(runFd, record, 0, record.length) !== record.length) throw new Error(`Partial workflow_start write for ${run.runId}`);
      fsyncSync(runFd);
      closeSync(runFd);
      runFd = undefined;
      linkSync(runTempFile, run.runFile);
      runFileCreated = true;
      runWriteCompleted = true;
      fsyncDirectory(RUNS_DIR);
      rmSync(runTempFile, { force: true });
      runTempFile = undefined;
      fsyncDirectory(RUNS_DIR);
    } else {
      let prefix = "";
      const size = existsSync(run.runFile) ? statSync(run.runFile).size : 0;
      if (size > 0) {
        let readFd;
        try {
          readFd = openSync(run.runFile, "r");
          const last = Buffer.allocUnsafe(1);
          if (readSync(readFd, last, 0, 1, size - 1) === 1 && last[0] !== 10) prefix = "\n";
        } finally {
          if (readFd !== undefined) closeSync(readFd);
        }
      }
      runFd = openSync(run.runFile, "a", 0o600);
      const record = Buffer.from(`${prefix}${line}`);
      if (writeSync(runFd, record, 0, record.length) !== record.length) throw new Error(`Partial event append for ${run.runId}`);
      runWriteCompleted = true;
      fsyncSync(runFd);
      closeSync(runFd);
      runFd = undefined;
    }
    fsyncDirectory(RUNS_DIR);
    });
    runFileCommitted = true;
    if (reservation) commitRunStartReservation(reservation);
    pendingFile = commitPendingIndex(pendingFile);
    processCommittedMarker(pendingFile, false);
    pendingFile = undefined;
  } catch (error) {
    if (runFd !== undefined) closeSync(runFd);
    if (runTempFile) rmSync(runTempFile, { force: true });
    if (!runFileCommitted) {
      // A completed write with failed fsync has uncertain durability. Keep its
      // prepared marker/reservation for post-crash recovery, but never report
      // success. Definite pre-write failures can be rolled back immediately.
      if (!runWriteCompleted) {
        if (runFileCreated) rmSync(run.runFile, { force: true });
        if (reservation?.file) rmSync(reservation.file, { force: true });
        if (pendingFile) rmSync(pendingFile, { force: true });
      }
      if (pendingFile) ACTIVE_PENDING_MARKERS.delete(pendingFile);
      throw error;
    }
    // A committed run event is recoverable. Ensure ownership and its marker are
    // committed before reporting success; reconciliation repairs index tails.
    if (reservation && reservation.envelope.reservationState !== "committed") commitRunStartReservation(reservation);
    if (pendingFile && basename(pendingFile).startsWith("prepared-")) pendingFile = commitPendingIndex(pendingFile);
    if (pendingFile) ACTIVE_PENDING_MARKERS.delete(pendingFile);
    throw error;
  }
  if (reservation) appendRunStartCatalog(reservation.envelope);
  return normalized;
}

export function phaseStart(run, phase, data) {
  return emit(run, { type: EVENT_TYPES.PHASE_START, phase, status: STATUSES.RUNNING, message: `${phase} started`, data });
}

export function phaseEvent(run, phase, event) {
  const kind = event && typeof event === "object" ? event.kind || event.type : undefined;
  if (kind === "active_io" && String(process.env.PI_THREAD_PHASE_ACTIVE_IO || "1") === "0") return undefined;
  const data = kind === "active_io"
    ? redactActiveIo({ ...event, kind: "active_io", schema: "thread-phase-active-io/v1", updatedAt: event.updatedAt || new Date().toISOString() })
    : event;
  const message = kind === "active_io" ? data?.message : event?.message;
  return emit(run, { type: EVENT_TYPES.PHASE_EVENT, phase, message, data });
}

export function phaseEnd(run, phase, status = STATUSES.SUCCESS, data) {
  return emit(run, { type: EVENT_TYPES.PHASE_END, phase, status, message: `${phase} ${status}`, data });
}

export function artifact(run, artifact) {
  return emit(run, {
    type: EVENT_TYPES.ARTIFACT,
    status: STATUSES.SUCCESS,
    message: artifact?.title || artifact?.path || "artifact",
    artifact,
  });
}

export function completeRun(run, status = STATUSES.SUCCESS, data) {
  return emit(run, {
    type: EVENT_TYPES.WORKFLOW_END,
    status,
    message: `${run.workflow || "workflow"} ${status}`,
    data,
  });
}

export function failRun(run, error, data) {
  emit(run, {
    type: EVENT_TYPES.ERROR,
    status: STATUSES.FAILED,
    level: "error",
    message: error?.message || String(error),
    error,
    data,
  });
  return completeRun(run, STATUSES.FAILED, { error: serializeError(error), ...data });
}

export function emitActiveIo(run, phase, io = {}) {
  if (String(process.env.PI_THREAD_PHASE_ACTIVE_IO || "1") === "0") return undefined;
  return phaseEvent(run, phase, {
    ...io,
    kind: "active_io",
    schema: "thread-phase-active-io/v1",
    updatedAt: io.updatedAt || new Date().toISOString(),
  });
}

function redactActiveIo(io = {}) {
  const out = {
    kind: "active_io",
    schema: "thread-phase-active-io/v1",
    updatedAt: io.updatedAt,
    componentId: io.componentId,
    role: io.role,
    status: io.status,
    pid: typeof io.pid === "number" ? io.pid : undefined,
    cwd: io.cwd,
    inputBytes: typeof io.inputBytes === "number" ? io.inputBytes : undefined,
    outputBytes: typeof io.outputBytes === "number" ? io.outputBytes : undefined,
    stdoutBytes: typeof io.stdoutBytes === "number" ? io.stdoutBytes : undefined,
    stderrBytes: typeof io.stderrBytes === "number" ? io.stderrBytes : undefined,
    truncated: io.truncated === undefined ? undefined : Boolean(io.truncated),
  };
  for (const key of ["component", "command", "inputPreview", "message"]) {
    if (io[key] !== undefined) out[key] = compactText(redactSecrets(String(io[key])), 1200).content;
  }
  for (const key of ["outputPreview", "stdoutPreview", "stderrPreview"]) {
    if (io[key] !== undefined) out[key] = compactTail(redactSecrets(String(io[key])), 1200);
  }
  return out;
}

function compactTail(text, maxBytes) {
  const value = String(text || "");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = `[truncated older active I/O: original output was ${Buffer.byteLength(value, "utf8")} bytes]\n`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let out = value.slice(-budget);
  while (Buffer.byteLength(out, "utf8") > budget) out = out.slice(1);
  return `${marker}${out}`;
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[redacted-api-key]")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|API[_-]?KEY|PASSWORD|PASSWD|AUTH|BEARER)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s'\"]+)/gi, "$1=[redacted]")
    .replace(/(--?(?:token|secret|api[-_]?key|password|passwd|auth|bearer)(?:\s+|=))(("[^"]*")|('[^']*')|[^\s]+)/gi, "$1[redacted]");
}

export function emitAgentEvent(run, phase, agentEvent) {
  return emit(run, {
    type: EVENT_TYPES.AGENT_EVENT,
    phase,
    status: agentEvent?.type === "agent_end" ? agentEvent?.finishReason || undefined : undefined,
    message: agentEvent?.text || agentEvent?.message || agentEvent?.type,
    data: agentEvent,
  });
}

export function emitPipelineEvent(run, phase, pipelineEvent) {
  return emit(run, {
    type: EVENT_TYPES.PHASE_EVENT,
    phase: phase || pipelineEvent?.phase || pipelineEvent?.name,
    message: pipelineEvent?.message || pipelineEvent?.type,
    data: pipelineEvent,
  });
}

export async function* mirrorPipelineEvents(events, run, options = {}) {
  for await (const event of events) {
    emitPipelineEvent(run, options.phase, event);
    yield event;
  }
}

export function wrapPhase(phase, run, options = {}) {
  if (!phase || typeof phase.run !== "function") throw new Error("wrapPhase expected a Phase-like object with run(ctx)");
  const phaseName = options.name || phase.name || "phase";
  return {
    ...phase,
    name: phase.name || phaseName,
    async *run(ctx, ...args) {
      phaseStart(run, phaseName, options.input?.(ctx));
      try {
        for await (const event of phase.run(ctx, ...args)) {
          phaseEvent(run, phaseName, event);
          yield event;
        }
        phaseEnd(run, phaseName, ctx?.stop ? STATUSES.CANCELLED : STATUSES.SUCCESS, options.output?.(ctx));
      } catch (error) {
        const cancelled = error?.name === "AbortError" || /aborted|cancelled/i.test(String(error?.message || error));
        phaseEnd(run, phaseName, cancelled ? STATUSES.CANCELLED : STATUSES.FAILED, { error: serializeError(error) });
        throw error;
      }
    },
  };
}

export function wrapPhases(phases, run, options = {}) {
  return phases.map((phase) => wrapPhase(phase, run, options[phase.name] || {}));
}

const JSONL_READ_CHUNK_BYTES = 64 * 1024;
const JSONL_DIAGNOSTIC_PREVIEW_BYTES = 160;
const DEFAULT_JSONL_READ_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_INDEX_READ_LIMIT = 5000;
const DEFAULT_RUN_READ_LIMIT = 50_000;
const RUN_START_SCAN_MAX_BYTES = 512 * 1024;
const EVENT_RECORD_MAX_BYTES = 512 * 1024;
const RUN_START_SCAN_MAX_RECORDS = 1024;
const DEFAULT_OWNERSHIP_READ_BUDGET_BYTES = 8 * 1024 * 1024;
const DEFAULT_OWNERSHIP_FALLBACK_SCAN_LIMIT = 256;
const DEFAULT_OWNERSHIP_SIDECAR_SCAN_LIMIT = 256;
const DEFAULT_OWNERSHIP_SIDECAR_READ_BUDGET_BYTES = 4 * 1024 * 1024;
const RUN_START_SIDECAR_MAX_BYTES = 16 * 1024;
const RUN_START_CATALOG_MAX_BYTES = 16 * 1024 * 1024;
const RUN_START_CATALOG_MAX_RECORDS = 20_000;
const RUN_START_CACHE_MAX_ENTRIES = 1_000;
const runStartCache = new Map();
let runStartCatalogCache;

/**
 * Read a bounded window from a JSONL file without materializing the whole file.
 * With no byte offset the window is taken from the tail. A fromByte offset reads
 * forward and is useful for pagination; an offset in the middle of a line skips
 * that partial line. readLimit bounds lines inspected, limit bounds results, and
 * maxBytes bounds the file window retained and decoded. Records cut by that byte
 * ceiling are skipped with an oversized_record diagnostic.
 */
export function readJsonl(file, { fromByte, limit, readLimit, maxBytes } = {}) {
  const empty = jsonlResult([], []);
  if (!existsSync(file)) return empty;
  const maxRead = positiveInteger(readLimit, positiveInteger(limit, DEFAULT_INDEX_READ_LIMIT));
  const maxResults = positiveInteger(limit, maxRead);
  const byteCeiling = positiveInteger(maxBytes, DEFAULT_JSONL_READ_MAX_BYTES);
  if (maxRead === 0 || maxResults === 0 || byteCeiling === 0) return empty;

  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return empty;
    const lines = fromByte === undefined
      ? readJsonlTailLines(fd, size, maxRead, byteCeiling)
      : readJsonlForwardLines(fd, size, byteOffset(fromByte, size), maxRead, byteCeiling);
    const parseErrors = [];
    const events = [];
    const seen = new Set();
    for (const [lineIndex, entry] of lines.entries()) {
      const parsed = parseJsonLine(entry, { file, lineIndex, parseErrors });
      if (!parsed) continue;
      const identity = eventIdentity(parsed, entry.text);
      if (seen.has(identity)) continue;
      seen.add(identity);
      events.push(parsed);
    }
    const bounded = events.slice(fromByte === undefined ? -maxResults : 0, fromByte === undefined ? undefined : maxResults);
    return jsonlResult(bounded, parseErrors);
  } finally {
    closeSync(fd);
  }
}

function readJsonlTailLines(fd, size, readLimit, maxBytes) {
  if (readLimit === 0) return [];
  const entries = [];
  const finalByte = Buffer.allocUnsafe(1);
  const newlineTerminated = readSync(fd, finalByte, 0, 1, size - 1) === 1 && finalByte[0] === 10;
  let recordEnd = newlineTerminated ? size - 1 : size;
  let complete = newlineTerminated;
  let inspected = 0;
  let delimitersScanned = 0;
  const delimiterLimit = readLimit * 2 + 16;
  let bytesRetained = 0;
  const scanBuffer = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES);

  // Walk records rather than recursively refilling byte windows. Delimiter scans
  // reuse one fixed buffer, and oversized records retain only a diagnostic
  // preview, so even a multi-gigabyte trailing record cannot grow the heap or
  // call stack. An oversized record still counts against readLimit.
  while (recordEnd > 0 && inspected < readLimit && delimitersScanned < delimiterLimit) {
    const previousNewline = findPreviousNewline(fd, recordEnd, scanBuffer);
    const recordStart = previousNewline + 1;
    const recordBytes = recordEnd - recordStart;
    let entry;
    if (recordBytes > maxBytes || bytesRetained + recordBytes > maxBytes) {
      entry = oversizedJsonlEntry(readJsonlPreview(fd, recordStart, recordBytes), maxBytes);
    } else {
      entry = { text: readJsonlText(fd, recordStart, recordBytes), complete };
      bytesRetained += recordBytes;
    }
    if (recordBytes > 0) {
      entries.push(entry);
      inspected++;
    }
    delimitersScanned++;
    if (previousNewline < 0) break;
    recordEnd = previousNewline;
    complete = true;
  }
  return entries.reverse();
}

function readJsonlForwardLines(fd, size, offset, readLimit, maxBytes) {
  if (readLimit === 0) return [];
  const entries = [];
  let position = offset;
  let inspected = 0;
  let delimitersScanned = 0;
  const delimiterLimit = readLimit * 2 + 16;
  let bytesRetained = 0;
  const scanBuffer = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES);
  let startsOnBoundary = offset === 0;
  if (offset > 0) {
    const previous = Buffer.allocUnsafe(1);
    startsOnBoundary = readSync(fd, previous, 0, 1, offset - 1) === 1 && previous[0] === 10;
  }

  // An offset inside a record discards that fragment. Diagnose and count it only
  // when reaching its delimiter requires crossing the byte ceiling, matching the
  // bounded-window contract while allowing iterative recovery after the record.
  if (!startsOnBoundary && position < size) {
    const nextNewline = findNextNewline(fd, position, size, scanBuffer);
    const fragmentEnd = nextNewline < 0 ? size : nextNewline;
    const fragmentBytes = fragmentEnd - position;
    if (fragmentBytes >= maxBytes) {
      entries.push(oversizedJsonlEntry(readJsonlPreview(fd, position, fragmentBytes), maxBytes));
      inspected++;
    }
    if (nextNewline < 0 || inspected >= readLimit) return entries;
    position = nextNewline + 1;
  }

  while (position < size && inspected < readLimit && delimitersScanned < delimiterLimit) {
    const nextNewline = findNextNewline(fd, position, size, scanBuffer);
    const complete = nextNewline >= 0;
    const recordEnd = complete ? nextNewline : size;
    const recordBytes = recordEnd - position;
    if (recordBytes > 0) {
      if (recordBytes > maxBytes || bytesRetained + recordBytes > maxBytes) {
        entries.push(oversizedJsonlEntry(readJsonlPreview(fd, position, recordBytes), maxBytes));
      } else {
        entries.push({ text: readJsonlText(fd, position, recordBytes), complete });
        bytesRetained += recordBytes;
      }
      inspected++;
    }
    delimitersScanned++;
    if (!complete) break;
    position = nextNewline + 1;
  }
  return entries;
}

function oversizedJsonlEntry(preview, maxBytes) {
  return { oversized: true, text: preview, maxBytes, complete: false };
}

function readJsonlText(fd, position, length) {
  if (length === 0) return "";
  const buffer = Buffer.allocUnsafe(length);
  const bytesRead = readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

function readJsonlPreview(fd, position, length) {
  const previewBytes = Math.min(length, JSONL_DIAGNOSTIC_PREVIEW_BYTES);
  return readJsonlText(fd, position, previewBytes);
}

function findPreviousNewline(fd, beforePosition, buffer = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES)) {
  let position = beforePosition;
  while (position > 0) {
    const length = Math.min(buffer.length, position);
    position -= length;
    const bytesRead = readSync(fd, buffer, 0, length, position);
    const index = buffer.subarray(0, bytesRead).lastIndexOf(10);
    if (index >= 0) return position + index;
  }
  return -1;
}

function findNextNewline(fd, fromPosition, size, buffer = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES)) {
  let position = fromPosition;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const bytesRead = readSync(fd, buffer, 0, length, position);
    if (bytesRead === 0) break;
    const index = buffer.subarray(0, bytesRead).indexOf(10);
    if (index >= 0) return position + index;
    position += bytesRead;
  }
  return -1;
}

function parseJsonLine(entry, { file, lineIndex, parseErrors }) {
  if (entry.oversized) {
    parseErrors.push(jsonlParseError("oversized_record", file, lineIndex, entry.text, undefined, entry.maxBytes));
    return undefined;
  }
  if (!entry.complete) {
    parseErrors.push(jsonlParseError("partial_final_line", file, lineIndex, entry.text));
    return undefined;
  }
  try { return JSON.parse(entry.text); }
  catch (error) {
    parseErrors.push(jsonlParseError("invalid_json", file, lineIndex, entry.text, error));
    return undefined;
  }
}

function jsonlParseError(kind, file, lineIndex, line, error, maxBytes) {
  const message = kind === "partial_final_line"
    ? "Skipped incomplete final JSONL line"
    : kind === "oversized_record"
      ? `Skipped JSONL record crossing the ${maxBytes}-byte read ceiling`
      : error?.message || "Invalid JSON";
  return {
    kind,
    file,
    lineIndex,
    message,
    preview: line.length > 500 ? `${line.slice(0, 500)}…` : line,
  };
}

function jsonlResult(events, parseErrors) {
  Object.defineProperty(events, "parseErrors", { value: parseErrors, enumerable: false });
  return events;
}

function eventIdentity(event, sourceLine) {
  return event?.eventId ? `eventId:${event.runId || ""}:${event.eventId}` : `line:${sourceLine}`;
}

function withParseErrors(events, source) {
  return jsonlResult(events, source?.parseErrors || []);
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function byteOffset(value, size) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(size, Math.floor(number)));
}

function byTimestamp(events) {
  events.sort((a, b) => String(a?.timestamp || "").localeCompare(String(b?.timestamp || "")));
  return events;
}

function normalizedRecordedCwd(value) {
  // Persisted workflow_start records should already be absolute, but historical
  // records may contain symlink paths. Canonicalize only absolute values: a
  // relative launch path has no trustworthy original base and must stay
  // unresolvable rather than being interpreted relative to the viewer.
  return typeof value === "string" && isAbsolute(value) ? canonicalCwd(value) : value;
}

export function readRunBounded(runId, options = {}) {
  const file = runFileFor(runId);
  const readLimit = options.readLimit ?? DEFAULT_RUN_READ_LIMIT;
  return byTimestamp(readJsonl(file, { ...options, readLimit }));
}

export function readIndexBounded(options = {}) {
  const { workflow, cwd, limit: requestedLimit, ...boundedOptions } = options;
  const readLimit = boundedOptions.readLimit ?? DEFAULT_INDEX_READ_LIMIT;
  const parsed = readJsonl(INDEX_FILE, { ...boundedOptions, limit: readLimit, readLimit });
  let events = parsed;
  if (workflow) events = events.filter((event) => event.workflow === workflow);
  if (cwd) events = events.filter((event) => event.cwd === cwd);
  const limit = positiveInteger(requestedLimit, readLimit);
  events = limit === 0
    ? []
    : events.slice(options.fromByte === undefined ? -limit : 0, options.fromByte === undefined ? undefined : limit);
  return byTimestamp(withParseErrors(events, parsed));
}

export function readRun(runId, options = {}) {
  return readRunBounded(runId, { readLimit: DEFAULT_RUN_READ_LIMIT, ...options });
}

export function readIndex(options = {}) {
  return readIndexBounded({ readLimit: DEFAULT_INDEX_READ_LIMIT, limit: 200, ...options });
}

function artifactIdentity(artifact) {
  if (!artifact || typeof artifact !== "object") return undefined;
  if (artifact.path) return `path:${artifact.path}`;
  if (artifact.url) return `url:${artifact.url}`;
  return undefined;
}

function dedupeArtifacts(artifacts = []) {
  const byKey = new Map();
  const out = [];
  for (const artifact of artifacts) {
    const key = artifactIdentity(artifact);
    if (!key) {
      out.push(artifact);
      continue;
    }
    if (byKey.has(key)) {
      const existingIndex = byKey.get(key);
      out.splice(existingIndex, 1);
      for (const [otherKey, index] of byKey.entries()) if (index > existingIndex) byKey.set(otherKey, index - 1);
    }
    byKey.set(key, out.length);
    out.push(artifact);
  }
  return out;
}

function closeOpenPhasesForTerminalRun(summary, sawWorkflowEnd = false) {
  if (!sawWorkflowEnd || summary.normalizedStatus === STATUSES.RUNNING) return;
  const terminal = summary.normalizedStatus || STATUSES.UNKNOWN;
  for (const phase of Object.values(summary.phaseMap || {})) {
    if (phase.normalizedStatus !== STATUSES.RUNNING || phase.endedAt) continue;
    phase.status = terminal;
    phase.normalizedStatus = terminal;
    phase.endedAt = summary.endedAt || summary.updatedAt;
  }
}

export function projectRun(events = [], options = {}) {
  // Capture once so every stale field in this projection uses the same clock,
  // and allow callers comparing projections to inject a shared reference time.
  const referenceTime = projectionReferenceTime(options.referenceTime);
  const seenEvents = new Set();
  const sorted = [...events].filter((event) => {
    if (!event) return false;
    const identity = eventIdentity(event, JSON.stringify(event));
    if (seenEvents.has(identity)) return false;
    seenEvents.add(identity);
    return true;
  }).sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  const first = sorted[0] || {};
  // Ownership is established by workflow_start and must not be rewritten by a
  // later event carrying different metadata. Bounded index windows may omit
  // this event; store-backed summary helpers restore it from the run log.
  const workflowStart = sorted.find((event) => event.type === EVENT_TYPES.WORKFLOW_START && (!first.runId || event.runId === first.runId));
  const workflowStartHasCwd = Boolean(workflowStart && Object.prototype.hasOwnProperty.call(workflowStart, "cwd"));
  const summary = {
    runId: workflowStart?.runId || first.runId,
    workflow: workflowStart?.workflow || first.workflow,
    cwd: workflowStart ? normalizedRecordedCwd(workflowStart.cwd) : first.cwd,
    trigger: workflowStart ? workflowStart.trigger : first.trigger,
    metadata: workflowStart ? workflowStart.metadata : first.metadata,
    // Store-backed helpers set this to false when their bounded prefix lookup
    // cannot prove a workflow_start. Scoping treats that state as unknown and
    // fails closed instead of trusting metadata or cwd from a later event.
    workflowStartResolved: Boolean(workflowStart),
    // Keep cwd field presence as explicit provenance. Only omission permits
    // absolute metadata fallback; every explicitly persisted invalid value is
    // authoritative and fails closed.
    workflowStartCwdPresent: workflowStart ? workflowStartHasCwd : undefined,
    startedAt: workflowStart?.timestamp || first.timestamp,
    updatedAt: first.timestamp,
    status: STATUSES.RUNNING,
    normalizedStatus: STATUSES.RUNNING,
    phases: [],
    phaseMap: {},
    artifacts: [],
    errors: [],
    progress: {},
    usage: emptyUsageSummary(),
    heartbeat: undefined,
    activeIo: undefined,
    stale: undefined,
    lastMessage: first.message,
    eventCount: sorted.length,
    events: sorted,
  };
  // Field presence carries provenance for historical starts. Delete cwd only
  // when it was genuinely omitted; explicit invalid values remain represented
  // and fail closed during session scoping.
  if (workflowStart && !workflowStartHasCwd) delete summary.cwd;
  let sawWorkflowEnd = false;

  for (const event of sorted) {
    summary.runId ||= event.runId;
    summary.workflow ||= event.workflow;
    if (!workflowStart) {
      summary.cwd ||= event.cwd;
      summary.trigger ||= event.trigger;
      summary.metadata ||= event.metadata;
    }
    summary.startedAt ||= event.timestamp;
    summary.updatedAt = event.timestamp || summary.updatedAt;
    summary.lastMessage = event.message || summary.lastMessage;

    if (event.type === EVENT_TYPES.WORKFLOW_START) {
      summary.status = event.status || STATUSES.RUNNING;
      summary.normalizedStatus = normalizeStatus(event.status || STATUSES.RUNNING);
    }
    if (event.type === EVENT_TYPES.WORKFLOW_END) {
      sawWorkflowEnd = true;
      summary.endedAt = event.timestamp || summary.updatedAt;
      summary.status = event.status || STATUSES.SUCCESS;
      summary.normalizedStatus = normalizeStatus(event.status || STATUSES.SUCCESS);
    }
    if (event.type === EVENT_TYPES.ERROR || event.error) {
      summary.errors.push({
        timestamp: event.timestamp,
        phase: event.phase,
        message: event.message || event.error?.message,
        error: event.error,
      });
    }
    if (event.type === EVENT_TYPES.PHASE_START && event.phase) {
      upsertPhase(summary, event.phase, {
        phase: event.phase,
        status: event.status || STATUSES.RUNNING,
        normalizedStatus: normalizeStatus(event.status || STATUSES.RUNNING),
        startedAt: event.timestamp,
        updatedAt: event.timestamp,
        eventCount: 0,
        lastMessage: event.message,
        type: event.data?.type,
        model: event.data?.model,
      });
    }
    if (event.type === EVENT_TYPES.PHASE_EVENT && event.phase) {
      const phase = summary.phaseMap[event.phase] || upsertPhase(summary, event.phase, {
        phase: event.phase,
        status: STATUSES.RUNNING,
        normalizedStatus: STATUSES.RUNNING,
        startedAt: event.timestamp,
      });
      phase.updatedAt = event.timestamp || phase.updatedAt;
      phase.lastMessage = event.message || phase.lastMessage;
      if (event.data?.model) phase.model = String(event.data.model);
      if (event.data?.key === "model" && event.data?.value) phase.model = String(event.data.value);
      phase.eventCount = (phase.eventCount || 0) + 1;
      const progress = extractProgress(event.data);
      if (progress) {
        summary.progress[event.phase] = progress;
        phase.progress = progress;
      }
      const heartbeat = extractHeartbeat(event.data, event);
      if (heartbeat) {
        summary.heartbeat = heartbeat;
        phase.heartbeat = heartbeat;
        phase.lastMessage = heartbeat.message || phase.lastMessage;
      }
      const activeIo = extractActiveIo(event.data, event);
      if (activeIo) {
        summary.activeIo = mergeActiveIo(summary.activeIo, activeIo);
        phase.activeIo = mergeActiveIo(phase.activeIo, activeIo);
      }
      applyFanoutEvent(phase, event.data, event);
      applyUsageEvent(summary, phase, event.data, event);
    }
    if (event.type === EVENT_TYPES.PHASE_END && event.phase) {
      const phase = upsertPhase(summary, event.phase, { phase: event.phase });
      phase.status = event.status || STATUSES.SUCCESS;
      phase.normalizedStatus = normalizeStatus(event.status || STATUSES.SUCCESS);
      phase.endedAt = event.timestamp;
      phase.updatedAt = event.timestamp || phase.updatedAt;
      phase.lastMessage = event.message || phase.lastMessage;
      if (!phase.startedAt) phase.startedAt = event.timestamp;
    }
    if (event.type === EVENT_TYPES.ARTIFACT && event.artifact) {
      summary.artifacts.push({ ...event.artifact, eventId: event.eventId, timestamp: event.timestamp });
    }
  }

  for (const phase of Object.values(summary.phaseMap)) finalizeFanout(phase);
  closeOpenPhasesForTerminalRun(summary, sawWorkflowEnd);
  summary.artifacts = dedupeArtifacts(summary.artifacts);
  summary.phases = Object.values(summary.phaseMap).sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
  delete summary.phaseMap;
  if (summary.normalizedStatus !== STATUSES.FAILED && summary.errors.length > 0 && !sorted.some((e) => e.type === EVENT_TYPES.WORKFLOW_END)) {
    summary.status = STATUSES.FAILED;
    summary.normalizedStatus = STATUSES.FAILED;
  }
  if (summary.normalizedStatus === STATUSES.RUNNING) summary.stale = detectStaleRun(summary, referenceTime);
  return summary;
}

export function projectRuns(events = [], options = {}) {
  const referenceTime = projectionReferenceTime(options.referenceTime);
  const byRun = new Map();
  for (const event of events) {
    if (!event?.runId) continue;
    const bucket = byRun.get(event.runId) || [];
    bucket.push(event);
    byRun.set(event.runId, bucket);
  }
  return Array.from(byRun.values())
    .map((runEvents) => projectRun(runEvents, { referenceTime }))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function compactOwnerMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const compact = {};
  for (const key of [
    "sessionId", "sessionFile", "launchSource", "source", "cwdAtLaunch", "cwd",
    "pid", "ppid", "hostname", "cancellable", "cancelSignal", "autoContinue", "continuationMode",
    "dynamic", "mode", "permissions", "maxPermissions", "chainId", "rootRunId", "parentRunId", "chainStep",
    "resumedFromRunId", "resumedPhaseCount",
  ]) {
    const value = metadata[key];
    if (["string", "number", "boolean"].includes(typeof value)) compact[key] = value;
  }
  return Object.keys(compact).length ? compact : undefined;
}

function compactTrigger(trigger) {
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) return undefined;
  const compact = {};
  for (const key of ["kind", "ref", "event", "path", "source"]) {
    if (typeof trigger[key] === "string") compact[key] = trigger[key];
  }
  return Object.keys(compact).length ? compact : undefined;
}

function envelopeFromStartEvent(event, safeId, compact = false) {
  if (event?.type !== EVENT_TYPES.WORKFLOW_START || event.runId !== safeId) return undefined;
  return {
    found: true,
    metadata: compact ? compactOwnerMetadata(event.metadata) : event.metadata,
    cwdPresent: Object.prototype.hasOwnProperty.call(event, "cwd"),
    cwd: normalizedRecordedCwd(event.cwd),
    trigger: compact ? compactTrigger(event.trigger) : event.trigger,
    workflow: event.workflow,
    timestamp: event.timestamp,
    eventId: event.eventId,
  };
}

function startRecordFromEvent(event) {
  const envelope = envelopeFromStartEvent(event, event.runId, true);
  return dropUndefined({ schema: "thread-phase-run-start/v1", runId: event.runId, ...envelope, found: undefined });
}

function startRecordFromEnvelope(envelope, runId) {
  return startRecordFromEvent({
    type: EVENT_TYPES.WORKFLOW_START,
    runId,
    eventId: envelope.eventId,
    workflow: envelope.workflow,
    timestamp: envelope.timestamp,
    ...(envelope.cwdPresent ? { cwd: envelope.cwd } : {}),
    metadata: envelope.metadata,
    trigger: envelope.trigger,
  });
}

function envelopeFromStartRecord(record, safeId) {
  if (record?.schema !== "thread-phase-run-start/v1" || record.runId !== safeId) return undefined;
  return {
    found: true,
    metadata: record.metadata,
    cwdPresent: record.cwdPresent === true,
    cwd: normalizedRecordedCwd(record.cwd),
    trigger: record.trigger,
    workflow: record.workflow,
    timestamp: record.timestamp,
    eventId: record.eventId,
  };
}

function reserveRunStartEnvelope(event) {
  const runFile = runFileFor(event.runId);
  const sidecarFile = runStartFileFor(event.runId);
  if (existsSync(sidecarFile)) {
    try {
      const orphan = JSON.parse(readFileSync(sidecarFile, "utf8"));
      if (orphan.reservationState === "reserved" && typeof orphan.reservationPid === "number" && !isWriterAlive(orphan.reservationPid, orphan.reservationProcessStart)) {
        const reservedEnvelope = envelopeFromStartRecord(orphan, event.runId);
        const loggedStart = runStartEnvelope(event.runId, undefined, { skipCatalog: true, skipSidecar: true });
        const completeMatch = reservedEnvelope && loggedStart?.found
          && JSON.stringify(startRecordFromEnvelope(reservedEnvelope, event.runId)) === JSON.stringify(startRecordFromEnvelope(loggedStart, event.runId));
        if (completeMatch) {
          commitRunStartReservation({ file: sidecarFile, envelope: orphan });
        } else {
          mkdirSync(QUARANTINED_START_DIR, { recursive: true, mode: 0o700 });
          renameSync(sidecarFile, join(QUARANTINED_START_DIR, `${randomUUID()}-${event.runId}.start.json`));
          if (existsSync(runFile)) renameSync(runFile, join(QUARANTINED_START_DIR, `${randomUUID()}-${event.runId}.jsonl`));
          fsyncDirectory(QUARANTINED_START_DIR);
          fsyncDirectory(RUNS_DIR);
        }
      }
    } catch {
      // Unknown or live reservations fail closed below.
    }
  }
  if (existsSync(runFile) && statSync(runFile).size === 0) {
    throw new Error(`Run ${event.runId} already has an empty event log without a reclaimable reservation`);
  }
  if (existsSync(runFile) && statSync(runFile).size > 0) {
    // Never claim an existing non-empty legacy log whose start cannot be
    // verified within bounded recovery limits. Reuse requires explicit
    // migration rather than silently assigning new ownership.
    throw new Error(`Run ${event.runId} already has a non-empty event log`);
  }
  const existing = runStartEnvelope(event.runId, undefined, { skipCatalog: true });
  if (existing?.found) throw new Error(`Run ${event.runId} already has an authoritative workflow_start`);
  const file = runStartFileFor(event.runId);
  const record = { ...startRecordFromEvent(event), reservationPid: process.pid, reservationProcessStart: PROCESS_START_TOKEN, reservationState: "reserved" };
  const content = JSON.stringify(record);
  if (Buffer.byteLength(content, "utf8") > RUN_START_SIDECAR_MAX_BYTES) {
    throw new Error(`Run ${event.runId} workflow_start ownership metadata exceeds ${RUN_START_SIDECAR_MAX_BYTES} bytes`);
  }
  let fd;
  try {
    // Reserving before append makes the sidecar and first run-log start agree
    // even when two processes race on the same runId.
    fd = openSync(file, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    fsyncDirectory(RUNS_DIR);
    return { file, envelope: record };
  } catch (error) {
    if (fd !== undefined) {
      closeSync(fd);
      fd = undefined;
      rmSync(file, { force: true });
    }
    if (error?.code === "EEXIST") throw new Error(`Run ${event.runId} already has an authoritative workflow_start`);
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function commitRunStartReservation(reservation) {
  if (reservation.envelope.reservationState === "committed") return;
  const record = { ...reservation.envelope, reservationState: "committed" };
  const temporary = `${reservation.file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(record), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, reservation.file);
    fsyncDirectory(RUNS_DIR);
    reservation.envelope = record;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function appendRunStartCatalog(record) {
  try {
    appendRecordDurably(RUN_START_INDEX_FILE, `${JSON.stringify(record)}\n`);
    runStartCatalogCache = undefined;
  } catch {
    // The immutable per-run sidecar remains authoritative. The catalog is only
    // a batched lookup accelerator and may be rebuilt by future maintenance.
  }
}

function loadRunStartCatalog() {
  try {
    const stat = statSync(RUN_START_INDEX_FILE, { bigint: true });
    const signature = runFileMetadataSignature(stat);
    if (runStartCatalogCache?.signature === signature) return runStartCatalogCache.records;
    const records = new Map();
    for (const record of readJsonl(RUN_START_INDEX_FILE, {
      limit: RUN_START_CATALOG_MAX_RECORDS,
      readLimit: RUN_START_CATALOG_MAX_RECORDS,
      maxBytes: RUN_START_CATALOG_MAX_BYTES,
    })) {
      if (record?.schema === "thread-phase-run-start/v1" && record.runId) records.set(record.runId, record);
    }
    runStartCatalogCache = { signature, records };
    return records;
  } catch {
    return new Map();
  }
}

function readRunStartSidecar(safeId) {
  let fd;
  try {
    const file = runStartFileFor(safeId);
    if (!existsSync(file)) return undefined;
    fd = openSync(file, "r");
    const stat = fstatSync(fd, { bigint: true });
    const bytes = Number(stat.size);
    if (bytes > RUN_START_SIDECAR_MAX_BYTES) return undefined;
    const identity = `${file}:${stat.dev}:${stat.ino}:sidecar`;
    const signature = runFileMetadataSignature(stat);
    const cached = runStartCache.get(identity);
    if (cached?.signature === signature) {
      touchRunStartCache(identity, cached);
      return cached.result;
    }
    const buffer = Buffer.allocUnsafe(bytes);
    const bytesRead = bytes ? readSync(fd, buffer, 0, bytes, 0) : 0;
    const record = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    const result = envelopeFromStartRecord(record, safeId);
    if (!result) return undefined;
    const finalSignature = runFileMetadataSignature(fstatSync(fd, { bigint: true }));
    if (finalSignature !== signature) return undefined;
    cacheRunStart(identity, { signature, result });
    return result;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function runStartEnvelope(runId, budget, { skipCatalog = false, skipSidecar = false } = {}) {
  let fd;
  try {
    const safeId = safeRunId(runId);
    if (!skipCatalog) {
      const catalog = budget
        ? (budget.catalog ||= loadRunStartCatalog())
        : loadRunStartCatalog();
      const catalogRecord = catalog.get(safeId);
      const catalogEnvelope = catalogRecord ? envelopeFromStartRecord(catalogRecord, safeId) : undefined;
      if (catalogEnvelope) return catalogEnvelope;
    }
    const sidecarFile = runStartFileFor(safeId);
    if (!skipSidecar && existsSync(sidecarFile)) {
      if (budget && (budget.remainingSidecarScans <= 0 || budget.remainingSidecarBytes <= 0)) {
        return { found: false, ownership: "unknown", reason: "aggregate_sidecar_budget_exhausted" };
      }
      const sidecarBytes = statSync(sidecarFile).size;
      if (budget && sidecarBytes > budget.remainingSidecarBytes) {
        return { found: false, ownership: "unknown", reason: "aggregate_sidecar_byte_budget_exhausted" };
      }
      if (budget) {
        budget.remainingSidecarScans--;
        budget.remainingSidecarBytes -= sidecarBytes;
      }
      const sidecar = readRunStartSidecar(safeId);
      if (sidecar) return sidecar;
      return { found: false, ownership: "unknown", reason: "invalid_start_sidecar" };
    }
    if (budget && budget.remainingScans <= 0) {
      return { found: false, ownership: "unknown", reason: "aggregate_scan_budget_exhausted" };
    }
    if (budget) budget.remainingScans--;
    const file = runFileFor(safeId);
    if (!existsSync(file)) return { found: false };
    fd = openSync(file, "r");
    const stat = fstatSync(fd, { bigint: true });
    const identity = `${file}:${stat.dev}:${stat.ino}`;
    const signature = runFileMetadataSignature(stat);
    const cached = runStartCache.get(identity);
    if (cached?.signature === signature) {
      touchRunStartCache(identity, cached);
      return cached.result;
    }

    // Ownership and launch cwd are security boundaries. Inspect at most a
    // 512 KiB / 1024-complete-record prefix, accepting corrupt complete records
    // before the start. If either ceiling is reached, an oversized record
    // crosses the byte ceiling, the start is missing, or the file ends
    // mid-record, ownership remains unknown and scoping fails closed.
    const fileSize = Number(stat.size);
    const scanLimit = Math.min(fileSize, RUN_START_SCAN_MAX_BYTES);
    const buffer = Buffer.allocUnsafe(scanLimit);
    let bytesRead = 0;
    let lineStart = 0;
    let recordsInspected = 0;
    let aggregateExhausted = false;
    let result = { found: false, ownership: "unknown", reason: "workflow_start_not_found" };
    // Read incrementally and stop at the authoritative start. Aggregate
    // accounting reflects bytes actually scanned rather than charging every
    // large run the full 512 KiB ceiling.
    while (bytesRead < scanLimit && recordsInspected < RUN_START_SCAN_MAX_RECORDS && !result.found) {
      const available = budget ? Math.min(4096, budget.remainingBytes) : 4096;
      if (available <= 0) {
        aggregateExhausted = true;
        break;
      }
      const requested = Math.min(available, scanLimit - bytesRead);
      const count = readSync(fd, buffer, bytesRead, requested, bytesRead);
      if (count <= 0) break;
      bytesRead += count;
      if (budget) budget.remainingBytes -= count;
      const prefix = buffer.subarray(0, bytesRead);
      for (let newline = prefix.indexOf(10, lineStart); newline >= 0 && recordsInspected < RUN_START_SCAN_MAX_RECORDS; newline = prefix.indexOf(10, lineStart)) {
        recordsInspected++;
        if (newline > lineStart) {
          try {
            const event = JSON.parse(prefix.subarray(lineStart, newline).toString("utf8"));
            const envelope = envelopeFromStartEvent(event, safeId);
            if (envelope) {
              result = envelope;
              break;
            }
          } catch {
            // Corrupt complete records before workflow_start are tolerated.
          }
        }
        lineStart = newline + 1;
      }
    }
    if (!result.found) {
      if (aggregateExhausted) result.reason = "aggregate_byte_budget_exhausted";
      else if (recordsInspected >= RUN_START_SCAN_MAX_RECORDS) result.reason = "record_budget_exhausted";
      else if (fileSize > RUN_START_SCAN_MAX_BYTES) result.reason = "byte_budget_exhausted";
      else if (lineStart < bytesRead) result.reason = "incomplete_record";
    }

    // Never cache or trust an envelope read while the file was changing. Exact
    // nanosecond metadata prevents an in-place rewrite (including a same-size
    // owner change) from inheriting a previously cached session envelope.
    const finalSignature = runFileMetadataSignature(fstatSync(fd, { bigint: true }));
    if (finalSignature !== signature) return { found: false, ownership: "unknown", reason: "file_changed_during_scan" };
    // Aggregate exhaustion belongs to this query's shared budget, not the
    // immutable run file. Caching it would poison later better-funded reads.
    if (!String(result.reason || "").startsWith("aggregate_")) {
      cacheRunStart(identity, { signature, result });
    }
    return result;
  } catch {
    // A stale/corrupt index entry must not make the whole monitor unavailable.
    return { found: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function runFileMetadataSignature(stat) {
  return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function cacheRunStart(identity, entry) {
  runStartCache.delete(identity);
  runStartCache.set(identity, entry);
  while (runStartCache.size > RUN_START_CACHE_MAX_ENTRIES) runStartCache.delete(runStartCache.keys().next().value);
}

function touchRunStartCache(identity, entry) {
  runStartCache.delete(identity);
  runStartCache.set(identity, entry);
}

function restoreRunStartMetadata(summary, budget, { verify = false } = {}) {
  if (!summary?.runId) return summary;
  // Catalog records are a compact pre-filter accelerator. Visible/final
  // results bypass the catalog and verify the immutable sidecar or legacy log.
  const start = runStartEnvelope(summary.runId, budget, { skipCatalog: verify });
  summary.workflowStartResolved = start.found;
  summary.workflowStartCwdPresent = start.found ? start.cwdPresent : undefined;
  if (start.found) {
    const projectedStart = summary.events?.find((event) =>
      event?.type === EVENT_TYPES.WORKFLOW_START && event.runId === summary.runId && event.eventId === start.eventId,
    );
    let source = projectedStart;
    const sidecarExists = verify && existsSync(runStartFileFor(summary.runId));
    if (verify) {
      // eventId is not an authenticity proof: a readable JSONL event can be
      // replayed later with changed fields. Final summaries always source every
      // public and security field from the authoritative bounded prefix.
      const fullStart = sidecarExists
        ? runStartEnvelope(summary.runId, budget, { skipCatalog: true, skipSidecar: true })
        : start;
      source = fullStart?.found && fullStart.eventId === start.eventId ? fullStart : undefined;
    }
    const sourceRecord = source ? startRecordFromEnvelope(source, summary.runId) : undefined;
    const sidecarMatches = !sidecarExists || (sourceRecord && JSON.stringify(startRecordFromEnvelope(start, summary.runId)) === JSON.stringify(sourceRecord));
    if (verify && (!source || !sidecarMatches)) {
      // A reservation sidecar alone is not a committed start, and every
      // security-relevant compact field must match the authoritative log.
      summary.workflowStartResolved = false;
      summary.workflowStartCwdPresent = undefined;
      summary.metadata = undefined;
      summary.cwd = undefined;
      summary.trigger = undefined;
      return summary;
    }
    // Preserve full public metadata/trigger values when a projected or bounded
    // run-prefix start matches the immutable reserved envelope. Compact catalog
    // data is used only during internal ownership preselection.
    source ||= start;
    summary.workflowStartCwdPresent = source.cwdPresent ?? Object.prototype.hasOwnProperty.call(source, "cwd");
    summary.metadata = source.metadata;
    if (summary.workflowStartCwdPresent) summary.cwd = normalizedRecordedCwd(source.cwd);
    else delete summary.cwd;
    summary.trigger = source.trigger;
    summary.workflow = source.workflow || summary.workflow;
    summary.startedAt = source.timestamp || summary.startedAt;
  } else {
    // Later records are not authoritative evidence that a run was unowned or
    // launched from their cwd. Remove both values so display and scope agree.
    summary.metadata = undefined;
    summary.cwd = undefined;
    summary.trigger = undefined;
  }
  return summary;
}

export function getRunSummary(runId) {
  return restoreRunStartMetadata(projectRun(readRun(runId)), undefined, { verify: true });
}

export function latestRunSummaries({ limit = 20, cwd, workflow, readLimit = 5000, filter, ownershipFilter, ownershipReadBudgetBytes = DEFAULT_OWNERSHIP_READ_BUDGET_BYTES, ownershipFallbackScanLimit = DEFAULT_OWNERSHIP_FALLBACK_SCAN_LIMIT, ownershipSidecarReadBudgetBytes = DEFAULT_OWNERSHIP_SIDECAR_READ_BUDGET_BYTES, ownershipSidecarScanLimit = DEFAULT_OWNERSHIP_SIDECAR_SCAN_LIMIT } = {}) {
  // Ownership and other authoritative fields may only be available from the
  // bounded run-prefix lookup. Restore them before applying a caller filter,
  // then enforce the result limit. This lets session-scoped callers fill their
  // requested limit from visible runs instead of letting newer foreign runs
  // consume a global pre-filter candidate limit.
  const runs = projectRuns(readIndex({ limit: readLimit, cwd, workflow }));
  const maxResults = positiveInteger(limit, 20);
  if (maxResults === 0) return [];
  const makeBudget = () => ({
    remainingBytes: positiveInteger(ownershipReadBudgetBytes, DEFAULT_OWNERSHIP_READ_BUDGET_BYTES),
    remainingScans: positiveInteger(ownershipFallbackScanLimit, DEFAULT_OWNERSHIP_FALLBACK_SCAN_LIMIT),
    remainingSidecarBytes: positiveInteger(ownershipSidecarReadBudgetBytes, DEFAULT_OWNERSHIP_SIDECAR_READ_BUDGET_BYTES),
    remainingSidecarScans: positiveInteger(ownershipSidecarScanLimit, DEFAULT_OWNERSHIP_SIDECAR_SCAN_LIMIT),
  });
  const budget = makeBudget();
  const verificationBudget = makeBudget();
  if (typeof filter !== "function" && typeof ownershipFilter !== "function") {
    return runs.slice(0, maxResults).map((run) => restoreRunStartMetadata(run, verificationBudget, { verify: true }));
  }
  const visible = [];
  for (const run of runs) {
    const provisional = typeof ownershipFilter === "function"
      ? restoreRunStartMetadata(run, budget)
      : run;
    if (typeof ownershipFilter === "function" && !ownershipFilter(provisional)) continue;
    const verified = restoreRunStartMetadata(run, verificationBudget, { verify: true });
    if (typeof ownershipFilter === "function" && !verified.workflowStartResolved) continue;
    if (typeof ownershipFilter === "function" && !ownershipFilter(verified)) continue;
    // Public filters see the fully restored summary exactly once. Internal
    // ownershipFilter may run twice because compact catalog data is untrusted.
    if (typeof filter === "function" && !filter(verified)) continue;
    visible.push(verified);
    if (visible.length >= maxResults) break;
  }
  return visible;
}

// Backward-compatible alias for the original projected run helper.
export function latestRuns(options = {}) {
  return latestRunSummaries(options);
}

export function formatUsageSummary(usage) {
  if (!usage || typeof usage !== "object" || !usage.entries) return "";
  const parts = [];
  if (typeof usage.inputTokens === "number" && usage.inputTokens > 0) parts.push(`${formatNumber(usage.inputTokens)} in`);
  if (typeof usage.outputTokens === "number" && usage.outputTokens > 0) parts.push(`${formatNumber(usage.outputTokens)} out`);
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0 && parts.length === 0) parts.push(`${formatNumber(usage.totalTokens)} tok`);
  if (typeof usage.reasoningTokens === "number" && usage.reasoningTokens > 0) parts.push(`${formatNumber(usage.reasoningTokens)} reasoning`);
  if (typeof usage.cachedInputTokens === "number" && usage.cachedInputTokens > 0) parts.push(`${formatNumber(usage.cachedInputTokens)} cached`);
  const models = usage.models && typeof usage.models === "object" ? Object.keys(usage.models).filter(Boolean) : [];
  const modelPart = models.length === 1 ? ` · ${models[0]}` : models.length > 1 ? ` · ${models.length} models` : "";
  return parts.length ? `${parts.join(" / ")}${modelPart}` : `${usage.entries} usage event${usage.entries === 1 ? "" : "s"}${modelPart}`;
}

export function readArtifactContent(artifact, { maxBytes = 500_000 } = {}) {
  if (!artifact) return undefined;
  if (typeof artifact.content === "string") return compactText(artifact.content, maxBytes);
  if (!artifact.path) return undefined;
  const fd = openSync(artifact.path, "r");
  try {
    const size = fstatSync(fd).size;
    const bytesToRead = Math.min(size, maxBytes + 1);
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0);
    const content = buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8");
    return { content, truncated: size > maxBytes || bytesRead > maxBytes, bytes: size };
  } finally {
    closeSync(fd);
  }
}

export function normalizeStatus(status) {
  const value = normalizeStatusValue(status);
  if (!value) return STATUSES.UNKNOWN;
  if (KNOWN_STATUSES.has(value)) return value;
  return STATUS_ALIASES.get(value) || STATUSES.UNKNOWN;
}

function normalizeOwnerMetadata(metadata, cwd, trigger) {
  if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) return metadata;
  const owner = { ...(metadata || {}) };
  if (!owner.launchSource && typeof trigger?.kind === "string" && trigger.kind) owner.launchSource = trigger.kind;
  // The normalized run cwd is authoritative. Legacy absolute owner metadata can
  // be retained when no run cwd exists, but a relative metadata path has no
  // trustworthy origin and must not be guessed relative to this process.
  const launchCwd = canonicalCwd(cwd)
    || (typeof owner.cwdAtLaunch === "string" && isAbsolute(owner.cwdAtLaunch) ? canonicalCwd(owner.cwdAtLaunch) : undefined);
  if (launchCwd) owner.cwdAtLaunch = launchCwd;
  else delete owner.cwdAtLaunch;
  return Object.keys(owner).length ? owner : undefined;
}

function normalizeWorkflowName(workflow) {
  const value = String(workflow || "workflow").trim();
  if (!value) return "workflow";
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
}

function normalizeEventType(type) {
  const value = String(type || EVENT_TYPES.PHASE_EVENT);
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_");
}

function normalizeStatusValue(status) {
  const value = String(status || "").trim().toLowerCase();
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_") || undefined;
}

function upsertPhase(summary, phaseName, patch) {
  const existing = summary.phaseMap[phaseName] || { phase: phaseName, eventCount: 0 };
  Object.assign(existing, patch);
  summary.phaseMap[phaseName] = existing;
  return existing;
}

function extractProgress(data) {
  if (!data || typeof data !== "object") return undefined;
  const kind = data.kind || data.type;
  if (kind !== "progress") return undefined;
  const current = data.current ?? data.completed ?? data.done;
  const total = data.total;
  const percent = typeof data.percent === "number"
    ? data.percent
    : typeof current === "number" && typeof total === "number" && total > 0
      ? current / total
      : undefined;
  return dropUndefined({ current, total, percent, message: data.message });
}

function extractHeartbeat(data, event) {
  if (!data || typeof data !== "object") return undefined;
  const kind = data.kind || data.type;
  if (kind !== "heartbeat") return undefined;
  return dropUndefined({
    timestamp: event.timestamp,
    pid: data.pid,
    childPids: Array.isArray(data.childPids) ? data.childPids : undefined,
    phase: event.phase,
    message: data.message,
    milestoneId: data.milestoneId,
    featureId: data.featureId,
    validator: data.validator,
    branch: data.branch,
    worktree: data.worktree,
  });
}

function mergeActiveIo(previous, next) {
  if (!previous) return next;
  if (!next) return previous;
  if (!previous.componentId || !next.componentId || previous.componentId !== next.componentId) return next;
  return dropUndefined({
    ...previous,
    ...next,
    inputPreview: next.inputPreview !== undefined ? next.inputPreview : previous.inputPreview,
    command: next.command !== undefined ? next.command : previous.command,
    cwd: next.cwd !== undefined ? next.cwd : previous.cwd,
  });
}

function extractActiveIo(data, event) {
  if (!data || typeof data !== "object") return undefined;
  const kind = data.kind || data.type;
  if (kind !== "active_io") return undefined;
  return dropUndefined({
    schema: data.schema || "thread-phase-active-io/v1",
    timestamp: event.timestamp,
    updatedAt: data.updatedAt || event.timestamp,
    phase: event.phase,
    componentId: data.componentId,
    component: data.component,
    role: data.role,
    status: data.status,
    pid: data.pid,
    cwd: data.cwd,
    command: data.command,
    inputPreview: data.inputPreview,
    outputPreview: data.outputPreview,
    stdoutPreview: data.stdoutPreview,
    stderrPreview: data.stderrPreview,
    inputBytes: data.inputBytes,
    outputBytes: data.outputBytes,
    stdoutBytes: data.stdoutBytes,
    stderrBytes: data.stderrBytes,
    truncated: data.truncated,
    message: data.message,
  });
}

function projectionReferenceTime(value) {
  if (value === undefined) return Date.now();
  const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number(value);
  return Number.isFinite(time) ? time : Date.now();
}

function detectStaleRun(summary, referenceTime) {
  const checkedAt = new Date(referenceTime).toISOString();
  const pid = summary.metadata?.pid;
  if (typeof pid === "number" && !isPidAlive(pid)) return { reason: "pid_not_running", pid, checkedAt };
  if (summary.heartbeat?.timestamp) {
    const ageMs = referenceTime - Date.parse(summary.heartbeat.timestamp);
    if (Number.isFinite(ageMs) && ageMs > 5 * 60 * 1000) return { reason: "heartbeat_stale", ageMs, checkedAt };
  }
  return undefined;
}

function processStartToken(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[19] || undefined; // Linux /proc stat field 22.
  } catch {
    return undefined;
  }
}

function isPidAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function isWriterAlive(pid, expectedStartToken) {
  if (!isPidAlive(pid)) return false;
  const actual = processStartToken(pid);
  // On platforms without process-start identity, conservatively preserve a
  // live PID. Linux additionally rejects PID reuse by comparing start ticks.
  return !actual || !expectedStartToken || expectedStartToken === "unknown" || actual === String(expectedStartToken);
}

function markerWriterActive(file, pid, startToken) {
  if (pid === process.pid && String(startToken) === PROCESS_START_TOKEN) return ACTIVE_PENDING_MARKERS.has(file);
  return isWriterAlive(pid, startToken);
}

function emptyUsageSummary() {
  return {
    entries: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    fields: {},
    models: {},
  };
}

function applyUsageEvent(summary, phase, data, event) {
  const entries = extractUsageEntries(data);
  if (!entries.length) return;
  phase.usage ||= emptyUsageSummary();
  for (const entry of entries) {
    const model = entry.model || data.model || event.data?.model;
    addUsage(summary.usage, entry.usage, model);
    addUsage(phase.usage, entry.usage, model);
    if (data.item !== undefined || data.itemId !== undefined || data.index !== undefined) {
      applyFanoutUsage(phase, data, entry.usage, model);
    }
  }
}

function extractUsageEntries(data) {
  if (!data || typeof data !== "object") return [];
  const kind = data.kind || data.type;
  if (kind !== "usage" && data.usage === undefined) return [];
  const raw = data.usage ?? data;
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .map((value) => value?.message?.usage ? { usage: value.message.usage, model: value.message.model || value.model } : { usage: value, model: value?.model })
    .filter((entry) => entry.usage && typeof entry.usage === "object");
}

function addUsage(target, usage, model) {
  target.entries += 1;
  const input = numberFrom(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens);
  const output = numberFrom(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens);
  const total = numberFrom(usage.total_tokens, usage.totalTokens) ?? ((input || 0) + (output || 0) || undefined);
  const cached = numberFrom(usage.cache_read_input_tokens, usage.cached_input_tokens, usage.cachedInputTokens, usage.input_token_details?.cached_tokens, usage.prompt_tokens_details?.cached_tokens);
  const cacheCreation = numberFrom(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens);
  const reasoning = numberFrom(usage.output_token_details?.reasoning_tokens, usage.completion_tokens_details?.reasoning_tokens, usage.reasoning_tokens, usage.reasoningTokens);
  if (input) target.inputTokens += input;
  if (output) target.outputTokens += output;
  if (total) target.totalTokens += total;
  if (cached) target.cachedInputTokens += cached;
  if (cacheCreation) target.cacheCreationInputTokens += cacheCreation;
  if (reasoning) target.reasoningTokens += reasoning;
  addNumericFields(target.fields, usage);
  if (model) {
    const key = String(model);
    target.models[key] ||= emptyUsageSummary();
    addUsage(target.models[key], { ...usage, model: undefined }, undefined);
  }
}

function applyFanoutUsage(phase, data, usage, model) {
  const itemId = String(data.itemId ?? data.item ?? data.label ?? data.index ?? "item");
  const item = phase._fanoutItemMap?.[itemId];
  if (!item) return;
  item.usage ||= emptyUsageSummary();
  if (model) item.model = String(model);
  addUsage(item.usage, usage, model);
}

function addNumericFields(fields, value, prefix = "") {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "model") continue;
    const name = normalizeFieldName(prefix ? `${prefix}.${key}` : key);
    if (typeof nested === "number" && Number.isFinite(nested)) fields[name] = (fields[name] || 0) + nested;
    else if (nested && typeof nested === "object" && !Array.isArray(nested)) addNumericFields(fields, nested, name);
  }
}

function numberFrom(...values) {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function normalizeFieldName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.:-]+/g, "_");
}

function formatNumber(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function applyFanoutEvent(phase, data, event) {
  if (!data || typeof data !== "object") return;
  const kind = data.kind || data.type;
  if (!String(kind || "").startsWith("fanout")) return;

  phase.fanout ||= { total: undefined, completed: 0, failed: 0, running: 0, items: [] };
  phase._fanoutItemMap ||= {};

  if (kind === "fanout_start") {
    if (typeof data.total === "number") phase.fanout.total = data.total;
    phase.fanout.label = data.label || phase.fanout.label;
    return;
  }

  const itemId = String(data.itemId ?? data.id ?? data.label ?? data.index ?? "item");
  const item = phase._fanoutItemMap[itemId] || {
    itemId,
    label: data.label || itemId,
    index: data.index,
    startedAt: event.timestamp,
    status: STATUSES.RUNNING,
    normalizedStatus: STATUSES.RUNNING,
    lastMessage: data.message,
  };
  item.label = data.label || item.label;
  item.index = data.index ?? item.index;
  if (data.model) item.model = String(data.model);
  item.updatedAt = event.timestamp;
  item.lastMessage = data.message || item.lastMessage;

  if (kind === "fanout_item_start") {
    item.startedAt ||= event.timestamp;
    item.status = data.status || STATUSES.RUNNING;
    item.normalizedStatus = normalizeStatus(item.status);
  } else if (kind === "fanout_item_end") {
    item.endedAt = event.timestamp;
    item.status = data.status || STATUSES.SUCCESS;
    item.normalizedStatus = normalizeStatus(item.status);
    item.error = data.error;
  }
  phase._fanoutItemMap[itemId] = item;
}

function finalizeFanout(phase) {
  if (!phase.fanout) return;
  const items = Object.values(phase._fanoutItemMap || {}).sort((a, b) => {
    if (typeof a.index === "number" && typeof b.index === "number") return a.index - b.index;
    return String(a.startedAt || "").localeCompare(String(b.startedAt || ""));
  });
  const completed = items.filter((item) => item.normalizedStatus === STATUSES.SUCCESS || item.normalizedStatus === STATUSES.SKIPPED).length;
  const failed = items.filter((item) => item.normalizedStatus === STATUSES.FAILED).length;
  const running = items.filter((item) => item.normalizedStatus === STATUSES.RUNNING).length;
  phase.fanout.items = items;
  phase.fanout.completed = completed;
  phase.fanout.failed = failed;
  phase.fanout.running = running;
  phase.fanout.total ||= items.length;
  delete phase._fanoutItemMap;
}

function compactText(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { content: text, truncated: false };
  let out = text.slice(0, maxBytes);
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return { content: out, truncated: true, bytes: Buffer.byteLength(text, "utf8") };
}

function dropUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

function serializeError(error) {
  if (!error) return undefined;
  if (typeof error === "string") return { message: error };
  return {
    name: error.name,
    message: error.message || String(error),
    stack: error.stack,
    code: error.code,
  };
}
