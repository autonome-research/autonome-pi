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
const { completeRun, createRun } = await import("../lib/store.mjs");
const { CONTINUATION_TIMESTAMPS_FILENAME, DEFAULT_CONTINUATION_RETENTION_MS, continuedRunsFile } = await import("../lib/continuation-store.mjs");

function extensionHarness() {
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
      sendUserMessage(message, options) { userMessages.push({ message, options }); },
    },
    handlers,
    userMessages,
    customMessages,
  };
}

function sessionContext() {
  return {
    cwd: storeDir,
    hasUI: false,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "lifecycle-session" },
  };
}

async function waitFor(predicate, message) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message);
    await delay(20);
  }
}

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
  assert.deepEqual(persistedAfterFirst, [run.runId]);
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
  assert.deepEqual(JSON.parse(readFileSync(continuedRunsFile(storeDir), "utf8")), [run.runId]);
  const renewedTimestamps = JSON.parse(readFileSync(join(storeDir, CONTINUATION_TIMESTAMPS_FILENAME), "utf8"));
  assert.equal(Date.parse(renewedTimestamps[run.runId]), Date.now());
});
