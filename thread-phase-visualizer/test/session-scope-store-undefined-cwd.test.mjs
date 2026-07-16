import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-undefined-cwd-test-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
process.on("exit", () => rmSync(storeDir, { recursive: true, force: true }));
const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);

const store = await import("../lib/store.mjs");
const { canInspectRun, mergeMonitorRuns } = await import("../lib/session-scope.mjs");
const { ThreadPhaseMonitorComponent } = await import("../components/monitor.ts");
const { default: registerVisualizer } = await import("../index.ts");

const theme = {
  fg(_color, value) { return String(value); },
  bold(value) { return String(value); },
};

test("projectRun permits metadata fallback only for omitted cwd provenance", (t) => {
  const root = mkdtempSync(join(tmpdir(), "thread-phase-project-blank-cwd-"));
  const repo = join(root, "repo");
  const repoLink = join(root, "repo-link");
  mkdirSync(repo);
  symlinkSync(repo, repoLink, "dir");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonicalRepo = realpathSync(repo);

  const starts = [
    { runId: "missing-cwd" },
    { runId: "undefined-cwd", cwd: undefined },
    { runId: "null-cwd", cwd: null },
    { runId: "empty-cwd", cwd: "" },
    { runId: "whitespace-cwd", cwd: " \t " },
    { runId: "relative-cwd", cwd: "repo" },
    { runId: "malformed-cwd", cwd: 42 },
    { runId: "other-session", cwd: "", metadata: { sessionId: "session-other", cwdAtLaunch: repoLink } },
  ];
  const summaries = starts.map((start, index) => store.projectRun([{
    schema: "thread-phase-ui/v1",
    eventId: `event-${index}`,
    timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
    workflow: "Blank CWD Projection",
    type: "workflow_start",
    status: "running",
    metadata: { cwdAtLaunch: repoLink },
    ...start,
  }]));

  assert.equal(canInspectRun(summaries[0], "session-viewer", canonicalRepo), true, "omitted cwd may use absolute metadata");
  for (const summary of summaries.slice(1)) {
    assert.equal(canInspectRun(summary, "session-viewer", canonicalRepo), false, summary.runId);
  }
  assert.deepEqual(
    mergeMonitorRuns(summaries, canonicalRepo, "session-viewer").map((run) => run.runId),
    ["missing-cwd"],
  );
});

test("store-backed undefined run cwd uses absolute launch metadata in inspection, monitor, and tool scope", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "thread-phase-undefined-cwd-repo-"));
  const repo = join(root, "repo");
  const repoLink = join(root, "repo-link");
  mkdirSync(repo);
  symlinkSync(repo, repoLink, "dir");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const run = store.createRun({
    runId: "undefined-cwd-local-running",
    workflow: "Undefined CWD Local Running",
    cwd: undefined,
    metadata: { cwdAtLaunch: repoLink },
  });
  const canonicalRepo = realpathSync(repo);
  const summary = store.getRunSummary(run.runId);
  const latest = store.latestRunSummaries({ limit: 20, readLimit: 20 });
  const latestSummary = latest.find((candidate) => candidate.runId === run.runId);

  assert.equal(Object.hasOwn(summary, "cwd"), false, "undefined cwd is persisted as absent");
  assert.equal(summary.workflowStartCwdPresent, false);
  assert.equal(summary.metadata.cwdAtLaunch, canonicalRepo);
  assert.equal(canInspectRun(summary, "viewer-session", canonicalRepo), true);
  assert.ok(latestSummary, "omitted-cwd run survives latestRunSummaries scoping input");
  assert.equal(Object.hasOwn(latestSummary, "cwd"), false);
  assert.equal(latestSummary.workflowStartCwdPresent, false);
  assert.equal(canInspectRun(latestSummary, "viewer-session", canonicalRepo), true);

  const monitor = new ThreadPhaseMonitorComponent(canonicalRepo, "viewer-session", theme, () => {}, () => {}, () => {});
  assert.match(monitor.render(100).join("\n"), /Undefined-CWD-Local-Running/);

  let tool;
  registerVisualizer({
    registerMessageRenderer() {},
    registerTool(value) { tool = value; },
    registerShortcut() {},
    on() {},
  });
  const context = {
    cwd: canonicalRepo,
    sessionManager: { getSessionId: () => "viewer-session" },
  };
  const list = await tool.execute("call", { limit: 20 }, undefined, undefined, context);
  assert.equal(list.details.runs.some((candidate) => candidate.runId === run.runId), true);
  const detail = await tool.execute("call", { runId: run.runId }, undefined, undefined, context);
  assert.equal(detail.details.summary.runId, run.runId);
});
