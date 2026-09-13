import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "../index.ts");
const repoRoot = resolve(here, "../..");
const pi = "/home/velvet/.npm-global/bin/pi";
const packageFile = "/home/velvet/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/package.json";

// Opt-in because this starts the real interactive CLI in a PTY and depends on the
// deployed terminal stack. The focused test command documents the explicit gate.
test("deployed bundled v0.85.1 PTY orders stock then extension OSC and stays quiet", { skip: process.env.PI_TITLE_PTY_SMOKE !== "1" }, () => {
  assert.equal(JSON.parse(readFileSync(packageFile, "utf8")).version, "0.85.1");
  const root = mkdtempSync(join(tmpdir(), "thread-phase-title-pty-"));
  try {
    const command = `cd ${JSON.stringify(repoRoot)} && exec ${JSON.stringify(pi)} --offline --approve --no-session --no-extensions -e ${JSON.stringify(extensionPath)}`;
    const child = spawnSync("bash", ["-lc", `(sleep 0.7; printf '\\004') | script -qefc ${JSON.stringify(command)} /dev/null`], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PI_THREAD_PHASE_STATUS_BRIDGE: "1",
        PI_THREAD_PHASE_TERMINAL_TITLE: "1",
        PI_THREAD_PHASE_STATUS_BRIDGE_DIR: root,
        PI_OFFLINE: "1",
        TERM: process.env.TERM || "xterm-256color",
      },
    });
    assert.notEqual(child.error?.code, "ETIMEDOUT", child.error?.message);
    const output = `${child.stdout || ""}${child.stderr || ""}`;
    const titles = [...output.matchAll(/\u001b\]0;([^\u0007]*)\u0007/gu)].map((match) => match[1]);
    const stockIndex = titles.findIndex((title) => title.startsWith("π - "));
    const extensionIndex = titles.findIndex((title) => title.startsWith("⎊ π - "));
    assert.ok(stockIndex >= 0, `no stock OSC title captured: ${JSON.stringify(titles)}`);
    assert.ok(extensionIndex > stockIndex, `extension did not hand off after stock title: ${JSON.stringify(titles)}`);
    assert.equal(titles.filter((title) => title.startsWith("⎊ π - ")).length, 1, "unchanged semantic state emitted repeated OSC titles");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
