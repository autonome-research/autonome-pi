// UNEXECUTED: parent validation runs this file in the fixed offline shell.
// v3 execution tests (Plan B). Pure compiler/render/recipe tests run
// unconditionally. Connected tests are consent-gated
// (PI_DELEGATION_COMPAT_FIXTURES=1) and drive the real wrapper + runner + SDK
// worker chain with the synthetic probe
// (test/support/delegation-v3-execution/sdk-worker-probe.mjs) installed as the
// fixture profile's workerEntryPath via the TEST-ONLY seam. No network, no
// real auth path (synthetic sentinel fixture only). Serial test order: the
// resume-downgrade test consumes the connected foreground run.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileV3Spec, makeV3Render, buildV3WorkerRecipe } from "../lib/delegation-v3.mjs";
import { inspectDelegationJournal } from "../lib/delegation-journal.mjs";
import { createHostedLaunchAuthority } from "../lib/delegation-launch-authorization.mjs";
import { canonicalJSON, decodeCanonical, readStoredArtifact, sha256 } from "../lib/delegation-storage.mjs";
import { validateDelegationPolicy } from "../lib/delegation-contract.mjs";
import { validateWorkerSetup } from "../worker/sdk-runner.mjs";
import { isolatedResourceOptions } from "../worker/profile.mjs";
import registerDynamicWorkflows, { __setV3LaunchProfileForTests } from "../index.ts";
import { versions, supportDir } from "./support/delegation-worker-gates/driver.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cli = join(repoRoot, "dynamic-thread-phase-workflow/bin/dynamic-thread-phase-workflow.mjs");
const probe = join(supportDir, "..", "delegation-v3-execution", "sdk-worker-probe.mjs");

const GATE = "PI_DYNAMIC_WORKFLOW_RECURSIVE_LAUNCH";
const ENV_KEYS = [GATE, "TMPDIR", "PI_THREAD_PHASE_STORE_DIR", "PI_DYNAMIC_WORKFLOW_BACKGROUND", "PI_DYNAMIC_THREAD_PHASE_BACKGROUND"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const SESSION_ID = "v3-exec-session";
// Credential material of the synthetic fixture; must never appear in output.
const CREDENTIAL_PATTERN = /synthetic-(?:expired-access|refresh-value|refreshed-access)/;
const consentTest = (name, options, fn) => test(name, { ...options, skip: process.env.PI_DELEGATION_COMPAT_FIXTURES !== "1" }, fn);

const children = new Set();
afterEach(() => {
  __setV3LaunchProfileForTests(null);
  for (const child of children) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function tool() {
  const registered = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => registered.set(definition.name, definition) });
  return registered.get("dynamic_workflow");
}

const fakeCtx = (fixture) => ({
  mode: "tui",
  cwd: fixture.workspace,
  sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => fixture.sessionFile },
});

function connectedFixture(t, name = "v3-exec-") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), name)));
  const fixture = {
    root,
    childTmp: join(root, "tmp"),
    home: join(root, "home"),
    workspace: join(root, "workspace"),
    storeDir: join(root, "store"),
    authFile: join(root, "auth.json"),
    sessionFile: join(root, "session.jsonl"),
    clean: false,
  };
  mkdirSync(fixture.childTmp);
  mkdirSync(fixture.home);
  mkdirSync(fixture.workspace);
  // Synthetic sentinel fixture credentials: positively owned, never real.
  writeFileSync(fixture.authFile, `${JSON.stringify({ "openai-codex": { type: "oauth",
    access: "synthetic-expired-access", refresh: "synthetic-refresh-value", expires: 0 } })}\n`, { mode: 0o600 });
  fixture.profile = {
    sdkPackagePath: versions[1].packageDir,
    workerEntryPath: probe,
    authPath: fixture.authFile,
    resourceProfile: isolatedResourceOptions(),
    limits: { maxConcurrentAgents: 4, maxLiveAgents: 8 },
  };
  return fixture;
}

function prepareConnectedEnv(fixture) {
  process.env[GATE] = "1";
  process.env.TMPDIR = fixture.childTmp; // wrapper mkdtemp and runner cleanup agree on the owned root
  process.env.PI_THREAD_PHASE_STORE_DIR = fixture.storeDir;
  process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND = "";
  process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND = "";
}

function finishFixture(t, fixture) {
  if (fixture.clean) rmSync(fixture.root, { recursive: true, force: true });
  else t.diagnostic(`retained owned fixture ${fixture.root}`);
}

const execSpec = (prompt = "Complete the synthetic bounded assignment.") => ({
  schema: "pi-dynamic-workflow/v3",
  name: "exec-fixture",
  delegation: {
    maxDepth: 0,
    totalAgentBudget: 1,
    directoryScope: { read: ["."], write: [] },
    context: { objective: "Synthetic v3 execution", constraints: ["Offline fixture only"] },
  },
  phases: [{ type: "agent", name: "root", prompt }],
});

const bindingFor = (fixture, specValue, resultArtifact) => ({
  manifestDigest: resultArtifact.delegation.manifestDigest,
  runId: resultArtifact.runId,
  specDigest: sha256(canonicalJSON(specValue)),
  profileDigest: sha256(canonicalJSON(fixture.profile.resourceProfile)),
});

const runEvents = (fixture, runId) =>
  readFileSync(join(fixture.storeDir, "runs", `${runId}.jsonl`), "utf8").trim().split("\n").map(JSON.parse);

function writeSpecInput(fixture, specValue) {
  const dir = mkdtempSync(join(fixture.childTmp, "pi-dynamic-workflow-"));
  const file = join(dir, "workflow-spec.json");
  writeFileSync(file, JSON.stringify(specValue, null, 2));
  return { dir, file };
}

// Mint a real initial-stage envelope with the trusted module and the synthetic
// fixture profile, asserting exactly the runner-side recomputation subset.
function mintInitialEnvelope(fixture, specValue) {
  const authority = createHostedLaunchAuthority(fixture.profile);
  const grant = authority.prepare(
    { mode: "tui", sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => fixture.sessionFile } },
    { spec: specValue, cwd: fixture.workspace, background: false },
  );
  const expected = {
    sessionId: SESSION_ID,
    sessionFile: fixture.sessionFile,
    cwd: realpathSync(fixture.workspace),
    specDigest: sha256(canonicalJSON(specValue)),
    policyDigest: sha256(canonicalJSON(validateDelegationPolicy(specValue.delegation))),
    background: false,
    progressReviewIntervalMs: null,
  };
  return authority.consume(grant, expected).initialEnvelope();
}

function spawnBin(fixture, args, { withFd3 = false } = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: fixture.workspace,
    stdio: withFd3 ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: fixture.home,
      TMPDIR: fixture.childTmp,
      PI_THREAD_PHASE_STORE_DIR: fixture.storeDir,
      PI_DYNAMIC_WORKFLOW_BACKGROUND: "",
      PI_DYNAMIC_THREAD_PHASE_BACKGROUND: "",
    },
  });
  children.add(child);
  child.on("close", () => children.delete(child));
  return child;
}

function collect(child) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (stdout.length < 1_000_000) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 1_000_000) stderr += chunk; });
    child.on("error", (error) => resolvePromise({ code: -1, signal: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// 1. compileV3Spec (pure, no consent)
// ---------------------------------------------------------------------------

const compilePolicy = {
  maxDepth: 1,
  totalAgentBudget: 8,
  directoryScope: { read: ["src"], write: ["out"] },
  context: { objective: "Compile fixture", constraints: ["offline"] },
};

const validSpec = () => ({
  schema: "pi-dynamic-workflow/v3",
  name: "compile-fixture",
  delegation: compilePolicy,
  phases: [
    { type: "agent", name: "review", prompt: "Review the tree.", contextTemplate: "parent context" },
    { type: "fanout", name: "sweep", prompt: "Sweep {{item}} after {{outputs.review}}.", items: ["a", "b"] },
    { type: "shell", name: "verify", command: "echo ok" },
    { type: "artifact", name: "report", content: "static report" },
    { type: "artifact", name: "summary", from: "review" },
  ],
});

test("compileV3Spec compiles a valid agent+fanout+shell+artifact spec exactly", () => {
  const compiled = compileV3Spec(validSpec());
  assert.equal(Object.isFrozen(compiled), true);
  assert.deepEqual(compiled.phases, [
    { type: "agent", name: "review" },
    { type: "fanout", name: "sweep", items: ["a", "b"] },
    { type: "shell", name: "verify", command: "echo ok", permissions: "rwx" },
    { type: "artifact", name: "report" },
    { type: "artifact", name: "summary", from: "review" },
  ]);
  // Roots enumerate in (phaseIndex, itemIndex) order; shell/artifact phases get
  // no delegation roots structurally.
  assert.equal(compiled.roots.length, 3);
  const [agent, first, second] = compiled.roots;
  assert.equal(agent.phaseIndex, 0);
  assert.equal("itemIndex" in agent, false);
  assert.equal(agent.agentBudget, 1); // default
  assert.equal(agent.label, "review");
  assert.equal(agent.permissions, "r"); // default
  assert.equal(agent.deadlineAt, null); // default
  assert.equal(agent.taskTemplate, "Review the tree.");
  assert.equal(agent.contextTemplate, "parent context");
  assert.deepEqual(agent.directoryScope, { read: ["src"], write: ["out"] });
  assert.equal(first.phaseIndex, 1);
  assert.equal(first.itemIndex, 0);
  assert.equal(first.label, "a");
  assert.equal(first.taskTemplate, "Sweep {{item}} after {{outputs.review}}.");
  assert.equal("contextTemplate" in first, false);
  assert.equal(second.itemIndex, 1);
  assert.equal(second.label, "b");
  assert.deepEqual([...compiled.artifactContents.entries()], [["report", "static report"]]);
  assert.equal(Object.isFrozen(compiled.roots[0]), true);
});

test("compileV3Spec rejects unsupported modes and invalid shapes with bounded codes", () => {
  const withPhase = (phase) => ({ schema: "pi-dynamic-workflow/v3", delegation: compilePolicy, phases: [phase] });
  const agent = { type: "agent", name: "a", prompt: "do" };
  assert.throws(() => compileV3Spec({ schema: "pi-dynamic-workflow/v2", delegation: compilePolicy, phases: [agent] }), /UNSUPPORTED_VERSION/);
  assert.throws(() => compileV3Spec({ ...withPhase(agent), model: "openai-codex/gpt-5.6-sol" }), /UNSUPPORTED_MODE/);
  assert.throws(() => compileV3Spec(withPhase({ ...agent, model: "openai-codex/gpt-5.6-sol" })), /UNSUPPORTED_MODE/);
  assert.throws(() => compileV3Spec(withPhase({ ...agent, attempts: 2 })), /UNSUPPORTED_MODE/);
  assert.throws(() => compileV3Spec(withPhase({ ...agent, attempts: 1 })), /INVALID_REQUEST/);
  assert.throws(() => compileV3Spec(withPhase({ ...agent, retry: { maxAttempts: 2 } })), /UNSUPPORTED_MODE/);
  assert.throws(() => compileV3Spec(withPhase({ type: "fanout", name: "f", prompt: "do {{item}}", itemsFrom: "a" })), /UNSUPPORTED_MODE/);
  assert.throws(() => compileV3Spec(withPhase({ ...agent, bogus: true })), /INVALID_REQUEST/);
  assert.throws(() => compileV3Spec(withPhase({ type: "fanout", name: "f", prompt: "do {{item}}", items: ["ok", 7] })), /INVALID_REQUEST/);
  assert.throws(() => compileV3Spec(withPhase({ type: "fanout", name: "f", prompt: "do {{item}}", items: [] })), /INVALID_REQUEST/);
  const many = { schema: "pi-dynamic-workflow/v3", delegation: compilePolicy,
    phases: Array.from({ length: 31 }, (_, i) => ({ type: "agent", name: `a${i}`, prompt: "do" })) };
  assert.throws(() => compileV3Spec(many), /INVALID_REQUEST/);
  assert.throws(() => compileV3Spec({ schema: "pi-dynamic-workflow/v3", delegation: compilePolicy,
    phases: [{ ...agent }, { ...agent }] }), /INVALID_REQUEST/, "duplicate phase name");
  assert.throws(() => compileV3Spec(withPhase({ type: "shell", name: "s", command: "true" })), /INVALID_REQUEST/, "no delegation roots");
  assert.throws(() => compileV3Spec(withPhase({ type: "artifact", name: "x", content: "y", from: "a" })), /INVALID_REQUEST/);
  assert.throws(() => compileV3Spec({ schema: "pi-dynamic-workflow/v3", delegation: compilePolicy,
    phases: [{ type: "artifact", name: "x", from: "later" }, agent] }), /INVALID_REQUEST/);
  // BUDGET_EXHAUSTED: roots x agentBudget exceed totalAgentBudget.
  assert.throws(() => compileV3Spec({ schema: "pi-dynamic-workflow/v3",
    delegation: { ...compilePolicy, totalAgentBudget: 1 },
    phases: [{ type: "fanout", name: "f", prompt: "do {{item}}", items: ["a", "b"] }] }), /BUDGET_EXHAUSTED/);
  // DEPTH_LIMIT: maxDepth 0 forbids agentBudget > 1.
  assert.throws(() => compileV3Spec({ schema: "pi-dynamic-workflow/v3",
    delegation: { ...compilePolicy, maxDepth: 0 },
    phases: [{ ...agent, agentBudget: 2 }] }), /DEPTH_LIMIT/);
});

// ---------------------------------------------------------------------------
// 2. makeV3Render (pure, no consent)
// ---------------------------------------------------------------------------

test("makeV3Render substitutes outputs/item/index and fails closed", () => {
  const compiled = compileV3Spec(validSpec());
  const render = makeV3Render(compiled);
  const reviewOutput = { status: "success", summary: "done" };
  const outputs = { review: reviewOutput, sweep: "text-out" };
  const roots = render({ kind: "roots", phaseIndex: 1, phase: compiled.phases[1], roots: [
    { nodeId: "n1", phaseIndex: 1, itemIndex: 0, label: "a", taskTemplate: "Sweep {{item}} after {{outputs.review}}." },
    { nodeId: "n2", phaseIndex: 1, itemIndex: 1, label: "b", taskTemplate: "Sweep {{item}} ({{index}}) then {{output:sweep}}." },
  ], outputs });
  assert.equal(roots[0].task, `Sweep a after ${canonicalJSON(reviewOutput)}.`);
  assert.equal(roots[1].task, "Sweep b (1) then text-out.");
  // String outputs substitute as-is; structured outputs canonicalize.
  assert.equal(render({ kind: "shell", phaseIndex: 2, phase: compiled.phases[2], value: "echo {{outputs.sweep}}", outputs }), "echo text-out");
  // Artifact: static content wins; a from source renders string as-is, else canonical.
  assert.equal(render({ kind: "artifact", phaseIndex: 3, phase: compiled.phases[3], value: null, outputs }), "static report");
  assert.equal(render({ kind: "artifact", phaseIndex: 4, phase: compiled.phases[4], value: reviewOutput, outputs }), canonicalJSON(reviewOutput));
  assert.equal(render({ kind: "artifact", phaseIndex: 4, phase: compiled.phases[4], value: "raw", outputs }), "raw");
  // Unknown reference and item/index outside a fanout root fail closed.
  assert.throws(() => render({ kind: "shell", phaseIndex: 2, phase: compiled.phases[2], value: "echo {{outputs.missing}}", outputs }), /INVALID_REQUEST/);
  assert.throws(() => render({ kind: "roots", phaseIndex: 0, phase: compiled.phases[0], roots: [
    { nodeId: "n0", phaseIndex: 0, label: "review", taskTemplate: "no {{item}} here" },
  ], outputs }), /INVALID_REQUEST/);
  // Oversize rendered tasks fail the downstream text() bound.
  assert.throws(() => render({ kind: "roots", phaseIndex: 0, phase: compiled.phases[0], roots: [
    { nodeId: "n0", phaseIndex: 0, label: "review", taskTemplate: "x".repeat(4097) },
  ], outputs }), /INVALID_REQUEST/);
});

// ---------------------------------------------------------------------------
// 3. buildV3WorkerRecipe (pure-ish: per-node profile dir creation only)
// ---------------------------------------------------------------------------

test("buildV3WorkerRecipe builds the trusted setup, tools by depth, and a clean env", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "v3-recipe-")));
  try {
    const node = { nodeId: "node-1", parentNodeId: null, assignment: { task: "Do the fixture task." },
      authority: { grantedTools: ["read", "grep", "find", "ls"] } };
    const binding = { worker: { sdkPackagePath: "/sdk", authPath: "/fixture-auth.json", workerEntryPath: "/fixture-worker.mjs" } };
    const workersRoot = join(root, "workers");
    mkdirSync(workersRoot, { mode: 0o700 });
    const recipe = buildV3WorkerRecipe({ node, nodes: [node], binding, workersRoot, policy: { maxDepth: 0 } });
    assert.equal(recipe.command, process.execPath);
    assert.equal(recipe.args[0], "/fixture-worker.mjs");
    const setup = JSON.parse(recipe.args[1]);
    assert.equal(setup.schema, "pi-workflow-sdk-worker/v1");
    assert.deepEqual(setup.tools, ["read", "grep", "find", "ls", "workflow_context", "workflow_complete"]);
    assert.equal(setup.prompt, "Do the fixture task.");
    assert.equal(setup.agentDir, join(workersRoot, "node-1", "agent"));
    assert.deepEqual(validateWorkerSetup(setup).tools, setup.tools, "validateWorkerSetup accepts the built setup");
    assert.deepEqual(recipe.tools, setup.tools);
    // Per-node 0700 profile dirs.
    for (const directory of ["home", "agent", "store", "sessions", "tmp"]) {
      assert.equal(statSync(join(workersRoot, "node-1", directory)).mode & 0o777, 0o700, directory);
    }
    // No ambient env is inherited; the FD4 bootstrap carries the socket.
    assert.deepEqual(Object.keys(recipe.env).sort(), ["HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR",
      "PI_DYNAMIC_THREAD_PHASE_BACKGROUND", "PI_DYNAMIC_WORKFLOW_BACKGROUND", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK",
      "PI_TELEMETRY", "PI_THREAD_PHASE_STATUS_BRIDGE", "PI_THREAD_PHASE_STORE_DIR", "PI_THREAD_PHASE_TERMINAL_TITLE", "TMPDIR"].sort());
    assert.equal("PI_DELEGATION_BRIDGE_SOCKET" in recipe.env, false);
    // workflow_delegate iff depth < maxDepth.
    const delegating = buildV3WorkerRecipe({ node, nodes: [node], binding, workersRoot, policy: { maxDepth: 1 } });
    assert.ok(JSON.parse(delegating.args[1]).tools.includes("workflow_delegate"));
    const parent = { ...node, nodeId: "parent-2" };
    const childNode = { ...node, nodeId: "child-2", parentNodeId: "parent-2" };
    const atMaxDepth = buildV3WorkerRecipe({ node: childNode, nodes: [parent, childNode], binding, workersRoot, policy: { maxDepth: 1 } });
    assert.ok(!JSON.parse(atMaxDepth.args[1]).tools.includes("workflow_delegate"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4 + 9. Connected foreground chain, then resume-downgrade rejection (chained)
// ---------------------------------------------------------------------------

let foregroundChain; // { fixture, runId, specValue } — produced by test 4, consumed and cleaned by test 9.

consentTest("connected foreground chain executes one synthetic agent root end to end", { timeout: 90_000 }, async (t) => {
  const fixture = connectedFixture(t);
  foregroundChain = { fixture };
  try {
    prepareConnectedEnv(fixture);
    __setV3LaunchProfileForTests(fixture.profile);
    const specValue = execSpec();
    const result = await tool().execute("v3-exec-fg", { v3: specValue }, undefined, undefined, fakeCtx(fixture));
    assert.equal(result.details?.ok, true);
    assert.equal(result.details?.status, "success");
    assert.equal(typeof result.details?.runId, "string");
    const runId = result.details.runId;
    const artifactsDir = join(fixture.storeDir, "artifacts", runId);
    const resultArtifact = JSON.parse(readFileSync(join(artifactsDir, "workflow-result.json"), "utf8"));
    assert.equal(resultArtifact.schema, "pi-dynamic-workflow-result/v2");
    assert.equal(resultArtifact.resumable, false);
    assert.equal(resultArtifact.status, "success");
    assert.equal(resultArtifact.launchId, result.details.launchId);
    // Verified root output projection from the immutable result artifact.
    assert.equal(resultArtifact.phases.root.status, "success");
    assert.equal(resultArtifact.phases.root.summary, "synthetic private SDK worker completed");
    assert.equal(resultArtifact.usage.totals.totalTokens, 7);
    assert.equal(resultArtifact.usage.completeness, "reported");
    assert.deepEqual(resultArtifact.budget, { totalAgentBudget: 1, spent: 1 });
    assert.deepEqual(resultArtifact.admission, { maxConcurrentAgents: 4, maxLiveAgents: 8 });
    assert.equal(resultArtifact.delegation.closed, true);
    const inspection = inspectDelegationJournal(join(artifactsDir, "delegation"), bindingFor(fixture, specValue, resultArtifact));
    assert.equal(inspection.projection, "current");
    assert.equal(inspection.state.workflowOpen, false);
    assert.ok(inspection.state.nodes.length >= 1);
    assert.ok(inspection.state.nodes.every((node) => node.joined && node.closed));
    const events = runEvents(fixture, runId);
    assert.equal(events[0].type, "workflow_start");
    assert.equal(events[0].metadata?.delegation, "v3");
    assert.equal(events[0].metadata?.resumable, false);
    assert.equal(events[0].metadata?.continuationMode, "none");
    assert.equal(events.at(-1).type, "workflow_end");
    assert.equal(events.at(-1).status, "success");
    assert.equal(existsSync(join(artifactsDir, "workflow-checkpoint.json")), false, "v3 runs never write a checkpoint");
    // Per-node 0700 worker profile dirs are retained with the run.
    const workers = readdirSync(join(artifactsDir, "workers"));
    assert.equal(workers.length, 1);
    assert.equal(statSync(join(artifactsDir, "workers", workers[0])).mode & 0o777, 0o700);
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(resultArtifact) + JSON.stringify(events), CREDENTIAL_PATTERN);
    assert.deepEqual(readdirSync(fixture.childTmp).filter((entry) => entry.startsWith("pi-dynamic-workflow-")), [], "temp input removed");
    foregroundChain.runId = runId;
    foregroundChain.specValue = specValue;
    // The fixture is retained for the chained resume-downgrade test, which owns cleanup.
  } catch (error) {
    t.diagnostic(`retained owned fixture ${fixture.root}`);
    foregroundChain = undefined;
    throw error;
  }
});

consentTest("resume of a v3 run is rejected before and after a forged downgrade", { timeout: 60_000 }, async (t) => {
  const chained = foregroundChain;
  assert.ok(chained?.runId, "the connected foreground run is required");
  const { fixture, runId } = chained;
  try {
    prepareConnectedEnv(fixture);
    const runDir = join(fixture.storeDir, "artifacts", runId);
    // Ordinary resume: v3 runs write no checkpoint, so it dies at the missing
    // checkpoint read before any ownership check.
    let result = await collect(spawnBin(fixture, ["--resume-run-id", runId, "--session-id", SESSION_ID]));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Could not read workflow resume checkpoint/);
    // Forged downgrade: a planted valid v2-shape checkpoint and spec still lose
    // to the authoritative workflow_start metadata marker.
    writeFileSync(join(runDir, "workflow-spec.json"), JSON.stringify({ schema: "pi-dynamic-workflow/v2",
      phases: [{ type: "artifact", name: "x", content: "y" }] }, null, 2));
    writeFileSync(join(runDir, "workflow-checkpoint.json"), JSON.stringify({
      schema: "pi-dynamic-workflow-checkpoint/v2", runId, cwd: realpathSync(fixture.workspace),
      sessionId: SESSION_ID, completed: [] }, null, 2));
    result = await collect(spawnBin(fixture, ["--resume-run-id", runId, "--session-id", SESSION_ID]));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not resumable/);
    fixture.clean = true;
  } finally {
    finishFixture(t, fixture);
    foregroundChain = undefined;
  }
});

// ---------------------------------------------------------------------------
// 5. Connected background chain
// ---------------------------------------------------------------------------

consentTest("connected background chain relays readiness then completes in the detached owner", { timeout: 90_000 }, async (t) => {
  const fixture = connectedFixture(t, "v3-exec-bg-");
  try {
    prepareConnectedEnv(fixture);
    __setV3LaunchProfileForTests(fixture.profile);
    const result = await tool().execute("v3-exec-bg", { v3: execSpec(), background: true, progressReviewIntervalMs: 120_000 }, undefined, undefined, fakeCtx(fixture));
    assert.equal(result.details?.ok, true);
    assert.equal(result.details?.ready, true);
    assert.equal(result.details?.background, true);
    assert.equal(typeof result.details?.runId, "string");
    assert.ok(result.details?.pid);
    // Detached-owned cleanup precedes the ready record the wrapper relays.
    assert.deepEqual(readdirSync(fixture.childTmp).filter((entry) => entry.startsWith("pi-dynamic-workflow-")), [], "temp input removed");
    const runId = result.details.runId;
    const artifactsDir = join(fixture.storeDir, "artifacts", runId);
    const resultPath = join(artifactsDir, "workflow-result.json");
    const deadline = Date.now() + 60_000;
    while (!existsSync(resultPath)) {
      assert.ok(Date.now() < deadline, "detached run did not record a result artifact");
      await sleep(100);
    }
    const resultArtifact = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.equal(resultArtifact.status, "success");
    assert.equal(resultArtifact.resumable, false);
    assert.equal(resultArtifact.usage.totals.totalTokens, 7);
    const events = runEvents(fixture, runId);
    assert.equal(events[0].metadata?.delegation, "v3");
    assert.equal(events[0].metadata?.continuationMode, "terminal");
    assert.equal(events[0].metadata?.supervisionMode, "main-agent");
    assert.equal(events[0].metadata?.progressReviewIntervalMs, 120_000);
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(resultArtifact), CREDENTIAL_PATTERN);
    fixture.clean = true;
  } finally {
    finishFixture(t, fixture);
  }
});

// ---------------------------------------------------------------------------
// 6. Missing/forged auth fails closed
// ---------------------------------------------------------------------------

consentTest("absent, non-file, and malformed auth fail closed without credential material", { timeout: 90_000 }, async (t) => {
  const fixture = connectedFixture(t, "v3-exec-auth-");
  try {
    prepareConnectedEnv(fixture);
    const execute = tool().execute;
    // Truly absent auth paths deny SCOPE_DENIED at launch-authority
    // construction (canonicalPath), before any spawn or run artifact.
    __setV3LaunchProfileForTests({ ...fixture.profile, authPath: join(fixture.root, "absent-auth.json") });
    await assert.rejects(execute("v3-exec-auth-absent", { v3: execSpec() }, undefined, undefined, fakeCtx(fixture)), /SCOPE_DENIED/);
    assert.equal(existsSync(fixture.storeDir), false, "no run artifacts on pre-spawn denial");
    // A non-file and a malformed auth file both pass the path binding and fail
    // closed in the worker (PI_WORKER_FAIL_STOP:SDK_WORKER): node failed, run
    // failed, wrapper rejects PHASE_FAILED, durable failed result artifact.
    const nonFile = join(fixture.root, "non-file-auth.json");
    mkdirSync(nonFile);
    const malformed = join(fixture.root, "malformed-auth.json");
    writeFileSync(malformed, "{not-json", { mode: 0o600 });
    for (const [variant, authPath] of [["non-file", nonFile], ["malformed", malformed]]) {
      __setV3LaunchProfileForTests({ ...fixture.profile, authPath });
      let failure;
      await execute(`v3-exec-auth-${variant}`, { v3: execSpec() }, undefined, undefined, fakeCtx(fixture)).catch((error) => { failure = error; });
      assert.match(String(failure?.message || failure), /PHASE_FAILED/, variant);
      assert.doesNotMatch(String(failure?.stack || failure), CREDENTIAL_PATTERN);
      const runId = /"runId": "([^"]+)"/.exec(String(failure?.message))?.[1];
      assert.ok(runId, "bounded failure record carries the runId");
      const resultArtifact = JSON.parse(readFileSync(join(fixture.storeDir, "artifacts", runId, "workflow-result.json"), "utf8"));
      assert.equal(resultArtifact.status, "failed");
      assert.equal(resultArtifact.resumable, false);
      assert.doesNotMatch(JSON.stringify(resultArtifact), CREDENTIAL_PATTERN);
    }
    fixture.clean = true;
  } finally {
    finishFixture(t, fixture);
  }
});

// ---------------------------------------------------------------------------
// 7. Cancellation mid-run
// ---------------------------------------------------------------------------

consentTest("SIGTERM mid-run settles cancelled, closes the journal, and refuses resume", { timeout: 90_000 }, async (t) => {
  const fixture = connectedFixture(t, "v3-exec-cancel-");
  try {
    prepareConnectedEnv(fixture);
    const specValue = execSpec("synthetic-await-abort: hold the stream until cancelled.");
    const { file } = writeSpecInput(fixture, specValue);
    const envelope = mintInitialEnvelope(fixture, specValue);
    const child = spawnBin(fixture, ["--v3-launch", "--launch-envelope-fd", "3", "--cwd", fixture.workspace,
      "--spec-file", file, "--cleanup-input", "--session-id", SESSION_ID, "--session-file", fixture.sessionFile], { withFd3: true });
    child.stdio[3].end(envelope);
    // SIGTERM once the run's workflow_start is durable.
    const runsDir = join(fixture.storeDir, "runs");
    const deadline = Date.now() + 30_000;
    for (;;) {
      assert.ok(Date.now() < deadline, "v3 run did not start");
      if (existsSync(runsDir) && readdirSync(runsDir).some((entry) => entry.endsWith(".jsonl"))) break;
      await sleep(50);
    }
    child.kill("SIGTERM");
    const result = await collect(child);
    assert.equal(result.code, 130, result.stderr);
    const record = JSON.parse(result.stdout.trim());
    assert.equal(record.ok, false);
    assert.equal(record.code, "CANCELLED");
    assert.equal(typeof record.runId, "string");
    const artifactsDir = join(fixture.storeDir, "artifacts", record.runId);
    const resultArtifact = JSON.parse(readFileSync(join(artifactsDir, "workflow-result.json"), "utf8"));
    assert.equal(resultArtifact.status, "cancelled");
    assert.equal(resultArtifact.resumable, false);
    const inspection = inspectDelegationJournal(join(artifactsDir, "delegation"), bindingFor(fixture, specValue, resultArtifact));
    assert.equal(inspection.state.workflowOpen, false, "journal closed");
    // A cancelled v3 run is never resumable.
    const resume = await collect(spawnBin(fixture, ["--resume-run-id", record.runId, "--session-id", SESSION_ID]));
    assert.equal(resume.code, 1);
    assert.equal(existsSync(file), false, "temp spec input removed");
    fixture.clean = true;
  } finally {
    finishFixture(t, fixture);
  }
});

// ---------------------------------------------------------------------------
// 8. Child -> grandchild delegation
// ---------------------------------------------------------------------------

consentTest("connected child-grandchild delegation joins two batches with verified summaries", { timeout: 120_000 }, async (t) => {
  const fixture = connectedFixture(t, "v3-exec-tree-");
  try {
    prepareConnectedEnv(fixture);
    __setV3LaunchProfileForTests(fixture.profile);
    const specValue = {
      ...execSpec(),
      delegation: {
        maxDepth: 2,
        totalAgentBudget: 3,
        directoryScope: { read: ["."], write: [] },
        context: { objective: "Synthetic v3 delegation tree", constraints: ["Offline fixture only"] },
      },
      phases: [{ type: "agent", name: "root", prompt: "Complete the synthetic bounded root assignment.", agentBudget: 3 }],
    };
    const result = await tool().execute("v3-exec-tree", { v3: specValue }, undefined, undefined, fakeCtx(fixture));
    assert.equal(result.details?.ok, true);
    const runId = result.details.runId;
    const artifactsDir = join(fixture.storeDir, "artifacts", runId);
    const resultArtifact = JSON.parse(readFileSync(join(artifactsDir, "workflow-result.json"), "utf8"));
    assert.equal(resultArtifact.status, "success");
    // 3 nodes x 7 completion-turn tokens; delegating turns carry no usage.
    assert.equal(resultArtifact.usage.totals.totalTokens, 21);
    const delegationDir = join(artifactsDir, "delegation");
    const inspection = inspectDelegationJournal(delegationDir, bindingFor(fixture, specValue, resultArtifact));
    assert.equal(inspection.state.nodes.length, 3);
    assert.equal(inspection.state.batches.length, 2);
    assert.ok(inspection.state.batches.every((batch) => batch.joined));
    assert.ok(inspection.state.nodes.every((node) => node.joined && node.closed && node.result.status === "success"));
    assert.equal(inspection.state.workflowOpen, false);
    // Verified per-node summaries come from the immutable result artifacts; the
    // accepted child reviews prove the delegate responses carried them (the
    // bridge fails closed RESULT_INVALID otherwise).
    for (const node of inspection.state.nodes) {
      const evidence = decodeCanonical(readStoredArtifact(delegationDir,
        { artifactId: node.result.artifactId, bytes: node.result.bytes, sha256: node.result.sha256 }));
      assert.equal(evidence.summary, "synthetic private SDK worker completed");
    }
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(resultArtifact), CREDENTIAL_PATTERN);
    fixture.clean = true;
  } finally {
    finishFixture(t, fixture);
  }
});
