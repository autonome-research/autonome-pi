import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import registerDynamicWorkflows from "../index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const cli = join(root, "dynamic-thread-phase-workflow/bin/dynamic-thread-phase-workflow.mjs");
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function artifactSpec(name) {
  return { name, permissions: "r", phases: [{ type: "artifact", name: "result", content: "must not run" }] };
}

test("pre-aborted extension request does not spawn a background runner", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-pre-abort-"));
  const previousStore = process.env.PI_THREAD_PHASE_STORE_DIR;
  process.env.PI_THREAD_PHASE_STORE_DIR = join(testDir, "store");
  try {
    const tools = new Map();
    registerDynamicWorkflows({ registerTool: (definition) => tools.set(definition.name, definition) });
    const controller = new AbortController();
    controller.abort("request already cancelled");
    await assert.rejects(
      tools.get("dynamic_workflow").execute("test", { spec: artifactSpec("pre-aborted"), background: true }, controller.signal, undefined, { cwd: root, sessionManager: {} }),
      /cancelled/,
    );
    await wait(200);
    assert.equal(existsSync(join(testDir, "store")), false);
  } finally {
    if (previousStore === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
    else process.env.PI_THREAD_PHASE_STORE_DIR = previousStore;
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("startup SIGTERM is observed before the CLI can detach a background run", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-startup-cancel-"));
  const specPath = join(testDir, "spec.json");
  const store = join(testDir, "store");
  writeFileSync(specPath, JSON.stringify(artifactSpec("startup-cancel")));
  try {
    const child = spawn(process.execPath, [cli, "--spec-file", specPath, "--cwd", root, "--background"], {
      cwd: root,
      env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: store },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.once("spawn", () => child.kill("SIGTERM"));
    await new Promise((resolveClose) => child.once("close", resolveClose));
    await wait(300);
    const runFiles = existsSync(join(store, "runs")) ? readdirSync(join(store, "runs")) : [];
    assert.deepEqual(runFiles, []);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("extension rejects ambiguous workflow input modes", async () => {
  const tools = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => tools.set(definition.name, definition) });
  const execute = tools.get("dynamic_workflow").execute;
  const ctx = { cwd: root, sessionManager: {} };
  const spec = artifactSpec("ambiguous");
  for (const params of [
    { spec, harness: "export default async function workflow() {}" },
    { spec, harnessFile: "/tmp/workflow.mjs" },
    { harness: "export default async function workflow() {}", harnessFile: "/tmp/workflow.mjs", permissions: "rwx" },
  ]) {
    await assert.rejects(execute("test", params, undefined, undefined, ctx), /exactly one of spec, harness, or harnessFile/);
  }
});

test("tool-level timeout validation rejects invalid values and cleans generated input", async () => {
  const tools = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => tools.set(definition.name, definition) });
  const execute = tools.get("dynamic_workflow").execute;
  const ctx = { cwd: root, sessionManager: {} };
  const isolatedTmp = mkdtempSync(join(tmpdir(), "dynamic-wrapper-cleanup-"));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = isolatedTmp;
  try {
    await assert.rejects(execute("test", { spec: artifactSpec("fractional-timeout"), timeout: 1.5 }, undefined, undefined, ctx), /timeout must be an integer/);
    await assert.rejects(execute("test", { spec: artifactSpec("large-timeout"), timeout: 2_147_483_648 }, undefined, undefined, ctx), /timeout must be an integer/);
    assert.deepEqual(readdirSync(isolatedTmp), []);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(isolatedTmp, { recursive: true, force: true });
  }
});
