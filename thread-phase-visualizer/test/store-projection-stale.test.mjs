import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-stale-projection-store-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
const store = await import(`../lib/store.mjs?projection-stale=${Date.now()}`);

test.after(() => rmSync(storeDir, { recursive: true, force: true }));

const now = Date.UTC(2025, 0, 1, 12, 0, 0);
const envelope = {
  schema: store.SCHEMA_VERSION,
  runId: "stale-projection-run",
  workflow: "projection-test",
};

function runningEvents(heartbeatAgeMs) {
  const timestamp = new Date(now - heartbeatAgeMs).toISOString();
  return [
    {
      ...envelope,
      eventId: "workflow-start",
      timestamp,
      type: store.EVENT_TYPES.WORKFLOW_START,
      status: store.STATUSES.RUNNING,
    },
    {
      ...envelope,
      eventId: "heartbeat",
      timestamp,
      type: store.EVENT_TYPES.PHASE_EVENT,
      phase: "worker",
      data: { kind: "heartbeat", message: "still working" },
    },
  ];
}

test("projectRun flags a running heartbeat older than five minutes as heartbeat_stale", () => {
  const projected = store.projectRun(runningEvents(5 * 60 * 1000 + 1), { referenceTime: now });

  assert.equal(projected.normalizedStatus, store.STATUSES.RUNNING);
  assert.equal(projected.stale?.reason, "heartbeat_stale");
  assert.equal(projected.stale?.ageMs, 5 * 60 * 1000 + 1);
  assert.equal(projected.stale?.checkedAt, new Date(now).toISOString());
});

test("projectRun does not flag a heartbeat at the five minute boundary as stale", () => {
  const projected = store.projectRun(runningEvents(5 * 60 * 1000), { referenceTime: now });

  assert.equal(projected.normalizedStatus, store.STATUSES.RUNNING);
  assert.equal(projected.stale, undefined);
});
