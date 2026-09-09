import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import test from "node:test";

const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);
const { ThreadPhaseMonitorComponent } = await import("../components/monitor.ts");
const store = await import("../lib/store.mjs");
const { visibleWidth } = await import("@earendil-works/pi-tui");

const theme = { fg: (_color, value) => String(value), bold: (value) => String(value) };
const preview = (text, extra = {}) => ({
  text,
  bytes: Buffer.byteLength(text),
  retainedBytes: Buffer.byteLength(text),
  truncated: false,
  ...extra,
});

function command(key, state, extra = {}) {
  return {
    key,
    identitySource: "pi",
    toolCallId: "reused-id",
    state,
    outcome: state === "succeeded" ? "success" : state === "failed" ? "failure" : state === "executing" ? "running" : "unobserved",
    executionObserved: ["executing", "succeeded", "failed", "finished", "interrupted"].includes(state),
    executionStartObserved: ["executing", "succeeded", "failed", "interrupted"].includes(state),
    executionEndObserved: ["succeeded", "failed", "finished"].includes(state),
    updateCount: 0,
    observedEvents: 1,
    history: [{ type: "tool_call_ready", state: "ready", at: "2026-01-01T00:00:01.000Z" }],
    historyDropped: 0,
    truncated: false,
    ...extra,
  };
}

function ledger(rows, extra = {}) {
  return {
    schema: "thread-phase-command-ledger/v1",
    rows,
    observedEvents: rows.length,
    duplicateEvents: 0,
    droppedCommands: 0,
    retainedCommands: rows.length,
    truncated: false,
    ...extra,
  };
}

function run(phases, extra = {}) {
  return {
    runId: "run-command-ui",
    workflow: "Command UI",
    normalizedStatus: "running",
    status: "running",
    cwd: "/repo",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:10.000Z",
    phases,
    artifacts: [],
    errors: [],
    ...extra,
  };
}

function component(loadRuns) {
  return new ThreadPhaseMonitorComponent("/repo", undefined, theme, () => {}, () => {}, () => {}, loadRuns);
}

function text(monitor, width = 110) {
  return monitor.render(width).join("\n");
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("projected interleaved command events integrate into separate monitor item lanes", () => {
  const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const envelope = { schema: store.SCHEMA_VERSION, runId: "projected-monitor", workflow: "Projected monitor", cwd: "/repo" };
  const phaseEvent = (eventId, second, data) => ({ ...envelope, eventId, timestamp: at(second), type: store.EVENT_TYPES.PHASE_EVENT, phase: "fanout", data });
  const agentEvent = (eventId, second, data) => ({ ...envelope, eventId, timestamp: at(second), type: store.EVENT_TYPES.AGENT_EVENT, phase: "fanout", data });
  const commandEvent = (type, invocationId, itemId, sequence, extra = {}) => ({
    schema: "pi-command-event/v1",
    type,
    commandEventId: `${invocationId}:${sequence}`,
    invocationId,
    attempt: 1,
    identitySource: "pi",
    toolCallId: "reused-id",
    toolName: extra.toolName || "bash",
    itemId,
    ...extra,
  });
  const projected = store.projectRun([
    { ...envelope, eventId: "start", timestamp: at(0), type: store.EVENT_TYPES.WORKFLOW_START, status: "running" },
    { ...envelope, eventId: "phase", timestamp: at(1), type: store.EVENT_TYPES.PHASE_START, phase: "fanout", status: "running" },
    phaseEvent("fanout-start", 2, { kind: "fanout_start", total: 2 }),
    phaseEvent("a-start", 3, { kind: "fanout_item_start", itemId: "a", label: "lane-a", index: 0 }),
    phaseEvent("b-start", 3, { kind: "fanout_item_start", itemId: "b", label: "lane-b", index: 1 }),
    agentEvent("a-ready", 4, commandEvent("tool_call_ready", "inv-a", "a", 1, { toolName: "edit", argsPreview: preview(JSON.stringify({ path: "/repo/a.ts" })) })),
    agentEvent("b-ready", 4, commandEvent("tool_call_ready", "inv-b", "b", 1, { toolName: "read", argsPreview: preview(JSON.stringify({ path: "/repo/b.ts" })) })),
    agentEvent("b-exec", 5, commandEvent("tool_execution_start", "inv-b", "b", 2, { toolName: "read" })),
    agentEvent("a-exec", 5, commandEvent("tool_execution_start", "inv-a", "a", 2, { toolName: "edit" })),
    agentEvent("b-end", 6, commandEvent("tool_execution_end", "inv-b", "b", 3, { toolName: "read", isError: false, resultPreview: preview("body omitted", { omitted: "read_output" }) })),
    agentEvent("a-end", 7, commandEvent("tool_execution_end", "inv-a", "a", 3, { toolName: "edit", isError: true, resultPreview: preview("patch rejected") })),
  ]);
  const phase = projected.phases[0];
  assert.equal(phase.commandLedger, undefined);
  assert.notEqual(phase.fanout.items[0].commandLedger.rows[0].key, phase.fanout.items[1].commandLedger.rows[0].key);

  const monitor = component(() => [projected]);
  monitor.handleInput("\r");
  monitor.handleInput("\r");
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\r");
  let rendered = text(monitor);
  assert.match(rendered, /lane-a/);
  assert.match(rendered, /✗ edit · failed/);
  assert.doesNotMatch(rendered, /\/repo\/b\.ts/);
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\r");
  rendered = text(monitor);
  assert.match(rendered, /✓ read · succeeded/);
  assert.equal(count(rendered, "/repo/b.ts"), 1);
});

test("fanout command rows stay in separate interleaved item lanes with opaque reused-ID namespaces", () => {
  const duplicateParent = command('pi-parent-reused-id', "succeeded", {
    toolName: "bash", argsPreview: preview(JSON.stringify({ command: "parent duplicate must hide" })),
  });
  const laneAReady = command('["pi","inv-a",1,"a","reused-id"]', "ready", {
    invocationId: "inv-a", itemId: "a", toolName: "edit", argsPreview: preview(JSON.stringify({ path: "/repo/a.ts" })),
  });
  const laneAExecuting = command('["pi","inv-a",1,"a","other"]', "executing", {
    invocationId: "inv-a", itemId: "a", toolName: "bash", argsPreview: preview(JSON.stringify({ command: "npm test -- a" })),
    startedAt: new Date(Date.now() - 2_000).toISOString(),
  });
  const laneBSuccess = command('["pi","inv-b",1,"b","reused-id"]', "succeeded", {
    invocationId: "inv-b", itemId: "b", toolName: "read", argsPreview: preview(JSON.stringify({ path: "/repo/b.ts" })),
    startedAt: "2026-01-01T00:00:03.000Z", endedAt: "2026-01-01T00:00:04.000Z", isError: false,
  });
  const phase = {
    phase: "fanout",
    normalizedStatus: "running",
    status: "running",
    commandLedger: ledger([duplicateParent]),
    fanout: {
      total: 2, completed: 1, failed: 0, running: 1,
      items: [
        { itemId: "a", label: "lane-a", index: 0, normalizedStatus: "running", status: "running", commandLedger: ledger([laneAReady, laneAExecuting]) },
        { itemId: "b", label: "lane-b", index: 1, normalizedStatus: "success", status: "success", commandLedger: ledger([laneBSuccess]) },
      ],
    },
  };
  const monitor = component(() => [run([phase])]);
  monitor.handleInput("\r"); // detail
  monitor.handleInput("\r"); // fanout phase open
  assert.doesNotMatch(text(monitor), /parent duplicate must hide/);

  monitor.handleInput("\x1b[B"); // lane-a
  monitor.handleInput("\r"); // lane-a open
  let rendered = text(monitor);
  assert.match(rendered, /lane-a/);
  assert.match(rendered, /edit · args ready · outcome unobserved — \/repo\/a\.ts/);
  assert.match(rendered, /bash · executing · 2s — npm test -- a/);
  assert.doesNotMatch(rendered, /\/repo\/b\.ts/);
  assert.equal(count(rendered, "/repo/a.ts"), 1);
  assert.doesNotMatch(rendered, /✓ edit/, "argument completion must not receive a success glyph");

  monitor.handleInput("\x1b[B"); // lane-a ready command
  const laneASelection = monitor.selectedKey;
  assert.ok(laneASelection);
  monitor.handleInput("\x1b[B"); // lane-a executing command
  monitor.handleInput("\x1b[B"); // lane-b
  monitor.handleInput("\r"); // lane-b open
  monitor.handleInput("\x1b[B"); // lane-b command
  const laneBSelection = monitor.selectedKey;
  assert.ok(laneBSelection);
  assert.notEqual(laneASelection, laneBSelection);
  rendered = text(monitor);
  assert.match(rendered, /✓ read · succeeded · 1s — \/repo\/b\.ts/);
  assert.equal(count(rendered, "/repo/b.ts"), 1);
});

test("a selected command updates in place from ready to executing to genuine end evidence", () => {
  const stable = command('["pi","inv",1,null,"call"]', "ready", {
    invocationId: "inv", toolName: "bash", argsPreview: preview(JSON.stringify({ command: "npm test" })),
  });
  const phase = { phase: "test", normalizedStatus: "running", status: "running", commandLedger: ledger([stable]) };
  const currentRun = run([phase]);
  const monitor = component(() => [currentRun]);
  monitor.handleInput("\r");
  monitor.handleInput("\r"); // phase open
  monitor.handleInput("\x1b[B"); // command
  monitor.handleInput("\r"); // command details
  const stableSelection = monitor.selectedKey;
  assert.match(text(monitor), /◇ bash · args ready · outcome unobserved — npm test/);
  assert.doesNotMatch(text(monitor), /✓ bash/);

  Object.assign(stable, {
    state: "executing", outcome: "running", executionObserved: true, executionStartObserved: true,
    startedAt: new Date(Date.now() - 1_000).toISOString(), outputPreview: preview("still running"),
  });
  monitor.invalidate();
  assert.equal(monitor.selectedKey, stableSelection);
  assert.match(text(monitor), /▶ bash · executing · 1s — npm test/);
  assert.match(text(monitor), /output:.*\n.*still running/);

  Object.assign(stable, {
    state: "failed", outcome: "failure", executionEndObserved: true, isError: true,
    endedAt: new Date().toISOString(), errorPreview: preview("exit 1"), outputPreview: undefined,
    history: [...stable.history, { type: "tool_execution_end", state: "failed", at: new Date().toISOString() }],
  });
  monitor.invalidate();
  assert.equal(monitor.selectedKey, stableSelection);
  const failed = text(monitor);
  assert.match(failed, /✗ bash · failed · 1s — npm test/);
  assert.match(failed, /error:.*\n.*exit 1/);
});

test("terminal stages retain failed, finished, ready, and interrupted command details honestly", () => {
  const rows = [
    command("failed", "failed", { toolName: "bash", isError: true, argsPreview: preview("npm test"), errorPreview: preview("exit 1") }),
    command("finished", "finished", { toolName: "custom", executionStartObserved: false, resultPreview: preview("finished text") }),
    command("ready", "ready", { toolName: "edit", executionObserved: false, argsPreview: preview(JSON.stringify({ path: "/repo/final.ts" })) }),
    command("interrupted", "interrupted", { toolName: "read", executionObserved: true, executionStartObserved: true, startedAt: "2026-01-01T00:00:05Z", endedAt: "2026-01-01T00:00:06Z" }),
  ];
  const stage = { itemId: "final", label: "final-stage", normalizedStatus: "failed", status: "failed", commandLedger: ledger(rows) };
  const phase = { phase: "fanout", normalizedStatus: "failed", status: "failed", fanout: { total: 1, completed: 0, failed: 1, running: 0, items: [stage] } };
  const monitor = component(() => [run([phase], { normalizedStatus: "failed", status: "failed" })]);
  monitor.handleInput("\r");
  monitor.handleInput("\r"); // phase
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\r"); // stage
  const rendered = text(monitor);
  assert.match(rendered, /final-stage/);
  assert.match(rendered, /\? custom · finished · outcome unobserved/);
  assert.match(rendered, /◇ edit · args ready · outcome unobserved/);
  assert.match(rendered, /! read · interrupted · 1s/);
  assert.doesNotMatch(rendered, /✓ custom|✓ edit|✓ read/);

  // The oldest failed command is behind the retained-history toggle.
  monitor.handleInput("\x1b[B"); // finished
  monitor.handleInput("\x1b[B"); // ready
  monitor.handleInput("\x1b[B"); // interrupted
  monitor.handleInput("\x1b[B"); // history toggle
  monitor.handleInput("\r");
  assert.match(text(monitor), /✗ bash · failed/);
  monitor.handleInput("\x1b[A"); // interrupted after all rows; move upward to ready/finished/failed
  monitor.handleInput("\x1b[A");
  monitor.handleInput("\x1b[A");
  monitor.handleInput("\x1b[A");
  monitor.handleInput("\r"); // failed details
  assert.match(text(monitor), /error:.*\n.*exit 1/);
});

test("ledger and preview truncation remain explicit at narrow widths with keyboard history controls", () => {
  const rows = Array.from({ length: 5 }, (_, index) => command(`row-${index}`, "succeeded", {
    toolName: index === 4 ? "read" : "bash",
    argsPreview: preview(index === 4 ? JSON.stringify({ path: "/repo/a/very/long/path/final.ts" }) : `command-${index}`),
    outputPreview: index === 4 ? preview("bounded output", { bytes: 9000, retainedBytes: 14, truncated: true, omitted: "read_output", redacted: true }) : undefined,
    truncated: index === 4,
  }));
  const phase = { phase: "bounded", normalizedStatus: "success", status: "success", commandLedger: ledger(rows, { droppedCommands: 7, truncated: true }) };
  const monitor = component(() => [run([phase], { normalizedStatus: "success", status: "success" })]);
  monitor.handleInput("\r");
  monitor.handleInput("\r");
  let rendered = text(monitor, 38);
  assert.ok(monitor.render(38).every((line) => visibleWidth(line) === 38));
  assert.match(rendered, /hidden:2/);
  assert.match(rendered, /dropped:7|ledger truncated/);

  // Select the last visible command, expand it, then page through bounded details.
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\r");
  rendered = text(monitor, 38);
  assert.match(rendered, /read succeeded truncated/);
  assert.match(rendered, /truncated/);
  monitor.handleInput("\x04"); // ctrl+d page
  rendered = text(monitor, 38);
  assert.ok(monitor.render(38).every((line) => visibleWidth(line) === 38));
  assert.match(rendered, /omitted: read_output|redacted|truncated:/);
});
