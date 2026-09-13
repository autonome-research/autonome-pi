import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const GLOBAL_PACKAGE = "/home/velvet/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "../index.ts");
const repoRoot = resolve(here, "../..");

test("deployed Pi v0.85.1 Jiti loader loads the title-only extension repeatedly", async (t) => {
  let manifest;
  try { manifest = JSON.parse(readFileSync(`${GLOBAL_PACKAGE}/package.json`, "utf8")); }
  catch { return t.skip("deployed global Pi package is unavailable"); }
  assert.equal(manifest.version, "0.85.1", "host smoke accidentally resolved a non-contract Pi version");
  const loader = await import(pathToFileURL(`${GLOBAL_PACKAGE}/dist/core/extensions/loader.js`));

  for (let pass = 0; pass < 2; pass++) {
    loader.clearExtensionCache();
    const loaded = await loader.loadExtensions([extensionPath], repoRoot);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.deepEqual([...extension.tools.keys()], []);
    assert.deepEqual([...extension.commands.keys()], []);
    assert.deepEqual([...extension.messageRenderers.keys()], []);
    assert.deepEqual([...extension.entryRenderers.keys()], []);
    assert.deepEqual([...extension.handlers.keys()].sort(), ["session_info_changed", "session_shutdown", "session_start"]);
  }
});
