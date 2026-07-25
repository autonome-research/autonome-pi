import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-projection-store-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
const store = await import(`../lib/store.mjs?projection-phase-lifecycle=${Date.now()}`);

test.after(() => rmSync(storeDir, { recursive: true, force: true }));

const envelope = {
  schema: store.SCHEMA_VERSION,
  runId: "phase-lifecycle-run",
  workflow: "projection-test",
};

function event(eventId, seconds, type, overrides = {}) {
  return {
    ...envelope,
    eventId,
    timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, seconds)).toISOString(),
    type,
    ...overrides,
  };
}

test("projectRun transitions a phase through start, event, and end", () => {
  const events = [
    event("workflow-start", 0, store.EVENT_TYPES.WORKFLOW_START, { status: store.STATUSES.RUNNING }),
    event("phase-start", 1, store.EVENT_TYPES.PHASE_START, {
      phase: "build",
      status: store.STATUSES.RUNNING,
      message: "build started",
      data: { type: "pi", model: "configured/model" },
    }),
    event("phase-progress", 2, store.EVENT_TYPES.PHASE_EVENT, {
      phase: "build",
      message: "halfway",
      data: { kind: "progress", completed: 1, total: 2 },
    }),
    event("phase-end", 3, store.EVENT_TYPES.PHASE_END, {
      phase: "build",
      status: "completed",
      message: "build completed",
    }),
  ];

  const started = store.projectRun(events.slice(0, 2)).phases[0];
  assert.equal(started.status, store.STATUSES.RUNNING);
  assert.equal(started.normalizedStatus, store.STATUSES.RUNNING);
  assert.equal(started.startedAt, events[1].timestamp);
  assert.equal(started.type, "pi");
  assert.equal(started.model, "configured/model");
  assert.equal(started.endedAt, undefined);
  assert.equal(started.eventCount, 0);

  const active = store.projectRun(events.slice(0, 3)).phases[0];
  assert.equal(active.normalizedStatus, store.STATUSES.RUNNING);
  assert.equal(active.updatedAt, events[2].timestamp);
  assert.equal(active.lastMessage, "halfway");
  assert.equal(active.eventCount, 1);
  assert.deepEqual(active.progress, {
    current: 1,
    total: 2,
    percent: 0.5,
  });

  const ended = store.projectRun(events).phases[0];
  assert.equal(ended.status, "completed");
  assert.equal(ended.normalizedStatus, store.STATUSES.SUCCESS);
  assert.equal(ended.startedAt, events[1].timestamp);
  assert.equal(ended.updatedAt, events[3].timestamp);
  assert.equal(ended.endedAt, events[3].timestamp);
  assert.equal(ended.lastMessage, "build completed");
  assert.equal(ended.eventCount, 1);
});

test("projectRun creates and ends a phase when lifecycle boundary events are missing", () => {
  const phaseEventOnly = event("implicit-event", 1, store.EVENT_TYPES.PHASE_EVENT, {
    phase: "implicit",
    message: "work observed",
  });
  const phaseEnd = event("implicit-end", 2, store.EVENT_TYPES.PHASE_END, {
    phase: "implicit",
    status: store.STATUSES.FAILED,
    message: "work failed",
  });

  const active = store.projectRun([phaseEventOnly]).phases[0];
  assert.equal(active.normalizedStatus, store.STATUSES.RUNNING);
  assert.equal(active.startedAt, phaseEventOnly.timestamp);
  assert.equal(active.eventCount, 1);

  const ended = store.projectRun([phaseEnd]).phases[0];
  assert.equal(ended.normalizedStatus, store.STATUSES.FAILED);
  assert.equal(ended.startedAt, phaseEnd.timestamp);
  assert.equal(ended.endedAt, phaseEnd.timestamp);
  assert.equal(ended.eventCount, 0);
});

test("projectRun closes open phases only after observing workflow_end", () => {
  const phaseEventOnly = event("open-phase-event", 1, store.EVENT_TYPES.PHASE_EVENT, {
    phase: "implicit",
    message: "work observed",
  });
  const error = event("run-error", 2, store.EVENT_TYPES.ERROR, {
    status: store.STATUSES.FAILED,
    message: "transient error event",
  });
  const workflowEnd = event("workflow-end", 3, store.EVENT_TYPES.WORKFLOW_END, {
    status: store.STATUSES.FAILED,
    message: "workflow failed",
  });

  const withoutWorkflowEnd = store.projectRun([phaseEventOnly, error]);
  assert.equal(withoutWorkflowEnd.normalizedStatus, store.STATUSES.FAILED);
  assert.equal(withoutWorkflowEnd.phases[0].normalizedStatus, store.STATUSES.RUNNING);
  assert.equal(withoutWorkflowEnd.phases[0].endedAt, undefined);

  const withWorkflowEnd = store.projectRun([phaseEventOnly, error, workflowEnd]);
  assert.equal(withWorkflowEnd.normalizedStatus, store.STATUSES.FAILED);
  assert.equal(withWorkflowEnd.endedAt, workflowEnd.timestamp);
  assert.equal(withWorkflowEnd.phases[0].normalizedStatus, store.STATUSES.FAILED);
  assert.equal(withWorkflowEnd.phases[0].endedAt, workflowEnd.timestamp);

  const laterArtifact = event("later-artifact", 4, store.EVENT_TYPES.ARTIFACT, { artifact: { kind: "file", path: "/tmp/result" } });
  const withLaterArtifact = store.projectRun([phaseEventOnly, error, workflowEnd, laterArtifact]);
  assert.equal(withLaterArtifact.updatedAt, laterArtifact.timestamp);
  assert.equal(withLaterArtifact.endedAt, workflowEnd.timestamp, "post-terminal artifacts must not inflate elapsed workflow time");
  assert.equal(withLaterArtifact.phases[0].endedAt, workflowEnd.timestamp);
});
