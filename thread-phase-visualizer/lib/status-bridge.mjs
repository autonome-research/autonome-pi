import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const STATUS_BRIDGE_SCHEMA = "autonome.workflow-status.snapshot/v1";
export const STATUS_BRIDGE_LEASE_SCHEMA = "autonome.workflow-status.lease/v1";
export const STATUS_BRIDGE_RECENT_TERMINAL_MS = 60_000;
export const STATUS_BRIDGE_LEASE_RENEW_MS = 15_000;
export const STATUS_BRIDGE_LEASE_TTL_MS = 45_000;
export const STATUS_BRIDGE_SOURCE_FRESH_MS = 30_000;
export const STATUS_BRIDGE_INDEX_EVENT_LIMIT = 8_000;
export const STATUS_BRIDGE_RUN_LIMIT = 256;
export const STATUS_BRIDGE_ITEM_LIMIT = 64;
export const STATUS_BRIDGE_PUBLISHER_LIMIT = 256;
export const STATUS_BRIDGE_SNAPSHOT_MAX_BYTES = 16 * 1024;
export const STATUS_BRIDGE_LEASE_MAX_BYTES = 2 * 1024;
export const STATUS_BRIDGE_FUTURE_SKEW_MS = 5_000;

const STATUS_BRIDGE_PUBLISHER_ID_ATTEMPTS = 16;
const SCOPE_ID_BYTES = 32;
const PUBLISHER_ID_BYTES = 16;
const WORKFLOW_ID_BYTES = 32;
const TERMINAL_OUTCOMES = new Set(["success", "failure", "cancelled", "unknown"]);
const TERMINAL_STATES = new Set(["success", "failure", "cancelled", "unknown-terminal"]);

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function hashOpaque(prefix, value) {
  return `${prefix}${base64url(createHash("sha256").update(value).digest())}`;
}

export function deriveStatusBridgeScopeId(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) throw new Error("A non-empty Pi session ID is required");
  return hashOpaque("s1_", `autonome-workflow-status\0${sessionId}`);
}

export function deriveStatusBridgeWorkflowId(sessionId, rawRunId) {
  if (typeof sessionId !== "string" || !sessionId || typeof rawRunId !== "string" || !rawRunId) {
    throw new Error("Non-empty session and run IDs are required");
  }
  return hashOpaque("w1_", `autonome-workflow\0${sessionId}\0${rawRunId}`);
}

export function statusBridgeRootFromEnv(env = process.env) {
  if (env.PI_THREAD_PHASE_STATUS_BRIDGE_DIR !== undefined) {
    const root = String(env.PI_THREAD_PHASE_STATUS_BRIDGE_DIR);
    return isAbsolute(root) ? root : undefined;
  }
  const store = env.PI_THREAD_PHASE_STORE_DIR
    ? String(env.PI_THREAD_PHASE_STORE_DIR)
    : join(env.PI_CODING_AGENT_DIR ? String(env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent"), "thread-phase");
  return resolve(store, "status-bridge");
}

export function statusBridgeConfiguration(env = process.env) {
  if (env.PI_THREAD_PHASE_STATUS_BRIDGE !== "1") return undefined;
  const root = statusBridgeRootFromEnv(env);
  return root ? { root } : undefined;
}

function iso(ms) {
  if (!Number.isFinite(ms)) throw new Error("Invalid status bridge clock");
  return new Date(ms).toISOString();
}

function timestampMs(value) {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  try {
    return new Date(parsed).toISOString() === value ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function ownObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeTerminalOutcome(status, normalizeStatus) {
  const normalized = typeof normalizeStatus === "function" ? normalizeStatus(status) : String(status || "").toLowerCase();
  if (normalized === "success") return "success";
  if (normalized === "failed") return "failure";
  if (normalized === "cancelled") return "cancelled";
  return "unknown";
}

function latestValidWorkflowEnd(run) {
  let latest;
  for (const event of run?.events || []) {
    if (event?.type !== "workflow_end") continue;
    const atMs = timestampMs(event.timestamp);
    if (atMs === undefined) continue;
    if (!latest || atMs > latest.atMs) latest = { event, atMs };
  }
  return latest;
}

function emptyCounts() {
  return {
    running: 0,
    unknownActive: 0,
    successRecent: 0,
    failureRecent: 0,
    cancelledRecent: 0,
    unknownTerminalRecent: 0,
  };
}

function observationMetadata(observedRuns, itemsTruncated) {
  return {
    kind: "bounded-tail",
    indexEventLimit: STATUS_BRIDGE_INDEX_EVENT_LIMIT,
    runLimit: STATUS_BRIDGE_RUN_LIMIT,
    itemLimit: STATUS_BRIDGE_ITEM_LIMIT,
    observedRuns,
    itemsTruncated,
  };
}

function unknownSemantic(reason) {
  return {
    source: { state: "unknown", reason },
    policy: { recentTerminalMs: STATUS_BRIDGE_RECENT_TERMINAL_MS, sourceFreshMs: STATUS_BRIDGE_SOURCE_FRESH_MS },
    observation: observationMetadata(0, false),
    counts: emptyCounts(),
    workflows: [],
  };
}

/** Project only already-verified, session-owned summaries into the text-free v1 contract. */
export function projectWorkflowStatusV1(runs, {
  sessionId,
  nowMs = Date.now(),
  normalizeStatus,
} = {}) {
  if (typeof sessionId !== "string" || !sessionId) throw new Error("A non-empty Pi session ID is required");
  const owned = (Array.isArray(runs) ? runs : []).filter((run) =>
    run?.workflowStartResolved === true
    && run?.metadata?.sessionId === sessionId
    && typeof run?.runId === "string"
    && run.runId,
  ).slice(0, STATUS_BRIDGE_RUN_LIMIT);
  const counts = emptyCounts();
  const candidates = [];
  let latestTerminal;

  for (const run of owned) {
    const id = deriveStatusBridgeWorkflowId(sessionId, run.runId);
    const terminal = latestValidWorkflowEnd(run);
    if (terminal) {
      const outcome = normalizeTerminalOutcome(terminal.event.status, normalizeStatus);
      const age = nowMs - terminal.atMs;
      const recent = age >= 0 && age < STATUS_BRIDGE_RECENT_TERMINAL_MS;
      if (!latestTerminal || terminal.atMs > latestTerminal.atMs) {
        latestTerminal = { workflowId: id, outcome, at: terminal.event.timestamp, recent, atMs: terminal.atMs };
      }
      if (recent) {
        if (outcome === "success") counts.successRecent++;
        else if (outcome === "failure") counts.failureRecent++;
        else if (outcome === "cancelled") counts.cancelledRecent++;
        else counts.unknownTerminalRecent++;
        candidates.push({ item: {
          id,
          state: outcome === "unknown" ? "unknown-terminal" : outcome,
          terminalAt: terminal.event.timestamp,
        }, sortAt: terminal.atMs, terminal: true });
      }
      continue;
    }

    const projected = run.normalizedStatus || run.status;
    const running = projected === "running" && !run.stale;
    if (running) counts.running++;
    else counts.unknownActive++;
    candidates.push({
      item: { id, state: running ? "running" : "unknown" },
      sortAt: timestampMs(run.updatedAt) ?? timestampMs(run.startedAt) ?? 0,
      terminal: false,
    });
  }

  candidates.sort((left, right) => right.sortAt - left.sortAt || Number(left.terminal) - Number(right.terminal) || left.item.id.localeCompare(right.item.id));
  const semantic = {
    source: { state: "current" },
    policy: { recentTerminalMs: STATUS_BRIDGE_RECENT_TERMINAL_MS, sourceFreshMs: STATUS_BRIDGE_SOURCE_FRESH_MS },
    observation: observationMetadata(owned.length, candidates.length > STATUS_BRIDGE_ITEM_LIMIT),
    counts,
    ...(latestTerminal ? { latestTerminal: {
      workflowId: latestTerminal.workflowId,
      outcome: latestTerminal.outcome,
      at: latestTerminal.at,
      recent: latestTerminal.recent,
    } } : {}),
    workflows: candidates.slice(0, STATUS_BRIDGE_ITEM_LIMIT).map(({ item }) => item),
  };
  return semantic;
}

function ensurePrivateDirectory(directory, { existingRoot = false } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Status bridge path is not a private directory");
  if (existingRoot) {
    if ((stat.mode & 0o077) !== 0) throw new Error("Existing status bridge root must not grant group/other access");
  } else chmodSync(directory, 0o700);
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function atomicWriteJson(file, value, maxBytes, randomBytes = nodeRandomBytes) {
  const content = Buffer.from(JSON.stringify(value));
  if (content.length > maxBytes) throw new Error("Status bridge JSON exceeds its v1 size bound");
  const directory = dirname(file);
  const temporary = join(directory, `.tmp-${base64url(randomBytes(12))}`);
  let descriptor;
  try {
    descriptor = openSync(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    let offset = 0;
    while (offset < content.length) offset += writeSync(descriptor, content, offset, content.length - offset);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function publisherPaths(root, scopeId, publisherId) {
  const scopeDirectory = join(root, "v1", "scopes", scopeId);
  const publishersDirectory = join(scopeDirectory, "publishers");
  const publisherDirectory = join(publishersDirectory, publisherId);
  return {
    scopeDirectory,
    publishersDirectory,
    publisherDirectory,
    snapshotFile: join(publisherDirectory, "snapshot.json"),
    leaseFile: join(publisherDirectory, "lease.json"),
  };
}

function removeEmpty(directory) {
  try { rmdirSync(directory); } catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error; }
}

function readDirectoryEntriesBounded(directory, limit) {
  const handle = opendirSync(directory);
  const entries = [];
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) return { entries, exceeded: false };
      if (entries.length === limit) return { entries, exceeded: true };
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
}

function readFixedJson(file, maxBytes) {
  let descriptor;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(maxBytes)) throw new Error("Invalid status bridge file");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error("Incomplete status bridge read");
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Status bridge file changed during read");
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function createStatusBridgePublisher({
  root,
  sessionId,
  now = Date.now,
  randomBytes = nodeRandomBytes,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  autoRenew = true,
  normalizeStatus,
} = {}) {
  if (!isAbsolute(String(root || ""))) throw new Error("Status bridge root must be absolute");
  const scopeId = deriveStatusBridgeScopeId(sessionId);
  const startedMs = now();
  const startedAt = iso(startedMs);
  const rootAlreadyExists = existsSync(root);
  ensurePrivateDirectory(root, { existingRoot: rootAlreadyExists });
  ensurePrivateDirectory(join(root, "v1"));
  ensurePrivateDirectory(join(root, "v1", "scopes"));
  const scopeDirectory = join(root, "v1", "scopes", scopeId);
  const publishersDirectory = join(scopeDirectory, "publishers");
  ensurePrivateDirectory(scopeDirectory);
  ensurePrivateDirectory(publishersDirectory);

  let publisherId;
  let paths;
  for (let attempt = 0; attempt < STATUS_BRIDGE_PUBLISHER_ID_ATTEMPTS; attempt++) {
    const allocationEntries = readDirectoryEntriesBounded(publishersDirectory, STATUS_BRIDGE_PUBLISHER_LIMIT);
    if (allocationEntries.exceeded || allocationEntries.entries.length >= STATUS_BRIDGE_PUBLISHER_LIMIT) {
      throw new Error("Status bridge publisher capacity reached; offline cleanup is required");
    }
    const candidateId = `p1_${base64url(randomBytes(PUBLISHER_ID_BYTES))}`;
    if (!validIdentity(candidateId, "p1_", PUBLISHER_ID_BYTES)) throw new Error("Invalid status bridge publisher randomness");
    const candidatePaths = publisherPaths(root, scopeId, candidateId);
    try {
      mkdirSync(candidatePaths.publisherDirectory, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    try {
      const stat = lstatSync(candidatePaths.publisherDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Status bridge publisher path is not a directory");
      chmodSync(candidatePaths.publisherDirectory, 0o700);
    } catch (error) {
      rmSync(candidatePaths.publisherDirectory, { recursive: true, force: true });
      throw error;
    }
    publisherId = candidateId;
    paths = candidatePaths;
    break;
  }
  if (!publisherId || !paths) throw new Error("Unable to allocate an exclusive status bridge publisher directory");

  const removeOwnedPublisher = () => {
    rmSync(paths.publisherDirectory, { recursive: true, force: true });
    removeEmpty(paths.publishersDirectory);
    removeEmpty(paths.scopeDirectory);
    removeEmpty(join(root, "v1", "scopes"));
    removeEmpty(join(root, "v1"));
  };

  let active = true;
  let revision = 0;
  let leaseRevision = 0;
  let changedAtMs = startedMs - 1;
  let sourceObservedAtMs;
  let semanticJson;
  let snapshot;
  let renewalTimer;

  const assertActive = () => {
    if (!active) throw new Error("Status bridge publisher is closed");
  };

  const writeLease = () => {
    assertActive();
    const renewedAtMs = now();
    const lease = {
      schema: STATUS_BRIDGE_LEASE_SCHEMA,
      version: 1,
      scopeId,
      publisherId,
      publisherStartedAt: startedAt,
      leaseRevision: ++leaseRevision,
      snapshotRevision: revision,
      renewedAt: iso(renewedAtMs),
      expiresAt: iso(renewedAtMs + STATUS_BRIDGE_LEASE_TTL_MS),
      ...(sourceObservedAtMs === undefined ? {} : { sourceObservedAt: iso(sourceObservedAtMs) }),
    };
    atomicWriteJson(paths.leaseFile, lease, STATUS_BRIDGE_LEASE_MAX_BYTES, randomBytes);
    return lease;
  };

  const publishSemantic = (semantic, successfulObservation) => {
    assertActive();
    const observedAt = now();
    const nextSemanticJson = JSON.stringify(semantic);
    if (nextSemanticJson === semanticJson) {
      if (successfulObservation) sourceObservedAtMs = observedAt;
      return snapshot;
    }
    revision++;
    changedAtMs = Math.max(observedAt, changedAtMs + 1);
    snapshot = {
      schema: STATUS_BRIDGE_SCHEMA,
      version: 1,
      scopeId,
      publisher: { id: publisherId, startedAt },
      revision,
      changedAt: iso(changedAtMs),
      ...semantic,
    };
    atomicWriteJson(paths.snapshotFile, snapshot, STATUS_BRIDGE_SNAPSHOT_MAX_BYTES, randomBytes);
    if (successfulObservation) sourceObservedAtMs = observedAt;
    semanticJson = nextSemanticJson;
    writeLease();
    return snapshot;
  };

  const publisher = {
    root,
    scopeId,
    publisherId,
    startedAt,
    paths,
    observe(runs) {
      return publishSemantic(projectWorkflowStatusV1(runs, { sessionId, nowMs: now(), normalizeStatus }), true);
    },
    markUnknown(reason = "store-read-failed") {
      if (!new Set(["initializing", "store-read-failed"]).has(reason)) throw new Error("Invalid status bridge unknown reason");
      return publishSemantic(unknownSemantic(reason), false);
    },
    renew() { return writeLease(); },
    currentSnapshot() { return snapshot; },
    close() {
      if (!active) return;
      active = false;
      if (renewalTimer) clearIntervalFn(renewalTimer);
      renewalTimer = undefined;
      removeOwnedPublisher();
    },
  };

  try {
    publisher.markUnknown("initializing");
    if (autoRenew) {
      renewalTimer = setIntervalFn(() => {
        if (!active) return;
        try { writeLease(); } catch { /* expiry makes publication unavailable */ }
      }, STATUS_BRIDGE_LEASE_RENEW_MS);
      renewalTimer?.unref?.();
    }
    return publisher;
  } catch (error) {
    active = false;
    if (renewalTimer) clearIntervalFn(renewalTimer);
    renewalTimer = undefined;
    removeOwnedPublisher();
    throw error;
  }
}

function validIdentity(value, prefix, byteLength) {
  if (typeof value !== "string" || !value.startsWith(prefix)) return false;
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return false;
  try {
    const decoded = Buffer.from(encoded, "base64url");
    return decoded.length === byteLength && base64url(decoded) === encoded;
  } catch {
    return false;
  }
}

function timestampNotFuture(value, nowMs) {
  const parsed = timestampMs(value);
  return parsed !== undefined && parsed <= nowMs + STATUS_BRIDGE_FUTURE_SKEW_MS;
}

function validateLease(value, { scopeId, publisherId, nowMs }) {
  if (!ownObject(value) || value.schema !== STATUS_BRIDGE_LEASE_SCHEMA || value.version !== 1
    || value.scopeId !== scopeId || value.publisherId !== publisherId
    || !validIdentity(value.scopeId, "s1_", SCOPE_ID_BYTES) || !validIdentity(value.publisherId, "p1_", PUBLISHER_ID_BYTES)
    || !positiveSafeInteger(value.leaseRevision) || !positiveSafeInteger(value.snapshotRevision)
    || !timestampNotFuture(value.publisherStartedAt, nowMs) || !timestampNotFuture(value.renewedAt, nowMs)) return undefined;
  const renewedAt = timestampMs(value.renewedAt);
  const expiresAt = timestampMs(value.expiresAt);
  if (renewedAt === undefined || expiresAt === undefined || expiresAt < renewedAt
    || expiresAt - renewedAt > STATUS_BRIDGE_LEASE_TTL_MS || nowMs > expiresAt) return undefined;
  if (value.sourceObservedAt !== undefined && !timestampNotFuture(value.sourceObservedAt, nowMs)) return undefined;
  return { value, renewedAt, expiresAt, startedAt: timestampMs(value.publisherStartedAt) };
}

function validateCounts(counts) {
  return ownObject(counts) && ["running", "unknownActive", "successRecent", "failureRecent", "cancelledRecent", "unknownTerminalRecent"]
    .every((key) => nonnegativeSafeInteger(counts[key]));
}

function validateSnapshot(value, { scopeId, publisherId, nowMs }) {
  if (!ownObject(value) || value.schema !== STATUS_BRIDGE_SCHEMA || value.version !== 1 || value.scopeId !== scopeId
    || !ownObject(value.publisher) || value.publisher.id !== publisherId || !validIdentity(value.publisher.id, "p1_", PUBLISHER_ID_BYTES)
    || !timestampNotFuture(value.publisher.startedAt, nowMs) || !positiveSafeInteger(value.revision)
    || !timestampNotFuture(value.changedAt, nowMs) || !validateCounts(value.counts)
    || !ownObject(value.policy) || value.policy.recentTerminalMs !== STATUS_BRIDGE_RECENT_TERMINAL_MS
    || value.policy.sourceFreshMs !== STATUS_BRIDGE_SOURCE_FRESH_MS || !ownObject(value.observation)
    || value.observation.kind !== "bounded-tail" || value.observation.indexEventLimit !== STATUS_BRIDGE_INDEX_EVENT_LIMIT
    || value.observation.runLimit !== STATUS_BRIDGE_RUN_LIMIT || value.observation.itemLimit !== STATUS_BRIDGE_ITEM_LIMIT
    || !nonnegativeSafeInteger(value.observation.observedRuns) || value.observation.observedRuns > STATUS_BRIDGE_RUN_LIMIT
    || typeof value.observation.itemsTruncated !== "boolean" || !Array.isArray(value.workflows)
    || value.workflows.length > STATUS_BRIDGE_ITEM_LIMIT) return false;
  if (!ownObject(value.source) || !["current", "unknown"].includes(value.source.state)) return false;
  if (value.source.state === "unknown") {
    if (!["initializing", "store-read-failed"].includes(value.source.reason) || value.latestTerminal !== undefined
      || value.workflows.length !== 0 || Object.values(value.counts).some((count) => count !== 0)
      || value.observation.observedRuns !== 0 || value.observation.itemsTruncated) return false;
  }
  const itemCounts = { running: 0, unknownActive: 0, successRecent: 0, failureRecent: 0, cancelledRecent: 0, unknownTerminalRecent: 0 };
  for (const workflow of value.workflows) {
    if (!ownObject(workflow) || !validIdentity(workflow.id, "w1_", WORKFLOW_ID_BYTES)) return false;
    if (["running", "unknown"].includes(workflow.state)) {
      if (workflow.terminalAt !== undefined) return false;
      itemCounts[workflow.state === "running" ? "running" : "unknownActive"]++;
    } else {
      if (!TERMINAL_STATES.has(workflow.state) || !timestampNotFuture(workflow.terminalAt, nowMs)) return false;
      const terminalMs = timestampMs(workflow.terminalAt);
      if (terminalMs === undefined || nowMs - terminalMs < 0 || nowMs - terminalMs >= STATUS_BRIDGE_RECENT_TERMINAL_MS) return false;
      const key = workflow.state === "success" ? "successRecent"
        : workflow.state === "failure" ? "failureRecent"
          : workflow.state === "cancelled" ? "cancelledRecent" : "unknownTerminalRecent";
      itemCounts[key]++;
    }
  }
  const representedCount = Object.values(value.counts).reduce((sum, count) => sum + count, 0);
  if (representedCount > value.observation.observedRuns
    || (value.observation.itemsTruncated && value.workflows.length !== STATUS_BRIDGE_ITEM_LIMIT)) return false;
  for (const key of Object.keys(itemCounts)) {
    if (value.observation.itemsTruncated ? itemCounts[key] > value.counts[key] : itemCounts[key] !== value.counts[key]) return false;
  }
  if (value.latestTerminal !== undefined) {
    const terminal = value.latestTerminal;
    if (!ownObject(terminal) || !validIdentity(terminal.workflowId, "w1_", WORKFLOW_ID_BYTES) || !TERMINAL_OUTCOMES.has(terminal.outcome)
      || !timestampNotFuture(terminal.at, nowMs) || typeof terminal.recent !== "boolean") return false;
    const age = nowMs - timestampMs(terminal.at);
    if (terminal.recent !== (age >= 0 && age < STATUS_BRIDGE_RECENT_TERMINAL_MS)) return false;
  }
  return true;
}

function unknown(reason) {
  return { state: "unknown", reason };
}

export function createStatusBridgeReader({ root, sessionId, scopeId: suppliedScopeId, now = Date.now } = {}) {
  const scopeId = suppliedScopeId || deriveStatusBridgeScopeId(sessionId);
  if (!isAbsolute(String(root || "")) || !validIdentity(scopeId, "s1_", SCOPE_ID_BYTES)) throw new Error("Absolute root and valid scope identity required");
  const highestRevisions = new Map();

  return {
    scopeId,
    read() {
      const nowMs = now();
      const publishersDirectory = join(root, "v1", "scopes", scopeId, "publishers");
      let entries;
      try {
        const directoryStat = lstatSync(publishersDirectory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return unknown("malformed-publishers-directory");
        const bounded = readDirectoryEntriesBounded(publishersDirectory, STATUS_BRIDGE_PUBLISHER_LIMIT);
        if (bounded.exceeded) return unknown("publisher-enumeration-exceeded");
        entries = bounded.entries;
      } catch {
        return unknown("no-live-publisher");
      }
      const live = [];
      for (const entry of entries) {
        if (!validIdentity(entry.name, "p1_", PUBLISHER_ID_BYTES) || !entry.isDirectory() || entry.isSymbolicLink()) return unknown("malformed-publisher-directory");
        const publisherDirectory = join(publishersDirectory, entry.name);
        try {
          const stat = lstatSync(publisherDirectory);
          if (!stat.isDirectory() || stat.isSymbolicLink()) return unknown("malformed-publisher-directory");
          const lease = validateLease(readFixedJson(join(publisherDirectory, "lease.json"), STATUS_BRIDGE_LEASE_MAX_BYTES), {
            scopeId,
            publisherId: entry.name,
            nowMs,
          });
          if (lease) live.push({ ...lease, publisherId: entry.name, publisherDirectory });
        } catch {
          // A malformed or expired lease is not a live publisher candidate.
        }
      }
      if (!live.length) return unknown("no-live-publisher");
      live.sort((left, right) => right.startedAt - left.startedAt || right.publisherId.localeCompare(left.publisherId));
      const selected = live[0];
      let selectedLease = selected;
      let snapshot;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) {
            selectedLease = validateLease(readFixedJson(join(selected.publisherDirectory, "lease.json"), STATUS_BRIDGE_LEASE_MAX_BYTES), {
              scopeId,
              publisherId: selected.publisherId,
              nowMs,
            });
            if (!selectedLease) break;
          }
          snapshot = readFixedJson(join(selected.publisherDirectory, "snapshot.json"), STATUS_BRIDGE_SNAPSHOT_MAX_BYTES);
          if (snapshot?.revision === selectedLease.value.snapshotRevision) break;
          snapshot = undefined;
        } catch { snapshot = undefined; }
      }
      if (!snapshot || !selectedLease || !validateSnapshot(snapshot, { scopeId, publisherId: selected.publisherId, nowMs })
        || snapshot.publisher.startedAt !== selectedLease.value.publisherStartedAt) return unknown("invalid-snapshot");
      if (snapshot.source.state !== "current") return unknown("source-unknown");
      const observedAt = timestampMs(selectedLease.value.sourceObservedAt);
      if (observedAt === undefined || nowMs - observedAt > STATUS_BRIDGE_SOURCE_FRESH_MS) return unknown("source-stale");
      const highest = highestRevisions.get(selected.publisherId);
      if (highest !== undefined && snapshot.revision < highest) return unknown("snapshot-rollback");
      highestRevisions.set(selected.publisherId, snapshot.revision);
      return { state: "current", snapshot, lease: selectedLease.value };
    },
  };
}
