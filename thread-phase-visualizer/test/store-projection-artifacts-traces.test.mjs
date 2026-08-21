import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-artifacts-traces-store-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
const store = await import(`../lib/store.mjs?artifacts-traces=${Date.now()}`);

test.after(() => rmSync(storeDir, { recursive: true, force: true }));

const RUN = "artifacts-traces-run";
const envelope = { schema: store.SCHEMA_VERSION, runId: RUN, workflow: "projection-test" };

function at(seconds) {
  return new Date(Date.UTC(2025, 0, 1, 0, 0, seconds)).toISOString();
}

function phaseStart(name, seconds) {
  return { ...envelope, eventId: `${name}-start`, type: store.EVENT_TYPES.PHASE_START, phase: name, status: store.STATUSES.RUNNING, timestamp: at(seconds) };
}
function phaseEnd(name, seconds, status = store.STATUSES.SUCCESS) {
  return { ...envelope, eventId: `${name}-end`, type: store.EVENT_TYPES.PHASE_END, phase: name, status, timestamp: at(seconds) };
}
function fanoutEvent(name, kind, data, seconds) {
  return { ...envelope, eventId: `${name}-${kind}-${seconds}`, type: store.EVENT_TYPES.PHASE_EVENT, phase: name, data: { kind, ...data }, timestamp: at(seconds) };
}
function artifactEvent(seconds, artifact) {
  return { ...envelope, eventId: `artifact-${seconds}`, type: store.EVENT_TYPES.ARTIFACT, artifact, timestamp: at(seconds) };
}
function agentEvent(name, data, seconds, itemId) {
  return {
    ...envelope,
    eventId: `agent-${seconds}`,
    type: store.EVENT_TYPES.AGENT_EVENT,
    phase: name,
    data: itemId === undefined ? data : { ...data, itemId },
    timestamp: at(seconds),
  };
}

function fanoutRun() {
  return [
    phaseStart("compile", 1),
    phaseEnd("compile", 2),
    phaseStart("stages", 3),
    fanoutEvent("stages", "fanout_start", { total: 2, label: "stage" }, 4),
    fanoutEvent("stages", "fanout_item_start", { itemId: "0:alpha", label: "alpha", index: 0, total: 2 }, 5),
    fanoutEvent("stages", "fanout_item_end", { itemId: "0:alpha", label: "alpha", index: 0, status: store.STATUSES.SUCCESS }, 6),
    fanoutEvent("stages", "fanout_item_start", { itemId: "1:beta", label: "beta", index: 1, total: 2 }, 7),
    fanoutEvent("stages", "fanout_item_end", { itemId: "1:beta", label: "beta", index: 1, status: store.STATUSES.SUCCESS }, 8),
    phaseEnd("stages", 9),
  ];
}

test("projectRun nests artifacts under their generating phase and fanout stage while keeping run.artifacts", () => {
  const stageArtifact = artifactEvent(10, {
    kind: "markdown", title: "alpha output", path: "/tmp/stages-alpha.md",
    metadata: { phase: "stages", type: "markdown", itemId: "0:alpha", index: 0 },
  });
  const phaseArtifact = artifactEvent(11, {
    kind: "markdown", title: "compile report", path: "/tmp/compile.md",
    metadata: { phase: "compile", type: "markdown" },
  });
  const projected = store.projectRun([...fanoutRun(), stageArtifact, phaseArtifact]);

  // Top-level run.artifacts still present for backward compatibility.
  assert.equal(projected.artifacts.length, 2);
  assert.ok(projected.artifacts.some((a) => a.path === "/tmp/stages-alpha.md"));
  assert.ok(projected.artifacts.some((a) => a.path === "/tmp/compile.md"));

  const compile = projected.phases.find((p) => p.phase === "compile");
  const stages = projected.phases.find((p) => p.phase === "stages");
  // Non-stage artifacts nest under their generating phase.
  assert.deepEqual(compile.artifacts.map((a) => a.path), ["/tmp/compile.md"]);
  // Stage artifacts nest under the exact fanout stage, not duplicated on the
  // fanout phase itself.
  assert.equal((stages.artifacts ?? []).length, 0);
  const alpha = stages.fanout.items.find((item) => item.itemId === "0:alpha");
  assert.ok(alpha);
  assert.deepEqual(alpha.artifacts.map((a) => a.path), ["/tmp/stages-alpha.md"]);
  const beta = stages.fanout.items.find((item) => item.itemId === "1:beta");
  assert.ok(beta);
  assert.equal((beta.artifacts ?? []).length, 0);
});

test("projectRun projects bounded recentItems from agent_event onto phase and fanout stage", () => {
  const events = [
    ...fanoutRun(),
    // Plain phase trace (no itemId) lands on the phase.
    agentEvent("compile", { type: "content_delta", agent: "assistant", contentType: "thinking", contentIndex: 0, delta: "reasoning text" }, 12),
    agentEvent("compile", { type: "tool_call_started", agent: "assistant", toolCallId: "tc1", contentIndex: 0 }, 13),
    agentEvent("compile", { type: "tool_call_completed", agent: "assistant", toolCallId: "tc1", toolName: "bash", contentIndex: 0, args: "{\"cmd\":\"ls\"}" }, 14),
    // Fanout stage trace carries itemId -> lands on that stage AND the phase.
    agentEvent("stages", { type: "content_delta", agent: "assistant", contentType: "thinking", contentIndex: 0, delta: "beta reasoning" }, 15, "1:beta"),
  ];
  const projected = store.projectRun(events);

  const compile = projected.phases.find((p) => p.phase === "compile");
  assert.ok(Array.isArray(compile.recentItems));
  assert.deepEqual(compile.recentItems.map((t) => t.type), ["content_delta", "tool_call_started", "tool_call_completed"]);
  assert.equal(compile.recentItems[0].delta, "reasoning text");
  assert.equal(compile.recentItems[2].toolName, "bash");

  const stages = projected.phases.find((p) => p.phase === "stages");
  const beta = stages.fanout.items.find((item) => item.itemId === "1:beta");
  assert.deepEqual(beta.recentItems.map((t) => t.type), ["content_delta"]);
  assert.equal(beta.recentItems[0].delta, "beta reasoning");
  // The fanout phase aggregates the stage trace too.
  assert.ok(stages.recentItems.some((t) => t.type === "content_delta" && t.delta === "beta reasoning"));
});

test("recentItems stays bounded when many agent_event records arrive for one phase", () => {
  const events = [
    phaseStart("long", 1),
    ...Array.from({ length: 250 }, (_, index) =>
      agentEvent("long", { type: "content_delta", agent: "assistant", contentType: "thinking", contentIndex: 0, delta: `d${index}` }, 2 + index, undefined)),
    phaseEnd("long", 300),
  ];
  const projected = store.projectRun(events);
  const phase = projected.phases.find((p) => p.phase === "long");
  assert.ok(phase.recentItems.length <= 100);
  // The oldest records were evicted; the newest remain (arrival order).
  assert.equal(phase.recentItems.at(-1).delta, "d249");
});
