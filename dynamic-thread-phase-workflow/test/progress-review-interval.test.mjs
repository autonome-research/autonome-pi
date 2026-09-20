import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const testStore = mkdtempSync(join(tmpdir(), "dynamic-progress-review-interval-store-"));
const previousStore = process.env.PI_THREAD_PHASE_STORE_DIR;
const previousPi = process.env.PI_DYNAMIC_WORKFLOW_PI_BIN;
process.env.PI_THREAD_PHASE_STORE_DIR = testStore;
process.on("exit", () => {
  if (previousStore === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
  else process.env.PI_THREAD_PHASE_STORE_DIR = previousStore;
  if (previousPi === undefined) delete process.env.PI_DYNAMIC_WORKFLOW_PI_BIN;
  else process.env.PI_DYNAMIC_WORKFLOW_PI_BIN = previousPi;
  rmSync(testStore, { recursive: true, force: true });
});

const { default: registerDynamicWorkflows } = await import("../index.ts");
const { default: registerVisualizer } = await import("../../thread-phase-visualizer/index.ts");
const store = await import("../../thread-phase-visualizer/lib/store.mjs");
const supervision = await import("../../thread-phase-visualizer/lib/supervision-store.mjs");

function tools() {
  const registered = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => registered.set(definition.name, definition) });
  return registered;
}

function workflowContext(cwd, sessionId = "progress-interval-session", mode = "tui") {
  return { cwd, mode, sessionManager: { getSessionId: () => sessionId } };
}

function host(sessionId, cwd, idle = true) {
  const handlers = new Map();
  const messages = [];
  const lifecycle = { shutdowns: 0 };
  const api = {
    registerMessageRenderer() {}, registerTool() {}, registerShortcut() {}, registerCommand() {},
    on(name, handler) {
      handlers.set(name, name === "session_shutdown" ? (...args) => {
        const result = handler(...args);
        lifecycle.shutdowns++;
        return result;
      } : handler);
    },
    sendMessage() {},
    sendUserMessage(message) { messages.push(message); },
  };
  registerVisualizer(api);
  const state = { idle };
  const context = {
    cwd, mode: "tui", hasUI: false, isIdle: () => state.idle,
    ui: { notify() {}, setStatus() {}, setWidget() {} },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
  };
  return { handlers, messages, state, context, lifecycle };
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(message);
}

function writeHoldingPi(directory, releaseFile) {
  const fakePi = join(directory, "fake-pi.mjs");
  writeFileSync(fakePi, `import { existsSync, watch } from "node:fs";
const release = ${JSON.stringify(releaseFile)};
const done = () => console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "fake", content: [{ type: "text", text: "done" }] } }));
if (existsSync(release)) done();
else { const watcher = watch(${JSON.stringify(directory)}, () => { if (existsSync(release)) { watcher.close(); done(); } }); }
`);
  chmodSync(fakePi, 0o755);
  return fakePi;
}

function runEvents(runId) {
  const file = store.runFileFor(runId);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}

test("typed cadence is strict, top-level, and background-hosted only", async () => {
  const registered = tools();
  const dynamicSchema = registered.get("dynamic_workflow").parameters;
  const scriptedSchema = registered.get("scripted_workflow").parameters;
  assert.equal(scriptedSchema.properties.progressReviewIntervalMs.type, "integer");
  assert.equal(scriptedSchema.properties.progressReviewIntervalMs.minimum, 60_000);
  assert.equal(scriptedSchema.properties.progressReviewIntervalMs.maximum, 2_147_483_647);
  // dynamic_workflow allows null to disable periodic reviews.
  assert.deepEqual(dynamicSchema.properties.progressReviewIntervalMs, {
    anyOf: [
      { type: "integer", minimum: 60_000, maximum: 2_147_483_647, description: "Hosted background progress-review cadence in milliseconds (null disables periodic reviews); this is not a timeout." },
      { type: "null" },
    ],
  });
  assert.deepEqual(scriptedSchema.properties.progressReviewIntervalMs.minimum, 60_000);

  const dynamic = registered.get("dynamic_workflow").execute;
  const scripted = registered.get("scripted_workflow").execute;
  const cwd = mkdtempSync(join(tmpdir(), "progress-interval-validation-"));
  try {
    const base = { name: "interval-validation", permissions: "r", phases: [{ type: "artifact", name: "out", content: "ok" }] };
    for (const value of [59_999, 1.5, "3600000"]) {
      await assert.rejects(dynamic("test", { ...base, background: true, progressReviewIntervalMs: value }, undefined, undefined, workflowContext(cwd)), /progressReviewIntervalMs.*integer between/);
    }
    // null is no longer rejected by the value validator (the schema anyOf above
    // and validateProgressReviewInterval accept it); a fully positive null launch
    // is exercised separately as an end-to-end offline run in the v3/runner suites.
    await assert.rejects(dynamic("test", { ...base, progressReviewIntervalMs: 3_600_000 }, undefined, undefined, workflowContext(cwd, "progress-interval-session", undefined)), /only valid for a new hosted supervised background/);
    await assert.rejects(dynamic("test", { ...base, background: true, phases: [{ type: "artifact", name: "out", content: "ok", progressReviewIntervalMs: 3_600_000 }] }, undefined, undefined, workflowContext(cwd)), /unsupported field/);
    await assert.rejects(scripted("test", {
      script: "export default async function workflow() {}",
      permissions: "rwx", background: true, progressReviewIntervalMs: 3_600_000,
    }, undefined, undefined, { cwd, sessionManager: {} }), /only valid for a new hosted supervised background/);
    await assert.rejects(dynamic("test", { resumeRunId: "source-run", background: true, progressReviewIntervalMs: 3_600_000 }, undefined, undefined, workflowContext(cwd)), /accepts only resumeRunId and background/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("shared public launch authorization requires a TUI or RPC host", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "progress-interval-host-boundary-"));
  const registered = tools();
  const dynamic = registered.get("dynamic_workflow").execute;
  const scripted = registered.get("scripted_workflow").execute;
  const dynamicParams = {
    name: "host-boundary-dynamic", permissions: "r", background: true,
    progressReviewIntervalMs: 3_600_000,
    phases: [{ type: "artifact", name: "out", content: "ok" }],
  };
  const scriptedParams = {
    script: `export default async function workflow(ctx) { await ctx.artifact("out", "ok", { name: "out" }); }`,
    permissions: "rwx", background: true, progressReviewIntervalMs: 3_600_000,
  };
  const ownedRunIds = [];
  try {
    for (const mode of [undefined, "unknown", "json", "print"]) {
      const ctx = workflowContext(cwd, "host-boundary-session", mode);
      if (mode === undefined) {
        delete ctx.mode;
        assert.equal(Object.hasOwn(ctx, "mode"), false, "missing-mode fixture must omit mode");
      }
      await assert.rejects(dynamic("test", dynamicParams, undefined, undefined, ctx), /only valid for a new hosted supervised background/);
      await assert.rejects(scripted("test", scriptedParams, undefined, undefined, ctx), /only valid for a new hosted supervised background/);
    }
    await assert.rejects(dynamic("test", dynamicParams, undefined, undefined, workflowContext(cwd, null, "tui")), /only valid for a new hosted supervised background/);
    await assert.rejects(scripted("test", scriptedParams, undefined, undefined, workflowContext(cwd, null, "rpc")), /only valid for a new hosted supervised background/);

    for (const mode of ["tui", "rpc"]) {
      const dynamicResult = await dynamic("test", { ...dynamicParams, name: `hosted-dynamic-${mode}` }, undefined, undefined, workflowContext(cwd, "hosted-session", mode));
      ownedRunIds.push(dynamicResult.details.runId);
      const dynamicStart = JSON.parse(readFileSync(join(testStore, "runs", `${dynamicResult.details.runId}.start.json`), "utf8"));
      assert.equal(dynamicStart.metadata.supervisionMode, "main-agent");
      assert.equal(dynamicStart.metadata.progressReviewIntervalMs, 3_600_000);

      const scriptedResult = await scripted("test", { ...scriptedParams, name: `hosted-scripted-${mode}` }, undefined, undefined, workflowContext(cwd, "hosted-session", mode));
      ownedRunIds.push(scriptedResult.details.runId);
      const scriptedStart = JSON.parse(readFileSync(join(testStore, "runs", `${scriptedResult.details.runId}.start.json`), "utf8"));
      assert.equal(scriptedStart.metadata.supervisionMode, "main-agent");
      assert.equal(scriptedStart.metadata.progressReviewIntervalMs, 3_600_000);
    }

    const templateDir = mkdtempSync(join(tmpdir(), "progress-interval-templates-"));
    const templateRunIds = [];
    const previousTemplateDir = process.env.PI_DYNAMIC_WORKFLOW_TEMPLATE_DIR;
    process.env.PI_DYNAMIC_WORKFLOW_TEMPLATE_DIR = templateDir;
    try {
      writeFileSync(join(templateDir, "hourly.json"), JSON.stringify({
        name: "hourly-template", permissions: "r", background: true,
        progressReviewIntervalMs: 3_600_000,
        phases: [{ type: "artifact", name: "out", content: "ok" }],
      }));
      writeFileSync(join(templateDir, "scripted.mjs"), `export default async function workflow(ctx) { await ctx.artifact("out", "ok", { name: "out" }); }\n`);
      await assert.rejects(dynamic("test", { template: "hourly", inputs: {} }, undefined, undefined, workflowContext(cwd, "template-session", "json")), /only valid for a new hosted supervised background/);
      await assert.rejects(scripted("test", { template: "scripted", permissions: "rwx", background: true, progressReviewIntervalMs: 3_600_000 }, undefined, undefined, workflowContext(cwd, "template-session", "print")), /only valid for a new hosted supervised background/);
      const templated = await dynamic("test", { template: "hourly", inputs: {} }, undefined, undefined, workflowContext(cwd, "template-session", "rpc"));
      ownedRunIds.push(templated.details.runId);
      templateRunIds.push(templated.details.runId);
      const templatedStart = JSON.parse(readFileSync(join(testStore, "runs", `${templated.details.runId}.start.json`), "utf8"));
      assert.equal(templatedStart.metadata.progressReviewIntervalMs, 3_600_000);
      const scriptedTemplate = await scripted("test", { template: "scripted", permissions: "rwx", background: true, progressReviewIntervalMs: 3_600_000 }, undefined, undefined, workflowContext(cwd, "template-session", "tui"));
      ownedRunIds.push(scriptedTemplate.details.runId);
      templateRunIds.push(scriptedTemplate.details.runId);
      const scriptedTemplateStart = JSON.parse(readFileSync(join(testStore, "runs", `${scriptedTemplate.details.runId}.start.json`), "utf8"));
      assert.equal(scriptedTemplateStart.metadata.progressReviewIntervalMs, 3_600_000);
    } finally {
      await Promise.all(templateRunIds.map((runId) => waitFor(
        () => runEvents(runId).some((event) => event.type === "workflow_end"),
        `template fixture ${runId} did not finish`,
      )));
      if (previousTemplateDir === undefined) delete process.env.PI_DYNAMIC_WORKFLOW_TEMPLATE_DIR;
      else process.env.PI_DYNAMIC_WORKFLOW_TEMPLATE_DIR = previousTemplateDir;
      rmSync(templateDir, { recursive: true, force: true });
    }
  } finally {
    await Promise.all(ownedRunIds.map((runId) => waitFor(
      () => runEvents(runId).some((event) => event.type === "workflow_end"),
      `host boundary fixture ${runId} did not finish`,
    )));
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("explicit hourly cadence is authoritative, survives restart, and cleans up after a post-restart failure", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "progress-interval-hourly-"));
  const release = join(cwd, "release");
  const previousPiValue = process.env.PI_DYNAMIC_WORKFLOW_PI_BIN;
  process.env.PI_DYNAMIC_WORKFLOW_PI_BIN = writeHoldingPi(cwd, release);
  const sessionId = "progress-interval-restart-session";
  const firstHost = host(sessionId, cwd);
  const registered = tools();
  const cleanupErrors = [];
  let injectedFailure;
  let primaryError;
  let restarted;
  let runId;
  let settled = false;
  try {
    await firstHost.handlers.get("session_start")({}, firstHost.context);
    const result = await registered.get("dynamic_workflow").execute("test", {
      name: "hourly-review", permissions: "r", background: true,
      progressReviewIntervalMs: 3_600_000,
      timeoutMs: 15_000,
      phases: [{ type: "agent", name: "worker", prompt: "wait" }],
    }, undefined, undefined, workflowContext(cwd, sessionId));
    runId = result.details.runId;
    await waitFor(() => supervision.loadProgressReviewRecords({ storeDir: testStore }).some((record) => record.runId === runId), "explicit cadence was not scheduled");
    const start = JSON.parse(readFileSync(join(testStore, "runs", `${runId}.start.json`), "utf8"));
    assert.equal(start.metadata.progressReviewIntervalMs, 3_600_000);
    assert.equal(start.metadata.continuationMode, "terminal");
    const initial = supervision.loadProgressReviewRecords({ storeDir: testStore }).find((record) => record.runId === runId);
    assert.ok(initial, "initial durable review schedule is present");
    assert.equal(initial.cadenceMs, 3_600_000);

    firstHost.handlers.get("session_shutdown")({}, firstHost.context);
    restarted = host(sessionId, cwd);
    await restarted.handlers.get("session_start")({}, restarted.context);
    const afterRestart = supervision.loadProgressReviewRecords({ storeDir: testStore }).find((record) => record.runId === runId);
    assert.ok(afterRestart, "durable review schedule survives restart");
    assert.deepEqual(
      { checkId: afterRestart.checkId, startedAt: afterRestart.startedAt, dueAt: afterRestart.dueAt, cadenceMs: afterRestart.cadenceMs },
      { checkId: initial.checkId, startedAt: initial.startedAt, dueAt: initial.dueAt, cadenceMs: initial.cadenceMs },
      "reload must preserve the existing durable schedule identity, anchor, deadline, and cadence",
    );
    assert.equal(restarted.messages.length, 0, "hourly review is not immediately due");
    try { assert.fail("simulated assertion after replacement startup"); }
    catch (error) { injectedFailure = error; throw error; }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      try { writeFileSync(release, "release"); } catch (error) { cleanupErrors.push(error); }
      if (runId) {
        try {
          await waitFor(() => runEvents(runId).some((event) => event.type === "workflow_end"), "held worker did not finish");
          settled = true;
          await waitFor(() => !supervision.loadProgressReviewRecords({ storeDir: testStore }).some((record) => record.runId === runId), "terminal completion did not supersede the review");
        } catch (error) { cleanupErrors.push(error); }
      }
    } finally {
      try {
        try { restarted?.handlers.get("session_shutdown")?.({}, restarted.context); } catch (error) { cleanupErrors.push(error); }
      } finally {
        try { firstHost.handlers.get("session_shutdown")?.({}, firstHost.context); } catch (error) { cleanupErrors.push(error); }
        finally {
          try {
            if (previousPiValue === undefined) delete process.env.PI_DYNAMIC_WORKFLOW_PI_BIN;
            else process.env.PI_DYNAMIC_WORKFLOW_PI_BIN = previousPiValue;
          } catch (error) { cleanupErrors.push(error); }
          if (settled) {
            try { rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
            catch (error) { cleanupErrors.push(error); }
          }
        }
      }
    }
  }

  if (cleanupErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupErrors], primaryError?.message || "hourly fixture cleanup failed", { cause: primaryError });
  if (primaryError !== injectedFailure) throw primaryError;
  assert.ok(injectedFailure, "the injected assertion reached the failure-path cleanup");
  assert.equal(settled, true, "fault cleanup waits for the owned workflow to terminate");
  assert.ok(firstHost.lifecycle.shutdowns >= 1, "original host timers are shut down");
  assert.ok(restarted?.lifecycle.shutdowns >= 1, "replacement host timers are shut down");
  assert.equal(process.env.PI_DYNAMIC_WORKFLOW_PI_BIN, previousPiValue, "fault cleanup restores the Pi executable environment");
  assert.equal(existsSync(cwd), false, "settled fixture directory is removed");
});

test("background structured resume inherits only the verified source cadence", { timeout: 20_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "progress-interval-resume-"));
  const sessionId = "progress-interval-resume-session";
  const registered = tools();
  const workflow = registered.get("dynamic_workflow");
  const app = host(sessionId, cwd);
  try {
    await app.handlers.get("session_start")({}, app.context);
    const source = await workflow.execute("test", {
      name: "cadenced-resume", permissions: "rwx", background: true,
      progressReviewIntervalMs: 3_600_000,
      phases: [
        { type: "artifact", name: "seed", content: "checkpoint" },
        { type: "shell", name: "gate", command: `test -f ${JSON.stringify(join(cwd, "allow"))}` },
      ],
    }, undefined, undefined, workflowContext(cwd, sessionId));
    await waitFor(() => runEvents(source.details.runId).some((event) => event.type === "workflow_end"), "source resume fixture did not finish");
    const resumedOverride = workflow.execute("test", {
      resumeRunId: source.details.runId, background: true, progressReviewIntervalMs: 60_000,
    }, undefined, undefined, workflowContext(cwd, sessionId));
    await assert.rejects(resumedOverride, /accepts only resumeRunId and background/);

    writeFileSync(join(cwd, "allow"), "yes");
    const resumed = await workflow.execute("test", {
      resumeRunId: source.details.runId, background: true,
    }, undefined, undefined, workflowContext(cwd, sessionId));
    const resumedStartFile = join(testStore, "runs", `${resumed.details.runId}.start.json`);
    await waitFor(() => existsSync(resumedStartFile), "resumed authoritative start was not written");
    const resumedStart = JSON.parse(readFileSync(resumedStartFile, "utf8"));
    assert.equal(resumedStart.metadata.progressReviewIntervalMs, 3_600_000, "resume must inherit the exact verified source cadence");
    await waitFor(() => runEvents(resumed.details.runId).some((event) => event.type === "workflow_end"), "resumed workflow did not finish");
  } finally {
    app.handlers.get("session_shutdown")({}, app.context);
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
