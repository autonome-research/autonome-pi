import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

function spawnCli(args, env) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
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
    child.once("close", (status, signal) => resolveCompletion({ status, signal, stdout, stderr }));
  });
  return { child, completion };
}

async function waitFor(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(message);
}

test("a definitive ENOENT launch failure leaves a resumable process journal", { skip: process.platform === "win32" }, () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-resume-no-child-"));
  try {
    const store = join(temp, "store");
    const executable = join(temp, "fake-pi");
    const specPath = join(temp, "workflow.json");
    writeFileSync(specPath, JSON.stringify({
      name: "resume-unspawned", permissions: "r",
      phases: [{ type: "agent", name: "agent", prompt: "Return recovered" }],
    }));
    const env = { PI_THREAD_PHASE_STORE_DIR: store, PI_DYNAMIC_WORKFLOW_PI_BIN: executable };
    const first = runCli(["--spec-file", specPath, "--cwd", temp, "--session-id", "no-child-session"], env);
    assert.equal(first.status, 1, first.stderr || first.stdout);
    const sourceRunId = terminalJson(first.stdout).runId;
    const sourceDir = join(store, "artifacts", sourceRunId);
    const failed = JSON.parse(readFileSync(join(sourceDir, "workflow-result.json"), "utf8"));
    assert.match(failed.error.message, /ENOENT/);
    const journal = JSON.parse(readFileSync(join(sourceDir, "workflow-processes.json"), "utf8"));
    assert.deepEqual(journal.groups, [], "a known failed launch must not leave unresolved intent");
    assert.equal(journal.hasSubprocesses, false);
    writeFileSync(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"recovered"}]}}));\n', { mode: 0o700 });
    const resumed = runCli(["--session-id", "no-child-session", "--resume-run-id", sourceRunId], env);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    assert.equal(terminalJson(resumed.stdout).resumedFromRunId, sourceRunId);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

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
    assert.equal(checkpoint.schema, "pi-dynamic-workflow-checkpoint/v2");
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

for (const largeLog of [false, true]) test(`checkpointed crashed source resumes once while live and competing resumes are rejected (${largeLog ? "large" : "small"} log)`, { skip: process.platform === "win32" && "POSIX crash signaling is required" }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-structured-resume-crash-"));
  const store = join(temp, "store");
  const specPath = join(temp, "workflow.json");
  const quote = (value) => JSON.stringify(value);
  const blockingScript = [
    "const fs=require('fs')",
    "if(fs.existsSync('allow')){fs.appendFileSync('continue-count','1');process.stdout.write('continued');process.exit(0)}",
    "fs.writeFileSync('phase-two-ready',String(process.pid))",
    "setInterval(()=>{},1000)",
  ].join(";");
  const spec = {
    name: "resume-crashed-runner",
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
        command: `exec ${quote(process.execPath)} -e ${quote(blockingScript)}`,
      },
    ],
  };
  writeFileSync(specPath, JSON.stringify(spec), "utf8");
  const env = { PI_THREAD_PHASE_STORE_DIR: store };
  const source = spawnCli(["--spec-file", specPath, "--cwd", temp, "--session-id", "crash-session"], env);
  let blockingPid;

  try {
    await waitFor(() => existsSync(join(temp, "phase-two-ready")), "source did not checkpoint before blocking");
    blockingPid = Number(readFileSync(join(temp, "phase-two-ready"), "utf8"));
    const runsDir = join(store, "runs");
    await waitFor(() => existsSync(runsDir), "source run store was not created");
    const runFiles = readdirSync(runsDir);
    const sourceRunId = runFiles.find((name) => name.endsWith(".jsonl"))?.replace(/\.jsonl$/, "");
    assert.ok(sourceRunId, "source run id was not persisted");
    const checkpoint = JSON.parse(readFileSync(join(store, "artifacts", sourceRunId, "workflow-checkpoint.json"), "utf8"));
    assert.deepEqual(checkpoint.completed.map((entry) => entry.name), ["seed"]);

    const liveResume = runCli(["--session-id", "crash-session", "--resume-run-id", sourceRunId], env);
    assert.equal(liveResume.status, 1);
    assert.match(liveResume.stderr, /source run is still running or its runner state is unknown/);

    // An error event alone projects as failed, but cannot prove terminality.
    // An empty journal must not override the still-live authoritative owner.
    const liveRunFile = join(store, "runs", `${sourceRunId}.jsonl`);
    const journalFile = join(store, "artifacts", sourceRunId, "workflow-processes.json");
    const beforeError = readFileSync(liveRunFile, "utf8");
    const originalJournal = readFileSync(journalFile, "utf8");
    const errorLine = JSON.stringify({
      runId: sourceRunId, workflow: spec.name, eventId: "nonterminal-error",
      type: "error", timestamp: new Date().toISOString(), error: { message: "not terminal yet" },
    }) + "\n";
    appendFileSync(liveRunFile, errorLine);
    writeFileSync(journalFile, JSON.stringify({ ...JSON.parse(originalJournal), groups: [] }));
    const inferredFailure = runCli(["--session-id", "crash-session", "--resume-run-id", sourceRunId], env);
    assert.equal(inferredFailure.status, 1);
    assert.match(inferredFailure.stderr, /source run is still running or its runner state is unknown/);
    assert.equal(existsSync(join(store, "chains", "successors", `${sourceRunId}.json`)), false);
    writeFileSync(journalFile, originalJournal);
    writeFileSync(liveRunFile, beforeError);

    source.child.kill("SIGKILL");
    const crashed = await source.completion;
    assert.equal(crashed.signal, "SIGKILL");

    const runFile = join(store, "runs", `${sourceRunId}.jsonl`);
    const sidecarFile = join(store, "runs", `${sourceRunId}.start.json`);
    const originalRunLog = readFileSync(runFile, "utf8");
    const originalSidecar = readFileSync(sidecarFile, "utf8");
    const legacyEvents = (originalRunLog + errorLine).trimEnd().split("\n").map(JSON.parse);
    delete legacyEvents.find((event) => event.type === "workflow_start").metadata.processJournalVersion;
    const legacySidecar = JSON.parse(originalSidecar);
    delete legacySidecar.metadata.processJournalVersion;
    writeFileSync(runFile, `${legacyEvents.map(JSON.stringify).join("\n")}\n`);
    writeFileSync(sidecarFile, JSON.stringify(legacySidecar));
    const legacyResume = runCli(["--session-id", "crash-session", "--resume-run-id", sourceRunId], env);
    assert.equal(legacyResume.status, 1);
    assert.match(legacyResume.stderr, /subprocess ownership is unknown for a legacy nonterminal source/);
    assert.equal(existsSync(join(store, "chains", "successors", `${sourceRunId}.json`)), false);
    writeFileSync(runFile, originalRunLog + errorLine);
    writeFileSync(sidecarFile, originalSidecar);
    if (largeLog) {
      // Leave the authoritative start intact, but push it outside the 8 MiB
      // bounded tail. Restore must recover the PID and recompute dead-owner proof.
      const recent = JSON.stringify({
        schema: legacyEvents[0].schema, runId: sourceRunId, workflow: spec.name,
        eventId: "large-crash-tail", type: "phase_event", phase: "continue",
        timestamp: new Date().toISOString(), status: "running",
      });
      // Exactly 4096 bytes per valid record fills the retention budget; an
      // oversized sparse line would be skipped and leave the start readable.
      const record = recent + " ".repeat(4096 - Buffer.byteLength(recent)) + "\n";
      appendFileSync(runFile, record.repeat(2049));
    }

    const unsafeResume = runCli(["--session-id", "crash-session", "--resume-run-id", sourceRunId], env);
    assert.equal(unsafeResume.status, 1);
    assert.match(unsafeResume.stderr, /subprocess group .* is still running or its state is unknown/);
    process.kill(-blockingPid, "SIGKILL");
    await waitFor(() => {
      try { process.kill(-blockingPid, 0); return false; }
      catch (error) { return error.code === "ESRCH"; }
    }, "orphaned subprocess group did not exit");
    blockingPid = undefined;
    writeFileSync(join(temp, "allow"), "yes", "utf8");

    const attempts = [
      spawnCli(["--session-id", "crash-session", "--resume-run-id", sourceRunId], env),
      spawnCli(["--session-id", "crash-session", "--resume-run-id", sourceRunId], env),
    ];
    const settled = await Promise.all(attempts.map((attempt) => attempt.completion));
    const successes = settled.filter((result) => result.status === 0);
    const rejected = settled.filter((result) => result.status !== 0);
    assert.equal(successes.length, 1, JSON.stringify(settled));
    assert.equal(rejected.length, 1, JSON.stringify(settled));
    assert.match(rejected[0].stderr, /already has (?:successor|a pending successor)/);
    const resumedResult = terminalJson(successes[0].stdout);
    assert.equal(resumedResult.resumedFromRunId, sourceRunId);
    assert.equal(readFileSync(join(temp, "seed-count"), "utf8"), "1", "checkpointed work must not rerun after a crash");
    assert.equal(readFileSync(join(temp, "continue-count"), "utf8"), "1");

    const repeated = runCli(["--session-id", "crash-session", "--resume-run-id", sourceRunId], env);
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /already has successor/);
  } finally {
    if (source.child.exitCode === null && source.child.signalCode === null) source.child.kill("SIGKILL");
    await source.completion.catch(() => {});
    if (Number.isInteger(blockingPid)) {
      try { process.kill(blockingPid, "SIGKILL"); } catch { /* already exited with its owner */ }
    }
    rmSync(temp, { recursive: true, force: true });
  }
});

test("terminal failed runs cannot resume over surviving redirected-stdio grandchildren", { skip: process.platform === "win32" }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-terminal-survivor-"));
  const store = join(temp, "store");
  const specPath = join(temp, "workflow.json");
  const script = [
    "const fs=require('fs')",
    "if(fs.existsSync('allow')){process.stdout.write('recovered');process.exit(0)}",
    "const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
    "child.unref()",
    "fs.writeFileSync('survivor',JSON.stringify({pid:child.pid,group:process.pid}))",
    "process.exit(1)",
  ].join(";");
  writeFileSync(specPath, JSON.stringify({ name: "terminal-survivor", permissions: "rwx", phases: [
    { type: "artifact", name: "seed", content: "checkpointed" },
    { type: "shell", name: "fail", command: `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` },
  ] }));
  const env = { PI_THREAD_PHASE_STORE_DIR: store };
  let group;
  try {
    const source = runCli(["--spec-file", specPath, "--cwd", temp], env);
    assert.equal(source.status, 1);
    const runId = terminalJson(source.stdout).runId;
    group = JSON.parse(readFileSync(join(temp, "survivor"), "utf8")).group;
    const rejected = runCli(["--resume-run-id", runId], env);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /subprocess group .* is still running or its state is unknown/);
    process.kill(-group, "SIGKILL");
    await waitFor(() => {
      try { process.kill(-group, 0); return false; }
      catch (error) { return error.code === "ESRCH"; }
    }, "surviving group did not exit");
    group = undefined;
    writeFileSync(join(temp, "allow"), "yes");
    const resumed = runCli(["--resume-run-id", runId], env);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  } finally {
    if (group) { try { process.kill(-group, "SIGKILL"); } catch { /* already exited */ } }
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI resume rejects process journal marker tampering, unknown versions, and cancellation", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-structured-resume-version-"));
  const store = join(temp, "store");
  const specPath = join(temp, "workflow.json");
  writeFileSync(specPath, JSON.stringify({
    name: "resume-journal-version",
    permissions: "rwx",
    phases: [{ type: "shell", name: "only", command: "printf original" }],
  }), "utf8");
  const env = { PI_THREAD_PHASE_STORE_DIR: store };

  try {
    const source = runCli(["--spec-file", specPath, "--cwd", temp], env);
    assert.equal(source.status, 0, source.stderr || source.stdout);
    const sourceRunId = terminalJson(source.stdout).runId;
    const runFile = join(store, "runs", `${sourceRunId}.jsonl`);
    const sidecarFile = join(store, "runs", `${sourceRunId}.start.json`);
    const originalRunLog = readFileSync(runFile, "utf8");
    const originalSidecar = JSON.parse(readFileSync(sidecarFile, "utf8"));
    assert.equal(originalSidecar.metadata.processJournalVersion, 1);

    const missingMarkerEvents = originalRunLog.trimEnd().split("\n").map(JSON.parse);
    delete missingMarkerEvents.find((event) => event.type === "workflow_start").metadata.processJournalVersion;
    writeFileSync(runFile, `${missingMarkerEvents.map(JSON.stringify).join("\n")}\n`);
    const missingMarker = runCli(["--resume-run-id", sourceRunId], env);
    assert.equal(missingMarker.status, 1);
    assert.match(missingMarker.stderr, /authoritative source ownership is unknown/);
    assert.equal(existsSync(join(store, "chains", "successors", `${sourceRunId}.json`)), false);

    const unknownVersionEvents = originalRunLog.trimEnd().split("\n").map(JSON.parse);
    unknownVersionEvents.find((event) => event.type === "workflow_start").metadata.processJournalVersion = 2;
    const unknownVersionSidecar = structuredClone(originalSidecar);
    unknownVersionSidecar.metadata.processJournalVersion = 2;
    writeFileSync(runFile, `${unknownVersionEvents.map(JSON.stringify).join("\n")}\n`);
    writeFileSync(sidecarFile, JSON.stringify(unknownVersionSidecar));
    const unknownVersion = runCli(["--resume-run-id", sourceRunId], env);
    assert.equal(unknownVersion.status, 1);
    assert.match(unknownVersion.stderr, /unsupported process journal version 2/);
    assert.equal(existsSync(join(store, "chains", "successors", `${sourceRunId}.json`)), false);

    const cancelledEvents = originalRunLog.trimEnd().split("\n").map(JSON.parse);
    cancelledEvents.find((event) => event.type === "workflow_end").status = "cancelled";
    writeFileSync(runFile, `${cancelledEvents.map(JSON.stringify).join("\n")}\n`);
    writeFileSync(sidecarFile, JSON.stringify(originalSidecar));
    const cancelled = runCli(["--resume-run-id", sourceRunId], env);
    assert.equal(cancelled.status, 1);
    assert.match(cancelled.stderr, /user-cancelled workflow cannot be resumed/);
    assert.equal(existsSync(join(store, "chains", "successors", `${sourceRunId}.json`)), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("v2 resume rejects saved-template provenance tampering before reserving a successor", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-resume-template-provenance-"));
  const store = join(temp, "store");
  const specPath = join(temp, "workflow.json");
  writeFileSync(specPath, JSON.stringify({
    name: "template-provenance",
    permissions: "r",
    phases: [{ type: "artifact", name: "result", content: "done" }],
  }));
  const env = { PI_THREAD_PHASE_STORE_DIR: store };

  try {
    const trusted = runCli(["--spec-file", specPath, "--cwd", temp, "--saved-template", "trusted-template"], env);
    assert.equal(trusted.status, 0, trusted.stderr || trusted.stdout);
    const trustedRunId = terminalJson(trusted.stdout).runId;
    const trustedDir = join(store, "artifacts", trustedRunId);
    const checkpointFile = join(trustedDir, "workflow-checkpoint.json");
    const originalCheckpoint = JSON.parse(readFileSync(checkpointFile, "utf8"));
    const sidecar = JSON.parse(readFileSync(join(store, "runs", `${trustedRunId}.start.json`), "utf8"));
    assert.equal(sidecar.metadata.savedTemplate, "trusted-template");

    for (const [label, mutate, pattern] of [
      ["changed", (checkpoint) => { checkpoint.savedTemplate = "other-template"; }, /does not match authoritative/],
      ["removed", (checkpoint) => { delete checkpoint.savedTemplate; }, /does not match authoritative/],
      ["invalid type", (checkpoint) => { checkpoint.savedTemplate = { name: "trusted-template" }; }, /must be a safe saved-template name/],
    ]) {
      const checkpoint = structuredClone(originalCheckpoint);
      mutate(checkpoint);
      writeFileSync(checkpointFile, JSON.stringify(checkpoint));
      const rejected = runCli(["--resume-run-id", trustedRunId], env);
      assert.equal(rejected.status, 1, `${label}: ${rejected.stderr || rejected.stdout}`);
      assert.match(rejected.stderr, pattern);
      assert.equal(existsSync(join(store, "chains", "successors", `${trustedRunId}.json`)), false, `${label} must not reserve a successor`);
    }
    writeFileSync(checkpointFile, JSON.stringify(originalCheckpoint));

    const storedSpecFile = join(trustedDir, "workflow-spec.json");
    const originalStoredSpec = JSON.parse(readFileSync(storedSpecFile, "utf8"));
    writeFileSync(storedSpecFile, JSON.stringify({ ...originalStoredSpec, schema: "pi-dynamic-workflow/v1" }));
    const v2CheckpointV1Spec = runCli(["--resume-run-id", trustedRunId], env);
    assert.equal(v2CheckpointV1Spec.status, 1);
    assert.match(v2CheckpointV1Spec.stderr, /unsupported spec.schema/);
    assert.equal(existsSync(join(store, "chains", "successors", `${trustedRunId}.json`)), false);
    writeFileSync(storedSpecFile, JSON.stringify(originalStoredSpec));

    writeFileSync(checkpointFile, JSON.stringify({ ...originalCheckpoint, schema: "pi-dynamic-workflow-checkpoint/v1" }));
    const v1CheckpointV2Spec = runCli(["--resume-run-id", trustedRunId], env);
    assert.equal(v1CheckpointV2Spec.status, 1);
    assert.match(v1CheckpointV2Spec.stderr, /unsupported spec.schema/);
    assert.equal(existsSync(join(store, "chains", "successors", `${trustedRunId}.json`)), false);
    writeFileSync(checkpointFile, JSON.stringify(originalCheckpoint));

    const runFile = join(store, "runs", `${trustedRunId}.jsonl`);
    const originalLog = readFileSync(runFile, "utf8");
    const rewritten = originalLog.trimEnd().split("\n").map(JSON.parse);
    rewritten.find((event) => event.type === "workflow_start").metadata.savedTemplate = "rewritten-template";
    writeFileSync(runFile, `${rewritten.map(JSON.stringify).join("\n")}\n`);
    const rewrittenOwner = runCli(["--resume-run-id", trustedRunId], env);
    assert.equal(rewrittenOwner.status, 1);
    assert.match(rewrittenOwner.stderr, /authoritative source ownership is unknown/);
    assert.equal(existsSync(join(store, "chains", "successors", `${trustedRunId}.json`)), false);
    writeFileSync(runFile, originalLog);

    const plain = runCli(["--spec-file", specPath, "--cwd", temp], env);
    assert.equal(plain.status, 0, plain.stderr || plain.stdout);
    const plainRunId = terminalJson(plain.stdout).runId;
    const plainCheckpointFile = join(store, "artifacts", plainRunId, "workflow-checkpoint.json");
    const added = JSON.parse(readFileSync(plainCheckpointFile, "utf8"));
    added.savedTemplate = "added-template";
    writeFileSync(plainCheckpointFile, JSON.stringify(added));
    const addedResult = runCli(["--resume-run-id", plainRunId], env);
    assert.equal(addedResult.status, 1);
    assert.match(addedResult.stderr, /does not match authoritative/);
    assert.equal(existsSync(join(store, "chains", "successors", `${plainRunId}.json`)), false, "adding provenance must not reserve a successor");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("structured resume fails closed when authoritative source ownership is unknown", () => {
  const temp = mkdtempSync(join(tmpdir(), "dynamic-structured-resume-unknown-"));
  const store = join(temp, "store");
  const specPath = join(temp, "workflow.json");
  writeFileSync(specPath, JSON.stringify({
    name: "resume-unknown-owner",
    permissions: "rwx",
    phases: [{ type: "shell", name: "only", command: "printf original" }],
  }), "utf8");
  const env = { PI_THREAD_PHASE_STORE_DIR: store };

  try {
    const source = runCli(["--spec-file", specPath, "--cwd", temp], env);
    assert.equal(source.status, 0, source.stderr || source.stdout);
    const sourceRunId = terminalJson(source.stdout).runId;
    rmSync(join(store, "runs", `${sourceRunId}.jsonl`));

    const resumed = runCli(["--resume-run-id", sourceRunId], env);
    assert.equal(resumed.status, 1);
    assert.match(resumed.stderr, /authoritative source ownership is unknown/);
    assert.equal(existsSync(join(store, "chains", "successors", `${sourceRunId}.json`)), false, "unknown sources must not reserve a successor");
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
