import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  STATUS_BRIDGE_ITEM_LIMIT,
  STATUS_BRIDGE_LEASE_MAX_BYTES,
  STATUS_BRIDGE_PUBLISHER_LIMIT,
  STATUS_BRIDGE_SNAPSHOT_MAX_BYTES,
  createStatusBridgePublisher,
  createStatusBridgeReader,
  deriveStatusBridgeScopeId,
  deriveStatusBridgeWorkflowId,
  projectWorkflowStatusV1,
  statusBridgeConfiguration,
} from "../lib/status-bridge.mjs";

const roots = new Set();
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "thread-phase-status-bridge-"));
  roots.add(root);
  return root;
}
process.on("exit", () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function normalizeStatus(status) {
  const value = String(status || "").toLowerCase();
  if (["failure", "fail", "error"].includes(value)) return "failed";
  if (["abort", "aborted", "canceled"].includes(value)) return "cancelled";
  if (["ok", "done", "complete"].includes(value)) return "success";
  return value;
}

function run(runId, sessionId, options = {}) {
  const at = options.at || "2026-03-20T12:00:00.000Z";
  const events = [{ type: "workflow_start", timestamp: "2026-03-20T11:59:00.000Z", status: "running" }, ...(options.events || [])];
  if (options.endStatus !== undefined) events.push({ type: "workflow_end", timestamp: at, status: options.endStatus });
  return {
    runId,
    workflowStartResolved: options.resolved ?? true,
    metadata: options.metadata ?? { sessionId },
    normalizedStatus: options.projectedStatus || (options.endStatus === undefined ? "running" : normalizeStatus(options.endStatus)),
    stale: options.stale,
    updatedAt: options.updatedAt || at,
    events,
    workflow: options.workflow || `secret-workflow-${runId}`,
    cwd: options.cwd || `/private/${runId}`,
    errors: options.errors,
  };
}

function assertNoForbiddenContent(value, forbidden) {
  const text = JSON.stringify(value);
  for (const item of forbidden) assert.equal(text.includes(item), false, `published private content: ${item}`);
  for (const key of ["runId", "workflow", "cwd", "prompt", "command", "error", "message", "path", "pid", "hostname", "model", "provider"]) {
    assert.equal(new RegExp(`"${key}"\\s*:`).test(text), false, `published forbidden field ${key}`);
  }
}

test("configuration is opt-in and requires an absolute override", () => {
  assert.equal(statusBridgeConfiguration({}), undefined);
  assert.equal(statusBridgeConfiguration({ PI_THREAD_PHASE_STATUS_BRIDGE: "0" }), undefined);
  assert.equal(statusBridgeConfiguration({ PI_THREAD_PHASE_STATUS_BRIDGE: "1", PI_THREAD_PHASE_STATUS_BRIDGE_DIR: "relative" }), undefined);
  assert.deepEqual(statusBridgeConfiguration({ PI_THREAD_PHASE_STATUS_BRIDGE: "1", PI_THREAD_PHASE_STATUS_BRIDGE_DIR: "/private/status" }), { root: "/private/status" });
});

test("opaque identity and aggregation preserve mixed outcomes without content", () => {
  const sessionId = "session-private-value";
  const nowMs = Date.parse("2026-03-20T12:00:30.000Z");
  const runs = [
    run("running-secret", sessionId),
    run("error-only-secret", sessionId, { projectedStatus: "failed", errors: [{ message: "abort command /secret" }] }),
    run("phase-failed-secret", sessionId, { projectedStatus: "failed", events: [{ type: "phase_end", timestamp: "2026-03-20T12:00:10.000Z", status: "failed" }] }),
    run("cancel-request-secret", sessionId, { projectedStatus: "running" }),
    run("success-secret", sessionId, { endStatus: "success", at: "2026-03-20T12:00:20.000Z" }),
    run("failure-secret", sessionId, { endStatus: "failed", at: "2026-03-20T12:00:25.000Z" }),
    run("cancelled-secret", sessionId, { endStatus: "cancelled", at: "2026-03-20T12:00:22.000Z" }),
    run("custom-secret", sessionId, { endStatus: "skipped", at: "2026-03-20T12:00:24.000Z" }),
    run("stale-secret", sessionId, { stale: { reason: "pid_not_running", pid: 99 } }),
    run("foreign-secret", "foreign-session"),
    run("unowned-secret", sessionId, { metadata: {} }),
    run("unresolved-secret", sessionId, { resolved: false }),
  ];
  const projected = projectWorkflowStatusV1(runs, { sessionId, nowMs, normalizeStatus });
  assert.deepEqual(projected.counts, {
    running: 2,
    unknownActive: 3,
    successRecent: 1,
    failureRecent: 1,
    cancelledRecent: 1,
    unknownTerminalRecent: 1,
  });
  assert.equal(projected.latestTerminal.outcome, "failure");
  assert.equal(projected.latestTerminal.at, "2026-03-20T12:00:25.000Z");
  assert.equal(projected.workflows.length, 9);
  assertNoForbiddenContent(projected, [sessionId, "running-secret", "secret-workflow", "/private/", "abort command"]);
  assert.equal(deriveStatusBridgeScopeId(sessionId), deriveStatusBridgeScopeId(sessionId));
  assert.equal(deriveStatusBridgeWorkflowId(sessionId, "running-secret"), deriveStatusBridgeWorkflowId(sessionId, "running-secret"));
  assert.notEqual(deriveStatusBridgeWorkflowId("another-session", "running-secret"), deriveStatusBridgeWorkflowId(sessionId, "running-secret"));
});

test("terminal recency expires exactly at 60 seconds and publisher revisions are semantic", () => {
  const root = tempRoot();
  const sessionId = "expiry-session";
  let clock = Date.parse("2026-03-20T12:00:59.999Z");
  const publisher = createStatusBridgePublisher({ root, sessionId, now: () => clock, autoRenew: false, normalizeStatus });
  const completed = run("historical-name", sessionId, { endStatus: "success", at: "2026-03-20T12:00:00.000Z" });
  const recent = publisher.observe([completed]);
  assert.equal(recent.counts.successRecent, 1);
  assert.equal(recent.latestTerminal.recent, true);
  const initialRevision = recent.revision;
  const initialChangedAt = recent.changedAt;

  publisher.renew();
  const afterRenew = JSON.parse(readFileSync(publisher.paths.snapshotFile, "utf8"));
  const leaseAfterRenew = JSON.parse(readFileSync(publisher.paths.leaseFile, "utf8"));
  assert.equal(afterRenew.revision, initialRevision);
  assert.equal(afterRenew.changedAt, initialChangedAt);
  assert.ok(leaseAfterRenew.leaseRevision > 1);

  clock = Date.parse("2026-03-20T12:01:00.000Z");
  const expired = publisher.observe([completed]);
  assert.equal(expired.revision, initialRevision + 1);
  assert.equal(expired.counts.successRecent, 0);
  assert.equal(expired.workflows.length, 0);
  assert.equal(expired.latestTerminal.recent, false);
  assert.ok(Date.parse(expired.changedAt) > Date.parse(initialChangedAt));

  clock -= 30_000;
  const changedBackward = publisher.observe([run("new-active", sessionId)]);
  assert.ok(Date.parse(changedBackward.changedAt) > Date.parse(expired.changedAt));
  publisher.close();
});

test("publisher starts historical terminals as expired and caps items without losing counters", () => {
  const sessionId = "bounded-session";
  const nowMs = Date.parse("2026-03-20T15:00:00.000Z");
  const historical = projectWorkflowStatusV1([
    run("old-success", sessionId, { endStatus: "success", at: "2026-03-20T12:00:00.000Z" }),
  ], { sessionId, nowMs, normalizeStatus });
  assert.equal(historical.counts.successRecent, 0);
  assert.equal(historical.latestTerminal.recent, false);
  assert.deepEqual(historical.workflows, []);

  const many = Array.from({ length: 300 }, (_, index) => run(`active-${index}-private`, sessionId));
  const projected = projectWorkflowStatusV1(many, { sessionId, nowMs, normalizeStatus });
  assert.equal(projected.counts.running, 256);
  assert.equal(projected.observation.observedRuns, 256);
  assert.equal(projected.workflows.length, STATUS_BRIDGE_ITEM_LIMIT);
  assert.equal(projected.observation.itemsTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < STATUS_BRIDGE_SNAPSHOT_MAX_BYTES);
});

test("unknown source clears all semantic state instead of carrying known state", () => {
  const root = tempRoot();
  let clock = Date.parse("2026-03-20T12:00:00.000Z");
  const publisher = createStatusBridgePublisher({ root, sessionId: "unknown-session", now: () => clock, autoRenew: false });
  const known = publisher.observe([run("known-private", "unknown-session")]);
  clock += 1;
  const unknown = publisher.markUnknown("store-read-failed");
  assert.equal(unknown.revision, known.revision + 1);
  assert.deepEqual(unknown.counts, {
    running: 0, unknownActive: 0, successRecent: 0, failureRecent: 0,
    cancelledRecent: 0, unknownTerminalRecent: 0,
  });
  assert.deepEqual(unknown.workflows, []);
  assert.equal(unknown.latestTerminal, undefined);
  publisher.close();
});

test("reader selects publishers deterministically and newer unknown prevents fallback", () => {
  const root = tempRoot();
  const sessionId = "selection-session";
  let clock = Date.parse("2026-03-20T12:00:00.000Z");
  const older = createStatusBridgePublisher({ root, sessionId, now: () => clock, autoRenew: false });
  older.observe([run("older-known", sessionId)]);
  clock += 1_000;
  const newer = createStatusBridgePublisher({ root, sessionId, now: () => clock, autoRenew: false });
  const reader = createStatusBridgeReader({ root, sessionId, now: () => clock });
  assert.deepEqual(reader.read(), { state: "unknown", reason: "source-unknown" });
  newer.observe([run("newer-known", sessionId)]);
  assert.equal(reader.read().snapshot.publisher.id, newer.publisherId);

  clock += 44_001;
  older.observe([run("older-known", sessionId)]);
  older.renew();
  clock += 1_000; // newer expires; the renewed older publisher remains live
  assert.equal(reader.read().snapshot.publisher.id, older.publisherId);
  newer.close();
  older.close();
});

test("reader fails closed for stale source, revision mismatch, rollback, malformed, oversized, and symlinked files", () => {
  const cases = ["stale", "mismatch", "malformed", "oversized", "symlink"];
  for (const kind of cases) {
    const root = tempRoot();
    const sessionId = `reader-${kind}`;
    let clock = Date.parse("2026-03-20T12:00:00.000Z");
    const publisher = createStatusBridgePublisher({ root, sessionId, now: () => clock, autoRenew: false });
    publisher.observe([run(`private-${kind}`, sessionId)]);
    const reader = createStatusBridgeReader({ root, sessionId, now: () => clock });
    assert.equal(reader.read().state, "current");
    if (kind === "stale") {
      clock += 30_001;
      publisher.renew();
    } else if (kind === "mismatch") {
      const lease = JSON.parse(readFileSync(publisher.paths.leaseFile, "utf8"));
      lease.snapshotRevision++;
      writeFileSync(publisher.paths.leaseFile, JSON.stringify(lease));
    } else if (kind === "malformed") {
      writeFileSync(publisher.paths.snapshotFile, "{");
    } else if (kind === "oversized") {
      writeFileSync(publisher.paths.snapshotFile, "x".repeat(STATUS_BRIDGE_SNAPSHOT_MAX_BYTES + 1));
    } else {
      rmSync(publisher.paths.snapshotFile);
      symlinkSync("lease.json", publisher.paths.snapshotFile);
    }
    assert.equal(reader.read().state, "unknown", kind);
    publisher.close();
  }

  const root = tempRoot();
  const sessionId = "rollback-session";
  let clock = Date.parse("2026-03-20T12:00:00.000Z");
  const publisher = createStatusBridgePublisher({ root, sessionId, now: () => clock, autoRenew: false });
  publisher.observe([run("first", sessionId)]);
  const oldSnapshot = readFileSync(publisher.paths.snapshotFile);
  clock++;
  publisher.observe([run("second", sessionId)]);
  const reader = createStatusBridgeReader({ root, sessionId, now: () => clock });
  assert.equal(reader.read().state, "current");
  const lease = JSON.parse(readFileSync(publisher.paths.leaseFile, "utf8"));
  const rolled = JSON.parse(oldSnapshot);
  lease.snapshotRevision = rolled.revision;
  writeFileSync(publisher.paths.snapshotFile, oldSnapshot);
  writeFileSync(publisher.paths.leaseFile, JSON.stringify(lease));
  assert.deepEqual(reader.read(), { state: "unknown", reason: "snapshot-rollback" });
  publisher.close();
});

test("parallel publishers use isolated fixed files and cleanup removes only self", () => {
  const root = tempRoot();
  const sessionId = "parallel-session";
  const now = () => Date.parse("2026-03-20T12:00:00.000Z");
  const first = createStatusBridgePublisher({ root, sessionId, now, autoRenew: false });
  const second = createStatusBridgePublisher({ root, sessionId, now, autoRenew: false });
  first.observe([run("first-private", sessionId)]);
  second.observe([run("second-private", sessionId)]);
  assert.notEqual(first.paths.publisherDirectory, second.paths.publisherDirectory);
  assert.deepEqual(readdirSync(first.paths.publisherDirectory).sort(), ["lease.json", "snapshot.json"]);
  assert.deepEqual(readdirSync(second.paths.publisherDirectory).sort(), ["lease.json", "snapshot.json"]);
  assert.equal(lstatSync(first.paths.publisherDirectory).mode & 0o777, 0o700);
  assert.equal(lstatSync(first.paths.snapshotFile).mode & 0o777, 0o600);
  first.close();
  assert.doesNotThrow(() => readFileSync(second.paths.snapshotFile));
  second.renew();
  second.close();
});

test("future timestamps and unknown schema versions fail closed", () => {
  for (const kind of ["future-lease", "future-snapshot", "unknown-major"]) {
    const root = tempRoot();
    const sessionId = `validation-${kind}`;
    const clock = Date.parse("2026-03-20T12:00:00.000Z");
    const publisher = createStatusBridgePublisher({ root, sessionId, now: () => clock, autoRenew: false });
    publisher.observe([run(`private-${kind}`, sessionId)]);
    if (kind === "future-lease") {
      const lease = JSON.parse(readFileSync(publisher.paths.leaseFile, "utf8"));
      lease.renewedAt = new Date(clock + 5_001).toISOString();
      lease.expiresAt = new Date(clock + 45_000).toISOString();
      writeFileSync(publisher.paths.leaseFile, JSON.stringify(lease));
    } else {
      const value = JSON.parse(readFileSync(publisher.paths.snapshotFile, "utf8"));
      if (kind === "future-snapshot") value.changedAt = new Date(clock + 5_001).toISOString();
      else { value.schema = "autonome.workflow-status.snapshot/v2"; value.version = 2; }
      writeFileSync(publisher.paths.snapshotFile, JSON.stringify(value));
    }
    assert.equal(createStatusBridgeReader({ root, sessionId, now: () => clock }).read().state, "unknown", kind);
    publisher.close();
  }
});

test("startup never deletes another publisher from timestamps or crash residue", () => {
  const root = tempRoot();
  const sessionId = "conservative-cleanup-session";
  let clock = Date.parse("2026-03-20T12:00:00.000Z");
  const stale = createStatusBridgePublisher({ root, sessionId, now: () => clock, autoRenew: false });
  stale.observe([]);
  const contradictoryLease = JSON.parse(readFileSync(stale.paths.leaseFile, "utf8"));

  const leaseLessId = `p1_${Buffer.alloc(16, 7).toString("base64url")}`;
  const leaseLessDirectory = join(stale.paths.publishersDirectory, leaseLessId);
  mkdirSync(leaseLessDirectory, { mode: 0o700 });
  writeFileSync(join(leaseLessDirectory, ".tmp-crash"), "partial", { mode: 0o600 });

  clock += 7 * 24 * 60 * 60 * 1000;
  contradictoryLease.renewedAt = new Date(clock).toISOString();
  contradictoryLease.expiresAt = "2026-03-20T12:00:45.000Z";
  writeFileSync(stale.paths.leaseFile, JSON.stringify(contradictoryLease));
  const replacement = createStatusBridgePublisher({ root, sessionId, now: () => clock, autoRenew: false });

  assert.equal(lstatSync(stale.paths.publisherDirectory).isDirectory(), true, "contradictory or stale lease authorized cross-owner deletion");
  assert.equal(readFileSync(stale.paths.leaseFile, "utf8"), JSON.stringify(contradictoryLease));
  assert.equal(readFileSync(join(leaseLessDirectory, ".tmp-crash"), "utf8"), "partial", "lease-less temp residue was deleted");
  replacement.close();
  stale.close();
  rmSync(leaseLessDirectory, { recursive: true, force: true });
});

test("publisher allocation is exclusive, retries collisions, and cleans only a failed new directory", () => {
  const root = tempRoot();
  const sessionId = "exclusive-allocation-session";
  const fixed = (byte) => (size) => Buffer.alloc(size, byte);
  const first = createStatusBridgePublisher({ root, sessionId, randomBytes: fixed(1), autoRenew: false });
  first.observe([]);
  const firstSnapshot = readFileSync(first.paths.snapshotFile, "utf8");

  let idCalls = 0;
  const retryingRandom = (size) => Buffer.alloc(size, size === 16 && idCalls++ === 0 ? 1 : 2);
  const second = createStatusBridgePublisher({ root, sessionId, randomBytes: retryingRandom, autoRenew: false });
  assert.notEqual(second.publisherId, first.publisherId);
  assert.equal(readFileSync(first.paths.snapshotFile, "utf8"), firstSnapshot, "collision overwrote the existing publisher");

  assert.throws(
    () => createStatusBridgePublisher({ root, sessionId, randomBytes: fixed(1), autoRenew: false }),
    /exclusive status bridge publisher directory/,
  );
  assert.equal(readFileSync(first.paths.snapshotFile, "utf8"), firstSnapshot, "bounded collision failure altered the owner");

  const failingRoot = tempRoot();
  const failingRandom = (size) => {
    if (size === 12) throw new Error("simulated initial temporary-write failure");
    return Buffer.alloc(size, 3);
  };
  assert.throws(
    () => createStatusBridgePublisher({ root: failingRoot, sessionId, randomBytes: failingRandom, autoRenew: false }),
    /simulated initial temporary-write failure/,
  );
  const failedPublisher = join(failingRoot, "v1", "scopes", deriveStatusBridgeScopeId(sessionId), "publishers", `p1_${Buffer.alloc(16, 3).toString("base64url")}`);
  assert.equal(existsSync(failedPublisher), false, "failed initial write retained its newly-created directory");

  second.close();
  first.close();
});

test("crash residue consumes bounded capacity and allocation fails closed without deleting it", () => {
  const root = tempRoot();
  const sessionId = "capacity-session";
  const owner = createStatusBridgePublisher({ root, sessionId, autoRenew: false });
  for (let index = 1; index < STATUS_BRIDGE_PUBLISHER_LIMIT; index++) {
    const directory = join(owner.paths.publishersDirectory, `.crash-residue-${index}`);
    mkdirSync(directory, { mode: 0o700 });
    if (index === 1) writeFileSync(join(directory, ".tmp-interrupted"), "partial", { mode: 0o600 });
  }
  const before = readdirSync(owner.paths.publishersDirectory).sort();
  assert.equal(before.length, STATUS_BRIDGE_PUBLISHER_LIMIT);
  assert.throws(
    () => createStatusBridgePublisher({ root, sessionId, autoRenew: false }),
    /capacity reached; offline cleanup is required/,
  );
  assert.deepEqual(readdirSync(owner.paths.publishersDirectory).sort(), before);
  owner.close();
});

test("reader requires exact opaque IDs and canonical ISO UTC timestamps", () => {
  for (const scopeId of ["s1_x", `s1_${"A".repeat(42)}B`]) {
    assert.throws(
      () => createStatusBridgeReader({ root: tempRoot(), scopeId }),
      /valid scope identity/,
    );
  }

  for (const kind of ["publisher-short", "publisher-noncanonical", "workflow-short", "workflow-noncanonical", "lease-time", "snapshot-time"]) {
    const root = tempRoot();
    const sessionId = `exact-reader-${kind}`;
    const clock = Date.parse("2026-03-20T12:00:00.000Z");
    const publisher = createStatusBridgePublisher({ root, sessionId, now: () => clock, autoRenew: false });
    publisher.observe([run(`private-${kind}`, sessionId)]);

    if (kind === "publisher-short" || kind === "publisher-noncanonical") {
      const invalidId = kind === "publisher-short" ? "p1_x" : `p1_${"A".repeat(21)}B`;
      const invalidDirectory = join(publisher.paths.publishersDirectory, invalidId);
      renameSync(publisher.paths.publisherDirectory, invalidDirectory);
      const leaseFile = join(invalidDirectory, "lease.json");
      const snapshotFile = join(invalidDirectory, "snapshot.json");
      const lease = JSON.parse(readFileSync(leaseFile, "utf8"));
      const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
      lease.publisherId = invalidId;
      snapshot.publisher.id = invalidId;
      writeFileSync(leaseFile, JSON.stringify(lease));
      writeFileSync(snapshotFile, JSON.stringify(snapshot));
    } else {
      const snapshot = JSON.parse(readFileSync(publisher.paths.snapshotFile, "utf8"));
      if (kind === "workflow-short") snapshot.workflows[0].id = "w1_x";
      if (kind === "workflow-noncanonical") snapshot.workflows[0].id = `w1_${"A".repeat(42)}B`;
      if (kind === "snapshot-time") snapshot.changedAt = "2026-03-20 12:00:00Z";
      writeFileSync(publisher.paths.snapshotFile, JSON.stringify(snapshot));
      if (kind === "lease-time") {
        const lease = JSON.parse(readFileSync(publisher.paths.leaseFile, "utf8"));
        lease.renewedAt = "2026-03-20 12:00:00Z";
        writeFileSync(publisher.paths.leaseFile, JSON.stringify(lease));
      }
    }

    assert.equal(createStatusBridgeReader({ root, sessionId, now: () => clock }).read().state, "unknown", kind);
    publisher.close();
  }
});

test("malformed lease and bounded publisher enumeration produce unknown", () => {
  const root = tempRoot();
  const sessionId = "malformed-lease-session";
  const publisher = createStatusBridgePublisher({ root, sessionId, autoRenew: false });
  publisher.observe([]);
  writeFileSync(publisher.paths.leaseFile, "x".repeat(STATUS_BRIDGE_LEASE_MAX_BYTES + 1));
  assert.equal(createStatusBridgeReader({ root, sessionId }).read().state, "unknown");
  publisher.close();

  const scopeId = deriveStatusBridgeScopeId("enumeration-session");
  const directory = join(root, "v1", "scopes", scopeId, "publishers");
  for (let index = 0; index < 257; index++) {
    const child = join(directory, `p1_${index}`);
    // Existing root remains private after the first publisher; create only test directories.
    mkdirSync(child, { recursive: true });
  }
  assert.deepEqual(createStatusBridgeReader({ root, scopeId }).read(), { state: "unknown", reason: "publisher-enumeration-exceeded" });
});
