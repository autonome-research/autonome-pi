import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const cli = join(root, "dynamic-thread-phase-workflow/bin/dynamic-thread-phase-workflow.mjs");

test("dynamic runner reports a phase timeout instead of generic exit 143", { skip: process.platform === "win32" && "requires POSIX shell process groups" }, () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-timeout-test-"));
  try {
    const specPath = join(temp, "spec.json");
    writeFileSync(specPath, JSON.stringify({
      name: "timeout-regression",
      permissions: "rwx",
      phases: [{ type: "shell", name: "slow", timeoutMs: 40, command: "sleep 10" }],
    }));
    const result = spawnSync(process.execPath, [cli, "--spec-file", specPath, "--cwd", temp], {
      cwd: root,
      env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: join(temp, "store") },
      encoding: "utf8",
      timeout: 5_000,
    });

    assert.equal(result.status, 1, result.stderr);
    const details = JSON.parse(result.stdout);
    assert.match(details.error, /timed out after 40 ms; terminated with SIGTERM/);
    assert.doesNotMatch(details.error, /exited 143/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("structured specs reject invalid fanout concurrency before execution", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-concurrency-validation-test-"));
  try {
    for (const concurrency of [0, -1, 1.5, 65, null]) {
      const specPath = join(temp, `spec-${String(concurrency).replace(".", "_")}.json`);
      writeFileSync(specPath, JSON.stringify({
        name: "bad-concurrency",
        permissions: "r",
        phases: [{ type: "fanout_pi", name: "never-runs", concurrency, items: ["x"], promptTemplate: "{{item}}" }],
      }));
      const result = spawnSync(process.execPath, [cli, "--spec-file", specPath, "--cwd", temp], {
        cwd: root,
        env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: join(temp, "store") },
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /never-runs\.concurrency must be an integer between 1 and 64/);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("structured specs reject invalid phase timeout values before execution", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-timeout-validation-test-"));
  try {
    const specPath = join(temp, "spec.json");
    writeFileSync(specPath, JSON.stringify({
      name: "bad-timeout",
      permissions: "rwx",
      phases: [{ type: "shell", name: "never-runs", timeoutMs: 0, command: "exit 99" }],
    }));
    const result = spawnSync(process.execPath, [cli, "--spec-file", specPath, "--cwd", temp], {
      cwd: root,
      env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: join(temp, "store") },
      encoding: "utf8",
      timeout: 5_000,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /never-runs\.timeoutMs must be an integer/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
