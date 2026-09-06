import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertProcessGroupsStopped, createProcessJournal } from "../lib/process-journal.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "dynamic-process-journal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "workflow-processes.json") };
}

test("process journal persists unresolved launch intent before a PID is available", (t) => {
  const { directory, file } = fixture(t);
  const journal = createProcessJournal(directory, "source");
  assert.doesNotThrow(() => assertProcessGroupsStopped(directory, "source", process.pid));
  const token = journal.reserve();
  assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).groups, [{ token }]);
  assert.throws(() => assertProcessGroupsStopped(directory, "source", process.pid), /unresolved subprocess launch/);
});

test("positive no-child proof clears only an unresolved launch intent", (t) => {
  const { directory, file } = fixture(t);
  const journal = createProcessJournal(directory, "source");
  const token = journal.reserve();
  journal.noChild(token);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).groups, []);
  assert.doesNotThrow(() => assertProcessGroupsStopped(directory, "source", process.pid));
  assert.throws(() => journal.noChild(token), /may have created a child/);
  assert.throws(() => journal.noChild("not-a-token"), /token is invalid/);
});

test("a started persistence failure permanently preserves the unresolved crash intent", (t) => {
  const { directory } = fixture(t);
  const moved = `${directory}-moved`;
  const journal = createProcessJournal(directory, "source");
  const token = journal.reserve();
  renameSync(directory, moved);
  try {
    assert.throws(() => journal.started(token, 12345), /ENOENT/);
  } finally {
    renameSync(moved, directory);
  }
  assert.throws(() => journal.noChild(token), /may have created a child/);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try { journal.ended(token); }
  finally { Object.defineProperty(process, "platform", descriptor); }
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "workflow-processes.json"), "utf8")).groups, [{ token }]);
  assert.throws(() => assertProcessGroupsStopped(directory, "source", process.pid), /unresolved subprocess launch/);
});

test("recovery accepts only ESRCH for every recorded group, never permission errors", { skip: process.platform === "win32" }, (t) => {
  const { directory } = fixture(t);
  const journal = createProcessJournal(directory, "source");
  journal.started(journal.reserve(), 12345);
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, -12345);
    assert.equal(signal, 0);
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  });
  assert.throws(() => assertProcessGroupsStopped(directory, "source", process.pid), /still running or its state is unknown/);
  process.kill.mock.mockImplementation(() => undefined);
  assert.throws(() => assertProcessGroupsStopped(directory, "source", process.pid), /still running or its state is unknown/);
  process.kill.mock.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  assert.doesNotThrow(() => assertProcessGroupsStopped(directory, "source", process.pid));
});

test("new launches prune only groups positively known to be gone", { skip: process.platform === "win32" }, (t) => {
  const { directory, file } = fixture(t);
  const journal = createProcessJournal(directory, "source");
  journal.started(journal.reserve(), 12345);
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  const next = journal.reserve();
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).groups, [{ token: next }]);
});

test("completed Windows children do not exhaust the journal or imply safe group recovery", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  const { directory, file } = fixture(t);
  const journal = createProcessJournal(directory, "source");
  for (let index = 0; index < 1025; index++) {
    const token = journal.reserve();
    journal.started(token, 12345);
    journal.ended(token);
  }
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).groups, []);
  assert.throws(() => assertProcessGroupsStopped(directory, "source", process.pid), /unsupported on Windows/);
});

test("process journal recovery rejects symlinks and oversized input", { skip: process.platform === "win32" }, (t) => {
  const { directory, file } = fixture(t);
  const target = join(directory, "target.json");
  createProcessJournal(directory, "source");
  writeFileSync(target, readFileSync(file));
  rmSync(file);
  symlinkSync(target, file);
  assert.throws(() => assertProcessGroupsStopped(directory, "source", process.pid), /ownership is unknown/);
  rmSync(file);
  writeFileSync(file, " ".repeat(1_000_001));
  assert.throws(() => assertProcessGroupsStopped(directory, "source", process.pid), /ownership is unknown/);
});

test("crash recovery fails closed for legacy, corrupt, and foreign process journals", (t) => {
  const { directory, file } = fixture(t);
  assert.throws(() => assertProcessGroupsStopped(directory, "source", process.pid), /ownership is unknown/);
  createProcessJournal(directory, "source");
  const original = JSON.parse(readFileSync(file, "utf8"));
  const token = "12345678-1234-4123-8123-123456789abc";
  for (const patch of [
    { runId: "other" }, { runnerPid: process.pid + 1 }, { hostname: `${original.hostname}-other` },
    { schema: "future" }, { groups: null }, { groups: [{ token: "pending" }] }, { groups: [{ pid: -1 }] },
    { groups: [{ token }, { token }] }, { groups: [{ token, extra: true }] },
    { hasSubprocesses: false, groups: [{ token, pid: 12345 }] },
  ]) {
    writeFileSync(file, JSON.stringify({ ...original, ...patch }));
    assert.throws(() => assertProcessGroupsStopped(directory, "source", process.pid), /Cannot resume workflow/);
  }
  writeFileSync(file, "{");
  assert.throws(() => assertProcessGroupsStopped(directory, "source", process.pid), /ownership is unknown/);
});
