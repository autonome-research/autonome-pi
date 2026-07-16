import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MONITOR_SORTS,
  MONITOR_STATUS_FILTERS,
  cycleMonitorOption,
  filterAndSortMonitorRuns,
  runMatchesSearch,
} from "../lib/monitor-state.mjs";

const store = mkdtempSync(join(tmpdir(), "thread-phase-monitor-test-"));
process.env.PI_THREAD_PHASE_STORE_DIR = store;
process.on("exit", () => rmSync(store, { recursive: true, force: true }));

const runs = [
  { runId: "deploy-ALPHA-123", workflow: "Deploy Service", normalizedStatus: "running", cwd: "/work/Alpha", updatedAt: "2026-01-03T00:00:00Z" },
  { runId: "review-beta-456", workflow: "Code Review", normalizedStatus: "failed", cwd: "/work/Beta", updatedAt: "2026-01-02T00:00:00Z" },
  { runId: "test-gamma-789", workflow: "Test Suite", normalizedStatus: "success", cwd: "/work/Gamma", updatedAt: "2026-01-04T00:00:00Z" },
];

test("monitor search is case-insensitive across workflow, run id, status, and cwd", () => {
  assert.deepEqual(filterAndSortMonitorRuns(runs, { query: "REVIEW" }).map((run) => run.runId), ["review-beta-456"]);
  assert.equal(runMatchesSearch(runs[0], "alpha-123"), true);
  assert.equal(runMatchesSearch(runs[1], "FAILED"), true);
  assert.equal(runMatchesSearch(runs[2], "/WORK/GAMMA"), true);
  assert.equal(runMatchesSearch(runs[2], "missing"), false);
});

test("monitor status filter combines with search", () => {
  assert.deepEqual(filterAndSortMonitorRuns(runs, { status: "failed" }).map((run) => run.runId), ["review-beta-456"]);
  assert.deepEqual(filterAndSortMonitorRuns(runs, { query: "deploy", status: "success" }), []);
});

test("monitor can hide stale runs independently of status filtering", () => {
  const staleRuns = runs.map((run, index) => index === 0 ? { ...run, stale: { reason: "heartbeat_stale" } } : run);
  assert.deepEqual(filterAndSortMonitorRuns(staleRuns, { hideStale: true }).map((run) => run.runId), ["review-beta-456", "test-gamma-789"]);
  assert.deepEqual(filterAndSortMonitorRuns(staleRuns, { hideStale: true, status: "running" }), []);
});

test("monitor sort modes order by running-first status, updated time, and workflow", () => {
  assert.deepEqual(filterAndSortMonitorRuns(runs, { sort: "status" }).map((run) => run.runId), ["deploy-ALPHA-123", "review-beta-456", "test-gamma-789"]);
  assert.deepEqual(filterAndSortMonitorRuns(runs, { sort: "updated" }).map((run) => run.runId), ["test-gamma-789", "deploy-ALPHA-123", "review-beta-456"]);
  assert.deepEqual(filterAndSortMonitorRuns(runs, { sort: "workflow" }).map((run) => run.workflow), ["Code Review", "Deploy Service", "Test Suite"]);
});

test("monitor filter and sort controls cycle back to their clear/default values", () => {
  let status = "all";
  for (let index = 0; index < MONITOR_STATUS_FILTERS.length; index++) status = cycleMonitorOption(status, MONITOR_STATUS_FILTERS);
  assert.equal(status, "all");
  let sort = "status";
  for (let index = 0; index < MONITOR_SORTS.length; index++) sort = cycleMonitorOption(sort, MONITOR_SORTS);
  assert.equal(sort, "status");
});

test("filtered results are recomputed when the run collection changes", () => {
  assert.deepEqual(filterAndSortMonitorRuns(runs, { query: "new workflow" }), []);
  const updated = [...runs, { runId: "new-1", workflow: "New Workflow", normalizedStatus: "running", cwd: "/work/new", updatedAt: "2026-01-05T00:00:00Z" }];
  assert.deepEqual(filterAndSortMonitorRuns(updated, { query: "NEW WORKFLOW" }).map((run) => run.runId), ["new-1"]);
});
