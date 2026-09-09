import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import test from "node:test";

const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);
const {
  commandElapsed,
  commandStatePresentation,
  conciseCommand,
  previewNotices,
  visibleCommandRows,
} = await import("../components/command-ledger.ts");

const row = (key, state, extra = {}) => ({ key, state, ...extra });
const ledger = (rows, extra = {}) => ({
  schema: "thread-phase-command-ledger/v1",
  rows,
  retainedCommands: rows.length,
  observedEvents: rows.length,
  duplicateEvents: 0,
  droppedCommands: 0,
  truncated: false,
  ...extra,
});

test("command state words never treat argument readiness or malformed completion as success", () => {
  assert.deepEqual(commandStatePresentation("ready"), {
    glyph: "◇", label: "args ready · outcome unobserved", color: "warning",
  });
  assert.deepEqual(commandStatePresentation("finished"), {
    glyph: "?", label: "finished · outcome unobserved", color: "muted",
  });
  assert.equal(commandStatePresentation("succeeded").glyph, "✓");
  assert.equal(commandStatePresentation("failed").label, "failed");
  assert.equal(commandStatePresentation("interrupted").label, "interrupted");
});

test("default ledger rows keep every active command plus three recent retained commands", () => {
  const rows = [
    row("old-1", "succeeded"),
    row("old-2", "failed"),
    row("active-ready", "ready"),
    row("recent-1", "finished"),
    row("active-executing", "executing"),
    row("recent-2", "interrupted"),
    row("recent-3", "succeeded"),
  ];
  const visible = visibleCommandRows(ledger(rows), { ownerRunning: true });
  assert.deepEqual(visible.rows.map((entry) => entry.key), [
    "active-ready", "recent-1", "active-executing", "recent-2", "recent-3",
  ]);
  assert.equal(visible.hiddenCount, 2);
  assert.deepEqual(visibleCommandRows(ledger(rows), { ownerRunning: true, showAll: true }).rows, rows);
});

test("concise labels use bounded command/path arguments without parsing row identity", () => {
  assert.equal(conciseCommand({ toolName: "bash", argsPreview: { text: JSON.stringify({ command: "npm test" }), truncated: false } }), "npm test");
  assert.equal(conciseCommand({ toolName: "read", argsPreview: { text: JSON.stringify({ path: "/repo/a.ts" }), truncated: false } }), "/repo/a.ts");
  assert.equal(conciseCommand({ toolName: "grep", argsPreview: { text: JSON.stringify({ pattern: "needle", path: "/repo" }), truncated: false } }), "needle @ /repo");
  assert.equal(conciseCommand({ toolName: "legacy", argsPreview: { text: "plain\nargs", truncated: true } }), "plain args");
});

test("elapsed time requires an observed execution start and preview loss is explicit", () => {
  assert.equal(commandElapsed({ executionStartObserved: false, startedAt: "2025-01-01T00:00:00Z" }, Date.parse("2025-01-01T00:00:10Z")), "");
  assert.equal(commandElapsed({ executionStartObserved: true, startedAt: "2025-01-01T00:00:00Z" }, Date.parse("2025-01-01T00:00:10Z")), "10s");
  assert.deepEqual(previewNotices({
    text: "safe", bytes: 100, retainedBytes: 4, truncated: true, omitted: "read_output", redacted: true,
  }), ["omitted: read_output", "redacted", "truncated: 4 of 100 bytes retained"]);
});
