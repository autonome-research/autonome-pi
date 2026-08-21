import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import test from "node:test";

const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);
const { ThreadPhaseMonitorComponent } = await import("../components/monitor.ts");

const theme = { fg: (_c, v) => String(v), bold: (v) => String(v) };

function text(lines) {
  return lines.join("\n");
}

function run(overrides = {}) {
  return {
    runId: "run-alpha",
    workflow: "Alpha Build",
    normalizedStatus: "success",
    status: "success",
    cwd: "/repo",
    updatedAt: "2026-01-01T00:00:00.000Z",
    phases: [{ phase: "compile", normalizedStatus: "success", status: "success" }],
    artifacts: [],
    errors: [],
    ...overrides,
  };
}

function component(runs) {
  return new ThreadPhaseMonitorComponent("/repo", undefined, theme, () => {}, () => {}, () => {}, () => runs);
}

// p1, a completed fanout phase with `count` displayed stages, p3.
function fanoutPhases(count) {
  return [
    { phase: "p1", normalizedStatus: "success", status: "success" },
    {
      phase: "fanout",
      normalizedStatus: "success",
      status: "success",
      fanout: {
        total: count, completed: count, failed: 0, running: 0,
        items: Array.from({ length: count }, (_, index) => ({
          itemId: `item-${index}`, label: `item-${String.fromCharCode(97 + index)}`, index, normalizedStatus: "success", status: "success",
        })),
      },
    },
    { phase: "p3", normalizedStatus: "success", status: "success" },
  ];
}

test("expanding a fanout phase reveals its stage rows and they navigate without skipping phases", () => {
  const monitor = component([run({ phases: fanoutPhases(3), artifacts: [] })]);
  monitor.handleInput("\r"); // list -> detail (p1)
  monitor.handleInput("\x1b[B"); // fanout
  monitor.handleInput("\r"); // expand -> stages revealed
  const expanded = text(monitor.render(90));
  assert.match(expanded, /fanout/);
  assert.match(expanded, /item-a/);
  assert.match(expanded, /item-c/);

  // Down walks through each stage, then reaches the next phase (nothing skipped).
  monitor.handleInput("\x1b[B");
  assert.match(text(monitor.render(90)), /item-a/);
  monitor.handleInput("\x1b[B");
  assert.match(text(monitor.render(90)), /item-b/);
  monitor.handleInput("\x1b[B");
  assert.match(text(monitor.render(90)), /item-c/);
  monitor.handleInput("\x1b[B");
  assert.match(text(monitor.render(90)), /p3/);
});

test("identity-based selection does not jump when a fanout collapses", () => {
  const monitor = component([run({ phases: fanoutPhases(3), artifacts: [] })]);
  monitor.handleInput("\r"); // list -> detail
  monitor.handleInput("\x1b[B"); // fanout
  monitor.handleInput("\r"); // expand fanout
  assert.equal(monitor.selectedKey, "phase:fanout");
  monitor.handleInput("\r"); // collapse fanout
  assert.equal(monitor.selectedKey, "phase:fanout"); // selection stays on the phase
  const collapsed = text(monitor.render(90));
  assert.doesNotMatch(collapsed, /item-a/); // stages removed
  // Down from the collapsed fanout reaches the next phase (no stale stage).
  monitor.handleInput("\x1b[B");
  assert.equal(monitor.selectedKey, "phase:p3");
});

test("a completed phase hands off to its nested artifacts", () => {
  const monitor = component([run({
    phases: [{
      phase: "review", normalizedStatus: "success", status: "success",
      artifacts: [{ kind: "markdown", title: "Review report", content: "review-body" }],
    }],
    artifacts: [],
  })]);
  monitor.handleInput("\r"); // detail
  monitor.handleInput("\r"); // expand completed phase -> nested artifact
  const rendered = text(monitor.render(90));
  assert.match(rendered, /Review report/);
  assert.doesNotMatch(rendered, /trace:/); // completed -> artifacts, not live trace
  monitor.handleInput("\x1b[B"); // to the artifact
  monitor.handleInput("\r"); // open it
  assert.match(text(monitor.render(90)), /review-body/);
});

test("live trace pane renders for a running phase and degrades without recentItems", () => {
  const monitor = component([run({
    normalizedStatus: "running", status: "running",
    phases: [{
      phase: "review", normalizedStatus: "running", status: "running", lastMessage: "review running",
      recentItems: [
        { type: "content_delta", contentType: "thinking", delta: "deep reasoning" },
        { type: "tool_call_started", toolCallId: "tc1" },
        { type: "tool_call_completed", toolName: "bash", args: "{\"cmd\":\"ls\"}" },
      ],
    }],
    artifacts: [],
  })]);
  monitor.handleInput("\r");
  monitor.handleInput("\r"); // expand running phase -> trace pane
  const trace = text(monitor.render(100));
  assert.match(trace, /trace:/);
  assert.match(trace, /deep reasoning/);
  assert.match(trace, /bash/);

  const empty = component([run({
    normalizedStatus: "running", status: "running",
    phases: [{ phase: "solo", normalizedStatus: "running", status: "running", lastMessage: "working hard" }],
    artifacts: [],
  })]);
  empty.handleInput("\r");
  empty.handleInput("\r");
  assert.doesNotThrow(() => text(empty.render(100)));
  assert.match(text(empty.render(100)), /solo/);
});
