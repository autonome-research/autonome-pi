import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-passive-progress-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
process.env.PI_THREAD_PHASE_STATUS_BRIDGE = "0";
process.env.PI_THREAD_PHASE_SUPERVISION_CHECK_MS = "60000";
process.on("exit", () => rmSync(storeDir, { recursive: true, force: true }));
const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);
const { default: registerVisualizer } = await import("../index.ts");
const store = await import("../lib/store.mjs");
// The retired store is used only to seed pre-upgrade state.
const supervision = await import("../lib/supervision-store.mjs");
const reviewFile = join(storeDir, "progress-reviews.json");

function host(sessionId, mode = "tui", hasUI = false) {
  const handlers = new Map();
  const tools = new Map();
  const userMessages = [];
  const customMessages = [];
  const statuses = [];
  const state = { idle: false, branch: [] };
  registerVisualizer({
    registerMessageRenderer() {}, registerShortcut() {}, registerCommand() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { handlers.set(name, handler); },
    sendMessage(message) { customMessages.push(message); },
    sendUserMessage(message) { userMessages.push(message); },
  });
  const ctx = {
    cwd: storeDir, mode, hasUI, isIdle: () => state.idle,
    ui: { notify() {}, setWidget() {}, setStatus(key, value) { statuses.push({ key, value }); } },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => state.branch },
  };
  return { handlers, tools, userMessages, customMessages, statuses, state, ctx };
}

function oldStart(runId, sessionId, metadata = {}) {
  const start = store.emit({ runId, workflow: runId, cwd: storeDir, trigger: { kind: "background" } }, {
    type: "workflow_start", status: "running",
    timestamp: new Date(Date.now() - 3_600_000).toISOString(),
    metadata: { sessionId, supervisionMode: "main-agent", progressReviewIntervalMs: 60_000, ...metadata },
  });
  return start.timestamp;
}

for (const mode of ["tui", "rpc", "print", "json"]) {
  test(`${mode}: old scheduled, pending and claimed reviews stay inert through idle, history, timers and restart`, async (t) => {
    rmSync(reviewFile, { force: true });
    const sessionId = `retired-reviews-${mode}`;
    const branch = [];
    for (const kind of ["scheduled", "pending", "claimed"]) {
      const runId = `${sessionId}-${kind}`;
      const startedAt = oldStart(runId, sessionId);
      const record = supervision.ensureProgressReview(runId, {
        storeDir, startedAt, cadenceMs: 60_000,
        now: kind === "scheduled" ? Date.parse(startedAt) : Date.now(),
      });
      if (kind === "claimed") supervision.claimProgressReview(runId, { storeDir, claimantId: "old-host" });
      branch.push({ type: "message", message: { role: "user", content:
        `[thread-phase-progress-review/v1] ${JSON.stringify({ checks: [{ runId, checkId: record.checkId }] })}` } });
    }
    oldStart(`${sessionId}-v3`, sessionId, { delegation: "v3", progressReviewIntervalMs: undefined });
    const before = readFileSync(reviewFile, "utf8");
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    for (let restart = 0; restart < 2; restart++) {
      const app = host(sessionId, mode);
      app.state.branch = branch;
      try {
        await app.handlers.get("session_start")({}, app.ctx);
        app.handlers.get("tool_result")?.({ details: { runId: `${sessionId}-v3` } }, app.ctx);
        app.state.idle = true;
        for (let i = 0; i < 3; i++) {
          app.handlers.get("message_start")({ message: { role: "assistant" } }, app.ctx);
          app.handlers.get("agent_settled")({}, app.ctx);
          t.mock.timers.tick(3_600_000);
        }
        assert.deepEqual(app.userMessages, [], "elapsed time must not request inference");
        assert.deepEqual(app.customMessages, [], "progress must not enter later model context either");
      } finally {
        app.handlers.get("session_shutdown")({}, app.ctx);
      }
      assert.equal(readFileSync(reviewFile, "utf8"), before, "legacy state is neither read into a schedule nor rewritten");
    }
  });
}

test("new explicit-cadence and v3 runs create no review file", async (t) => {
  rmSync(reviewFile, { force: true });
  const sessionId = "no-new-reviews";
  oldStart("new-explicit-review", sessionId);
  oldStart("new-default-v3-review", sessionId, { delegation: "v3", progressReviewIntervalMs: undefined });
  const app = host(sessionId);
  try {
    app.state.idle = true;
    await app.handlers.get("session_start")({}, app.ctx);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    app.handlers.get("agent_settled")({}, app.ctx);
    t.mock.timers.tick(86_400_000);
    assert.deepEqual(app.userMessages, []);
    assert.equal(existsSync(reviewFile), false);
  } finally {
    app.handlers.get("session_shutdown")({}, app.ctx);
  }
});

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await delay(20);
  assert.ok(predicate(), message);
}

test("passive status and on-demand inspection survive malformed legacy state; only real completion hands off", async () => {
  writeFileSync(reviewFile, "{broken legacy review state");
  const sessionId = "passive-status-session";
  const app = host(sessionId, "tui", true);
  const run = store.createRun({
    runId: "passive-status-run", workflow: "passive-status", cwd: storeDir,
    trigger: { kind: "background" },
    metadata: { sessionId, pid: process.pid, continuationMode: "terminal", supervisionMode: "main-agent", progressReviewIntervalMs: 60_000 },
  });
  try {
    await app.handlers.get("session_start")({}, app.ctx);
    assert.ok(app.statuses.some(({ key, value }) => key === "thread-phase" && value), "passive footer is still live");
    for (let index = 0; index < 10; index++) store.phaseEvent(run, "worker", { kind: "progress", completed: index, total: 10 });
    store.emit(run, { type: "error", status: "failed", message: "diagnostic, not a terminal event" });
    await delay(50); // Let the real index watcher process activity, not just startup.
    app.state.idle = true;
    app.handlers.get("agent_settled")({}, app.ctx);
    assert.deepEqual(app.userMessages, []);
    assert.deepEqual(app.customMessages, []);
    const inspected = await app.tools.get("thread_phase_runs").execute("inspect", { runId: run.runId }, undefined, undefined, app.ctx);
    assert.equal(inspected.details.summary.runId, run.runId);
    assert.equal(inspected.details.summary.endedAt, undefined);

    store.completeRun(run);
    await waitFor(() => app.userMessages.length === 1, "terminal continuation was lost");
    assert.match(app.userMessages[0], /workflow completed/i);
    assert.equal(app.customMessages.length, 1, "the terminal card still appears");
    app.state.branch = [{ type: "message", message: { role: "user", content: app.userMessages[0] } }];
    app.handlers.get("message_start")({ message: { role: "assistant" } }, app.ctx);
    app.handlers.get("agent_settled")({}, app.ctx);
    await delay(50);
    assert.equal(app.userMessages.length, 1, "no periodic follow-up after completion acknowledgement");
    assert.equal(readFileSync(reviewFile, "utf8"), "{broken legacy review state");
  } finally {
    app.handlers.get("session_shutdown")({}, app.ctx);
    rmSync(reviewFile, { force: true });
  }
});
