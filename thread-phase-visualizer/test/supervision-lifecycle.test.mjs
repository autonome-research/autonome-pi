import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-supervision-lifecycle-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
process.on("exit", () => rmSync(storeDir, { recursive: true, force: true }));
const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);
const { default: registerVisualizer } = await import("../index.ts");
const { default: registerDynamicWorkflows } = await import("../../dynamic-thread-phase-workflow/index.ts");
const store = await import("../lib/store.mjs");
const supervision = await import("../lib/supervision-store.mjs");

function harness() {
  const handlers = new Map();
  const userMessages = [];
  return {
    handlers,
    userMessages,
    api: {
      registerMessageRenderer() {}, registerTool() {}, registerShortcut() {}, registerCommand() {},
      on(name, handler) { handlers.set(name, handler); },
      sendMessage() {},
      sendUserMessage(message) { userMessages.push(message); },
    },
  };
}

function context(sessionId, idleState, branch = [], mode = "tui", cwd = storeDir) {
  return {
    cwd,
    mode,
    hasUI: false,
    isIdle: () => idleState.idle,
    ui: { notify() {}, setStatus() {}, setWidget() {} },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
      getEntries: () => branch,
    },
  };
}

function oldStart(runId, sessionId, extra = {}, cwd = storeDir, trigger = { kind: "background" }) {
  return store.emit({ runId, workflow: runId, cwd, trigger }, {
    type: store.EVENT_TYPES.WORKFLOW_START,
    status: store.STATUSES.RUNNING,
    timestamp: new Date(Date.now() - supervision.DEFAULT_PROGRESS_REVIEW_CADENCE_MS - 60_000).toISOString(),
    metadata: { sessionId, supervisionMode: "main-agent", ...extra },
  });
}

function contradictLaunchCwd(runId, claimedCwd) {
  const runFile = store.runFileFor(runId);
  const events = readFileSync(runFile, "utf8").trim().split("\n").map(JSON.parse);
  events[0].metadata.cwdAtLaunch = claimedCwd;
  writeFileSync(runFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const sidecarFile = join(storeDir, "runs", `${runId}.start.json`);
  const sidecar = JSON.parse(readFileSync(sidecarFile, "utf8"));
  sidecar.metadata.cwdAtLaunch = claimedCwd;
  writeFileSync(sidecarFile, JSON.stringify(sidecar));
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch { /* state may not be published yet */ }
    await delay(20);
  }
  assert.fail(message);
}

test("overdue reviews persist while busy, batch once, acknowledge only on active branch, then schedule the next period", async (t) => {
  const sessionId = "supervision-batch-session";
  oldStart("supervision-batch-one", sessionId);
  oldStart("supervision-batch-two", sessionId);
  const idle = { idle: false };
  const app = harness();
  registerVisualizer(app.api);
  const initial = context(sessionId, idle);
  await app.handlers.get("session_start")({}, initial);
  t.after(() => app.handlers.get("session_shutdown")({}, initial));

  assert.equal(app.userMessages.length, 0, "busy main agent is never interrupted");
  let records = supervision.loadProgressReviewRecords({ storeDir });
  assert.equal(records.filter((record) => record.state === "pending").length, 2, "busy backlog is durable");

  idle.idle = true;
  app.handlers.get("agent_settled")({}, initial);
  assert.equal(app.userMessages.length, 1, "overdue runs coalesce into one bounded review");
  assert.match(app.userMessages[0], /supervision-batch-one/);
  assert.match(app.userMessages[0], /supervision-batch-two/);
  records = supervision.loadProgressReviewRecords({ storeDir });
  assert.equal(records.every((record) => record.claimantId), true, "fire-and-forget sends remain pending until history proof");

  app.handlers.get("message_start")({ message: { role: "assistant" } }, context(sessionId, idle, []));
  assert.equal(supervision.loadProgressReviewRecords({ storeDir }).every((record) => record.state === "pending"), true,
    "an abandoned branch does not acknowledge the checks");

  const activeBranch = [{ type: "message", message: { role: "user", content: app.userMessages[0] } }];
  app.handlers.get("message_start")({ message: { role: "assistant" } }, context(sessionId, idle, activeBranch));
  records = supervision.loadProgressReviewRecords({ storeDir });
  assert.equal(records.every((record) => record.state === "scheduled"), true);
  assert.equal(records.every((record) => Date.parse(record.dueAt) > Date.now()), true, "ack schedules the next anchored period without catch-up spam");
  app.handlers.get("agent_settled")({}, context(sessionId, idle, activeBranch));
  assert.equal(app.userMessages.length, 1, "repeated idle edges do not duplicate an acknowledged review");
});

test("generated IDs longer than 200 characters can be reviewed and acknowledged", async (t) => {
  const sessionId = "supervision-long-name-session";
  // Stay below the existing store's atomic temporary filename limit, while
  // crossing the formatter's former (incorrect) 200-character ID ceiling.
  const runId = store.createRunId("w".repeat(169));
  assert.ok(runId.length > 200);
  oldStart(runId, sessionId);
  const idle = { idle: true };
  const app = harness();
  registerVisualizer(app.api);
  const ctx = context(sessionId, idle);
  await app.handlers.get("session_start")({}, ctx);
  t.after(() => app.handlers.get("session_shutdown")({}, ctx));
  assert.equal(app.userMessages.length, 1);
  assert.ok(app.userMessages[0].includes(runId), "retain the exact generated identifier");
  const branch = [{ type: "message", message: { role: "user", content: app.userMessages[0] } }];
  app.handlers.get("message_start")({ message: { role: "assistant" } }, context(sessionId, idle, branch));
  const record = supervision.loadProgressReviewRecords({ storeDir }).find((entry) => entry.runId === runId);
  assert.equal(record.state, "scheduled", "acknowledgement advances the long-ID run to its next check");
});

test("verified owned cross-directory work is eligible while contradictory claims, foreign work, cancellation, and terminal completion are denied", async (t) => {
  oldStart("supervision-foreign", "another-session");
  oldStart("supervision-manual", "supervision-scope-session", {}, storeDir, { kind: "manual" });
  oldStart("supervision-no-trigger", "supervision-scope-session", {}, storeDir, null);
  oldStart("supervision-cross-cwd", "supervision-scope-session", {}, join(storeDir, "other-cwd"));
  oldStart("supervision-contradictory-cwd", "supervision-scope-session");
  contradictLaunchCwd("supervision-contradictory-cwd", join(storeDir, "claimed-elsewhere"));
  oldStart("supervision-cancelled", "supervision-scope-session");
  store.requestCancellation("supervision-cancelled", { reason: "test cancellation" });
  oldStart("supervision-terminal", "supervision-scope-session");
  store.completeRun({ runId: "supervision-terminal", workflow: "supervision-terminal", cwd: storeDir, metadata: { sessionId: "supervision-scope-session", supervisionMode: "main-agent" } });

  const idle = { idle: true };
  const app = harness();
  registerVisualizer(app.api);
  const ctx = context("supervision-scope-session", idle);
  await app.handlers.get("session_start")({}, ctx);
  t.after(() => app.handlers.get("session_shutdown")({}, ctx));
  app.handlers.get("agent_settled")({}, ctx);
  assert.equal(app.userMessages.length, 1);
  assert.match(app.userMessages[0], /supervision-cross-cwd/);
  assert.doesNotMatch(app.userMessages[0], /supervision-contradictory-cwd/);
  const ids = supervision.loadProgressReviewRecords({ storeDir }).map((record) => record.runId);
  assert.equal(ids.includes("supervision-cross-cwd"), true);
  assert.equal(ids.includes("supervision-foreign"), false);
  assert.equal(ids.includes("supervision-manual"), false);
  assert.equal(ids.includes("supervision-no-trigger"), false);
  assert.equal(ids.includes("supervision-contradictory-cwd"), false);
  assert.equal(ids.includes("supervision-cancelled"), false);
  assert.equal(ids.includes("supervision-terminal"), false);
});

test("tool_result reconciliation schedules verified owned work across cwd scope changes", async (t) => {
  const sessionId = "supervision-tool-result-session";
  const idle = { idle: false };
  const app = harness();
  registerVisualizer(app.api);
  const ctx = context(sessionId, idle);
  await app.handlers.get("session_start")({}, ctx);
  t.after(() => app.handlers.get("session_shutdown")({}, ctx));

  const runId = "supervision-tool-result-cross-cwd";
  oldStart(runId, sessionId, {}, join(storeDir, "tool-result-cwd"));
  app.handlers.get("tool_result")({ details: { runId } }, ctx);
  assert.equal(supervision.loadProgressReviewRecords({ storeDir }).some((record) => record.runId === runId), true);

  app.handlers.get("user_bash")({ command: `cd ${JSON.stringify(tmpdir())}`, cwd: storeDir }, ctx);
  app.handlers.get("agent_settled")({}, ctx);
  assert.equal(supervision.loadProgressReviewRecords({ storeDir }).some((record) => record.runId === runId), true,
    "changing the session cwd must not revoke owned supervision");
});

test("a supported cross-directory tool launch survives restart and scope changes, then terminal index discovery removes supervision", { timeout: 20_000 }, async (t) => {
  const sessionId = "supervision-real-cross-directory-session";
  const launchCwd = mkdtempSync(join(tmpdir(), "supervision-real-launch-"));
  const laterSessionCwd = mkdtempSync(join(tmpdir(), "supervision-real-host-"));
  const releaseFile = join(launchCwd, "release");
  const fakePi = join(launchCwd, "fake-pi.mjs");
  writeFileSync(fakePi, `#!/usr/bin/env node\nimport { existsSync, watch } from "node:fs";\nimport { dirname } from "node:path";\nconst release = process.env.PI_TEST_SUPERVISION_RELEASE;\nconst complete = () => { console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "fake", content: [{ type: "text", text: "released" }] } })); };\nif (existsSync(release)) complete();\nelse {\n  const watcher = watch(dirname(release), () => { if (existsSync(release)) { watcher.close(); complete(); } });\n}\n`);
  chmodSync(fakePi, 0o755);
  const previousPi = process.env.PI_DYNAMIC_WORKFLOW_PI_BIN;
  const previousRelease = process.env.PI_TEST_SUPERVISION_RELEASE;
  process.env.PI_DYNAMIC_WORKFLOW_PI_BIN = fakePi;
  process.env.PI_TEST_SUPERVISION_RELEASE = releaseFile;

  const idle = { idle: false };
  const first = harness();
  registerVisualizer(first.api);
  const firstCtx = context(sessionId, idle);
  let replacement;
  let replacementCtx;
  let runId;
  try {
    await first.handlers.get("session_start")({}, firstCtx);
    const tools = new Map();
    registerDynamicWorkflows({ registerTool: (definition) => tools.set(definition.name, definition) });
    const launched = await tools.get("dynamic_workflow").execute("cross-directory-call", {
      name: "supervision-real-cross-directory",
      cwd: launchCwd,
      permissions: "r",
      background: true,
      timeoutMs: 8_000,
      phases: [{ type: "agent", name: "worker", prompt: "wait for the test release" }],
    }, undefined, undefined, { cwd: storeDir, sessionManager: { getSessionId: () => sessionId } });
    runId = launched.details.runId;
    assert.equal(launched.details.background, true);

    await waitFor(
      () => supervision.loadProgressReviewRecords({ storeDir }).some((record) => record.runId === runId),
      "the live index path did not schedule the supported cross-directory launch",
    );
    const summary = store.getRunSummary(runId);
    assert.equal(summary.cwd, launchCwd);
    assert.equal(summary.metadata.cwdAtLaunch, launchCwd);
    assert.equal(summary.metadata.sessionId, sessionId);

    first.handlers.get("user_bash")({ command: `cd ${JSON.stringify(laterSessionCwd)}`, cwd: storeDir }, firstCtx);
    first.handlers.get("agent_settled")({}, firstCtx);
    assert.equal(supervision.loadProgressReviewRecords({ storeDir }).some((record) => record.runId === runId), true);
    first.handlers.get("session_shutdown")({}, firstCtx);

    supervision.discardProgressReview(runId, { storeDir });
    replacement = harness();
    registerVisualizer(replacement.api);
    replacementCtx = context(sessionId, idle, [], "tui", laterSessionCwd);
    await replacement.handlers.get("session_start")({}, replacementCtx);
    assert.equal(supervision.loadProgressReviewRecords({ storeDir }).some((record) => record.runId === runId), true,
      "startup discovery must recreate the schedule without matching the new session cwd");

    replacement.handlers.get("user_bash")({ command: `cd ${JSON.stringify(storeDir)}`, cwd: laterSessionCwd }, replacementCtx);
    replacement.handlers.get("agent_settled")({}, replacementCtx);
    assert.equal(supervision.loadProgressReviewRecords({ storeDir }).some((record) => record.runId === runId), true);

    writeFileSync(releaseFile, "release");
    await waitFor(() => Boolean(store.getRunSummary(runId).endedAt), "the supported workflow did not finish", 10_000);
    await waitFor(
      () => !supervision.loadProgressReviewRecords({ storeDir }).some((record) => record.runId === runId),
      "terminal index discovery did not remove the supervision record",
    );
  } finally {
    if (!existsSync(releaseFile)) writeFileSync(releaseFile, "release");
    if (replacement && replacementCtx) replacement.handlers.get("session_shutdown")({}, replacementCtx);
    else first.handlers.get("session_shutdown")({}, firstCtx);
    if (previousPi === undefined) delete process.env.PI_DYNAMIC_WORKFLOW_PI_BIN;
    else process.env.PI_DYNAMIC_WORKFLOW_PI_BIN = previousPi;
    if (previousRelease === undefined) delete process.env.PI_TEST_SUPERVISION_RELEASE;
    else process.env.PI_TEST_SUPERVISION_RELEASE = previousRelease;
    rmSync(launchCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(laterSessionCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("ambiguous cancellation markers suppress reviews without blocking the host", (t) => {
  const isolated = mkdtempSync(join(tmpdir(), "supervision-cancel-markers-"));
  t.after(() => rmSync(isolated, { recursive: true, force: true }));
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import * as nodeModule from 'node:module';
    const loader = ${JSON.stringify(loaderUrl.href)};
    if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loader));
    else nodeModule.register(loader);
    const { default: registerVisualizer } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
    const store = await import(${JSON.stringify(new URL("../lib/store.mjs", import.meta.url).href)});
    for (const runId of ['broken-json', 'dangling-link', 'fifo-marker']) {
      store.emit({ runId, workflow: runId, cwd: process.env.PI_THREAD_PHASE_STORE_DIR, trigger: { kind: 'background' } }, {
        type: 'workflow_start', status: 'running', timestamp: new Date(Date.now() - ${supervision.DEFAULT_PROGRESS_REVIEW_CADENCE_MS + 60_000}).toISOString(),
        metadata: { sessionId: 'cancel-markers', supervisionMode: 'main-agent' },
      });
    }
    fs.writeFileSync(store.cancelFileFor('broken-json'), '{bad');
    fs.symlinkSync('missing-target', store.cancelFileFor('dangling-link'));
    const fifo = spawnSync('mkfifo', [store.cancelFileFor('fifo-marker')]);
    if (fifo.status !== 0) fs.writeFileSync(store.cancelFileFor('fifo-marker'), '{bad');
    const handlers = new Map();
    const messages = [];
    registerVisualizer({ registerMessageRenderer() {}, registerTool() {}, registerShortcut() {}, registerCommand() {},
      on(name, fn) { handlers.set(name, fn); }, sendMessage() {}, sendUserMessage(value) { messages.push(value); } });
    const ctx = { cwd: process.env.PI_THREAD_PHASE_STORE_DIR, mode: 'tui', hasUI: false, isIdle: () => true,
      ui: { notify() {}, setStatus() {}, setWidget() {} },
      sessionManager: { getSessionId: () => 'cancel-markers', getBranch: () => [] } };
    try {
      await handlers.get('session_start')({}, ctx);
      handlers.get('agent_settled')({}, ctx);
      assert.equal(messages.length, 0);
    } finally { handlers.get('session_shutdown')({}, ctx); }
  `;
  // A subprocess deadline can catch a blocking FIFO read; node:test's own
  // timeout cannot interrupt a synchronous read on its event loop.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: isolated }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(child.status, 0, String(child.error || child.stderr));
});

test("terminal continuation has priority at the shared submission gate", async (t) => {
  const sessionId = "supervision-priority-session";
  oldStart("supervision-priority-review", sessionId);
  const terminal = store.createRun({
    runId: "supervision-priority-terminal",
    workflow: "supervision-priority-terminal",
    cwd: storeDir,
    metadata: { sessionId, autoContinue: true },
  });
  store.completeRun(terminal);
  const idle = { idle: true };
  const app = harness();
  registerVisualizer(app.api);
  const ctx = context(sessionId, idle);
  await app.handlers.get("session_start")({}, ctx);
  t.after(() => app.handlers.get("session_shutdown")({}, ctx));
  assert.equal(app.userMessages.length, 1);
  assert.match(app.userMessages[0], /workflow completed/i, "terminal work submits before an overdue progress check");
  assert.doesNotMatch(app.userMessages[0], /progress review, not completion/i);

  const terminalBranch = [{ type: "message", message: { role: "user", content: app.userMessages[0] } }];
  app.handlers.get("message_start")({ message: { role: "assistant" } }, context(sessionId, idle, terminalBranch));
  app.handlers.get("agent_settled")({}, context(sessionId, idle, terminalBranch));
  assert.equal(app.userMessages.length, 2);
  assert.match(app.userMessages[1], /progress review, not completion/i);
});

test("shutdown disposes an overdue callback before it can submit", async () => {
  const sessionId = "supervision-shutdown-session";
  oldStart("supervision-shutdown-review", sessionId);
  const idle = { idle: false };
  const app = harness();
  registerVisualizer(app.api);
  const ctx = context(sessionId, idle);
  await app.handlers.get("session_start")({}, ctx);
  app.handlers.get("session_shutdown")({}, ctx);
  await delay(5_100);
  assert.equal(app.userMessages.length, 0);
});

test("print/json worker contexts do not recursively supervise", async (t) => {
  const sessionId = "supervision-worker-context";
  oldStart("supervision-json-worker", sessionId);
  const idle = { idle: true };
  const app = harness();
  registerVisualizer(app.api);
  const ctx = context(sessionId, idle, [], "json");
  await app.handlers.get("session_start")({}, ctx);
  t.after(() => app.handlers.get("session_shutdown")({}, ctx));
  app.handlers.get("agent_settled")({}, ctx);
  assert.equal(app.userMessages.length, 0);
  assert.equal(supervision.loadProgressReviewRecords({ storeDir }).some((record) => record.runId === "supervision-json-worker"), false);
});

test("an error without workflow_end remains reviewable and synchronous send failure is durably deferred", async (t) => {
  const sessionId = "supervision-error-session";
  oldStart("supervision-error-only", sessionId);
  store.emit({ runId: "supervision-error-only", workflow: "supervision-error-only", cwd: storeDir }, {
    type: store.EVENT_TYPES.ERROR,
    status: store.STATUSES.FAILED,
    message: "diagnostic error without workflow_end",
  });
  const idle = { idle: true };
  const app = harness();
  app.api.sendUserMessage = () => { throw new Error("simulated synchronous submission failure"); };
  registerVisualizer(app.api);
  const ctx = context(sessionId, idle);
  await app.handlers.get("session_start")({}, ctx);
  t.after(() => app.handlers.get("session_shutdown")({}, ctx));
  app.handlers.get("agent_settled")({}, ctx);

  const record = supervision.loadProgressReviewRecords({ storeDir }).find((entry) => entry.runId === "supervision-error-only");
  assert.equal(record.state, "pending", "error-derived failure is not completion");
  assert.equal(record.claimantId, undefined, "known failed send cannot permanently retain in-flight ownership");
  assert.ok(Date.parse(record.notBefore) > Date.now(), "submission retry uses durable backoff");
  assert.equal(existsSync(store.cancelFileFor(record.runId)), false, "review scheduling never creates cancellation/kill side effects");
});
