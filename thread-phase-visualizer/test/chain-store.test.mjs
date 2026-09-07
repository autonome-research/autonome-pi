import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND = "";
process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND = "";

const moduleUrl = new URL("../lib/chain-store.mjs", import.meta.url).href;
const CHAIN_ID = "12345678-1234-4123-8123-123456789abc";

async function withStore(t) {
  const root = mkdtempSync(join(tmpdir(), "dynamic-chain-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.PI_THREAD_PHASE_STORE_DIR;
  process.env.PI_THREAD_PHASE_STORE_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
    else process.env.PI_THREAD_PHASE_STORE_DIR = previous;
  });
  return { root, store: await import(`${moduleUrl}?store=${Date.now()}-${Math.random()}`) };
}

test("successor reservation commits exactly one durable parent-child edge", async (t) => {
  const { store } = await withStore(t);
  const reservation = store.reserveSuccessor("parent-run", "child-run", { chainId: CHAIN_ID });
  assert.equal(store.readSuccessor("parent-run").state, "reserved");
  const committed = store.commitSuccessor(reservation);
  assert.equal(committed.state, "committed");
  assert.equal(committed.parentRunId, "parent-run");
  assert.equal(committed.childRunId, "child-run");
  assert.throws(() => store.reserveSuccessor("parent-run", "other-child", { chainId: CHAIN_ID }), /already has successor child-run/);
  assert.equal(store.releaseSuccessor(reservation), false, "committed edges are immutable");
});

test("uncommitted successor reservation can be released after launch failure", async (t) => {
  const { store } = await withStore(t);
  const first = store.reserveSuccessor("release-parent", "failed-child", { chainId: CHAIN_ID });
  assert.equal(store.releaseSuccessor(first), true);
  const second = store.reserveSuccessor("release-parent", "replacement-child", { chainId: CHAIN_ID });
  assert.equal(second.record.childRunId, "replacement-child");
});

test("a genuinely missing successor record is absent", async (t) => {
  const { store } = await withStore(t);
  assert.equal(store.readSuccessor("missing-parent"), undefined);
});

test("successor records reject symlinks instead of following external content", async (t) => {
  const { root, store } = await withStore(t);
  const external = join(root, "external.json");
  writeFileSync(external, JSON.stringify({ schema: "pi-dynamic-workflow-successor/v1", state: "committed", parentRunId: "linked-parent", childRunId: "outside-child" }));
  const directory = join(root, "chains", "successors");
  mkdirSync(directory, { recursive: true });
  symlinkSync(external, join(directory, "linked-parent.json"));
  assert.throws(() => store.readSuccessor("linked-parent"), /Could not read workflow successor record/);
  assert.throws(() => store.reserveSuccessor("linked-parent", "new-child", { chainId: CHAIN_ID }), /Could not read workflow successor record/);
});

test("broken symlinks and non-directory path components are read errors, not absence", async (t) => {
  const { root, store } = await withStore(t);
  const directory = join(root, "chains", "successors");
  mkdirSync(directory, { recursive: true });
  symlinkSync(join(root, "missing-target.json"), join(directory, "broken-parent.json"));
  assert.throws(() => store.readSuccessor("broken-parent"), /Could not read workflow successor record/);

  rmSync(join(root, "chains"), { recursive: true });
  writeFileSync(join(root, "chains"), "not a directory");
  assert.throws(() => store.readSuccessor("not-directory-parent"), /Could not read workflow successor record/);
});

test("an unreadable successor directory is an unknown read state", async (t) => {
  if (typeof process.getuid !== "function" || process.getuid() === 0) {
    t.skip("directory mode bits cannot reliably deny access for this user");
    return;
  }
  const { root, store } = await withStore(t);
  const directory = join(root, "chains", "successors");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "private-parent.json"), "{}");
  chmodSync(directory, 0o000);
  try {
    assert.throws(() => store.readSuccessor("private-parent"), /Could not read workflow successor record/);
  } finally {
    chmodSync(directory, 0o700);
  }
});

test("successor reads reject FIFOs without blocking", async (t) => {
  const { root } = await withStore(t);
  const directory = join(root, "chains", "successors");
  mkdirSync(directory, { recursive: true });
  const fifo = join(directory, "fifo-parent.json");
  const mkfifo = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  if (mkfifo.error?.code === "ENOENT") {
    t.skip("mkfifo is unavailable");
    return;
  }
  assert.equal(mkfifo.status, 0, mkfifo.stderr || mkfifo.error?.message);

  const script = `
    const store = await import(process.argv[1]);
    try {
      store.readSuccessor("fifo-parent");
      process.exitCode = 2;
    } catch (error) {
      if (!/bounded regular file/.test(error.message)) {
        console.error(error);
        process.exitCode = 3;
      }
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, moduleUrl], {
    env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: root },
    encoding: "utf8",
    timeout: 3_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || `unexpected signal ${result.signal}`);
});

test("concurrent successor reservations produce one winner without timing arbitration", async (t) => {
  const { root, store } = await withStore(t);
  const barrier = join(root, "release");
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    const [moduleUrl, parent, child, chainId, ready, barrier] = process.argv.slice(1);
    const store = await import(moduleUrl);
    writeFileSync(ready, "ready");
    while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      const reservation = store.reserveSuccessor(parent, child, { chainId });
      process.stdout.write(JSON.stringify({ won: true, child: reservation.record.childRunId }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ won: false, error: error.message }));
    }
  `;
  const children = Array.from({ length: 8 }, (_, index) => {
    const ready = join(root, `ready-${index}`);
    const childId = `child-${index}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, moduleUrl, "shared-parent", childId, CHAIN_ID, ready, barrier], {
      env: { ...process.env, PI_THREAD_PHASE_STORE_DIR: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const completion = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
    return { child, childId, ready, completion };
  });

  try {
    const deadline = Date.now() + 10_000;
    while (!children.every(({ ready }) => existsSync(ready))) {
      assert.ok(Date.now() < deadline, "reservation workers did not reach the explicit barrier");
      await delay(10);
    }
    writeFileSync(barrier, "release");
    const results = await Promise.all(children.map(({ completion }) => completion));
    for (const result of results) assert.equal(result.code, 0, result.stderr || String(result.signal));
    const parsed = results.map((result) => JSON.parse(result.stdout));
    assert.equal(parsed.filter((result) => result.won).length, 1);
    assert.equal(parsed.filter((result) => !result.won).length, children.length - 1);
    const durable = store.readSuccessor("shared-parent");
    assert.equal(durable.state, "reserved");
    assert.equal(durable.childRunId, parsed.find((result) => result.won).child);
  } finally {
    if (!existsSync(barrier)) writeFileSync(barrier, "release");
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.allSettled(children.map(({ completion }) => completion));
  }
});
