import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  persistContinuationClaim,
  relinquishContinuationClaims,
} = await import("../lib/continuation-store.mjs");
const { formatMarkedContinuation } = await import("../lib/continuation-message.mjs");

function extensionHarness({ enqueueError, acknowledge = true } = {}) {
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

function sessionContext(branchEntries = [], allEntries = branchEntries) {
  return {
    cwd: storeDir,
    hasUI: false,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "lifecycle-session",
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

test("session shutdown relinquishes an enqueue-failed claim for same-process replacement", async (t) => {
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
    return state.records.some((record) => record.runId === run.runId && record.state === "pending" && record.claimantId);
  }, "failed enqueue did not leave an owned pending claim");

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
