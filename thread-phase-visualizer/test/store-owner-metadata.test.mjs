import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-owner-test-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
process.on("exit", () => rmSync(storeDir, { recursive: true, force: true }));
const store = await import(`../lib/store.mjs?owner=${Date.now()}`);

test("createRun records canonical launch source and cwd-at-launch metadata", () => {
  const run = store.createRun({
    workflow: "owner-test",
    cwd: "/repo",
    trigger: { kind: "background" },
    metadata: { sessionId: "session-a" },
  });
  assert.deepEqual(run.metadata, {
    sessionId: "session-a",
    launchSource: "background",
    cwdAtLaunch: "/repo",
  });
  assert.deepEqual(store.getRunSummary(run.runId).metadata, run.metadata);
});

test("createRun canonicalizes launch cwd from the runner origin, not owner metadata", (t) => {
  const root = mkdtempSync(join(tmpdir(), "thread-phase-owner-cwd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const sibling = join(root, "sibling");
  const link = join(root, "repo-link");
  mkdirSync(repo);
  mkdirSync(sibling);
  symlinkSync(repo, link, "dir");

  const run = store.createRun({
    workflow: "canonical-owner-test",
    cwd: path.relative(process.cwd(), link),
    metadata: { cwdAtLaunch: sibling },
  });
  const canonical = realpathSync(repo);
  assert.equal(run.cwd, canonical);
  assert.equal(run.metadata.cwdAtLaunch, canonical);
  const summary = store.getRunSummary(run.runId);
  assert.equal(summary.cwd, canonical);
  assert.equal(summary.metadata.cwdAtLaunch, canonical);
});

test("createRun drops relative owner cwd metadata when no launch origin exists", () => {
  const run = store.createRun({
    workflow: "relative-owner-cwd-test",
    metadata: { sessionId: "session-a", cwdAtLaunch: "requested/repo" },
  });
  assert.equal(run.cwd, undefined);
  assert.deepEqual(run.metadata, { sessionId: "session-a" });
  assert.deepEqual(store.getRunSummary(run.runId).metadata, run.metadata);
});

test("emit canonicalizes relative cwd and owner metadata for direct producers", () => {
  const event = store.emit({
    runId: "direct-relative-cwd",
    workflow: "direct-producer",
    cwd: ".",
  }, {
    type: store.EVENT_TYPES.WORKFLOW_START,
    status: store.STATUSES.RUNNING,
    metadata: { cwdAtLaunch: ".", sessionId: "session-direct" },
  });
  const canonical = realpathSync(process.cwd());
  assert.equal(event.cwd, canonical);
  assert.equal(event.metadata.cwdAtLaunch, canonical);
  assert.equal(store.getRunSummary(event.runId).cwd, canonical);
});
