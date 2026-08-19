import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const cli = join(root, "dynamic-thread-phase-workflow", "bin", "dynamic-thread-phase-workflow.mjs");

function runCli(args, env) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
}

function terminalJson(stdout) {
  const start = stdout.lastIndexOf("\n{");
  return JSON.parse(stdout.slice(start < 0 ? 0 : start + 1));
}

test("structured resume reuses validated contiguous phase-output artifacts", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-structured-resume-"));
  const store = join(temp, "store");
  const specPath = join(temp, "workflow.json");
  const quote = (value) => JSON.stringify(value);
  const spec = {
    name: "resume-artifacts",
    permissions: "rwx",
    phases: [
      {
        type: "shell",
        name: "seed",
        command: `${quote(process.execPath)} -e ${quote("const fs=require('fs');fs.appendFileSync('seed-count','1');process.stdout.write('seed-output')")}`,
      },
      {
        type: "shell",
        name: "continue",
        command: `${quote(process.execPath)} -e ${quote("const fs=require('fs');if(!fs.existsSync('allow'))process.exit(7);fs.appendFileSync('continue-count','1');process.stdout.write(process.argv[1]+'-continued')")} {{outputs.seed}}`,
      },
      { type: "artifact", name: "report", from: "continue", title: "Resumed report" },
    ],
  };
  writeFileSync(specPath, JSON.stringify(spec), "utf8");
  const env = { PI_THREAD_PHASE_STORE_DIR: store };

  try {
    const interrupted = runCli(["--spec-file", specPath, "--cwd", temp, "--session-id", "session-a"], env);
    assert.equal(interrupted.status, 1, interrupted.stderr || interrupted.stdout);
    const interruptedResult = terminalJson(interrupted.stdout);
    const sourceRunId = interruptedResult.runId;
    const sourceDir = join(store, "artifacts", sourceRunId);
    const checkpoint = JSON.parse(readFileSync(join(sourceDir, "workflow-checkpoint.json"), "utf8"));
    assert.equal(checkpoint.schema, "pi-dynamic-workflow-checkpoint/v1");
    assert.match(checkpoint.chainId, /^[0-9a-f-]{36}$/);
    assert.equal(checkpoint.rootRunId, sourceRunId);
    assert.equal(checkpoint.chainStep, 0);
    assert.deepEqual(checkpoint.completed.map((entry) => entry.name), ["seed"]);
    assert.equal(readFileSync(join(sourceDir, checkpoint.completed[0].outputFile), "utf8"), "seed-output");
    assert.equal(readFileSync(join(temp, "seed-count"), "utf8"), "1");

    const wrongSession = runCli(["--session-id", "session-b", "--resume-run-id", sourceRunId], env);
    assert.equal(wrongSession.status, 1);
    assert.match(wrongSession.stderr, /different Pi session/);

    writeFileSync(join(temp, "allow"), "yes", "utf8");
    const resumed = runCli(["--session-id", "session-a", "--resume-run-id", sourceRunId], env);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const resumedResult = terminalJson(resumed.stdout);
    assert.equal(resumedResult.resumedFromRunId, sourceRunId);
    assert.equal(resumedResult.resumedPhaseCount, 1);
    assert.equal(resumedResult.chainId, checkpoint.chainId);
    assert.equal(resumedResult.rootRunId, sourceRunId);
    assert.equal(resumedResult.parentRunId, sourceRunId);
    assert.equal(resumedResult.chainStep, 1);
    assert.equal(readFileSync(join(temp, "seed-count"), "utf8"), "1", "the completed seed phase must not execute twice");
    assert.equal(readFileSync(join(temp, "continue-count"), "utf8"), "1");

    const result = JSON.parse(readFileSync(join(store, "artifacts", resumedResult.runId, "workflow-result.json"), "utf8"));
    assert.equal(result.outputs.seed, "seed-output");
    assert.equal(result.outputs.continue, "seed-output-continued");
    assert.equal(result.outputs.report, "seed-output-continued");
    assert.deepEqual(result.results.seed, { resumed: true, sourceRunId });
    const resumedCheckpoint = JSON.parse(readFileSync(join(store, "artifacts", resumedResult.runId, "workflow-checkpoint.json"), "utf8"));
    assert.deepEqual(resumedCheckpoint.completed.map((entry) => entry.name), ["seed", "continue", "report"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("structured resume rejects repeated specs and fails closed on output tampering", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-structured-resume-tamper-"));
  const store = join(temp, "store");
  const specPath = join(temp, "workflow.json");
  const spec = {
    name: "resume-integrity",
    permissions: "rwx",
    phases: [{ type: "shell", name: "only", command: "printf original" }],
  };
  writeFileSync(specPath, JSON.stringify(spec), "utf8");
  const env = { PI_THREAD_PHASE_STORE_DIR: store };

  try {
    const source = runCli(["--spec-file", specPath, "--cwd", temp], env);
    assert.equal(source.status, 0, source.stderr || source.stdout);
    const sourceRunId = terminalJson(source.stdout).runId;

    const chainLimited = runCli(["--resume-run-id", sourceRunId], { ...env, PI_DYNAMIC_WORKFLOW_MAX_CHAIN_RUNS: "1" });
    assert.equal(chainLimited.status, 1);
    assert.match(chainLimited.stderr, /chain reached the 1-run limit/);

    const repeatedSpec = runCli(["--spec-file", specPath, "--cwd", temp, "--resume-run-id", sourceRunId], env);
    assert.equal(repeatedSpec.status, 1);
    assert.match(repeatedSpec.stderr, /resumeRunId must be used without structured spec input/);

    const checkpoint = JSON.parse(readFileSync(join(store, "artifacts", sourceRunId, "workflow-checkpoint.json"), "utf8"));
    writeFileSync(join(store, "artifacts", sourceRunId, checkpoint.completed[0].outputFile), "tampered", "utf8");
    const tampered = runCli(["--resume-run-id", sourceRunId], env);
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /failed integrity validation/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
