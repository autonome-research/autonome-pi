import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const cli = join(root, "dynamic-thread-phase-workflow/bin/dynamic-thread-phase-workflow.mjs");

function runHarness(harnessFile, store, extraArgs = []) {
  return spawnSync(process.execPath, [cli, "--js-file", harnessFile, "--permissions", "rwx", "--cwd", root, ...extraArgs], {
    cwd: root,
    env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: store },
    encoding: "utf8",
    timeout: 5_000,
  });
}

test("generated foreground harness is copied to durable artifacts before cleanup", () => {
  const generatedDir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflow-"));
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-input-lifecycle-"));
  const harnessFile = join(generatedDir, "workflow-harness.mjs");
  writeFileSync(harnessFile, "export default async function workflow(ctx) { await ctx.artifact('result', 'ok'); }\n");
  try {
    const result = runHarness(harnessFile, join(testDir, "store"), ["--cleanup-input"]);
    assert.equal(result.status, 0, result.stderr);
    const details = JSON.parse(result.stdout);
    const durableHarness = join(dirname(details.resultPath), "workflow-harness.mjs");
    assert.equal(existsSync(generatedDir), false);
    assert.equal(existsSync(durableHarness), true);
    assert.match(readFileSync(durableHarness, "utf8"), /ctx\.artifact/);
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("cleanup removes only the generated input and preserves unrelated temp files", () => {
  const generatedDir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflow-"));
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-input-neighbor-"));
  const harnessFile = join(generatedDir, "workflow-harness.mjs");
  const unrelatedFile = join(generatedDir, "unrelated.txt");
  writeFileSync(harnessFile, "export default async function workflow() {}\n");
  writeFileSync(unrelatedFile, "keep me\n");
  try {
    const result = runHarness(harnessFile, join(testDir, "store"), ["--cleanup-input"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(harnessFile), false);
    assert.equal(existsSync(unrelatedFile), true);
    assert.equal(readFileSync(unrelatedFile, "utf8"), "keep me\n");
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("user-supplied harness is never deleted without the cleanup handshake", () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-user-harness-"));
  const harnessFile = join(testDir, "user-harness.mjs");
  writeFileSync(harnessFile, "export default async function workflow() {}\n");
  try {
    const result = runHarness(harnessFile, join(testDir, "store"));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(harnessFile), true);
    const details = JSON.parse(result.stdout);
    assert.equal(existsSync(join(dirname(details.resultPath), "workflow-harness.mjs")), true);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("generated background harness is removed after detached runner takes ownership", async () => {
  const generatedDir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflow-"));
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-background-input-"));
  const harnessFile = join(generatedDir, "workflow-harness.mjs");
  writeFileSync(harnessFile, "export default async function workflow() {}\n");
  try {
    const result = runHarness(harnessFile, join(testDir, "store"), ["--background", "--cleanup-input"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).background, true);
    const deadline = Date.now() + 5_000;
    while (existsSync(generatedDir) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(existsSync(generatedDir), false);
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
    rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("missing harness fails preflight without creating a visualizer run", () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-setup-failure-"));
  const store = join(testDir, "store");
  const missingHarness = join(testDir, "missing-harness.mjs");
  try {
    const result = runHarness(missingHarness, store, ["--background"]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(store, "runs")), false);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("directory-valued harness fails preflight before background acknowledgement", () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-directory-harness-"));
  try {
    const result = runHarness(testDir, join(testDir, "store"), ["--background"]);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /"background"\s*:\s*true/);
    assert.match(result.stderr, /must be a regular file/);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("detached runner cleans generated input when validation fails before createRun", () => {
  const generatedDir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflow-"));
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-detached-early-failure-"));
  const specFile = join(generatedDir, "workflow-spec.json");
  writeFileSync(specFile, JSON.stringify({ name: "early-failure", permissions: "r", phases: [{ type: "artifact", name: "result", content: "x" }] }));
  try {
    const result = spawnSync(process.execPath, [cli, "--spec-file", specFile, "--cleanup-input", "--timeout", "0", "--cwd", root], {
      cwd: root,
      env: { ...process.env, PI_DYNAMIC_WORKFLOW_BACKGROUND: "1", PI_THREAD_PHASE_STORE_DIR: join(testDir, "store") },
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(generatedDir), false);
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
    rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("cleanup handshake refuses non-generated directories", () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-refuse-cleanup-"));
  const harnessFile = join(testDir, "user-harness.mjs");
  writeFileSync(harnessFile, "export default async function workflow() {}\n");
  try {
    const result = runHarness(harnessFile, join(testDir, "store"), ["--cleanup-input"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to clean non-generated workflow input directory/);
    assert.equal(existsSync(harnessFile), true);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
