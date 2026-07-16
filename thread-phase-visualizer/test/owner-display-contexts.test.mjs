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
  assert.match(output, /sessionId: session-owner-42  launch source: background  cwd at launch: \/repo\/at-launch/);
  assert.match(output, /\[STALE\] heartbeat_stale/);
});

test("active run widget lines display canonical owner metadata and stale reason", () => {
  const output = activeRunWidgetLines([displayRun()]).join("\n");
  assert.match(output, /sessionId: session-owner-42  launch source: background  cwd at launch: \/repo\/at-launch/);
  assert.match(output, /\[STALE\] heartbeat_stale/);
});
