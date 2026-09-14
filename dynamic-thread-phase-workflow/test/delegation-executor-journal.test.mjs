import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDelegationJournal, inspectDelegationJournal } from '../lib/delegation-journal.mjs';
import { createProcessJournal } from '../lib/process-journal.mjs';
import { createDelegationExecutor } from '../lib/delegation-executor.mjs';
import { checkCapacity, reduceEvent, reservedBytes } from '../lib/delegation-journal-model.mjs';
import { canonicalJSON } from '../lib/delegation-storage.mjs';
import { LIMITS } from '../lib/delegation-contract.mjs';
function fixture(t, fault) {
  const root = fs.mkdtempSync(join(tmpdir(), 'executor-journal-'));
  for (const d of ['workspace', 'workspace/src', 'profile', 'artifacts']) fs.mkdirSync(join(root, d), { mode: 0o700 });
  const scope = { read: ['src'], write: [] };
  const j = createDelegationJournal({ artifactDirectory: join(root, 'artifacts'), workspace: join(root, 'workspace'),
    protectedDirectories: [join(root, 'profile')], runId: 'storage-executor', specDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
    policy: { maxDepth: 0, totalAgentBudget: 1, directoryScope: scope, context: { objective: 'fixture', constraints: [] } },
    roots: [{ phaseIndex: 0, agentBudget: 1, label: 'root', task: 'fixture', permissions: 'r', directoryScope: scope, deadlineAt: null }], ...(fault ? { fault } : {}) });
  const pj = createProcessJournal(join(root, 'artifacts'), 'storage-executor');
  t.after(() => { j.dispose(); t.diagnostic(`retained no-process storage fixture ${root}`); });
  return { j, pj, root };
}
const inspect = j => inspectDelegationJournal(j.directory, j.binding);

test('durable acceptance reserves three exact 4096 slots before dispatch; freeze and matching terminal slots', t => {
  const { j, pj } = fixture(t), scope = j.openCommandScope('declared-shell');
  const before = j.snapshot().reservedBytes;
  const token = pj.reserve(), id = j.acceptCommand(scope.scopeId, 1, token, 'shell', 'a'.repeat(64));
  const s = j.snapshot(); assert.equal(s.reservedBytes, before + 3 * 4096);
  assert.equal(s.state.commands[0].pid, null); assert.equal(s.state.budget.spent, 0);
  const text = fs.readFileSync(join(j.directory, 'events.jsonl'), 'utf8');
  assert.equal(s.usedBytes, Buffer.byteLength(text));
  const actual = text.trim().split('\n').map(JSON.parse).find(e => e.type === 'command_accepted');
  const size = Buffer.byteLength(canonicalJSON(actual)) + 1;
  checkCapacity(s.state, LIMITS.journalBytes - s.reservedBytes - size, size, 'command_accepted');
  assert.throws(() => checkCapacity(s.state, LIMITS.journalBytes - s.reservedBytes - size + 1, size, 'command_accepted'), /JOURNAL_LIMIT/);
  assert.throws(() => checkCapacity(s.state, 0, 4097, 'command_result'));
  j.freezeCommandScope(scope.scopeId); pj.noChild(token);
  j.settleCommand(id, { classification: 'cancelled', code: null, signal: null, disposition: 'no_child' });
  assert.equal(j.snapshot().reservedBytes, before);
  assert.deepEqual(inspect(j).state, j.snapshot().state);
  for (const e of fs.readFileSync(join(j.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.type.startsWith('command_') && ['command_result', 'command_drained', 'command_closed'].includes(e.type))) {
    assert.ok(Buffer.byteLength(canonicalJSON(e)) + 1 <= 4096);
  }
  assert.equal(inspect(j).launchAuthorized, false);
});

test('128 cumulative accepted commands are never refunded; real preaborted production seam, no child processes', async t => {
  const { j, pj } = fixture(t), executor = createDelegationExecutor({ journal: j, processJournal: pj });
  const scope = executor.openDeclaredShell(), abort = new AbortController(); abort.abort('no-child');
  for (let occurrence = 1; occurrence <= 128; occurrence++) {
    const result = await executor.runShell(scope, occurrence, '/bin/true', [], { timeoutMs: 1000, signal: abort.signal });
    assert.equal(result.disposition, 'no_child');
  }
  const before = j.snapshot();
  assert.throws(() => executor.runShell(scope, 129, '/bin/true', [], { timeoutMs: 1000 }), /ADMISSION_LIMIT/);
  assert.deepEqual(j.snapshot(), before);
  assert.equal(executor.inspect().acceptedCommands, 128); assert.equal(before.state.commands.length, 128);
  assert.equal(before.reservedBytes, 4 * 4096); assert.equal(before.state.budget.spent, 0);
  const receipt = (await executor.settleScope(scope)).receipt;
  assert.equal(receipt.commands.length, 128);
  assert.throws(() => { executor.inspect().acceptedCommands = 0; }, TypeError);
  fs.unlinkSync(join(j.directory, 'state.json'));
  assert.equal(inspect(j).state.commands.length, 128); assert.equal(inspect(j).launchAuthorized, false);
  t.diagnostic(`128 disk-backed command admissions+3 terminal appends; ${before.usedBytes} canonical log bytes, no process launches`);
});

test('scope cap and occurrence/token reuse guards cannot open an unbounded inventory', t => {
  const { j, pj } = fixture(t);
  const scopes = Array.from({ length: 128 }, () => j.openCommandScope('declared-shell'));
  assert.throws(() => j.openCommandScope('declared-shell'), /ADMISSION_LIMIT/);
  const token = pj.reserve(); j.acceptCommand(scopes[0].scopeId, 1, token, 'shell', 'a'.repeat(64));
  assert.throws(() => j.acceptCommand(scopes[1].scopeId, 1, token, 'shell', 'a'.repeat(64)), /REQUEST_CONFLICT/);
  assert.equal(j.snapshot().poisoned, true);
  assert.equal(inspect(j).state.commands.length, 1); assert.equal(inspect(j).reservedBytes, 7 * 4096);
});

test('inspection reducer rejects forged drain/result/closure combinations and never promotes launched joins', t => {
  const { j, pj } = fixture(t), scope = j.openCommandScope('declared-shell');
  const id = j.acceptCommand(scope.scopeId, 1, pj.reserve(), 'shell', 'a'.repeat(64));
  const original = j.snapshot().state, manifest = inspect(j).manifest;
  const event = (s, type, payload) => ({ sequence: s.sequence + 1, eventId: randomUUID(), at: manifest.createdAt, type, payload });
  const apply = (s, type, payload) => reduceEvent(s, event(s, type, payload), manifest);
  for (const type of ['command_drained', 'command_closed']) {
    assert.throws(() => apply(original, type, { commandId: id, ...(type === 'command_drained' ? { disposition: 'no_child' } : {}) }), /OWNERSHIP_UNKNOWN/);
  }
  assert.throws(() => apply(original, 'command_result', { commandId: id, classification: 'clean', code: 0, signal: null }), /OWNERSHIP_UNKNOWN/);
  const result = apply(original, 'command_result', { commandId: id, classification: 'cancelled', code: null, signal: null });
  assert.equal(reservedBytes(result), reservedBytes(original) - 4096);
  assert.throws(() => apply(result, 'command_drained', { commandId: id, disposition: 'drained' }), /OWNERSHIP_UNKNOWN/);
  const drained = apply(result, 'command_drained', { commandId: id, disposition: 'no_child' });
  assert.equal(reservedBytes(drained), reservedBytes(original) - 8192);
  const closed = apply(drained, 'command_closed', { commandId: id });
  assert.throws(() => apply(closed, 'command_closed', { commandId: id }), /OWNERSHIP_UNKNOWN/);
});

test('storage-only commands cannot be laundered into a live scope receipt by importing inspection', async t => {
  const { j, pj } = fixture(t), executor = createDelegationExecutor({ journal: j, processJournal: pj });
  const scope = executor.openDeclaredShell(), token = pj.reserve();
  const id = j.acceptCommand(scope.scopeId, 1, token, 'shell', 'a'.repeat(64));
  pj.noChild(token);
  j.settleCommand(id, { classification: 'cancelled', code: null, signal: null, disposition: 'no_child' });
  assert.equal(inspect(j).state.commands[0].disposition, 'no_child');
  const settled = await executor.settleScope(scope);
  assert.equal(settled.disposition, 'unknown'); assert.equal(settled.receipt, null);
  assert.equal(executor.inspect().lost, true);
});

test('each command admission/start-free terminal/freeze persistence cut poisons and retains unresolved authority', t => {
  // Explicit no-child cuts avoid creating subprocesses in storage fault matrices.
  let cases = 0;
  for (const operation of ['accept', 'freeze', 'result', 'drain', 'close']) {
    for (const cut of ['before:event-fsync', 'after:event-fsync', 'before:projection-rename', 'after:projection-rename']) {
      let armed = false, seen = 0;
      const target = ['result', 'drain', 'close'].indexOf(operation) + 1;
      const { j, pj } = fixture(t, point => { if (armed && point === cut && ++seen === Math.max(1, target)) throw new Error('command cut'); });
      const scope = j.openCommandScope('declared-shell'), token = pj.reserve();
      let id;
      if (operation !== 'accept') id = j.acceptCommand(scope.scopeId, 1, token, 'shell', 'a'.repeat(64));
      if (!['accept', 'freeze'].includes(operation)) pj.noChild(token);
      armed = true;
      assert.throws(() => {
        if (operation === 'accept') j.acceptCommand(scope.scopeId, 1, token, 'shell', 'a'.repeat(64));
        else if (operation === 'freeze') j.freezeCommandScope(scope.scopeId);
        else j.settleCommand(id, { classification: 'cancelled', code: null, signal: null, disposition: 'no_child' });
      }, /command cut/);
      armed = false;
      assert.equal(j.snapshot().poisoned, true);
      assert.throws(() => j.freezeCommandScope(scope.scopeId), /writer unavailable/);
      assert.equal(inspect(j).launchAuthorized, false); cases++;
    }
  }
  t.diagnostic(`${cases} command-specific before/after fsync/projection cuts; full writes observable, not physical power-loss proof`);
});
