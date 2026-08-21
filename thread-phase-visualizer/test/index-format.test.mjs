import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-index-format-test-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
process.on("exit", () => rmSync(storeDir, { recursive: true, force: true }));
const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);
const { default: registerVisualizer, formatContinuationPrompt, formatRunSummary } = await import("../index.ts");
const store = await import("../lib/store.mjs");

test("formatRunSummary includes canonical stale and owner metadata", () => {
  const output = formatRunSummary({
    runId: "run-a",
    workflow: "workflow-a",
    normalizedStatus: "running",
    updatedAt: "2026-01-01T00:00:00Z",
    stale: { reason: "heartbeat_stale" },
    metadata: { sessionId: "session-a", launchSource: "background", cwdAtLaunch: "/repo" },
    phases: [],
    artifacts: [],
  });
  assert.match(output, /\[STALE\] heartbeat_stale/);
  // Owner metadata is trimmed to high-signal fields (audit MUST): full sessionId
  // and launch cwd are dropped, stale + short launch source retained.
  assert.match(output, /launch source: background/);
  assert.doesNotMatch(output, /sessionId: session-a|cwd at launch/);
});

test("failed continuation prompts identify failure and recovery choices", () => {
  const prompt = formatContinuationPrompt({
    runId: "failed-run",
    workflow: "failed-workflow",
    status: "failed",
    normalizedStatus: "failed",
    phases: [{ phase: "build", normalizedStatus: "failed", lastMessage: "build failed" }],
    artifacts: [{ title: "Partial workflow result", path: "/tmp/partial.json" }],
    errors: [{ phase: "build", message: "exit 1" }],
  });
  assert.match(prompt, /^A thread-phase workflow failed/);
  assert.match(prompt, /Status: failed/);
  assert.match(prompt, /build: exit 1/);
  assert.match(prompt, /resume the structured run, launch a recovery workflow, or report the blocker/);
  assert.match(prompt, /Do not proceed as though the workflow succeeded/);
});

test("thread_phase_runs details expose the owning sessionId", async () => {
  let tool;
  registerVisualizer({
    registerMessageRenderer() {},
    registerTool(value) { tool = value; },
    registerShortcut() {},
    on() {},
  });
  const run = store.createRun({ workflow: "tool-owner", cwd: "/repo", metadata: { sessionId: "session-a" } });
  const result = await tool.execute("call", { runId: run.runId }, undefined, undefined, {
    cwd: "/repo",
    sessionManager: { getSessionId: () => "session-a" },
  });
  assert.equal(result.details.sessionId, "session-a");
  assert.equal(result.details.summary.metadata.sessionId, "session-a");
});

test("thread_phase_runs rejects remote unscoped running runs and accepts canonical local cwd", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "thread-phase-tool-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const remote = join(root, "remote");
  const repoLink = join(root, "repo-link");
  mkdirSync(repo);
  mkdirSync(remote);
  symlinkSync(repo, repoLink, "dir");

  let tool;
  registerVisualizer({
    registerMessageRenderer() {},
    registerTool(value) { tool = value; },
    registerShortcut() {},
    on() {},
  });
  store.createRun({ runId: "tool-local-canonical", workflow: "tool-local", cwd: repoLink });
  const completedLocal = store.createRun({ runId: "tool-local-completed", workflow: "tool-completed", cwd: repoLink });
  store.completeRun(completedLocal);
  store.createRun({ runId: "tool-remote-rejected", workflow: "tool-remote", cwd: remote });
  store.createRun({ runId: "tool-owned-local", workflow: "tool-owned-local", cwd: repoLink, metadata: { sessionId: "scope-session" } });
  store.createRun({ runId: "tool-owned-remote", workflow: "tool-owned-remote", cwd: remote, metadata: { sessionId: "scope-session" } });
  const context = {
    cwd: realpathSync(repo),
    sessionManager: { getSessionId: () => "scope-session" },
  };

  const activeResult = await tool.execute("call", { limit: 100 }, undefined, undefined, context);
  const activeIds = activeResult.details.runs.map((run) => run.runId);
  assert.equal(activeIds.includes("tool-local-canonical"), true);
  assert.equal(activeIds.includes("tool-local-completed"), false);
  assert.equal(activeIds.includes("tool-remote-rejected"), false);

  const explicitResult = await tool.execute("call", { cwd: repoLink, limit: 100 }, undefined, undefined, {
    ...context,
    cwd: remote,
  });
  const explicitIds = explicitResult.details.runs.map((run) => run.runId);
  assert.equal(explicitIds.includes("tool-local-canonical"), true);
  assert.equal(explicitIds.includes("tool-local-completed"), false);
  assert.equal(explicitIds.includes("tool-remote-rejected"), false);
  assert.equal(explicitIds.includes("tool-owned-local"), true);
  assert.equal(explicitIds.includes("tool-owned-remote"), false);

  const completedResult = await tool.execute("call", { runId: "tool-local-completed" }, undefined, undefined, context);
  assert.equal(completedResult.details.summary, undefined);
});
