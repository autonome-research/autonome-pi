import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const directory = mkdtempSync(join(tmpdir(), "pi-restored-stale-"));
const previousStore = process.env.PI_THREAD_PHASE_STORE_DIR;
process.env.PI_THREAD_PHASE_STORE_DIR = directory;
const store = await import("../lib/store.mjs");
test.after(() => {
  if (previousStore === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
  else process.env.PI_THREAD_PHASE_STORE_DIR = previousStore;
  rmSync(directory, { recursive: true, force: true });
});

test("large-log summaries recompute dead-owner proof after restoration using one projection clock", (t) => {
  const pid = 2_147_483_647;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const run = store.createRun({
    workflow: "large-dead-owner", cwd: directory,
    metadata: { pid, sessionId: "large-owner", processJournalVersion: 1 },
  });
  const recent = JSON.stringify({
    schema: store.SCHEMA_VERSION, runId: run.runId, workflow: "large-dead-owner",
    eventId: "recent-tail", timestamp: new Date().toISOString(),
    type: "phase_event", phase: "work", status: "running",
  });
  const record = recent + " ".repeat(4096 - Buffer.byteLength(recent)) + "\n";
  appendFileSync(run.runFile, record.repeat(2049));
  writeFileSync(store.INDEX_FILE, recent + "\n");
  const tail = store.readRun(run.runId);
  assert.equal(tail.some((event) => event.type === "workflow_start"), false);
  assert.equal(store.projectRun(tail).metadata, undefined);

  const referenceTime = Date.parse("2025-01-01T01:00:00.000Z");
  let clockCalls = 0;
  t.mock.method(Date, "now", () => referenceTime + clockCalls++);
  const summaries = [
    store.getRunSummary(run.runId),
    store.latestRunSummaries({ limit: 1, readLimit: 1 })[0],
    store.latestRunSummaries({
      limit: 1, readLimit: 1,
      ownershipFilter: (summary) => summary.metadata?.sessionId === "large-owner",
    })[0],
  ];
  for (const [index, summary] of summaries.entries()) {
    assert.equal(summary.workflowStartResolved, true);
    assert.equal(summary.metadata.pid, pid);
    assert.deepEqual(summary.stale, {
      reason: "pid_not_running", pid,
      checkedAt: new Date(referenceTime + index).toISOString(),
    });
  }
  assert.equal(clockCalls, 3, "each projection and its restorations must share one clock");
});
