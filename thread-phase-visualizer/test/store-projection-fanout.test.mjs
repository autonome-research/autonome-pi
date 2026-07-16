import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-fanout-projection-store-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
const store = await import(`../lib/store.mjs?projection-fanout=${Date.now()}`);

test.after(() => rmSync(storeDir, { recursive: true, force: true }));

const envelope = {
  schema: store.SCHEMA_VERSION,
  runId: "fanout-projection-run",
  workflow: "projection-test",
  type: store.EVENT_TYPES.PHASE_EVENT,
  phase: "review",
};

function fanoutEvent(eventId, seconds, data) {
  return {
    ...envelope,
    eventId,
    timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, seconds)).toISOString(),
    data,
  };
}

test("projectRun tracks fanout items from start through completed, failed, and running summaries", () => {
  const events = [
    fanoutEvent("fanout-start", 1, { kind: "fanout_start", total: 3, label: "files" }),
    fanoutEvent("item-a-start", 2, { kind: "fanout_item_start", itemId: "a", label: "A", index: 0 }),
    fanoutEvent("item-b-start", 3, { kind: "fanout_item_start", itemId: "b", label: "B", index: 1 }),
    fanoutEvent("item-a-end", 4, { kind: "fanout_item_end", itemId: "a", status: "passed", message: "reviewed" }),
    fanoutEvent("item-b-end", 5, { kind: "fanout_item_end", itemId: "b", status: "error", error: "review failed" }),
    fanoutEvent("item-c-start", 6, { kind: "fanout_item_start", itemId: "c", label: "C", index: 2 }),
  ];

  const started = store.projectRun(events.slice(0, 3)).phases[0].fanout;
  assert.deepEqual(
    { total: started.total, completed: started.completed, failed: started.failed, running: started.running },
    { total: 3, completed: 0, failed: 0, running: 2 },
  );

  const projected = store.projectRun([...events].reverse());
  const fanout = projected.phases[0].fanout;
  assert.deepEqual(
    { label: fanout.label, total: fanout.total, completed: fanout.completed, failed: fanout.failed, running: fanout.running },
    { label: "files", total: 3, completed: 1, failed: 1, running: 1 },
  );
  assert.deepEqual(fanout.items.map((item) => item.itemId), ["a", "b", "c"]);
  assert.deepEqual(fanout.items.map((item) => item.normalizedStatus), [
    store.STATUSES.SUCCESS,
    store.STATUSES.FAILED,
    store.STATUSES.RUNNING,
  ]);
  assert.equal(fanout.items[0].lastMessage, "reviewed");
  assert.equal(fanout.items[1].error, "review failed");
  assert.equal(fanout.items[2].endedAt, undefined);
});

test("projectRun counts skipped item endings as completed and creates missing item starts", () => {
  const endOnly = fanoutEvent("item-end-only", 2, {
    kind: "fanout_item_end",
    itemId: "end-only",
    label: "End only",
    index: 0,
    status: store.STATUSES.SKIPPED,
  });

  const fanout = store.projectRun([
    fanoutEvent("fanout-start-empty", 1, { kind: "fanout_start", total: 1 }),
    endOnly,
  ]).phases[0].fanout;

  assert.deepEqual(
    { total: fanout.total, completed: fanout.completed, failed: fanout.failed, running: fanout.running },
    { total: 1, completed: 1, failed: 0, running: 0 },
  );
  assert.equal(fanout.items[0].startedAt, endOnly.timestamp);
  assert.equal(fanout.items[0].endedAt, endOnly.timestamp);
  assert.equal(fanout.items[0].normalizedStatus, store.STATUSES.SKIPPED);
});
