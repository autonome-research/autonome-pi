import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-bounded-store-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
const store = await import(`../lib/store.mjs?bounded-test=${Date.now()}`);

function event(index, overrides = {}) {
  return {
    schema: store.SCHEMA_VERSION,
    eventId: `event-${index}`,
    timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
    runId: "bounded-run",
    workflow: "bounded-test",
    type: "phase_event",
    phase: "work",
    message: `event ${index}`,
    ...overrides,
  };
}

function writeJsonl(file, events) {
  writeFileSync(file, `${events.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

mkdirSync(store.RUNS_DIR, { recursive: true });

test.after(() => rmSync(storeDir, { recursive: true, force: true }));

test("bounded index tail honors readLimit and drops oldest events beyond limit", () => {
  const events = Array.from({ length: 30 }, (_, index) => event(index));
  writeJsonl(store.INDEX_FILE, events);

  assert.deepEqual(store.readIndexBounded({ readLimit: 7, limit: 20 }).map((value) => value.eventId), events.slice(-7).map((value) => value.eventId));
  assert.deepEqual(store.readIndexBounded({ readLimit: 20, limit: 3 }).map((value) => value.eventId), events.slice(-3).map((value) => value.eventId));
});

test("bounded index reads normalize zero and negative result limits to empty", () => {
  const events = Array.from({ length: 3 }, (_, index) => event(index));
  writeFileSync(store.INDEX_FILE, `${events.map((value) => JSON.stringify(value)).join("\n")}\n{invalid json}\n`, "utf8");

  for (const limit of [0, -1]) {
    const result = store.readIndexBounded({ readLimit: 10, limit });
    assert.equal(result.length, 0);
    assert.equal(result.parseErrors.length, 1);
    assert.equal(result.parseErrors[0].kind, "invalid_json");
  }
});

test("bounded run reads support byte offsets and return timestamp order", () => {
  const events = [event(3), event(1), event(2), event(4)];
  const file = store.runFileFor("bounded-run");
  writeJsonl(file, events);

  assert.deepEqual(store.readRunBounded("bounded-run", { readLimit: 4 }).map((value) => value.eventId), ["event-1", "event-2", "event-3", "event-4"]);

  const firstLineBytes = Buffer.byteLength(`${JSON.stringify(events[0])}\n`);
  assert.deepEqual(store.readRunBounded("bounded-run", { fromByte: firstLineBytes, readLimit: 2, limit: 2 }).map((value) => value.eventId), ["event-1", "event-2"]);
});

test("forward byte ceilings preserve preceding events and diagnose an oversized record", () => {
  const file = store.runFileFor("bounded-run");
  const first = `${JSON.stringify(event(0))}\n`;
  writeFileSync(file, `${first}{"payload":"${"x".repeat(16_000)}"}\n${JSON.stringify(event(1))}\n`, "utf8");

  const result = store.readRunBounded("bounded-run", { fromByte: 0, readLimit: 10, maxBytes: Buffer.byteLength(first) + 1024 });

  assert.deepEqual(result.map((value) => value.eventId), ["event-0", "event-1"]);
  assert.deepEqual(result.parseErrors.map((error) => error.kind), ["oversized_record"]);
  assert.match(result.parseErrors[0].message, /byte read ceiling/i);
  assert.ok(result.parseErrors[0].preview.length <= 501);
});

test("tail byte ceilings preserve recent events after an oversized record", () => {
  const file = store.runFileFor("bounded-run");
  const recent = [event(1), event(2)];
  writeFileSync(file, `{"payload":"${"x".repeat(16_000)}"}\n${recent.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");

  const result = store.readRunBounded("bounded-run", { readLimit: 10, maxBytes: 2048 });

  assert.deepEqual(result.map((value) => value.eventId), ["event-1", "event-2"]);
  assert.deepEqual(result.parseErrors.map((error) => error.kind), ["oversized_record"]);
});

test("an oversized unterminated forward record preserves its adjacent preceding event", () => {
  const file = store.runFileFor("bounded-run");
  const preceding = `${JSON.stringify(event(0))}\n`;
  writeFileSync(file, `${preceding}{"payload":"${"x".repeat(8 * 1024 * 1024)}`, "utf8");

  const before = process.memoryUsage().heapUsed;
  const result = store.readRunBounded("bounded-run", {
    fromByte: 0,
    readLimit: 2,
    maxBytes: Buffer.byteLength(preceding) + 1024,
  });
  const heapGrowth = process.memoryUsage().heapUsed - before;

  assert.deepEqual(result.map((value) => value.eventId), ["event-0"]);
  assert.deepEqual(result.parseErrors.map((error) => error.kind), ["oversized_record"]);
  assert.ok(heapGrowth < 8 * 1024 * 1024, `unterminated forward read grew heap by ${heapGrowth} bytes`);
});

test("a forward read starting inside a multi-megabyte record recovers the next event", () => {
  const file = store.runFileFor("bounded-run");
  const prefix = `${JSON.stringify(event(0))}\n{"payload":"`;
  const oversizedBytes = 16 * 1024 * 1024;
  writeFileSync(file, `${prefix}${"x".repeat(oversizedBytes)}"}\n${JSON.stringify(event(1))}\n`, "utf8");

  const before = process.memoryUsage().heapUsed;
  const result = store.readRunBounded("bounded-run", {
    fromByte: Buffer.byteLength(prefix) + oversizedBytes / 2,
    readLimit: 2,
    maxBytes: 1024,
  });
  const heapGrowth = process.memoryUsage().heapUsed - before;

  assert.deepEqual(result.map((value) => value.eventId), ["event-1"]);
  assert.deepEqual(result.parseErrors.map((error) => error.kind), ["oversized_record"]);
  assert.ok(heapGrowth < 8 * 1024 * 1024, `oversized forward read grew heap by ${heapGrowth} bytes`);
});

test("an oversized unterminated tail is bounded and diagnosed", () => {
  const file = store.runFileFor("bounded-run");
  writeFileSync(file, `{"payload":"${"x".repeat(16_000)}`, "utf8");

  const result = store.readRunBounded("bounded-run", { readLimit: 10, maxBytes: 1024 });

  assert.deepEqual(result, []);
  assert.deepEqual(result.parseErrors.map((error) => error.kind), ["oversized_record"]);
});

test("an oversized unterminated tail does not hide valid preceding events", () => {
  const file = store.runFileFor("bounded-run");
  const preceding = [event(0), event(1)];
  writeFileSync(file, `${preceding.map((value) => JSON.stringify(value)).join("\n")}\n{"payload":"${"x".repeat(16 * 1024 * 1024)}`, "utf8");

  const before = process.memoryUsage().heapUsed;
  const result = store.readRunBounded("bounded-run", { readLimit: 10, maxBytes: 1024 });
  const heapGrowth = process.memoryUsage().heapUsed - before;

  assert.deepEqual(result.map((value) => value.eventId), ["event-0", "event-1"]);
  assert.deepEqual(result.parseErrors.map((error) => error.kind), ["oversized_record"]);
  assert.ok(heapGrowth < 8 * 1024 * 1024, `oversized tail read grew heap by ${heapGrowth} bytes`);
});

test("a newline-terminated oversized tail does not hide valid preceding events", () => {
  const file = store.runFileFor("bounded-run");
  const preceding = [event(0), event(1)];
  writeFileSync(file, `${preceding.map((value) => JSON.stringify(value)).join("\n")}\n{"payload":"${"x".repeat(16 * 1024 * 1024)}"}\n`, "utf8");

  const before = process.memoryUsage().heapUsed;
  const result = store.readRunBounded("bounded-run", { readLimit: 3, maxBytes: 1024 });
  const heapGrowth = process.memoryUsage().heapUsed - before;

  assert.deepEqual(result.map((value) => value.eventId), ["event-0", "event-1"]);
  assert.deepEqual(result.parseErrors.map((error) => error.kind), ["oversized_record"]);
  assert.ok(result.parseErrors[0].preview.length <= 501);
  assert.ok(heapGrowth < 8 * 1024 * 1024, `terminated oversized tail read grew heap by ${heapGrowth} bytes`);
});

test("forward recovery iterates across consecutive oversized records", () => {
  const file = store.runFileFor("bounded-run");
  const oversized = (value) => `{"payload":"${value.repeat(2 * 1024 * 1024)}"}\n`;
  writeFileSync(file, `${oversized("x")}${oversized("y")}${JSON.stringify(event(2))}\n`, "utf8");

  const result = store.readRunBounded("bounded-run", { fromByte: 0, readLimit: 3, maxBytes: 1024 });

  assert.deepEqual(result.map((value) => value.eventId), ["event-2"]);
  assert.deepEqual(result.parseErrors.map((error) => error.kind), ["oversized_record", "oversized_record"]);
  assert.ok(result.parseErrors.every((error) => error.preview.length <= 501));
});

test("tail recovery iterates across consecutive oversized records", () => {
  const file = store.runFileFor("bounded-run");
  const oversized = (value) => `{"payload":"${value.repeat(2 * 1024 * 1024)}"}\n`;
  writeFileSync(file, `${JSON.stringify(event(0))}\n${oversized("x")}${oversized("y")}${JSON.stringify(event(3))}\n`, "utf8");

  const before = process.memoryUsage().heapUsed;
  const result = store.readRunBounded("bounded-run", { readLimit: 4, maxBytes: 1024 });
  const heapGrowth = process.memoryUsage().heapUsed - before;

  assert.deepEqual(result.map((value) => value.eventId), ["event-0", "event-3"]);
  assert.deepEqual(result.parseErrors.map((error) => error.kind), ["oversized_record", "oversized_record"]);
  assert.ok(result.parseErrors.every((error) => error.preview.length <= 501));
  assert.ok(heapGrowth < 8 * 1024 * 1024, `repeated oversized tail read grew heap by ${heapGrowth} bytes`);
});

test("tail recovery stays memory bounded across many consecutive oversized records", () => {
  const stressStoreDir = mkdtempSync(join(tmpdir(), "thread-phase-oversized-tail-"));
  const oversizedCount = 12_000;
  const script = String.raw`
    import assert from "node:assert/strict";
    import { appendFileSync } from "node:fs";
    const store = await import("./thread-phase-visualizer/lib/store.mjs");
    store.ensureStore();
    const event = (eventId, sequence) => JSON.stringify({
      schema: store.SCHEMA_VERSION,
      eventId,
      timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, sequence)).toISOString(),
      runId: "oversized-stress-run",
      workflow: "bounded-test",
      type: "phase_event",
      phase: "work",
      sequence,
    }) + "\n";
    appendFileSync(store.INDEX_FILE, event("valid-before", 0));
    const oversizedLine = JSON.stringify({ payload: "x".repeat(2_048) }) + "\n";
    for (let written = 0; written < ${oversizedCount}; written += 250) {
      appendFileSync(store.INDEX_FILE, oversizedLine.repeat(Math.min(250, ${oversizedCount} - written)));
    }
    appendFileSync(store.INDEX_FILE, event("valid-recent", 1));

    const heapBefore = process.memoryUsage().heapUsed;
    const result = store.readIndexBounded({ readLimit: ${oversizedCount + 2}, limit: 2, maxBytes: 1_024 });
    const heapGrowth = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
    assert.deepEqual(result.map((value) => value.eventId), ["valid-before", "valid-recent"]);
    assert.equal(result.parseErrors.length, ${oversizedCount});
    assert.ok(result.parseErrors.every((error) => error.kind === "oversized_record" && error.preview.length <= 160));
    console.log(JSON.stringify({ heapGrowth, peakBytes: process.resourceUsage().maxRSS * 1024 }));
  `;

  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: join(import.meta.dirname, "../.."),
      env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: stressStoreDir },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const metrics = JSON.parse(child.stdout.trim());
    assert.ok(metrics.heapGrowth < 32 * 1024 * 1024, `consecutive oversized tail read grew heap by ${metrics.heapGrowth} bytes`);
    assert.ok(metrics.peakBytes < 128 * 1024 * 1024, `consecutive oversized tail read peaked at ${metrics.peakBytes} bytes`);
  } finally {
    rmSync(stressStoreDir, { recursive: true, force: true });
  }
});

test("bounded and full reads project identically for the same event set", () => {
  const events = [
    event(0, { type: "workflow_start", status: "running", metadata: { sessionId: "session" } }),
    event(1, { type: "phase_start", status: "running" }),
    event(2, { data: { kind: "progress", completed: 1, total: 1 } }),
    event(3, { type: "artifact", artifact: { kind: "file", title: "result", path: "/tmp/result" } }),
    event(4, { type: "phase_end", status: "success" }),
    event(5, { type: "workflow_end", status: "success" }),
  ];
  const file = store.runFileFor("bounded-run");
  writeJsonl(file, events);
  const full = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  const bounded = store.readRunBounded("bounded-run", { fromByte: 0, readLimit: events.length, limit: events.length });

  assert.deepEqual(store.projectRun(bounded), store.projectRun(full));
});

test("bounded and full projections use one injected clock for stale running runs", () => {
  const referenceTime = Date.UTC(2025, 0, 1, 1, 0, 0);
  const heartbeatTime = new Date(referenceTime - 6 * 60 * 1000).toISOString();
  const events = [
    event(0, { eventId: "stale-start", timestamp: heartbeatTime, type: "workflow_start", status: "running" }),
    event(1, { eventId: "stale-heartbeat", timestamp: heartbeatTime, data: { kind: "heartbeat" } }),
  ];
  const file = store.runFileFor("bounded-run");
  writeJsonl(file, events);
  const full = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  const bounded = store.readRunBounded("bounded-run", { fromByte: 0, readLimit: events.length, limit: events.length });
  const options = { referenceTime };

  const fullProjection = store.projectRun(full, options);
  const boundedProjection = store.projectRun(bounded, options);

  assert.deepEqual(boundedProjection, fullProjection);
  assert.deepEqual(boundedProjection.stale, {
    reason: "heartbeat_stale",
    ageMs: 6 * 60 * 1000,
    checkedAt: new Date(referenceTime).toISOString(),
  });
});

test("bounded and full projections use one injected clock for dead-PID metadata", () => {
  const referenceTime = "2025-01-01T01:00:00.000Z";
  const events = [
    event(0, {
      eventId: "dead-pid-start",
      type: "workflow_start",
      status: "running",
      metadata: { pid: 2_147_483_647, sessionId: "bounded-session" },
    }),
  ];
  const file = store.runFileFor("bounded-run");
  writeJsonl(file, events);
  const full = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  const bounded = store.readRunBounded("bounded-run", { fromByte: 0, readLimit: events.length, limit: events.length });
  const options = { referenceTime };

  const fullProjection = store.projectRun(full, options);
  const boundedProjection = store.projectRun(bounded, options);

  assert.deepEqual(boundedProjection, fullProjection);
  assert.deepEqual(boundedProjection.stale, {
    reason: "pid_not_running",
    pid: 2_147_483_647,
    checkedAt: referenceTime,
  });
});

test("a sparse 512MB run log restores start ownership with bounded prefix I/O", () => {
  const largeStoreDir = mkdtempSync(join(tmpdir(), "thread-phase-large-owned-run-"));
  const script = String.raw`
    import assert from "node:assert/strict";
    import { truncateSync, writeFileSync } from "node:fs";
    const store = await import("./thread-phase-visualizer/lib/store.mjs");
    const { canInspectRun } = await import("./thread-phase-visualizer/lib/session-scope.mjs");
    store.ensureStore();
    const cwd = process.cwd();
    const start = {
      schema: store.SCHEMA_VERSION,
      eventId: "large-owned-start",
      timestamp: "2025-01-01T00:00:00.000Z",
      runId: "large-owned-run",
      workflow: "large-owned-test",
      cwd,
      type: "workflow_start",
      status: "running",
      metadata: { sessionId: "session-owner", cwdAtLaunch: cwd },
    };
    const recent = {
      ...start,
      eventId: "large-owned-recent",
      timestamp: "2025-01-01T00:00:01.000Z",
      type: "phase_event",
      metadata: undefined,
    };
    const runFile = store.runFileFor(start.runId);
    writeFileSync(runFile, JSON.stringify(start) + "\n");
    // A sparse suffix makes an accidental full-file ownership read allocate or
    // scan 512 MiB while keeping this regression fast and disk-light.
    truncateSync(runFile, 512 * 1024 * 1024);
    writeFileSync(store.INDEX_FILE, JSON.stringify(recent) + "\n");

    const summary = store.latestRunSummaries({ limit: 1, readLimit: 1 })[0];
    assert.equal(summary.workflowStartResolved, true);
    assert.equal(summary.metadata.sessionId, "session-owner");
    assert.equal(canInspectRun(summary, "session-owner", cwd), true);
    assert.equal(canInspectRun(summary, "session-other", cwd), false);
    console.log(JSON.stringify({ peakBytes: process.resourceUsage().maxRSS * 1024 }));
  `;

  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: join(import.meta.dirname, "../.."),
      env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: largeStoreDir },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const metrics = JSON.parse(child.stdout.trim());
    assert.ok(metrics.peakBytes < 100 * 1024 * 1024, `bounded ownership lookup peaked at ${metrics.peakBytes} bytes`);
  } finally {
    rmSync(largeStoreDir, { recursive: true, force: true });
  }
});

test("a 50000-line index scan completes below 100MB peak memory", () => {
  const largeStoreDir = mkdtempSync(join(tmpdir(), "thread-phase-large-index-"));
  const script = String.raw`
    import { appendFileSync } from "node:fs";
    const store = await import("./thread-phase-visualizer/lib/store.mjs");
    store.ensureStore();
    for (let start = 0; start < 50_000; start += 500) {
      let batch = "";
      for (let sequence = start; sequence < start + 500; sequence++) {
        batch += JSON.stringify({
          schema: store.SCHEMA_VERSION,
          eventId: "large-" + sequence,
          timestamp: "2025-01-01T00:00:00.000Z",
          runId: "large-run",
          workflow: "bounded-test",
          type: "phase_event",
          sequence,
        }) + "\n";
      }
      appendFileSync(store.INDEX_FILE, batch);
    }
    const result = store.readIndexBounded({ readLimit: 100, limit: 25 });
    console.log(JSON.stringify({
      sequences: result.map((value) => value.sequence),
      peakBytes: process.resourceUsage().maxRSS * 1024,
    }));
  `;

  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: join(import.meta.dirname, "../.."),
      env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: largeStoreDir },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const metrics = JSON.parse(child.stdout.trim());
    assert.deepEqual(metrics.sequences, Array.from({ length: 25 }, (_, index) => 49_975 + index));
    assert.ok(metrics.peakBytes < 100 * 1024 * 1024, `bounded 50000-line read peaked at ${metrics.peakBytes} bytes`);
  } finally {
    rmSync(largeStoreDir, { recursive: true, force: true });
  }
});
