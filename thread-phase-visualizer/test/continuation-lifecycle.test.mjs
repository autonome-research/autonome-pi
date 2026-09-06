import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-continuation-lifecycle-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
process.on("exit", () => rmSync(storeDir, { recursive: true, force: true }));
const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);
const { default: registerVisualizer } = await import("../index.ts");
const { STATUSES, completeRun, createRun } = await import("../lib/store.mjs");
const {
  CONTINUATION_STATE_FILENAME,
  CONTINUATION_TIMESTAMPS_FILENAME,
  DEFAULT_CONTINUATION_RETENTION_MS,
  continuedRunsFile,
  createContinuationClaimantId,
  discardPendingContinuation,
  persistContinuationClaim,
  relinquishContinuationClaims,
} = await import("../lib/continuation-store.mjs");
const { formatMarkedContinuation } = await import("../lib/continuation-message.mjs");
const { reserveSuccessor, commitSuccessor } = await import("../lib/chain-store.mjs");

function extensionHarness({ enqueueError, acknowledge = true, onSend } = {}) {
  const handlers = new Map();
  const userMessages = [];
  const customMessages = [];
  return {
    api: {
      registerMessageRenderer() {},
      registerTool() {},
      registerShortcut() {},
      on(name, handler) { handlers.set(name, handler); },
      sendMessage(message) { customMessages.push(message); },
      sendUserMessage(message, options) {
        if (enqueueError) throw enqueueError;
        userMessages.push({ message, options });
        onSend?.(message, options);
        if (acknowledge) {
          const persistedBranch = [{ type: "message", message: { role: "user", content: message } }];
          handlers.get("message_start")?.(
            { message: { role: "assistant", content: [] } },
            { hasUI: false, sessionManager: { getBranch: () => persistedBranch } },
          );
        }
      },
    },
    handlers,
    userMessages,
    customMessages,
  };
}

function sessionContext(branchEntries = [], allEntries = branchEntries, { idleState, hasUI = false, sessionId = "lifecycle-session" } = {}) {
  return {
    cwd: storeDir,
    hasUI,
    isIdle: () => idleState?.idle ?? true,
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branchEntries,
      getEntries: () => allEntries,
    },
  };
}

async function waitFor(predicate, message) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message);
    await delay(20);
  }
}

test("startup reconciles a pending post-enqueue crash against current-session history", async (t) => {
  const run = createRun({
    runId: "lifecycle-post-enqueue-crash",
    workflow: "lifecycle-reconcile",
    cwd: storeDir,
    metadata: { sessionId: "lifecycle-session", autoContinue: true },
  });
  completeRun(run);
  const crashedRuntime = createContinuationClaimantId();
  const claim = persistContinuationClaim(run.runId, { storeDir, claimantId: crashedRuntime });
  relinquishContinuationClaims({ storeDir, claimantId: crashedRuntime });

  const entries = [{
    type: "message",
    message: { role: "user", content: formatMarkedContinuation("continuation", claim.deliveryId) },
  }];
  const harness = extensionHarness();
  registerVisualizer(harness.api);
  const context = sessionContext(entries);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));

  assert.equal(harness.userMessages.length, 0, "history proof must prevent replay");
  const state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  assert.equal(state.records.find((record) => record.runId === run.runId)?.state, "delivered");
  assert.equal(state.records.find((record) => record.runId === run.runId)?.deliveryId, claim.deliveryId);
});

test("startup ignores continuation markers on abandoned branches", async (t) => {
  const run = createRun({
    runId: "lifecycle-abandoned-branch",
    workflow: "lifecycle-abandoned-branch",
    cwd: storeDir,
    metadata: { sessionId: "lifecycle-session", autoContinue: true },
  });
  completeRun(run);
  const crashedRuntime = createContinuationClaimantId();
  const claim = persistContinuationClaim(run.runId, { storeDir, claimantId: crashedRuntime });
  relinquishContinuationClaims({ storeDir, claimantId: crashedRuntime });
  const abandonedMarker = [{
    type: "message",
    message: { role: "user", content: formatMarkedContinuation("continuation", claim.deliveryId) },
  }];
  const harness = extensionHarness();
  registerVisualizer(harness.api);
  const context = sessionContext([], abandonedMarker);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));
  assert.equal(harness.userMessages.length, 1, "an abandoned-branch marker must not suppress active-branch replay");
});

test("fire-and-forget submission remains pending until message_start acknowledgement", async (t) => {
  const context = sessionContext();
  const harness = extensionHarness({ acknowledge: false });
  registerVisualizer(harness.api);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));

  const run = createRun({
    runId: "lifecycle-await-message-start",
    workflow: "lifecycle-await-message-start",
    cwd: storeDir,
    metadata: { sessionId: "lifecycle-session", autoContinue: true },
  });
  completeRun(run);
  await waitFor(() => harness.userMessages.length === 1, "continuation was not submitted");
  let state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  const pending = state.records.find((record) => record.runId === run.runId);
  assert.equal(pending.state, "pending");

  // User message_start fires before SessionManager persistence and must not
  // acknowledge delivery on its own.
  harness.handlers.get("message_start")({ message: { role: "user", content: harness.userMessages[0].message } }, context);
  state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  assert.equal(state.records.find((record) => record.runId === run.runId).state, "pending");

  const persistedContext = sessionContext([{
    type: "message",
    message: { role: "user", content: harness.userMessages[0].message },
  }]);
  harness.handlers.get("message_start")({ message: { role: "assistant", content: [] } }, persistedContext);
  state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  assert.equal(state.records.find((record) => record.runId === run.runId).state, "delivered");
});

test("background terminal policy continues failed runs but not cancelled runs", async (t) => {
  const context = sessionContext();
  const harness = extensionHarness();
  registerVisualizer(harness.api);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));

  const failed = createRun({
    runId: "lifecycle-background-failed",
    workflow: "background-failed",
    cwd: storeDir,
    metadata: { sessionId: "lifecycle-session", continuationMode: "terminal" },
  });
  completeRun(failed, STATUSES.FAILED);
  await waitFor(() => harness.userMessages.length === 1, "failed background run did not continue");
  assert.match(harness.userMessages[0].message, /workflow failed/i);
  assert.match(harness.userMessages[0].message, /Do not proceed as though the workflow succeeded/);

  const cancelled = createRun({
    runId: "lifecycle-background-cancelled",
    workflow: "background-cancelled",
    cwd: storeDir,
    metadata: { sessionId: "lifecycle-session", continuationMode: "terminal" },
  });
  completeRun(cancelled, STATUSES.CANCELLED);
  await delay(150);
  assert.equal(harness.userMessages.length, 1, "cancelled background run must not auto-continue");
});

test("session shutdown preserves an enqueue-failed pending record for replacement", async (t) => {
  const context = sessionContext();
  const failing = extensionHarness({ enqueueError: new Error("simulated enqueue failure") });
  registerVisualizer(failing.api);
  await failing.handlers.get("session_start")({}, context);

  const run = createRun({
    runId: "lifecycle-shutdown-relinquish",
    workflow: "lifecycle-relinquish",
    cwd: storeDir,
    metadata: { sessionId: "lifecycle-session", autoContinue: true },
  });
  completeRun(run);
  await waitFor(() => {
    const state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
    return state.records.some((record) => record.runId === run.runId && record.state === "pending");
  }, "failed enqueue did not leave durable pending work");

  failing.handlers.get("session_shutdown")({}, context);
  const afterShutdown = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  const pending = afterShutdown.records.find((record) => record.runId === run.runId);
  assert.equal(pending.state, "pending");
  assert.equal(pending.claimantId, undefined);
  assert.equal(pending.claimantPid, undefined);

  const replacement = extensionHarness();
  registerVisualizer(replacement.api);
  await replacement.handlers.get("session_start")({}, context);
  t.after(() => replacement.handlers.get("session_shutdown")({}, context));
  assert.equal(replacement.userMessages.length, 1);
});

test("synchronous submission rejection retries once and then unblocks later continuations", async (t) => {
  const sessionId = "lifecycle-sync-retry-session";
  const idleState = { idle: true };
  const context = sessionContext([], [], { idleState, sessionId });
  const harness = extensionHarness({ onSend: () => { idleState.idle = false; } });
  const submit = harness.api.sendUserMessage;
  let attempts = 0;
  harness.api.sendUserMessage = (...args) => {
    if (++attempts === 1) throw new Error("temporary synchronous rejection");
    submit(...args);
  };
  registerVisualizer(harness.api);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));
  completeRun(createRun({ runId: "lifecycle-sync-retry-first", workflow: "retry", cwd: storeDir, metadata: { sessionId, autoContinue: true } }));
  await waitFor(() => harness.userMessages.length === 1, "synchronous rejection was not retried");
  assert.equal(attempts, 2);
  completeRun(createRun({ runId: "lifecycle-sync-retry-second", workflow: "retry", cwd: storeDir, metadata: { sessionId, autoContinue: true } }));
  await waitFor(() => harness.customMessages.length === 2, "second completion was not observed");
  idleState.idle = true;
  harness.handlers.get("agent_settled")({}, context);
  assert.equal(harness.userMessages.length, 2);
});

test("synchronous submission retries are bounded without blocking later deliveries", async (t) => {
  const sessionId = "lifecycle-retry-bound-session";
  const context = sessionContext([], [], { sessionId });
  const harness = extensionHarness();
  const submit = harness.api.sendUserMessage;
  let failures = 0;
  harness.api.sendUserMessage = (message, options) => {
    if (message.includes("Run: lifecycle-retry-bound-failed")) {
      failures++;
      throw new Error("permanent synchronous rejection");
    }
    submit(message, options);
  };
  registerVisualizer(harness.api);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));
  const failedRun = createRun({ runId: "lifecycle-retry-bound-failed", workflow: "retry", cwd: storeDir, metadata: { sessionId, autoContinue: true } });
  completeRun(failedRun);
  await waitFor(() => failures === 3, "retry budget did not settle");
  completeRun(createRun({ runId: "lifecycle-retry-bound-next", workflow: "retry", cwd: storeDir, metadata: { sessionId, autoContinue: true } }));
  await waitFor(() => harness.userMessages.length === 1, "exhausted delivery blocked later work");
  completeRun(failedRun); // New event ID must not reset the same runtime's budget.
  await waitFor(() => harness.customMessages.length === 3, "duplicate terminal event was not observed");
  harness.handlers.get("agent_settled")({}, context);
  await delay(350);
  assert.equal(failures, 3);
  const state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  const pending = state.records.find((record) => record.runId === "lifecycle-retry-bound-failed");
  assert.equal(pending.state, "pending");
  assert.equal(pending.claimantId, undefined);
  discardPendingContinuation(pending.runId, { storeDir, deliveryId: pending.deliveryId, claimantId: createContinuationClaimantId() });
});

test("submission retry budget survives unknown successor eligibility and requeue", async (t) => {
  const sessionId = "lifecycle-retry-eligibility-session";
  const runId = "lifecycle-retry-eligibility-run";
  const context = sessionContext([], [], { sessionId });
  const harness = extensionHarness();
  const run = createRun({ runId, workflow: "retry", cwd: storeDir, metadata: { sessionId, continuationMode: "terminal" } });
  const successor = reserveSuccessor(runId, `${runId}-child`, { chainId: randomUUID() });
  let failures = 0;
  harness.api.sendUserMessage = () => {
    failures++;
    if (failures === 1) writeFileSync(successor.file, "{");
    throw new Error("synchronous rejection across eligibility transition");
  };
  registerVisualizer(harness.api);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));
  completeRun(run);
  await waitFor(() => failures === 1, "first rejection did not occur");
  await delay(200); // The scheduled retry revalidates unknown state and leaves the queue.
  assert.equal(failures, 1, "unknown eligibility must suppress submission");
  rmSync(successor.file);
  harness.handlers.get("agent_settled")({}, context);
  await waitFor(() => failures >= 3, "pending work was not retried after eligibility recovered");
  await delay(350);
  assert.equal(failures, 3, "requeue must retain the first failure in the session budget");
  const state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  const pending = state.records.find((record) => record.runId === runId);
  assert.equal(pending.state, "pending");
  assert.equal(pending.claimantId, undefined);
  discardPendingContinuation(runId, { storeDir, deliveryId: pending.deliveryId, claimantId: createContinuationClaimantId() });
});

test("registered lifecycle handlers persist continuation deduplication across extension reloads", async (t) => {
  const context = sessionContext();
  const first = extensionHarness();
  registerVisualizer(first.api);
  await first.handlers.get("session_start")({}, context);
  t.after(() => first.handlers.get("session_shutdown")({}, context));

  const run = createRun({
    runId: "lifecycle-reload-run",
    workflow: "lifecycle-reload",
    cwd: storeDir,
    metadata: { sessionId: "lifecycle-session", autoContinue: true },
  });
  completeRun(run);
  await waitFor(() => first.userMessages.length === 1, "first extension did not deliver continuation");
  assert.equal(first.customMessages.length, 1);

  first.handlers.get("session_shutdown")({}, context);
  const persistedAfterFirst = JSON.parse(readFileSync(continuedRunsFile(storeDir), "utf8"));
  assert.equal(persistedAfterFirst.includes(run.runId), true);
  assert.ok(persistedAfterFirst.every((runId) => typeof runId === "string"));

  const reloaded = extensionHarness();
  registerVisualizer(reloaded.api);
  await reloaded.handlers.get("session_start")({}, context);
  t.after(() => reloaded.handlers.get("session_shutdown")({}, context));

  // A producer can append a second terminal envelope with a fresh eventId. The
  // reloaded lifecycle handler observes it, but the durable claim prevents a
  // second automatic continuation.
  completeRun(run);
  await waitFor(() => reloaded.customMessages.length === 1, "reloaded extension did not process the new terminal event");
  await delay(50);
  assert.equal(reloaded.userMessages.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(continuedRunsFile(storeDir), "utf8")), persistedAfterFirst);

  // Advance beyond retention while this extension instance remains live. The
  // next eligible terminal event must consult the timestamp-aware atomic store,
  // rather than being suppressed by the set loaded at session_start.
  const realNow = Date.now;
  const firstClaimedAt = Date.parse(JSON.parse(readFileSync(join(storeDir, CONTINUATION_TIMESTAMPS_FILENAME), "utf8"))[run.runId]);
  Date.now = () => firstClaimedAt + DEFAULT_CONTINUATION_RETENTION_MS + 1;
  t.after(() => { Date.now = realNow; });
  completeRun(run);
  await waitFor(() => reloaded.customMessages.length === 2, "live extension did not process the post-expiry terminal event");
  await waitFor(() => reloaded.userMessages.length === 1, "expired continuation claim was not renewed without restart");
  // Renewal also prunes unrelated delivered records that expired under the
  // advanced clock; the renewed run remains the sole retained mirror entry.
  assert.deepEqual(JSON.parse(readFileSync(continuedRunsFile(storeDir), "utf8")), [run.runId]);
  const renewedTimestamps = JSON.parse(readFileSync(join(storeDir, CONTINUATION_TIMESTAMPS_FILENAME), "utf8"));
  assert.equal(Date.parse(renewedTimestamps[run.runId]), Date.now());
});

test("a continuation deferred while busy retries on agent_settled", async (t) => {
  const idleState = { idle: false };
  const sessionId = "lifecycle-busy-session";
  const context = sessionContext([], [], { idleState, sessionId });
  const harness = extensionHarness({ onSend: () => { idleState.idle = false; } });
  registerVisualizer(harness.api);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));

  const run = createRun({
    runId: "lifecycle-busy-then-idle",
    workflow: "lifecycle-busy-then-idle",
    cwd: storeDir,
    metadata: { sessionId, autoContinue: true },
  });
  completeRun(run);
  await waitFor(() => harness.customMessages.length === 1, "busy completion event was not observed");
  assert.equal(harness.userMessages.length, 0, "a busy agent must not receive a queued follow-up continuation");
  const deferredState = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  const deferred = deferredState.records.find((record) => record.runId === run.runId);
  assert.equal(deferred?.state, "pending", "busy deferral must be durable before the idle edge");
  assert.equal(deferred.claimantId, undefined, "an unsent delivery must not retain an active claim");

  idleState.idle = true;
  harness.handlers.get("agent_settled")({}, context);
  await waitFor(() => harness.userMessages.length === 1, "idle settlement did not retry the deferred continuation");
  assert.match(harness.userMessages[0].message, new RegExp(`Run: ${run.runId}`));
});

test("multiple pending continuations are claimed and sent one at a time", async (t) => {
  const sessionId = "lifecycle-serialized-session";
  const runIds = ["lifecycle-serialized-one", "lifecycle-serialized-two"];
  for (const runId of runIds) {
    const run = createRun({
      runId,
      workflow: runId,
      cwd: storeDir,
      metadata: { sessionId, autoContinue: true },
    });
    completeRun(run);
    const crashedRuntime = createContinuationClaimantId();
    persistContinuationClaim(runId, { storeDir, claimantId: crashedRuntime });
    relinquishContinuationClaims({ storeDir, claimantId: crashedRuntime });
  }

  const idleState = { idle: false };
  const context = sessionContext([], [], { idleState, sessionId });
  const harness = extensionHarness({ onSend: () => { idleState.idle = false; } });
  registerVisualizer(harness.api);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));
  assert.equal(harness.userMessages.length, 0);

  idleState.idle = true;
  harness.handlers.get("agent_settled")({}, context);
  assert.equal(harness.userMessages.length, 1, "the first idle edge must submit only one continuation");

  let state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  const afterFirst = runIds.map((runId) => state.records.find((record) => record.runId === runId));
  assert.equal(afterFirst.filter((record) => record.state === "delivered").length, 1);
  assert.equal(afterFirst.filter((record) => record.state === "pending" && !record.claimantId).length, 1,
    "the later continuation must remain unclaimed until the first turn settles");

  idleState.idle = true;
  harness.handlers.get("agent_settled")({}, context);
  assert.equal(harness.userMessages.length, 2);
  assert.equal(runIds.every((runId) => harness.userMessages.some(({ message }) => message.includes(`Run: ${runId}`))), true);

  idleState.idle = true;
  harness.handlers.get("agent_settled")({}, context);
  await delay(50);
  assert.equal(harness.userMessages.length, 2, "repeated idle notifications must not duplicate a claim");
  state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  assert.equal(runIds.every((runId) => state.records.find((record) => record.runId === runId)?.state === "delivered"), true);
});

test("busy deferred work survives restart after the startup freshness window", async (t) => {
  const sessionId = "lifecycle-durable-busy-session";
  const idleState = { idle: false };
  const context = sessionContext([], [], { idleState, sessionId });
  const harness = extensionHarness();
  registerVisualizer(harness.api);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));
  const run = createRun({
    runId: "lifecycle-durable-busy-restart",
    workflow: "lifecycle-durable-busy-restart",
    cwd: storeDir,
    metadata: { sessionId, autoContinue: true },
  });
  completeRun(run);
  await waitFor(() => harness.customMessages.length === 1, "busy completion was not observed");
  harness.handlers.get("session_shutdown")({}, context);

  const future = Date.now() + DEFAULT_CONTINUATION_RETENTION_MS * 2;
  t.mock.method(Date, "now", () => future);
  idleState.idle = true;
  const reloaded = extensionHarness();
  registerVisualizer(reloaded.api);
  await reloaded.handlers.get("session_start")({}, context);
  t.after(() => reloaded.handlers.get("session_shutdown")({}, context));
  assert.equal(reloaded.userMessages.length, 1, "old pending work must survive even when workflow_end is no longer fresh");
  assert.match(reloaded.userMessages[0].message, new RegExp(`Run: ${run.runId}`));
});

test("a later completion does not release an in-flight unacknowledged claim", async (t) => {
  const sessionId = "lifecycle-inflight-session";
  const idleState = { idle: true };
  const context = sessionContext([], [], { idleState, sessionId });
  const harness = extensionHarness({ acknowledge: false, onSend: () => { idleState.idle = false; } });
  registerVisualizer(harness.api);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));
  const first = createRun({
    runId: "lifecycle-inflight-first", workflow: "inflight", cwd: storeDir,
    metadata: { sessionId, autoContinue: true },
  });
  completeRun(first);
  await waitFor(() => harness.userMessages.length === 1, "first continuation was not submitted");
  const second = createRun({
    runId: "lifecycle-inflight-second", workflow: "inflight", cwd: storeDir,
    metadata: { sessionId, autoContinue: true },
  });
  completeRun(second);
  await waitFor(() => harness.customMessages.length === 2, "second completion was not observed");
  const state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  const firstRecord = state.records.find((record) => record.runId === first.runId);
  const secondRecord = state.records.find((record) => record.runId === second.runId);
  assert.equal(firstRecord.state, "pending");
  assert.ok(firstRecord.claimantId, "the unacknowledged send must retain ownership");
  assert.equal(secondRecord.state, "pending");
  assert.equal(secondRecord.claimantId, undefined);
  const competingRuntime = createContinuationClaimantId();
  assert.equal(persistContinuationClaim(first.runId, { storeDir, retryPending: true, claimantId: competingRuntime }).claimed, false);

  idleState.idle = true;
  harness.handlers.get("agent_settled")({}, context);
  assert.equal(harness.userMessages.length, 1, "idle alone must not overtake an unacknowledged send");
  const branch = [{ type: "message", message: { role: "user", content: harness.userMessages[0].message } }];
  harness.handlers.get("message_start")(
    { message: { role: "assistant", content: [] } },
    sessionContext(branch, branch, { idleState, sessionId }),
  );
  harness.handlers.get("agent_settled")({}, context);
  assert.equal(harness.userMessages.length, 2, "the next continuation starts only after acknowledgement and idle");
});

test("shutdown cancels a startup-delayed continuation", async () => {
  const sessionId = "lifecycle-shutdown-delay-session";
  const run = createRun({
    runId: "lifecycle-shutdown-delayed",
    workflow: "lifecycle-shutdown-delayed",
    cwd: storeDir,
    metadata: { sessionId, autoContinue: true },
  });
  completeRun(run);
  const crashedRuntime = createContinuationClaimantId();
  persistContinuationClaim(run.runId, { storeDir, claimantId: crashedRuntime });
  relinquishContinuationClaims({ storeDir, claimantId: crashedRuntime });

  const context = sessionContext([], [], { hasUI: true, sessionId });
  const harness = extensionHarness();
  registerVisualizer(harness.api);
  await harness.handlers.get("session_start")({}, context);
  harness.handlers.get("session_shutdown")({}, context);
  await delay(500);

  assert.equal(harness.userMessages.length, 0);
  const state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  const pending = state.records.find((record) => record.runId === run.runId);
  assert.equal(pending.state, "pending");
  assert.equal(pending.claimantId, undefined);
});

test("startup delay revalidates cancellation before sending", async (t) => {
  const sessionId = "lifecycle-cancellation-session";
  const run = createRun({
    runId: "lifecycle-delayed-cancelled",
    workflow: "lifecycle-delayed-cancelled",
    cwd: storeDir,
    metadata: { sessionId, autoContinue: true },
  });
  completeRun(run);
  const crashedRuntime = createContinuationClaimantId();
  persistContinuationClaim(run.runId, { storeDir, claimantId: crashedRuntime });
  relinquishContinuationClaims({ storeDir, claimantId: crashedRuntime });

  const context = sessionContext([], [], { hasUI: true, sessionId });
  const harness = extensionHarness();
  registerVisualizer(harness.api);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));
  completeRun(run, STATUSES.CANCELLED);
  await delay(500);

  assert.equal(harness.userMessages.some(({ message }) => message.includes(`Run: ${run.runId}`)), false,
    "a run cancelled during startup defer must remain suppressed");
  const state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  assert.equal(state.records.some((record) => record.runId === run.runId), false,
    "permanently cancelled pending work must stop consuming backlog capacity");
});

test("startup removes pending records for cancelled runs and committed chain parents", async (t) => {
  const sessionId = "lifecycle-ineligible-session";
  const runIds = ["lifecycle-ineligible-cancelled", "lifecycle-ineligible-chained"];
  for (const runId of runIds) {
    const run = createRun({ runId, workflow: "ineligible", cwd: storeDir, metadata: { sessionId, continuationMode: "terminal" } });
    completeRun(run, runId.endsWith("cancelled") ? STATUSES.CANCELLED : STATUSES.SUCCESS);
    const claimantId = createContinuationClaimantId();
    persistContinuationClaim(runId, { storeDir, claimantId });
    relinquishContinuationClaims({ storeDir, claimantId });
  }
  commitSuccessor(reserveSuccessor(runIds[1], "lifecycle-ineligible-child", { chainId: randomUUID() }));
  const context = sessionContext([], [], { sessionId });
  const harness = extensionHarness();
  registerVisualizer(harness.api);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));
  assert.equal(harness.userMessages.length, 0);
  const state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  assert.equal(state.records.some((record) => runIds.includes(record.runId)), false);
});

test("unknown successor state preserves pending work until eligibility can be revalidated", async (t) => {
  for (const repairedState of ["committed", "absent"]) {
    const sessionId = `lifecycle-unknown-successor-${repairedState}`;
    const runId = sessionId;
    const context = sessionContext([], [], { sessionId });
    const harness = extensionHarness();
    registerVisualizer(harness.api);
    await harness.handlers.get("session_start")({}, context);
    t.after(() => harness.handlers.get("session_shutdown")({}, context));
    const run = createRun({ runId, workflow: "unknown-successor", cwd: storeDir, metadata: { sessionId, continuationMode: "terminal" } });
    commitSuccessor(reserveSuccessor(runId, `${runId}-child`, { chainId: randomUUID() }));
    const successorFile = join(storeDir, "chains", "successors", `${runId}.json`);
    const committed = readFileSync(successorFile, "utf8");
    writeFileSync(successorFile, "{");
    completeRun(run);
    await waitFor(() => harness.customMessages.length === 1, "completion with corrupt successor was not observed");
    harness.handlers.get("agent_settled")({}, context);
    assert.equal(harness.userMessages.length, 0, "unknown successor state must fail closed");
    let records = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8")).records;
    assert.equal(records.find((record) => record.runId === runId)?.state, "pending", "unknown is not permanent suppression");

    if (repairedState === "committed") writeFileSync(successorFile, committed);
    else rmSync(successorFile);
    harness.handlers.get("agent_settled")({}, context);
    records = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8")).records;
    assert.equal(harness.userMessages.length, repairedState === "committed" ? 0 : 1);
    assert.equal(records.some((record) => record.runId === runId && record.state === "pending"), false);
    harness.handlers.get("session_shutdown")({}, context);
  }
});

test("startup delay does not send after durable claim ownership changes", async (t) => {
  const sessionId = "lifecycle-owner-change-session";
  const run = createRun({
    runId: "lifecycle-delayed-owner-change",
    workflow: "lifecycle-delayed-owner-change",
    cwd: storeDir,
    metadata: { sessionId, autoContinue: true },
  });
  completeRun(run);
  const crashedRuntime = createContinuationClaimantId();
  persistContinuationClaim(run.runId, { storeDir, claimantId: crashedRuntime });
  relinquishContinuationClaims({ storeDir, claimantId: crashedRuntime });

  const context = sessionContext([], [], { hasUI: true, sessionId });
  const harness = extensionHarness();
  registerVisualizer(harness.api);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));

  const competingRuntime = createContinuationClaimantId();
  const competing = persistContinuationClaim(run.runId, { storeDir, retryPending: true, claimantId: competingRuntime });
  assert.equal(competing.claimed, true);
  t.after(() => relinquishContinuationClaims({ storeDir, claimantId: competingRuntime }));
  await delay(500);

  assert.equal(harness.userMessages.some(({ message }) => message.includes(`Run: ${run.runId}`)), false,
    "a delayed sender must not use a claim now owned by another runtime");
  const state = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  assert.equal(state.records.find((record) => record.runId === run.runId)?.claimantId, competingRuntime);
});
