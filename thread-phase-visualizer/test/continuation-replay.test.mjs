import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodeModule from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const storeDir = mkdtempSync(join(tmpdir(), "handoff-replay-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
process.env.PI_THREAD_PHASE_STATUS_BRIDGE = "0";
test.after(() => rmSync(storeDir, { recursive: true, force: true }));
const loader = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loader));
else nodeModule.register(loader);
const { default: register, formatContinuationPrompt } = await import("../index.ts");
const store = await import("../lib/store.mjs");
const receipts = await import("../lib/continuation-store.mjs");
const { formatMarkedContinuation, sessionHistoryHasRunContinuation } = await import("../lib/continuation-message.mjs");
const { reserveSuccessor, commitSuccessor } = await import("../lib/chain-store.mjs");
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text };

function host(sessionId, history = [], options = {}) {
  const handlers = new Map(), commands = new Map(), messages = [], cards = [], notifications = [];
  const state = { idle: true, accept: true, confirm: true, confirms: 0, editor: "", component: undefined, ...options };
  const ctx = { cwd: storeDir, mode: "tui", hasUI: true, isIdle: () => state.idle,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => history },
    ui: { notify: text => notifications.push(text), setWidget() {}, setStatus() {},
      confirm: async () => { state.confirms++; return state.confirm; }, setEditorText: text => { state.editor = text; },
      custom: async factory => { state.component = factory({ requestRender() {} }, theme, {}, () => {}); } } };
  register({ registerMessageRenderer() {}, registerTool() {}, registerShortcut() {},
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, fn) => handlers.set(name, fn),
    sendMessage(message) { cards.push(message); history.push({ type: "custom_message", ...message }); },
    sendUserMessage(message) {
      state.onSend?.(message);
      messages.push(message);
      if (state.accept) {
        history.push({ type: "message", message: { role: "user", content: message } });
        handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
      }
    } });
  return { handlers, commands, messages, cards, ctx, state, notifications,
    start: () => handlers.get("session_start")({}, ctx), stop: () => handlers.get("session_shutdown")({}, ctx),
    settled: () => handlers.get("agent_settled")({}, ctx),
    deliver: runId => commands.get("workflow-handoff").handler(runId, ctx),
    dashboard: () => commands.get("workflows").handler("", ctx) };
}
function run(id, sessionId = id) {
  return store.createRun({ runId: id, workflow: id, cwd: storeDir, trigger: { kind: "background" },
    metadata: { sessionId, continuationMode: "terminal" } });
}
function pending(id) { return receipts.loadPendingContinuationRecords({ storeDir }).find(record => record.runId === id); }
async function waitFor(fn) {
  for (let i = 0; i < 300 && !fn(); i++) await delay(10);
  assert.ok(fn());
}

for (const legacy of [false, true]) test(`capacity eviction cannot repeat a ${legacy ? "legacy" : "stable"} receipt on another branch`, async () => {
  const id = `capacity-${legacy}`, history = [], first = host(id, history);
  const r = run(id);
  try {
    await first.start(); store.completeRun(r, "failed"); await waitFor(() => first.messages.length === 1);
  } finally { first.stop(); }
  if (legacy) history[history.length - 1].message.content = formatMarkedContinuation(`A workflow failed.\nRun: ${id}`, "old-random-id");
  receipts.persistContinuedRuns(new Set(Array.from({ length: 500 }, (_, i) => `other-${legacy}-${i}`)), { storeDir });
  assert.equal(receipts.loadContinuedRuns({ storeDir }).has(id), false);
  const second = host(id, history);
  try {
    await second.start(); await delay(400); second.settled();
    store.completeRun(r, "failed"); await delay(50);
    await second.deliver(id);
    assert.deepEqual(second.messages, []);
    assert.deepEqual(second.cards, []);
  } finally { second.stop(); }
});

test("delivery identity survives receipt expiry and includes the owning session", () => {
  const id = "stable-identity";
  const first = receipts.persistContinuationClaim(id, { storeDir, sessionId: "owner", now: 1_000 });
  receipts.markContinuationDelivered(id, { storeDir, now: 1_000 });
  const next = receipts.persistContinuationClaim(id, { storeDir, sessionId: "owner", now: 100_000_000 });
  assert.equal(next.deliveryId, first.deliveryId);
  receipts.markContinuationDelivered(id, { storeDir, now: 100_000_000 });
  const other = receipts.persistContinuationClaim(id, { storeDir, sessionId: "other", now: 200_000_000 });
  assert.notEqual(other.deliveryId, first.deliveryId);
});

test("old unsent failures stay visible and require an explicit handoff", async (t) => {
  const id = "old-unsent", history = [], first = host(id, history);
  first.state.idle = false;
  try { await first.start(); store.completeRun(run(id), "failed"); await waitFor(() => first.cards.length === 1); }
  finally { first.stop(); }
  const future = Date.now() + 48 * 60 * 60 * 1000;
  t.mock.method(Date, "now", () => future);
  const second = host(id, history);
  try {
    await second.start(); second.settled();
    assert.deepEqual(second.messages, []);
    assert.equal(pending(id).submissionState, "unsent");
    await second.dashboard();
    assert.match(second.state.component.render(160).join("\n"), /old result — explicit action required/);
    // Dashboard action only prepares a command, never submits model input.
    second.state.component.handleInput("r");
    assert.equal(second.state.editor, `/workflow-handoff ${id}`);
    assert.deepEqual(second.messages, []);
    await second.deliver(id);
    assert.equal(second.messages.length, 1);
    assert.match(second.messages[0], /Report the blocker/);
    assert.doesNotMatch(second.messages[0], /Decide whether to resume/);
    await second.deliver(id); second.settled();
    assert.equal(second.messages.length, 1);
  } finally { second.stop(); }
});

test("uncertain sends stay pending across restart, refuse automatic claims, and require confirmation", async () => {
  const id = "uncertain-send", history = [], first = host(id, history, { accept: false });
  try { await first.start(); store.completeRun(run(id), "failed"); await waitFor(() => first.messages.length === 1); }
  finally { first.stop(); }
  assert.equal(pending(id).submissionState, "submitted");
  assert.equal(receipts.persistContinuationClaim(id, { storeDir, retryPending: true }).claimed, false);
  const second = host(id, history);
  try {
    await second.start(); second.settled(); await delay(400);
    assert.deepEqual(second.messages, []);
    second.state.confirm = false;
    await second.deliver(id); assert.equal(second.state.confirms, 1); assert.deepEqual(second.messages, []);
    second.state.confirm = true;
    await second.deliver(id); assert.equal(second.state.confirms, 2); assert.equal(second.messages.length, 1);
    second.settled(); assert.equal(second.messages.length, 1);
  } finally { second.stop(); }
});

test("persisted acceptance reconciles an uncertain send without another assistant-start event", async () => {
  const id = "late-receipt", history = [], app = host(id, history, { accept: false });
  try {
    await app.start(); store.completeRun(run(id), "failed"); await waitFor(() => app.messages.length === 1);
    history.push({ type: "message", message: { role: "user", content: app.messages[0] } });
    app.settled(); assert.equal(pending(id), undefined); assert.equal(app.messages.length, 1);
  } finally { app.stop(); }
});

test("v3 pending records migrate to uncertain, never silently to unsent", async () => {
  const id = "legacy-pending";
  const file = join(storeDir, receipts.CONTINUATION_STATE_FILENAME);
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.schema = "thread-phase-continuations/v3";
  state.records.push({ runId: id, deliveryId: "legacy-delivery", state: "pending", updatedAt: new Date().toISOString() });
  writeFileSync(file, JSON.stringify(state));
  store.completeRun(run(id), "failed");
  const app = host(id);
  try {
    await app.start(); app.settled(); await delay(400);
    assert.equal(pending(id).submissionState, "unknown"); assert.deepEqual(app.messages, []);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).schema, "thread-phase-continuations/v4");
  } finally { app.stop(); }
});

test("duplicate terminal envelopes create one card and one failure prompt", async () => {
  const id = "duplicate-card", app = host(id);
  try {
    await app.start(); const r = run(id);
    store.completeRun(r, "failed"); await waitFor(() => app.messages.length === 1);
    store.completeRun(r, "failed"); await delay(80);
    assert.equal(app.cards.length, 1); assert.equal(app.messages.length, 1);
    assert.equal(app.notifications.filter(text => text.startsWith("thread-phase ")).length, 1, "duplicate toasts are suppressed too");
  } finally { app.stop(); }
});

test("manual handoffs cannot cross ownership, continue cancellation/successors, or accept error-only evidence", async () => {
  const id = "manual-boundary", app = host(id);
  try {
    await app.start();
    store.completeRun(run("foreign-failure", "someone-else"), "failed");
    store.completeRun(run("cancelled-failure", id), "cancelled");
    const errorOnly = run("error-only", id); store.emit(errorOnly, { type: "error", status: "failed", message: "not terminal" });
    const parent = run("committed-parent", id);
    commitSuccessor(reserveSuccessor(parent.runId, "child", { chainId: randomUUID() }));
    store.completeRun(parent, "failed");
    for (const runId of ["foreign-failure", "cancelled-failure", "error-only", "committed-parent"]) await app.deliver(runId);
    assert.deepEqual(app.messages, []);
  } finally { app.stop(); }
});

test("unreadable session history suppresses automatic and manual delivery", async () => {
  const id = "unknown-history", history = [], app = host(id, history);
  app.ctx.sessionManager.getEntries = () => { throw new Error("unreadable"); };
  try {
    await app.start(); store.completeRun(run(id), "failed"); await waitFor(() => app.cards.length === 1);
    app.settled(); await app.deliver(id); assert.deepEqual(app.messages, []);
    assert.equal(pending(id).submissionState, "unsent", "unknown history must not lose the completion");
    app.ctx.sessionManager.getEntries = () => null;
    app.settled(); assert.deepEqual(app.messages, [], "invalid full history must not fall back to an empty branch");
    app.ctx.sessionManager.getEntries = () => history;
    app.settled(); assert.equal(app.messages.length, 1);
  } finally { app.stop(); }
});

test("dashboard handoff reads are throttled and corruption does not break rendering", async (t) => {
  const id = "dashboard-corruption", app = host(id, [], { idle: false });
  const file = join(storeDir, receipts.CONTINUATION_STATE_FILENAME);
  let saved, reads = 0, now = Date.now();
  t.mock.method(Date, "now", () => now);
  const originalRead = fs.readFileSync;
  const spy = t.mock.method(fs, "readFileSync", (path, ...args) => {
    if (path === file) reads++;
    return originalRead(path, ...args);
  });
  nodeModule.syncBuiltinESMExports();
  try {
    await app.start(); store.completeRun(run(id), "failed"); await waitFor(() => app.cards.length === 1);
    saved = readFileSync(file, "utf8");
    await app.dashboard();
    const render = () => { app.state.component.invalidate(); return app.state.component.render(160).join("\n"); };
    reads = 0;
    assert.match(render(), /pending delivery/);
    const firstReads = reads;
    assert.ok(firstReads > 0);
    for (let i = 0; i < 20; i++) render();
    const animationReads = reads;
    writeFileSync(file, "{corrupt");
    now += 5_001;
    assert.match(render(), /dashboard-corruption/);
    assert.doesNotMatch(render(), /handoff:/);
    assert.deepEqual(app.messages, []);
    writeFileSync(file, saved);
    now += 5_001;
    assert.match(render(), /pending delivery/, "annotations recover at the next bounded refresh");
    assert.equal(animationReads, firstReads, "animation ticks must not re-lock/re-read the continuation store");
    const originalOpen = fs.openSync;
    let lockAttempts = 0;
    const lockSpy = t.mock.method(fs, "openSync", (path, ...args) => {
      if (path === `${receipts.continuedRunsFile(storeDir)}.lock`) {
        lockAttempts++; now += 5_001; // simulate elapsed lock timeout without blocking the test
        throw new Error("Timed out waiting for continuation store lock");
      }
      return originalOpen(path, ...args);
    });
    nodeModule.syncBuiltinESMExports();
    try {
      now += 5_001;
      assert.doesNotMatch(render(), /handoff:/);
      render();
      assert.equal(lockAttempts, 1, "backoff starts after a slow failed refresh, not before it");
    } finally { lockSpy.mock.restore(); nodeModule.syncBuiltinESMExports(); }
  } finally {
    spy.mock.restore(); nodeModule.syncBuiltinESMExports();
    if (saved) writeFileSync(file, saved);
    app.stop();
  }
});

test("formatting failure leaves unsent work unclaimed and does not wedge later deliveries", async () => {
  const id = "bad-prompt", app = host(id, [], { idle: false });
  try {
    await app.start(); const bad = run(id);
    store.completeRun(bad, "failed"); await waitFor(() => app.cards.length === 1);
    // JSON-shaped malformed artifact data; no prototype tricks or mocked formatter.
    store.emit(bad, { type: store.EVENT_TYPES.ARTIFACT, artifact: { title: { toString: null }, path: "partial.txt" } });
    assert.throws(() => formatContinuationPrompt(store.getRunSummary(id)), TypeError);
    app.state.idle = true;
    assert.doesNotThrow(() => app.settled());
    assert.equal(pending(id).submissionState, "unsent");
    assert.equal(pending(id).claimantId, undefined);
    assert.deepEqual(app.messages, []);
    assert.ok(app.notifications.some(text => text.includes("Could not format thread-phase continuation")));
    store.completeRun(run("after-bad-prompt", id), "failed");
    await waitFor(() => app.messages.length === 1);
    assert.match(app.messages[0], /Run: after-bad-prompt/);
    assert.equal(pending("after-bad-prompt"), undefined);
  } finally { app.stop(); }
});

test("a completion observed live ages into an explicit handoff during a long busy turn", async (t) => {
  const id = "long-busy-turn", app = host(id, [], { idle: false });
  try {
    await app.start(); store.completeRun(run(id), "failed"); await waitFor(() => app.cards.length === 1);
    const endedAt = Date.parse(store.getRunSummary(id).endedAt);
    t.mock.method(Date, "now", () => endedAt + 30 * 60 * 1000 + 1);
    app.state.idle = true; app.settled();
    assert.deepEqual(app.messages, []);
    assert.equal(pending(id).submissionState, "unsent");
    await app.dashboard();
    assert.match(app.state.component.render(160).join("\n"), /old result — explicit action required/);
    await app.deliver(id);
    assert.equal(app.messages.length, 1);
    assert.equal(app.state.confirms, 0, "known-unsent old results do not require uncertain-delivery confirmation");
  } finally { app.stop(); }
});

test("run markers are exact and session-scoped", () => {
  const entries = [{ type: "message", message: { role: "user", content: formatMarkedContinuation("result", "delivery", { runId: "abc", sessionId: "owner" }) } }];
  assert.equal(sessionHistoryHasRunContinuation(entries, "abc", "owner"), true);
  assert.equal(sessionHistoryHasRunContinuation(entries, "ab", "owner"), false);
  assert.equal(sessionHistoryHasRunContinuation(entries, "abc", "other"), false);
});

test("submission intent precedes the API call; synchronous rejection alone restores unsent", async () => {
  const id = "send-intent", observed = [];
  let attempts = 0;
  const app = host(id, [], { onSend() {
    observed.push(pending(id).submissionState);
    if (++attempts === 1) {
      queueMicrotask(() => observed.push(pending(id).submissionState));
      throw new Error("synchronous rejection");
    }
  } });
  try {
    await app.start(); store.completeRun(run(id), "failed"); await waitFor(() => app.messages.length === 1);
    assert.equal(attempts, 2);
    assert.deepEqual(observed, ["submitted", "unsent", "submitted"]);
    assert.equal(pending(id), undefined);
  } finally { app.stop(); }
});

test("submission transitions require exact live claim ownership", () => {
  const runId = "claim-boundary", claimantId = receipts.createContinuationClaimantId();
  const claim = receipts.persistContinuationClaim(runId, { storeDir, claimantId });
  const identity = { storeDir, claimantId, deliveryId: claim.deliveryId };
  assert.equal(receipts.markContinuationSubmission(runId, { ...identity, claimantId: "someone-else", submissionState: "submitted" }), false);
  assert.equal(receipts.markContinuationSubmission(runId, { ...identity, deliveryId: "wrong-id", submissionState: "submitted" }), false);
  assert.equal(pending(runId).submissionState, "unsent");
  assert.equal(receipts.markContinuationSubmission(runId, { ...identity, submissionState: "submitted" }), true);
  receipts.relinquishContinuationClaim(runId, identity);
  assert.equal(receipts.markContinuationSubmission(runId, { ...identity, submissionState: "unsent" }), false);
  assert.equal(pending(runId).submissionState, "submitted");
});

test("a rejected confirmed resend preserves uncertainty across bounded retries and restart", async () => {
  const id = "resend-taint", history = [], first = host(id, history, { accept: false });
  try {
    await first.start();
    store.completeRun(run(id), "failed");
    await waitFor(() => first.messages.length === 1);
    assert.equal(pending(id).submissionState, "submitted");
  } finally { first.stop(); }
  let attempts = 0;
  const second = host(id, history, { onSend() { attempts++; throw new Error("synchronous rejection"); } });
  try {
    await second.start(); second.settled(); await delay(400);
    assert.deepEqual(second.messages, []);
    assert.equal(second.state.confirms, 0);
    assert.equal(attempts, 0);
    await second.deliver(id);
    assert.equal(second.state.confirms, 1, "an uncertain record still requires confirmation");
    await waitFor(() => second.notifications.some(text => text.includes("attempt 3/3")));
    assert.equal(attempts, 3, "the confirmed resend keeps its bounded retry budget");
    assert.equal(pending(id).submissionState, "submitted",
      "a synchronously rejected resend must not erase prior uncertainty");
    second.settled(); await delay(350);
    assert.equal(attempts, 3, "exhausted retries stay exhausted in this runtime");
    assert.deepEqual(second.messages, []);
  } finally { second.stop(); }
  const third = host(id, history);
  try {
    await third.start(); third.settled(); await delay(400);
    assert.deepEqual(third.messages, [], "uncertainty must survive restart within the freshness window");
    third.state.confirm = false;
    await third.deliver(id);
    assert.equal(third.state.confirms, 1, "the tainted record still requires explicit confirmation");
    assert.deepEqual(third.messages, []);
    third.state.confirm = true;
    await third.deliver(id);
    assert.equal(third.messages.length, 1, "a confirmed handoff still delivers");
  } finally { third.stop(); }
});

test("held old results do not churn the continuation store at idle transitions", async (t) => {
  const id = "held-idle-churn", history = [], ids = [`${id}-a`, `${id}-b`, `${id}-c`];
  const first = host(id, history, { idle: false });
  try {
    await first.start();
    for (const runId of ids) store.completeRun(run(runId, id), "failed");
    await waitFor(() => first.cards.length === 3);
    for (const runId of ids) assert.equal(pending(runId)?.submissionState, "unsent");
  } finally { first.stop(); }
  const future = Date.now() + 48 * 60 * 60 * 1000;
  t.mock.method(Date, "now", () => future);
  const stateFile = join(storeDir, receipts.CONTINUATION_STATE_FILENAME);
  let writes = 0;
  const originalRename = fs.renameSync;
  // One-time retention normalization of expired delivered receipts under the
  // shifted clock is not idle churn; settle it before counting writes.
  receipts.loadPendingContinuationRecords({ storeDir });
  const spy = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === stateFile) writes++;
    return originalRename(from, to);
  });
  nodeModule.syncBuiltinESMExports();
  const second = host(id, history);
  try {
    await second.start();
    second.settled(); second.settled(); second.settled();
    assert.equal(writes, 0, "held records must not re-claim/re-release the store at every idle edge");
    assert.deepEqual(second.messages, []);
    for (const runId of ids) assert.equal(pending(runId)?.state, "pending", "the durable backlog survives");
    await second.deliver(ids[0]);
    assert.equal(second.messages.length, 1, "explicit old-result handoff still delivers");
    assert.equal(pending(ids[0]), undefined);
  } finally {
    spy.mock.restore(); nodeModule.syncBuiltinESMExports();
    second.stop();
  }
});
