import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import registerDynamicWorkflows from "../index.ts";

const root = resolve(new URL("../..", import.meta.url).pathname);
const cli = join(root, "dynamic-thread-phase-workflow/bin/dynamic-thread-phase-workflow.mjs");

function registeredTools() {
  const tools = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => tools.set(definition.name, definition) });
  return tools;
}

function context(cwd, sessionId = "timeout-policy-session") {
  return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

async function waitForRunEnd(store, runId, timeoutMs = 8_000) {
  const runFile = join(store, "runs", `${runId}.jsonl`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(runFile)) {
      const events = readFileSync(runFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const end = events.filter((event) => event.type === "workflow_end").at(-1);
      if (end) return { end, events };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail(`workflow ${runId} did not reach workflow_end`);
}

function withRunnerEnvironment(temp, fakePi) {
  const keys = [
    "PI_THREAD_PHASE_STORE_DIR",
    "PI_DYNAMIC_WORKFLOW_PI_BIN",
    "PI_DYNAMIC_WORKFLOW_DEFAULT_TIMEOUT_MS",
    "PI_DYNAMIC_WORKFLOW_BACKGROUND",
    "PI_DYNAMIC_THREAD_PHASE_BACKGROUND",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.PI_THREAD_PHASE_STORE_DIR = join(temp, "store");
  process.env.PI_DYNAMIC_WORKFLOW_PI_BIN = fakePi;
  process.env.PI_DYNAMIC_WORKFLOW_DEFAULT_TIMEOUT_MS = "80";
  process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND = "";
  process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND = "";
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function writeDelayedPi(temp, delayMs = 240) {
  const file = join(temp, "fake-pi.mjs");
  writeFileSync(file, `#!/usr/bin/env node\nsetTimeout(() => console.log(JSON.stringify({type:'message_end',message:{role:'assistant',model:'fake',content:[{type:'text',text:'completed after old default'}]}})), ${delayMs});\n`);
  chmodSync(file, 0o755);
  return file;
}

test("new public background agents opt into verified main-agent supervision and outlive the old implicit bound", { timeout: 15_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-supervised-agent-"));
  const fakePi = writeDelayedPi(temp);
  const restore = withRunnerEnvironment(temp, fakePi);
  try {
    const result = await registeredTools().get("dynamic_workflow").execute("test", {
      name: "supervised-agent",
      permissions: "r",
      background: true,
      phases: [{ type: "agent", name: "long-agent", prompt: "finish later" }],
    }, undefined, undefined, context(temp));

    assert.equal(result.details.background, true);
    const { end } = await waitForRunEnd(process.env.PI_THREAD_PHASE_STORE_DIR, result.details.runId);
    assert.equal(end.status, "success");
    const start = JSON.parse(readFileSync(join(process.env.PI_THREAD_PHASE_STORE_DIR, "runs", `${result.details.runId}.start.json`), "utf8"));
    assert.equal(start.metadata.supervisionMode, "main-agent");
    assert.equal(start.metadata.continuationMode, "terminal");
    assert.ok(Date.parse(end.timestamp) - Date.parse(start.timestamp) >= 200, "agent should remain active beyond the injected 80 ms fallback");
    assert.equal(start.metadata.sessionId, "timeout-policy-session");
  } finally {
    restore();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("explicit workflow and phase deadlines still win for supervised agent and fanout work", { timeout: 15_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-supervised-explicit-timeout-"));
  const fakePi = writeDelayedPi(temp);
  const restore = withRunnerEnvironment(temp, fakePi);
  try {
    const execute = registeredTools().get("dynamic_workflow").execute;
    const workflowDeadline = await execute("test", {
      name: "supervised-global-deadline", permissions: "r", background: true, timeoutMs: 70,
      phases: [{ type: "agent", name: "agent", prompt: "too slow" }],
    }, undefined, undefined, context(temp));
    assert.equal((await waitForRunEnd(process.env.PI_THREAD_PHASE_STORE_DIR, workflowDeadline.details.runId)).end.status, "failed");

    const phaseDeadline = await execute("test", {
      name: "supervised-fanout-deadline", permissions: "r", background: true, timeoutMs: 500,
      phases: [{ type: "fanout", name: "fanout", prompt: "{{item}}", items: ["one"], timeoutMs: 70 }],
    }, undefined, undefined, context(temp));
    const fanout = await waitForRunEnd(process.env.PI_THREAD_PHASE_STORE_DIR, phaseDeadline.details.runId);
    assert.equal(fanout.end.status, "failed");
    assert.match(JSON.stringify(fanout.events), /timed out after 70 ms/);
  } finally {
    restore();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("shell, foreground, and non-opted-in CLI agent execution retain the implicit bound", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-retained-bounds-"));
  const fakePi = writeDelayedPi(temp);
  const restore = withRunnerEnvironment(temp, fakePi);
  const store = process.env.PI_THREAD_PHASE_STORE_DIR;
  try {
    const foregroundSpec = join(temp, "foreground.json");
    writeFileSync(foregroundSpec, JSON.stringify({ name: "foreground-bound", permissions: "r", phases: [{ type: "agent", name: "agent", prompt: "slow" }] }));
    const foreground = spawnSync(process.execPath, [cli, "--spec-file", foregroundSpec, "--cwd", temp], {
      cwd: root, env: process.env, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(foreground.status, 1, foreground.stderr || foreground.stdout);
    assert.match(foreground.stdout, /timed out after 80 ms/);

    const legacySpec = join(temp, "legacy-background.json");
    writeFileSync(legacySpec, JSON.stringify({ schema: "pi-dynamic-workflow/v1", name: "legacy-bound", permissions: "r", phases: [{ type: "pi", name: "agent", prompt: "slow" }] }));
    const legacy = spawnSync(process.execPath, [cli, "--spec-file", legacySpec, "--legacy-spec", "--cwd", temp, "--background"], {
      cwd: root, env: process.env, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(legacy.status, 0, legacy.stderr);
    const legacyReady = JSON.parse(legacy.stdout);
    assert.equal((await waitForRunEnd(store, legacyReady.runId)).end.status, "failed");
    const legacyStart = JSON.parse(readFileSync(join(store, "runs", `${legacyReady.runId}.start.json`), "utf8"));
    assert.equal(legacyStart.metadata.supervisionMode, undefined);

    const dynamicTool = registeredTools().get("dynamic_workflow");
    const historicalArgs = dynamicTool.prepareArguments({
      spec: { name: "historical-prepared", permissions: "r", phases: [{ type: "artifact", name: "result", content: "old call" }] },
      background: true,
    });
    const historical = await dynamicTool.execute("test", historicalArgs, undefined, undefined, context(temp));
    await waitForRunEnd(store, historical.details.runId);
    const historicalStart = JSON.parse(readFileSync(join(store, "runs", `${historical.details.runId}.start.json`), "utf8"));
    assert.equal(historicalStart.metadata.supervisionMode, undefined);

    const shell = await dynamicTool.execute("test", {
      name: "supervised-shell-bound", permissions: "rwx", background: true,
      phases: [{ type: "shell", name: "shell", command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(()=>{},1000)")}` }],
    }, undefined, undefined, context(temp));
    assert.equal((await waitForRunEnd(store, shell.details.runId)).end.status, "failed");
  } finally {
    restore();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("scripted pi helpers inherit no deadline only when supervised and preserve helper timeout precedence", { timeout: 15_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-scripted-supervision-"));
  const fakePi = writeDelayedPi(temp);
  const restore = withRunnerEnvironment(temp, fakePi);
  try {
    const execute = registeredTools().get("scripted_workflow").execute;
    const openEnded = await execute("test", {
      script: `export default async function(ctx) { await ctx.pi('finish later', { name: 'agent' }); }`,
      name: "scripted-open-ended", permissions: "rwx", background: true,
    }, undefined, undefined, context(temp));
    assert.equal((await waitForRunEnd(process.env.PI_THREAD_PHASE_STORE_DIR, openEnded.details.runId)).end.status, "success");

    const explicit = await execute("test", {
      script: `export default async function(ctx) { await ctx.pi('too slow', { name: 'agent', timeoutMs: 70 }); }`,
      name: "scripted-explicit-deadline", permissions: "rwx", background: true,
    }, undefined, undefined, context(temp));
    const failed = await waitForRunEnd(process.env.PI_THREAD_PHASE_STORE_DIR, explicit.details.runId);
    assert.equal(failed.end.status, "failed");
    assert.match(JSON.stringify(failed.events), /timed out after 70 ms/);
  } finally {
    restore();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("background resume inherits supervision only from verified source ownership", { timeout: 20_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-supervised-resume-"));
  const fakePi = writeDelayedPi(temp);
  const restore = withRunnerEnvironment(temp, fakePi);
  const store = process.env.PI_THREAD_PHASE_STORE_DIR;
  const sessionId = "trusted-resume-session";
  try {
    const launchFailedSource = async (name, allowFile, supervised) => {
      const specPath = join(temp, `${name}.json`);
      const gate = `if [ -f ${JSON.stringify(join(temp, allowFile))} ]; then printf open; else exit 7; fi`;
      writeFileSync(specPath, JSON.stringify({
        schema: "pi-dynamic-workflow/v2", name, permissions: "rwx",
        phases: [
          { type: "artifact", name: "seed", content: "checkpoint" },
          { type: "shell", name: "gate", command: gate },
          { type: "agent", name: "long-agent", permissions: "r", prompt: "finish later" },
        ],
      }));
      const args = ["--spec-file", specPath, "--cwd", temp, "--session-id", sessionId, "--background"];
      if (supervised) args.push("--supervise-agents");
      const launched = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: process.env, encoding: "utf8", timeout: 5_000 });
      assert.equal(launched.status, 0, launched.stderr);
      const ready = JSON.parse(launched.stdout);
      assert.equal((await waitForRunEnd(store, ready.runId)).end.status, "failed");
      return ready.runId;
    };

    const trustedSource = await launchFailedSource("trusted-supervised-source", "allow-trusted", true);
    const callerOverride = spawnSync(process.execPath, [cli, "--resume-run-id", trustedSource, "--session-id", sessionId, "--background", "--supervise-agents"], {
      cwd: root, env: process.env, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(callerOverride.status, 1);
    assert.match(callerOverride.stderr, /derives supervision policy from trusted source ownership/);
    writeFileSync(join(temp, "allow-trusted"), "yes");
    const trustedResume = spawnSync(process.execPath, [cli, "--resume-run-id", trustedSource, "--session-id", sessionId, "--background"], {
      cwd: root, env: process.env, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(trustedResume.status, 0, trustedResume.stderr);
    const trustedReady = JSON.parse(trustedResume.stdout);
    assert.equal((await waitForRunEnd(store, trustedReady.runId)).end.status, "success");
    const trustedStart = JSON.parse(readFileSync(join(store, "runs", `${trustedReady.runId}.start.json`), "utf8"));
    assert.equal(trustedStart.metadata.supervisionMode, "main-agent");

    const historicalSource = await launchFailedSource("historical-bounded-source", "allow-historical", false);
    writeFileSync(join(temp, "allow-historical"), "yes");
    const historicalResume = spawnSync(process.execPath, [cli, "--resume-run-id", historicalSource, "--session-id", sessionId, "--background"], {
      cwd: root, env: process.env, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(historicalResume.status, 0, historicalResume.stderr);
    const historicalReady = JSON.parse(historicalResume.stdout);
    assert.equal((await waitForRunEnd(store, historicalReady.runId)).end.status, "failed");
    const historicalStart = JSON.parse(readFileSync(join(store, "runs", `${historicalReady.runId}.start.json`), "utf8"));
    assert.equal(historicalStart.metadata.supervisionMode, undefined);

    const foregroundSource = await launchFailedSource("supervised-foreground-resume-source", "allow-foreground", true);
    writeFileSync(join(temp, "allow-foreground"), "yes");
    const foregroundResume = spawnSync(process.execPath, [cli, "--resume-run-id", foregroundSource, "--session-id", sessionId], {
      cwd: root, env: process.env, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(foregroundResume.status, 1, foregroundResume.stderr || foregroundResume.stdout);
    assert.match(foregroundResume.stdout, /timed out after 80 ms/);
  } finally {
    restore();
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("internal supervision flag rejects foreground, malformed, legacy, and resume overrides before launch", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-supervision-validation-"));
  try {
    const spec = join(temp, "spec.json");
    const legacySpec = join(temp, "legacy.json");
    writeFileSync(spec, JSON.stringify({ schema: "pi-dynamic-workflow/v2", name: "validation", permissions: "r", phases: [{ type: "artifact", name: "result", content: "x" }] }));
    writeFileSync(legacySpec, JSON.stringify({ schema: "pi-dynamic-workflow/v1", name: "legacy-validation", permissions: "r", phases: [{ type: "artifact", name: "result", content: "x" }] }));
    const env = { ...process.env, PI_THREAD_PHASE_STORE_DIR: join(temp, "store"), PI_DYNAMIC_WORKFLOW_BACKGROUND: "", PI_DYNAMIC_THREAD_PHASE_BACKGROUND: "" };
    for (const [args, pattern] of [
      [["--spec-file", spec, "--cwd", temp, "--supervise-agents"], /requires a background workflow/],
      [["--spec-file", spec, "--cwd", temp, "--background", "--supervise-agents=maybe"], /must be a boolean flag/],
      [["--spec-file", spec, "--cwd", temp, "--background", "--supervise-agents"], /requires an originating Pi session/],
      [["--spec-file", legacySpec, "--legacy-spec", "--cwd", temp, "--background", "--session-id", "legacy-session", "--supervise-agents"], /not supported for legacy workflow execution/],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8", timeout: 5_000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, pattern);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
