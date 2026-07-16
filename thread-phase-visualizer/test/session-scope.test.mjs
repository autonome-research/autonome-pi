import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canInspectRun,
  canonicalCwd,
  createCwdState,
  isRunningRun,
  mergeMonitorRuns,
  parseCdTargets,
  sameCanonicalCwd,
  trackCwdCommand,
} from "../lib/session-scope.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "thread-phase-scope-"));
  const repo = path.join(root, "repo");
  const sibling = path.join(root, "sibling");
  mkdirSync(path.join(repo, "nested", "path"), { recursive: true });
  mkdirSync(sibling);
  const link = path.join(root, "repo-link");
  symlinkSync(repo, link, "dir");
  return { root, repo: realpathSync(repo), sibling: realpathSync(sibling), link };
}

test("cwd fallback canonicalizes paths and rejects legacy relative launch paths without a recorded base", (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));

  assert.equal(canonicalCwd(paths.link), paths.repo);
  assert.equal(sameCanonicalCwd(paths.link, paths.repo), true);
  assert.equal(canInspectRun({ cwd: paths.link, normalizedStatus: "running" }, "session-a", paths.repo), true);
  assert.equal(canInspectRun({ metadata: { cwdAtLaunch: paths.link }, normalizedStatus: "running" }, undefined, paths.repo), true);

  // These would all match a requested cwd if a legacy launch value were
  // resolved against the viewer's cwd (or another caller-provided base).
  // Without a recorded launch origin they must fail closed instead.
  const relativeLaunchCases = [
    { value: ".", origin: paths.repo, requested: paths.repo },
    { value: "..", origin: path.join(paths.repo, "nested"), requested: paths.repo },
    { value: "repo-link", origin: paths.root, requested: paths.repo },
    { value: path.relative(paths.repo, paths.sibling), origin: paths.repo, requested: paths.sibling },
  ];
  for (const { value, origin, requested } of relativeLaunchCases) {
    // Demonstrate that resolving against some guessed base could produce the
    // requested directory, then verify scoping refuses to make that guess.
    assert.equal(canonicalCwd(value, origin), requested, value);
    assert.equal(sameCanonicalCwd(value, requested, origin), false, value);
    assert.equal(
      canInspectRun({ metadata: { cwdAtLaunch: value }, normalizedStatus: "running" }, undefined, requested),
      false,
      value,
    );
  }
  assert.deepEqual(
    mergeMonitorRuns(
      relativeLaunchCases.map(({ value: cwdAtLaunch }, index) => ({
        runId: `relative-${index}`,
        metadata: { cwdAtLaunch },
        normalizedStatus: "running",
      })),
      paths.repo,
      undefined,
    ),
    [],
  );

  // A relative run.cwd is authoritative over conflicting absolute owner
  // metadata, but cannot be resolved safely. Both inspection and monitor
  // scoping must reject it rather than falling through to metadata.
  const conflictingLegacy = {
    runId: "conflicting-relative",
    cwd: "repo-link",
    metadata: { cwdAtLaunch: paths.link, cwd: paths.sibling },
    normalizedStatus: "running",
    updatedAt: "1",
  };
  assert.equal(canInspectRun(conflictingLegacy, undefined, paths.repo), false);
  assert.equal(canInspectRun(conflictingLegacy, undefined, paths.sibling), false);
  assert.deepEqual(mergeMonitorRuns([conflictingLegacy], paths.repo, undefined), []);

  // Nonblank relative or malformed run.cwd values are authoritative and
  // unresolvable. Do not fall through to conflicting absolute legacy metadata
  // in either tool inspection or monitor scoping.
  const invalidPrimaryCwdRuns = [
    { runId: "relative-run-cwd", cwd: "repo-link" },
    { runId: "malformed-run-cwd", cwd: 42 },
    { runId: "object-run-cwd", cwd: { path: paths.link } },
  ].map((run) => ({
    ...run,
    metadata: { cwdAtLaunch: paths.link, cwd: paths.sibling },
    normalizedStatus: "running",
  }));
  for (const run of invalidPrimaryCwdRuns) {
    assert.equal(canInspectRun(run, undefined, paths.repo), false, run.runId);
    assert.equal(canInspectRun(run, undefined, paths.sibling), false, run.runId);
  }
  assert.deepEqual(mergeMonitorRuns(invalidPrimaryCwdRuns, paths.repo, undefined), []);

  // Only genuinely omitted primary CWD values may use absolute owner metadata.
  const fallbackPrimaryCwdRuns = [
    { runId: "missing-cwd-at-launch", metadata: { cwdAtLaunch: paths.link }, normalizedStatus: "running", updatedAt: "6" },
    { runId: "projected-omitted-cwd", cwd: undefined, workflowStartCwdPresent: false, metadata: { cwdAtLaunch: paths.link }, normalizedStatus: "running", updatedAt: "5" },
  ];
  const explicitInvalidCwdRuns = [
    { runId: "legacy-own-undefined-cwd", cwd: undefined, metadata: { cwdAtLaunch: paths.link }, normalizedStatus: "running", updatedAt: "4" },
    { runId: "projected-present-undefined-cwd", cwd: undefined, workflowStartCwdPresent: true, metadata: { cwdAtLaunch: paths.link }, normalizedStatus: "running", updatedAt: "3" },
    { runId: "contradictory-omitted-absolute-cwd", cwd: paths.repo, workflowStartCwdPresent: false, metadata: { cwdAtLaunch: paths.link }, normalizedStatus: "running", updatedAt: "3" },
    { runId: "projected-null-cwd", cwd: null, workflowStartCwdPresent: true, metadata: { cwdAtLaunch: paths.link }, normalizedStatus: "running", updatedAt: "2" },
    { runId: "projected-empty-cwd", cwd: "", workflowStartCwdPresent: true, metadata: { cwdAtLaunch: paths.link }, normalizedStatus: "running", updatedAt: "1" },
    { runId: "projected-whitespace-cwd", cwd: "   ", workflowStartCwdPresent: true, metadata: { cwd: paths.link }, normalizedStatus: "running", updatedAt: "0" },
  ];
  for (const run of fallbackPrimaryCwdRuns) {
    assert.equal(canInspectRun(run, undefined, paths.repo), true, run.runId);
    assert.equal(canInspectRun(run, undefined, paths.sibling), false, run.runId);
  }
  for (const run of explicitInvalidCwdRuns) assert.equal(canInspectRun(run, undefined, paths.repo), false, run.runId);
  assert.deepEqual(
    mergeMonitorRuns([...fallbackPrimaryCwdRuns, ...explicitInvalidCwdRuns], paths.repo, undefined).map((run) => run.runId),
    fallbackPrimaryCwdRuns.map((run) => run.runId),
  );
});

test("absolute run cwd overrides conflicting local legacy metadata for inspection and monitor scope", (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));
  const remote = {
    runId: "remote-with-local-metadata",
    cwd: paths.sibling,
    metadata: { cwdAtLaunch: paths.repo, cwd: paths.repo },
    normalizedStatus: "running",
    updatedAt: "1",
  };

  assert.equal(canInspectRun(remote, undefined, paths.repo), false);
  assert.equal(canInspectRun(remote, undefined, paths.sibling), true);
  assert.deepEqual(mergeMonitorRuns([remote], paths.repo, undefined), []);
  assert.deepEqual(mergeMonitorRuns([remote], paths.sibling, undefined).map((run) => run.runId), [remote.runId]);
});

test("matching session-owned runs are visible in inspection and monitor results", (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));
  const own = { runId: "own", metadata: { sessionId: "session-a" }, normalizedStatus: "success", updatedAt: "5" };
  const localUnscoped = { runId: "local", cwd: paths.sibling, status: "running", updatedAt: "4" };
  const other = { runId: "other", metadata: { sessionId: "session-b" }, normalizedStatus: "running", updatedAt: "6" };

  assert.equal(canInspectRun(own, "session-a", paths.sibling), true);
  assert.deepEqual(
    mergeMonitorRuns([other, localUnscoped, own], paths.sibling, "session-a").map((run) => run.runId),
    ["own", "local"],
  );
});

test("other sessions and remote unscoped running runs are hidden", (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));
  const other = { runId: "other", cwd: paths.repo, metadata: { sessionId: "session-b" }, normalizedStatus: "running", updatedAt: "5" };
  const localSymlink = { runId: "local-link", cwd: paths.link, normalizedStatus: "running", updatedAt: "4" };
  const localRelative = { runId: "local-relative", metadata: { cwdAtLaunch: "repo-link" }, normalizedStatus: "running", updatedAt: "3" };
  const remoteRunning = { runId: "remote", cwd: paths.sibling, normalizedStatus: "running", updatedAt: "2" };
  const localDone = { runId: "done", cwd: paths.repo, normalizedStatus: "success", updatedAt: "1" };

  assert.equal(canInspectRun(other, "session-a", paths.repo), false);
  assert.equal(canInspectRun(remoteRunning, "session-a", paths.repo), false);
  assert.equal(canInspectRun(localSymlink, "session-a", paths.repo), true);
  assert.equal(canInspectRun(localRelative, "session-a", paths.repo), false);
  assert.equal(canInspectRun(localDone, "session-a", paths.repo), false);
  assert.equal(canInspectRun({ ...localDone, cwd: paths.sibling }, "session-a", paths.repo), false);
  assert.deepEqual(
    mergeMonitorRuns([localDone, remoteRunning, other, localRelative, localSymlink], paths.repo, "session-a").map((run) => run.runId),
    ["local-link"],
  );
});

test("cwd fallback only exposes unowned running runs using one status helper", (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));

  const rawRunning = { runId: "legacy", cwd: paths.link, status: "running", updatedAt: "1" };
  assert.equal(isRunningRun(rawRunning), true);
  assert.equal(canInspectRun(rawRunning, undefined, paths.repo), true);
  assert.deepEqual(mergeMonitorRuns([rawRunning], paths.repo, undefined).map((run) => run.runId), ["legacy"]);
  assert.equal(canInspectRun({ runId: "completed", cwd: paths.link, normalizedStatus: "success" }, undefined, paths.repo), false);
  assert.equal(canInspectRun({ runId: "unknown" }, undefined, paths.repo), false);
  assert.equal(canInspectRun(undefined, undefined, paths.repo), false);
});

test("cwd tracking handles nested and chained cd commands and swaps for cd -", (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));
  assert.deepEqual(parseCdTargets("cd nested && cd path"), ["nested", "path"]);
  assert.deepEqual(parseCdTargets("cd nested && pwd"), []);

  let state = createCwdState(paths.repo);
  state = trackCwdCommand(state, "cd nested/path", paths.repo);
  assert.equal(state.activeCwd, path.join(paths.repo, "nested", "path"));
  state = trackCwdCommand(state, "cd ../.. && cd ../sibling", state.activeCwd);
  assert.equal(state.activeCwd, paths.sibling);
  assert.equal(state.previousCwd, paths.repo);
  state = trackCwdCommand(state, "cd -", state.activeCwd);
  assert.equal(state.activeCwd, paths.repo);
  assert.equal(state.previousCwd, paths.sibling);
});

test("cwd parser accepts trailing semicolons but rejects incomplete conditional chains", (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));

  assert.deepEqual(parseCdTargets("cd nested;"), ["nested"]);
  assert.deepEqual(parseCdTargets("cd nested;   "), ["nested"]);
  assert.deepEqual(parseCdTargets("cd nested &&"), []);
  assert.deepEqual(parseCdTargets("cd nested; && cd path"), []);

  const state = trackCwdCommand(createCwdState(paths.repo), "cd nested;", paths.repo);
  assert.equal(state.activeCwd, path.join(paths.repo, "nested"));
});

test("cwd tracking preserves semicolon and conditional-chain failure semantics", (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));

  const missing = "definitely-missing-directory";
  const semicolon = trackCwdCommand(
    createCwdState(paths.repo),
    `cd ${missing}; cd ${paths.sibling}`,
    paths.repo,
  );
  assert.equal(semicolon.activeCwd, paths.sibling, "semicolon must continue after a failed cd");

  const conditional = trackCwdCommand(
    createCwdState(paths.repo),
    `cd ${missing} && cd ${paths.sibling}`,
    paths.repo,
  );
  assert.equal(conditional.activeCwd, paths.repo, "&& must stop its chain after a failed cd");

  const mixed = trackCwdCommand(
    createCwdState(paths.repo),
    `cd ${missing} && cd ${paths.sibling}; cd nested && cd path; cd ${missing} && cd ${paths.sibling}; cd ${paths.repo}`,
    paths.repo,
  );
  assert.equal(mixed.activeCwd, paths.repo, "semicolon-delimited lists must resume after failed && chains");
});
