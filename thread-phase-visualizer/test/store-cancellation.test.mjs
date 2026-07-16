import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-cancel-store-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
const store = await import(`../lib/store.mjs?cancellation-test=${Date.now()}`);

test.after(() => rmSync(storeDir, { recursive: true, force: true }));

test("cancelFileFor computes a contained safe JSON path", () => {
  const file = store.cancelFileFor("workflow:run-1.2_test");

  assert.equal(dirname(file), store.CANCEL_DIR);
  assert.equal(basename(file), "workflow:run-1.2_test.json");
  assert.equal(relative(store.CANCEL_DIR, file), "workflow:run-1.2_test.json");
  assert.throws(() => store.cancelFileFor("../outside"), /Invalid thread-phase runId/);
  assert.throws(() => store.cancelFileFor("nested/run"), /Invalid thread-phase runId/);
});

test("requestCancellation writes the complete cancellation schema used by the monitor", () => {
  const before = Date.now();
  const request = store.requestCancellation("monitor-run", {
    reason: "cancelled from thread-phase monitor",
    source: "thread-phase-visualizer",
  });
  const file = store.cancelFileFor("monitor-run");
  const persisted = JSON.parse(readFileSync(file, "utf8"));

  assert.deepEqual(persisted, request);
  assert.deepEqual(Object.keys(persisted).sort(), ["reason", "requestedAt", "runId", "source"]);
  assert.equal(persisted.runId, "monitor-run");
  assert.equal(persisted.reason, "cancelled from thread-phase monitor");
  assert.equal(persisted.source, "thread-phase-visualizer");
  assert.ok(Number.isFinite(Date.parse(persisted.requestedAt)));
  assert.ok(Date.parse(persisted.requestedAt) >= before);
  assert.deepEqual(store.readCancellation("monitor-run"), persisted);
});

test("requestCancellation safely rewrites an existing request", async () => {
  const first = store.requestCancellation("rewrite-run", { reason: "first", source: "test" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = store.requestCancellation("rewrite-run", { reason: "second", source: "test" });
  const persisted = JSON.parse(readFileSync(store.cancelFileFor("rewrite-run"), "utf8"));

  assert.equal(first.runId, second.runId);
  assert.equal(persisted.reason, "second");
  assert.deepEqual(persisted, second);
  assert.ok(Date.parse(second.requestedAt) >= Date.parse(first.requestedAt));
});

test("cancellation requests work after the store directory is recreated", () => {
  store.requestCancellation("recreated-run", { reason: "before recreation" });
  rmSync(store.STORE_DIR, { recursive: true, force: true });

  const request = store.requestCancellation("recreated-run", { reason: "after recreation" });

  assert.ok(existsSync(store.INDEX_FILE));
  assert.deepEqual(store.readCancellation("recreated-run"), request);
});

test("readCancellation returns undefined when the cancellation file is missing", () => {
  const file = store.cancelFileFor("missing-run");

  assert.equal(existsSync(file), false);
  assert.equal(store.readCancellation("missing-run"), undefined);
});

test("readCancellation handles corrupt files without crashing", () => {
  store.ensureStore();
  writeFileSync(store.cancelFileFor("corrupt-run"), "{not valid JSON", "utf8");
  assert.deepEqual(store.readCancellation("corrupt-run"), {
    runId: "corrupt-run",
    reason: "cancel requested",
  });
});
