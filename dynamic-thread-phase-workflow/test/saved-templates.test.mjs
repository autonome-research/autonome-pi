import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("saved structured workflow executes by safe template name and records provenance", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-saved-structured-"));
  const env = withTemplateEnvironment(testDir);
  try {
    writeFileSync(join(env.templates, "review.json"), JSON.stringify({
      name: "saved-review",
      permissions: "r",
      metadata: { owner: "test", targets: "{{inputs.targets}}" },
      phases: [{ type: "artifact", name: "report", content: "saved workflow output: {{inputs.subject}}" }],
    }));
    const result = await registeredTools().get("dynamic_workflow").execute(
      "test",
      { template: "review", inputs: { subject: "cancellation", targets: ["src", "tests"] }, name: "saved-review-override", metadata: { ticket: "T-1" }, background: true },
      undefined,
      undefined,
      executionContext(testDir),
    );

    assert.equal(result.details.ok, true);
    assert.equal(result.details.workflow, "saved-review-override");
    const runId = result.details.runId;
    const start = JSON.parse(readFileSync(join(env.store, "runs", `${runId}.start.json`), "utf8"));
    assert.equal(start.metadata.continuationMode, "terminal", "background workflows return success or failure to chat by default");
    const compiled = JSON.parse(readFileSync(join(env.store, "artifacts", runId, "workflow-spec.json"), "utf8"));
    assert.equal(compiled.metadata.owner, "test");
    assert.equal(compiled.metadata.ticket, "T-1");
    assert.deepEqual(compiled.metadata.targets, ["src", "tests"]);
    assert.equal(compiled.metadata.savedTemplate, "review");
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

test("saved self-contained harness executes by safe template name", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-saved-harness-"));
  const env = withTemplateEnvironment(testDir);
  try {
    writeFileSync(join(env.templates, "harness-report.mjs"), `export default async function workflow(ctx) {\n  await ctx.artifact("Saved harness report", "saved harness output", { name: "saved-harness-report" });\n}\n`);
    const result = await registeredTools().get("dynamic_workflow_harness").execute(
      "test",
      { template: "harness-report", permissions: "rwx" },
      undefined,
      undefined,
      executionContext(testDir),
    );

    assert.equal(result.details.ok, true);
    assert.equal(result.details.workflow, "harness-report");
    assert.equal(readFileSync(join(env.store, "artifacts", result.details.runId, "saved-harness-report.md"), "utf8"), "saved harness output");
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
    const harness = tools.get("dynamic_workflow_harness").execute;
    const ctx = executionContext(testDir);
    const direct = [{ type: "artifact", name: "result", content: "x" }];

    writeFileSync(join(env.templates, "valid.json"), JSON.stringify({ permissions: "r", phases: direct }));
    writeFileSync(join(env.templates, "invalid.json"), "{");
    writeFileSync(join(env.templates, "wrong-kind.json"), JSON.stringify({ harnessFile: "workflow.mjs", phases: direct }));
    writeFileSync(join(env.templates, "needs-input.json"), JSON.stringify({ permissions: "r", phases: [{ type: "artifact", name: "result", content: "{{inputs.message}}" }] }));
    writeFileSync(join(env.templates, "embedded-input.json"), JSON.stringify({ permissions: "r", phases: [{ type: "artifact", name: "result", content: "value={{inputs.message}}" }] }));
    writeFileSync(join(testDir, "outside.json"), JSON.stringify({ permissions: "r", phases: direct }));
    symlinkSync(join(testDir, "outside.json"), join(env.templates, "linked.json"));

    await assert.rejects(workflow("test", { template: "valid", phases: direct }, undefined, undefined, ctx), /exactly one of template, phases, or resumeRunId/);
    await assert.rejects(workflow("test", {}, undefined, undefined, ctx), /exactly one of template, phases, or resumeRunId/);
    await assert.rejects(workflow("test", { resumeRunId: "source-run", name: "do-not-override" }, undefined, undefined, ctx), /accepts only resumeRunId and background/);
    await assert.rejects(workflow("test", { template: "../outside" }, undefined, undefined, ctx), /paths are not accepted/);
    await assert.rejects(workflow("test", { template: "linked" }, undefined, undefined, ctx), /must not be a symbolic link/);
    await assert.rejects(workflow("test", { template: "invalid" }, undefined, undefined, ctx), /Could not parse saved workflow template/);
    await assert.rejects(workflow("test", { template: "wrong-kind" }, undefined, undefined, ctx), /may contain only flat dynamic_workflow arguments/);
    await assert.rejects(workflow("test", { template: "needs-input" }, undefined, undefined, ctx), /requires input: message/);
    await assert.rejects(workflow("test", { template: "needs-input", inputs: { message: "x", typo: "y" } }, undefined, undefined, ctx), /unused inputs: typo/);
    await assert.rejects(workflow("test", { template: "embedded-input", inputs: { message: { nested: true } } }, undefined, undefined, ctx), /must be a scalar when embedded in text/);
    await assert.rejects(workflow("test", { phases: direct, inputs: { message: "x" } }, undefined, undefined, ctx), /inputs may only be used/);
    await assert.rejects(workflow("test", { template: "missing" }, undefined, undefined, ctx), /Available: embedded-input, invalid, needs-input, valid, wrong-kind/);
    await assert.rejects(harness("test", { template: "harness-report", harness: "export default async()=>{}", permissions: "rwx" }, undefined, undefined, ctx), /exactly one of template, harness, or harnessFile/);
    await assert.rejects(harness("test", { template: "harness-report", inputs: { message: "x" }, permissions: "rwx" }, undefined, undefined, ctx), /only by saved structured workflow templates/);
    await assert.rejects(harness("test", { harness: "export default async()=>{}", permissions: "rwx", resumeRunId: "source-run" }, undefined, undefined, ctx), /supported only for structured workflows/);
    assert.equal(existsSync(env.store), false, "template preflight failures must not create visualizer runs");
  } finally {
    env.restore();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("saved template files are bounded before parsing or execution", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "dynamic-saved-template-size-"));
  const env = withTemplateEnvironment(testDir);
  try {
    writeFileSync(join(env.templates, "oversized.json"), " ".repeat(1_000_001));
    await assert.rejects(
      registeredTools().get("dynamic_workflow").execute("test", { template: "oversized" }, undefined, undefined, executionContext(testDir)),
      /exceeds the 1000000-byte limit/,
    );
    assert.deepEqual(existsSync(join(env.store, "runs")) ? readdirSync(join(env.store, "runs")) : [], []);
  } finally {
    env.restore();
    rmSync(testDir, { recursive: true, force: true });
  }
});
