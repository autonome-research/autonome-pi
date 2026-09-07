import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import registerDynamicWorkflows from "../index.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cli = join(root, "dynamic-thread-phase-workflow/bin/dynamic-thread-phase-workflow.mjs");

function tools() {
  const registered = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => registered.set(definition.name, definition) });
  return registered;
}

function runCli(spec, temp, extraArgs = []) {
  const specPath = join(temp, `spec-${Math.random()}.json`);
  writeFileSync(specPath, JSON.stringify(spec));
  return spawnSync(process.execPath, [cli, "--spec-file", specPath, "--cwd", temp, ...extraArgs], {
    cwd: root,
    env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: join(temp, "store"), PI_DYNAMIC_WORKFLOW_BACKGROUND: "", PI_DYNAMIC_THREAD_PHASE_BACKGROUND: "" },
    encoding: "utf8",
    timeout: 15_000,
  });
}

function terminalJson(stdout) {
  const start = stdout.lastIndexOf("\n{");
  return JSON.parse(stdout.slice(start < 0 ? 0 : start + 1));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

test("exposed declarative schema is reduced while retaining execution controls", (t) => {
  const baselineBytes = 5_243; // Measured from the registered e29790f schema.
  const schema = tools().get("dynamic_workflow").parameters;
  const bytes = Buffer.byteLength(JSON.stringify(schema));
  t.diagnostic(`dynamic_workflow schema bytes: ${baselineBytes} (e29790f) -> ${bytes}`);
  assert.ok(bytes < baselineBytes, `schema did not shrink from its ${baselineBytes}-byte baseline: ${bytes}`);
  for (const removed of ["description", "metadata", "concurrency", "autoContinue"]) assert.equal(schema.properties[removed], undefined);
  const variants = schema.properties.phases.items.anyOf;
  const hasType = (variant, type) => variant.properties.type.enum?.includes(type) || variant.properties.type.const === type;
  const agent = variants.find((variant) => hasType(variant, "agent"));
  const fanout = variants.find((variant) => hasType(variant, "fanout"));
  const artifact = variants.find((variant) => hasType(variant, "artifact"));
  for (const executable of variants.filter((variant) => variant !== artifact)) {
    assert.equal(executable.properties.attempts.minimum, 1);
    assert.equal(executable.properties.attempts.maximum, 5);
    assert.equal(executable.properties.retry, undefined);
  }
  assert.ok(agent.properties.tools);
  assert.ok(agent.properties.permissions);
  assert.ok(fanout.properties.tools);
  assert.ok(fanout.properties.concurrency);
  assert.ok(fanout.properties.failOnItemFailure);
  assert.equal(fanout.properties.label, undefined);
  assert.equal(artifact.properties.attempts, undefined);
  assert.equal(artifact.properties.fileName, undefined);
  assert.equal(artifact.properties.kind, undefined);
});

test("v2 runner rejects removed fields and enforces attempts bounds before creating a run", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-schema-reject-"));
  try {
    const base = { name: "contract", permissions: "rwx", phases: [{ type: "shell", name: "step", command: "printf ok" }] };
    for (const spec of [
      { ...base, schema: "pi-dynamic-workflow/v999" },
      { ...base, description: "removed" },
      { ...base, metadata: { caller: true } },
      { ...base, concurrency: 2 },
      { ...base, name: 3 },
      { ...base, cwd: false },
      { ...base, model: { id: "bad" } },
      { ...base, timeoutMs: "1000" },
      { ...base, permissions: "wr" },
      { ...base, phases: [{ ...base.phases[0], retry: { maxAttempts: 2 } }] },
      { ...base, phases: [{ ...base.phases[0], description: "removed" }] },
      { ...base, phases: [{ ...base.phases[0], command: false }] },
      { ...base, phases: [{ ...base.phases[0], permissions: "rw" }] },
      { ...base, phases: [{ ...base.phases[0], timeoutMs: "100" }] },
      { ...base, phases: [{ ...base.phases[0], attempts: "2" }] },
      { ...base, phases: [{ ...base.phases[0], attempts: 0 }] },
      { ...base, phases: [{ ...base.phases[0], attempts: 6 }] },
      { ...base, phases: [{ type: "agent", name: 1, prompt: "x" }] },
      { ...base, phases: [{ type: 1, name: "agent", prompt: "x" }] },
      { ...base, phases: [{ type: "agent", name: "agent", prompt: 1 }] },
      { ...base, phases: [{ type: "agent", name: "agent", prompt: "x", model: false }] },
      { ...base, phases: [{ type: "agent", name: "agent", prompt: "x", tools: [] }] },
      { ...base, phases: [{ type: "agent", name: "agent", prompt: "x", tools: ["read", 1] }] },
      { ...base, phases: [{ type: "agent", name: "agent", prompt: "x", tools: ["unknown"] }] },
      { ...base, permissions: "r", phases: [{ type: "agent", name: "agent", prompt: "x", tools: ["write"] }] },
      { ...base, phases: [{ type: "fanout", name: "many", prompt: "{{item}}", items: ["x"], concurrency: "2" }] },
      { ...base, phases: [{ type: "fanout", name: "many", prompt: "{{item}}", items: ["x"], failOnItemFailure: "false" }] },
      { ...base, phases: [{ type: "fanout", name: "many", prompt: "{{item}}", items: ["x"], model: 7 }] },
      { ...base, phases: [{ type: "fanout", name: "many", prompt: "{{item}}", items: [] }] },
      { ...base, phases: [{ type: "fanout", name: "many", prompt: "{{item}}", items: [{ bad: true }] }] },
      { ...base, phases: [{ type: "fanout", name: "many", prompt: "{{item}}", items: ["x"], itemsFrom: "step" }] },
      { ...base, phases: [{ type: "artifact", name: "report", content: "x", attempts: 2 }] },
      { ...base, phases: [{ type: "artifact", name: "report", content: "x", title: 9 }] },
      { ...base, phases: [{ type: "artifact", name: "report", content: "x", from: "step" }] },
    ]) {
      const result = runCli(spec, temp);
      assert.notEqual(result.status, 0, result.stderr || result.stdout);
    }
    const autoContinue = runCli(base, temp, ["--auto-continue"]);
    assert.notEqual(autoContinue.status, 0);
    assert.match(autoContinue.stderr, /not supported by strict v2/);
    assert.equal(existsSync(join(temp, "store", "runs")), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("wrapper and runner agree on a focused v2 validation corpus", async () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-schema-parity-"));
  const previousStore = process.env.PI_THREAD_PHASE_STORE_DIR;
  const previousBackground = process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND;
  const previousLegacyBackground = process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND;
  process.env.PI_THREAD_PHASE_STORE_DIR = join(temp, "wrapper-store");
  process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND = "";
  process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND = "";
  try {
    const execute = tools().get("dynamic_workflow").execute;
    const base = { name: "parity", permissions: "r", phases: [{ type: "artifact", name: "result", content: "ok" }] };
    const corpus = [
      { label: "minimal artifact", spec: base, accepted: true },
      { label: "invalid workflow name", spec: { ...base, name: "bad/name" }, accepted: false },
      { label: "duplicate phase name", spec: { ...base, phases: [...base.phases, { type: "artifact", name: "result", content: "again" }] }, accepted: false },
      { label: "artifact title type", spec: { ...base, phases: [{ ...base.phases[0], title: 7 }] }, accepted: false },
      { label: "empty agent tools", spec: { ...base, phases: [{ type: "agent", name: "agent", prompt: "x", tools: [] }] }, accepted: false },
      { label: "fanout source exclusivity", spec: { ...base, phases: [{ type: "fanout", name: "many", prompt: "{{item}}", items: ["x"], itemsFrom: "result" }] }, accepted: false },
    ];

    for (const entry of corpus) {
      let wrapperAccepted = true;
      try {
        await execute("parity", entry.spec, undefined, undefined, { cwd: temp, sessionManager: {} });
      } catch {
        wrapperAccepted = false;
      }
      const runner = runCli(entry.spec, temp);
      const runnerAccepted = runner.status === 0;
      assert.equal(wrapperAccepted, entry.accepted, `wrapper outcome for ${entry.label}`);
      assert.equal(runnerAccepted, entry.accepted, `runner outcome for ${entry.label}: ${runner.stderr || runner.stdout}`);
    }
  } finally {
    if (previousStore === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
    else process.env.PI_THREAD_PHASE_STORE_DIR = previousStore;
    if (previousBackground === undefined) delete process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND;
    else process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND = previousBackground;
    if (previousLegacyBackground === undefined) delete process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND;
    else process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND = previousLegacyBackground;
    rmSync(temp, { recursive: true, force: true });
  }
});

test("attempts uses deterministic internal exponential backoff and does not persist caller backoff knobs", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-attempts-"));
  try {
    const script = "const fs=require('fs');const p='attempt-count';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));if(n<2)process.exit(9);process.stdout.write('ok')";
    const spec = { name: "deterministic-attempts", permissions: "rwx", phases: [{ type: "shell", name: "flaky", attempts: 3, command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` }] };
    const started = Date.now();
    const result = runCli(spec, temp);
    const elapsed = Date.now() - started;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(join(temp, "attempt-count"), "utf8"), "3");
    assert.ok(elapsed >= 650, `two deterministic retry delays should total about 750ms; elapsed=${elapsed}`);
    const runId = terminalJson(result.stdout).runId;
    const compiled = JSON.parse(readFileSync(join(temp, "store", "artifacts", runId, "workflow-spec.json"), "utf8"));
    assert.equal(compiled.schema, "pi-dynamic-workflow/v2");
    assert.equal(compiled.phases[0].attempts, 3);
    assert.equal(compiled.phases[0].retry, undefined);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("explicit v1 specs retain their exact legacy fingerprint and checkpoint decoder", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-v1-identity-"));
  try {
    const spec = {
      schema: "pi-dynamic-workflow/v1",
      name: "legacy-identity",
      description: "retained only for explicit v1",
      permissions: "rwx",
      concurrency: 7,
      metadata: { identity: "legacy" },
      phases: [{ type: "shell", name: "legacy", description: "old phase", command: "printf old", retry: { maxAttempts: 1, baseDelayMs: 4321 } }],
    };
    const result = runCli(spec, temp);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const runId = terminalJson(result.stdout).runId;
    const artifactDir = join(temp, "store", "artifacts", runId);
    const compiled = JSON.parse(readFileSync(join(artifactDir, "workflow-spec.json"), "utf8"));
    assert.deepEqual(compiled, spec);
    const checkpoint = JSON.parse(readFileSync(join(artifactDir, "workflow-checkpoint.json"), "utf8"));
    assert.equal(checkpoint.schema, "pi-dynamic-workflow-checkpoint/v1");
    const expected = createHash("sha256").update(canonicalJson({ spec, cwd: temp, model: null })).digest("hex");
    assert.equal(checkpoint.specHash, expected, "legacy execution identity must not be rewritten into v2");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
