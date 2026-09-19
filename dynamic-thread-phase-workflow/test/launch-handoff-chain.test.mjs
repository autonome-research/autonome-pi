// UNEXECUTED: parent validation runs this file in the fixed offline shell.
// Real offline spawn-chain tests: node + the actual bin runner, envelope pipes
// on fd 3, synthetic fixtures positively owned under this test's TMPDIR. No
// network, no real auth path (sentinel fixture only).
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHostedLaunchAuthority } from "../lib/delegation-launch-authorization.mjs";
import { canonicalJSON, sha256 } from "../lib/delegation-storage.mjs";
import { validateDelegationPolicy } from "../lib/delegation-contract.mjs";
import { isolatedResourceOptions } from "../worker/profile.mjs";
import registerDynamicWorkflows, { __setV3LaunchProfileForTests } from "../index.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cli = join(repoRoot, "dynamic-thread-phase-workflow/bin/dynamic-thread-phase-workflow.mjs");

const GATE = "PI_DYNAMIC_WORKFLOW_RECURSIVE_LAUNCH";
const ENV_KEYS = [GATE, "TMPDIR", "PI_THREAD_PHASE_STORE_DIR", "PI_DYNAMIC_WORKFLOW_BACKGROUND", "PI_DYNAMIC_THREAD_PHASE_BACKGROUND"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const root = realpathSync(mkdtempSync(join(tmpdir(), "launch-chain-")));
after(() => rmSync(root, { recursive: true, force: true }));
const childTmp = join(root, "tmp"); mkdirSync(childTmp);
const home = join(root, "home"); mkdirSync(home);
const workspace = join(root, "workspace"); mkdirSync(workspace);
const sdkDir = join(root, "sdk"); mkdirSync(sdkDir);
const workerEntry = join(root, "sdk-runner.mjs"); writeFileSync(workerEntry, "// launch chain fixture entry\n");
// Synthetic sentinel fixture: positively owned, never a real credential. The
// chain binds the nonsecret path only and must never read or leak content.
const SENTINEL = "PRIVATE_SENTINEL_LAUNCH_CHAIN";
const authFile = join(root, "auth.json");
writeFileSync(authFile, `{"openai-codex":{"type":"oauth","access":"${SENTINEL}"}}\n`, { mode: 0o600 });
const sessionFile = join(root, "session.jsonl");
const storeDir = join(root, "store");
const SESSION_ID = "chain-session";

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

const spec = () => ({
  schema: "pi-dynamic-workflow/v3",
  name: "chain-fixture",
  delegation: {
    maxDepth: 1,
    totalAgentBudget: 2,
    // The workspace exists, so an authorized chain reaches worker spawn.
    directoryScope: { read: ["."], write: [] },
    context: { objective: "Bounded review", constraints: ["stay in scope"] },
  },
  // The stub workerEntryPath exits 0 without a bootstrap read, so execution
  // reaches worker spawn and the root node ends missing_completion.
  phases: [{ type: "agent", name: "step", prompt: "Complete the bounded fixture step." }],
});

const profile = () => ({
  sdkPackagePath: sdkDir,
  workerEntryPath: workerEntry,
  authPath: authFile,
  resourceProfile: isolatedResourceOptions(),
  limits: { maxConcurrentAgents: 4, maxLiveAgents: 8 },
});

function writeSpecInput(specValue) {
  const dir = mkdtempSync(join(childTmp, "pi-dynamic-workflow-"));
  const file = join(dir, "workflow-spec.json");
  writeFileSync(file, JSON.stringify(specValue, null, 2));
  return { dir, file };
}

// Mint a real initial-stage envelope with the trusted module and a synthetic
// profile, asserting exactly the runner-side recomputation subset.
function mintInitialEnvelope(specValue, { background = false, progressReviewIntervalMs } = {}) {
  const authority = createHostedLaunchAuthority(profile());
  const launch = {
    spec: specValue,
    cwd: workspace,
    background,
    ...(progressReviewIntervalMs !== undefined ? { progressReviewIntervalMs } : {}),
  };
  const grant = authority.prepare(
    { mode: "tui", sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => sessionFile } },
    launch,
  );
  const expected = {
    sessionId: SESSION_ID,
    sessionFile,
    cwd: realpathSync(workspace),
    specDigest: sha256(canonicalJSON(specValue)),
    policyDigest: sha256(canonicalJSON(validateDelegationPolicy(specValue.delegation))),
    background,
    progressReviewIntervalMs: progressReviewIntervalMs ?? null,
  };
  return authority.consume(grant, expected).initialEnvelope();
}

const baseArgs = (file, extra = []) => [
  "--v3-launch", "--launch-envelope-fd", "3",
  "--cwd", workspace,
  "--spec-file", file,
  "--cleanup-input",
  "--session-id", SESSION_ID,
  "--session-file", sessionFile,
  ...extra,
];

function spawnRunner(args, { withFd3 = false, env = {} } = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: workspace,
    stdio: withFd3 ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: childTmp,
      PI_THREAD_PHASE_STORE_DIR: storeDir,
      PI_DYNAMIC_WORKFLOW_BACKGROUND: "",
      PI_DYNAMIC_THREAD_PHASE_BACKGROUND: "",
      ...env,
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

const residue = () => readdirSync(childTmp).filter((entry) => entry.startsWith("pi-dynamic-workflow-")).sort();
const runEvents = (runId) => readFileSync(join(storeDir, "runs", `${runId}.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
// Execution now creates a durable (failed) run: workflow_start carries the v3
// marker, a terminal workflow_end exists, and the v2 result artifact is
// recorded with resumable:false. Callers clean the store afterwards.
function assertV3FailedRun(runId) {
  const events = runEvents(runId);
  assert.equal(events[0].type, "workflow_start");
  assert.equal(events[0].metadata?.delegation, "v3");
  assert.equal(events[0].metadata?.resumable, false);
  assert.equal(events.at(-1).type, "workflow_end");
  assert.equal(events.at(-1).status, "failed");
  const resultArtifact = JSON.parse(readFileSync(join(storeDir, "artifacts", runId, "workflow-result.json"), "utf8"));
  assert.equal(resultArtifact.schema, "pi-dynamic-workflow-result/v2");
  assert.equal(resultArtifact.status, "failed");
  assert.equal(resultArtifact.resumable, false);
  assert.equal(existsSync(join(storeDir, "artifacts", runId, "workflow-checkpoint.json")), false);
}
// Wait for the detached owner's terminal event before store cleanup.
async function awaitRunEnd(runId) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    assert.ok(Date.now() < deadline, "detached run did not record a terminal event");
    const file = join(storeDir, "runs", `${runId}.jsonl`);
    if (existsSync(file) && readFileSync(file, "utf8").includes('"type":"workflow_end"')) return;
    await sleep(100);
  }
}
function assertClean(result, { specFile }) {
  assert.equal(existsSync(specFile), false, "temp spec input must be removed");
  assert.deepEqual(residue(), [], "no temp input or ready-dir residue");
  assert.equal(existsSync(storeDir), false, "no visualizer runs/process journals/checkpoints/artifacts");
  assert.ok(!result.stdout.includes(SENTINEL) && !result.stderr.includes(SENTINEL), "credential sentinel must never appear in output");
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

test("missing fd 3 denies pre-side-effects and removes the temp input", { timeout: 20_000 }, async () => {
  const { file } = writeSpecInput(spec());
  const result = await collect(spawnRunner(baseArgs(file)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /FRAME_PROTOCOL|INVALID_REQUEST/);
  assertClean(result, { specFile: file });
});

test("a forged digest denies LAUNCH_MISMATCH pre-side-effects", { timeout: 20_000 }, async () => {
  const specValue = spec();
  const { file } = writeSpecInput(specValue);
  const envelope = JSON.parse(mintInitialEnvelope(specValue).toString("utf8"));
  envelope.binding.specDigest = "f".repeat(64);
  const child = spawnRunner(baseArgs(file), { withFd3: true });
  child.stdio[3].end(Buffer.from(`${canonicalJSON(envelope)}\n`));
  const result = await collect(child);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /LAUNCH_MISMATCH/);
  assertClean(result, { specFile: file });
});

test("a wrong-stage envelope is UNAUTHORIZED", { timeout: 20_000 }, async () => {
  const specValue = spec();
  const { file } = writeSpecInput(specValue);
  const envelope = JSON.parse(mintInitialEnvelope(specValue).toString("utf8"));
  envelope.stage = "detached";
  const child = spawnRunner(baseArgs(file), { withFd3: true });
  child.stdio[3].end(Buffer.from(`${canonicalJSON(envelope)}\n`));
  const result = await collect(child);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /UNAUTHORIZED/);
  assertClean(result, { specFile: file });
});

test("an authorized initial envelope executes and fails closed without execution prerequisites", { timeout: 30_000 }, async () => {
  const specValue = spec();
  const { file } = writeSpecInput(specValue);
  const envelope = mintInitialEnvelope(specValue);
  const launchId = JSON.parse(envelope.toString("utf8")).binding.launchId;
  const child = spawnRunner(baseArgs(file), { withFd3: true });
  child.stdio[3].end(envelope);
  const result = await collect(child);
  assert.equal(result.code, 1, result.stderr);
  const record = JSON.parse(result.stdout.trim());
  assert.equal(record.ok, false);
  assert.equal(record.code, "PHASE_FAILED");
  assert.equal(record.launchId, launchId);
  assert.equal(typeof record.runId, "string");
  assert.equal(existsSync(file), false, "temp spec input must be removed");
  assert.deepEqual(residue(), [], "no temp input or ready-dir residue");
  assert.ok(!result.stdout.includes(SENTINEL) && !result.stderr.includes(SENTINEL), "credential sentinel must never appear in output");
  assertV3FailedRun(record.runId);
  rmSync(storeDir, { recursive: true, force: true }); // keep later denial tests residue-free
});

test("wrapper-driven background chain hands off; detached owner executes and fails closed", { timeout: 60_000 }, async () => {
  process.env[GATE] = "1";
  process.env.TMPDIR = childTmp; // wrapper mkdtemp and runner cleanup agree on the owned root
  process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
  process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND = "";
  process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND = "";
  __setV3LaunchProfileForTests(profile());
  const registered = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => registered.set(definition.name, definition) });
  const execute = registered.get("dynamic_workflow").execute;
  const fakeCtx = {
    mode: "tui",
    cwd: workspace,
    sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => sessionFile },
  };
  // The detached owner becomes ready once every execution prerequisite is
  // durable; the wrapper resolves with the relayed ready record.
  const result = await execute("chain-bg", { v3: spec(), background: true, progressReviewIntervalMs: 120_000 }, undefined, undefined, fakeCtx);
  assert.equal(result.details?.ok, true);
  assert.equal(result.details?.ready, true);
  assert.equal(result.details?.background, true);
  assert.equal(typeof result.details?.runId, "string");
  assert.ok(result.details?.pid);
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
  // Detached-owned cleanup precedes the ready record the wrapper relays.
  assert.deepEqual(residue(), [], "no temp input or ready-dir residue");
  // The stub fixture entry exits without a bootstrap read: the asynchronous
  // run fails closed (missing_completion) and records a durable failed result.
  const resultPath = join(storeDir, "artifacts", result.details.runId, "workflow-result.json");
  const deadline = Date.now() + 30_000;
  while (!existsSync(resultPath)) {
    assert.ok(Date.now() < deadline, "detached run did not record a result artifact");
    await sleep(100);
  }
  const resultArtifact = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.equal(resultArtifact.schema, "pi-dynamic-workflow-result/v2");
  assert.equal(resultArtifact.status, "failed");
  assert.equal(resultArtifact.resumable, false);
  await awaitRunEnd(result.details.runId);
  const events = runEvents(result.details.runId);
  assert.equal(events[0].metadata?.delegation, "v3");
  assert.equal(events[0].metadata?.continuationMode, "terminal");
  rmSync(storeDir, { recursive: true, force: true }); // keep later denial tests residue-free
});

test("a detached owner denies an EOF pipe and cleans its owned input", { timeout: 20_000 }, async () => {
  const { file } = writeSpecInput(spec());
  const child = spawnRunner(baseArgs(file), {
    withFd3: true,
    env: { PI_DYNAMIC_WORKFLOW_BACKGROUND: "1" }, // detached owner role
  });
  child.stdio[3].end(); // EOF before any frame bytes
  const result = await collect(child);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /FRAME_PROTOCOL/);
  assertClean(result, { specFile: file });
});

test("SIGTERM before handoff cancels the launch and cleans the owned input", { timeout: 20_000 }, async () => {
  const { file } = writeSpecInput(spec());
  const child = spawnRunner(baseArgs(file, ["--background"]), { withFd3: true });
  // Hold the envelope pipe open without writing; cancel while the runner waits.
  await sleep(250);
  child.kill("SIGTERM");
  const result = await collect(child);
  child.stdio[3].destroy();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /LAUNCH_CANCELLED/);
  assertClean(result, { specFile: file });
});
