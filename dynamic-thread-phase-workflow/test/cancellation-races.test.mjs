import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const cli = join(root, "dynamic-thread-phase-workflow/bin/dynamic-thread-phase-workflow.mjs");
const posixOnly = process.platform === "win32" && "requires POSIX process-group signals";

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

function spawnRunner(args, options) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("close", (code, signal) => resolveCompletion({ code, signal, stdout, stderr }));
  });
  return { child, completion };
}

function runFiles(store) {
  const dir = join(store, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
}

function readEvents(store, runId) {
  const file = join(store, "runs", `${runId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}

async function waitForRunId(store) {
  return await waitFor(() => {
    const files = runFiles(store);
    return files.length === 1 ? files[0].slice(0, -".jsonl".length) : undefined;
  }, "runner did not create exactly one run");
}

function requestCancellation(store, runId, reason = "cancelled by integration test") {
  const dir = join(store, "cancel");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${runId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({
    runId,
    requestedAt: new Date().toISOString(),
    reason,
    source: "dynamic-workflow-test",
  }), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}

function assertCancelledResult(store, runId) {
  const events = readEvents(store, runId);
  const terminal = events.filter((event) => event.type === "workflow_end").at(-1);
  assert.equal(terminal?.status, "cancelled", JSON.stringify(events.at(-1)));
  const result = JSON.parse(readFileSync(join(store, "artifacts", runId, "workflow-result.json"), "utf8"));
  assert.equal(result.status, "cancelled");
  return { events, result };
}

function longRunningHelper(temp, name = "hold") {
  const helper = join(temp, `${name}.mjs`);
  const ready = join(temp, `${name}.ready`);
  writeFileSync(helper, `import { appendFileSync, writeFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(join(temp, `${name}.attempts`))}, "attempt\\n");\nwriteFileSync(${JSON.stringify(ready)}, String(process.pid));\nprocess.on("SIGTERM", () => process.exit(0));\nprocess.on("SIGINT", () => process.exit(0));\nsetInterval(() => {}, 1000);\n`);
  return { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`, ready, attempts: join(temp, `${name}.attempts`) };
}

async function cleanupChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolveClose) => child.once("close", resolveClose));
  }
}

test("cancellation-file polling cancels an active structured phase without retrying it", { skip: posixOnly, timeout: 20_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-cancel-file-"));
  const store = join(temp, "store");
  const specPath = join(temp, "spec.json");
  const helper = longRunningHelper(temp);
  writeFileSync(specPath, JSON.stringify({
    name: "cancel-file-race",
    permissions: "rwx",
    phases: [{ type: "shell", name: "hold", command: helper.command, retry: { maxAttempts: 3, baseDelayMs: 1 } }],
  }));
  const { child, completion } = spawnRunner(["--spec-file", specPath, "--cwd", temp], { env: { PI_THREAD_PHASE_STORE_DIR: store } });
  try {
    const runId = await waitForRunId(store);
    await waitFor(() => existsSync(helper.ready), "structured shell did not reach its explicit ready barrier");
    requestCancellation(store, runId);
    const completed = await completion;
    assert.equal(completed.code, 130, completed.stderr);
    assert.equal(JSON.parse(completed.stdout).cancelled, true);
    const { events } = assertCancelledResult(store, runId);
    assert.equal(events.filter((event) => event.type === "phase_end" && event.phase === "hold").at(-1)?.status, "cancelled");
    assert.equal(readFileSync(helper.attempts, "utf8").trim().split("\n").length, 1, "cancellation must not enter another retry attempt");
  } finally {
    await cleanupChild(child);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("SIGTERM during a foreground structured phase produces one cancelled terminal result", { skip: posixOnly, timeout: 20_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-sigterm-active-"));
  const store = join(temp, "store");
  const specPath = join(temp, "spec.json");
  const helper = longRunningHelper(temp);
  writeFileSync(specPath, JSON.stringify({
    name: "sigterm-active",
    permissions: "rwx",
    phases: [{ type: "shell", name: "hold", command: helper.command }],
  }));
  const { child, completion } = spawnRunner(["--spec-file", specPath, "--cwd", temp], { env: { PI_THREAD_PHASE_STORE_DIR: store } });
  try {
    const runId = await waitForRunId(store);
    await waitFor(() => existsSync(helper.ready), "structured shell did not reach its explicit ready barrier");
    child.kill("SIGTERM");
    const completed = await completion;
    assert.equal(completed.code, 130, completed.stderr);
    const { events } = assertCancelledResult(store, runId);
    assert.equal(events.filter((event) => event.type === "workflow_end").length, 1);
  } finally {
    await cleanupChild(child);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("cancellation-file polling aborts an active harness helper and its wrapper phase", { skip: posixOnly, timeout: 20_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-harness-cancel-"));
  const store = join(temp, "store");
  const harnessPath = join(temp, "workflow.mjs");
  const helper = longRunningHelper(temp, "harness-hold");
  writeFileSync(harnessPath, `export default async function workflow(ctx) {\n  await ctx.shell(${JSON.stringify(helper.command)}, { name: "harness-hold" });\n}\n`);
  const { child, completion } = spawnRunner(["--harness-file", harnessPath, "--permissions", "rwx", "--cwd", temp], { env: { PI_THREAD_PHASE_STORE_DIR: store } });
  try {
    const runId = await waitForRunId(store);
    await waitFor(() => existsSync(helper.ready), "harness shell did not reach its explicit ready barrier");
    requestCancellation(store, runId, "cancel active harness");
    const completed = await completion;
    assert.equal(completed.code, 130, completed.stderr);
    const { events } = assertCancelledResult(store, runId);
    for (const phase of ["harness-hold", "run-harness"]) {
      assert.equal(events.filter((event) => event.type === "phase_end" && event.phase === phase).at(-1)?.status, "cancelled", `${phase} was not cancelled`);
    }
  } finally {
    await cleanupChild(child);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("fanout cancellation settles every started sibling before the workflow ends", { skip: posixOnly, timeout: 20_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-fanout-cancel-"));
  const store = join(temp, "store");
  const fakePi = join(temp, "fake-pi.mjs");
  writeFileSync(fakePi, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nconst index = process.argv.indexOf("-p");\nconst item = index >= 0 ? process.argv[index + 1] : "unknown";\nif (item === "fast") {\n  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "fake", content: [{ type: "text", text: "fast complete" }] } }));\n} else {\n  writeFileSync(${JSON.stringify(temp)} + "/" + item + ".ready", String(process.pid));\n  process.on("SIGTERM", () => process.exit(0));\n  process.on("SIGINT", () => process.exit(0));\n  setInterval(() => {}, 1000);\n}\n`);
  chmodSync(fakePi, 0o755);
  const specPath = join(temp, "spec.json");
  writeFileSync(specPath, JSON.stringify({
    name: "fanout-cancel-race",
    permissions: "r",
    phases: [{ type: "fanout", name: "workers", items: ["fast", "slow-a", "slow-b"], concurrency: 3, prompt: "{{item}}" }],
  }));
  const { child, completion } = spawnRunner(["--spec-file", specPath, "--cwd", temp], {
    env: { PI_THREAD_PHASE_STORE_DIR: store, PI_DYNAMIC_WORKFLOW_PI_BIN: fakePi },
  });
  try {
    const runId = await waitForRunId(store);
    await waitFor(() => existsSync(join(temp, "slow-a.ready")) && existsSync(join(temp, "slow-b.ready")), "fanout siblings did not reach their ready barriers");
    await waitFor(() => readEvents(store, runId).some((event) => event.data?.kind === "fanout_item_end" && event.data?.index === 0 && event.data?.status === "success"), "fast fanout item did not complete before cancellation");
    requestCancellation(store, runId, "cancel fanout siblings");
    const completed = await completion;
    assert.equal(completed.code, 130, completed.stderr);
    const { events } = assertCancelledResult(store, runId);
    const starts = events.filter((event) => event.data?.kind === "fanout_item_start" && event.phase === "workers");
    const ends = events.filter((event) => event.data?.kind === "fanout_item_end" && event.phase === "workers");
    assert.equal(starts.length, 3);
    assert.equal(ends.length, starts.length, "workflow ended before every started sibling emitted a terminal event");
    assert.deepEqual(ends.map((event) => [event.data.index, event.data.status]).sort((a, b) => a[0] - b[0]), [[0, "success"], [1, "cancelled"], [2, "cancelled"]]);
    const workflowEndIndex = events.findIndex((event) => event.type === "workflow_end");
    assert.ok(ends.every((event) => events.indexOf(event) < workflowEndIndex), "fanout item terminals must precede workflow_end");
  } finally {
    await cleanupChild(child);
    rmSync(temp, { recursive: true, force: true });
  }
});
