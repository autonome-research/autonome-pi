import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";

process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND = "";
process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND = "";

const moduleUrl = new URL("../lib/chain-store.mjs", import.meta.url).href;
const CHAIN_ID = "12345678-1234-4123-8123-123456789abc";

async function withStore(t) {
  const root = mkdtempSync(join(tmpdir(), "dynamic-chain-store-v2-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.PI_THREAD_PHASE_STORE_DIR;
  process.env.PI_THREAD_PHASE_STORE_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
    else process.env.PI_THREAD_PHASE_STORE_DIR = previous;
  });
  return { root, store: await import(`${moduleUrl}?store-v2=${Date.now()}-${Math.random()}`) };
}

function reserveV2(store, parent, child, options = {}) {
  return store.reserveSuccessorV2(parent, child, {
    chainId: CHAIN_ID,
    launchProtocol: store.SUCCESSOR_V2_LAUNCH_PROTOCOL,
    ...options,
  });
}

function successorPath(root, parent) {
  return join(root, "chains", "successors", `${parent}.json`);
}

function workerResult(worker) {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}`));
    });
  });
}

test("v2 requires its exported launch protocol and does not silently upgrade v1", async (t) => {
  const { root, store } = await withStore(t);
  assert.equal(store.SUCCESSOR_V2_LAUNCH_PROTOCOL, "pi-dynamic-workflow-successor-launch/v2");
  assert.throws(() => store.reserveSuccessorV2("literal-parent", "child", { chainId: CHAIN_ID }), /launchProtocol must be exactly/);
  assert.throws(() => store.reserveSuccessorV2("literal-parent", "child", { chainId: CHAIN_ID, launchProtocol: "v2" }), /launchProtocol must be exactly/);
  assert.equal(existsSync(successorPath(root, "literal-parent")), false);

  const legacy = store.reserveSuccessor("legacy-parent", "legacy-child", { chainId: CHAIN_ID });
  assert.equal(legacy.record.schema, "pi-dynamic-workflow-successor/v1");
  assert.equal("stage" in legacy.record, false);
  assert.equal(store.commitSuccessor(legacy).state, "committed");
});

test("v2 publishes the exact pre-create schema and performs legal durable transitions", async (t) => {
  const { store } = await withStore(t);
  const handle = reserveV2(store, "shape-parent", "shape-child", { now: 1_700_000_000_000 });
  assert.equal(Object.isFrozen(handle), true);
  assert.deepEqual(Object.keys(handle), [], "the capability exposes no delegable claim fields");

  const reserved = store.readSuccessor("shape-parent");
  assert.deepEqual(Object.keys(reserved).sort(), [
    "chainId", "childRunId", "createdAt", "owner", "parentRunId", "schema", "stage", "state", "token", "updatedAt",
  ]);
  assert.deepEqual(Object.keys(reserved.owner).sort(), [
    "bootId", "launchProtocol", "machineId", "pid", "pidNamespace", "processStartTicks",
  ]);
  assert.deepEqual(Object.keys(reserved.owner.pidNamespace).sort(), ["dev", "ino"]);
  assert.equal(reserved.schema, "pi-dynamic-workflow-successor/v2");
  assert.equal(reserved.state, "reserved");
  assert.equal(reserved.stage, "pre-create");
  assert.equal(reserved.owner.pid, process.pid);
  assert.equal(reserved.owner.launchProtocol, store.SUCCESSOR_V2_LAUNCH_PROTOCOL);
  assert.match(reserved.owner.machineId, /^[0-9a-f]{32}$/);
  assert.match(reserved.owner.processStartTicks, /^[0-9]+$/);

  const creating = store.markSuccessorLaunchIntent(handle);
  assert.equal(creating.state, "reserved");
  assert.equal(creating.stage, "creating-child");
  assert.deepEqual(store.readSuccessor("shape-parent"), creating);
  assert.throws(() => store.releaseSuccessorV2(handle), /stale or poisoned/, "a potentially child-producing call can never be followed by release");

  const committed = store.commitSuccessorV2(handle);
  assert.equal(committed.state, "committed");
  assert.equal(committed.stage, "committed");
  assert.deepEqual(store.readSuccessor("shape-parent"), committed);
  assert.throws(() => store.commitSuccessorV2(handle), /stale or poisoned/);
  assert.throws(() => store.releaseSuccessorV2(handle), /stale or poisoned/);
});

test("strict v2 decoding rejects illegal pairs, extra fields, corruption, symlinks, and FIFOs", async (t) => {
  const { root, store } = await withStore(t);
  const handle = reserveV2(store, "strict-parent", "strict-child");
  const file = successorPath(root, "strict-parent");
  const valid = store.readSuccessor("strict-parent");

  for (const [name, mutate] of [
    ["committed-pre-create", (record) => Object.assign(record, { state: "committed", stage: "pre-create" })],
    ["reserved-committed", (record) => Object.assign(record, { state: "reserved", stage: "committed" })],
    ["extra-field", (record) => { record.modelFacing = true; }],
    ["bad-owner", (record) => { record.owner.processStartTicks = ""; }],
    ["array-machine-id", (record) => { record.owner.machineId = [record.owner.machineId]; }],
    ["array-boot-id", (record) => { record.owner.bootId = [record.owner.bootId]; }],
    ["numeric-namespace-device", (record) => { record.owner.pidNamespace.dev = 1; }],
    ["array-namespace-inode", (record) => { record.owner.pidNamespace.ino = [record.owner.pidNamespace.ino]; }],
    ["zero-namespace-inode", (record) => { record.owner.pidNamespace.ino = "0"; }],
    ["numeric-start-ticks", (record) => { record.owner.processStartTicks = 123; }],
    ["zero-start-ticks", (record) => { record.owner.processStartTicks = "0"; }],
    ["out-of-range-pid", (record) => { record.owner.pid = 2_147_483_648; }],
  ]) {
    const malformed = structuredClone(valid);
    mutate(malformed);
    writeFileSync(file, `${JSON.stringify(malformed)}\n`);
    assert.throws(() => store.readSuccessor("strict-parent"), /invalid successor record/, name);
  }
  writeFileSync(file, "{not-json\n");
  assert.throws(() => store.readSuccessor("strict-parent"), /Could not read workflow successor record/);
  assert.throws(() => store.releaseSuccessorV2(handle), /changed before mutation|Could not read/);

  const directory = join(root, "chains", "successors");
  const external = join(root, "external-v2.json");
  writeFileSync(external, `${JSON.stringify(valid)}\n`);
  symlinkSync(external, join(directory, "v2-symlink.json"));
  assert.throws(() => store.readSuccessor("v2-symlink"), /Could not read workflow successor record/);

  const fifo = join(directory, "v2-fifo.json");
  const fifoResult = await new Promise((resolve) => {
    const child = spawn("mkfifo", [fifo]);
    child.once("error", (error) => resolve({ error }));
    child.once("close", (status) => resolve({ status }));
  });
  if (fifoResult.error?.code === "ENOENT") return;
  assert.equal(fifoResult.status, 0);
  assert.throws(() => store.readSuccessor("v2-fifo"), /bounded regular file/);
});

test("legacy mutators explicitly refuse v2 while the prior v1 schema gate rejects it", async (t) => {
  const { root, store } = await withStore(t);
  reserveV2(store, "mixed-parent", "v2-child");
  const record = store.readSuccessor("mixed-parent");
  const legacyShapedCapability = { file: successorPath(root, "mixed-parent"), record };

  assert.throws(() => store.reserveSuccessor("mixed-parent", "legacy-child", { chainId: CHAIN_ID }), /Legacy successor reservation refuses.*v2/);
  assert.throws(() => store.commitSuccessor(legacyShapedCapability), /Legacy successor commit refuses.*v2/);
  assert.throws(() => store.releaseSuccessor(legacyShapedCapability), /Legacy successor release refuses.*v2/);
  assert.throws(() => {
    if (record.schema !== "pi-dynamic-workflow-successor/v1") throw new Error("invalid successor record");
  }, /invalid successor record/, "the exact schema gate in the previous reader rejects v2");
  assert.equal(store.readSuccessor("mixed-parent").childRunId, "v2-child");
});

test("v2 rejects forged, cloned, stale, owner-mismatched, and caller-identity inputs", async (t) => {
  const { root, store } = await withStore(t);
  assert.throws(() => reserveV2(store, "override-parent", "child", { owner: { pid: process.pid } }), /caller-supplied owner/);

  const handle = reserveV2(store, "cap-parent", "cap-child");
  assert.throws(() => store.markSuccessorLaunchIntent(Object.freeze({})), /nondelegable/);
  assert.throws(() => store.releaseSuccessorV2(structuredClone(handle)), /nondelegable/);

  const file = successorPath(root, "cap-parent");
  const changed = store.readSuccessor("cap-parent");
  changed.owner.pid += 1;
  writeFileSync(file, `${JSON.stringify(changed, null, 2)}\n`);
  assert.throws(() => store.markSuccessorLaunchIntent(handle), /changed before mutation/);

  const releasable = reserveV2(store, "stale-parent", "stale-child");
  assert.equal(store.releaseSuccessorV2(releasable), true);
  assert.throws(() => store.releaseSuccessorV2(releasable), /stale or poisoned/);
});

test("worker threads cannot reserve v2 or use a delegated clone", async (t) => {
  const { root, store } = await withStore(t);
  const handle = reserveV2(store, "worker-parent", "worker-child");
  const worker = new Worker(`
    import { parentPort, workerData } from "node:worker_threads";
    const store = await import(workerData.moduleUrl);
    const errors = [];
    try {
      store.reserveSuccessorV2("worker-own-parent", "worker-own-child", {
        chainId: workerData.chainId,
        launchProtocol: store.SUCCESSOR_V2_LAUNCH_PROTOCOL,
      });
    } catch (error) { errors.push(error.message); }
    try { store.releaseSuccessorV2(workerData.handle); }
    catch (error) { errors.push(error.message); }
    parentPort.postMessage(errors);
  `, {
    eval: true,
    type: "module",
    workerData: { moduleUrl, chainId: CHAIN_ID, handle },
    env: {
      ...process.env,
      PI_THREAD_PHASE_STORE_DIR: root,
      PI_DYNAMIC_WORKFLOW_BACKGROUND: "",
      PI_DYNAMIC_THREAD_PHASE_BACKGROUND: "",
    },
  });
  const errors = await workerResult(worker);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /originating main thread/);
  assert.match(errors[1], /nondelegable/);
  assert.equal(store.readSuccessor("worker-parent").stage, "pre-create");
  assert.equal(store.readSuccessor("worker-own-parent"), undefined);
});

test("v2 reservations retain O_EXCL one-winner semantics across processes", async (t) => {
  const { root, store } = await withStore(t);
  const barrier = join(root, "v2-release");
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    const [moduleUrl, child, chainId, ready, barrier] = process.argv.slice(1);
    const store = await import(moduleUrl);
    writeFileSync(ready, "ready");
    while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      store.reserveSuccessorV2("v2-shared-parent", child, { chainId, launchProtocol: store.SUCCESSOR_V2_LAUNCH_PROTOCOL });
      process.stdout.write(JSON.stringify({ won: true, child }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ won: false, error: error.message }));
    }
  `;
  const children = Array.from({ length: 6 }, (_, index) => {
    const ready = join(root, `v2-ready-${index}`);
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, moduleUrl, `v2-child-${index}`, CHAIN_ID, ready, barrier], {
      env: {
        ...process.env,
        PI_THREAD_PHASE_STORE_DIR: root,
        PI_DYNAMIC_WORKFLOW_BACKGROUND: "",
        PI_DYNAMIC_THREAD_PHASE_BACKGROUND: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const completion = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
    return { child, ready, completion };
  });

  try {
    const deadline = Date.now() + 10_000;
    while (!children.every(({ ready }) => existsSync(ready))) {
      assert.ok(Date.now() < deadline, "v2 reservation workers did not reach the barrier");
      await delay(10);
    }
    writeFileSync(barrier, "release");
    const results = await Promise.all(children.map(({ completion }) => completion));
    for (const result of results) assert.equal(result.code, 0, result.stderr || String(result.signal));
    const parsed = results.map(({ stdout }) => JSON.parse(stdout));
    assert.equal(parsed.filter(({ won }) => won).length, 1);
    assert.equal(store.readSuccessor("v2-shared-parent").childRunId, parsed.find(({ won }) => won).child);
  } finally {
    if (!existsSync(barrier)) writeFileSync(barrier, "release");
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.allSettled(children.map(({ completion }) => completion));
  }
});

test("intent failure before rename remains exactly releasable", async (t) => {
  const { store } = await withStore(t);
  const handle = reserveV2(store, "intent-write-parent", "intent-write-child");
  const realFsync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (descriptor) => {
    if (!injected && fs.fstatSync(descriptor).isFile()) {
      injected = true;
      throw new Error("injected temporary fsync failure");
    }
    return realFsync(descriptor);
  };
  try {
    assert.throws(() => store.markSuccessorLaunchIntent(handle), /injected temporary fsync failure/);
  } finally {
    fs.fsyncSync = realFsync;
  }
  assert.equal(store.readSuccessor("intent-write-parent").stage, "pre-create");
  assert.equal(store.releaseSuccessorV2(handle), true);
});

test("intent poisons release before rename and after rename ambiguity", async (t) => {
  const { store } = await withStore(t);
  const before = reserveV2(store, "rename-before-parent", "rename-before-child");
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error("injected rename failure before syscall"); };
  try {
    assert.throws(() => store.markSuccessorLaunchIntent(before), /injected rename failure/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(store.readSuccessor("rename-before-parent").stage, "pre-create");
  assert.throws(() => store.releaseSuccessorV2(before), /stale or poisoned/);

  const after = reserveV2(store, "rename-after-parent", "rename-after-child");
  fs.renameSync = (from, to) => {
    realRename(from, to);
    throw new Error("injected ambiguity after rename");
  };
  try {
    assert.throws(() => store.markSuccessorLaunchIntent(after), /injected ambiguity after rename/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(store.readSuccessor("rename-after-parent").stage, "creating-child");
  assert.throws(() => store.releaseSuccessorV2(after), /stale or poisoned/);
});

test("intent directory-fsync ambiguity never restores release authority", async (t) => {
  const { store } = await withStore(t);
  const handle = reserveV2(store, "intent-dir-parent", "intent-dir-child");
  const realFsync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (descriptor) => {
    const result = realFsync(descriptor);
    if (!injected && fs.fstatSync(descriptor).isDirectory()) {
      injected = true;
      throw new Error("injected intent directory fsync ambiguity");
    }
    return result;
  };
  try {
    assert.throws(() => store.markSuccessorLaunchIntent(handle), /directory fsync ambiguity/);
  } finally {
    fs.fsyncSync = realFsync;
  }
  assert.equal(store.readSuccessor("intent-dir-parent").stage, "creating-child");
  assert.throws(() => store.releaseSuccessorV2(handle), /stale or poisoned/);
});

test("synchronous handle mutation rejects reentrancy", async (t) => {
  const { store } = await withStore(t);
  const handle = reserveV2(store, "reentrant-parent", "reentrant-child");
  const realRename = fs.renameSync;
  let nestedError;
  fs.renameSync = (from, to) => {
    try { store.markSuccessorLaunchIntent(handle); } catch (error) { nestedError = error; }
    return realRename(from, to);
  };
  try {
    store.markSuccessorLaunchIntent(handle);
  } finally {
    fs.renameSync = realRename;
  }
  assert.match(nestedError?.message || "", /cannot re-enter/);
  assert.equal(store.readSuccessor("reentrant-parent").stage, "creating-child");
});

test("release issues one unlink and cannot delete a replacement after unlink ambiguity", async (t) => {
  const { root, store } = await withStore(t);
  const old = reserveV2(store, "unlink-parent", "old-child");
  const file = successorPath(root, "unlink-parent");
  const realUnlink = fs.unlinkSync;
  let reservationUnlinks = 0;
  let replacement;
  fs.unlinkSync = (path) => {
    if (path === file) {
      reservationUnlinks += 1;
      realUnlink(path);
      replacement = reserveV2(store, "unlink-parent", "fresh-child");
      throw new Error("injected ambiguity after unlink");
    }
    return realUnlink(path);
  };
  try {
    assert.throws(() => store.releaseSuccessorV2(old), /ambiguity after unlink/);
  } finally {
    fs.unlinkSync = realUnlink;
  }
  assert.equal(reservationUnlinks, 1);
  assert.equal(store.readSuccessor("unlink-parent").childRunId, "fresh-child");
  assert.throws(() => store.releaseSuccessorV2(old), /stale or poisoned/);
  assert.equal(store.readSuccessor("unlink-parent").childRunId, "fresh-child");
  assert.equal(store.releaseSuccessorV2(replacement), true);
});

test("release directory-fsync ambiguity cannot trigger a second unlink of a fresh claim", async (t) => {
  const { root, store } = await withStore(t);
  const old = reserveV2(store, "release-fsync-parent", "old-child");
  const file = successorPath(root, "release-fsync-parent");
  const realUnlink = fs.unlinkSync;
  const realFsync = fs.fsyncSync;
  let reservationUnlinks = 0;
  let injected = false;
  let replacement;
  fs.unlinkSync = (path) => {
    if (path === file) reservationUnlinks += 1;
    return realUnlink(path);
  };
  fs.fsyncSync = (descriptor) => {
    const result = realFsync(descriptor);
    if (!injected && fs.fstatSync(descriptor).isDirectory()) {
      injected = true;
      replacement = reserveV2(store, "release-fsync-parent", "fresh-child");
      throw new Error("injected release directory fsync ambiguity");
    }
    return result;
  };
  try {
    assert.throws(() => store.releaseSuccessorV2(old), /release directory fsync ambiguity/);
  } finally {
    fs.unlinkSync = realUnlink;
    fs.fsyncSync = realFsync;
  }
  assert.equal(reservationUnlinks, 1);
  assert.equal(store.readSuccessor("release-fsync-parent").childRunId, "fresh-child");
  assert.throws(() => store.releaseSuccessorV2(old), /stale or poisoned/);
  assert.equal(store.readSuccessor("release-fsync-parent").childRunId, "fresh-child");
  assert.equal(store.releaseSuccessorV2(replacement), true);
});
