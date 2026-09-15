import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter, getEventListeners } from 'node:events';
import { createDelegationJournal, inspectDelegationJournal } from '../lib/delegation-journal.mjs';
import { createProcessJournal } from '../lib/process-journal.mjs';
import { createDelegationExecutor, guardDelegationExecutor, takeExecutorDenial } from '../lib/delegation-executor.mjs';
import { probeGroup, ANCHOR_PATH, createScopedProcess } from '../lib/scoped-process.mjs';
const script = new URL('./support/delegation-executor/process.mjs', import.meta.url).pathname;
const pause = ms => new Promise(r => setTimeout(r, ms));
const defaults = { timeoutMs: 5000, killGraceMs: 100 };
function fixture(t, fault) {
  const root = fs.mkdtempSync(join(tmpdir(), 'delegation-executor-'));
  for (const d of ['workspace', 'workspace/src', 'profile', 'artifacts']) fs.mkdirSync(join(root, d), { mode: 0o700 });
  const scope = { read: ['src'], write: [] };
  const journal = createDelegationJournal({ artifactDirectory: join(root, 'artifacts'), workspace: join(root, 'workspace'),
    protectedDirectories: [join(root, 'profile')], runId: 'executor-fixture', specDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
    policy: { maxDepth: 1, totalAgentBudget: 2, directoryScope: scope, context: { objective: 'fixture', constraints: [] } },
    roots: [0, 1].map(phaseIndex => ({ phaseIndex, agentBudget: 1, label: 'fixture', task: 'wait', permissions: 'r', directoryScope: scope, deadlineAt: null })),
    ...(fault ? { fault } : {}) });
  const processJournal = createProcessJournal(join(root, 'artifacts'), 'executor-fixture');
  const ownedPids = new Set(), started = processJournal.started;
  processJournal.started = (token, pid) => { ownedPids.add(pid); return started(token, pid); };
  const executor = createDelegationExecutor({ journal, processJournal });
  const promises = [];
  function track(p) {
    promises.push(p);
    p.then(r => { if (r.scopeSettlement?.anchorPid) ownedPids.add(r.scopeSettlement.anchorPid); }, () => {});
    return p;
  }
  t.after(async () => {
    await Promise.allSettled(promises);
    // Retain all artifacts/evidence. Cleanup proof is live fixture group ESRCH,
    // never a result marker or directory deletion. No teardown signaling.
    // Live fixture inventory is independent of recovery-journal pruning.
    const pids = [...ownedPids];
    for (const pid of pids) {
      const until = Date.now() + 8000;
      while (probeGroup(pid) === 'present' && Date.now() < until) await pause(20);
      assert.equal(probeGroup(pid), 'gone', `retained cleanup uncertainty for fixture group ${pid} at ${root}`);
    }
    journal.dispose(); t.diagnostic(`retained ${root}; ${pids.length} current fixture groups positively ESRCH; no cleanup signals`);
  });
  const run = (handle, occurrence, mode, options = {}) => track(executor.runShell(handle, occurrence, process.execPath, [script, mode], { ...defaults, ...options }));
  return { root, journal, processJournal, executor, run, track };
}

// Fixture phase adapter, NOT a public CLI phase switch. It uses the real shared
// executor and can advance only after consuming the original live scope receipt.
async function declaredPhase(f, mode, next, options) {
  const handle = f.executor.openDeclaredShell();
  const result = await f.run(handle, 1, mode, options);
  const settled = await f.executor.settleScope(handle);
  if (!settled.receipt) return result;
  f.executor.consumeReceipt(handle, settled.receipt);
  if (result.ok && settled.ok) next();
  return result;
}

test('normal direct0 survivor: shell return waits for complete adopted-group drain; not clean success', async t => {
  const f = fixture(t), scope = f.executor.openDeclaredShell();
  let returned = false, ready = false;
  const p = f.run(scope, 1, 'normal-survivor', { killGraceMs: 200, onStdout() { ready = true; } }).then(r => { returned = true; return r; });
  const readyUntil = Date.now() + 6000;
  while (!ready && !returned && Date.now() < readyUntil) await pause(10);
  assert.equal(ready, true, JSON.stringify(returned ? await p : 'readiness deadline'));
  await pause(40); assert.equal(returned, false);
  assert.equal(f.executor.inspect().scopes[0].commands[0].disposition, 'pending');
  const r = await p;
  assert.equal(r.code, 0); assert.equal(r.ok, false); assert.equal(r.classification, 'residual_cleanup');
  assert.equal(r.disposition, 'drained'); assert.equal(r.scopeSettlement.group, 'gone');
  assert.equal(probeGroup(r.scopeSettlement.anchorPid), 'gone');
  assert.ok(r.receipt); assert.equal((await f.executor.settleScope(scope)).disposition, 'drained');
});

test('declared shell adapter never advances before drain or on residual cleanup; clean leaf advances', async t => {
  const f = fixture(t); let advances = 0;
  const residual = await declaredPhase(f, 'normal-survivor', () => advances++);
  assert.equal(residual.disposition, 'drained'); assert.equal(advances, 0);
  const clean = await declaredPhase(f, 'utf8', () => advances++);
  assert.equal(clean.ok, true); assert.equal(clean.stdout, 'A😀B'); assert.equal(advances, 1);
});

test('cancellation direct0 with TERM-ignoring survivor retains KILL escalation after payload exit', async t => {
  const f = fixture(t), scope = f.executor.openDeclaredShell(), abort = new AbortController();
  const r = await f.run(scope, 1, 'cancel-survivor', { signal: abort.signal, onStdout() { abort.abort('operator'); } });
  assert.equal(r.aborted, true); assert.equal(r.timedOut, false); assert.equal(r.code, 0);
  assert.equal(r.classification, 'cancelled'); assert.equal(r.disposition, 'drained');
  assert.equal(r.scopeSettlement.group, 'gone'); assert.ok(r.durationMs < 2500);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('abort during normal-exit drain and absolute timeout during drain remain distinct', async t => {
  for (const kind of ['abort', 'timeout']) {
    const f = fixture(t), scope = f.executor.openDeclaredShell(), abort = new AbortController();
    let timer;
    const r = await f.run(scope, 1, 'normal-survivor', { signal: abort.signal, killGraceMs: 700,
      timeoutMs: kind === 'timeout' ? 350 : 5000,
      onStdout() { if (kind === 'abort') timer = setTimeout(() => abort.abort('during drain'), 100); } });
    clearTimeout(timer);
    assert.equal(r.classification, kind === 'abort' ? 'cancelled' : 'timeout');
    assert.equal(r.disposition, 'drained'); assert.equal(r.timedOut, kind === 'timeout');
  }
});

test('stream and end callbacks fail distinctly while complete group drains', async t => {
  for (const hook of ['onStdout', 'onStderr', 'onChildEnd']) {
    const f = fixture(t), scope = f.executor.openDeclaredShell();
    const r = hook === 'onStderr' ? await f.track(f.executor.runShell(scope, 1, process.execPath,
      ['-e', "process.stderr.write('trigger');setTimeout(()=>{},2000)"], { ...defaults, [hook]() { throw new Error('callback fixture'); } })) :
      await f.run(scope, 1, 'normal-survivor', { [hook]() { throw new Error('callback fixture'); } });
    assert.equal(r.classification, 'callback_error'); assert.equal(r.disposition, 'drained'); assert.equal(r.ok, false);
  }
});

test('failed payload spawn, preabort and invalid timeout distinguish no anchor from anchor-may-exist', async t => {
  const f = fixture(t), scope = f.executor.openDeclaredShell();
  const a = new AbortController(); a.abort('before');
  const pre = await f.run(scope, 1, 'utf8', { signal: a.signal });
  assert.equal(pre.disposition, 'no_child'); assert.equal(pre.classification, 'cancelled');
  const bad = await f.run(scope, 2, 'utf8', { timeoutMs: 0 });
  assert.equal(bad.disposition, 'no_child'); assert.equal(bad.classification, 'validation_error');
  const missing = await f.track(f.executor.runShell(scope, 3, '/definitely/absent/executor-command', [], defaults));
  assert.equal(missing.disposition, 'drained'); assert.equal(missing.classification, 'spawn_error');
  assert.ok(missing.scopeSettlement.anchorPid); assert.equal(f.journal.snapshot().state.commands.length, 3);
});

test('actual anchor ENOENT versus failed no-child persistence never fabricates launch or permission', async t => {
  const f = fixture(t), scope = f.executor.openDeclaredShell();
  const spawn = childProcess.spawn;
  const mock = t.mock.method(childProcess, 'spawn', (_command, args, options) => spawn('/definitely/absent/anchor', args, options));
  syncBuiltinESMExports();
  let result;
  try { result = await f.run(scope, 1, 'utf8'); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(result.disposition, 'no_child'); assert.equal(result.classification, 'spawn_error');
  assert.equal(f.journal.snapshot().state.commands[0].pid, null);
  const broken = fixture(t), other = broken.executor.openDeclaredShell();
  t.mock.method(broken.processJournal, 'noChild', () => { throw new Error('no-child write ambiguity'); });
  const abort = new AbortController(); abort.abort('before');
  const unknown = await broken.run(other, 1, 'utf8', { signal: abort.signal });
  assert.equal(unknown.physicalDisposition, 'no_child'); assert.equal(unknown.disposition, 'unknown'); assert.equal(unknown.receipt, null);
  assert.equal(broken.journal.snapshot().state.commands[0].slots.length, 3);
});

test('start hook and durable PID/result ambiguity hold authority even after physical cleanup', async t => {
  for (const kind of ['hook', 'started', 'result']) {
    let writes = 0, armed = false;
    const f = fixture(t, point => {
      if (armed && point === 'after:event-fsync' && ++writes === (kind === 'started' ? 1 : 2)) throw new Error('ambiguous write');
    });
    const scope = f.executor.openDeclaredShell();
    if (kind === 'started') {
      const started = f.processJournal.started;
      t.mock.method(f.processJournal, 'started', (...args) => { started(...args); armed = true; });
    }
    const r = await f.run(scope, 1, 'utf8', { onChildStart() {
      if (kind === 'hook') throw new Error('start failure');
      if (kind === 'result') armed = true;
    } });
    assert.equal(r.disposition, 'unknown'); assert.equal(r.receipt, null); assert.equal(f.executor.inspect().lost, true);
    assert.equal(r.physicalDisposition, 'drained');
    assert.throws(() => f.executor.runShell(scope, 2, '/bin/true', [], defaults), /OWNERSHIP_UNKNOWN/);
  }
  const f = fixture(t), scope = f.executor.openDeclaredShell();
  t.mock.method(f.processJournal, 'started', () => { throw new Error('PID write ambiguity'); });
  const r = await f.run(scope, 1, 'utf8');
  assert.equal(r.disposition, 'unknown'); assert.equal(r.physicalDisposition, 'drained'); assert.equal(r.receipt, null);
  assert.equal(f.journal.snapshot().state.commands[0].slots.length, 3);
});

test('worker inventory includes own group and multiple shell groups; waiting ancestor/unrelated lane stay live', async t => {
  const f = fixture(t), controllers = [new AbortController(), new AbortController()];
  const nodes = f.journal.snapshot().state.nodes;
  let ready = 0;
  const workers = nodes.map((n, i) => f.executor.startInvocation(n.nodeId, process.execPath, [script, 'waiting'],
    { noDeadline: true, killGraceMs: 100, signal: controllers[i].signal, onStdout() { ready++; } }));
  workers.forEach(w => f.track(w.result));
  const readyUntil = Date.now() + 6000;
  while (ready !== 2 && Date.now() < readyUntil) await pause(10);
  assert.equal(ready, 2);
  const view = f.journal.snapshot(); assert.equal(view.state.budget.spent, 2);
  const pids = view.state.commands.map(c => c.pid);
  const first = await f.run(workers[0].scope, 2, 'normal-survivor');
  const second = await f.run(workers[0].scope, 3, 'utf8');
  assert.equal(first.disposition, 'drained'); assert.equal(second.ok, true);
  for (const pid of pids) assert.equal(probeGroup(pid), 'present');
  let settled = false;
  const barrier = f.executor.settleScope(workers[0].scope).then(r => { settled = true; return r; });
  await pause(30); assert.equal(settled, false);
  assert.throws(() => f.run(workers[0].scope, 4, 'utf8'), /frozen/);
  controllers[0].abort('done ancestor'); const receipt = (await barrier).receipt;
  assert.equal(receipt.commands.length, 3); assert.equal(probeGroup(pids[1]), 'present');
  controllers[1].abort('done unrelated'); await workers[1].result;
  assert.throws(() => f.journal.joinUnlaunched(nodes[0].nodeId), /OWNERSHIP_UNKNOWN/);
});

test('immutable receipts reject forged, copied, serialized, cross-scope and reused authority', async t => {
  const f = fixture(t), a = f.executor.openDeclaredShell(), b = f.executor.openDeclaredShell();
  const result = await f.run(a, 1, 'utf8');
  const receipt = (await f.executor.settleScope(a)).receipt;
  for (const forged of [{ ...receipt }, JSON.parse(JSON.stringify(receipt)), f.executor.inspect(), { disposition: 'drained' }]) {
    assert.throws(() => f.executor.consumeReceipt(a, forged), /UNAUTHORIZED/);
  }
  assert.throws(() => { receipt.commands[0].disposition = 'unknown'; }, TypeError);
  assert.throws(() => f.executor.consumeReceipt(b, receipt), /UNAUTHORIZED/);
  assert.throws(() => f.executor.consumeReceipt(a, result.receipt), /UNAUTHORIZED/);
  f.executor.consumeReceipt(a, result.receipt, result.commandId);
  assert.throws(() => f.executor.consumeReceipt(a, result.receipt, result.commandId), /UNAUTHORIZED/);
  f.executor.consumeReceipt(a, receipt); assert.throws(() => f.executor.consumeReceipt(a, receipt), /UNAUTHORIZED/);
  const inspected = inspectDelegationJournal(f.journal.directory, f.journal.binding);
  assert.equal(inspected.launchAuthorized, false); assert.throws(() => createDelegationExecutor({ journal: inspected, processJournal: f.processJournal }), /UNAUTHORIZED/);
  assert.throws(() => createDelegationExecutor({ journal: f.journal, processJournal: f.processJournal }), /UNAUTHORIZED/);
});

test('nonzero, signal, repeated abort/result races preserve classifications and one settlement', async t => {
  const f = fixture(t), scope = f.executor.openDeclaredShell();
  const nonzero = await f.run(scope, 1, 'nonzero');
  assert.equal(nonzero.classification, 'nonzero'); assert.match(nonzero.error, /nonzero.*exit 23/);
  const signal = await f.run(scope, 2, 'signal');
  assert.equal(signal.classification, 'signal'); assert.equal(signal.termination.observedSignal, 'SIGTERM');
  for (let i = 3; i < 8; i++) {
    const abort = new AbortController();
    const result = await f.run(scope, i, 'cancel-survivor', { signal: abort.signal, onStdout() { abort.abort('one'); abort.abort('two'); } });
    abort.abort('late'); assert.equal(result.classification, 'cancelled'); assert.equal(result.disposition, 'drained');
  }
  const one = await f.executor.settleScope(scope), two = await f.executor.settleScope(scope);
  assert.equal(one.receipt, two.receipt); assert.equal(f.journal.snapshot().state.commands.length, 7);
});

test('unsupported platform and negative/EPERM group probes fail closed, never signal reused identities', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
  try {
    const { createScopedProcess } = await import('../lib/scoped-process.mjs');
    assert.throws(() => createScopedProcess(['/bin/true']), /UNSUPPORTED_MODE/);
    assert.equal(probeGroup(123), 'unknown');
  } finally { Object.defineProperty(process, 'platform', descriptor); }
  assert.equal(probeGroup(-1), 'unknown');
  const f = fixture(t), scope = f.executor.openDeclaredShell();
  const original = process.kill; let probes = 0;
  const mock = t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(signal, 0, 'parent must NEVER signal a saved/reused PGID'); probes++;
    throw Object.assign(new Error('unobservable'), { code: 'EPERM' });
  });
  let result;
  try { result = await f.run(scope, 1, 'utf8'); } finally { mock.mock.restore(); }
  assert.equal(process.kill, original); assert.ok(probes > 0);
  assert.equal(result.disposition, 'unknown'); assert.equal(result.receipt, null);
});

test('bounded bootstrap/shutdown abandon owns timers/readers without authorizing fake process evidence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(process, 'kill', (_pid, signal) => { assert.equal(signal, 0); throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  for (const phase of ['bootstrap', 'shutdown']) {
    let abandoned = 0, destroyed = 0, unreferenced = 0;
    const stream = () => Object.assign(new EventEmitter(), { setEncoding() {}, write() {}, destroy() { destroyed++; } });
    const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: stream(), stderr: stream(), stdio: [null, null, null, stream()], unref() { unreferenced++; } });
    const lifecycle = createScopedProcess(['/bin/true']);
    lifecycle.attach(child, () => abandoned++); lifecycle.dispatch();
    if (phase === 'shutdown') {
      child.stdio[3].emit('data', '{"type":"ready","pid":12345}\n{"type":"direct","code":0,"signal":null,"spawnError":false}\n{"type":"residual"}\n');
      t.mock.timers.tick(11000);
    } else t.mock.timers.tick(5500);
    assert.equal(abandoned, 1); assert.equal(unreferenced, 1); assert.equal(destroyed, 3);
    const result = await lifecycle.settle({ code: 0, signal: null });
    assert.equal(result.disposition, 'unknown');
    lifecycle.terminate(); t.mock.timers.tick(20000); assert.equal(abandoned, 1);
  }
});

test('anchor production-main action boundaries: mid-batch loss/budgets, control precedence, drain and one in-flight race', () => {
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', new URL('./support/delegation-executor/anchor-probes.py', import.meta.url).pathname, ANCHOR_PATH],
    { encoding: 'utf8', env: process.env, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const probes = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(probes.length, 40);
  assert.ok(probes.every(p => p.check === 'PASS'));
  assert.equal(probes.find(p => p.case === 'many-eof').kills, 0);
  assert.equal(probes.find(p => p.case === 'many-mid-eof').kills, 2048);
  assert.ok(probes.filter(p => p.case.startsWith('inflight-')).every(p => p.inFlightAfterFinalCheck === 1));
});

test('writer disposal revokes the live executor synchronously; no receipt or post-disposal dispatch', async t => {
  const f = fixture(t), scope = f.executor.openDeclaredShell();
  const result = await f.run(scope, 1, 'waiting', { onStdout() { f.journal.dispose(); } });
  assert.equal(result.disposition, 'unknown'); assert.equal(result.receipt, null);
  assert.equal(f.executor.inspect().lost, true);
  assert.throws(() => f.run(scope, 2, 'utf8'), /OWNERSHIP_UNKNOWN/);
});

test('opted UTF8 streaming/capture limits and fixed-shell success use shared production output path', async t => {
  const f = fixture(t), scope = f.executor.openDeclaredShell(); let captured = '';
  const result = await f.run(scope, 1, 'utf8', { captureStdout: false, onStdout(chunk) { captured += chunk; } });
  assert.equal(captured, 'A😀B'); assert.equal(result.stdout, ''); assert.equal(result.ok, true);
  const shell = await f.track(f.executor.runShell(scope, 2, '/bin/sh', ['-c', "printf 'fixed-shell'"], defaults));
  assert.equal(shell.ok, true); assert.equal(shell.stdout, 'fixed-shell');
  const large = await f.track(f.executor.runShell(scope, 3, process.execPath,
    ['-e', "process.stdout.write('😀'.repeat(10000));process.stderr.write('x'.repeat(10000))"],
    { ...defaults, maxStdoutBytes: 1024, maxStderrBytes: 1024 }));
  assert.equal(large.ok, true); assert.equal(large.stdoutTruncated, true); assert.equal(large.stderrTruncated, true);
  assert.doesNotMatch(large.stdout, /\uFFFD/); assert.ok(Buffer.byteLength(large.stdout) < 1200);
});

test('repair: actual channel loss synchronously vetoes all original scopes/receipts before later listener', async t => {
  const f = fixture(t), declared = f.executor.openDeclaredShell();
  const prior = await f.run(declared, 1, 'utf8');
  const channels = [], writes = [[], []]; let ready = 0;
  const workers = f.journal.snapshot().state.nodes.map((n, i) => f.executor.startInvocation(n.nodeId, process.execPath,
    ['-e', "process.stdout.write('ready');setTimeout(()=>{},700)"], { timeoutMs: 2000,
      onChildStart(child) {
        channels[i] = child.stdio[3]; const write = channels[i].write;
        channels[i].write = function(value, ...args) { writes[i].push(String(value)); return write.call(this, value, ...args); };
      }, onStdout() { ready++; } }));
  workers.forEach(w => f.track(w.result));
  const until = Date.now() + 3000;
  while (ready < 2 && Date.now() < until) await pause(10);
  assert.equal(ready, 2);
  const checked = new Promise(resolve => channels[0].once('error', () => {
    assert.equal(f.executor.inspect().lost, true);
    assert.throws(() => guardDelegationExecutor(f.executor), /OWNERSHIP_UNKNOWN/);
    assert.throws(() => f.executor.consumeReceipt(declared, prior.receipt, prior.commandId), /OWNERSHIP_UNKNOWN/);
    assert.throws(() => f.executor.runShell(workers[1].scope, 2, '/bin/true', [], defaults), /OWNERSHIP_UNKNOWN/);
    f.executor.revoke(); resolve();
  }));
  const before = writes[0].length; channels[0].destroy(Error('live owned loss')); await checked;
  assert.equal(writes[0].length, before, 'no revoke/TERM on already-observed lost authority');
  assert.equal(writes[1].filter(s => s.includes('revoke')).length, 1);
  assert.ok((await Promise.all(workers.map(w => w.result))).every(r => r.disposition === 'unknown' && !r.receipt));
});

test('repair: reentrant/throwing loss listener and reader close cannot skip loss or other cleanup', async t => {
  let notified = 0, abandoned = 0, unreferenced = 0; const destroyed = [];
  const stream = name => Object.assign(new EventEmitter(), { setEncoding() {}, write() {}, destroy() { destroyed.push(name); if (name === 'out') throw Error('close failure'); } });
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: stream('out'), stderr: stream('err'), stdio: [null, null, null, stream('control')], unref() { unreferenced++; } });
  t.mock.method(process, 'kill', () => { throw Object.assign(Error('unknown'), { code: 'EPERM' }); });
  const lifecycle = createScopedProcess(['/bin/true'], 100, () => {}, () => { notified++; lifecycle.revoke(); throw Error('listener'); });
  lifecycle.attach(child, () => abandoned++);
  child.stdio[3].emit('error', Error('owned channel loss'));
  child.stdio[3].emit('error', Error('repeat')); lifecycle.revoke(); lifecycle.terminate(); lifecycle.dispatch();
  assert.equal(notified, 1); assert.equal(abandoned, 1); assert.equal(unreferenced, 1);
  assert.deepEqual(destroyed, ['control', 'out', 'err']);
  assert.equal((await lifecycle.settle({ code: 0 })).disposition, 'unknown');
});

test('repair: synchronous control write loss cannot re-arm shutdown after abandonment', t => {
  const timers = new Set(); let losses = 0;
  t.mock.method(globalThis, 'setTimeout', fn => { timers.add(fn); return fn; });
  t.mock.method(globalThis, 'clearTimeout', fn => timers.delete(fn));
  const stream = () => Object.assign(new EventEmitter(), { setEncoding() {}, destroy() {}, write(value, callback) { callback(Error('synchronous owned write error')); } });
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: stream(), stderr: stream(), stdio: [null, null, null, stream()], unref() {} });
  const lifecycle = createScopedProcess(['/bin/true'], 100, () => {}, () => losses++);
  lifecycle.attach(child, () => {});
  child.stdio[3].emit('data', '{"type":"ready","pid":12345}\n');
  lifecycle.terminate();
  assert.equal(losses, 1); assert.equal(timers.size, 0);
  lifecycle.terminate(); lifecycle.revoke(); assert.equal(timers.size, 0);
});

test('repair: start rejection vetoes scope in its first rejection reaction before later listeners', async t => {
  const f = fixture(t), scope = f.executor.openDeclaredShell(); let checked = false;
  const result = await f.run(scope, 1, 'utf8', { onChildStart() {
    const rejected = Promise.reject(Error('async start failure'));
    queueMicrotask(() => { rejected.catch(() => {
      assert.throws(() => f.executor.runShell(scope, 2, '/bin/true', [], defaults), /PARENT_NOT_ACTIVE|OWNERSHIP_UNKNOWN/); checked = true;
    }); }); return rejected;
  } });
  assert.equal(checked, true); assert.equal(result.classification, 'start_error');
  assert.equal(result.disposition, 'unknown'); assert.equal(result.physicalDisposition, 'drained');
  assert.equal(f.executor.inspect().acceptedCommands, 1);
});

test('repair: sync/async end failure blocks reentrant admission before result publication', async t => {
  for (const async of [false, true]) {
    const f = fixture(t), scope = f.executor.openDeclaredShell(); let checked = false;
    const probe = () => { assert.throws(() => f.executor.runShell(scope, 2, '/bin/true', [], defaults), /PARENT_NOT_ACTIVE/); checked = true; };
    const result = await f.run(scope, 1, 'utf8', { onChildEnd() {
      if (async) { setImmediate(probe); return Promise.reject(Error('async end failure')); }
      queueMicrotask(probe); throw Error('end failure');
    } });
    if (async) await new Promise(resolve => setImmediate(resolve));
    assert.equal(checked, true); assert.equal(result.classification, 'callback_error'); assert.equal(result.disposition, 'drained');
    assert.equal(f.executor.inspect().acceptedCommands, 1);
  }
});

test('repair: preadmission denial provenance is exact, single-use and covers occurrence/command caps', async t => {
  const f = fixture(t), scope = f.executor.openDeclaredShell(), other = f.executor.openDeclaredShell();
  const abort = new AbortController(); abort.abort('finite no-child');
  await f.run(scope, 1, 'utf8', { signal: abort.signal });
  for (const [occurrence, command, pattern] of [[1, '/bin/true', /REQUEST_CONFLICT/], [2, '\u0001'.repeat(11000), /command bound/]]) {
    let error;
    assert.throws(() => f.executor.runShell(scope, occurrence, command, [], defaults), e => { error = e; return pattern.test(e.message); });
    assert.equal(takeExecutorDenial(f.executor, new Error(error.message), scope, 'shell'), false);
    assert.equal(takeExecutorDenial({ ...f.executor }, error, scope, 'shell'), false);
    assert.equal(takeExecutorDenial(f.executor, error, other, 'shell'), false);
    assert.equal(takeExecutorDenial(f.executor, error, scope, 'shell'), true);
    assert.equal(takeExecutorDenial(f.executor, error, scope, 'shell'), false);
  }
  for (let i = 2; i <= 128; i++) await f.run(scope, i, 'utf8', { signal: abort.signal });
  let error;
  assert.throws(() => f.executor.runShell(scope, 129, '/bin/true', [], defaults), e => { error = e; return /ADMISSION_LIMIT/.test(e.message); });
  assert.equal(takeExecutorDenial(f.executor, error, scope, 'shell'), true);
  assert.equal(f.executor.inspect().lost, false); assert.equal(f.executor.inspect().acceptedCommands, 128);
  assert.equal((await f.executor.settleScope(scope)).receipt.commands.length, 128);
});

for (const [hook, bit] of [['onChildStart', 1], ['onStdout', 2], ['onStderr', 4], ['onChildEnd', 8]])
  test(`callback lifetime: acknowledged ${hook} command cannot authorize a stale whole declared scope`, async t => {
    const f = fixture(t), scope = f.executor.openDeclaredShell();
    let reject;
    const deferred = new Promise((_, r) => { reject = r; });
    const first = await f.track(f.executor.runShell(scope, 1, process.execPath,
      ['-e', "process.stdout.write('out');process.stderr.write('err')"], { ...defaults, [hook]() { return deferred; } }));
    assert.equal(first.classification, 'clean'); assert.equal(first.disposition, 'drained');
    const acknowledged = structuredClone(f.journal.snapshot().state.commands[0]);
    // A different command in the SAME original scope is still physically live.
    let ready;
    const live = new Promise(r => { ready = r; });
    const second = f.track(f.executor.runShell(scope, 2, process.execPath,
      ['-e', "process.stdout.write('ready');setTimeout(()=>{},150)"], { ...defaults, onStdout() { ready(); } }));
    await live;
    reject(Error('observed after physical acknowledgement')); await pause(0);
    assert.throws(() => f.executor.runShell(scope, 3, '/bin/true', [], defaults), /PARENT_NOT_ACTIVE/);
    assert.deepEqual(f.journal.snapshot().state.commands[0], acknowledged);
    if (bit === 1) assert.throws(() => f.executor.consumeReceipt(scope, first.receipt, first.commandId), /OWNERSHIP_UNKNOWN/);
    else f.executor.consumeReceipt(scope, first.receipt, first.commandId); // Physical acknowledgement only.
    await second;
    const settled = await f.executor.settleScope(scope);
    assert.deepEqual(f.journal.snapshot().state.commands[0], acknowledged);
    assert.equal(first.ok, true); // Immutable historical command, NOT scope approval.
    if (bit === 1) { assert.equal(settled.receipt, null); assert.equal(settled.disposition, 'unknown'); }
    else {
      assert.equal(settled.ok, false); assert.deepEqual(settled.receipt.callbackFailures, [bit, 0]);
      f.executor.consumeReceipt(scope, settled.receipt);
      assert.deepEqual(inspectDelegationJournal(f.journal.directory, f.journal.binding).state, f.journal.snapshot().state);
    }
  });

test('callback lifetime: declared phase consumer checks sealed scope, not historical clean command', async t => {
  const f = fixture(t); let advances = 0, reject;
  const deferred = new Promise((_, r) => { reject = r; });
  const result = await declaredPhase(f, 'utf8', () => advances++, { onChildEnd() { return deferred; } });
  assert.equal(result.ok, true); assert.equal(advances, 0);
  reject(Error('post-seal end rejection')); await pause(0); assert.equal(advances, 0);
});

test('callback lifetime: pending start expiry holds; owner loss interrupts finite observer wait without new signals', async t => {
  for (const loss of [false, true]) {
    const f = fixture(t), scope = f.executor.openDeclaredShell();
    let reject, channel; const deferred = new Promise((_, r) => { reject = r; });
    const r = await f.run(scope, 1, 'utf8', { onChildStart(p) { channel = p.stdio[3]; return deferred; } });
    assert.equal(r.classification, 'clean');
    let writes = 0; const write = channel.write;
    channel.write = function(...args) { writes++; return write.apply(this, args); };
    const before = Date.now(), pending = f.executor.settleScope(scope);
    if (loss) setTimeout(() => f.executor.revoke(), 20);
    const settled = await pending;
    assert.equal(settled.receipt, null); assert.equal(settled.disposition, 'unknown');
    assert.ok(Date.now() - before < (loss ? 800 : 2500));
    const snapshot = f.journal.snapshot(); reject(Error('post-seal rejection')); await pause(0);
    assert.deepEqual(f.journal.snapshot(), snapshot); assert.equal(writes, 0);
    assert.equal(f.executor.inspect().lost, true);
  }
});

test('owner revoke disables pending escalation and all receipts; finite fixture fallback is not settlement permission', async t => {
  const f = fixture(t), scope = f.executor.openDeclaredShell();
  let revoked = false;
  const result = await f.run(scope, 1, 'normal-survivor', { killGraceMs: 500, onStdout() { revoked = true; f.executor.revoke(); } });
  assert.equal(revoked, true); assert.equal(result.disposition, 'unknown'); assert.equal(result.receipt, null);
  assert.equal(f.journal.snapshot().state.commands[0].slots.length, 3);
});
