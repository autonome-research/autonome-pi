import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-corrupt-store-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
const store = await import(`../lib/store.mjs?corruption-test=${Date.now()}`);

function event(index, overrides = {}) {
  return {
    schema: store.SCHEMA_VERSION,
    eventId: `event-${index}`,
    timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
    runId: "corrupt-run",
    workflow: "corruption-test",
    type: "phase_event",
    phase: "work",
    ...overrides,
  };
}

mkdirSync(store.RUNS_DIR, { recursive: true });
test.after(() => rmSync(storeDir, { recursive: true, force: true }));

test("invalid JSON lines are skipped and diagnosed by forward and tail reads", () => {
  const file = store.runFileFor("corrupt-run");
  writeFileSync(
    file,
    `${JSON.stringify(event(0))}\n{not json}\n${JSON.stringify(event(1))}\n[also invalid}\n${JSON.stringify(event(2))}\n`,
    "utf8",
  );

  for (const options of [{ fromByte: 0, readLimit: 5 }, { readLimit: 5 }]) {
    const result = store.readRunBounded("corrupt-run", options);

    assert.deepEqual(result.map((value) => value.eventId), ["event-0", "event-1", "event-2"]);
    assert.deepEqual(result.parseErrors.map((error) => error.kind), ["invalid_json", "invalid_json"]);
    assert.ok(result.parseErrors.every((error) => error.file === file));
    assert.ok(result.parseErrors.every((error) => /JSON/i.test(error.message)));
    assert.deepEqual(result.parseErrors.map((error) => error.preview), ["{not json}", "[also invalid}"]);
  }
});

test("parse errors remain accessible diagnostics without changing event-array projections", () => {
  const file = store.runFileFor("corrupt-run");
  writeFileSync(file, `${JSON.stringify(event(0))}\n{broken}\n${JSON.stringify(event(1))}\n`, "utf8");

  const result = store.readRunBounded("corrupt-run", { fromByte: 0, readLimit: 3 });
  const descriptor = Object.getOwnPropertyDescriptor(result, "parseErrors");

  assert.ok(Array.isArray(result));
  assert.deepEqual(result.map((value) => value.eventId), ["event-0", "event-1"]);
  assert.deepEqual(result.parseErrors, [{
    kind: "invalid_json",
    file,
    lineIndex: 1,
    message: result.parseErrors[0].message,
    preview: "{broken}",
  }]);
  assert.match(result.parseErrors[0].message, /JSON/i);
  assert.equal(descriptor?.enumerable, false);
  assert.deepEqual([...result], result);
});

test("an incomplete final line is skipped and diagnosed", () => {
  const file = store.runFileFor("corrupt-run");
  writeFileSync(file, `${JSON.stringify(event(0))}\n{"eventId":"unfinished`, "utf8");

  const result = store.readRunBounded("corrupt-run", { fromByte: 0, readLimit: 2 });

  assert.deepEqual(result.map((value) => value.eventId), ["event-0"]);
  assert.deepEqual(result.parseErrors.map((error) => error.kind), ["partial_final_line"]);
});

test("a syntactically valid final record without a newline is treated as a partial write", () => {
  const file = store.runFileFor("corrupt-run");
  writeFileSync(file, `${JSON.stringify(event(0))}\n${JSON.stringify(event(1))}`, "utf8");

  for (const options of [{ readLimit: 2 }, { fromByte: 0, readLimit: 2 }]) {
    const result = store.readRunBounded("corrupt-run", options);

    assert.deepEqual(result.map((value) => value.eventId), ["event-0"]);
    assert.deepEqual(result.parseErrors.map((error) => error.kind), ["partial_final_line"]);
    assert.match(result.parseErrors[0].message, /incomplete final JSONL line/i);
  }
});

test("duplicate event lines are projected only once", () => {
  const file = store.runFileFor("corrupt-run");
  const artifact = event(1, {
    type: "artifact",
    artifact: { kind: "markdown", title: "inline", content: "result" },
  });
  writeFileSync(file, `${JSON.stringify(event(0, { type: "workflow_start" }))}\n${JSON.stringify(artifact)}\n${JSON.stringify(artifact)}\n`, "utf8");

  const result = store.readRunBounded("corrupt-run", { fromByte: 0, readLimit: 3 });
  const projected = store.projectRun([artifact, artifact]);

  assert.deepEqual(result.map((value) => value.eventId), ["event-0", "event-1"]);
  assert.equal(projected.eventCount, 1);
  assert.equal(projected.artifacts.length, 1);
});
