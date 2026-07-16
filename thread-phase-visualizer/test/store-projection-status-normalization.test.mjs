import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-status-projection-store-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
const store = await import(`../lib/store.mjs?projection-status-normalization=${Date.now()}`);

test.after(() => rmSync(storeDir, { recursive: true, force: true }));

const envelope = {
  schema: store.SCHEMA_VERSION,
  runId: "status-normalization-run",
  workflow: "projection-test",
};

function event(eventId, seconds, type, status, overrides = {}) {
  return {
    ...envelope,
    eventId,
    timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, seconds)).toISOString(),
    type,
    status,
    ...overrides,
  };
}

test("projectRun preserves an unknown terminal status while normalizing it to unknown", () => {
  const events = [
    event("workflow-start", 0, store.EVENT_TYPES.WORKFLOW_START, store.STATUSES.RUNNING),
    event("phase-start", 1, store.EVENT_TYPES.PHASE_START, store.STATUSES.RUNNING, { phase: "deploy" }),
    event("workflow-end", 2, store.EVENT_TYPES.WORKFLOW_END, "timed_out"),
  ];

  const projected = store.projectRun(events);

  assert.equal(projected.status, "timed_out");
  assert.equal(projected.normalizedStatus, store.STATUSES.UNKNOWN);
  assert.notEqual(projected.normalizedStatus, store.STATUSES.SUCCESS);
  assert.equal(projected.phases[0].normalizedStatus, store.STATUSES.UNKNOWN);
  assert.equal(projected.phases[0].endedAt, events[2].timestamp);
});

test("normalizeStatus maps aliases and leaves unrecognized values unknown", () => {
  const cases = new Map([
    ["completed", store.STATUSES.SUCCESS],
    ["PASSED", store.STATUSES.SUCCESS],
    ["error", store.STATUSES.FAILED],
    ["failure", store.STATUSES.FAILED],
    ["canceled", store.STATUSES.CANCELLED],
    ["aborted", store.STATUSES.CANCELLED],
    ["in-progress", store.STATUSES.RUNNING],
    ["pending", store.STATUSES.RUNNING],
    ["future_terminal_state", store.STATUSES.UNKNOWN],
    [undefined, store.STATUSES.UNKNOWN],
  ]);

  for (const [status, expected] of cases) {
    assert.equal(store.normalizeStatus(status), expected, String(status));
  }

  const aliasEvents = [
    event("alias-start", 0, store.EVENT_TYPES.WORKFLOW_START, "in-progress"),
    event("alias-end", 1, store.EVENT_TYPES.WORKFLOW_END, "completed"),
  ];
  const projected = store.projectRun(aliasEvents);
  assert.equal(projected.status, "completed");
  assert.equal(projected.normalizedStatus, store.STATUSES.SUCCESS);
});
