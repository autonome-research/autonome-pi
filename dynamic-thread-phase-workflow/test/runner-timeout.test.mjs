import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("background spawn failure does not emit a success acknowledgement", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-background-spawn-test-"));
  try {
    const specPath = join(temp, "spec.json");
    writeFileSync(specPath, JSON.stringify({ name: "bad-background-cwd", permissions: "r", phases: [{ type: "artifact", name: "result", content: "x" }] }));
    const missingCwd = join(temp, "does-not-exist");
    const result = spawnSync(process.execPath, [cli, "--spec-file", specPath, "--cwd", missingCwd, "--background"], {
      cwd: root, env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: join(temp, "store") }, encoding: "utf8", timeout: 5_000,
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /"background"\s*:\s*true/);
    assert.match(result.stderr, /ENOENT/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("invalid CLI timeout is rejected before creating a visualizer run", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-cli-timeout-validation-test-"));
  try {
    const specPath = join(temp, "spec.json");
    const store = join(temp, "store");
    writeFileSync(specPath, JSON.stringify({ name: "bad-cli-timeout", permissions: "rwx", phases: [{ type: "shell", name: "never-runs", command: "exit 99" }] }));
    const result = spawnSync(process.execPath, [cli, "--spec-file", specPath, "--cwd", temp, "--timeout", "0"], {
      cwd: root,
      env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: store },
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--timeout must be an integer/);
    assert.equal(existsSync(join(store, "runs")), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("structured specs reject explicit and resolved fanouts above the item cap", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-fanout-size-test-"));
  try {
    const explicitPath = join(temp, "explicit.json");
    writeFileSync(explicitPath, JSON.stringify({
      name: "large-explicit-fanout", permissions: "r",
      phases: [{ type: "fanout_pi", name: "too-many", items: new Array(1_001).fill("x"), promptTemplate: "{{item}}" }],
    }));
    const explicit = spawnSync(process.execPath, [cli, "--spec-file", explicitPath, "--cwd", temp], {
      cwd: root, env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: join(temp, "explicit-store") }, encoding: "utf8", timeout: 5_000,
    });
    assert.notEqual(explicit.status, 0);
    assert.match(explicit.stderr, /too-many\.items is capped at 1000 items/);

    const resolvedPath = join(temp, "resolved.json");
    const command = `${JSON.stringify(process.execPath)} -e "console.log(Array.from({length:1001},(_,i)=>i).join('\\\\n'))"`;
    writeFileSync(resolvedPath, JSON.stringify({
      name: "large-resolved-fanout", permissions: "rwx",
      phases: [
        { type: "shell", name: "items", command },
        { type: "fanout_pi", name: "too-many-resolved", itemsFrom: "items", promptTemplate: "{{item}}" },
      ],
    }));
    const resolved = spawnSync(process.execPath, [cli, "--spec-file", resolvedPath, "--cwd", temp], {
      cwd: root, env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: join(temp, "resolved-store") }, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(resolved.status, 1, resolved.stderr);
    assert.match(JSON.parse(resolved.stdout).error, /too-many-resolved\.items is capped at 1000 items/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("fanout progress reaches total when failures are allowed", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-fanout-progress-test-"));
  try {
    const fakePi = join(temp, "fake-pi.mjs");
    writeFileSync(fakePi, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',model:'fake',content:[{type:'text',text:'failed item'}]}}));\nprocess.exitCode=1;\n`);
    chmodSync(fakePi, 0o755);
    const specPath = join(temp, "spec.json");
    const store = join(temp, "store");
    writeFileSync(specPath, JSON.stringify({
      name: "fanout-progress", permissions: "r", phases: [{
        type: "fanout_pi", name: "allowed-failures", items: ["a", "b"], promptTemplate: "{{item}}", failOnItemFailure: false,
      }],
    }));
    const result = spawnSync(process.execPath, [cli, "--spec-file", specPath, "--cwd", temp], {
      cwd: root, env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: store, PI_DYNAMIC_WORKFLOW_PI_BIN: fakePi }, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const runFile = join(store, "runs", readdirSync(join(store, "runs"))[0]);
    const events = readFileSync(runFile, "utf8").trim().split("\n").map(JSON.parse);
    const progress = events.filter((event) => event.data?.kind === "progress").at(-1)?.data;
    assert.equal(progress?.completed, 2);
    assert.equal(progress?.total, 2);
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
