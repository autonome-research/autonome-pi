// UNEXECUTED: parent validation runs this file in the fixed offline shell.
// In-process wrapper-side wiring tests for the strict v3 launch branch. The
// runner child is real (spawned through the extension's own runScript path);
// the launch profile is a synthetic fixture installed via the TEST-ONLY seam.
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerDynamicWorkflows, { __setV3LaunchProfileForTests } from "../index.ts";
import { isolatedResourceOptions } from "../worker/profile.mjs";

const GATE = "PI_DYNAMIC_WORKFLOW_RECURSIVE_LAUNCH";
const ENV_KEYS = [GATE, "PI_THREAD_PHASE_STORE_DIR", "PI_DYNAMIC_WORKFLOW_BACKGROUND", "PI_DYNAMIC_THREAD_PHASE_BACKGROUND"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const root = realpathSync(mkdtempSync(join(tmpdir(), "launch-wiring-")));
after(() => rmSync(root, { recursive: true, force: true }));
const workspace = join(root, "workspace"); mkdirSync(workspace);
const sdkDir = join(root, "sdk"); mkdirSync(sdkDir);
const workerEntry = join(root, "sdk-runner.mjs"); writeFileSync(workerEntry, "// launch wiring fixture entry\n");
// Synthetic sentinel fixture: positively owned, never a real credential. The
// wrapper binds the nonsecret path only and must never read or leak content.
const SENTINEL = "PRIVATE_SENTINEL_LAUNCH_WIRING";
const authFile = join(root, "auth.json");
writeFileSync(authFile, `{"openai-codex":{"type":"oauth","access":"${SENTINEL}"}}\n`, { mode: 0o600 });
const sessionFile = join(root, "session.jsonl");
const storeDir = join(root, "store");

afterEach(() => {
  __setV3LaunchProfileForTests(null);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function prepareEnv({ gate } = {}) {
  if (gate === undefined) delete process.env[GATE];
  else process.env[GATE] = gate;
  process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
  process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND = "";
  process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND = "";
}

const profile = () => ({
  sdkPackagePath: sdkDir,
  workerEntryPath: workerEntry,
  authPath: authFile,
  resourceProfile: isolatedResourceOptions(),
  limits: { maxConcurrentAgents: 4, maxLiveAgents: 8 },
});

const ctx = (over = {}) => ({
  mode: "tui",
  cwd: workspace,
  sessionManager: { getSessionId: () => "wiring-session", getSessionFile: () => sessionFile },
  ...over,
});

const v3 = () => ({
  schema: "pi-dynamic-workflow/v3",
  name: "wiring-fixture",
  delegation: {
    maxDepth: 1,
    totalAgentBudget: 2,
    directoryScope: { read: ["src"], write: [] },
    context: { objective: "Bounded review", constraints: ["stay in scope"] },
  },
  phases: [{ type: "shell", name: "step", command: "true" }],
});

function tool() {
  const registered = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => registered.set(definition.name, definition) });
  return registered.get("dynamic_workflow");
}

const tempResidue = () => readdirSync(tmpdir()).filter((entry) => entry.startsWith("pi-dynamic-workflow-")).sort();

test("gate unset denies NOT_ENABLED before any profile, grant, spawn, or temp artifact", async () => {
  prepareEnv({ gate: undefined });
  __setV3LaunchProfileForTests(profile()); // installed to prove the gate fires first
  const before = tempResidue();
  await assert.rejects(tool().execute("call-1", { v3: v3() }, undefined, undefined, ctx()), /NOT_ENABLED/);
  assert.deepEqual(tempResidue(), before);
  assert.equal(existsSync(storeDir), false);
});

test("v3 requires a hosted tui/rpc session before any grant work", async () => {
  prepareEnv({ gate: "1" });
  __setV3LaunchProfileForTests(profile());
  const before = tempResidue();
  for (const bad of [ctx({ mode: "json" }), ctx({ mode: "print" }), ctx({ sessionManager: {} })]) {
    await assert.rejects(tool().execute("call-2", { v3: v3() }, undefined, undefined, bad), /UNAUTHORIZED/);
  }
  assert.deepEqual(tempResidue(), before);
  assert.equal(existsSync(storeDir), false);
});

test("authorized v3 launch ends in the bounded NOT_IMPLEMENTED denial with zero residue", async () => {
  prepareEnv({ gate: "1" });
  __setV3LaunchProfileForTests(profile());
  const before = tempResidue();
  let failure;
  await tool().execute("call-3", { v3: v3() }, undefined, undefined, ctx()).catch((error) => { failure = error; });
  assert.match(String(failure?.message || failure), /NOT_IMPLEMENTED/);
  const diagnostic = String(failure?.stack || failure);
  assert.ok(!diagnostic.includes(SENTINEL), "credential sentinel must never appear in denial output");
  assert.deepEqual(tempResidue(), before, "no pi-dynamic-workflow temp residue");
  assert.equal(existsSync(storeDir), false, "no visualizer store/runs/journal/checkpoint artifacts");
});

test("a changed session between prepare and consume mismatches and burns the grant", async () => {
  prepareEnv({ gate: "1" });
  __setV3LaunchProfileForTests(profile());
  let calls = 0;
  const mutable = ctx({ sessionManager: { getSessionId: () => (calls++ === 0 ? "session-a" : "session-b"), getSessionFile: () => sessionFile } });
  const before = tempResidue();
  await assert.rejects(tool().execute("call-4", { v3: v3() }, undefined, undefined, mutable), /LAUNCH_MISMATCH: launch field sessionId/);
  assert.deepEqual(tempResidue(), before);
  assert.equal(existsSync(storeDir), false);
});

test("v3 is exclusive: legacy/public launch fields are rejected before any grant", async () => {
  prepareEnv({ gate: "1" });
  __setV3LaunchProfileForTests(profile());
  const before = tempResidue();
  const forbidden = {
    phases: [{ type: "artifact", name: "x", content: "y" }],
    template: "saved",
    inputs: {},
    resumeRunId: "run-1",
    after: "run-0",
    name: "named",
    cwd: workspace,
    model: "openai-codex/gpt-5.6-sol",
    timeoutMs: 1000,
    permissions: "r",
  };
  for (const [key, value] of Object.entries(forbidden)) {
    await assert.rejects(tool().execute("call-5", { v3: v3(), [key]: value }, undefined, undefined, ctx()), /unsupported field/, key);
  }
  assert.deepEqual(tempResidue(), before);
  assert.equal(existsSync(storeDir), false);
});

test("v2 compile path is unchanged whether or not the v3 gate is set", async () => {
  for (const gate of [undefined, "1"]) {
    prepareEnv({ gate });
    const before = tempResidue();
    const result = await tool().execute("call-6", {
      permissions: "r",
      phases: [{ type: "artifact", name: "result", content: "ok" }],
    }, undefined, undefined, ctx({ sessionManager: {} }));
    assert.equal(result.details?.ok, true);
    assert.equal(typeof result.details?.runId, "string");
    assert.deepEqual(tempResidue(), before);
    rmSync(storeDir, { recursive: true, force: true });
  }
});
