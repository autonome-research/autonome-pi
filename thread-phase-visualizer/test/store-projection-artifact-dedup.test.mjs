import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-artifact-projection-store-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
const store = await import(`../lib/store.mjs?projection-artifact-dedup=${Date.now()}`);

test.after(() => rmSync(storeDir, { recursive: true, force: true }));

const envelope = {
  schema: store.SCHEMA_VERSION,
  runId: "artifact-dedup-run",
  workflow: "projection-test",
  type: store.EVENT_TYPES.ARTIFACT,
};

function artifactEvent(eventId, seconds, artifact) {
  return {
    ...envelope,
    eventId,
    timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, seconds)).toISOString(),
    artifact,
  };
}

test("projectRun deduplicates repeated artifact paths and keeps the latest event", () => {
  const oldPath = artifactEvent("path-old", 1, {
    kind: "file",
    title: "old report",
    path: "/tmp/report.md",
    preview: "old content",
  });
  const latestPath = artifactEvent("path-latest", 3, {
    kind: "file",
    title: "latest report",
    path: "/tmp/report.md",
    preview: "latest content",
  });
  const otherPath = artifactEvent("path-other", 4, {
    kind: "file",
    title: "other report",
    path: "/tmp/other.md",
  });

  // Projection sorts events by timestamp, so "latest" is based on event time
  // rather than the caller's input order.
  const projected = store.projectRun([otherPath, latestPath, oldPath]);

  assert.equal(projected.artifacts.length, 2);
  assert.deepEqual(projected.artifacts.map((artifact) => artifact.path), [
    "/tmp/report.md",
    "/tmp/other.md",
  ]);
  assert.deepEqual(projected.artifacts[0], {
    ...latestPath.artifact,
    eventId: latestPath.eventId,
    timestamp: latestPath.timestamp,
  });
});

test("artifact last-occurrence ordering preserves interleaved inline entries and URL identity", () => {
  const events = [
    { path: "/tmp/report" },
    { content: "inline first" },
    { url: "/tmp/report" },
    { path: "/tmp/other" },
    { url: "/tmp/report" },
    { content: "inline second" },
    { path: "/tmp/report" },
  ].map((artifact, index) => artifactEvent(`mixed-${index}`, index, artifact));
  const projected = store.projectRun(events);
  assert.deepEqual(projected.artifacts.map((artifact) => artifact.eventId), ["mixed-1", "mixed-3", "mixed-4", "mixed-5", "mixed-6"]);
});

test("50,000 artifact events with repeated paths project within a bounded subprocess", () => {
  // A child-process deadline can interrupt a synchronous quadratic regression;
  // an ordinary node:test timeout cannot interrupt a blocked event loop.
  const source = `
    import assert from 'node:assert/strict';
    import { projectRun, SCHEMA_VERSION } from ${JSON.stringify(new URL("../lib/store.mjs", import.meta.url).href)};
    const count = 25_000;
    const events = Array.from({ length: count * 2 }, (_, index) => ({
      schema: SCHEMA_VERSION, runId: 'large-artifacts', workflow: 'projection-test',
      eventId: 'load-' + index, type: 'artifact',
      timestamp: new Date(Date.UTC(2025, 0, 1) + index).toISOString(),
      artifact: { path: '/tmp/path-' + (index % count) },
    }));
    const projected = projectRun(events);
    assert.equal(projected.artifacts.length, count);
    assert.ok(projected.artifacts.every((artifact, index) => artifact.eventId === 'load-' + (count + index)));
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", source], { timeout: 15_000, encoding: "utf8" });
});

test("projectRun preserves distinct inline-only artifacts even when their content matches", () => {
  const firstInline = artifactEvent("inline-first", 1, {
    kind: "markdown",
    title: "inline result",
    content: "same content",
  });
  const secondInline = artifactEvent("inline-second", 2, {
    kind: "markdown",
    title: "inline result",
    content: "same content",
  });

  const projected = store.projectRun([firstInline, secondInline]);

  assert.equal(projected.artifacts.length, 2);
  assert.deepEqual(projected.artifacts.map((artifact) => artifact.eventId), [
    "inline-first",
    "inline-second",
  ]);
  assert.ok(projected.artifacts.every((artifact) => artifact.content === "same content"));
});
