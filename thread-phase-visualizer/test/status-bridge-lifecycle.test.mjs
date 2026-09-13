import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(join(tmpdir(), "thread-phase-status-bridge-lifecycle-"));
const storeDir = join(testRoot, "store");
const bridgeRoot = join(testRoot, "bridge");
const otherCwd = join(testRoot, "other-cwd");
mkdirSync(otherCwd, { recursive: true });
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
process.env.PI_THREAD_PHASE_STATUS_BRIDGE = "1";
process.env.PI_THREAD_PHASE_STATUS_BRIDGE_DIR = bridgeRoot;
process.env.PI_THREAD_PHASE_STATUS_REFRESH_MS = "25";
delete process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND;
delete process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND;
process.on("exit", () => rmSync(testRoot, { recursive: true, force: true }));

const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);
const { default: registerVisualizer } = await import("../index.ts");
const { INDEX_FILE, STATUSES, completeRun, createRun, emit, requestCancellation } = await import("../lib/store.mjs");
const { deriveStatusBridgeScopeId } = await import("../lib/status-bridge.mjs");

function harness() {
  const handlers = new Map();
  const statuses = [];
  return {
    handlers,
    statuses,
    api: {
      registerMessageRenderer() {}, registerTool() {}, registerShortcut() {}, registerCommand() {},
      on(name, handler) { handlers.set(name, handler); },
      sendMessage() {}, sendUserMessage() {},
    },
  };
}

function context(sessionId, mode = "tui", cwd = testRoot, statuses) {
  return {
    cwd,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    ui: { setWidget() {}, setStatus(id, value) { statuses?.push({ id, value }); }, notify() {} },
  };
}

function publisherDirectories(root, sessionId) {
  const directory = join(root, "v1", "scopes", deriveStatusBridgeScopeId(sessionId), "publishers");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).map((name) => join(directory, name));
}

function snapshot(root, sessionId) {
  const directories = publisherDirectories(root, sessionId);
  assert.equal(directories.length, 1, `expected one publisher for ${sessionId}`);
  return JSON.parse(readFileSync(join(directories[0], "snapshot.json"), "utf8"));
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function ownedRun(runId, sessionId, cwd = testRoot) {
  return createRun({
    runId,
    workflow: `private-${runId}`,
    cwd,
    metadata: { sessionId, pid: process.pid, cwdAtLaunch: cwd, launchSource: "background" },
  });
}

test("lifecycle publishes strict session ownership across cwd with distinct real outcomes", async () => {
  const sessionId = "bridge-lifecycle-owner";
  const foreignSession = "bridge-lifecycle-foreign";
  const active = ownedRun("bridge-lifecycle-active", sessionId, otherCwd);
  ownedRun("bridge-lifecycle-foreign-run", foreignSession, testRoot);
  const h = harness();
  registerVisualizer(h.api);
  const ctx = context(sessionId);
  await h.handlers.get("session_start")({}, ctx);

  let current = snapshot(bridgeRoot, sessionId);
  assert.equal(current.source.state, "current");
  assert.equal(current.counts.running, 1, "same-session different-cwd run must be included");
  assert.equal(current.observation.observedRuns, 1, "foreign same-cwd run must be excluded");

  h.handlers.get("user_bash")({ command: `cd '${otherCwd}'`, cwd: testRoot }, ctx);
  await waitFor(() => snapshot(bridgeRoot, sessionId).counts.running === 1, "owned run disappeared after cwd change");

  const success = ownedRun("bridge-lifecycle-success", sessionId);
  const failure = ownedRun("bridge-lifecycle-failure", sessionId);
  const cancelled = ownedRun("bridge-lifecycle-cancelled", sessionId);
  const phaseError = ownedRun("bridge-lifecycle-phase-error", sessionId);
  const requested = ownedRun("bridge-lifecycle-request-only", sessionId);
  completeRun(success, STATUSES.SUCCESS);
  completeRun(failure, STATUSES.FAILED);
  completeRun(cancelled, STATUSES.CANCELLED);
  emit(phaseError, { type: "phase_end", phase: "private-phase", status: STATUSES.FAILED, error: new Error("private error") });
  requestCancellation(requested.runId);

  current = await waitFor(() => {
    const value = snapshot(bridgeRoot, sessionId);
    return value.counts.successRecent === 1 && value.counts.failureRecent === 1 && value.counts.cancelledRecent === 1 ? value : undefined;
  }, "terminal outcomes were not published distinctly");
  assert.equal(current.counts.running, 2, "request-only cancellation remains running alongside the original active run");
  assert.equal(current.counts.unknownActive, 1, "phase error projection is nonterminal unknown, not failure");
  assert.equal(current.counts.failureRecent, 1);
  assert.equal(current.counts.cancelledRecent, 1);
  assert.equal(JSON.stringify(current).includes(sessionId), false);
  assert.equal(JSON.stringify(current).includes("private-"), false);

  completeRun(active, STATUSES.SUCCESS);
  await waitFor(() => snapshot(bridgeRoot, sessionId).counts.running === 2, "active completion was not observed");
  await h.handlers.get("session_shutdown")({}, ctx);
  assert.deepEqual(publisherDirectories(bridgeRoot, sessionId), []);
});

test("switch, reload, shutdown, and parallel hosts isolate publisher directories", async () => {
  const firstSession = "bridge-switch-first";
  const secondSession = "bridge-switch-second";
  const h = harness();
  registerVisualizer(h.api);
  const firstContext = context(firstSession, "rpc");
  const secondContext = context(secondSession, "rpc");
  await h.handlers.get("session_start")({}, firstContext);
  const firstDirectory = publisherDirectories(bridgeRoot, firstSession)[0];
  assert.ok(firstDirectory);
  await h.handlers.get("session_start")({}, secondContext);
  assert.equal(existsSync(firstDirectory), false, "replacement start retained old publisher");
  assert.equal(publisherDirectories(bridgeRoot, secondSession).length, 1);
  await h.handlers.get("session_shutdown")({}, secondContext);

  const reloadSession = "bridge-reload-parallel";
  const left = harness();
  const right = harness();
  registerVisualizer(left.api);
  registerVisualizer(right.api);
  const reloadContext = context(reloadSession, "rpc");
  await left.handlers.get("session_start")({}, reloadContext);
  await right.handlers.get("session_start")({}, reloadContext);
  const both = publisherDirectories(bridgeRoot, reloadSession);
  assert.equal(both.length, 2);
  await left.handlers.get("session_shutdown")({ reason: "reload" }, reloadContext);
  assert.equal(publisherDirectories(bridgeRoot, reloadSession).length, 1, "one reload cleaned another host's publisher");
  assert.ok(existsSync(join(publisherDirectories(bridgeRoot, reloadSession)[0], "snapshot.json")));
  await right.handlers.get("session_shutdown")({ reason: "quit" }, reloadContext);
  assert.deepEqual(publisherDirectories(bridgeRoot, reloadSession), []);
});

test("disabled and print/JSON sessions create no bridge roots or bridge refresh resources", async () => {
  const originalRoot = process.env.PI_THREAD_PHASE_STATUS_BRIDGE_DIR;
  const disabledRoot = join(testRoot, "disabled-bridge");
  process.env.PI_THREAD_PHASE_STATUS_BRIDGE_DIR = disabledRoot;
  delete process.env.PI_THREAD_PHASE_STATUS_BRIDGE;
  const disabled = harness();
  registerVisualizer(disabled.api);
  const disabledContext = context("disabled-session", "rpc");
  await disabled.handlers.get("session_start")({}, disabledContext);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(existsSync(disabledRoot), false);
  await disabled.handlers.get("session_shutdown")({}, disabledContext);

  process.env.PI_THREAD_PHASE_STATUS_BRIDGE = "1";
  for (const mode of ["print", "json"]) {
    const root = join(testRoot, `${mode}-bridge`);
    process.env.PI_THREAD_PHASE_STATUS_BRIDGE_DIR = root;
    const worker = harness();
    registerVisualizer(worker.api);
    const workerContext = context(`${mode}-session`, mode);
    await worker.handlers.get("session_start")({}, workerContext);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(existsSync(root), false, `${mode} host published a bridge`);
    await worker.handlers.get("session_shutdown")({}, workerContext);
  }
  process.env.PI_THREAD_PHASE_STATUS_BRIDGE_DIR = originalRoot;
});

test("truncated source makes the strict bridge unknown without changing tolerant footer behavior", async () => {
  process.env.PI_THREAD_PHASE_STATUS_BRIDGE = "1";
  process.env.PI_THREAD_PHASE_STATUS_BRIDGE_DIR = bridgeRoot;
  const sessionId = "bridge-truncated-source";
  ownedRun("bridge-truncated-running", sessionId);
  const h = harness();
  registerVisualizer(h.api);
  const ctx = context(sessionId, "tui", testRoot, h.statuses);
  await h.handlers.get("session_start")({}, ctx);
  assert.equal(snapshot(bridgeRoot, sessionId).counts.running, 1);
  assert.match(h.statuses.filter(({ id }) => id === "thread-phase").at(-1)?.value || "", /^[◐◓◑◒]$/);
  appendFileSync(INDEX_FILE, "{");
  const unknown = await waitFor(() => {
    const value = snapshot(bridgeRoot, sessionId);
    return value.source.state === "unknown" ? value : undefined;
  }, "partial source was reported as current/idle");
  assert.deepEqual(unknown.workflows, []);
  assert.ok(Object.values(unknown.counts).every((count) => count === 0));
  assert.match(h.statuses.filter(({ id }) => id === "thread-phase").at(-1)?.value || "", /^[◐◓◑◒]$/,
    "strict bridge parse checks must not clear the footer's independently tolerant observation");
  await h.handlers.get("session_shutdown")({}, ctx);
});
