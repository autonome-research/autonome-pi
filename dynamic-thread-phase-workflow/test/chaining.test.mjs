import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const cli = join(root, "dynamic-thread-phase-workflow", "bin", "dynamic-thread-phase-workflow.mjs");

function runCli(args, env) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
}

function terminalJson(stdout) {
  const start = stdout.lastIndexOf("\n{");
  return JSON.parse(stdout.slice(start < 0 ? 0 : start + 1));
}

function artifactSpec(name, content) {
  return { name, permissions: "r", phases: [{ type: "artifact", name: "result", content }] };
}

test("after creates one session-scoped successor in the parent chain", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-chain-runner-"));
  const store = join(temp, "store");
  const parentSpec = join(temp, "parent.json");
  const childSpec = join(temp, "child.json");
  writeFileSync(parentSpec, JSON.stringify(artifactSpec("chain-parent", "parent output")));
  writeFileSync(childSpec, JSON.stringify(artifactSpec("chain-child", "child output")));
  const env = { PI_THREAD_PHASE_STORE_DIR: store };

  try {
    const parentRun = runCli(["--spec-file", parentSpec, "--cwd", temp, "--session-id", "chain-session"], env);
    assert.equal(parentRun.status, 0, parentRun.stderr || parentRun.stdout);
    const parent = terminalJson(parentRun.stdout);
    assert.equal(parent.chainStep, 0);
    assert.equal(parent.rootRunId, parent.runId);

    const wrongSession = runCli(["--spec-file", childSpec, "--cwd", temp, "--session-id", "other-session", "--after", parent.runId], env);
    assert.equal(wrongSession.status, 1);
    assert.match(wrongSession.stderr, /different Pi session/);

    const childRun = runCli(["--spec-file", childSpec, "--cwd", temp, "--session-id", "chain-session", "--after", parent.runId], env);
    assert.equal(childRun.status, 0, childRun.stderr || childRun.stdout);
    const child = terminalJson(childRun.stdout);
    assert.equal(child.chainId, parent.chainId);
    assert.equal(child.rootRunId, parent.runId);
    assert.equal(child.parentRunId, parent.runId);
    assert.equal(child.chainStep, 1);

    const result = JSON.parse(readFileSync(join(store, "artifacts", child.runId, "workflow-result.json"), "utf8"));
    assert.equal(result.chainId, parent.chainId);
    assert.equal(result.parentRunId, parent.runId);
    assert.equal(result.chainStep, 1);

    const duplicate = runCli(["--spec-file", childSpec, "--cwd", temp, "--session-id", "chain-session", "--after", parent.runId], env);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, new RegExp(`already has successor ${child.runId}`));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("after rejects running and user-cancelled parents", async () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-chain-parent-status-"));
  const storeDir = join(temp, "store");
  process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
  const store = await import(`../../thread-phase-visualizer/lib/store.mjs?chain-parent-status=${Date.now()}`);
  const specPath = join(temp, "child.json");
  writeFileSync(specPath, JSON.stringify(artifactSpec("status-child", "child")));
  const metadata = {
    sessionId: "chain-session",
    chainId: "12345678-1234-4123-8123-123456789abc",
    rootRunId: "status-parent",
    chainStep: 0,
  };

  try {
    store.createRun({ runId: "running-parent", workflow: "running-parent", cwd: temp, metadata: { ...metadata, rootRunId: "running-parent" } });
    const running = runCli(["--spec-file", specPath, "--cwd", temp, "--session-id", "chain-session", "--after", "running-parent"], { PI_THREAD_PHASE_STORE_DIR: storeDir });
    assert.equal(running.status, 1);
    assert.match(running.stderr, /requires a terminal successful or failed parent/);

    const cancelledParent = store.createRun({ runId: "cancelled-parent", workflow: "cancelled-parent", cwd: temp, metadata: { ...metadata, rootRunId: "cancelled-parent" } });
    store.completeRun(cancelledParent, store.STATUSES.CANCELLED);
    const cancelled = runCli(["--spec-file", specPath, "--cwd", temp, "--session-id", "chain-session", "--after", "cancelled-parent"], { PI_THREAD_PHASE_STORE_DIR: storeDir });
    assert.equal(cancelled.status, 1);
    assert.match(cancelled.stderr, /user-cancelled workflow cannot launch/);
  } finally {
    delete process.env.PI_THREAD_PHASE_STORE_DIR;
    rmSync(temp, { recursive: true, force: true });
  }
});
