import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-global-artifact-dedup-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
const store = await import("../lib/store.mjs");
const { ThreadPhaseMonitorComponent } = await import("../components/monitor.ts");

test.after(() => rmSync(storeDir, { recursive: true, force: true }));

const envelope = {
  schema: store.SCHEMA_VERSION,
  runId: "global-artifact-dedup-run",
  workflow: "projection-test",
};

function at(seconds) {
  return new Date(Date.UTC(2025, 0, 1, 0, 0, seconds)).toISOString();
}

function phaseEvent(phase, type, seconds, data) {
  return {
    ...envelope,
    eventId: `${phase}-${type}-${seconds}`,
    type,
    phase,
    timestamp: at(seconds),
    ...(data === undefined ? {} : { data }),
    ...(type === store.EVENT_TYPES.PHASE_START ? { status: store.STATUSES.RUNNING } : {}),
    ...(type === store.EVENT_TYPES.PHASE_END ? { status: store.STATUSES.SUCCESS } : {}),
  };
}

function artifactEvent(seconds, artifact, eventId) {
  return {
    ...envelope,
    ...(eventId === undefined ? {} : { eventId }),
    type: store.EVENT_TYPES.ARTIFACT,
    timestamp: at(seconds),
    artifact,
  };
}

function phase(name, start) {
  return [
    phaseEvent(name, store.EVENT_TYPES.PHASE_START, start),
    phaseEvent(name, store.EVENT_TYPES.PHASE_END, start + 1),
  ];
}

function nestedArtifacts(projected) {
  return projected.phases.flatMap((entry) => [
    ...(entry.artifacts || []),
    ...(entry.fanout?.items || []).flatMap((item) => item.artifacts || []),
  ]);
}

test("global dedup removes stale path and URL occurrences across phases without dropping inline artifacts", () => {
  const events = [
    ...phase("alpha", 1),
    ...phase("beta", 3),
    artifactEvent(10, {
      kind: "file", title: "stale path", path: "/tmp/shared.md", content: "stale path body",
      metadata: { phase: "alpha", producer: "first-path" },
    }),
    artifactEvent(11, {
      kind: "markdown", title: "alpha inline", content: "same inline body",
      metadata: { phase: "alpha", producer: "first-inline" },
    }),
    artifactEvent(12, {
      kind: "url", title: "stale URL", url: "https://example.test/shared", content: "stale URL body",
      metadata: { phase: "beta", producer: "first-url" },
    }),
    artifactEvent(13, {
      kind: "markdown", title: "beta inline", content: "same inline body",
      metadata: { phase: "beta", producer: "second-inline" },
    }),
    artifactEvent(14, {
      kind: "file", title: "latest path", path: "/tmp/shared.md", content: "latest path body",
      metadata: { phase: "beta", producer: "last-path" },
    }),
    artifactEvent(15, {
      kind: "url", title: "latest URL", url: "https://example.test/shared", content: "latest URL body",
      metadata: { phase: "alpha", producer: "last-url" },
    }),
  ];

  // Artifact events deliberately have no eventId. Matching survivors by the
  // optional eventId would make every occurrence look identical.
  const projected = store.projectRun(events);
  assert.deepEqual(projected.artifacts.map((artifact) => artifact.title), [
    "alpha inline", "beta inline", "latest path", "latest URL",
  ]);

  const alpha = projected.phases.find((entry) => entry.phase === "alpha");
  const beta = projected.phases.find((entry) => entry.phase === "beta");
  assert.deepEqual(alpha.artifacts.map((artifact) => artifact.title), ["alpha inline", "latest URL"]);
  assert.deepEqual(beta.artifacts.map((artifact) => artifact.title), ["beta inline", "latest path"]);
  assert.deepEqual(nestedArtifacts(projected).map((artifact) => artifact.title), [
    "alpha inline", "latest URL", "beta inline", "latest path",
  ]);
  assert.ok(nestedArtifacts(projected).every((artifact) => !artifact.title.startsWith("stale")));

  const latestPath = projected.artifacts.find((artifact) => artifact.title === "latest path");
  assert.equal(beta.artifacts[1], latestPath, "nested and global lists retain the exact same occurrence object");
  assert.deepEqual(latestPath.metadata, { phase: "beta", producer: "last-path" });
  assert.equal(latestPath.timestamp, at(14));
  assert.equal(latestPath.eventId, undefined);
});

test("global dedup removes stale path and URL occurrences across fanout items", () => {
  const fanout = "stages";
  const events = [
    phaseEvent(fanout, store.EVENT_TYPES.PHASE_START, 1),
    phaseEvent(fanout, store.EVENT_TYPES.PHASE_EVENT, 2, { kind: "fanout_start", total: 2 }),
    phaseEvent(fanout, store.EVENT_TYPES.PHASE_EVENT, 3, { kind: "fanout_item_start", itemId: "a", label: "A", index: 0 }),
    phaseEvent(fanout, store.EVENT_TYPES.PHASE_EVENT, 4, { kind: "fanout_item_end", itemId: "a", label: "A", index: 0, status: store.STATUSES.SUCCESS }),
    phaseEvent(fanout, store.EVENT_TYPES.PHASE_EVENT, 5, { kind: "fanout_item_start", itemId: "b", label: "B", index: 1 }),
    phaseEvent(fanout, store.EVENT_TYPES.PHASE_EVENT, 6, { kind: "fanout_item_end", itemId: "b", label: "B", index: 1, status: store.STATUSES.SUCCESS }),
    phaseEvent(fanout, store.EVENT_TYPES.PHASE_END, 7),
    artifactEvent(10, {
      title: "A stale path", path: "/tmp/fanout-shared.txt", metadata: { phase: fanout, itemId: "a", producer: "a-path" },
    }),
    artifactEvent(11, {
      title: "A inline", content: "inline", metadata: { phase: fanout, itemId: "a", producer: "a-inline" },
    }),
    artifactEvent(12, {
      title: "B stale URL", url: "https://example.test/fanout", metadata: { phase: fanout, itemId: "b", producer: "b-url" },
    }),
    artifactEvent(13, {
      title: "B latest path", path: "/tmp/fanout-shared.txt", metadata: { phase: fanout, itemId: "b", producer: "b-path" },
    }),
    artifactEvent(14, {
      title: "A latest URL", url: "https://example.test/fanout", metadata: { phase: fanout, itemId: "a", producer: "a-url" },
    }),
    artifactEvent(15, {
      title: "B inline", content: "inline", metadata: { phase: fanout, itemId: "b", producer: "b-inline" },
    }),
  ];

  const projected = store.projectRun(events);
  const items = projected.phases[0].fanout.items;
  const a = items.find((item) => item.itemId === "a");
  const b = items.find((item) => item.itemId === "b");

  assert.deepEqual(projected.artifacts.map((artifact) => artifact.title), [
    "A inline", "B latest path", "A latest URL", "B inline",
  ]);
  assert.deepEqual(a.artifacts.map((artifact) => artifact.title), ["A inline", "A latest URL"]);
  assert.deepEqual(b.artifacts.map((artifact) => artifact.title), ["B latest path", "B inline"]);
  assert.equal(a.artifacts[1], projected.artifacts[2]);
  assert.equal(b.artifacts[0], projected.artifacts[1]);
  assert.ok(nestedArtifacts(projected).every((artifact) => !artifact.title.includes("stale")));
});

test("monitor renders exactly the latest nested artifact after cross-phase dedup", () => {
  const events = [
    {
      ...envelope,
      eventId: "workflow-start",
      type: store.EVENT_TYPES.WORKFLOW_START,
      status: store.STATUSES.RUNNING,
      timestamp: at(0),
    },
    ...phase("old-phase", 1),
    ...phase("latest-phase", 3),
    artifactEvent(5, {
      kind: "markdown", title: "Stale report", path: "/tmp/rendered.md", content: "stale body",
      metadata: { phase: "old-phase" },
    }),
    artifactEvent(6, {
      kind: "markdown", title: "Latest report", path: "/tmp/rendered.md", content: "latest body",
      metadata: { phase: "latest-phase" },
    }),
    {
      ...envelope,
      eventId: "workflow-end",
      type: store.EVENT_TYPES.WORKFLOW_END,
      status: store.STATUSES.SUCCESS,
      timestamp: at(7),
    },
  ];
  const projected = store.projectRun(events);
  assert.equal(projected.phases.find((entry) => entry.phase === "old-phase").artifacts.length, 0);

  const theme = {
    fg(_color, value) { return String(value); },
    bold(value) { return String(value); },
  };
  const monitor = new ThreadPhaseMonitorComponent(
    "/tmp",
    undefined,
    theme,
    () => {},
    () => {},
    () => {},
    () => [projected],
  );

  monitor.handleInput("\r"); // list -> detail, old-phase selected
  monitor.handleInput("\x1b[B"); // latest-phase
  monitor.handleInput("\r"); // reveal its surviving artifact
  const rendered = monitor.render(90).join("\n");
  assert.doesNotMatch(rendered, /Stale report|stale body/);
  assert.equal((rendered.match(/Latest report/g) || []).length, 1);
});
