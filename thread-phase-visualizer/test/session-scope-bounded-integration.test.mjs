import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-bounded-session-test-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
process.on("exit", () => rmSync(storeDir, { recursive: true, force: true }));
const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);

const store = await import("../lib/store.mjs");
const { canInspectRun } = await import("../lib/session-scope.mjs");
const { ThreadPhaseMonitorComponent } = await import("../components/monitor.ts");
const { default: registerVisualizer } = await import("../index.ts");

const theme = {
  fg(_color, value) { return String(value); },
  bold(value) { return String(value); },
};

function event(runId, workflow, cwd, sequence, overrides = {}) {
  return {
    schema: store.SCHEMA_VERSION,
    eventId: `${runId}-${sequence}`,
    timestamp: new Date(Date.UTC(2026, 0, 1) + sequence * 1000).toISOString(),
    runId,
    workflow,
    cwd,
    type: "phase_event",
    status: "running",
    message: `event ${sequence}`,
    ...overrides,
  };
}

function writeLargeOwnedFixture(cwd, remoteCwd) {
  store.ensureStore();
  const definitions = [
    {
      runId: "bounded-own",
      workflow: "Bounded Own",
      cwd,
      metadata: { sessionId: "session-own", launchSource: "background", cwdAtLaunch: cwd },
    },
    {
      runId: "bounded-other",
      workflow: "Bounded Other",
      cwd,
      metadata: { sessionId: "session-other", launchSource: "background", cwdAtLaunch: cwd },
    },
    {
      runId: "bounded-local",
      workflow: "Bounded Local",
      cwd,
      // Legacy relative owner cwd has no reliable origin. The absolute event
      // cwd remains authoritative and should make this running run local.
      metadata: { cwdAtLaunch: "../remote" },
    },
    {
      runId: "bounded-remote",
      workflow: "Bounded Remote",
      cwd: remoteCwd,
      // Recovered events before workflow_start disagree with the launch cwd.
      // The authoritative start must keep this run out of the local scope.
      prefixCwd: cwd,
      // Resolving this relative legacy metadata against run.cwd would point at
      // the local symlink and leak the run. Scoping must keep the absolute cwd.
      metadata: { cwdAtLaunch: "../repo-link", cwd: "../repo-link" },
    },
    {
      runId: "bounded-relative-primary",
      workflow: "Bounded Relative Primary",
      cwd: "../repo-link",
      // A present but unresolvable primary cwd must fail closed instead of
      // falling through to otherwise local absolute legacy metadata.
      metadata: { cwdAtLaunch: cwd, cwd },
    },
    {
      runId: "bounded-completed",
      workflow: "Bounded Completed",
      cwd,
    },
    {
      runId: "bounded-oversized-owner",
      workflow: "Bounded Oversized Owner",
      cwd,
      metadata: { sessionId: "session-other" },
      recoveryFailure: "oversized",
    },
    {
      runId: "bounded-missing-owner",
      workflow: "Bounded Missing Owner",
      cwd,
      metadata: { sessionId: "session-other" },
      recoveryFailure: "missing",
    },
    {
      runId: "bounded-budget-owner",
      workflow: "Bounded Budget Owner",
      cwd,
      metadata: { sessionId: "session-other" },
      recoveryFailure: "record-budget",
    },
  ];
  const runLines = new Map();
  const indexLines = [];
  for (const definition of definitions) {
    const start = event(definition.runId, definition.workflow, definition.cwd, 0, {
      type: "workflow_start",
      metadata: definition.metadata,
    });
    const line = `${JSON.stringify(start)}\n`;
    // Recovered/public-emitter logs can contain records before workflow_start.
    // Keep the authoritative owner beyond the old 32-record lookup window and
    // include corruption to prove metadata recovery remains bounded and robust.
    const runPrefix = ["{corrupt-prefix}\n"];
    for (let prefix = 0; prefix < 40; prefix++) {
      runPrefix.push(`${JSON.stringify(event(definition.runId, definition.workflow, definition.prefixCwd || definition.cwd, -(prefix + 1)))}\n`);
    }
    if (definition.recoveryFailure === "oversized") {
      const oversizedStart = { ...start, metadata: { ...start.metadata, padding: "x".repeat(600 * 1024) } };
      runLines.set(definition.runId, [`${JSON.stringify(oversizedStart)}\n`]);
    } else if (definition.recoveryFailure === "missing") {
      runLines.set(definition.runId, []);
    } else if (definition.recoveryFailure === "record-budget") {
      runLines.set(definition.runId, ["{}\n".repeat(1024), line]);
    } else {
      runLines.set(definition.runId, [...runPrefix, line]);
    }
    // The index still records that these runs were session-owned. Once that
    // start falls outside the bounded index tail, only run-file recovery may
    // establish ownership; an inconclusive recovery must never reinterpret the
    // recent local events as globally visible unscoped runs.
    indexLines.push(line);
  }

  // The monitor/tool index window is 8000 lines, so all workflow_start events
  // are deliberately outside it while recent events from every run remain.
  for (let sequence = 1; sequence <= 8001; sequence++) {
    const definition = definitions[sequence % definitions.length];
    const line = `${JSON.stringify(event(definition.runId, definition.workflow, definition.cwd, sequence))}\n`;
    runLines.get(definition.runId).push(line);
    indexLines.push(line);
  }

  const completed = definitions.find((definition) => definition.runId === "bounded-completed");
  const completedLine = `${JSON.stringify(event(completed.runId, completed.workflow, completed.cwd, 8002, {
    type: "workflow_end",
    status: "success",
    message: "completed",
  }))}\n`;
  runLines.get(completed.runId).push(completedLine);
  indexLines.push(completedLine);

  for (const [runId, lines] of runLines) writeFileSync(store.runFileFor(runId), lines.join(""));
  for (let offset = 0; offset < indexLines.length; offset += 500) {
    appendFileSync(store.INDEX_FILE, indexLines.slice(offset, offset + 500).join(""));
  }
}

test("workflow_start ownership is immutable during projection", () => {
  const cwd = join(storeDir, "immutable-repo");
  const summary = store.projectRun([
    event("immutable-run", "Immutable Owner", cwd, 0, {
      type: "workflow_start",
      metadata: { sessionId: "session-original" },
    }),
    event("immutable-run", "Immutable Owner", cwd, 1, {
      metadata: { sessionId: "session-rewritten" },
    }),
  ]);
  assert.equal(summary.metadata.sessionId, "session-original");
});

test("bounded workflow_start lookup preserves omitted cwd provenance for metadata fallback", (t) => {
  store.ensureStore();
  const root = mkdtempSync(join(storeDir, "omitted-cwd-"));
  const local = join(root, "repo");
  const localLink = join(root, "repo-link");
  mkdirSync(local);
  symlinkSync(local, localLink, "dir");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const writeStart = (runId, overrides) => {
    const start = event(runId, "Legacy Local", undefined, 0, {
      type: "workflow_start",
      metadata: { cwdAtLaunch: localLink },
      ...overrides,
    });
    const line = `${JSON.stringify(start)}\n`;
    writeFileSync(store.runFileFor(runId), line);
    appendFileSync(store.INDEX_FILE, line);
    return store.getRunSummary(runId);
  };

  const omitted = writeStart("omitted-start-cwd", {});
  assert.equal(Object.prototype.hasOwnProperty.call(omitted, "cwd"), false);
  assert.equal(omitted.workflowStartCwdPresent, false);
  assert.equal(canInspectRun(omitted, undefined, local), true, "absolute metadata cwd is canonicalized when start cwd was omitted");

  for (const [runId, cwd] of [
    ["null-start-cwd", null],
    ["empty-start-cwd", ""],
    ["blank-start-cwd", "   "],
  ]) {
    const blank = writeStart(runId, { cwd });
    assert.equal(Object.prototype.hasOwnProperty.call(blank, "cwd"), true);
    assert.equal(blank.workflowStartCwdPresent, true);
    assert.equal(canInspectRun(blank, undefined, local), false, "a present invalid start cwd remains authoritative and fails closed");
  }

  for (const [runId, cwd] of [["relative-start-cwd", "repo"], ["malformed-start-cwd", 42]]) {
    const invalid = writeStart(runId, { cwd });
    assert.equal(canInspectRun(invalid, undefined, local), false, "a nonblank relative or malformed start cwd remains fail-closed");
  }

  const foreign = writeStart("blank-start-foreign-owner", { cwd: " ", metadata: { sessionId: "session-other", cwdAtLaunch: localLink } });
  assert.equal(canInspectRun(foreign, "session-own", local), false, "invalid cwd handling does not weaken session ownership");
  assert.equal(canInspectRun(foreign, "session-other", local), true);
});

test("bounded workflow_start lookup preserves authoritative launch scope and fails closed when unknown", async () => {
  const local = join(storeDir, "scope-local");
  const remote = join(storeDir, "scope-remote");
  const remoteLink = join(storeDir, "scope-remote-link");
  mkdirSync(local);
  mkdirSync(remote);
  symlinkSync(remote, remoteLink, "dir");
  store.ensureStore();

  const cases = [
    { runId: "scope-missing", prefix: "", writeRun: false },
    { runId: "scope-corrupt", prefix: "{not-json}\n", writeRun: true },
    // A start after an oversized prefix is outside the fixed byte budget. It
    // must remain unknown rather than inheriting the local cwd from the tail.
    { runId: "scope-oversized", prefix: `${"x".repeat(600 * 1024)}\n`, writeRun: true, startCwd: local },
    // The record ceiling is independent of the byte ceiling. A later start in
    // the bounded index/run tail must not become authoritative after recovery
    // cannot reach the original start.
    {
      runId: "scope-tail-start",
      prefix: "{}\n".repeat(1024),
      writeRun: true,
      startCwd: local,
      recentOverrides: { type: "workflow_start" },
    },
  ];
  for (const definition of cases) {
    const recent = event(definition.runId, definition.runId, local, 9000, {
      metadata: { sessionId: "session-own", cwdAtLaunch: local },
      ...definition.recentOverrides,
    });
    appendFileSync(store.INDEX_FILE, `${JSON.stringify(recent)}\n`);
    if (definition.writeRun) {
      const start = event(definition.runId, definition.runId, definition.startCwd || local, 0, {
        type: "workflow_start",
        metadata: { sessionId: "session-own", cwdAtLaunch: definition.startCwd || local },
      });
      writeFileSync(store.runFileFor(definition.runId), `${definition.prefix}${definition.startCwd ? `${JSON.stringify(start)}\n` : ""}${JSON.stringify(recent)}\n`);
    }
    const summary = store.latestRunSummaries({ limit: 20, readLimit: 20 }).find((run) => run.runId === definition.runId);
    assert.equal(summary.workflowStartResolved, false, definition.runId);
    assert.equal(summary.cwd, undefined, definition.runId);
    assert.equal(summary.metadata, undefined, definition.runId);
    assert.equal(canInspectRun(summary, "session-own", local), false, definition.runId);
  }

  const authoritative = "scope-authoritative-cwd";
  const beforeStart = event(authoritative, authoritative, local, -1);
  const start = event(authoritative, authoritative, remoteLink, 0, {
    type: "workflow_start",
    metadata: { cwdAtLaunch: remoteLink },
  });
  const recent = event(authoritative, authoritative, local, 9001);
  writeFileSync(store.runFileFor(authoritative), `{corrupt-before-start}\n${JSON.stringify(beforeStart)}\n${JSON.stringify(start)}\n${JSON.stringify(recent)}\n`);
  appendFileSync(store.INDEX_FILE, `${JSON.stringify(recent)}\n`);

  const fullSummary = store.projectRun([beforeStart, start, recent]);
  assert.equal(fullSummary.cwd, realpathSync(remote), "full projection uses and canonicalizes workflow_start rather than an earlier recovered event");

  const summary = store.latestRunSummaries({ limit: 20, readLimit: 20 }).find((run) => run.runId === authoritative);
  assert.equal(summary.workflowStartResolved, true);
  assert.equal(summary.cwd, realpathSync(remote), "bounded projection restores normalized workflow_start cwd over tail event cwd");
  assert.equal(summary.metadata.cwdAtLaunch, remoteLink);
  assert.equal(canInspectRun(summary, undefined, local), false);
  assert.equal(canInspectRun(summary, undefined, remote), true);

  const monitor = new ThreadPhaseMonitorComponent(local, undefined, theme, () => {}, () => {}, () => {});
  assert.doesNotMatch(monitor.render(100).join("\n"), /scope-authoritative-cwd/, "monitor hides a remote unscoped run despite local events before and after its start");

  let tool;
  registerVisualizer({
    registerMessageRenderer() {},
    registerTool(value) { tool = value; },
    registerShortcut() {},
    on() {},
  });
  const result = await tool.execute("call", { limit: 100 }, undefined, undefined, {
    cwd: local,
    sessionManager: { getSessionId: () => "scope-session" },
  });
  assert.equal(result.details.runs.some((run) => run.runId === authoritative), false, "tool hides a remote unscoped run despite local events before and after its start");
});

test("ownership cache invalidates on in-place rewrites and budget exhaustion stays unknown", () => {
  const local = join(storeDir, "cache-scope-local");
  mkdirSync(local, { recursive: true });
  store.ensureStore();
  const runId = "scope-cache-rewrite";
  const recent = event(runId, "Cache Rewrite", local, 3);
  appendFileSync(store.INDEX_FILE, `${JSON.stringify(recent)}\n`);

  const startFor = (sessionId, sequence) => event(runId, "Cache Rewrite", local, sequence, {
    type: "workflow_start",
    metadata: { sessionId, cwdAtLaunch: local },
  });
  writeFileSync(store.runFileFor(runId), `${JSON.stringify(startFor("session-first", 0))}\n${JSON.stringify(recent)}\n`);
  let summary = store.latestRunSummaries({ limit: 20, readLimit: 20 }).find((run) => run.runId === runId);
  assert.equal(summary.workflowStartResolved, true);
  assert.equal(summary.metadata.sessionId, "session-first");

  // writeFileSync truncates and rewrites the same inode. A cache keyed only by
  // inode or monotonic size would continue exposing the first session owner.
  writeFileSync(store.runFileFor(runId), `${JSON.stringify(startFor("session-other", 0))}\n${JSON.stringify(recent)}\n`);
  summary = store.latestRunSummaries({ limit: 20, readLimit: 20 }).find((run) => run.runId === runId);
  assert.equal(summary.workflowStartResolved, true);
  assert.equal(summary.metadata.sessionId, "session-other");
  assert.equal(canInspectRun(summary, "session-first", local), false);
  assert.equal(canInspectRun(summary, "session-other", local), true);

  // A later start beyond the complete-record budget is not evidence that the
  // run became unscoped. It must replace the cached owner with unknown state.
  writeFileSync(store.runFileFor(runId), `${"{}\n".repeat(1024)}${JSON.stringify(startFor("session-first", 2))}\n${JSON.stringify(recent)}\n`);
  summary = store.latestRunSummaries({ limit: 20, readLimit: 20 }).find((run) => run.runId === runId);
  assert.equal(summary.workflowStartResolved, false);
  assert.equal(summary.metadata, undefined);
  assert.equal(summary.cwd, undefined);
  assert.equal(canInspectRun(summary, "session-first", local), false);
  assert.equal(canInspectRun(summary, "session-other", local), false);
});

test("session-scoped queries fill limits after excluding newer foreign-session candidates", async () => {
  const cwd = join(storeDir, "starvation-repo");
  mkdirSync(cwd, { recursive: true });
  store.ensureStore();

  const appendStart = (runId, workflow, sessionId, sequence) => {
    const start = event(runId, workflow, cwd, sequence, {
      type: "workflow_start",
      timestamp: new Date(Date.UTC(2099, 0, 1) + sequence * 1000).toISOString(),
      metadata: { sessionId, cwdAtLaunch: cwd },
    });
    const line = `${JSON.stringify(start)}\n`;
    writeFileSync(store.runFileFor(runId), line);
    appendFileSync(store.INDEX_FILE, line);
  };

  // Matching candidates are older than both of the old global pre-filter caps:
  // 150 for the monitor and 200 for the tool list.
  for (let index = 0; index < 5; index++) appendStart(`starvation-own-${index}`, `Starvation Own ${index}`, "session-own", index);
  for (let index = 0; index < 205; index++) appendStart(`starvation-foreign-${index}`, `Starvation Foreign ${index}`, "session-other", 100 + index);

  const monitor = new ThreadPhaseMonitorComponent(cwd, "session-own", theme, () => {}, () => {}, () => {}, undefined);
  const monitorText = monitor.render(100).join("\n");
  for (let index = 0; index < 5; index++) assert.match(monitorText, new RegExp(`Starvation Own ${index}`));
  assert.doesNotMatch(monitorText, /Starvation Foreign/);

  let tool;
  registerVisualizer({
    registerMessageRenderer() {},
    registerTool(value) { tool = value; },
    registerShortcut() {},
    on() {},
  });
  const result = await tool.execute("call", { limit: 3 }, undefined, undefined, {
    cwd,
    sessionManager: { getSessionId: () => "session-own" },
  });
  assert.deepEqual(result.details.runs.map((run) => run.runId), [
    "starvation-own-4",
    "starvation-own-3",
    "starvation-own-2",
  ]);
});

test("concurrent workflow starts reserve one immutable compact owner", async () => {
  const cwd = join(storeDir, "start-race-repo");
  mkdirSync(cwd, { recursive: true });
  store.ensureStore();
  const moduleUrl = new URL("../lib/store.mjs", import.meta.url).href;
  const launch = (sessionId) => new Promise((resolve) => {
    const source = `import { createRun } from ${JSON.stringify(moduleUrl)}; try { createRun({ runId: "start-race", workflow: "Start Race", cwd: ${JSON.stringify(cwd)}, trigger: { kind: "test", custom: { value: 1 } }, input: "x".repeat(100000), metadata: { sessionId: ${JSON.stringify(sessionId)}, customOwnerField: "preserved" } }); } catch (error) { console.error(error.message); process.exitCode = 2; }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: storeDir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  const outcomes = await Promise.all([launch("race-session-a"), launch("race-session-b")]);
  assert.deepEqual(outcomes.map((outcome) => outcome.code).sort(), [0, 2]);

  const summary = store.getRunSummary("start-race");
  assert.ok(["race-session-a", "race-session-b"].includes(summary.metadata.sessionId));
  assert.equal(summary.metadata.customOwnerField, "preserved", "full run reads preserve public custom metadata");
  assert.deepEqual(summary.trigger.custom, { value: 1 }, "full run reads preserve arbitrary trigger fields");
  const sidecar = store.runFileFor("start-race").replace(/\.jsonl$/, ".start.json");
  const record = JSON.parse(readFileSync(sidecar, "utf8"));
  assert.equal(record.metadata.sessionId, summary.metadata.sessionId);
  assert.equal(Object.hasOwn(record, "data"), false, "large workflow input is excluded from the sidecar");
  assert.ok(Buffer.byteLength(JSON.stringify(record)) < 16 * 1024);
});

test("an orphan start sidecar is not accepted without its matching committed log event", () => {
  const cwd = join(storeDir, "orphan-sidecar-repo");
  mkdirSync(cwd, { recursive: true });
  const run = store.createRun({
    runId: "orphan-start-sidecar",
    workflow: "Orphan Sidecar",
    cwd,
    metadata: { sessionId: "orphan-owner" },
  });
  rmSync(run.runFile);
  store.phaseEvent(run, "work", { kind: "progress", completed: 1, total: 2 });
  const summary = store.getRunSummary(run.runId);
  assert.equal(summary.workflowStartResolved, false);
  assert.equal(summary.metadata, undefined);
  assert.equal(summary.cwd, undefined);
  let filterCalls = 0;
  const filtered = store.latestRunSummaries({
    limit: 1,
    readLimit: 1,
    filter(candidate) {
      filterCalls++;
      return candidate.runId === run.runId;
    },
  });
  assert.equal(filterCalls, 1);
  assert.equal(filtered[0].runId, run.runId);
  assert.equal(filtered[0].workflowStartResolved, false);
});

test("dead pre-publication sidecar reservations are quarantined and safely retried", () => {
  const cwd = join(storeDir, "dead-sidecar-reservation-repo");
  mkdirSync(cwd, { recursive: true });
  const runId = "dead-sidecar-reservation";
  const first = store.createRun({ runId, workflow: "Dead Reservation", cwd, metadata: { sessionId: "first" } });
  const sidecarPath = first.runFile.replace(/\.jsonl$/, ".start.json");
  writeFileSync(first.runFile, "");
  const orphan = JSON.parse(readFileSync(sidecarPath, "utf8"));
  orphan.reservationPid = 99_999_999;
  orphan.reservationState = "reserved";
  writeFileSync(sidecarPath, JSON.stringify(orphan));
  const retried = store.createRun({ runId, workflow: "Dead Reservation", cwd, metadata: { sessionId: "retry" } });
  assert.equal(store.getRunSummary(retried.runId).metadata.sessionId, "retry");
  const visible = store.latestRunSummaries({
    limit: 1,
    readLimit: 5,
    ownershipFilter: (summary) => canInspectRun(summary, "retry", cwd),
  });
  assert.equal(visible[0].runId, runId);
  assert.ok(readdirSync(join(storeDir, "run-start-quarantine")).some((name) => name.endsWith(`${runId}.start.json`)));
});

test("committed ownership cannot be reclaimed after run-log loss", () => {
  const cwd = join(storeDir, "committed-log-loss-repo");
  mkdirSync(cwd, { recursive: true });
  const runId = "committed-log-loss";
  const run = store.createRun({ runId, workflow: "Committed Log Loss", cwd, metadata: { sessionId: "committed-owner" } });
  rmSync(run.runFile);
  const sidecarPath = run.runFile.replace(/\.jsonl$/, ".start.json");
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  assert.equal(sidecar.reservationState, "committed");
  sidecar.reservationPid = 99_999_999;
  writeFileSync(sidecarPath, JSON.stringify(sidecar));
  assert.throws(
    () => store.createRun({ runId, workflow: "Committed Log Loss", cwd, metadata: { sessionId: "attacker" } }),
    /already has an authoritative workflow_start/,
  );
});

test("sidecar verification rejects security-envelope disagreement", () => {
  const cwd = join(storeDir, "mismatched-sidecar-repo");
  mkdirSync(cwd, { recursive: true });
  const run = store.createRun({
    runId: "mismatched-start-sidecar",
    workflow: "Mismatched Sidecar",
    cwd,
    metadata: { sessionId: "original-owner" },
  });
  const sidecarPath = run.runFile.replace(/\.jsonl$/, ".start.json");
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  sidecar.cwdPresent = false;
  delete sidecar.cwd;
  writeFileSync(sidecarPath, JSON.stringify(sidecar));
  const summary = store.getRunSummary(run.runId);
  assert.equal(summary.workflowStartResolved, false);
  assert.equal(summary.metadata, undefined);
  assert.equal(summary.cwd, undefined);
});

test("replayed starts cannot replace authoritative full metadata", () => {
  const cwd = join(storeDir, "replayed-start-repo");
  mkdirSync(cwd, { recursive: true });
  const run = store.createRun({
    runId: "replayed-start-full-metadata",
    workflow: "Replayed Start",
    cwd,
    trigger: { kind: "test", nested: { source: "original" } },
    metadata: { sessionId: "original-session", customOwnerField: "original" },
  });
  const original = JSON.parse(readFileSync(run.runFile, "utf8").trim());
  const replay = {
    ...original,
    timestamp: "2099-01-01T00:00:00.000Z",
    metadata: { ...original.metadata, customOwnerField: "forged" },
    trigger: { ...original.trigger, nested: { source: "forged" } },
  };
  appendFileSync(run.runFile, `${JSON.stringify(replay)}\n`);
  appendFileSync(join(storeDir, "index.jsonl"), `${JSON.stringify(replay)}\n`);
  const summaries = store.latestRunSummaries({
    limit: 1,
    readLimit: 1,
    filter: (summary) => summary.runId === run.runId,
  });
  assert.equal(summaries[0].metadata.customOwnerField, "original");
  assert.deepEqual(summaries[0].trigger.nested, { source: "original" });
});

test("oversized workflow starts are rejected before reservation or persistence", () => {
  const cwd = join(storeDir, "oversized-start-repo");
  mkdirSync(cwd, { recursive: true });
  const runId = "oversized-workflow-start";
  assert.throws(
    () => store.createRun({ runId, workflow: "Oversized Start", cwd, message: "x".repeat(600_000) }),
    /workflow_start exceeds the 524288-byte verification limit/,
  );
  assert.equal(existsSync(store.runFileFor(runId)), false);
  assert.equal(existsSync(store.runFileFor(runId).replace(/\.jsonl$/, ".start.json")), false);
});

test("public write APIs reject explicit invalid cwd provenance", () => {
  for (const cwd of ["", "   ", null]) {
    assert.throws(
      () => store.createRun({ workflow: "Invalid CWD", cwd }),
      /cwd must be a non-empty path when provided/,
    );
  }
  assert.throws(
    () => store.emit({ runId: "invalid-direct-cwd", workflow: "Invalid Direct CWD", cwd: "" }, { type: "phase_event" }),
    /run\.cwd must be a non-empty path when provided/,
  );
});

test("public filters receive fully restored custom metadata exactly once", () => {
  const cwd = join(storeDir, "public-filter-repo");
  mkdirSync(cwd, { recursive: true });
  const run = store.createRun({
    runId: "public-filter-custom-metadata",
    workflow: "Public Filter",
    cwd,
    trigger: { kind: "test", nested: { retained: true } },
    metadata: { sessionId: "public-filter-session", customOwnerField: "match" },
  });
  store.phaseEvent(run, "work", { kind: "progress", completed: 1, total: 2 });
  let calls = 0;
  const summaries = store.latestRunSummaries({
    limit: 1,
    readLimit: 1,
    filter(summary) {
      calls++;
      assert.equal(summary.trigger.nested.retained, true);
      return summary.metadata.customOwnerField === "match";
    },
  });
  assert.equal(calls, 1);
  assert.equal(summaries[0].runId, run.runId);
  assert.equal(summaries[0].metadata.customOwnerField, "match");
});

test("a truncated run tail cannot consume the next valid event", () => {
  const cwd = join(storeDir, "truncated-run-tail-repo");
  mkdirSync(cwd, { recursive: true });
  const run = store.createRun({ runId: "truncated-run-tail", workflow: "Truncated Tail", cwd });
  appendFileSync(run.runFile, "{\"partial\"");
  const emitted = store.phaseEvent(run, "work", { kind: "progress", completed: 1, total: 2 });
  assert.ok(store.readRun(run.runId).some((event) => event.eventId === emitted.eventId));
  assert.ok(store.readIndex({ limit: 100 }).some((event) => event.eventId === emitted.eventId));
});

test("an unresolved non-empty legacy log cannot be reclaimed with new ownership", () => {
  const cwd = join(storeDir, "legacy-reclaim-repo");
  mkdirSync(cwd, { recursive: true });
  const runId = "legacy-unresolved-reclaim";
  writeFileSync(store.runFileFor(runId), "{}\n".repeat(1_024));
  assert.throws(
    () => store.createRun({ runId, workflow: "Legacy Reclaim", cwd, metadata: { sessionId: "attacker-session" } }),
    /already has a non-empty event log/,
  );
  assert.equal(existsSync(store.runFileFor(runId).replace(/\.jsonl$/, ".start.json")), false);
});

test("aggregate ownership reads stay bounded while start catalog preserves matching-session visibility", () => {
  const cwd = join(storeDir, "aggregate-budget-repo");
  mkdirSync(cwd, { recursive: true });
  store.ensureStore();

  // A normal emitter creates the immutable workflow_start sidecar. Keep this
  // matching run older than a large set of legacy candidates.
  store.createRun({ runId: "aggregate-own", workflow: "Aggregate Own", cwd, metadata: { sessionId: "session-aggregate-own" } });
  const indexLines = [];
  for (let index = 0; index < 1_200; index++) {
    const runId = `aggregate-foreign-${index}`;
    const start = event(runId, `Aggregate Foreign ${index}`, cwd, index + 1, {
      type: "workflow_start",
      timestamp: new Date(Date.UTC(2099, 0, 1) + index * 1000).toISOString(),
      metadata: { sessionId: "session-other", padding: "x".repeat(1024) },
    });
    writeFileSync(store.runFileFor(runId), `${JSON.stringify(start)}\n`);
    indexLines.push(`${JSON.stringify(event(runId, start.workflow, cwd, index + 1, { timestamp: start.timestamp }))}\n`);
  }

  // This legacy unowned local run appears only after the tiny aggregate budget
  // is exhausted. It must fail closed rather than trigger another prefix read.
  const budgetLocal = event("aggregate-budget-local", "Aggregate Budget Local", cwd, 1, {
    type: "workflow_start",
    timestamp: new Date(Date.UTC(2027, 0, 1)).toISOString(),
  });
  writeFileSync(store.runFileFor(budgetLocal.runId), `${JSON.stringify(budgetLocal)}\n`);
  indexLines.push(`${JSON.stringify(event(budgetLocal.runId, budgetLocal.workflow, cwd, 2, { timestamp: budgetLocal.timestamp }))}\n`);
  appendFileSync(store.INDEX_FILE, indexLines.join(""));

  const visible = store.latestRunSummaries({
    limit: 5,
    readLimit: 2_000,
    ownershipReadBudgetBytes: 1024 * 1024,
    ownershipFallbackScanLimit: 1,
    ownershipFilter: (run) => canInspectRun(run, "session-aggregate-own", cwd),
  });
  assert.deepEqual(visible.map((run) => run.runId), ["aggregate-own"]);

  // Catalog loss degrades to the fixed-size sidecar; final returned ownership
  // still requires one separately bounded authoritative-prefix verification.
  writeFileSync(join(storeDir, "run-starts.jsonl"), "");
  const sidecarVisible = store.latestRunSummaries({
    limit: 5,
    readLimit: 2_000,
    ownershipReadBudgetBytes: 512 * 1024,
    ownershipFallbackScanLimit: 1,
    ownershipSidecarReadBudgetBytes: 16 * 1024,
    ownershipSidecarScanLimit: 1,
    ownershipFilter: (run) => canInspectRun(run, "session-aggregate-own", cwd),
  });
  assert.deepEqual(sidecarVisible.map((run) => run.runId), ["aggregate-own"]);
});

test("aggregate verification exhaustion does not poison later ownership reads", () => {
  const cwd = join(storeDir, "budget-cache-recovery-repo");
  mkdirSync(cwd, { recursive: true });
  const run = store.createRun({
    runId: "budget-cache-recovery",
    workflow: "Budget Cache Recovery",
    cwd,
    metadata: { sessionId: "budget-cache-session" },
  });
  const exhausted = store.latestRunSummaries({
    limit: 1,
    readLimit: 1,
    ownershipReadBudgetBytes: 1,
    ownershipFallbackScanLimit: 1,
  });
  assert.equal(exhausted[0].runId, run.runId);
  assert.equal(exhausted[0].workflowStartResolved, false);
  const recovered = store.getRunSummary(run.runId);
  assert.equal(recovered.workflowStartResolved, true);
  assert.equal(recovered.metadata.sessionId, "budget-cache-session");
});

test("durable pending index markers reconcile on the next store initialization", () => {
  const pendingDir = join(storeDir, "index-pending");
  mkdirSync(pendingDir, { recursive: true });
  const eventId = "pending-index-recovery-event";
  const pending = event("pending-index-recovery", "Pending Recovery", storeDir, 1, { eventId });
  writeFileSync(join(pendingDir, `${eventId}.jsonl`), `${JSON.stringify(pending)}\n`);
  store.ensureStore();
  assert.match(readFileSync(store.INDEX_FILE, "utf8"), /pending-index-recovery-event/);
  assert.equal(existsSync(join(pendingDir, `${eventId}.jsonl`)), false);

  const processing = event("processing-index-recovery", "Processing Recovery", storeDir, 2);
  const processingName = "processing-99999999-dead-reconciler.claim";
  writeFileSync(join(pendingDir, processingName), `${JSON.stringify(processing)}\n`);
  store.ensureStore();
  assert.equal(existsSync(join(pendingDir, processingName)), false);
  assert.match(readFileSync(store.INDEX_FILE, "utf8"), /processing-index-recovery-2/);

  // Recover a dead writer's prepared marker and separate it from a partial
  // index tail before appending the complete record.
  mkdirSync(pendingDir, { recursive: true });
  const prepared = event("prepared-index-recovery", "Prepared Recovery", storeDir, 2);
  const preparedLine = `${JSON.stringify(prepared)}\n`;
  writeFileSync(store.runFileFor(prepared.runId), preparedLine);
  const preparedName = "prepared-99999999-dead-writer.jsonl";
  writeFileSync(join(pendingDir, preparedName), preparedLine);
  appendFileSync(store.INDEX_FILE, "{\"partial\"");
  store.ensureStore();
  assert.equal(existsSync(join(pendingDir, preparedName)), false);
  assert.match(readFileSync(store.INDEX_FILE, "utf8"), /\n\{\"schema\":\"thread-phase-ui\/v1\",\"eventId\":\"prepared-index-recovery-2\"/);

  mkdirSync(pendingDir, { recursive: true });
  const oversizedName = "oversized-pending.jsonl";
  writeFileSync(join(pendingDir, oversizedName), "x".repeat(600_000));
  store.ensureStore();
  assert.equal(existsSync(join(pendingDir, oversizedName)), false);
  assert.equal(readdirSync(join(storeDir, "index-quarantine")).some((name) => name.endsWith(oversizedName)), true);
});

test("verification charges actual start bytes for many large run logs", () => {
  const cwd = join(storeDir, "many-large-runs-repo");
  mkdirSync(cwd, { recursive: true });
  for (let index = 0; index < 24; index++) {
    const run = store.createRun({
      runId: `large-log-owner-${index}`,
      workflow: "Large Log Owner",
      cwd,
      metadata: { sessionId: "many-large-runs-session" },
    });
    appendFileSync(run.runFile, `${JSON.stringify({ type: "phase_event", padding: "x".repeat(520_000) })}\n`);
  }
  const visible = store.latestRunSummaries({
    limit: 24,
    readLimit: 100,
    ownershipFilter: (run) => canInspectRun(run, "many-large-runs-session", cwd),
  });
  assert.equal(visible.length, 24);
});

test("monitor and tool enforce the same session-scope fixture beyond the 8000-event index window", async (t) => {
  const repo = join(storeDir, "repo");
  const repoLink = join(storeDir, "repo-link");
  const remote = join(storeDir, "remote");
  mkdirSync(repo);
  mkdirSync(remote);
  symlinkSync(repo, repoLink, "dir");
  const cwd = realpathSync(repo);
  writeLargeOwnedFixture(repoLink, remote);

  await t.test("monitor component shows matching-session and local unscoped running runs only", () => {
    const monitor = new ThreadPhaseMonitorComponent(cwd, "session-own", theme, () => {}, () => {}, () => {});
    const monitorText = monitor.render(100).join("\n");
    assert.match(monitorText, /Bounded Own/, "matching-session run is visible");
    assert.match(monitorText, /Bounded Local/, "local unscoped running run is visible");
    assert.doesNotMatch(monitorText, /Bounded Other/, "different-session run is hidden");
    assert.doesNotMatch(monitorText, /Bounded Remote/, "remote unscoped running run is hidden");
    assert.doesNotMatch(monitorText, /Bounded Relative Primary/, "relative primary cwd cannot be redirected by legacy metadata");
    assert.doesNotMatch(monitorText, /Bounded Completed/, "completed unscoped run is hidden");
    assert.doesNotMatch(monitorText, /Bounded Oversized Owner/, "oversized ownership record fails closed");
    assert.doesNotMatch(monitorText, /Bounded Missing Owner/, "missing ownership record fails closed");
    assert.doesNotMatch(monitorText, /Bounded Budget Owner/, "ownership beyond the record budget fails closed");
  });

  await t.test("thread_phase_runs shows matching-session and local unscoped running runs only", async () => {
    let tool;
    registerVisualizer({
      registerMessageRenderer() {},
      registerTool(value) { tool = value; },
      registerShortcut() {},
      on() {},
    });
    const context = {
      cwd,
      sessionManager: { getSessionId: () => "session-own" },
    };
    const list = await tool.execute("call", { limit: 100 }, undefined, undefined, context);
    assert.deepEqual(list.details.runs.map((run) => run.runId).sort(), ["bounded-local", "bounded-own"]);
    assert.equal(list.details.runs.find((run) => run.runId === "bounded-own").metadata.sessionId, "session-own");
    assert.equal(list.details.runs.find((run) => run.runId === "bounded-local").metadata.cwdAtLaunch, "../remote");

    const own = await tool.execute("call", { runId: "bounded-own" }, undefined, undefined, context);
    assert.equal(own.details.sessionId, "session-own");
    const local = await tool.execute("call", { runId: "bounded-local" }, undefined, undefined, context);
    assert.equal(local.details.summary.runId, "bounded-local");
    for (const hiddenRunId of [
      "bounded-other",
      "bounded-remote",
      "bounded-relative-primary",
      "bounded-completed",
      "bounded-oversized-owner",
      "bounded-missing-owner",
      "bounded-budget-owner",
    ]) {
      const hidden = await tool.execute("call", { runId: hiddenRunId }, undefined, undefined, context);
      assert.equal(hidden.details.summary, undefined, `${hiddenRunId} is hidden`);
    }
  });
});
