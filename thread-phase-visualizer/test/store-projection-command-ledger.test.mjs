import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-command-ledger-store-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
const store = await import(`../lib/store.mjs?commands=${Date.now()}`);

test.after(() => rmSync(storeDir, { recursive: true, force: true }));

const envelope = { schema: store.SCHEMA_VERSION, runId: "commands", workflow: "test" };
const at = (n) => new Date(Date.UTC(2025, 0, 1, 0, 0, n)).toISOString();
const event = (eventId, type, phase, seconds, extra = {}) => ({ ...envelope, eventId, type, phase, timestamp: at(seconds), ...extra });
const agent = (eventId, phase, seconds, data) => event(eventId, store.EVENT_TYPES.AGENT_EVENT, phase, seconds, { data });
const preview = (text, truncated = false) => ({ text, bytes: Buffer.byteLength(text), retainedBytes: Buffer.byteLength(text), truncated });

function command(type, invocationId, toolCallId, itemId, extra = {}) {
  return {
    schema: "pi-command-event/v1",
    type,
    commandEventId: `${invocationId}:${type}:${extra.sequence ?? 1}`,
    invocationId,
    attempt: extra.attempt ?? 1,
    identitySource: "pi",
    toolCallId,
    toolName: extra.toolName || "bash",
    itemId,
    contentIndex: extra.contentIndex ?? 0,
    ...extra,
  };
}

test("projectRun correlates real execution lifecycle by invocation and fanout item without phase duplication", () => {
  const events = [
    event("phase", store.EVENT_TYPES.PHASE_START, "fan", 1, { status: "running" }),
    event("fanout", store.EVENT_TYPES.PHASE_EVENT, "fan", 2, { data: { kind: "fanout_start", total: 2 } }),
    event("a-start", store.EVENT_TYPES.PHASE_EVENT, "fan", 3, { data: { kind: "fanout_item_start", itemId: "0:a", label: "a", index: 0 } }),
    event("b-start", store.EVENT_TYPES.PHASE_EVENT, "fan", 3, { data: { kind: "fanout_item_start", itemId: "1:b", label: "b", index: 1 } }),
    // Same content index and real id in separate invocation/item namespaces.
    agent("a-prepare", "fan", 4, command("tool_call_preparing", "inv-a", "same-id", "0:a", { sequence: 1 })),
    agent("b-prepare", "fan", 4, command("tool_call_preparing", "inv-b", "same-id", "1:b", { sequence: 1 })),
    agent("a-ready", "fan", 5, command("tool_call_ready", "inv-a", "same-id", "0:a", { sequence: 2, argsPreview: preview("{\"command\":\"ok\"}") })),
    agent("b-ready", "fan", 5, command("tool_call_ready", "inv-b", "same-id", "1:b", { sequence: 2, argsPreview: preview("{\"command\":\"long\"}") })),
    // Interleaved starts/partial output. Input order is intentionally shuffled;
    // timestamp order remains authoritative to the existing projection.
    agent("b-update", "fan", 7, command("tool_execution_update", "inv-b", "same-id", "1:b", { sequence: 4, outputPreview: preview("partial") })),
    agent("a-exec", "fan", 6, command("tool_execution_start", "inv-a", "same-id", "0:a", { sequence: 3 })),
    agent("b-exec", "fan", 6, command("tool_execution_start", "inv-b", "same-id", "1:b", { sequence: 3 })),
    agent("a-end", "fan", 8, command("tool_execution_end", "inv-a", "same-id", "0:a", { sequence: 4, isError: false, resultPreview: preview("finished") })),
    // Exact duplicate outer event is ignored by the existing event-id contract.
    agent("a-end", "fan", 8, command("tool_execution_end", "inv-a", "same-id", "0:a", { sequence: 4, isError: false, resultPreview: preview("finished") })),
    // Scope end interrupts B; it does not invent failure/success.
    agent("b-scope", "fan", 9, { type: "agent_execution_scope_end", commandEventId: "inv-b:scope", invocationId: "inv-b", attempt: 1, itemId: "1:b" }),
    // A retry/subprocess reusing the id is a separate command.
    agent("b2-start", "fan", 10, command("tool_execution_start", "inv-b2", "same-id", "1:b", { sequence: 1, attempt: 2 })),
    agent("b2-end", "fan", 11, command("tool_execution_end", "inv-b2", "same-id", "1:b", { sequence: 2, attempt: 2, isError: true, resultPreview: preview("denied") })),
    event("a-done", store.EVENT_TYPES.PHASE_EVENT, "fan", 12, { data: { kind: "fanout_item_end", itemId: "0:a", status: "success" } }),
    event("b-done", store.EVENT_TYPES.PHASE_EVENT, "fan", 12, { data: { kind: "fanout_item_end", itemId: "1:b", status: "failed" } }),
    event("phase-done", store.EVENT_TYPES.PHASE_END, "fan", 13, { status: "failed" }),
  ];

  const phase = store.projectRun(events).phases[0];
  assert.equal(phase.commandLedger, undefined, "fanout commands are not duplicated as phase commands");
  const a = phase.fanout.items.find((item) => item.itemId === "0:a");
  const b = phase.fanout.items.find((item) => item.itemId === "1:b");
  assert.equal(a.commandLedger.rows.length, 1);
  assert.equal(a.commandLedger.rows[0].state, "succeeded");
  assert.equal(a.commandLedger.rows[0].outcome, "success");
  assert.equal(a.commandLedger.rows[0].outputPreview.text, "finished");
  assert.equal(b.commandLedger.rows.length, 2);
  assert.deepEqual(b.commandLedger.rows.map((row) => row.state), ["interrupted", "failed"]);
  assert.equal(b.commandLedger.rows[0].outputPreview.text, "partial");
  assert.equal(b.commandLedger.rows[1].errorPreview.text, "denied");
  assert.notEqual(b.commandLedger.rows[0].key, b.commandLedger.rows[1].key);
});

test("projectRun separates complete real-id lifecycles from different Pi turns in one invocation", () => {
  const events = [event("phase", store.EVENT_TYPES.PHASE_START, "turns", 1, { status: "running" })];
  let sequence = 0;
  for (const [turn, result] of [[1, "first"], [2, "second"]]) {
    const extra = { turn, occurrence: turn, sequence: ++sequence };
    events.push(agent(`prepare-${turn}`, "turns", turn * 4, command("tool_call_preparing", "same-process", "reused", undefined, extra)));
    events.push(agent(`ready-${turn}`, "turns", turn * 4 + 1, command("tool_call_ready", "same-process", "reused", undefined, { ...extra, sequence: ++sequence, argsPreview: preview(`{\"command\":\"${result}\"}`) })));
    events.push(agent(`start-${turn}`, "turns", turn * 4 + 2, command("tool_execution_start", "same-process", "reused", undefined, { ...extra, sequence: ++sequence })));
    events.push(agent(`end-${turn}`, "turns", turn * 4 + 3, command("tool_execution_end", "same-process", "reused", undefined, { ...extra, sequence: ++sequence, isError: false, resultPreview: preview(result) })));
  }
  events.push(event("phase-end", store.EVENT_TYPES.PHASE_END, "turns", 12, { status: "success" }));

  const rows = store.projectRun(events).phases[0].commandLedger.rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.outputPreview.text), ["first", "second"]);
  assert.ok(rows.every((row) => row.state === "succeeded"));
  assert.notEqual(rows[0].key, rows[1].key);
});

test("projectRun keeps ambiguous same-turn execution separate from declarations", () => {
  const shared = { turn: 1 };
  const events = [
    event("phase", store.EVENT_TYPES.PHASE_START, "ambiguous", 1, { status: "running" }),
    agent("prepare-a", "ambiguous", 2, command("tool_call_preparing", "same-process", "duplicate", undefined, { ...shared, occurrence: 1, sequence: 1 })),
    agent("ready-a", "ambiguous", 3, command("tool_call_ready", "same-process", "duplicate", undefined, { ...shared, occurrence: 1, sequence: 2 })),
    agent("prepare-b", "ambiguous", 4, command("tool_call_preparing", "same-process", "duplicate", undefined, { ...shared, occurrence: 2, sequence: 3 })),
    agent("ready-b", "ambiguous", 5, command("tool_call_ready", "same-process", "duplicate", undefined, { ...shared, occurrence: 2, sequence: 4 })),
    agent("unknown-start", "ambiguous", 6, { ...command("tool_execution_start", "same-process", "duplicate", undefined, { ...shared, sequence: 5 }), identitySource: "synthetic", syntheticId: "ambiguous:start" }),
    agent("unknown-end", "ambiguous", 7, { ...command("tool_execution_end", "same-process", "duplicate", undefined, { ...shared, sequence: 6, isError: false }), identitySource: "synthetic", syntheticId: "ambiguous:end" }),
    event("phase-end", store.EVENT_TYPES.PHASE_END, "ambiguous", 8, { status: "success" }),
  ];

  const rows = store.projectRun(events).phases[0].commandLedger.rows;
  assert.deepEqual(rows.map((row) => row.state), ["ready", "ready", "interrupted", "succeeded"]);
  assert.deepEqual(rows.map((row) => row.identitySource), ["pi", "pi", "synthetic", "synthetic"]);
});

test("terminal projection keeps ready legacy rows outcome-unobserved and interrupts only observed execution", () => {
  const events = [
    event("phase", store.EVENT_TYPES.PHASE_START, "legacy", 1, { status: "running" }),
    agent("legacy-start-1", "legacy", 2, { type: "tool_call_started", toolCallId: "tc-0", contentIndex: 0 }),
    agent("legacy-ready-1", "legacy", 3, { type: "tool_call_completed", toolCallId: "tc-0", toolName: "edit", contentIndex: 0, args: "first" }),
    agent("legacy-start-2", "legacy", 4, { type: "tool_call_started", toolCallId: "tc-0", contentIndex: 0 }),
    agent("legacy-ready-2", "legacy", 5, { type: "tool_call_completed", toolCallId: "tc-0", toolName: "edit", contentIndex: 0, args: "second" }),
    agent("open", "legacy", 6, command("tool_execution_start", "inv-open", "open", undefined, { sequence: 1 })),
    agent("malformed-end", "legacy", 6, command("tool_execution_end", "inv-finished", "finished", undefined, { sequence: 1, resultPreview: preview("finished") })),
    event("phase-end", store.EVENT_TYPES.PHASE_END, "legacy", 7, { status: "cancelled" }),
  ];
  const rows = store.projectRun(events).phases[0].commandLedger.rows;
  assert.equal(rows.length, 4, "reused fabricated content-index ids become separate historical rows");
  assert.deepEqual(rows.map((row) => row.state), ["ready", "ready", "interrupted", "finished"]);
  assert.deepEqual(rows.map((row) => row.outcome), ["unobserved", "unobserved", "interrupted", "unobserved"]);
  assert.ok(rows.every((row) => row.state !== "succeeded"));
});

test("out-of-order and duplicate lifecycle records cannot downgrade an observed execution end", () => {
  const endData = command("tool_execution_end", "out-of-order", "call", undefined, { sequence: 3, isError: false, resultPreview: preview("done") });
  const events = [
    event("phase", store.EVENT_TYPES.PHASE_START, "odd", 1, { status: "running" }),
    agent("end-first", "odd", 2, endData),
    agent("end-duplicate-envelope", "odd", 2.5, endData),
    agent("late-start", "odd", 3, command("tool_execution_start", "out-of-order", "call", undefined, { sequence: 1 })),
    event("phase-end", store.EVENT_TYPES.PHASE_END, "odd", 4, { status: "failed" }),
  ];
  const ledger = store.projectRun(events).phases[0].commandLedger;
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0].state, "succeeded");
  assert.equal(ledger.rows[0].executionEndObserved, true);
  assert.equal(ledger.rows[0].startedAt, undefined, "contradictory late start is not used to invent elapsed time");
  assert.equal(ledger.duplicateEvents, 1);
});

test("command projection bounds row count, history, previews, and reports truncation", () => {
  const events = [event("phase", store.EVENT_TYPES.PHASE_START, "bounded", 1, { status: "running" })];
  for (let index = 0; index < 100; index++) {
    const id = `c-${index}`;
    events.push(agent(`start-${index}`, "bounded", 2 + index * 2, command("tool_execution_start", "bounded-inv", id, undefined, { sequence: index * 2 + 1 })));
    events.push(agent(`end-${index}`, "bounded", 3 + index * 2, command("tool_execution_end", "bounded-inv", id, undefined, { sequence: index * 2 + 2, isError: false, resultPreview: preview("x".repeat(10_000), true) })));
  }
  events.push(event("phase-end", store.EVENT_TYPES.PHASE_END, "bounded", 250, { status: "success" }));
  const ledger = store.projectRun(events).phases[0].commandLedger;
  assert.equal(ledger.retainedCommands, 64);
  assert.equal(ledger.droppedCommands, 36);
  assert.equal(ledger.truncated, true);
  assert.ok(ledger.rows.every((row) => Buffer.byteLength(row.outputPreview.text) <= 4_096));
  assert.ok(ledger.rows.every((row) => row.history.length <= 12));
});
