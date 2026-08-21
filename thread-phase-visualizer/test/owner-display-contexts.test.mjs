import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import test from "node:test";

const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);

const { registerThreadPhaseMessageRenderers } = await import("../components/run-message-renderer.ts");
const { activeRunWidgetLines } = await import("../components/status-widget.ts");

const theme = {
  bg(_color, value) { return String(value); },
  fg(_color, value) { return String(value); },
  bold(value) { return String(value); },
};

function displayRun() {
  return {
    runId: "run-owner-display",
    workflow: "Owner display",
    normalizedStatus: "running",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    metadata: {
      sessionId: "session-owner-42",
      launchSource: "background",
      cwdAtLaunch: "/repo/at-launch",
    },
    stale: { reason: "heartbeat_stale", ageMs: 600_000 },
    phases: [{ phase: "compile", normalizedStatus: "running", status: "running" }],
    artifacts: [],
    errors: [],
  };
}

function componentText(component) {
  if (typeof component?.text === "string") return component.text;
  if (Array.isArray(component?.children)) return component.children.map(componentText).filter(Boolean).join("\n");
  return "";
}

test("expanded run messages display canonical owner metadata and stale reason", () => {
  let renderer;
  registerThreadPhaseMessageRenderers({
    registerMessageRenderer(type, callback) {
      assert.equal(type, "thread-phase-run");
      renderer = callback;
    },
  });

  const rendered = renderer({ details: { summary: displayRun() } }, { expanded: true }, theme);
  const output = componentText(rendered);
  // Owner metadata is trimmed to high-signal fields (audit MUST): sessionId/cwd
  // dropped, short launch source retained, stale reason kept.
  assert.match(output, /launch source: background/);
  assert.doesNotMatch(output, /sessionId: session-owner-42|cwd at launch/);
  assert.match(output, /\[STALE\] heartbeat_stale/);
});

test("active run widget lines display canonical workflow/phase for live runs", () => {
  const live = displayRun();
  delete live.stale;
  const output = activeRunWidgetLines([live]).join("\n");
  // Signal-first widget: no owner telemetry, just workflow + active phase.
  assert.doesNotMatch(output, /sessionId: session-owner-42|launch source|cwd at launch/);
  assert.match(output, /Owner display: compile/);
  assert.match(output, /\/workflows open dashboard/);
});

test("active run widget omits stale and terminal runs", () => {
  const stale = displayRun();
  const timedOut = { ...displayRun(), runId: "timed-out", normalizedStatus: "failed", status: "timed_out", stale: undefined };
  assert.deepEqual(activeRunWidgetLines([stale, timedOut]), []);
});

test("inline run message nests artifacts under their phase and has no flat Artifacts section", () => {
  let renderer;
  registerThreadPhaseMessageRenderers({
    registerMessageRenderer(type, callback) { assert.equal(type, "thread-phase-run"); renderer = callback; },
  });
  const run = {
    runId: "run-nest", workflow: "Nested", normalizedStatus: "success", status: "success",
    artifacts: [],
    phases: [
      { phase: "compile", normalizedStatus: "success", status: "success", artifacts: [{ kind: "markdown", title: "Compile out", path: "/x/compile.md" }] },
      { phase: "fanout", normalizedStatus: "success", status: "success", fanout: { total: 1, completed: 1, items: [{ itemId: "0:one", label: "one", normalizedStatus: "success", status: "success", artifacts: [{ kind: "markdown", title: "Stage one", path: "/x/stage-one.md" }] }] } },
    ],
    errors: [],
  };
  const rendered = renderer({ details: { summary: run } }, { expanded: true }, theme);
  const output = componentText(rendered);
  assert.match(output, /Compile out/);
  assert.match(output, /Stage one/);
  // No flat "Artifacts" section header remains; artifacts are nested under phases/stages.
  assert.doesNotMatch(output, /\nArtifacts\n|\nArtifacts:/);
});
