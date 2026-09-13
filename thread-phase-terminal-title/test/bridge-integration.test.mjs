import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createStatusBridgePublisher,
  createStatusBridgeReader,
} from "../../thread-phase-visualizer/lib/status-bridge.mjs";
import { projectTerminalTitleState } from "../lib/terminal-title.mjs";

const roots = new Set();
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "thread-phase-title-bridge-"));
  roots.add(root);
  return root;
}
process.on("exit", () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function run(runId, sessionId, { endStatus, at = "2026-03-20T12:00:00.000Z", stale = false } = {}) {
  const events = [{ type: "workflow_start", timestamp: "2026-03-20T11:59:00.000Z", status: "running" }];
  if (endStatus !== undefined) events.push({ type: "workflow_end", timestamp: at, status: endStatus });
  return {
    runId,
    workflowStartResolved: true,
    metadata: { sessionId },
    normalizedStatus: endStatus === undefined ? "running" : endStatus,
    stale: stale || undefined,
    updatedAt: at,
    events,
  };
}

test("real bridge and fake clock enforce completion expiry and source freshness", () => {
  const root = tempRoot();
  const sessionId = "title-expiry";
  let clock = Date.parse("2026-03-20T12:00:00.000Z");
  const reader = createStatusBridgeReader({ root, sessionId, now: () => clock });
  assert.equal(projectTerminalTitleState(reader.read()), "attention", "no publisher must be unknown attention");

  const publisher = createStatusBridgePublisher({ root, sessionId, now: () => clock, autoRenew: false });
  const success = run("success", sessionId, { endStatus: "success" });
  clock += 59_999;
  publisher.observe([success]);
  publisher.renew();
  assert.equal(projectTerminalTitleState(reader.read()), "completed");

  clock += 1;
  // Even before the publisher's next observation, the exact boundary makes the
  // old terminal item invalid rather than extending the success display.
  publisher.renew();
  assert.equal(reader.read().state, "unknown");
  assert.equal(projectTerminalTitleState(reader.read()), "attention");
  publisher.observe([success]);
  assert.equal(projectTerminalTitleState(reader.read()), "idle");

  clock += 30_001;
  publisher.renew();
  assert.equal(reader.read().state, "unknown");
  assert.equal(projectTerminalTitleState(reader.read()), "attention", "stale source must not retain idle/known state");
  publisher.close();
});

test("mixed real outcomes retain cancellation and unknown distinctions while title shares attention", () => {
  const root = tempRoot();
  const sessionId = "title-mixed";
  const clock = Date.parse("2026-03-20T12:00:10.000Z");
  const publisher = createStatusBridgePublisher({ root, sessionId, now: () => clock, autoRenew: false });
  publisher.observe([
    run("running", sessionId),
    run("success", sessionId, { endStatus: "success", at: "2026-03-20T12:00:01.000Z" }),
    run("failure", sessionId, { endStatus: "failed", at: "2026-03-20T12:00:02.000Z" }),
    run("cancelled", sessionId, { endStatus: "cancelled", at: "2026-03-20T12:00:03.000Z" }),
    run("unknown-terminal", sessionId, { endStatus: "skipped", at: "2026-03-20T12:00:04.000Z" }),
    run("unknown-active", sessionId, { stale: true }),
  ]);
  const result = createStatusBridgeReader({ root, sessionId, now: () => clock }).read();
  assert.equal(result.state, "current");
  assert.deepEqual(result.snapshot.counts, {
    running: 1,
    unknownActive: 1,
    successRecent: 1,
    failureRecent: 1,
    cancelledRecent: 1,
    unknownTerminalRecent: 1,
  });
  assert.equal(result.snapshot.workflows.some((item) => item.state === "cancelled"), true);
  assert.equal(result.snapshot.workflows.some((item) => item.state === "failure"), true);
  assert.equal(projectTerminalTitleState(result), "attention");
  publisher.close();
});

test("malformed snapshots and rollback become unknown attention", () => {
  const root = tempRoot();
  const sessionId = "title-malformed";
  let clock = Date.parse("2026-03-20T12:00:00.000Z");
  const publisher = createStatusBridgePublisher({ root, sessionId, now: () => clock, autoRenew: false });
  publisher.observe([run("first", sessionId)]);
  const reader = createStatusBridgeReader({ root, sessionId, now: () => clock });
  assert.equal(projectTerminalTitleState(reader.read()), "active");
  const oldSnapshot = readFileSync(publisher.paths.snapshotFile);

  clock++;
  publisher.observe([]);
  assert.equal(projectTerminalTitleState(reader.read()), "idle");
  const lease = JSON.parse(readFileSync(publisher.paths.leaseFile, "utf8"));
  const rolled = JSON.parse(oldSnapshot);
  lease.snapshotRevision = rolled.revision;
  writeFileSync(publisher.paths.snapshotFile, oldSnapshot);
  writeFileSync(publisher.paths.leaseFile, JSON.stringify(lease));
  assert.deepEqual(reader.read(), { state: "unknown", reason: "snapshot-rollback" });
  assert.equal(projectTerminalTitleState(reader.read()), "attention");

  writeFileSync(publisher.paths.snapshotFile, "{");
  assert.equal(projectTerminalTitleState(reader.read()), "attention");
  publisher.close();
});
