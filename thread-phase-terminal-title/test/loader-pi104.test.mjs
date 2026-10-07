import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Real-host contract: the installed Pi 1.0.4 extension loader must load this
// title-only extension cleanly, twice, with no residual registrations. There is
// no fallback to an older SDK: an explicitly supplied but missing or
// version-mismatched PI_HANDOFF_SDK_DIR fails this test.
const sdkDir = process.env.PI_HANDOFF_SDK_DIR;
const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "../index.ts");
const repoRoot = resolve(here, "../..");

test("installed Pi 1.0.4 Jiti loader loads the title-only extension repeatedly", async (t) => {
  if (!sdkDir) return t.skip("PI_HANDOFF_SDK_DIR is not set; point it at an installed @earendil-works/pi-coding-agent 1.0.4 package directory");
  const manifest = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));
  assert.equal(manifest.version, "1.0.4", "host smoke accidentally resolved a non-contract Pi version");
  const loader = await import(pathToFileURL(join(sdkDir, "dist/core/extensions/loader.js")));

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
