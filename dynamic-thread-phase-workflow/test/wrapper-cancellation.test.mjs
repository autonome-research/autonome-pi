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
      tools.get("dynamic_workflow").execute("test", { ...artifactSpec("pre-aborted"), background: true }, controller.signal, undefined, { cwd: root, sessionManager: {} }),
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

test("flat public workflow arguments execute without a spec wrapper", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-flat-public-"));
  const previousStore = process.env.PI_THREAD_PHASE_STORE_DIR;
  process.env.PI_THREAD_PHASE_STORE_DIR = join(testDir, "store");
  try {
    const tools = new Map();
    registerDynamicWorkflows({ registerTool: (definition) => tools.set(definition.name, definition) });
    const result = await tools.get("dynamic_workflow").execute("test", artifactSpec("flat-public"), undefined, undefined, { cwd: testDir, sessionManager: {} });
    assert.equal(result.details.ok, true);
    assert.equal(result.details.workflow, "flat-public");
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

test("advanced harness tool rejects ambiguous and empty inputs", async () => {
  const tools = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => tools.set(definition.name, definition) });
  const execute = tools.get("dynamic_workflow_harness").execute;
  const ctx = { cwd: root, sessionManager: {} };
  await assert.rejects(execute("test", { harness: "export default async function workflow() {}", harnessFile: "/tmp/workflow.mjs", permissions: "rwx" }, undefined, undefined, ctx), /exactly one of template, harness, or harnessFile/);
  await assert.rejects(execute("test", { harness: "", permissions: "rwx" }, undefined, undefined, ctx), /harness must be a non-empty string/);
  await assert.rejects(execute("test", { harness: "   ", permissions: "rwx" }, undefined, undefined, ctx), /harness must be a non-empty string/);
  await assert.rejects(execute("test", { harnessFile: "", permissions: "rwx" }, undefined, undefined, ctx), /harnessFile must be a non-empty path/);
});

test("legacy nested spec arguments are prepared into the flat public format", () => {
  const tools = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => tools.set(definition.name, definition) });
  const prepared = tools.get("dynamic_workflow").prepareArguments({
    spec: {
      name: "legacy",
      permissions: "r",
      metadata: { ticket: "PR-2" },
      phases: [
        { type: "pi", name: "one", prompt: "inspect" },
        { type: "fanout_pi", name: "many", items: ["a"], label: "files", promptTemplate: "review {{item}}" },
      ],
    },
    background: true,
    timeout: 1234,
  });
  assert.equal(prepared.name, "legacy");
  assert.equal(prepared.background, true);
  assert.equal(prepared.timeoutMs, 1234);
  assert.deepEqual(prepared.metadata, { ticket: "PR-2" });
  assert.deepEqual(prepared.phases, [
    { type: "agent", name: "one", prompt: "inspect" },
    { type: "fanout", name: "many", items: ["a"], label: "files", prompt: "review {{item}}" },
  ]);
});

test("legacy preparation rejects conflicts and options the simplified format cannot preserve", () => {
  const tools = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => tools.set(definition.name, definition) });
  const prepare = tools.get("dynamic_workflow").prepareArguments;
  assert.throws(() => prepare({ spec: artifactSpec("permissions-conflict"), permissions: "rw" }), /permissions conflict/);
  assert.throws(() => prepare({ spec: { ...artifactSpec("timeout-conflict"), timeoutMs: 100 }, timeout: 200 }), /timeout conflicts/);
  assert.throws(() => prepare({
    spec: { name: "legacy-artifact", phases: [{ type: "pi", name: "review", prompt: "review", artifact: true }] },
  }), /cannot be represented by the simplified format/);
});

test("legacy alias is registered but removed from the default active tool set", () => {
  const tools = new Map();
  const handlers = new Map();
  let active = ["read", "dynamic_workflow", "dynamic_workflow_harness", "dynamic_thread_phase_workflow"];
  registerDynamicWorkflows({
    registerTool: (definition) => tools.set(definition.name, definition),
    on: (name, handler) => handlers.set(name, handler),
    getActiveTools: () => active,
    setActiveTools: (next) => { active = next; },
  });
  assert.deepEqual([...tools.keys()], ["dynamic_workflow", "dynamic_workflow_harness", "dynamic_thread_phase_workflow"]);
  handlers.get("session_start")();
  assert.deepEqual(active, ["read", "dynamic_workflow", "dynamic_workflow_harness"]);
});
