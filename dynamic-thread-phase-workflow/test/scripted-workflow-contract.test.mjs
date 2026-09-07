import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import registerDynamicWorkflows from "../index.ts";

// Other node:test files also launch workflows concurrently. Scope temporary
// input assertions to this test process rather than observing unrelated runs.
const isolatedTmp = mkdtempSync(join(tmpdir(), "scripted-contract-tmp-"));
const tempEnvironment = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map((key) => [key, process.env[key]]));
for (const key of Object.keys(tempEnvironment)) process.env[key] = isolatedTmp;
test.after(() => {
  for (const [key, value] of Object.entries(tempEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(isolatedTmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function tools() {
  const registered = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => registered.set(definition.name, definition) });
  return registered;
}

function context(cwd, sessionId = "scripted-contract-session") {
  return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

function tempInputs() {
  return new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith("pi-dynamic-workflow-")));
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(20);
  }
  assert.fail(message);
}

test("registered scripted schema replaces the harness tool without declarative schema drift", (t) => {
  const registered = tools();
  assert.deepEqual([...registered.keys()], ["dynamic_workflow", "scripted_workflow", "dynamic_thread_phase_workflow"]);
  assert.equal(registered.has("dynamic_workflow_harness"), false);

  const declarative = registered.get("dynamic_workflow").parameters;
  const declarativeJson = JSON.stringify(declarative);
  assert.equal(Buffer.byteLength(declarativeJson), 4_494);
  assert.equal(createHash("sha256").update(declarativeJson).digest("hex"), "812252eee7b29d7bdbe551dd4ab48f0e524e57d706bc76dc6fec53d64d3c9cf8");

  const scripted = registered.get("scripted_workflow").parameters;
  const scriptedBytes = Buffer.byteLength(JSON.stringify(scripted));
  t.diagnostic(`scripted schema: 920 bytes / 10 properties before -> ${scriptedBytes} bytes / ${Object.keys(scripted.properties).length} properties after`);
  assert.deepEqual(Object.keys(scripted.properties), ["script", "scriptFile", "template", "name", "cwd", "model", "timeoutMs", "background", "after", "permissions"]);
  assert.equal(scripted.additionalProperties, false);
  assert.deepEqual(scripted.required, ["permissions"]);
  assert.deepEqual(scripted.properties.permissions.enum, ["rwx"]);
  for (const removed of ["inputs", "spec", "phases", "resumeRunId", "autoContinue", "metadata", "description", "harness", "harnessFile", "timeout"]) {
    assert.equal(scripted.properties[removed], undefined);
  }
});

test("direct scripted execute strictly rejects legacy, structured, malformed, and unknown arguments without side effects", async () => {
  const temp = mkdtempSync(join(tmpdir(), "scripted-invalid-contract-"));
  const previousStore = process.env.PI_THREAD_PHASE_STORE_DIR;
  process.env.PI_THREAD_PHASE_STORE_DIR = join(temp, "store");
  const execute = tools().get("scripted_workflow").execute;
  const ctx = context(temp);
  const base = { script: "export default async function workflow() {}", permissions: "rwx" };
  const beforeInputs = tempInputs();
  try {
    const rejectedFields = [
      ["inputs", {}], ["spec", {}], ["phases", []], ["resumeRunId", "old-run"], ["autoContinue", true],
      ["metadata", {}], ["description", "old"], ["harness", base.script], ["harnessFile", "old.mjs"],
      ["timeout", 100], ["futureOption", true],
    ];
    for (const [field, value] of rejectedFields) {
      await assert.rejects(execute("test", { ...base, [field]: value }, undefined, undefined, ctx), new RegExp(`unsupported field\\(s\\).*${field}`));
    }

    const malformed = [
      [null, /must be an object/],
      [{ permissions: "rwx" }, /exactly one of template, script, or scriptFile/],
      [{ ...base, scriptFile: "workflow.mjs" }, /exactly one of template, script, or scriptFile/],
      [{ script: " ", permissions: "rwx" }, /script must be a non-empty string/],
      [{ scriptFile: " ", permissions: "rwx" }, /scriptFile must be a non-empty path/],
      [{ template: "../escape", permissions: "rwx" }, /safe saved-template name/],
      [{ ...base, name: "unsafe/name" }, /safe workflow name/],
      [{ ...base, cwd: "" }, /cwd must be a non-empty string/],
      [{ ...base, model: "" }, /model must be a non-empty string/],
      [{ ...base, timeoutMs: 0 }, /between 1 and/],
      [{ ...base, timeoutMs: 2_147_483_648 }, /between 1 and/],
      [{ ...base, timeoutMs: 1.5 }, /between 1 and/],
      [{ ...base, background: "true" }, /background must be a boolean/],
      [{ ...base, after: "bad/run" }, /safe run identifier/],
      [{ script: base.script }, /requires explicit permissions/],
      [{ script: base.script, permissions: "rw" }, /requires explicit permissions/],
    ];
    for (const [params, expected] of malformed) {
      await assert.rejects(execute("test", params, undefined, undefined, ctx), expected);
    }

    await assert.rejects(
      execute("test", { template: "does-not-exist", permissions: "rw" }, undefined, undefined, ctx),
      /requires explicit permissions/,
      "invalid controls must be rejected before opening a template",
    );
    assert.equal(existsSync(process.env.PI_THREAD_PHASE_STORE_DIR), false);
    const leaked = [...tempInputs()].filter((entry) => !beforeInputs.has(entry));
    assert.deepEqual(leaked, [], `invalid calls created temporary inputs: ${leaked.join(", ")}`);
  } finally {
    if (previousStore === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
    else process.env.PI_THREAD_PHASE_STORE_DIR = previousStore;
    rmSync(temp, { recursive: true, force: true });
  }
});

test("inline and file scripted sources execute through durable runner copies and clean temporary inputs", async () => {
  const temp = mkdtempSync(join(tmpdir(), "scripted-source-modes-"));
  const previousStore = process.env.PI_THREAD_PHASE_STORE_DIR;
  process.env.PI_THREAD_PHASE_STORE_DIR = join(temp, "store");
  const execute = tools().get("scripted_workflow").execute;
  const ctx = context(temp);
  const beforeInputs = tempInputs();
  const scriptFile = join(temp, "file-workflow.mjs");
  writeFileSync(scriptFile, `export default async function workflow(ctx) {\n  await ctx.phase("file-phase", async () => "phase result");\n  await ctx.artifact("File result", "file ok", { name: "file-output" });\n}\n`);
  try {
    const inlineSource = `export default async function workflow(ctx) {\n  await ctx.emit("data", { source: "inline" });\n  await ctx.artifact("Inline result", "inline ok", { name: "inline-output" });\n}\n`;
    const inline = await execute("test", { script: inlineSource, name: "inline-script", permissions: "rwx" }, undefined, undefined, ctx);
    assert.equal(inline.details.ok, true);
    const inlineArtifacts = join(temp, "store", "artifacts", inline.details.runId);
    assert.equal(readFileSync(join(inlineArtifacts, "inline-output.md"), "utf8"), "inline ok");
    assert.equal(readFileSync(join(inlineArtifacts, "workflow-harness.mjs"), "utf8"), inlineSource);

    const file = await execute("test", { scriptFile, name: "file-script", permissions: "rwx" }, undefined, undefined, ctx);
    assert.equal(file.details.ok, true);
    assert.equal(readFileSync(join(temp, "store", "artifacts", file.details.runId, "file-output.md"), "utf8"), "file ok");
    assert.equal(existsSync(scriptFile), true, "a caller-owned scriptFile must not be removed");
    const leaked = [...tempInputs()].filter((entry) => !beforeInputs.has(entry));
    assert.deepEqual(leaked, [], `foreground inline script left temporary inputs: ${leaked.join(", ")}`);
  } finally {
    if (previousStore === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
    else process.env.PI_THREAD_PHASE_STORE_DIR = previousStore;
    rmSync(temp, { recursive: true, force: true });
  }
});

test("background scripted workflow returns durable readiness and cleans its generated source", async () => {
  const temp = mkdtempSync(join(tmpdir(), "scripted-background-ready-"));
  const previousStore = process.env.PI_THREAD_PHASE_STORE_DIR;
  process.env.PI_THREAD_PHASE_STORE_DIR = join(temp, "store");
  const beforeInputs = tempInputs();
  try {
    const result = await tools().get("scripted_workflow").execute("test", {
      script: `export default async function workflow(ctx) { await ctx.artifact("Background", "ready", { name: "background-output" }); }`,
      name: "background-script",
      permissions: "rwx",
      background: true,
    }, undefined, undefined, context(temp));
    assert.equal(result.details.ok, true);
    assert.equal(result.details.ready, true);
    assert.equal(result.details.background, true);
    assert.ok(result.details.runId);
    assert.ok(result.details.pid);

    const runFile = join(temp, "store", "runs", `${result.details.runId}.jsonl`);
    await waitFor(() => existsSync(runFile) && readFileSync(runFile, "utf8").includes('"type":"workflow_end"'), "background scripted workflow did not finish");
    const start = JSON.parse(readFileSync(join(temp, "store", "runs", `${result.details.runId}.start.json`), "utf8"));
    assert.equal(start.metadata.continuationMode, "terminal");
    await waitFor(() => {
      // workflow_end is recorded before the final index append. Do not remove
      // this runner's store until it has finished all persistence and exited.
      try { process.kill(result.details.pid, 0); return false; }
      catch (error) { if (error.code === "ESRCH") return true; throw error; }
    }, "background scripted runner did not exit");
    await waitFor(() => [...tempInputs()].every((entry) => beforeInputs.has(entry)), "background generated script was not cleaned");
  } finally {
    if (previousStore === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
    else process.env.PI_THREAD_PHASE_STORE_DIR = previousStore;
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("wrapper cancellation terminates an active scripted helper and records cancellation", { skip: process.platform === "win32" && "requires POSIX process groups", timeout: 20_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "scripted-wrapper-cancel-"));
  const previousStore = process.env.PI_THREAD_PHASE_STORE_DIR;
  process.env.PI_THREAD_PHASE_STORE_DIR = join(temp, "store");
  const ready = join(temp, "helper.ready");
  const helper = join(temp, "helper.mjs");
  writeFileSync(helper, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ready)}, String(process.pid));\nprocess.on("SIGTERM", () => process.exit(0));\nsetInterval(() => {}, 1000);\n`);
  chmodSync(helper, 0o755);
  const controller = new AbortController();
  let promise;
  try {
    promise = tools().get("scripted_workflow").execute("test", {
      script: `export default async function workflow(ctx) { await ctx.shell(${JSON.stringify(`${process.execPath} ${helper}`)}, { name: "hold" }); }`,
      name: "cancel-script",
      permissions: "rwx",
    }, controller.signal, undefined, context(temp));
    void promise.catch(() => {}); // Keep early launch failures handled during readiness polling.
    await waitFor(() => existsSync(ready), "scripted helper did not start");
    controller.abort("cancel scripted wrapper");
    await assert.rejects(promise, /scripted workflow runner cancelled/);
    const runId = readdirSync(join(temp, "store", "runs")).find((file) => file.endsWith(".jsonl"))?.replace(/\.jsonl$/, "");
    assert.ok(runId);
    const events = readFileSync(join(temp, "store", "runs", `${runId}.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.filter((event) => event.type === "workflow_end").at(-1)?.status, "cancelled");
  } finally {
    controller.abort("test cleanup");
    await promise?.catch(() => {});
    if (previousStore === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
    else process.env.PI_THREAD_PHASE_STORE_DIR = previousStore;
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("scripted after creates a same-session successor without changing runner chain semantics", async () => {
  const temp = mkdtempSync(join(tmpdir(), "scripted-after-"));
  const previousStore = process.env.PI_THREAD_PHASE_STORE_DIR;
  process.env.PI_THREAD_PHASE_STORE_DIR = join(temp, "store");
  const registered = tools();
  const ctx = context(temp, "scripted-chain-session");
  try {
    const parent = await registered.get("dynamic_workflow").execute("test", {
      name: "scripted-parent",
      permissions: "r",
      phases: [{ type: "artifact", name: "parent-output", content: "parent" }],
    }, undefined, undefined, ctx);
    const child = await registered.get("scripted_workflow").execute("test", {
      script: `export default async function workflow(ctx) { await ctx.artifact("Child", "child", { name: "child-output" }); }`,
      name: "scripted-child",
      permissions: "rwx",
      after: parent.details.runId,
    }, undefined, undefined, ctx);
    assert.equal(child.details.chainId, parent.details.chainId);
    assert.equal(child.details.rootRunId, parent.details.runId);
    assert.equal(child.details.parentRunId, parent.details.runId);
    assert.equal(child.details.chainStep, 1);
  } finally {
    if (previousStore === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
    else process.env.PI_THREAD_PHASE_STORE_DIR = previousStore;
    rmSync(temp, { recursive: true, force: true });
  }
});
