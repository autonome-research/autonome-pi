import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports, registerHooks, register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

// No real HOME/store, agents, workflow launch, publication, or file watchers.
const root = fs.mkdtempSync(join(tmpdir(), "status-bounded-history-"));
process.env.HOME = join(root, "home");
process.env.PI_CODING_AGENT_DIR = join(root, "home", ".pi", "agent");
process.env.PI_THREAD_PHASE_STORE_DIR = join(root, "store");
process.env.PI_THREAD_PHASE_STATUS_BRIDGE_DIR = join(root, "bridge");
process.env.PI_THREAD_PHASE_STATUS_BRIDGE = "1";
process.env.PI_THREAD_PHASE_TERMINAL_TITLE = "1";
process.env.PI_THREAD_PHASE_STATUS_REFRESH_MS = "5000";
delete process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND;
delete process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND;
fs.mkdirSync(process.env.HOME, { recursive: true });
const loader = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (registerHooks) registerHooks(await import(loader));
else register(loader);
const store = await import("../lib/store.mjs");
const { default: visualizer } = await import("../index.ts");
const { createStatusBridgeReader } = await import("../lib/status-bridge.mjs");
const { registerThreadPhaseTerminalTitle, projectTerminalTitleState, ACTIVE_SYMBOL, ATTENTION_SYMBOL, COMPLETED_SYMBOL } =
  await import("../../thread-phase-terminal-title/lib/terminal-title.mjs");
const BYTE_LIMIT = 8 * 1024 * 1024;
const RECORD_LIMIT = 512 * 1024;
const SESSION = "isolated-owner";
const NOW = Date.UTC(2026, 8, 14, 1);
let sequence;

function line(event) { return `${JSON.stringify(event)}\n`; }
function event(run, overrides = {}) {
  return {
    schema: store.SCHEMA_VERSION, runId: run.runId, workflow: run.workflow,
    eventId: `fixture-${++sequence}`, timestamp: new Date().toISOString(),
    type: "phase_event", phase: "work", ...overrides,
  };
}
function owned(id = "running", sessionId = SESSION) {
  return store.createRun({ runId: id, workflow: "bounded-history", cwd: root,
    metadata: { sessionId, pid: process.pid, autoContinue: false } });
}
function append(run, events) {
  const text = events.map(line).join("");
  fs.appendFileSync(store.runFileFor(run.runId), text);
  fs.appendFileSync(store.INDEX_FILE, text);
}
function largeHistory(run) {
  // 8000 ordinary ~1.6 KiB records, >12 MiB total, none individually oversized.
  for (let batch = 0; batch < 16; batch++) {
    const batchEvents = Array.from({ length: 500 }, () => event(run, {
      message: "Observed bounded workflow output: " + "x".repeat(1400),
    }));
    assert.ok(batchEvents.every((value) => Buffer.byteLength(line(value)) < 13_000));
    append(run, batchEvents);
  }
  assert.ok(fs.statSync(store.INDEX_FILE).size > BYTE_LIMIT);
}
function patchFs(name, implementation) {
  const original = fs[name];
  const patched = mock.method(fs, name, (...args) => implementation(original, ...args));
  syncBuiltinESMExports();
  return () => { patched.mock.restore(); syncBuiltinESMExports(); };
}
async function host() {
  const handlers = new Map();
  const titles = [];
  const pi = {
    registerMessageRenderer() {}, registerTool() {}, registerShortcut() {}, registerCommand() {},
    sendMessage() {}, sendUserMessage() { assert.fail("fixture must never launch a continuation"); },
    on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]); },
  };
  const ctx = {
    cwd: root, mode: "tui", hasUI: false, isIdle: () => false,
    sessionManager: { getSessionId: () => SESSION, getBranch: () => [], getCwd: () => root },
    ui: { setTitle(value) { titles.push(value); }, setStatus() {}, setWidget() {}, notify() {} },
  };
  visualizer(pi);
  registerThreadPhaseTerminalTitle(pi);
  for (const fn of handlers.get("session_start")) await fn({}, ctx);
  mock.timers.tick(100); // real title's delayed handoff, real reader
  const reader = createStatusBridgeReader({ root: process.env.PI_THREAD_PHASE_STATUS_BRIDGE_DIR, sessionId: SESSION });
  return {
    titles, reader,
    refresh() { mock.timers.tick(5000); },
    state(expected) {
      const result = reader.read();
      assert.equal(projectTerminalTitleState(result), expected, JSON.stringify(result));
      const prefix = { active: ACTIVE_SYMBOL, attention: ATTENTION_SYMBOL, completed: COMPLETED_SYMBOL, idle: "π" }[expected];
      assert.ok(titles.at(-1)?.startsWith(prefix), titles.at(-1));
      return result;
    },
    async close() { for (const fn of handlers.get("session_shutdown")) await fn({}, ctx); },
  };
}

test.beforeEach(() => {
  sequence = 0;
  fs.rmSync(process.env.PI_THREAD_PHASE_STORE_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.PI_THREAD_PHASE_STATUS_BRIDGE_DIR, { recursive: true, force: true });
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: NOW });
  // Explicit polling is deterministic; no asynchronous watcher can observe a
  // deliberately half-written fixture or run completion delivery code.
  patchFs("watch", () => ({ close() {} }));
  store.ensureStore();
});
test.afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); mock.timers.reset(); });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("real >8 MiB ordinary history reaches active title and terminal/recency transitions", async () => {
  const run = owned();
  largeHistory(run);
  const foreign = owned("foreign", "other-session");
  store.completeRun(foreign, "failed");
  const observation = store.observeSessionRunSummaries(SESSION);
  assert.equal(observation.window.truncatedBy, "bytes");
  assert.ok(observation.window.startByte > 0);
  assert.ok(observation.window.endByte - observation.window.startByte <= BYTE_LIMIT);
  assert.ok(observation.window.records < 8000);
  assert.equal(observation.runs.length, 1);
  assert.equal(observation.runs[0].normalizedStatus, "running");
  assert.equal(observation.runs[0].workflowStartResolved, true, "start outside tail must be immutably verified");
  const h = await host();
  try {
    assert.equal(h.state("active").snapshot.counts.running, 1);
    store.completeRun(run, "success");
    h.refresh();
    assert.equal(h.state("completed").snapshot.counts.successRecent, 1);
    // Advancing time, not rewriting terminal timestamps, expires recency.
    mock.timers.tick(60_000);
    h.state("idle");
    for (const [id, outcome, key] of [["failure", "failed", "failureRecent"], ["cancelled", "cancelled", "cancelledRecent"]]) {
      const next = owned(id);
      h.refresh();
      h.state("active");
      store.completeRun(next, outcome);
      h.refresh();
      const current = h.state("attention");
      assert.equal(current.state, "current");
      assert.equal(current.snapshot.counts[key], 1);
      mock.timers.tick(60_000);
      h.state("idle");
    }
  } finally { await h.close(); }
});

test("8000-record source and projection share scope, including lifecycle evidence older than 5000 records", async () => {
  const run = owned();
  const foreign = owned("foreign", "other-session");
  store.completeRun(run, "success");
  const terminal = fs.readFileSync(store.INDEX_FILE, "utf8").trim().split("\n").at(-1);
  append(foreign, Array.from({ length: 6000 }, () => event(foreign)));
  // A post-terminal event must not resurrect this run through a shorter 5000
  // record projection when the strict 8000-record source includes its end.
  append(run, [event(run)]);
  const observation = store.observeSessionRunSummaries(SESSION);
  assert.equal(observation.runs[0].normalizedStatus, "success");
  assert.ok(observation.runs[0].events.some((value) => value.eventId === JSON.parse(terminal).eventId));
  const h = await host();
  try { h.state("completed"); } finally { await h.close(); }
});

test("byte-boundary straddles exclude only an older prefix, never skip an interior workflow_end", async () => {
  const run = owned();
  largeHistory(run);
  // A normal but larger terminal envelope fits the writer's record limit.
  // It must never be skipped in favor of older, smaller running records.
  const end = event(run, { type: "workflow_end", status: "success", message: "y".repeat(12000) });
  append(run, [end, event(run)]);
  const observation = store.observeSessionRunSummaries(SESSION);
  const bytes = fs.readFileSync(store.INDEX_FILE);
  assert.equal(bytes[observation.window.startByte - 1], 10);
  const expected = bytes.subarray(observation.window.startByte).toString("utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(observation.runs[0].events.map((value) => value.eventId), expected.map((value) => value.eventId));
  assert.ok(expected.some((value) => value.eventId === end.eventId));
  const h = await host();
  try { h.state("completed"); } finally { await h.close(); }
});

test("record limits and corrupt evidence outside the chosen window do not poison it", () => {
  const run = owned();
  const values = Array.from({ length: 8000 }, () => event(run));
  fs.writeFileSync(store.INDEX_FILE, "{older corruption}\n" + values.map(line).join(""));
  const observation = store.observeSessionRunSummaries(SESSION);
  assert.equal(observation.window.records, 8000);
  assert.equal(observation.window.truncatedBy, "records");
  assert.equal(observation.runs[0].events.length, 8000);
  assert.equal(observation.window.startByte, Buffer.byteLength("{older corruption}\n"));
  // One corrupt physical record now enters the selected suffix.
  fs.writeFileSync(store.INDEX_FILE, "{older corruption}\n" + values.slice(1).map(line).join(""));
  assert.throws(() => store.observeSessionRunSummaries(SESSION));
});

test("actual interior malformed, oversized, partial, and invalid UTF-8 evidence fails closed through title", async () => {
  const run = owned();
  const start = fs.readFileSync(store.INDEX_FILE);
  const h = await host();
  try {
    h.state("active");
    const corruptions = [
      "{invalid}\n", "null\n", "{}\n",
      line(event(run, { type: "workflow_end", timestamp: "not-a-time", status: "success" })),
      line(event(run, { type: "workflow_end", status: "success", message: "x".repeat(RECORD_LIMIT) })),
      Buffer.from(line(event(run, { message: "INVALID_UTF8" })).replace("INVALID_UTF8", "\xff"), "latin1"),
    ];
    for (const corruption of corruptions) {
      fs.writeFileSync(store.INDEX_FILE, Buffer.concat([start, Buffer.from(corruption), Buffer.from(line(event(run)))]));
      h.refresh();
      assert.equal(h.state("attention").reason, "source-unknown");
      fs.writeFileSync(store.INDEX_FILE, start);
      h.refresh();
      h.state("active");
    }
    for (const partial of ["{", line(event(run, { type: "workflow_end", status: "success" })).trimEnd(), "x".repeat(BYTE_LIMIT + 1)]) {
      fs.writeFileSync(store.INDEX_FILE, Buffer.concat([start, Buffer.from(partial)]));
      h.refresh();
      assert.equal(h.state("attention").reason, "source-unknown");
    }
  } finally { await h.close(); }
});

test("exact record/byte boundaries, blank lines, and empty/missing source are truthful", async () => {
  const run = owned();
  const base = event(run);
  const exact = { ...base, message: "x".repeat(RECORD_LIMIT - Buffer.byteLength(line({ ...base, message: "" }))) };
  assert.equal(Buffer.byteLength(line(exact)), RECORD_LIMIT);
  fs.writeFileSync(store.INDEX_FILE, line(exact));
  assert.equal(store.observeSessionRunSummaries(SESSION).runs.length, 1);
  fs.writeFileSync(store.INDEX_FILE, line({ ...exact, message: exact.message + "x" }));
  assert.throws(() => store.observeSessionRunSummaries(SESSION), /Oversized/);
  fs.writeFileSync(store.INDEX_FILE, line(exact).repeat(16));
  const full = store.observeSessionRunSummaries(SESSION);
  assert.equal(full.window.endByte, BYTE_LIMIT);
  assert.equal(full.window.startByte, 0);
  assert.equal(full.window.records, 16);
  fs.appendFileSync(store.INDEX_FILE, "\n");
  const clipped = store.observeSessionRunSummaries(SESSION);
  assert.equal(clipped.window.truncatedBy, "bytes");
  assert.equal(clipped.window.startByte, RECORD_LIMIT);
  fs.writeFileSync(store.INDEX_FILE, "\n\n");
  assert.equal(store.observeSessionRunSummaries(SESSION).window.records, 2);
  fs.writeFileSync(store.INDEX_FILE, "");
  const h = await host();
  try {
    h.state("idle");
    fs.rmSync(store.INDEX_FILE);
    h.refresh();
    assert.equal(h.state("attention").reason, "source-unknown");
    fs.writeFileSync(store.INDEX_FILE, "");
    h.refresh();
    h.state("idle");
  } finally { await h.close(); }
});

test("immutable owner verification excludes foreign, forged, and unresolved runs in the same cwd", async () => {
  const local = owned();
  const foreign = owned("foreign", "foreign-session");
  append(foreign, [event(foreign, { metadata: { sessionId: SESSION }, type: "workflow_start", status: "running" })]);
  append({ runId: "unresolved", workflow: "bounded-history" }, [event({ runId: "unresolved", workflow: "bounded-history" }, { metadata: { sessionId: SESSION } })]);
  const observation = store.observeSessionRunSummaries(SESSION);
  assert.deepEqual(observation.runs.map((run) => run.runId), [local.runId]);
  const h = await host();
  try { assert.equal(h.state("active").snapshot.observation.observedRuns, 1); } finally { await h.close(); }
});

test("growing, rotated, same-size rewritten, short-read, and unreadable sources remain unknown", async () => {
  const run = owned();
  const stable = fs.readFileSync(store.INDEX_FILE);
  const h = await host();
  try {
    h.state("active");
    const mutations = [
      () => fs.appendFileSync(store.INDEX_FILE, line(event(run))),
      () => fs.truncateSync(store.INDEX_FILE, stable.length - 1),
      () => { fs.renameSync(store.INDEX_FILE, `${store.INDEX_FILE}.old`); fs.writeFileSync(store.INDEX_FILE, stable); },
      () => { const changed = Buffer.from(stable); changed[changed.indexOf("bounded-history")] = 66; fs.writeFileSync(store.INDEX_FILE, changed); },
    ];
    for (const mutate of mutations) {
      let fired = false;
      const restore = patchFs("readSync", (original, fd, buffer, offset, length, position) => {
        const count = original(fd, buffer, offset, length, position);
        if (!fired && length === stable.length && position === 0) { fired = true; mutate(); }
        return count;
      });
      h.refresh();
      restore();
      assert.ok(fired);
      assert.equal(h.state("attention").reason, "source-unknown");
      fs.writeFileSync(store.INDEX_FILE, stable);
      h.refresh();
      h.state("active");
    }
    const restoreShort = patchFs("readSync", (original, ...args) => {
      const count = original(...args);
      return args[3] === stable.length ? count - 1 : count;
    });
    h.refresh();
    restoreShort();
    assert.equal(h.state("attention").reason, "source-unknown");
    const restoreOpen = patchFs("openSync", (original, file, ...args) => {
      if (file === store.INDEX_FILE) throw Object.assign(new Error("isolated EACCES"), { code: "EACCES" });
      return original(file, ...args);
    });
    h.refresh();
    restoreOpen();
    assert.equal(h.state("attention").reason, "source-unknown");
  } finally { await h.close(); }
});

test("strict observation never scans unbounded oversized records or reads full index/run files", () => {
  const run = owned();
  largeHistory(run);
  const indexFds = new Set();
  let readBytes = 0;
  let maxRequest = 0;
  patchFs("openSync", (original, file, ...args) => {
    const fd = original(file, ...args);
    if (file === store.INDEX_FILE) indexFds.add(fd);
    return fd;
  });
  patchFs("closeSync", (original, fd) => { indexFds.delete(fd); return original(fd); });
  patchFs("readFileSync", (original, file, ...args) => {
    assert.notEqual(file, store.INDEX_FILE);
    assert.notEqual(file, store.runFileFor(run.runId));
    return original(file, ...args);
  });
  patchFs("readSync", (original, fd, buffer, offset, length, position) => {
    if (indexFds.has(fd)) { readBytes += length; maxRequest = Math.max(maxRequest, length); }
    return original(fd, buffer, offset, length, position);
  });
  store.observeSessionRunSummaries(SESSION);
  assert.equal(readBytes, BYTE_LIMIT);
  assert.ok(maxRequest <= BYTE_LIMIT);
  // Sparse, isolated 256 MiB trailing record: strict read cannot chase its start.
  fs.truncateSync(store.INDEX_FILE, 256 * 1024 * 1024);
  readBytes = 0;
  assert.throws(() => store.observeSessionRunSummaries(SESSION), /Incomplete/);
  assert.equal(readBytes, BYTE_LIMIT);
  const fd = fs.openSync(store.INDEX_FILE, "r+");
  fs.writeSync(fd, Buffer.from("\n"), 0, 1, 256 * 1024 * 1024 - 1);
  fs.closeSync(fd);
  readBytes = 0;
  assert.throws(() => store.observeSessionRunSummaries(SESSION), /Oversized/);
  assert.equal(readBytes, BYTE_LIMIT);
});

test("reported separately: nonterminal error projection remains attention even with live owner and newer activity", async () => {
  const run = owned();
  store.emit(run, { type: "error", error: new Error("recoverable phase error") });
  store.emit(run, { type: "phase_event", phase: "work", message: "still working" });
  const observation = store.observeSessionRunSummaries(SESSION);
  assert.equal(observation.runs[0].normalizedStatus, "failed");
  assert.equal(observation.runs[0].endedAt, undefined);
  const h = await host();
  try {
    const result = h.state("attention");
    assert.equal(result.state, "current");
    assert.equal(result.snapshot.counts.unknownActive, 1);
    assert.equal(result.snapshot.counts.failureRecent, 0);
  } finally { await h.close(); }
});
