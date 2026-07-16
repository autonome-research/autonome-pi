import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-active-io-projection-store-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
const store = await import(`../lib/store.mjs?projection-active-io=${Date.now()}`);

test.after(() => rmSync(storeDir, { recursive: true, force: true }));

const envelope = {
  schema: store.SCHEMA_VERSION,
  runId: "active-io-projection-run",
  workflow: "projection-test",
  type: store.EVENT_TYPES.PHASE_EVENT,
  phase: "agent",
};

function activeIoEvent(eventId, seconds, data) {
  return {
    ...envelope,
    eventId,
    timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, seconds)).toISOString(),
    data: { kind: "active_io", ...data },
  };
}

test("projectRun merges successive active I/O snapshots with the same componentId", () => {
  const projected = store.projectRun([
    activeIoEvent("latest", 2, {
      componentId: "agent-1",
      status: "running",
      outputPreview: "latest output",
      stdoutBytes: 20,
    }),
    activeIoEvent("initial", 1, {
      componentId: "agent-1",
      component: "worker agent",
      command: "pi run",
      inputPreview: "original input",
      stdoutBytes: 10,
    }),
  ]);

  assert.deepEqual(
    {
      componentId: projected.activeIo.componentId,
      component: projected.activeIo.component,
      command: projected.activeIo.command,
      inputPreview: projected.activeIo.inputPreview,
      outputPreview: projected.activeIo.outputPreview,
      status: projected.activeIo.status,
      stdoutBytes: projected.activeIo.stdoutBytes,
    },
    {
      componentId: "agent-1",
      component: "worker agent",
      command: "pi run",
      inputPreview: "original input",
      outputPreview: "latest output",
      status: "running",
      stdoutBytes: 20,
    },
  );
  assert.deepEqual(projected.phases[0].activeIo, projected.activeIo);
});

test("projectRun replaces active I/O state when componentId changes", () => {
  const replacement = activeIoEvent("replacement", 2, {
    componentId: "validator-1",
    component: "validator",
    outputPreview: "validator output",
  });
  const projected = store.projectRun([
    activeIoEvent("initial", 1, {
      componentId: "agent-1",
      component: "worker agent",
      command: "pi run",
      inputPreview: "worker input",
    }),
    replacement,
  ]);

  assert.equal(projected.activeIo.componentId, "validator-1");
  assert.equal(projected.activeIo.component, "validator");
  assert.equal(projected.activeIo.outputPreview, "validator output");
  assert.equal(projected.activeIo.command, undefined);
  assert.equal(projected.activeIo.inputPreview, undefined);
  assert.deepEqual(projected.phases[0].activeIo, projected.activeIo);
});
