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
const { createRun } = await import("../lib/store.mjs");

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

test("below-editor widget removes a run after its process becomes stale without another store event", { skip: process.platform === "win32" && "PID liveness projection differs on Windows", timeout: 8_000 }, async (t) => {
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
    runId: "status-widget-live-process",
    workflow: "status-widget-live-process",
    cwd: storeDir,
    metadata: {
      pid: worker.pid,
      sessionId: "status-widget-session",
      launchSource: "background",
      cwdAtLaunch: storeDir,
    },
  });

  const harness = extensionHarness();
  registerVisualizer(harness.api);
  const context = {
    cwd: storeDir,
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "status-widget-session",
      getBranch: () => [],
    },
    ui: {
      setWidget(id, value, options) { harness.widgets.push({ id, value, options }); },
      setStatus(id, value) { harness.statuses.push({ id, value }); },
      notify() {},
    },
  };
  await harness.handlers.get("session_start")({}, context);
  t.after(() => harness.handlers.get("session_shutdown")({}, context));

  await waitFor(() => harness.widgets.at(-1)?.value?.some((line) => line.includes("status-widget-live-process")), "live workflow never appeared below the editor");
  assert.equal(harness.statuses.at(-1)?.value, "1 workflow(s) running");

  worker.kill("SIGTERM");
  await new Promise((resolveClose) => worker.once("close", resolveClose));
  await waitFor(() => harness.widgets.at(-1)?.value === undefined, "stale workflow remained below the editor after its process exited");
  assert.equal(harness.statuses.at(-1)?.value, undefined);
});
