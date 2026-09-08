import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Exercise Pi's actual Jiti loader, not native test imports or peer stubs.
const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", sdkUrl));

function context(cwd) {
  return {
    cwd,
    mode: "tui",
    hasUI: false,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "reload-session", getBranch: () => [] },
  };
}

async function emit(extension, event, ctx) {
  for (const handler of extension.handlers.get(event) || []) await handler({}, ctx);
}

test("same-process Pi reload replaces cached continuation and supervision APIs before session_start", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "pi-continuation-reload-"));
  const fixture = join(temp, "visualizer");
  const storeDir = join(temp, "store");
  const previousStore = process.env.PI_THREAD_PHASE_STORE_DIR;
  process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
  t.after(() => {
    if (previousStore === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
    else process.env.PI_THREAD_PHASE_STORE_DIR = previousStore;
    rmSync(temp, { recursive: true, force: true });
  });
  cpSync(new URL("../", import.meta.url), fixture, {
    recursive: true,
    filter: (source) => !source.endsWith("/test"),
  });
  const entry = join(fixture, "index.ts");
  const storeFile = join(fixture, "lib", "continuation-store.mjs");
  const supervisionStoreFile = join(fixture, "lib", "supervision-store.mjs");
  const currentEntry = readFileSync(entry, "utf8");
  const currentStore = readFileSync(storeFile, "utf8");
  const currentSupervisionStore = readFileSync(supervisionStoreFile, "utf8");
  const oldStore = currentStore.replace("export function continuationEligibility(", "function continuationEligibility(");
  const oldSupervisionStore = currentSupervisionStore.replace("export function ensureProgressReview(", "function ensureProgressReview(");
  assert.notEqual(oldStore, currentStore);
  assert.notEqual(oldSupervisionStore, currentSupervisionStore);
  writeFileSync(storeFile, oldStore);
  writeFileSync(supervisionStoreFile, oldSupervisionStore);
  writeFileSync(entry, `import * as store from "./lib/continuation-store.mjs";
import * as supervision from "./lib/supervision-store.mjs";
export default function () {
  if (store.continuationEligibility !== undefined || supervision.ensureProgressReview !== undefined) throw new Error("old APIs were not loaded");
}
`);
  const first = await loadExtensions([entry], temp);
  assert.deepEqual(first.errors, []);
  assert.equal(first.extensions.length, 1);

  // Upgrade on disk without restarting Node: the unversioned native module stays old.
  writeFileSync(storeFile, currentStore);
  writeFileSync(supervisionStoreFile, currentSupervisionStore);
  writeFileSync(entry, currentEntry);
  const cached = await import(pathToFileURL(storeFile).href);
  const cachedSupervision = await import(pathToFileURL(supervisionStoreFile).href);
  assert.equal(cached.continuationEligibility, undefined, "fixture must reproduce the stale continuation module");
  assert.equal(cachedSupervision.ensureProgressReview, undefined, "fixture must reproduce the stale supervision module");

  const runStore = await import(pathToFileURL(join(fixture, "lib", "store.mjs")).href);
  const run = runStore.createRun({
    workflow: "reload-test", cwd: temp,
    metadata: { sessionId: "reload-session", continuationMode: "none", supervisionMode: "main-agent" },
  });

  for (let reload = 0; reload < 2; reload++) {
    const loaded = await loadExtensions([entry], temp);
    assert.deepEqual(loaded.errors, [], `reload ${reload} must initialize the extension`);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    const ctx = context(temp);
    try {
      // The existing terminal run exercises continuationEligibility at startup.
      await emit(extension, "session_start", ctx);
      await emit(extension, "agent_settled", ctx);
    } finally {
      await emit(extension, "session_shutdown", ctx);
    }
  }
});

test("content-revision imports reuse unchanged modules and refresh changed implementations", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "pi-revision-import-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const { importFresh } = await import("../lib/import-fresh.mjs");
  const file = join(temp, "api.mjs");
  const url = pathToFileURL(file);
  writeFileSync(file, 'export const value = "first";');
  const first = await importFresh(url);
  assert.equal(first.value, "first");
  assert.equal(await importFresh(url), first, "unchanged reloads should not create new module instances");
  writeFileSync(file, 'export const value = "second";');
  const second = await importFresh(url);
  assert.equal(second.value, "second");
  assert.notEqual(second, first);
});
