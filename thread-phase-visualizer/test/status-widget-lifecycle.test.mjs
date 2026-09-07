import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-status-widget-lifecycle-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
process.env.PI_THREAD_PHASE_STATUS_REFRESH_MS = "25";
process.on("exit", () => rmSync(storeDir, { recursive: true, force: true }));

const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);

const { default: registerVisualizer } = await import("../index.ts");
const { createWorkflowFooterAnimator } = await import("../components/status-widget.ts");
const { completeRun, createRun } = await import("../lib/store.mjs");

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(message);
}

function extensionHarness() {
  const handlers = new Map();
  const widgets = [];
  const statuses = [];
  return {
    handlers,
    widgets,
    statuses,
    api: {
      registerMessageRenderer() {},
      registerTool() {},
      registerShortcut() {},
      on(name, handler) { handlers.set(name, handler); },
      sendMessage() {},
      sendUserMessage() {},
    },
  };
}

function contextFor(harness, sessionId, hasUI = true) {
  return {
    cwd: storeDir,
    mode: hasUI ? "tui" : "json",
    hasUI,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
    },
    ui: {
      setWidget(id, value, options) { harness.widgets.push({ id, value, options }); },
      setStatus(id, value) { harness.statuses.push({ id, value }); },
      notify() {},
    },
  };
}

function addLiveRun(runId, sessionId) {
  return createRun({
    runId,
    workflow: `private-name-${runId}`,
    cwd: storeDir,
    metadata: {
      pid: process.pid,
      sessionId,
      launchSource: "background",
      cwdAtLaunch: storeDir,
    },
  });
}

function nonemptyStatusValues(harness) {
  return harness.statuses.filter(({ id, value }) => id === "thread-phase" && value !== undefined).map(({ value }) => value);
}

function assertGlyphFooter(value, expectedCount) {
  assert.match(value, /^[◐◓◑◒](?: [◐◓◑◒])*$/);
  assert.equal(value.split(" ").length, expectedCount);
  assert.doesNotMatch(value, /WF|workflow|private-name|\d/);
}

test("footer animator changes one staggered glyph per cached workflow without refreshing", async () => {
  const statuses = [];
  const widgets = [];
  let refreshes = 0;
  const animator = createWorkflowFooterAnimator({
    setStatus: (value) => statuses.push(value),
    clearWidget: () => widgets.push(undefined),
    intervalMs: 15,
  });
  const refresh = () => {
    refreshes++;
    animator.setWorkflowIds(["a", "b", "c", "d", "e"]);
  };

  refresh();
  assert.equal(statuses.at(-1), "◐ ◓ ◑ ◒ ◐", "workflow glyphs must start with staggered phases");
  await waitFor(() => new Set(statuses.filter(Boolean)).size >= 3, "footer glyphs did not change phase");
  assert.equal(refreshes, 1, "animation must not invoke store refreshes");
  assert.ok(statuses.filter(Boolean).every((value) => {
    assertGlyphFooter(value, 5);
    return true;
  }));
  assert.ok(widgets.length >= 1 && widgets.every((value) => value === undefined), "footer lifecycle must only clear the legacy widget");

  animator.setWorkflowIds([]);
  assert.equal(statuses.at(-1), undefined);
  const callsAtIdle = statuses.length;
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.equal(statuses.length, callsAtIdle, "idle footer kept animating");
  animator.dispose();
});

test("footer keeps surviving workflow order and state while appending and removing IDs", () => {
  const statuses = [];
  const animator = createWorkflowFooterAnimator({
    setStatus: (value) => statuses.push(value),
    clearWidget() {},
    intervalMs: 60_000,
  });

  animator.setWorkflowIds(["a", "b", "c", "d", "e"]);
  assert.equal(statuses.at(-1), "◐ ◓ ◑ ◒ ◐");
  animator.setWorkflowIds(["e", "c", "a", "d", "b"]);
  assert.equal(statuses.at(-1), "◐ ◓ ◑ ◒ ◐", "recency reordering must not reorder surviving IDs");
  animator.setWorkflowIds(["e", "b", "d", "new"]);
  assert.equal(statuses.at(-1), "◓ ◒ ◐ ◓", "survivors keep order/state and a new workflow appends");
  animator.dispose();
});

test("footer shows one glyph for each of more than three scoped live runs", async (t) => {
  const sessionId = "status-footer-multiple";
  for (const suffix of ["a", "b", "c", "d", "e"]) addLiveRun(`status-footer-multiple-${suffix}`, sessionId);
  addLiveRun("status-footer-out-of-scope", "another-session");
  const harness = extensionHarness();
  registerVisualizer(harness.api);
  const context = contextFor(harness, sessionId);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));

  await waitFor(() => new Set(nonemptyStatusValues(harness)).size >= 2, "compact footer did not animate");
  assert.ok(nonemptyStatusValues(harness).every((value) => {
    assertGlyphFooter(value, 5);
    return true;
  }));
  assert.ok(harness.widgets.length >= 1 && harness.widgets.every(({ value }) => value === undefined), "a nonempty below-editor widget was rendered");
});

test("footer appends new runs, removes terminal runs, then clears and stops", async (t) => {
  const sessionId = "status-footer-terminal";
  const first = addLiveRun("status-footer-terminal-first", sessionId);
  const harness = extensionHarness();
  registerVisualizer(harness.api);
  const context = contextFor(harness, sessionId);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));

  await waitFor(() => /^[◐◓◑◒]$/.test(harness.statuses.at(-1)?.value || ""), "initial workflow did not appear");
  const second = addLiveRun("status-footer-terminal-second", sessionId);
  await waitFor(() => /^[◐◓◑◒] [◐◓◑◒]$/.test(harness.statuses.at(-1)?.value || ""), "new workflow was not appended");
  completeRun(first, "success");
  await waitFor(() => /^[◐◓◑◒]$/.test(harness.statuses.at(-1)?.value || ""), "terminal workflow was not removed");
  completeRun(second, "success");
  await waitFor(() => harness.statuses.at(-1)?.value === undefined, "terminal workflows remained in the footer");
  const callsAtIdle = harness.statuses.length;
  await new Promise((resolveWait) => setTimeout(resolveWait, 180));
  assert.equal(harness.statuses.length, callsAtIdle, "terminal workflow animation did not stop");
  assert.ok(harness.widgets.every(({ value }) => value === undefined));
});

test("footer hides and stops after a live process becomes stale without another store event", { skip: process.platform === "win32" && "PID liveness projection differs on Windows", timeout: 8_000 }, async (t) => {
  const worker = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise((resolveSpawn, rejectSpawn) => {
    worker.once("spawn", resolveSpawn);
    worker.once("error", rejectSpawn);
  });
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill("SIGTERM");
      await new Promise((resolveClose) => worker.once("close", resolveClose));
    }
  });

  createRun({
    runId: "status-footer-live-process",
    workflow: "status-footer-live-process",
    cwd: storeDir,
    metadata: {
      pid: worker.pid,
      sessionId: "status-footer-process-session",
      launchSource: "background",
      cwdAtLaunch: storeDir,
    },
  });

  const harness = extensionHarness();
  registerVisualizer(harness.api);
  const context = contextFor(harness, "status-footer-process-session");
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));

  await waitFor(() => nonemptyStatusValues(harness).some((value) => /^[◐◓◑◒]$/.test(value)), "live workflow never appeared in the footer");
  assert.ok(harness.widgets.every(({ value }) => value === undefined));

  worker.kill("SIGTERM");
  await new Promise((resolveClose) => worker.once("close", resolveClose));
  await waitFor(() => harness.statuses.at(-1)?.value === undefined, "stale workflow remained in the footer after its process exited");
  const callsAtIdle = harness.statuses.length;
  await new Promise((resolveWait) => setTimeout(resolveWait, 180));
  assert.equal(harness.statuses.length, callsAtIdle, "stale workflow animation did not stop");
});

test("non-UI sessions do not start footer animation", async (t) => {
  const sessionId = "status-footer-no-ui";
  addLiveRun("status-footer-no-ui-run", sessionId);
  const harness = extensionHarness();
  registerVisualizer(harness.api);
  const context = contextFor(harness, sessionId, false);
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));

  await new Promise((resolveWait) => setTimeout(resolveWait, 160));
  assert.deepEqual(harness.statuses, []);
  assert.deepEqual(harness.widgets, []);
});

test("RPC and other non-TUI modes never animate even when hasUI is true", async (t) => {
  for (const mode of ["rpc", "json", "print", undefined]) {
    const sessionId = `status-footer-mode-${mode}`;
    addLiveRun(`${sessionId}-run`, sessionId);
    const harness = extensionHarness();
    registerVisualizer(harness.api);
    const context = { ...contextFor(harness, sessionId), mode };
    await harness.handlers.get("session_start")({}, context);
    t.after(() => harness.handlers.get("session_shutdown")({}, context));
    await new Promise((resolveWait) => setTimeout(resolveWait, 160));
    assert.deepEqual(harness.statuses, [], `${mode} must not receive spinner updates`);
    assert.deepEqual(harness.widgets, []);
    await harness.handlers.get("session_shutdown")({}, context);
  }
});

test("repeated session_start and shutdown dispose old footer callbacks", async () => {
  addLiveRun("status-footer-first-run", "status-footer-first");
  addLiveRun("status-footer-second-run", "status-footer-second");
  const harness = extensionHarness();
  registerVisualizer(harness.api);
  const first = contextFor(harness, "status-footer-first");
  const secondHarness = { ...harness, widgets: [], statuses: [] };
  const second = contextFor(secondHarness, "status-footer-second");

  await harness.handlers.get("session_start")({}, first);
  await waitFor(() => nonemptyStatusValues(harness).length > 0, "first footer did not start");
  await harness.handlers.get("session_start")({}, second);
  await waitFor(() => nonemptyStatusValues(secondHarness).length > 0, "replacement footer did not start");
  const oldCalls = harness.statuses.length;
  await new Promise((resolveWait) => setTimeout(resolveWait, 160));
  assert.equal(harness.statuses.length, oldCalls, "replaced footer updated its stale context");

  await harness.handlers.get("session_shutdown")({}, second);
  const replacementCalls = secondHarness.statuses.length;
  await new Promise((resolveWait) => setTimeout(resolveWait, 160));
  assert.equal(secondHarness.statuses.length, replacementCalls, "shutdown footer kept animating");
  assert.equal(secondHarness.statuses.at(-1)?.value, undefined);
  assert.ok([...harness.widgets, ...secondHarness.widgets].every(({ value }) => value === undefined));
});
