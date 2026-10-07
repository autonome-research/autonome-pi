import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "../index.ts");
const repoRoot = resolve(here, "../..");
const sdkDir = process.env.PI_HANDOFF_SDK_DIR;

// Opt-in because this starts the real interactive CLI in a PTY and depends on the
// deployed terminal stack. When opted in, an unavailable or version-mismatched
// PI_HANDOFF_SDK_DIR is a failure, never a silent pass: the run must execute on
// the actually installed Pi 1.0.4. No provider/model turn, no credentials, and
// every state directory is fixture-owned and removed afterwards.
test("installed Pi 1.0.4 PTY orders stock then extension OSC and stays quiet", { skip: process.env.PI_TITLE_PTY_SMOKE !== "1", timeout: 30_000 }, async () => {
  assert.ok(sdkDir, "PI_TITLE_PTY_SMOKE=1 requires PI_HANDOFF_SDK_DIR pointing at the installed Pi 1.0.4 package");
  assert.equal(JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")).version, "1.0.4");
  const root = mkdtempSync(join(tmpdir(), "thread-phase-title-pty-"));
  for (const dir of ["home", "agent", "sessions", "store", "bridge", "tmp"]) mkdirSync(join(root, dir));
  const command = [
    `cd ${JSON.stringify(repoRoot)}`,
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(sdkDir, "dist/cli.js"))} --offline --approve --no-session --no-extensions -e ${JSON.stringify(extensionPath)}`,
  ].join(" && ");
  let output = "";
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
      TERM: process.env.TERM || "xterm-256color",
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
      PI_THREAD_PHASE_STORE_DIR: join(root, "store"),
      PI_THREAD_PHASE_STATUS_BRIDGE: "1",
      PI_THREAD_PHASE_TERMINAL_TITLE: "1",
      PI_THREAD_PHASE_STATUS_BRIDGE_DIR: join(root, "bridge"),
      PI_OFFLINE: "1",
      // Preserve the harness network-blocking preload; never widen beyond it.
      ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
    },
  });
  try {
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    // Readiness observation instead of a fixed startup sleep: end the session
    // only once the extension's own OSC title proves the stock handoff happened.
    const exit = new Promise((resolveExit) => {
      const deadline = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 2_000).unref();
      }, 20_000);
      deadline.unref();
      child.on("close", (code, signal) => { clearTimeout(deadline); resolveExit({ code, signal }); });
      child.on("error", () => { clearTimeout(deadline); resolveExit({ code: null, signal: "SPAWN_ERROR" }); });
    });
    const readyDeadline = Date.now() + 15_000;
    while (!output.includes("⎊ π - ") && child.exitCode === null && Date.now() < readyDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assert.ok(output.includes("⎊ π - "), `extension OSC title never appeared within readiness window: ${JSON.stringify(output.slice(-2000))}`);
    child.stdin.end("\x04");
    const { code, signal } = await exit;
    assert.equal(signal, null, `pi PTY session did not exit on its own after EOT (code ${code})`);

    const titles = [...output.matchAll(/\u001b\]0;([^\u0007]*)\u0007/gu)].map((match) => match[1]);
    const stockIndex = titles.findIndex((title) => title.startsWith("π - "));
    const extensionIndex = titles.findIndex((title) => title.startsWith("⎊ π - "));
    assert.ok(stockIndex >= 0, `no stock OSC title captured: ${JSON.stringify(titles)}`);
    assert.ok(extensionIndex > stockIndex, `extension did not hand off after stock title: ${JSON.stringify(titles)}`);
    assert.equal(titles.filter((title) => title.startsWith("⎊ π - ")).length, 1, "unchanged semantic state emitted repeated OSC titles");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});
