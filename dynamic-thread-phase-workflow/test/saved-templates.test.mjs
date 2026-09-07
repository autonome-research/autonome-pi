import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import registerDynamicWorkflows from "../index.ts";

function registeredTools() {
  const tools = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => tools.set(definition.name, definition) });
  return tools;
}

function withTemplateEnvironment(testDir) {
  const previousTemplateDir = process.env.PI_DYNAMIC_WORKFLOW_TEMPLATE_DIR;
  const previousStore = process.env.PI_THREAD_PHASE_STORE_DIR;
  const templates = join(testDir, "templates");
  const store = join(testDir, "store");
  mkdirSync(templates, { recursive: true });
  process.env.PI_DYNAMIC_WORKFLOW_TEMPLATE_DIR = templates;
  process.env.PI_THREAD_PHASE_STORE_DIR = store;
  return {
    templates,
    store,
    restore() {
      if (previousTemplateDir === undefined) delete process.env.PI_DYNAMIC_WORKFLOW_TEMPLATE_DIR;
      else process.env.PI_DYNAMIC_WORKFLOW_TEMPLATE_DIR = previousTemplateDir;
      if (previousStore === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
      else process.env.PI_THREAD_PHASE_STORE_DIR = previousStore;
    },
  };
}

function executionContext(cwd) {
  return { cwd, sessionManager: {} };
}

async function waitForWorkflowEnd(store, runId, pid) {
  const runFile = join(store, "runs", `${runId}.jsonl`);
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if (existsSync(runFile)) {
      // The runner may still be appending: parse only complete JSONL records.
      const events = readFileSync(runFile, "utf8").split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
      const terminal = events.find((event) => event.type === "workflow_end");
      if (terminal) {
        assert.equal(terminal.status, "success", JSON.stringify(terminal));
        // workflow_end reaches the run log before the index append finishes.
        // Let the owned test runner exit before cleanup removes its store.
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === "ESRCH") return; else throw error; }
      }
    }
    await delay(20);
  }
  assert.fail(`Background workflow ${runId} did not finish within 10 seconds`);
}

test("saved structured workflow executes by safe template name and records provenance", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-saved-structured-"));
  const env = withTemplateEnvironment(testDir);
  try {
    writeFileSync(join(env.templates, "review.json"), JSON.stringify({
      name: "saved-review",
      permissions: "r",
      background: true,
      phases: [{ type: "artifact", name: "report", content: "saved workflow output: {{inputs.subject}}" }],
    }));
    const result = await registeredTools().get("dynamic_workflow").execute(
      "test",
      { template: "review", inputs: { subject: "cancellation" }, name: "saved-review-override" },
      undefined,
      undefined,
      executionContext(testDir),
    );

    assert.equal(result.details.ok, true);
    assert.equal(result.details.workflow, "saved-review-override");
    assert.equal(result.details.ready, true);
    assert.equal(result.details.background, true);
    const runId = result.details.runId;
    // A background readiness acknowledgement is not a completion barrier.
    // Wait before reading outputs or removing the runner's temporary store.
    await waitForWorkflowEnd(env.store, runId, result.details.pid);
    const start = JSON.parse(readFileSync(join(env.store, "runs", `${runId}.start.json`), "utf8"));
    assert.equal(start.metadata.continuationMode, "terminal", "a saved-template background default remains an effective launch control");
    assert.equal(start.metadata.savedTemplate, "review", "saved-template provenance is bound into immutable run ownership");
    const compiled = JSON.parse(readFileSync(join(env.store, "artifacts", runId, "workflow-spec.json"), "utf8"));
    assert.equal(compiled.schema, "pi-dynamic-workflow/v2");
    assert.equal(compiled.metadata, undefined, "caller metadata must not enter the v2 compiled contract");
    const checkpoint = JSON.parse(readFileSync(join(env.store, "artifacts", runId, "workflow-checkpoint.json"), "utf8"));
    assert.equal(checkpoint.savedTemplate, "review", "saved-template provenance is system-owned checkpoint data");
    assert.equal(compiled.phases[0].content, "saved workflow output: cancellation");
    assert.equal(readFileSync(join(env.store, "artifacts", runId, "report.md"), "utf8"), "saved workflow output: cancellation");
  } finally {
    env.restore();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("dynamic_workflow resumes from runId alone without repeating the structured spec", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-tool-resume-"));
  const env = withTemplateEnvironment(testDir);
  try {
    const workflow = registeredTools().get("dynamic_workflow");
    const params = {
      name: "tool-resume",
      permissions: "r",
      phases: [{ type: "artifact", name: "result", content: "durable output" }],
    };
    const first = await workflow.execute("test", params, undefined, undefined, executionContext(testDir));
    assert.equal(first.details.ok, true);
    const resumed = await workflow.execute("test", { resumeRunId: first.details.runId }, undefined, undefined, executionContext(testDir));
    assert.equal(resumed.details.ok, true);
    assert.equal(resumed.details.resumedFromRunId, first.details.runId);
    assert.equal(resumed.details.resumedPhaseCount, 1);
  } finally {
    env.restore();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("saved self-contained scripted workflow executes by safe template name", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-saved-script-"));
  const env = withTemplateEnvironment(testDir);
  try {
    const source = `export default async function workflow(ctx) {\n  await ctx.artifact("Saved harness report", "saved harness output", { name: "saved-harness-report" });\n}\n`;
    writeFileSync(join(env.templates, "harness-report.mjs"), source);
    const result = await registeredTools().get("scripted_workflow").execute(
      "test",
      { template: "harness-report", permissions: "rwx" },
      undefined,
      undefined,
      executionContext(testDir),
    );

    assert.equal(result.details.ok, true);
    assert.equal(result.details.workflow, "harness-report");
    assert.equal(readFileSync(join(env.store, "artifacts", result.details.runId, "saved-harness-report.md"), "utf8"), "saved harness output");
    assert.equal(readFileSync(join(env.store, "artifacts", result.details.runId, "workflow-harness.mjs"), "utf8"), source, "saved scripts execute from a durable self-contained copy");
  } finally {
    env.restore();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("saved templates reject ambiguous modes, traversal, symlinks, invalid JSON, and wrong template kinds", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-saved-template-reject-"));
  const env = withTemplateEnvironment(testDir);
  try {
    const tools = registeredTools();
    const workflow = tools.get("dynamic_workflow").execute;
    const scripted = tools.get("scripted_workflow").execute;
    const ctx = executionContext(testDir);
    const direct = [{ type: "artifact", name: "result", content: "x" }];

    writeFileSync(join(env.templates, "valid.json"), JSON.stringify({ permissions: "r", phases: direct }));
    writeFileSync(join(env.templates, "invalid.json"), "{");
    writeFileSync(join(env.templates, "wrong-kind.json"), JSON.stringify({ harnessFile: "workflow.mjs", phases: direct }));
    writeFileSync(join(env.templates, "removed-metadata.json"), JSON.stringify({ metadata: { owner: "caller" }, phases: direct }));
    writeFileSync(join(env.templates, "removed-phase-field.json"), JSON.stringify({ phases: [{ ...direct[0], fileName: "caller.md" }] }));
    writeFileSync(join(env.templates, "bad-workflow-types.json"), JSON.stringify({ model: false, phases: direct }));
    writeFileSync(join(env.templates, "bad-background.json"), JSON.stringify({ background: "false", phases: direct }));
    writeFileSync(join(env.templates, "bad-phase-model.json"), JSON.stringify({ phases: [{ type: "agent", name: "agent", prompt: "x", model: 7 }] }));
    writeFileSync(join(env.templates, "bad-fanout-boolean.json"), JSON.stringify({ phases: [{ type: "fanout", name: "many", prompt: "{{item}}", items: ["x"], failOnItemFailure: "false" }] }));
    writeFileSync(join(env.templates, "bad-artifact-title.json"), JSON.stringify({ phases: [{ ...direct[0], title: false }] }));
    writeFileSync(join(env.templates, "needs-input.json"), JSON.stringify({ permissions: "r", phases: [{ type: "artifact", name: "result", content: "{{inputs.message}}" }] }));
    writeFileSync(join(env.templates, "embedded-input.json"), JSON.stringify({ permissions: "r", phases: [{ type: "artifact", name: "result", content: "value={{inputs.message}}" }] }));
    writeFileSync(join(testDir, "outside.json"), JSON.stringify({ permissions: "r", phases: direct }));
    writeFileSync(join(testDir, "outside.mjs"), "export default async function workflow() {}\n");
    symlinkSync(join(testDir, "outside.json"), join(env.templates, "linked.json"));
    symlinkSync(join(testDir, "outside.mjs"), join(env.templates, "linked-script.mjs"));

    await assert.rejects(workflow("test", { template: "valid", phases: direct }, undefined, undefined, ctx), /exactly one of template, phases, or resumeRunId/);
    await assert.rejects(workflow("test", {}, undefined, undefined, ctx), /exactly one of template, phases, or resumeRunId/);
    await assert.rejects(workflow("test", { resumeRunId: "source-run", name: "do-not-override" }, undefined, undefined, ctx), /accepts only resumeRunId and background/);
    await assert.rejects(workflow("test", { resumeRunId: "source-run", after: "parent-run" }, undefined, undefined, ctx), /accepts only resumeRunId and background/);
    await assert.rejects(workflow("test", { template: "valid", resumeRunId: "source-run" }, undefined, undefined, ctx), /exactly one of template, phases, or resumeRunId/);
    for (const removed of [
      { description: "caller" }, { metadata: { caller: true } }, { concurrency: 2 },
    ]) await assert.rejects(workflow("test", { phases: direct, ...removed }, undefined, undefined, ctx), /unsupported field/);
    for (const removedPhase of [
      { type: "agent", name: "agent", prompt: "x", description: "caller" },
      { type: "shell", name: "shell", command: "true", retry: { maxAttempts: 2 } },
      { type: "fanout", name: "fanout", items: ["x"], prompt: "{{item}}", label: "items" },
      { ...direct[0], fileName: "caller.md" },
      { ...direct[0], kind: "json" },
    ]) await assert.rejects(workflow("test", { phases: [removedPhase] }, undefined, undefined, ctx), /unsupported field/);
    await assert.rejects(workflow("test", { template: "../outside" }, undefined, undefined, ctx), /(?:paths are not accepted|safe saved-template name)/);
    await assert.rejects(workflow("test", { template: "linked" }, undefined, undefined, ctx), /must not be a symbolic link/);
    await assert.rejects(workflow("test", { template: "invalid" }, undefined, undefined, ctx), /Could not parse saved workflow template/);
    await assert.rejects(workflow("test", { template: "wrong-kind" }, undefined, undefined, ctx), /(?:may contain only flat dynamic_workflow arguments|unsupported field)/);
    await assert.rejects(workflow("test", { template: "removed-metadata" }, undefined, undefined, ctx), /unsupported field.*metadata/);
    await assert.rejects(workflow("test", { template: "removed-phase-field" }, undefined, undefined, ctx), /unsupported field.*fileName/);
    await assert.rejects(workflow("test", { phases: direct, background: "false" }, undefined, undefined, ctx), /background must be a boolean/);
    for (const malformed of ["bad-workflow-types", "bad-background", "bad-phase-model", "bad-fanout-boolean", "bad-artifact-title"]) {
      await assert.rejects(workflow("test", { template: malformed }, undefined, undefined, ctx), /must be|invalid/);
    }
    await assert.rejects(workflow("test", { template: "needs-input" }, undefined, undefined, ctx), /requires input: message/);
    await assert.rejects(workflow("test", { template: "needs-input", inputs: { message: "x", typo: "y" } }, undefined, undefined, ctx), /unused inputs: typo/);
    await assert.rejects(workflow("test", { template: "embedded-input", inputs: { message: { nested: true } } }, undefined, undefined, ctx), /must be a scalar when embedded in text/);
    await assert.rejects(workflow("test", { phases: direct, inputs: { message: "x" } }, undefined, undefined, ctx), /inputs may only be used/);
    await assert.rejects(workflow("test", { template: "missing" }, undefined, undefined, ctx), /Available: .*valid/);
    await assert.rejects(scripted("test", { template: "harness-report", script: "export default async()=>{}", permissions: "rwx" }, undefined, undefined, ctx), /exactly one of template, script, or scriptFile/);
    await assert.rejects(scripted("test", { template: "../outside", permissions: "rwx" }, undefined, undefined, ctx), /safe saved-template name/);
    await assert.rejects(scripted("test", { template: "linked-script", permissions: "rwx" }, undefined, undefined, ctx), /must not be a symbolic link/);
    await assert.rejects(scripted("test", { template: "does-not-exist" }, undefined, undefined, ctx), /requires explicit permissions/, "permissions must be validated before reading a saved script");
    await assert.rejects(scripted("test", { template: "harness-report", inputs: { message: "x" }, permissions: "rwx" }, undefined, undefined, ctx), /unsupported field.*inputs/);
    await assert.rejects(scripted("test", { script: "export default async()=>{}", permissions: "rwx", resumeRunId: "source-run" }, undefined, undefined, ctx), /unsupported field.*resumeRunId/);
    assert.equal(existsSync(env.store), false, "template preflight failures must not create visualizer runs");
  } finally {
    env.restore();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("saved structured and scripted template files are bounded before parsing or execution", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-saved-template-size-"));
  const env = withTemplateEnvironment(testDir);
  try {
    writeFileSync(join(env.templates, "oversized.json"), " ".repeat(1_000_001));
    writeFileSync(join(env.templates, "oversized.mjs"), " ".repeat(1_000_001));
    const registered = registeredTools();
    await assert.rejects(
      registered.get("dynamic_workflow").execute("test", { template: "oversized" }, undefined, undefined, executionContext(testDir)),
      /exceeds the 1000000-byte limit/,
    );
    await assert.rejects(
      registered.get("scripted_workflow").execute("test", { template: "oversized", permissions: "rwx" }, undefined, undefined, executionContext(testDir)),
      /exceeds the 1000000-byte limit/,
    );
    assert.deepEqual(existsSync(join(env.store, "runs")) ? readdirSync(join(env.store, "runs")) : [], []);
  } finally {
    env.restore();
    rmSync(testDir, { recursive: true, force: true });
  }
});
