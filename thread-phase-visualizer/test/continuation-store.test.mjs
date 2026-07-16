import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  CONTINUATION_STATE_FILENAME,
  CONTINUATION_TIMESTAMPS_FILENAME,
  continuedRunsFile,
  createContinuationClaimantId,
  currentProcessStartIdentity,
  loadContinuedRuns,
  loadPendingContinuationRecords,
  loadPendingContinuations,
  markContinuationDelivered,
  persistContinuationClaim,
  persistContinuedRuns,
  releaseContinuationClaim,
  relinquishContinuationClaims,
  pruneContinuedRuns,
  shouldAutoContinue,
} from "../lib/continuation-store.mjs";

function persistedRecords(storeDir) {
  return JSON.parse(readFileSync(continuedRunsFile(storeDir), "utf8"));
}

function persistedIds(storeDir) {
  return persistedRecords(storeDir);
}

function persistedTimestamps(storeDir) {
  return JSON.parse(readFileSync(join(storeDir, CONTINUATION_TIMESTAMPS_FILENAME), "utf8"));
}

function temporaryStore(t) {
  const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-continuations-"));
  t.after(() => rmSync(storeDir, { recursive: true, force: true }));
  return storeDir;
}

test("loadContinuedRuns handles a missing persistence file", (t) => {
  const storeDir = temporaryStore(t);

  assert.deepEqual(Array.from(loadContinuedRuns({ storeDir })), []);
  assert.equal(existsSync(continuedRunsFile(storeDir)), false);
});

test("malformed authoritative state never falls back to lossy legacy mirrors", (t) => {
  const storeDir = temporaryStore(t);
  writeFileSync(continuedRunsFile(storeDir), `${JSON.stringify(["mirrored-pending"])}\n`);
  writeFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "{not-json");
  assert.throws(() => loadPendingContinuationRecords({ storeDir }), /Invalid authoritative continuation state JSON/);

  writeFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), `${JSON.stringify({ schema: "thread-phase-continuations/v999", records: [] })}\n`);
  assert.throws(() => loadContinuedRuns({ storeDir }), /Unsupported authoritative continuation state schema or shape/);

  const malformedPending = `${JSON.stringify({
    schema: "thread-phase-continuations/v3",
    records: [{ runId: "must-not-disappear", deliveryId: "delivery", state: "pending", updatedAt: "not-a-date" }],
  })}\n`;
  writeFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), malformedPending);
  assert.throws(() => loadPendingContinuationRecords({ storeDir }), /updatedAt is required/);
  assert.equal(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"), malformedPending);
});

test("pending continuation claims enforce an independent hard bound", (t) => {
  const storeDir = temporaryStore(t);
  assert.equal(persistContinuationClaim("pending-one", { storeDir, maxPendingEntries: 1 }).claimed, true);
  assert.throws(
    () => persistContinuationClaim("pending-two", { storeDir, maxPendingEntries: 1 }),
    /Pending continuation limit reached \(1\)/,
  );
  assert.deepEqual(loadPendingContinuationRecords({ storeDir }).map((record) => record.runId), ["pending-one"]);
});

test("expired claimant leases permit retry despite a still-live PID", (t) => {
  const storeDir = temporaryStore(t);
  const first = persistContinuationClaim("lease-retry", {
    storeDir,
    claimantId: "old-runtime",
    claimantProcessStart: null,
    claimLeaseMs: 1,
    now: "2000-01-01T00:00:00.000Z",
  });
  const retried = persistContinuationClaim("lease-retry", {
    storeDir,
    retryPending: true,
    claimantId: "replacement-runtime",
  });
  assert.equal(retried.claimed, true);
  assert.equal(retried.deliveryId, first.deliveryId);
});

test("persisted continuation ids load after a simulated extension restart", (t) => {
  const storeDir = temporaryStore(t);
  const firstExtensionSet = new Set(["run-a", "run-b"]);

  persistContinuedRuns(firstExtensionSet, { storeDir });
  const restartedExtensionSet = loadContinuedRuns({ storeDir });

  assert.ok(restartedExtensionSet instanceof Set);
  assert.notEqual(restartedExtensionSet, firstExtensionSet);
  assert.deepEqual(Array.from(restartedExtensionSet), ["run-a", "run-b"]);
  assert.equal(restartedExtensionSet.has("run-a"), true);
  assert.deepEqual(persistedIds(storeDir), ["run-a", "run-b"]);
  assert.ok(Object.values(persistedTimestamps(storeDir)).every((timestamp) => Number.isFinite(Date.parse(timestamp))));
});

test("shouldAutoContinue rejects non-success runs even when they opt in", () => {
  assert.equal(shouldAutoContinue({ normalizedStatus: "running", metadata: { autoContinue: true } }), false);
  assert.equal(shouldAutoContinue({ normalizedStatus: "failed", metadata: { autoContinue: "always" } }), false);
  assert.equal(shouldAutoContinue({ normalizedStatus: "success", metadata: { autoContinue: true } }), true);
  assert.equal(shouldAutoContinue(undefined), false);
});

test("persistContinuedRuns atomically merges the latest JSON with new run ids", (t) => {
  const storeDir = temporaryStore(t);
  const file = continuedRunsFile(storeDir);
  writeFileSync(file, "[\"old-run\"]\n", "utf8");

  const requested = new Set(["new-run", "newer-run"]);
  persistContinuedRuns(requested, { storeDir });

  const persisted = persistedRecords(storeDir);
  assert.deepEqual(persisted, ["old-run", "new-run", "newer-run"]);
  assert.deepEqual(Array.from(requested), persisted);
  assert.ok(persisted.every((runId) => typeof runId === "string"));
  assert.ok(Object.values(persistedTimestamps(storeDir)).every((timestamp) => Number.isFinite(Date.parse(timestamp))));
  assert.deepEqual(readdirSync(storeDir).sort(), ["continuations.json", "continued-runs.json", "continued-runs.timestamps.json"]);
});

test("competing stale writers preserve on-disk order at continuation capacity", async (t) => {
  const storeDir = temporaryStore(t);
  const barrier = join(storeDir, "release-writers");
  const moduleUrl = new URL("../lib/continuation-store.mjs", import.meta.url).href;
  const initialCount = 499;
  const writerCount = 12;
  persistContinuedRuns(Array.from({ length: initialCount }, (_, index) => `old-${index}`), { storeDir });
  const writerScript = `
    import { existsSync, writeFileSync } from "node:fs";
    const [moduleUrl, storeDir, runId, readyFile, barrier] = process.argv.slice(1);
    const { loadContinuedRuns, persistContinuedRuns } = await import(moduleUrl);
    const staleSnapshot = loadContinuedRuns({ storeDir });
    writeFileSync(readyFile, "ready");
    while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 5));
    staleSnapshot.add(runId);
    persistContinuedRuns(staleSnapshot, { storeDir });
  `;

  const children = Array.from({ length: writerCount }, (_, index) => {
    const readyFile = join(storeDir, `writer-${index}.ready`);
    const child = spawn(process.execPath, ["--input-type=module", "-e", writerScript, moduleUrl, storeDir, `writer-run-${index}`, readyFile, barrier], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let spawnError;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { spawnError = error; });
    // Resolve on close rather than rejecting on exit so a child failure cannot
    // become an unhandled rejection while the parent is still at the barrier.
    const completed = new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal, error: spawnError, stderr }));
    });
    return { index, readyFile, child, completed };
  });

  try {
    const readyDeadline = Date.now() + 10_000;
    while (!children.every(({ readyFile }) => existsSync(readyFile))) {
      assert.ok(Date.now() < readyDeadline, "competing writers did not reach the persistence barrier");
      await delay(10);
    }
    writeFileSync(barrier, "release", "utf8");
    const outcomes = await Promise.all(children.map(({ completed }) => completed));
    for (const [index, outcome] of outcomes.entries()) {
      assert.equal(outcome.error, undefined, `writer ${index} failed to spawn: ${outcome.error?.message || "unknown error"}`);
      assert.equal(outcome.code, 0, `writer ${index} exited ${outcome.code ?? outcome.signal}: ${outcome.stderr}`);
    }
  } finally {
    // Never leave children blocked if readiness or completion assertions fail.
    // Release first so cooperative children can finish, terminate any process
    // still alive, and await every close before the temporary store is removed.
    if (!existsSync(barrier)) writeFileSync(barrier, "release", "utf8");
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.allSettled(children.map(({ completed }) => completed));
  }

  const persisted = persistedIds(storeDir);
  const writerIds = Array.from({ length: writerCount }, (_, index) => `writer-run-${index}`);
  const retainedOldIds = Array.from({ length: 488 }, (_, index) => `old-${index + 11}`);
  assert.equal(persisted.length, 500);
  assert.deepEqual(persisted.slice(0, retainedOldIds.length), retainedOldIds,
    "writers must append deltas without reordering ids already retained on disk");
  assert.deepEqual(new Set(persisted.slice(retainedOldIds.length)), new Set(writerIds));
  assert.equal(readdirSync(storeDir).some((name) => name.endsWith(".lock") || name.endsWith(".tmp")), false);
});

test("single-run claims persist before success and deduplicate after reload", (t) => {
  const storeDir = temporaryStore(t);

  const first = persistContinuationClaim("claimed-run", { storeDir });
  assert.equal(first.claimed, true);
  assert.equal(first.runs.has("claimed-run"), true);
  assert.equal(loadContinuedRuns({ storeDir }).has("claimed-run"), true);

  const restartedClaim = persistContinuationClaim("claimed-run", { storeDir });
  assert.equal(restartedClaim.claimed, false);
  assert.deepEqual(Array.from(restartedClaim.runs), ["claimed-run"]);
});

test("pending claim survives a pre-enqueue crash and startup marks the retry delivered", (t) => {
  const storeDir = temporaryStore(t);
  const moduleUrl = new URL("../lib/continuation-store.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { persistContinuationClaim } = await import(process.argv[1]);
    persistContinuationClaim("retryable-run", { storeDir: process.argv[2] });
  `, moduleUrl, storeDir], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);

  const pending = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  assert.equal(pending.records[0].state, "pending");
  assert.deepEqual(Array.from(loadPendingContinuations({ storeDir })), ["retryable-run"]);
  assert.equal(persistContinuationClaim("retryable-run", { storeDir }).claimed, false);

  const startupRetry = persistContinuationClaim("retryable-run", { storeDir, retryPending: true });
  assert.equal(startupRetry.claimed, true);
  assert.equal(markContinuationDelivered("retryable-run", { storeDir }).delivered, true);
  const delivered = JSON.parse(readFileSync(join(storeDir, CONTINUATION_STATE_FILENAME), "utf8"));
  assert.equal(delivered.records[0].state, "delivered");
  assert.deepEqual(Array.from(loadPendingContinuations({ storeDir })), []);
  assert.equal(persistContinuationClaim("retryable-run", { storeDir, retryPending: true }).claimed, false);
});

test("pending claims retain a stable durable delivery id across reload and retry", (t) => {
  const storeDir = temporaryStore(t);
  const claimantId = createContinuationClaimantId();
  const first = persistContinuationClaim("stable-delivery-run", { storeDir, claimantId });

  const [reloaded] = loadPendingContinuationRecords({ storeDir });
  const retried = persistContinuationClaim("stable-delivery-run", {
    storeDir,
    retryPending: true,
    claimantId,
  });

  assert.ok(first.deliveryId);
  assert.equal(reloaded.deliveryId, first.deliveryId);
  assert.equal(retried.deliveryId, first.deliveryId);
});

test("session shutdown relinquishes only its claims while the process remains alive", (t) => {
  const storeDir = temporaryStore(t);
  const owner = createContinuationClaimantId();
  const other = createContinuationClaimantId();
  const processStart = currentProcessStartIdentity();
  assert.equal(persistContinuationClaim("shutdown-run", { storeDir, claimantId: owner, claimantProcessStart: processStart }).claimed, true);
  assert.equal(persistContinuationClaim("other-run", { storeDir, claimantId: other, claimantProcessStart: processStart }).claimed, true);

  assert.equal(persistContinuationClaim("shutdown-run", { storeDir, retryPending: true, claimantId: other, claimantProcessStart: processStart }).claimed, false,
    "a genuinely active claimant must not be stolen");
  const relinquished = relinquishContinuationClaims({ storeDir, claimantId: owner, claimantProcessStart: processStart });
  assert.equal(relinquished.relinquished, 1);
  assert.equal(persistContinuationClaim("shutdown-run", { storeDir, retryPending: true, claimantId: other, claimantProcessStart: processStart }).claimed, true);
  assert.equal(persistContinuationClaim("other-run", { storeDir, retryPending: true, claimantId: owner, claimantProcessStart: processStart }).claimed, false,
    "shutdown must not relinquish another runtime's claim");
});

test("startup retry does not steal a pending claim from a live concurrent claimant", async (t) => {
  const storeDir = temporaryStore(t);
  const moduleUrl = new URL("../lib/continuation-store.mjs", import.meta.url).href;
  const ready = join(storeDir, "claim.ready");
  const release = join(storeDir, "claim.release");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { existsSync, writeFileSync } from "node:fs";
    const { persistContinuationClaim } = await import(process.argv[1]);
    persistContinuationClaim("concurrent-run", { storeDir: process.argv[2] });
    writeFileSync(process.argv[3], "ready");
    while (!existsSync(process.argv[4])) await new Promise((resolve) => setTimeout(resolve, 5));
  `, moduleUrl, storeDir, ready, release], { stdio: ["ignore", "pipe", "pipe"] });
  const completed = new Promise((resolve) => child.once("close", resolve));
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(ready)) {
      assert.ok(Date.now() < deadline, "claimant did not become ready");
      await delay(10);
    }
    assert.equal(persistContinuationClaim("concurrent-run", { storeDir, retryPending: true }).claimed, false);
  } finally {
    writeFileSync(release, "release");
    await completed;
  }
});

test("release remains a compatibility escape hatch for pending claims", (t) => {
  const storeDir = temporaryStore(t);
  assert.equal(persistContinuationClaim("released-run", { storeDir }).claimed, true);
  assert.equal(releaseContinuationClaim("released-run", { storeDir }).released, true);
  assert.equal(persistContinuationClaim("released-run", { storeDir }).claimed, true);
});

test("stale snapshots cannot prune competing claims at capacity", (t) => {
  const storeDir = temporaryStore(t);
  persistContinuedRuns(Array.from({ length: 500 }, (_, index) => `old-${index}`), { storeDir });
  const staleA = loadContinuedRuns({ storeDir });
  const staleB = loadContinuedRuns({ storeDir });

  staleA.add("claim-a");
  persistContinuedRuns(staleA, { storeDir });
  staleB.add("claim-b");
  persistContinuedRuns(staleB, { storeDir });

  const persisted = loadContinuedRuns({ storeDir });
  assert.equal(persisted.size, 500);
  assert.equal(persisted.has("claim-a"), true);
  assert.equal(persisted.has("claim-b"), true);
  assert.equal(persisted.has("old-0"), false, "a stale snapshot must not resurrect pruned history");
  assert.equal(persisted.has("old-1"), false);
  assert.deepEqual(Array.from(persisted).slice(-2), ["claim-a", "claim-b"]);
});

test("a zero-capacity store never reports an undurable claim", (t) => {
  const storeDir = temporaryStore(t);

  const claim = persistContinuationClaim("cannot-retain", { storeDir, maxEntries: 0 });

  assert.equal(claim.claimed, false);
  assert.deepEqual(Array.from(claim.runs), []);
  assert.deepEqual(persistedRecords(storeDir), []);
});

test("a fresh lock is reclaimed when its owner process has exited", (t) => {
  const storeDir = temporaryStore(t);
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(child.status, 0);
  const lockFile = `${continuedRunsFile(storeDir)}.lock`;
  writeFileSync(lockFile, `${child.stdout}:crashed-owner`, { mode: 0o600 });

  const startedAt = Date.now();
  const claim = persistContinuationClaim("after-crash", { storeDir });

  assert.equal(claim.claimed, true);
  assert.ok(Date.now() - startedAt < 1_000, "dead-owner lock should be reclaimed without waiting for lock timeout");
  assert.equal(existsSync(lockFile), false);
});

test("an abandoned same-process lock is reclaimed after an extension reload", (t) => {
  const storeDir = temporaryStore(t);
  const lockFile = `${continuedRunsFile(storeDir)}.lock`;
  writeFileSync(lockFile, `${process.pid}:abandoned-extension-instance`, { mode: 0o600 });

  const startedAt = Date.now();
  const claim = persistContinuationClaim("after-reload", { storeDir });

  assert.equal(claim.claimed, true);
  assert.ok(Date.now() - startedAt < 1_000, "same-process abandoned lock should be reclaimed immediately");
  assert.equal(existsSync(lockFile), false);
});

test("timestamp retention expires claims older than 24 hours and permits a fresh atomic claim", (t) => {
  const storeDir = temporaryStore(t);
  const now = Date.parse("2026-06-12T12:00:00.000Z");
  writeFileSync(continuedRunsFile(storeDir), JSON.stringify([
    { runId: "expired", continuedAt: "2026-06-11T11:59:59.999Z" },
    { runId: "boundary", continuedAt: "2026-06-11T12:00:00.000Z" },
    { runId: "recent", continuedAt: "2026-06-12T11:00:00.000Z" },
  ]));

  const loaded = loadContinuedRuns({ storeDir, now });
  assert.deepEqual(Array.from(loaded), ["boundary", "recent"]);
  assert.deepEqual(persistedIds(storeDir), ["boundary", "recent"]);

  const reclaimed = persistContinuationClaim("expired", { storeDir, now });
  assert.equal(reclaimed.claimed, true);
  assert.deepEqual(Array.from(reclaimed.runs), ["boundary", "recent", "expired"]);
  assert.equal(persistedTimestamps(storeDir).expired, "2026-06-12T12:00:00.000Z");
});

test("legacy string arrays use file age deterministically for 24-hour retention", (t) => {
  const now = Date.parse("2026-06-12T12:00:00.000Z");
  const recentStore = temporaryStore(t);
  const recentFile = continuedRunsFile(recentStore);
  const recentTimestamp = new Date(now - 2 * 60 * 60 * 1000);
  writeFileSync(recentFile, JSON.stringify(["legacy-a", "legacy-b"]));
  utimesSync(recentFile, recentTimestamp, recentTimestamp);

  const recent = loadContinuedRuns({ storeDir: recentStore, now });
  assert.deepEqual(Array.from(recent), ["legacy-a", "legacy-b"]);
  assert.deepEqual(persistedRecords(recentStore), ["legacy-a", "legacy-b"]);
  assert.deepEqual(persistedTimestamps(recentStore), {
    "legacy-a": recentTimestamp.toISOString(),
    "legacy-b": recentTimestamp.toISOString(),
  });

  const expiredStore = temporaryStore(t);
  const expiredFile = continuedRunsFile(expiredStore);
  const expiredTimestamp = new Date(now - 24 * 60 * 60 * 1000 - 1);
  writeFileSync(expiredFile, JSON.stringify(["expired-legacy"]));
  utimesSync(expiredFile, expiredTimestamp, expiredTimestamp);

  assert.deepEqual(Array.from(loadContinuedRuns({ storeDir: expiredStore, now })), []);
  assert.deepEqual(persistedRecords(expiredStore), []);
});

test("timestamp and capacity pruning compose while preserving valid canonical JSON", (t) => {
  const storeDir = temporaryStore(t);
  const now = "2026-06-12T12:00:00.000Z";
  const recent = Array.from({ length: 510 }, (_, index) => ({
    runId: `recent-${index}`,
    continuedAt: new Date(Date.parse(now) - (510 - index) * 1000).toISOString(),
  }));
  writeFileSync(continuedRunsFile(storeDir), JSON.stringify([
    { runId: "too-old", continuedAt: "2026-06-10T00:00:00.000Z" },
    ...recent,
  ]));

  const loaded = loadContinuedRuns({ storeDir, now });
  const persisted = persistedRecords(storeDir);
  assert.equal(loaded.size, 500);
  assert.equal(loaded.has("too-old"), false);
  assert.equal(loaded.has("recent-0"), false);
  assert.equal(loaded.has("recent-10"), true);
  assert.deepEqual(persisted, Array.from(loaded));
  assert.ok(persisted.every((runId) => typeof runId === "string"));
  assert.deepEqual(Object.keys(persistedTimestamps(storeDir)), persisted);
});

test("continuation history pruning keeps only the latest 500 entries", (t) => {
  const storeDir = temporaryStore(t);
  const runs = new Set(Array.from({ length: 620 }, (_, index) => `run-${index}`));

  pruneContinuedRuns(runs);
  persistContinuedRuns(runs, { storeDir });
  const persisted = persistedIds(storeDir);

  assert.equal(runs.size, 500);
  assert.equal(persisted.length, 500);
  assert.equal(persisted[0], "run-120");
  assert.equal(persisted.at(-1), "run-619");
  assert.deepEqual(persistedIds(storeDir), Array.from(runs));
});

test("loading an oversized legacy file prunes and atomically normalizes it", (t) => {
  const storeDir = temporaryStore(t);
  const file = continuedRunsFile(storeDir);
  const legacy = Array.from({ length: 503 }, (_, index) => `legacy-${index}`);
  writeFileSync(file, JSON.stringify([...legacy, "legacy-502", null, ""]), "utf8");

  const loaded = loadContinuedRuns({ storeDir });
  const persisted = persistedRecords(storeDir);

  assert.equal(loaded.size, 500);
  assert.equal(persisted.length, 500);
  assert.deepEqual(persisted, Array.from(loaded));
  assert.ok(persisted.every((runId) => typeof runId === "string" && runId.length > 0));
});

test("canonical continuation history remains stable and claimed across consecutive reloads", (t) => {
  const storeDir = temporaryStore(t);
  const file = continuedRunsFile(storeDir);
  const legacy = Array.from({ length: 503 }, (_, index) => `legacy-${index}`);
  writeFileSync(file, JSON.stringify([
    ...legacy,
    "legacy-0",
    null,
    "legacy-1",
    "",
    "legacy-502",
    "legacy-0",
  ]), "utf8");

  const firstReload = loadContinuedRuns({ storeDir });
  const afterFirstReload = persistedIds(storeDir);
  const firstRepeatedClaim = persistContinuationClaim("legacy-0", { storeDir });
  const secondRepeatedClaim = persistContinuationClaim("legacy-0", { storeDir });
  const secondReload = loadContinuedRuns({ storeDir });
  const afterSecondReload = persistedIds(storeDir);
  const thirdReload = loadContinuedRuns({ storeDir });

  const expected = [...Array.from({ length: 496 }, (_, index) => `legacy-${index + 5}`), "legacy-501", "legacy-1", "legacy-502", "legacy-0"];
  assert.equal(expected.length, 500);
  assert.deepEqual(Array.from(firstReload), expected);
  assert.deepEqual(afterFirstReload, expected);
  assert.equal(firstRepeatedClaim.claimed, false);
  assert.equal(secondRepeatedClaim.claimed, false);
  assert.deepEqual(Array.from(firstRepeatedClaim.runs), expected);
  assert.deepEqual(Array.from(secondRepeatedClaim.runs), expected);
  assert.deepEqual(Array.from(secondReload), expected);
  assert.deepEqual(afterSecondReload, expected);
  assert.deepEqual(Array.from(thirdReload), expected);
  assert.deepEqual(readdirSync(storeDir).sort(), ["continuations.json", "continued-runs.json", "continued-runs.timestamps.json"]);
});
