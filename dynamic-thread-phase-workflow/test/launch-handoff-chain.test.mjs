// UNEXECUTED: parent validation runs this file in the fixed offline shell.
// Real offline spawn-chain tests: node + the actual bin runner, envelope pipes
// on fd 3, synthetic fixtures positively owned under this test's TMPDIR. No
// network, no real auth path (sentinel fixture only).
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    directoryScope: { read: ["src"], write: [] },
    context: { objective: "Bounded review", constraints: ["stay in scope"] },
  },
  phases: [{ type: "shell", name: "step", command: "true" }],
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

test("an authorized initial envelope yields the exit-78 NOT_IMPLEMENTED denial", { timeout: 20_000 }, async () => {
  const specValue = spec();
  const { file } = writeSpecInput(specValue);
  const envelope = mintInitialEnvelope(specValue);
  const launchId = JSON.parse(envelope.toString("utf8")).binding.launchId;
  const child = spawnRunner(baseArgs(file), { withFd3: true });
  child.stdio[3].end(envelope);
  const result = await collect(child);
  assert.equal(result.code, 78, result.stderr);
  const denial = JSON.parse(result.stdout.trim());
  assert.equal(denial.ok, false);
  assert.equal(denial.code, "NOT_IMPLEMENTED");
  assert.equal(denial.error, "recursive v3 execution is disconnected in this build");
  assert.equal(denial.launchId, launchId);
  assertClean(result, { specFile: file });
});

test("wrapper-driven background chain hands off; detached owner denies and cleans", { timeout: 30_000 }, async () => {
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
  let failure;
  await execute("chain-bg", { v3: spec(), background: true, progressReviewIntervalMs: 120_000 }, undefined, undefined, fakeCtx)
    .catch((error) => { failure = error; });
  assert.match(String(failure?.message || failure), /NOT_IMPLEMENTED/);
  assert.ok(!String(failure?.stack || failure).includes(SENTINEL));
  // Detached-owned cleanup precedes the denial record the wrapper relays.
  assert.deepEqual(residue(), [], "no temp input or ready-dir residue");
  assert.equal(existsSync(storeDir), false, "no visualizer runs/process journals/checkpoints/artifacts");
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
