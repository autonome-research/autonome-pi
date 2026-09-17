import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { getEventListeners } from 'node:events';
import { createDelegationRuntime, delegationLaneCap } from '../lib/delegation-runtime.mjs';
import { createDelegationJournal, inspectDelegationJournal } from '../lib/delegation-journal.mjs';
import { createProcessJournal } from '../lib/process-journal.mjs';
import { canonicalJSON, readStoredArtifact } from '../lib/delegation-storage.mjs';
import { probeGroup } from '../lib/scoped-process.mjs';
import { assertBudgetInvariants } from '../lib/delegation-budget.mjs';
import { initialState, reduceEvent, composeFinalResult } from '../lib/delegation-journal-model.mjs';
const worker = new URL('./support/delegation-runtime/worker.mjs', import.meta.url).pathname;
const pause = ms => new Promise(r => setTimeout(r, ms));
const scope = { read: ['src'], write: ['src'] };
const child = (label, agentBudget = 1, extras = {}) => ({ label, agentBudget, task: label,
  acceptance: [{ id: 'a', criterion: 'finite work' }], permissions: 'r', directoryScope: scope, ...extras });
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'delegation-runtime-'));
  for (const d of ['workspace', 'workspace/src', 'workspace/src/narrow', 'profile', 'artifacts']) fs.mkdirSync(join(dir, d), { mode: 0o700 });
  fs.writeFileSync(join(dir, 'workspace/src/file'), 'parent');
  fs.writeFileSync(join(dir, 'workspace/src/narrow/file'), 'child');
  const phases = options.phases ?? [{ type: 'agent', name: 'root' }];
  const roots = phases.flatMap((p, phaseIndex) => !['agent', 'fanout'].includes(p.type) ? [] : (p.items ?? [p.name]).map((label, itemIndex) => ({
    phaseIndex, ...(p.items ? { itemIndex } : {}), agentBudget: options.budgets?.[phaseIndex] ?? 8,
    label, ...(options.deferred ? { taskTemplate: `finite template ${label} {{outputs}}`, contextTemplate: `context ${phaseIndex}:${itemIndex}` } : { task: `finite ${label}` }),
    permissions: options.permissions?.[itemIndex] ?? 'r', directoryScope: scope, deadlineAt: options.deadlineAt ?? null,
  })));
  let armedFault;
  const j = createDelegationJournal({ artifactDirectory: join(dir, 'artifacts'), workspace: join(dir, 'workspace'), protectedDirectories: [join(dir, 'profile')],
    runId: 'runtime-fixture', specDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
    policy: { maxDepth: options.depth ?? 2, totalAgentBudget: roots.reduce((s, n) => s + n.agentBudget, 0), directoryScope: scope, context: { objective: 'finite', constraints: [] } },
    roots, fault(point) { armedFault?.(point); } });
  const pj = createProcessJournal(join(dir, 'artifacts'), 'runtime-fixture');
  const starts = [], gates = new Map(), handles = new Map(), events = [], emittedArtifacts = [], owned = new Set();
  const originalStarted = pj.started;
  pj.started = (token, pid) => { owned.add(pid); originalStarted(token, pid); };
  const state = () => j.snapshot().state;
  const content = n => JSON.parse(readStoredArtifact(j.directory, { artifactId: n.result.artifactId, bytes: n.result.bytes, sha256: n.result.sha256 }));
  const release = h => fs.writeFileSync(gates.get(h.assignment.nodeId).gate, 'done');
  const complete = (h, status = 'success', requestId = 'complete') => h.complete(requestId, { status, summary: 'finite claim',
    acceptance: h.assignment.acceptance.map(a => ({ id: a.id, outcome: status === 'success' ? 'passed' : 'unverified', evidenceIds: [] })),
    evidence: [], remainingWork: [], childReviews: state().nodes.filter(n => n.parentNodeId === h.assignment.nodeId && n.joined)
      .map(n => ({ childNodeId: n.nodeId, resultHash: n.result.sha256, decision: 'accepted', reason: 'reviewed failure or success' })) });
  let runtime;
  function build(overrides = {}) {
    runtime = createDelegationRuntime({ journal: j, processJournal: pj, phases,
      operator: options.operator ?? { maxConcurrentAgents: 2, maxLiveAgents: 6 }, deadlinePolicy: { supervised: true, ...options.deadlinePolicy },
      ...(options.signal ? { signal: options.signal } : {}),
      worker(n) {
        starts.push(n.nodeId);
        const gate = join(dir, `gate-${n.nodeId}`);
        let ready, pending = ''; const promise = new Promise(r => { ready = r; }); gates.set(n.nodeId, { gate, promise });
        return { command: process.execPath, args: [worker, gate, options.modes?.[n.label] ?? 'clean'], env: { ...process.env },
          onStdout(chunk) {
            pending += chunk;
            while (pending.includes('\n')) {
              const at = pending.indexOf('\n'), event = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1);
              if (event.type === 'session' && event.id === 'ready') { Object.assign(gates.get(n.nodeId), { payloadPid: event.pid, anchorPid: event.anchorPid }); ready(); }
            }
            return options.onStdout?.(chunk, n);
          },
          ...(options.onChildStart ? { onChildStart: child => options.onChildStart(child, n) } : {}) };
      },
      async onInvocation(h) {
        handles.set(h.assignment.nodeId, h);
        await gates.get(h.assignment.nodeId).promise;
        if (options.drive) await options.drive(h, f);
        else { complete(h); release(h); }
      },
      onEvent(e) { events.push(e); options.onEvent?.(e, f); },
      ...(options.render ? { render: input => options.render(input, f) } : {}),
      ...(options.emitArtifact ? { emitArtifact: input => { emittedArtifacts.push(input); return options.emitArtifact(input, f); } } : {}),
      ...overrides });
    return runtime;
  }
  const f = { dir, j, pj, state, content, gates, handles, starts, events, emittedArtifacts, complete, release, build,
    get runtime() { return runtime; }, armFault(fn) { armedFault = fn; },
    delegate(h, children, requestId = 'delegate') { return h.delegate(requestId, { directoryRevision: h.revision(), children }); } };
  t.after(async () => {
    armedFault = undefined;
    for (const { gate } of gates.values()) fs.writeFileSync(gate, 'finite cleanup release');
    for (const pid of owned) {
      const end = Date.now() + 6500;
      while (probeGroup(pid) === 'present' && Date.now() < end) await pause(20);
      assert.equal(probeGroup(pid), 'gone', `live-owned group ${pid} ${dir}`);
    }
    j.dispose();
    fs.writeFileSync(join(dir, 'cleanup.json'), JSON.stringify({ groups: [...owned].map(pid => ({ pid, disposition: 'ESRCH' })), signals: 0 }));
    t.diagnostic(`retained ${dir}; agents=${starts.length}; anchors=${owned.size}; ESRCH observations; no teardown signals`);
  });
  return f;
}

test('cap matrix and strict static ingress reject before spawn', async t => {
  for (let d = 0; d <= 4; d++) for (const execution of [1, 3, 16]) for (const live of [1, 3, 24, 128]) {
    const expected = Math.min(7, execution, Math.floor(live / (d + 1)));
    if (expected) assert.equal(delegationLaneCap(d, 7, { maxConcurrentAgents: execution, maxLiveAgents: live }), expected);
    else assert.throws(() => delegationLaneCap(d, 7, { maxConcurrentAgents: execution, maxLiveAgents: live }), /ADMISSION_LIMIT/);
  }
  for (const bad of [0, 17, '3', -0, NaN]) assert.throws(() => delegationLaneCap(2, 3, { maxConcurrentAgents: bad }), /INVALID_REQUEST/);
  const f = fixture(t);
  for (const extra of [{ attempts: 2 }, { itemsFrom: 'dynamic' }, { resumeRunId: 'old' }, { template: 'x' }])
    assert.throws(() => f.build({ phases: [{ type: 'agent', name: 'root', ...extra }] }), /INVALID_REQUEST/);
  assert.throws(() => f.build({ operator: { maxLiveAgents: 2 } }), /ADMISSION_LIMIT/);
  assert.throws(() => f.build({ operator: null }), /INVALID_REQUEST/);
  assert.throws(() => f.build({ deadlinePolicy: null }), /INVALID_REQUEST/);
  assert.equal(f.starts.length, 0);
});

test('deferred ordered phases bind prior verified outputs, duplicate item indexes, shell and artifact positions before activation', async t => {
  const phases = [
    { type: 'agent', name: 'first' },
    { type: 'artifact', name: 'snapshot', from: 'first' },
    { type: 'shell', name: 'shell', permissions: 'rwx', command: 'template shell' },
    { type: 'fanout', name: 'review', items: ['duplicate', 'duplicate'], concurrency: 2 },
  ];
  const f = fixture(t, { phases, budgets: [1, 0, 0, 1], depth: 0, deferred: true,
    render(input) {
      if (input.kind === 'shell') {
        assert.equal(input.outputs.first.summary, 'finite claim'); return 'printf shell-bound';
      }
      if (input.kind === 'artifact') {
        assert.equal(input.value.summary, 'finite claim'); return `artifact:${input.value.result.sha256}`;
      }
      if (input.phaseIndex === 0) {
        assert.deepEqual(Object.keys(input.outputs), []); return [{ task: 'rendered first', parentContextSummary: 'root context' }];
      }
      assert.equal(input.phaseIndex, 3); assert.equal(input.outputs.first.summary, 'finite claim');
      assert.equal(input.outputs.shell.stdout, 'shell-bound'); assert.match(input.outputs.snapshot.content, /^artifact:/);
      return input.roots.map(root => ({ task: `review item ${root.itemIndex} after ${input.outputs.first.result.sha256}` }));
    },
    emitArtifact(input) { assert.equal(input.phase.name, 'snapshot'); assert.match(input.content, /^artifact:/); },
    drive(h, f) {
      const n = f.state().nodes.find(n => n.nodeId === h.assignment.nodeId);
      assert.equal(f.runtime.inspect().outputs[n.phaseIndex === 0 ? 'first' : 'review'], undefined);
      if (n.phaseIndex === 0) {
        assert.equal(h.assignment.task, 'rendered first');
        const context = h.context('materialized-context');
        assert.equal(context.assignment.task, 'rendered first');
        assert.ok(context.directory.some(row => row.phaseIndex === 3 && /finite template duplicate/.test(row.assignmentPreview)));
      } else assert.equal(h.assignment.task, `review item ${n.itemIndex} after ${f.runtime.inspect().outputs.first.result.sha256}`);
      assert.match(h.assignment.acceptance[0].criterion, /sha256:[a-f0-9]{64}/);
      f.complete(h); f.release(h);
    } });
  const result = await f.build().run(); assert.equal(result.status, 'success');
  assert.equal(f.emittedArtifacts.length, 1); assert.equal(f.starts.length, 3);
  const state = f.state();
  assert.deepEqual(state.materializations.map(m => m.phaseIndex), [0, 3]);
  assert.deepEqual(state.nodes.map(n => n.itemIndex), [undefined, 0, 1]);
  state.nodes.forEach(n => {
    const result = f.content(n); assert.equal(result.assignment.task, n.assignment.task);
    assert.equal(result.taskHash, createHash('sha256').update(n.assignment.task).digest('hex'));
    assert.equal(result.assignmentHash, createHash('sha256').update(canonicalJSON(n.assignment)).digest('hex'));
  });
  assert.deepEqual(f.runtime.inspect().outputs.review.map(row => row.itemIndex), [0, 1]);
  assert.deepEqual(inspectDelegationJournal(f.j.directory, f.j.binding).state, state);
  const events = fs.readFileSync(join(f.j.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const phaseIndex of [0, 3]) {
    const materialized = events.findIndex(e => e.type === 'root_assignments_materialized' && e.payload.phaseIndex === phaseIndex);
    const activated = events.findIndex(e => e.type === 'root_activated' && state.nodes.find(n => n.nodeId === e.payload.nodeId)?.phaseIndex === phaseIndex);
    assert.ok(materialized >= 0 && activated > materialized);
  }
});

test('whole deferred fanout validation is atomic: one oversized task launches and materializes none', async t => {
  const f = fixture(t, { phases: [{ type: 'fanout', name: 'review', items: ['duplicate', 'duplicate'], concurrency: 2 }],
    budgets: [1], depth: 0, deferred: true, render({ roots }) { return roots.map((_, i) => i ? { task: 'x'.repeat(4097) } : { task: 'valid' }); } });
  const before = f.j.snapshot().state.sequence;
  const result = await f.build().run(); assert.equal(result.status, 'failed'); assert.equal(result.held, false);
  assert.equal(f.starts.length, 0); assert.equal(f.state().materializations.length, 0); assert.equal(f.state().budget.spent, 0);
  assert.ok(f.state().sequence > before); // only known terminal cleanup, never a materialization/activation
  const events = fs.readFileSync(join(f.j.directory, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(events, /root_assignments_materialized|root_activated/);
  assert.ok(f.state().nodes.every(n => n.joined && n.closed && n.assignment === undefined));
});

test('deferred rendering has bounded late rejection and cancellation/loss checks before publication', async t => {
  for (const boundary of ['late-reject', 'cancel', 'loss']) {
    let reject, resolve;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const f = fixture(t, { deferred: true, render() { return pending; } });
    const runtime = f.build(), running = runtime.run();
    await pause(20); assert.equal(f.starts.length, 0); assert.equal(f.state().materializations.length, 0);
    if (boundary === 'cancel') { runtime.cancel(); resolve([{ task: 'too late' }]); }
    else if (boundary === 'loss') { f.j.dispose(); resolve([{ task: 'too late' }]); }
    const result = await running;
    assert.equal(result.held, boundary === 'loss');
    assert.equal(result.status, boundary === 'loss' ? 'unknown' : boundary === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(f.starts.length, 0); assert.equal(f.state().materializations.length, 0);
    const snapshot = f.j.snapshot(); reject(Error('late render rejection')); await pause(0); assert.deepEqual(f.j.snapshot(), snapshot);
  }
});

test('artifact emission rejection produces no artifact output or later root activation', async t => {
  const f = fixture(t, { deferred: true,
    phases: [{ type: 'agent', name: 'first' }, { type: 'artifact', name: 'report', from: 'first' }, { type: 'agent', name: 'later' }],
    budgets: [1, 0, 1], depth: 0,
    render(input) { return input.kind === 'roots' ? [{ task: `rendered ${input.phase.name}` }] : 'artifact content'; },
    emitArtifact() { return Promise.reject(Error('artifact write failed')); } });
  const result = await f.build().run(); assert.equal(result.status, 'failed'); assert.equal(result.held, false);
  assert.equal(f.starts.length, 1); assert.equal(f.runtime.inspect().outputs.report, undefined);
  const later = f.state().nodes.find(n => n.phaseIndex === 2);
  assert.equal(later.invocationId, null); assert.equal(later.assignment, undefined);
});

test('real tree at D+1 headroom: live parked ancestors, read-only parallel lane, serial failure/partial review, fixed later quota', async t => {
  let laneReady; const unrelatedReady = new Promise(r => { laneReady = r; });
  let done; const treeDone = new Promise(r => { done = r; });
  const f = fixture(t, { phases: [{ type: 'fanout', name: 'roots', items: ['duplicate', 'duplicate'], concurrency: 2 }, { type: 'agent', name: 'integrate' }],
    budgets: [5, 2], drive: async (h, f) => {
      const n = f.state().nodes.find(n => n.nodeId === h.assignment.nodeId);
      if (n.phaseIndex === 0 && n.itemIndex === 1) { laneReady(); await treeDone; }
      else if (n.phaseIndex === 0) {
        await unrelatedReady;
        const request = { directoryRevision: h.revision(), children: [child('child', 3), child('sibling')] };
        const pending = h.delegate('tree', request);
        assert.equal(h.delegate('tree', request), pending);
        assert.throws(() => h.delegate('tree', { ...request, children: [child('conflict')] }), /REQUEST_CONFLICT/);
        assert.throws(() => h.readFile('src/file'), /PARENT_NOT_ACTIVE/);
        assert.throws(() => f.complete(h, 'success', 'denied-completion'), /PARENT_NOT_ACTIVE/);
        const joined = await pending;
        assert.deepEqual(joined.map(r => r.result.status), ['partial', 'failed']);
        assert.equal(h.readFile('src/file').toString(), 'parent');
        assert.equal(f.state().budget.nodes.find(b => b.nodeId === f.state().nodes[2].nodeId).available, 2);
        done();
      } else if (n.label === 'child') {
        await f.delegate(h, [child('grandchild', 1, { directoryScope: { read: ['src/narrow'], write: [] } })]);
        f.complete(h, 'partial'); f.release(h); return;
      } else if (n.label === 'grandchild') {
        assert.throws(() => h.readFile('src/file'), /SCOPE_DENIED/);
        assert.equal(h.readFile('src/narrow/file').toString(), 'child');
        const live = f.state().nodes.filter(n => n.pid && !n.joined);
        assert.equal(live.length, 4); live.forEach(n => {
          assert.equal(probeGroup(n.pid), 'present');
          const observed = f.gates.get(n.nodeId); assert.equal(observed.anchorPid, n.pid);
          assert.equal(process.kill(observed.payloadPid, 0), true); // current live fixture identity; observation only
        });
        assert.equal(f.runtime.inspect().reservedLiveSlots, 6);
      }
      f.complete(h); f.release(h);
    }, modes: { sibling: 'nonzero' } });
  const result = await f.build().run(); assert.equal(result.status, 'success');
  assert.equal(f.starts.length, 6); assert.equal(new Set(f.starts).size, 6);
  const s = f.state(); assertBudgetInvariants(s.budget); assert.equal(s.budget.spent, 6); assert.equal(s.budget.acceptedNodes, 6);
  assert.equal(s.budget.freeWorkflow, 6);
  const contents = s.nodes.map(n => f.content(n));
  contents.forEach(content => {
    assert.equal(content.schema, 'pi-workflow-delegation-result-evidence/v2');
    for (const field of ['assignment', 'assignmentHash', 'taskHash']) assert.equal(Object.hasOwn(content, field), false);
  });
  assert.equal(contents.reduce((sum, content) => sum + content.usage.totals.totalTokens, 0), 42);
  assert.deepEqual(inspectDelegationJournal(f.j.directory, f.j.binding).state, s);
  assert.equal(f.runtime.inspect().lanes.length, 0);
});

for (const permissions of [['rw', 'r', 'r'], ['rwx', 'r', 'r'], ['r', 'r', 'r']]) test(`root FIFO prefix leases ${permissions}`, async t => {
  let active = 0, maximum = 0;
  const f = fixture(t, { phases: [{ type: 'fanout', name: 'roots', items: ['a', 'b', 'c'], concurrency: 3 }], budgets: [1], depth: 0,
    permissions, operator: { maxConcurrentAgents: 3, maxLiveAgents: 3 }, drive: async (h, f) => {
      active++; maximum = Math.max(maximum, active);
      if (h.assignment.nodeId === f.state().nodes[0].nodeId && permissions[0] !== 'r') {
        assert.equal(f.runtime.inspect().lanes.length, 1);
        assert.equal(f.runtime.inspect().waitingRoots, 2);
      }
      await pause(100); f.complete(h); active--; f.release(h);
    } });
  assert.equal((await f.build().run()).status, 'success');
  assert.equal(maximum, permissions[0] === 'r' ? 3 : 2);
  assert.deepEqual(f.starts, f.state().nodes.map(n => n.nodeId));
});

test('scope lending denies parked writes/shell; child narrows and parent restores after exact joins', async t => {
  const f = fixture(t, { permissions: ['rwx'], drive: async (h, f) => {
    if (!f.state().nodes.find(n => n.nodeId === h.assignment.nodeId).parentNodeId) {
      const p = f.delegate(h, [child('narrow', 1, { permissions: 'rw', directoryScope: { read: ['src/narrow'], write: ['src/narrow'] } })]);
      assert.throws(() => h.writeFile('src/file', 'forbidden'), /PARENT_NOT_ACTIVE/);
      assert.throws(() => h.shell('parked-shell', 'printf forbidden'), /PARENT_NOT_ACTIVE/);
      await p; h.writeFile('src/file', 'restored');
      assert.equal((await h.shell('shell', 'printf scoped')).stdout, 'scoped');
    } else {
      assert.throws(() => h.writeFile('src/file', 'forbidden'), /SCOPE_DENIED/);
      h.writeFile('src/narrow/file', 'lent');
    }
    f.complete(h); f.release(h);
  } });
  assert.equal((await f.build().run()).status, 'success');
  assert.equal(fs.readFileSync(join(f.dir, 'workspace/src/file'), 'utf8'), 'restored');
});

test('acceptance-time child expiry while queued; no-deadline root stays live, no late dispatch/refund', async t => {
  const f = fixture(t, { drive: async (h, f) => {
    const n = f.state().nodes.find(n => n.nodeId === h.assignment.nodeId);
    if (!n.parentNodeId) {
      const ordered = await f.delegate(h, [child('slow'), child('expired', 2, { timeoutMs: 80 })]);
      assert.deepEqual(ordered.map(r => r.result.status), ['success', 'timeout']);
      assert.equal(ordered[1].deadlineAt, f.state().nodes.find(n => n.label === 'expired').authority.deadlineAt);
      assert.equal(h.assignment.authority.deadlineAt, null);
    } else await pause(140);
    f.complete(h); f.release(h);
  } });
  assert.equal((await f.build().run()).status, 'success');
  assert.equal(f.starts.length, 2); assert.equal(f.state().budget.spent, 2); assert.equal(f.state().budget.acceptedNodes, 3);
  assert.equal(f.state().budget.freeWorkflow, 6);
});

test('root deadline selected at activation, queue does not spend timeout', async t => {
  const f = fixture(t, { phases: [{ type: 'fanout', name: 'roots', items: ['a', 'b'], concurrency: 2, timeoutMs: 450 }],
    budgets: [1], depth: 0, permissions: ['rw', 'rw'], drive: async (h, f) => { await pause(200); f.complete(h); f.release(h); } });
  assert.equal((await f.build().run()).status, 'success');
  const [a, b] = f.state().nodes;
  assert.equal(a.authority.deadlineAt, null); assert.equal(b.authority.deadlineAt, null);
  assert.ok(b.effectiveDeadlineAt - a.effectiveDeadlineAt >= 200);
});

for (const cause of ['timeout', 'cancelled', 'disconnect']) test(`${cause} while parked cancels live subtree and unlaunched siblings; exact structural drain`, async t => {
  const f = fixture(t, { phases: [{ type: 'agent', name: 'root', ...(cause === 'timeout' ? { timeoutMs: 300 } : {}) }],
    drive: async (h, f) => {
      const n = f.state().nodes.find(n => n.nodeId === h.assignment.nodeId);
      if (!n.parentNodeId) {
        const p = f.delegate(h, [child('live'), child('queued')]);
        if (cause !== 'timeout') setTimeout(() => cause === 'cancelled' ? f.runtime.cancel() : h.disconnect(), 100);
        await p;
      } // no completion; executor's owned timers/cancellation drain the processes
    } });
  const result = await f.build().run();
  assert.equal(result.held, false); assert.equal(result.status, cause === 'cancelled' ? 'cancelled' : 'failed');
  const s = f.state(); assert.ok(s.nodes.every(n => n.joined && n.closed));
  assert.equal(s.budget.spent, 2); assert.equal(s.budget.acceptedNodes, 3);
  assert.equal(s.nodes.find(n => n.label === 'queued').invocationId, null);
  assert.equal(s.nodes[0].result.status, cause === 'disconnect' ? 'infrastructure_error' : cause);
});

test('already expired absolute root and pre-cancel create no intent/process', async t => {
  for (const cancel of [false, true]) {
    const signal = new AbortController(); if (cancel) signal.abort();
    const f = fixture(t, { deadlineAt: Date.now() - 1, signal: signal.signal });
    const result = await f.build().run();
    assert.equal(result.status, cancel ? 'cancelled' : 'failed'); assert.equal(result.held, false);
    assert.equal(f.starts.length, 0); assert.equal(f.state().budget.spent, 0); assert.equal(f.state().budget.acceptedNodes, 1);
    assert.equal(f.state().nodes[0].result.status, cancel ? 'cancelled' : 'timeout');
  }
});

test('shell deadline narrows root; mixed complete/shell denied, shell occurrence replay does not dispatch twice', async t => {
  const f = fixture(t, { permissions: ['rwx'], phases: [{ type: 'agent', name: 'root', timeoutMs: 450 }], drive: async (h, f) => {
    const p = h.shell('shell', 'sleep 2', 2000);
    assert.equal(h.shell('shell', 'sleep 2', 2000), p);
    assert.throws(() => f.complete(h), /PARENT_NOT_ACTIVE/);
    await p;
  } });
  const before = Date.now(); const result = await f.build().run();
  assert.equal(result.status, 'failed'); assert.equal(result.held, false); assert.ok(Date.now() - before < 1900);
  assert.equal(f.state().commands.length, 2); assert.equal(f.state().nodes[0].result.status, 'timeout');
});

for (const mode of ['clean', 'residual']) test(`declared shell ${mode} waits root joins and cannot advance on nonclean drain`, async t => {
  const command = mode === 'clean' ? 'printf declared' : `${JSON.stringify(process.execPath)} -e 'require("child_process").spawn("/bin/sleep",["1"],{stdio:"ignore"}).unref()'`;
  const f = fixture(t, { phases: [{ type: 'agent', name: 'first' }, { type: 'shell', name: 'shell', permissions: 'rwx', command }, { type: 'agent', name: 'last' }], budgets: [1, 0, 1], depth: 0 });
  const result = await f.build().run(); assert.equal(result.status, mode === 'clean' ? 'success' : 'failed');
  assert.equal(result.held, false); assert.equal(f.starts.length, mode === 'clean' ? 2 : 1);
  assert.equal(f.state().commandScopes.filter(s => s.kind === 'declared-shell').length, 1);
});

for (const kind of ['missing', 'nonzero', 'callback']) test(`${kind} worker retains actual result/source and closes without fake success`, async t => {
  const f = fixture(t, { modes: { root: kind === 'nonzero' ? 'nonzero' : 'clean' },
    ...(kind === 'callback' ? { onStdout() { throw Error('display'); } } : {}),
    drive(h, f) { if (kind !== 'missing') f.complete(h); f.release(h); } });
  const r = await f.build().run(); assert.equal(r.status, 'failed'); assert.equal(r.held, false);
  const result = f.content(f.state().nodes[0]);
  assert.equal(result.status, kind === 'missing' ? 'missing_completion' : kind === 'nonzero' ? 'failed' : 'infrastructure_error');
  assert.equal(result.usage.totals.totalTokens, 7);
});

test('scheduler observation callback throw is fail-stop, not success or admission authority', async t => {
  const f = fixture(t, { onEvent(e) { if (e.kind === 'running') throw Error('observer'); } });
  const r = await f.build().run(); assert.equal(r.status, 'failed'); assert.equal(r.held, false);
  assert.equal(f.state().nodes[0].result.status, 'infrastructure_error');
});

test('unknown owner/start ambiguity holds lane slots/leases, rejects next root/phase and cannot retry', async t => {
  const f = fixture(t, { phases: [{ type: 'fanout', name: 'roots', items: ['a', 'b'], concurrency: 2 }, { type: 'agent', name: 'last' }],
    budgets: [1, 1], permissions: ['rw', 'rw'], depth: 0, onChildStart() { throw Error('ambiguous start'); } });
  const runtime = f.build(), result = await runtime.run();
  assert.equal(result.status, 'unknown'); assert.equal(result.closed, false);
  assert.equal(f.starts.length, 1); assert.equal(runtime.inspect().reservedLiveSlots, 1);
  assert.equal(f.state().budget.spent, 1); assert.equal(f.state().nodes.filter(n => n.joined).length, 0);
  await assert.rejects(() => runtime.run(), /UNAUTHORIZED/);
  assert.equal(inspectDelegationJournal(f.j.directory, f.j.binding).launchAuthorized, false);
});

test('root activation durable fsync cut is inspect-only, never dispatch/replay', async t => {
  const f = fixture(t); const runtime = f.build();
  f.armFault(point => { if (point === 'after:event-fsync') throw Error('activation acknowledgement lost'); });
  const result = await runtime.run(); assert.equal(result.status, 'unknown'); assert.equal(f.starts.length, 0);
  const view = inspectDelegationJournal(f.j.directory, f.j.binding);
  assert.equal(view.launchAuthorized, false); assert.equal(view.resumable, false);
  assert.equal(view.state.nodes[0].schedulerState, 'admitted'); assert.equal(view.state.budget.spent, 0);
});

test('one lane at exact D+1 never needs a free execution slot for a grandchild', async t => {
  const f = fixture(t, { operator: { maxConcurrentAgents: 1, maxLiveAgents: 3 }, drive: async (h, f) => {
    const depth = f.state().budget.nodes.find(n => n.nodeId === h.assignment.nodeId).depth;
    if (depth < 2) await f.delegate(h, [child(`depth-${depth + 1}`, depth === 0 ? 3 : 1)]);
    else {
      const live = f.state().nodes.filter(n => n.pid && !n.joined);
      assert.equal(live.length, 3); live.forEach(n => {
        assert.equal(probeGroup(n.pid), 'present');
        const observed = f.gates.get(n.nodeId); assert.equal(observed.anchorPid, n.pid);
        assert.equal(process.kill(observed.payloadPid, 0), true);
      });
      assert.equal(f.runtime.inspect().reservedLiveSlots, 3);
    }
    f.complete(h); f.release(h);
  } });
  assert.equal((await f.build().run()).status, 'success'); assert.equal(f.starts.length, 3);
});

test('child-only timeout returns failure then dispatches sibling; parent noDeadline remains live', async t => {
  const f = fixture(t, { drive: async (h, f) => {
    const n = f.state().nodes.find(n => n.nodeId === h.assignment.nodeId);
    if (!n.parentNodeId) {
      const joined = await f.delegate(h, [child('timeout', 1, { timeoutMs: 180 }), child('next')]);
      assert.deepEqual(joined.map(c => c.result.status), ['timeout', 'success']);
      assert.equal(probeGroup(n.pid), 'present');
    } else if (n.label === 'timeout') return;
    f.complete(h); f.release(h);
  } });
  assert.equal((await f.build().run()).status, 'success'); assert.equal(f.state().budget.spent, 3);
});

test('parent nonzero mid-subtree cancels children, keeps parent actual failed usage/result', async t => {
  const f = fixture(t, { modes: { root: 'nonzero' }, drive: async (h, f) => {
    const n = f.state().nodes.find(n => n.nodeId === h.assignment.nodeId);
    if (!n.parentNodeId) {
      const pending = f.delegate(h, [child('live'), child('unlaunched')]);
      setTimeout(() => f.release(h), 120);
      await pending;
    }
  } });
  const result = await f.build().run(); assert.equal(result.status, 'failed'); assert.equal(result.held, false);
  assert.equal(f.state().nodes[0].result.status, 'failed'); assert.equal(f.content(f.state().nodes[0]).usage.totals.totalTokens, 7);
  assert.equal(f.state().nodes.find(n => n.label === 'unlaunched').invocationId, null);
  assert.ok(f.state().nodes.every(n => n.joined));
});

for (const boundary of ['admission', 'intent-start', 'result']) test(`user cancel at ${boundary} neither replays nor strands known work`, async t => {
  let fired = false;
  const f = fixture(t, {
    ...(boundary === 'intent-start' ? { onChildStart() { f.runtime.cancel(); } } : {}),
    ...(boundary === 'admission' ? { onEvent(e, f) { if (e.kind === 'phase') queueMicrotask(() => f.runtime.cancel()); } } : {}),
  });
  const runtime = f.build();
  if (boundary === 'result') f.armFault(point => {
    // Real fsync boundary instrumentation, not fabricated settlement. Inspect
    // actual durable last record before requesting cooperative cancellation.
    if (!fired && point === 'after:directory-fsync') {
      const log = fs.readFileSync(join(f.j.directory, 'events.jsonl'), 'utf8').trim().split('\n');
      if (JSON.parse(log.at(-1)).type === 'node_result') { fired = true; queueMicrotask(() => runtime.cancel()); }
    }
  });
  const result = await runtime.run(); assert.equal(result.held, false);
  assert.equal(result.status, 'cancelled'); assert.ok(f.state().nodes.every(n => n.joined));
  assert.equal(f.state().budget.spent, boundary === 'admission' ? 0 : 1);
});

test('denied occurrence remains denied after credits return; conflicts and completion replay are stable', async t => {
  const f = fixture(t, { drive: async (h, f) => {
    if (!f.state().nodes.find(n => n.nodeId === h.assignment.nodeId).parentNodeId) {
      const request = { directoryRevision: h.revision(), children: [child('too-large', 128)] };
      assert.throws(() => h.delegate('denied', request), /BUDGET_EXHAUSTED/);
      const before = f.state().budget.acceptedNodes;
      assert.throws(() => h.delegate('denied', request), /BUDGET_EXHAUSTED/);
      assert.throws(() => h.delegate('denied', { ...request, children: [child('small')] }), /REQUEST_CONFLICT/);
      assert.equal(f.state().budget.acceptedNodes, before);
      await f.delegate(h, [child('small')]);
    }
    const ref = f.complete(h); assert.deepEqual(f.complete(h), ref); f.release(h);
  } });
  assert.equal((await f.build().run()).status, 'success'); assert.equal(f.starts.length, 2);
});

test('request exhaustion cancels existing worker; counts never replenish after denials', async t => {
  const f = fixture(t, { drive: async (h) => {
    for (let i = 0; i < 128; i++) h.inspect();
    assert.throws(() => h.inspect(), /REQUEST_LIMIT/);
  } });
  const result = await f.build().run(); assert.equal(result.status, 'failed'); assert.equal(result.held, false);
  assert.equal(f.state().nodes[0].result.status, 'infrastructure_error');
});

test('unknown write error holds after cooperative cancellation; immutable assignment cannot restore access', async t => {
  let h;
  const f = fixture(t, { permissions: ['rw'], drive(handle) {
    h = handle;
    const original = fs.fsyncSync;
    // storageIO uses default fs at directory publication; filesystem's named
    // fs binding still performs the earlier temporary-file fsync normally.
    fs.fsyncSync = () => { throw Object.assign(Error('directory fsync ambiguous'), { code: 'EIO' }); };
    try { assert.throws(() => h.writeFile('src/file', 'changed before failed fsync'), /ambiguous/); }
    finally { fs.fsyncSync = original; }
    assert.equal(fs.readFileSync(join(f.dir, 'workspace/src/file'), 'utf8'), 'changed before failed fsync');
    assert.throws(() => h.readFile('src/file'), /OWNERSHIP_UNKNOWN/);
  } });
  const result = await f.build().run(); assert.equal(result.status, 'unknown'); assert.equal(result.closed, false);
  assert.equal(f.runtime.inspect().reservedLiveSlots, 3);
  assert.equal(f.state().nodes[0].joined, false); assert.ok(Object.isFrozen(h.assignment));
});

for (const cut of ['scheduler_configured', 'node_stopped']) test(`new ${cut} durable cut stays held/inspect-only with unchanged immutable manifest`, async t => {
  const f = fixture(t); let fired = false;
  const inject = point => {
    if (point !== 'after:event-fsync' || fired) return;
    const last = JSON.parse(fs.readFileSync(join(f.j.directory, 'events.jsonl'), 'utf8').trim().split('\n').at(-1));
    if (last.type === cut) { fired = true; throw Error('durable acknowledgement cut'); }
  };
  if (cut === 'scheduler_configured') {
    f.armFault(inject); assert.throws(() => f.build(), /acknowledgement cut/);
  } else {
    const runtime = f.build(); f.armFault(inject); runtime.cancel();
    assert.equal((await runtime.run()).status, 'unknown');
  }
  assert.equal(fired, true); assert.equal(f.starts.length, 0);
  const view = inspectDelegationJournal(f.j.directory, f.j.binding);
  assert.equal(view.launchAuthorized, false); assert.equal(view.manifest.roots[0].authority.deadlineAt, null);
  assert.equal(view.state.budget.spent, 0); assert.equal(view.state.budget.acceptedNodes, 1);
});

test('direct parent exit vetoes new sibling dispatch while its real residual group drains', async t => {
  const f = fixture(t, { modes: { root: 'residual' }, drive: async (h, f) => {
    const n = f.state().nodes.find(n => n.nodeId === h.assignment.nodeId);
    if (!n.parentNodeId) {
      const p = f.delegate(h, [child('first'), child('never')]);
      f.release(h); await p;
    } else {
      await pause(100); // Parent direct exit is independently reported before its 500ms residual drain.
      f.release(h);
    }
  } });
  const result = await f.build().run(); assert.equal(result.status, 'failed'); assert.equal(result.held, false);
  assert.equal(f.state().nodes.find(n => n.label === 'never').invocationId, null);
  assert.equal(f.content(f.state().nodes[0]).cause, 'RESIDUAL_CLEANUP');
});

test('actual live control disconnect while parked is unknown; no sibling/phase/restoration after bounded diagnostic', async t => {
  let rootChannel;
  const f = fixture(t, { phases: [{ type: 'agent', name: 'root' }, { type: 'agent', name: 'later' }],
    onChildStart(child) { rootChannel ??= child.stdio[3]; }, drive: async (h, f) => {
      const n = f.state().nodes.find(n => n.nodeId === h.assignment.nodeId);
      if (!n.parentNodeId) await f.delegate(h, [child('live'), child('never')]);
      else rootChannel.destroy(); // Owned live private channel only, no PID signalling.
    } });
  const result = await f.build().run(); assert.equal(result.status, 'unknown'); assert.equal(result.closed, false);
  assert.equal(f.starts.length, 2); assert.equal(f.runtime.inspect().reservedLiveSlots, 3);
  assert.equal(f.events.filter(e => e.kind === 'restored').length, 0);
  assert.equal(f.state().nodes.filter(n => n.joined).length, 0);
});

test('new durable config/deadline reducer is strict at clock/grant boundaries; old manifest stays byte-identical', async t => {
  const f = fixture(t, { deadlineAt: Date.now() + 30000, phases: [{ type: 'agent', name: 'root', timeoutMs: 1000 }] });
  const before = fs.readFileSync(join(f.j.directory, 'manifest.json'));
  assert.equal((await f.build().run()).status, 'success');
  assert.deepEqual(fs.readFileSync(join(f.j.directory, 'manifest.json')), before);
  const view = inspectDelegationJournal(f.j.directory, f.j.binding);
  const events = fs.readFileSync(join(f.j.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  let s = initialState(view.manifest);
  for (const event of events) {
    if (event.type === 'scheduler_configured') {
      for (const rootTimeouts of [[], [0], ['1000'], [null, null]])
        assert.throws(() => reduceEvent(s, { ...event, payload: { ...event.payload, rootTimeouts } }, view.manifest), /INVALID_REQUEST/);
    }
    if (event.type === 'root_activated') {
      const effective = Math.min(view.manifest.roots[0].authority.deadlineAt, event.at + 1000);
      assert.equal(event.payload.deadlineAt, effective);
      for (const deadlineAt of [null, effective - 1, effective + 1])
        assert.throws(() => reduceEvent(s, { ...event, payload: { ...event.payload, deadlineAt } }, view.manifest), /INVALID_REQUEST/);
      assert.throws(() => reduceEvent(s, { ...event, at: Number.MAX_SAFE_INTEGER }, view.manifest), /INVALID_REQUEST/);
    }
    s = reduceEvent(s, event, view.manifest);
  }
  assert.deepEqual(s, view.state);
});

test('repair: invocation/start/stdout failures veto operations at catch or observed rejection, not settlement', async t => {
  for (const kind of ['invocation', 'start', 'stdout', 'async-stdout', 'async-invocation']) {
    let handle, attempted = false, denied = false, invoked = false;
    const probe = () => { attempted = true; assert.throws(() => handle.writeFile('src/file', 'forbidden'), /CANCELLED|PARENT_NOT_ACTIVE|OWNERSHIP_UNKNOWN/); denied = true; };
    const f = fixture(t, { permissions: ['rw'],
      ...(kind === 'start' ? { onChildStart() { throw Error('start observer'); } } : {}),
      ...(['stdout', 'async-stdout'].includes(kind) ? { onStdout() {
        if (kind === 'stdout') { queueMicrotask(probe); throw Error('stdout observer'); }
        // The rejection reaction is the first observable boundary, not the
        // still-running callback's internal microtasks.
        setImmediate(probe); return Promise.reject(Error('async stdout observer'));
      } } : {}) });
    const r = await f.build({ onInvocation(h) {
      invoked = true; handle = h;
      if (kind === 'invocation') { queueMicrotask(probe); throw Error('invocation'); }
      if (kind === 'async-invocation') {
        const rejected = Promise.reject(Error('async invocation'));
        queueMicrotask(() => { rejected.catch(probe); }); return rejected;
      }
    } }).run();
    assert.equal(r.status, kind === 'start' ? 'unknown' : 'failed');
    assert.equal(invoked, kind !== 'start');
    if (kind !== 'start') { assert.equal(attempted, true); assert.equal(denied, true); }
    assert.equal(f.state().budget.acceptedNodes, 1);
    assert.equal(fs.readFileSync(join(f.dir, 'workspace/src/file'), 'utf8'), 'parent');
  }
});

test('repair: real reservation crosses root/child deadline, exact noChild token settles without charge/refund', async t => {
  for (const kind of ['root', 'child']) {
    const cleared = [];
    const f = fixture(t, { ...(kind === 'root' ? { phases: [{ type: 'agent', name: 'root', timeoutMs: 180 }] } : {}),
      drive: async (h, f) => {
        if (!f.state().nodes.find(n => n.nodeId === h.assignment.nodeId).parentNodeId) {
          const rows = await f.delegate(h, [child('expire-in-reserve', 2, { timeoutMs: 180 }), child('next')]);
          assert.deepEqual(rows.map(r => r.result.status), ['timeout', 'success']);
        }
        f.complete(h); f.release(h);
      } });
    const reserve = f.pj.reserve, noChild = f.pj.noChild;
    f.pj.reserve = () => {
      const token = reserve();
      const n = f.state().nodes.find(n => kind === 'root' ? !n.parentNodeId : n.label === 'expire-in-reserve');
      if (n && !n.result) {
        const end = n.effectiveDeadlineAt ?? n.authority.deadlineAt;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, end - Date.now() + 1));
      }
      return token;
    };
    f.pj.noChild = token => { noChild(token); cleared.push(token); };
    const r = await f.build().run();
    assert.equal(r.held, false); assert.equal(r.status, kind === 'root' ? 'failed' : 'success');
    assert.equal(cleared.length, 1); assert.equal(f.state().budget.spent, kind === 'root' ? 0 : 2);
    assert.equal(f.state().budget.acceptedNodes, kind === 'root' ? 1 : 3);
    const n = f.state().nodes.find(n => n.result.status === 'timeout');
    assert.equal(n.invocationId, null); assert.equal(n.result.disposition, 'never_launched'); assert.equal(n.closed, true);
    const processLog = JSON.parse(fs.readFileSync(join(f.dir, 'artifacts/workflow-processes.json')));
    assert.ok(processLog.groups.every(g => g.pid && g.token !== cleared[0]));
    assert.deepEqual(inspectDelegationJournal(f.j.directory, f.j.binding).state, f.state());
  }
});

test('repair: deadline text, failed noChild acknowledgement and launch-intent persistence remain held', async t => {
  for (const kind of ['reserve-text', 'noChild', 'intent-fsync']) {
    const f = fixture(t, { phases: [{ type: 'agent', name: 'root', timeoutMs: 180 }] });
    const reserve = f.pj.reserve;
    f.pj.reserve = () => {
      const token = reserve();
      if (kind === 'reserve-text') throw Error('DEADLINE_EXPIRED: not provenance');
      if (kind === 'noChild') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0,
        Math.max(1, f.state().nodes[0].effectiveDeadlineAt - Date.now() + 1));
      return token;
    };
    if (kind === 'noChild') f.pj.noChild = () => { throw Error('DEADLINE_EXPIRED: noChild persistence failed'); };
    const r = f.build();
    if (kind === 'intent-fsync') f.armFault(p => {
      if (p === 'after:event-fsync' && JSON.parse(fs.readFileSync(join(f.j.directory, 'events.jsonl'), 'utf8').trim().split('\n').at(-1)).type === 'launch_intent')
        throw Error('DEADLINE_EXPIRED: fsync acknowledgement ambiguous');
    });
    assert.equal((await r.run()).status, 'unknown');
    assert.equal(f.state().nodes[0].result, null); assert.equal(r.inspect().reservedLiveSlots, 3);
    assert.equal(inspectDelegationJournal(f.j.directory, f.j.binding).state.budget.spent, kind === 'intent-fsync' ? 1 : 0);
    assert.equal(JSON.parse(fs.readFileSync(join(f.dir, 'artifacts/workflow-processes.json'))).groups.length, 1);
  }
});

test('repair: native envelope denial is stable; noDeadline parent can execute next shell and complete', async t => {
  let checked = false;
  const f = fixture(t, { permissions: ['rwx'], drive: async (h, f) => {
    const command = '\u0001'.repeat(10800); let denial;
    try { h.shell('native-denial', command); } catch (e) { denial = e; }
    assert.match(denial.message, /command bound/);
    assert.throws(() => h.shell('native-denial', command), e => e === denial);
    assert.throws(() => h.shell('native-denial', 'printf wrong'), /REQUEST_CONFLICT/);
    assert.equal(h.readFile('src/file').toString(), 'parent');
    assert.equal((await h.shell('next', 'printf next')).stdout, 'next');
    assert.equal(f.state().commands.length, 2); checked = true; f.complete(h); f.release(h);
  } });
  assert.equal((await f.build().run()).status, 'success'); assert.equal(checked, true);
});

test('far-future finite absolute grant does not overflow Node timer into immediate expiry', async t => {
  const f = fixture(t, { deadlineAt: Number.MAX_SAFE_INTEGER });
  const policy = { supervised: true };
  const runtime = f.build({ deadlinePolicy: policy }); policy.defaultTimeoutMs = 1;
  assert.equal((await runtime.run()).status, 'success');
  assert.equal(f.state().nodes[0].effectiveDeadlineAt, Number.MAX_SAFE_INTEGER);
  assert.equal(f.state().nodes[0].result.status, 'success');
});

test('deadline timer rechecks its fixed absolute due time before timing out', async t => {
  const nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
  const wakeups = [];
  let capture = 'initial', clockMock, active;
  const activeNode = new Promise(resolve => { active = resolve; });
  const timerMock = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (capture === 'rearm' || capture === 'initial' && delay > 25000) {
      const timer = nativeSetTimeout(() => {}, 60000, ...args); timer.unref();
      wakeups.push({ callback, delay, timer }); capture = null; return timer;
    }
    return nativeSetTimeout(callback, delay, ...args);
  });
  const f = fixture(t, { phases: [{ type: 'agent', name: 'root', timeoutMs: 30000 }], drive() { active(); } });
  const runtime = f.build(), running = runtime.run();
  let finished = false;
  try {
    await activeNode;
    assert.equal(wakeups.length, 1);
    const deadline = f.state().nodes[0].effectiveDeadlineAt;
    assert.equal(runtime.inspect().nodes[0].deadlineAt, deadline);

    nativeClearTimeout(wakeups[0].timer); capture = 'rearm';
    clockMock = t.mock.method(Date, 'now', () => deadline - 1);
    wakeups[0].callback();
    clockMock.mock.restore(); clockMock = null;
    assert.equal(wakeups.length, 2); assert.equal(wakeups[1].delay, 1);
    assert.equal(f.state().nodes[0].stopped, undefined);
    assert.equal(f.state().nodes[0].effectiveDeadlineAt, deadline);
    assert.equal(runtime.inspect().nodes[0].deadlineAt, deadline);

    nativeClearTimeout(wakeups[1].timer);
    clockMock = t.mock.method(Date, 'now', () => deadline);
    wakeups[1].callback();
    clockMock.mock.restore(); clockMock = null;
    assert.equal(f.state().nodes[0].stopped, 'timeout');
    assert.equal(f.state().nodes[0].effectiveDeadlineAt, deadline);

    const result = await running; finished = true;
    assert.equal(result.status, 'failed'); assert.equal(result.held, false);
    const node = f.state().nodes[0];
    assert.equal(node.result.status, 'timeout'); assert.equal(node.joined, true); assert.equal(node.closed, true);
  } finally {
    clockMock?.mock.restore(); timerMock.mock.restore();
    wakeups.forEach(({ timer }) => nativeClearTimeout(timer));
    if (!finished) { runtime.cancel(); await running.catch(() => {}); }
  }
});

async function shellReady(file) {
  const until = Date.now() + 2000;
  while (!fs.existsSync(file) && Date.now() < until) await pause(5);
  assert.equal(fs.existsSync(file), true, 'actual shell payload must be running');
}
const activeShell = (h, f) => {
  const ready = join(f.dir, `shell-ready-${h.assignment.nodeId}`), mutation = ready + '.mutation';
  return { ready, mutation, pending: h.shell('active-shell', `printf ready > '${ready}'; sleep 0.7; printf forbidden > '${mutation}'`, 2500) };
};
function verifyClosed(f) {
  const s = f.state();
  assertBudgetInvariants(s.budget);
  assert.deepEqual(inspectDelegationJournal(f.j.directory, f.j.binding).state, s);
  assert.ok(s.nodes.every(n => n.joined && n.closed));
  assert.ok(s.commands.every(c => !c.slots.length && c.disposition === 'drained' && probeGroup(c.pid) === 'gone'));
  const log = fs.readFileSync(join(f.j.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const n of s.nodes) assert.equal(log.filter(e => e.type === 'node_joined' && e.payload.nodeId === n.nodeId).length, 1);
  assert.equal(log.filter(e => e.type === 'workflow_delegation_closed').length, 1);
}

for (const boundary of ['stdout', 'async-stdout', 'direct', 'nonzero', 'source', 'candidate'])
  test(`S2-R1 active shell: ${boundary} preserves worker cause/source, exact drain, no next phase`, async t => {
    let shell, handle, checked = false, source = '', workerWrites = [];
    const f = fixture(t, { permissions: ['rwx'], modes: { root: boundary === 'nonzero' ? 'tail-nonzero' : boundary === 'source' ? 'tail-source' : 'tail' },
      phases: [{ type: 'agent', name: 'root' }, { type: 'agent', name: 'later' }], budgets: [1, 1], depth: 0,
      onChildStart(p) {
        p.stdout.on('data', chunk => { source += chunk; });
        const write = p.stdio[3].write;
        p.stdio[3].write = function(v, ...args) { workerWrites.push(String(v)); return write.call(this, v, ...args); };
      },
      onStdout(chunk) {
        if (!chunk.includes('display-trigger')) return;
        const probe = () => assert.throws(() => handle.readFile('src/file'), /PARENT_NOT_ACTIVE|CANCELLED/);
        if (boundary === 'async-stdout') {
          const p = Promise.reject(Error('display failed'));
          queueMicrotask(() => p.catch(probe)); return p;
        }
        queueMicrotask(probe); throw Error('display failed');
      },
      async drive(h, f) {
        handle = h; shell = activeShell(h, f); await shellReady(shell.ready);
        const n = f.state().nodes[0];
        assert.throws(() => f.complete(h, 'success', 'mixed'), /PARENT_NOT_ACTIVE/);
        if (boundary === 'candidate') {
          // Trusted raw recording attack, not a new worker route: a candidate
          // cannot turn cancellation of a still-active supported command clean.
          f.j.submitCompletion(n.invocationId, 'raw-candidate', { status: 'success', summary: 'claim',
            acceptance: h.assignment.acceptance.map(a => ({ id: a.id, outcome: 'passed', evidenceIds: [] })),
            evidence: [], childReviews: [], remainingWork: [] });
        }
        if (['stdout', 'async-stdout', 'source'].includes(boundary)) fs.writeFileSync(f.gates.get(n.nodeId).gate + '.trigger', 'go');
        else f.release(h);
        const outcome = await shell.pending;
        assert.equal(outcome.classification, 'cancelled'); assert.equal(outcome.ok, false);
        assert.equal(fs.existsSync(shell.mutation), false);
        assert.throws(() => h.readFile('src/file'), /PARENT_NOT_ACTIVE|CANCELLED/); checked = true;
      } });
    const result = await f.build().run();
    assert.equal(result.status, 'failed'); assert.equal(result.held, false); assert.equal(checked, true);
    const s = f.state(), content = f.content(s.nodes[0]), worker = s.commands.find(c => c.kind === 'worker');
    assert.equal(content.cause, ({ stdout: 'CALLBACK_ERROR', 'async-stdout': 'CALLBACK_ERROR', direct: 'MISSING_COMPLETION', nonzero: 'NONZERO', source: 'SOURCE_PROTOCOL', candidate: 'CANCELLED' })[boundary]);
    assert.equal(worker.result.classification, ['stdout', 'async-stdout', 'source'].includes(boundary) ? 'callback_error' : boundary === 'nonzero' ? 'nonzero' : 'clean');
    assert.equal(worker.result.code, boundary === 'nonzero' ? 23 : 0);
    assert.equal(content.usage.totals.totalTokens, ['stdout', 'async-stdout', 'source'].includes(boundary) ? 14 : 7);
    assert.equal(content.usage.streamHash, createHash('sha256').update(source).digest('hex'));
    assert.equal(content.usage.streamBytes, Buffer.byteLength(source));
    assert.equal(content.usage.completeness, boundary === 'source' ? 'partial' : 'reported');
    assert.equal(s.nodes[0].stopped, undefined); assert.equal(f.starts.length, 1);
    assert.equal(workerWrites.filter(v => v.includes('revoke')).length, 0);
    assert.equal(f.events.filter(e => e.kind === 'restored').length, 0); verifyClosed(f);
    fs.writeFileSync(join(f.dir, 'active-shell-evidence.json'), JSON.stringify({ boundary, result, content, commands: s.commands, workerWrites }));

    if (boundary === 'direct') {
      // Pure composition negative matrix on this real drained snapshot. These
      // copies test classification only; they never enter a live coordinator.
      const view = inspectDelegationJournal(f.j.directory, f.j.binding);
      for (const [scheduled, stopped, workerClass, shellClass, expected] of [
        [true, 'cancelled', 'callback_error', 'cancelled', 'CANCELLED'],
        [true, 'timeout', 'callback_error', 'cancelled', 'TIMEOUT'],
        [true, null, 'cancelled', 'cancelled', 'CANCELLED'],
        [true, null, 'callback_error', 'timeout', 'TIMEOUT'],
        [true, null, 'clean', 'nonzero', 'NONZERO'],
        [true, null, 'nonzero', 'cancelled', 'NONZERO'],
        [false, null, 'callback_error', 'cancelled', 'CANCELLED'],
      ]) {
        const state = structuredClone(view.state), n = state.nodes[0];
        if (!scheduled) delete state.scheduler;
        if (stopped) n.stopped = stopped;
        const own = state.commands.filter(c => c.scopeId === content.settlement.scopeId);
        own[0].result.classification = workerClass; own[1].result.classification = shellClass;
        assert.equal(composeFinalResult(state, n, view.manifest, content.settlement.scopeId, content.usage, null).cause, expected);
      }
    }
  });

for (const boundary of ['invocation', 'async-invocation', 'user', 'deadline', 'shell-timeout', 'shell-nonzero'])
  test(`S2-R1 shell cancellation sibling: ${boundary}`, async t => {
    let checked = false, shell, handle;
    const f = fixture(t, { permissions: ['rwx'], modes: { root: 'tail' }, budgets: [1], depth: 0,
      ...(boundary === 'deadline' ? { phases: [{ type: 'agent', name: 'root', timeoutMs: 650 }] } : {}),
      async drive(h, f) {
        handle = h;
        if (boundary === 'shell-timeout' || boundary === 'shell-nonzero') {
          const outcome = await h.shell('own-failure', boundary === 'shell-timeout' ? 'sleep 1' : 'exit 19', 120);
          assert.equal(outcome.classification, boundary === 'shell-timeout' ? 'timeout' : 'nonzero');
          assert.equal(h.readFile('src/file').toString(), 'parent'); f.complete(h); f.release(h); checked = true; return;
        }
        shell = activeShell(h, f); await shellReady(shell.ready);
        if (boundary === 'user') f.runtime.cancel();
        else if (boundary.includes('invocation')) throw Error('invocation rejection');
        const r = await shell.pending; assert.equal(r.classification, 'cancelled'); checked = true;
      } });
    const overrides = boundary === 'invocation' ? { onInvocation(h) {
      handle = h;
      // Start an accepted shell on the actual invocation stack, then throw
      // synchronously: cooperative pre-dispatch cancellation, not revoke.
      shell = activeShell(h, f); throw Error('invocation throw');
    } } : {};
    const result = await f.build(overrides).run();
    if (boundary.includes('invocation')) { assert.equal((await shell.pending).classification, 'cancelled'); checked = true; }
    assert.equal(result.held, false); assert.equal(checked, true);
    const content = f.content(f.state().nodes[0]);
    assert.equal(content.cause, ({ invocation: 'SCHEDULER_FAILURE', 'async-invocation': 'SCHEDULER_FAILURE', user: 'CANCELLED', deadline: 'TIMEOUT', 'shell-timeout': 'TIMEOUT', 'shell-nonzero': 'NONZERO' })[boundary]);
    if (shell) { assert.equal(fs.existsSync(shell.mutation), false); assert.throws(() => handle.readFile('src/file'), /CANCELLED|DEADLINE_EXPIRED|PARENT_NOT_ACTIVE/); }
    verifyClosed(f);
  });

for (const boundary of ['callback', 'timeout', 'ancestor-exit']) test(`S2-R1 grandchild active shell ${boundary}; parents/queued healthy root keep correct scope`, async t => {
  let shell, checked = false;
  const f = fixture(t, { permissions: ['rwx', 'r'], modes: { leaf: 'tail' },
    phases: [{ type: 'fanout', name: 'roots', items: ['root', 'healthy'], concurrency: 2, failOnItemFailure: false }], budgets: [4],
    onStdout(chunk, n) { if (n.label === 'leaf' && chunk.includes('display-trigger')) throw Error('leaf display'); },
    async drive(h, f) {
      const n = f.state().nodes.find(n => n.nodeId === h.assignment.nodeId);
      if (n.label === 'root') {
        const rows = await f.delegate(h, [child('branch', 2, { permissions: 'rwx' })]);
        if (boundary === 'ancestor-exit') { assert.equal(rows[0].result.status, 'infrastructure_error'); checked = true; return; }
      } else if (n.label === 'branch') {
        const rows = await f.delegate(h, [child('leaf', 1, { permissions: 'rwx', ...(boundary === 'timeout' ? { timeoutMs: 650 } : {}) })]);
        if (boundary === 'ancestor-exit') return;
        assert.equal(rows[0].result.status, boundary === 'timeout' ? 'timeout' : 'infrastructure_error');
        assert.equal(h.readFile('src/file').toString(), 'parent');
      } else if (n.label === 'leaf') {
        shell = activeShell(h, f); await shellReady(shell.ready);
        // rwx is exclusive: unrelated root must be queued, not falsely run in parallel.
        assert.equal(f.starts.length, 3); assert.equal(f.runtime.inspect().waitingRoots, 1);
        if (boundary === 'callback') fs.writeFileSync(f.gates.get(n.nodeId).gate + '.trigger', 'go');
        if (boundary === 'ancestor-exit') f.release(f.handles.get(f.state().nodes[0].nodeId));
        assert.equal((await shell.pending).classification, 'cancelled');
        assert.equal(fs.existsSync(shell.mutation), false); checked = true; return;
      } else {
        assert.equal(n.label, 'healthy'); assert.equal(probeGroup(f.state().nodes[0].pid), 'gone');
      }
      f.complete(h); f.release(h);
    } });
  assert.equal((await f.build().run()).status, 'success'); assert.equal(checked, true);
  const s = f.state(), leaf = s.nodes.find(n => n.label === 'leaf');
  assert.equal(f.content(leaf).cause, boundary === 'callback' ? 'CALLBACK_ERROR' : boundary === 'timeout' ? 'TIMEOUT' : 'SCHEDULER_FAILURE');
  assert.equal(s.nodes.find(n => n.label === 'healthy').result.status, 'success');
  assert.equal(s.budget.spent, 4); assert.equal(s.budget.acceptedNodes, 4); verifyClosed(f);
});

for (const boundary of ['preflight', 'start', 'loss-before', 'loss-during']) test(`S2-R1 reentrant ${boundary}: no restoration/dispatch on veto or loss`, async t => {
  let stream, channel, failNow = false, checked = false, shell, writes = [];
  const f = fixture(t, { permissions: ['rwx'], modes: { root: 'tail' },
    onChildStart(p) {
      stream = p.stdout; channel = p.stdio[3];
      const write = channel.write;
      channel.write = function(v, ...args) { writes.push(String(v)); return write.call(this, v, ...args); };
    },
    onStdout() { if (failNow) throw Error('reentrant observer'); },
    async drive(h, f) {
      if (boundary === 'preflight') {
        const size = Buffer.byteLength; let fired = false;
        Buffer.byteLength = function(v, ...args) {
          const n = size(v, ...args);
          if (!fired && typeof v === 'string' && v.startsWith('{"type":"dispatch"')) {
            fired = true; failNow = true; stream.emit('data', '');
          }
          return n;
        };
        try { assert.throws(() => h.shell('preflight', 'printf forbidden'), /PARENT_NOT_ACTIVE/); }
        finally { Buffer.byteLength = size; }
        assert.equal(f.state().commands.length, 1);
      } else if (boundary === 'start') {
        const started = f.pj.started;
        f.pj.started = (token, pid) => { started(token, pid); failNow = true; stream.emit('data', ''); };
        shell = activeShell(h, f);
        assert.equal((await shell.pending).classification, 'cancelled');
        assert.equal(fs.existsSync(shell.ready), false, 'cancel before native dispatch');
      } else {
        let cut = false;
        if (boundary === 'loss-during') {
          const spawn = childProcess.spawn;
          const mock = t.mock.method(childProcess, 'spawn', (...args) => {
            const p = spawn(...args), write = p.stdio[3].write;
            p.stdio[3].write = function(v, ...rest) {
              if (!cut && String(v).includes('"term"')) {
                cut = true; channel.emit('error', Error('loss during live shell cancellation')); return false;
              }
              return write.call(this, v, ...rest);
            };
            return p;
          });
          syncBuiltinESMExports();
          try { shell = activeShell(h, f); }
          finally { mock.mock.restore(); syncBuiltinESMExports(); }
        } else shell = activeShell(h, f);
        await shellReady(shell.ready);
        if (boundary === 'loss-before') {
          channel.emit('error', Error('actual owned loss')); failNow = true; stream.emit('data', '');
          f.runtime.cancel(); assert.equal(writes.filter(v => /term|revoke/.test(v)).length, 0);
        } else {
          failNow = true; stream.emit('data', '');
          assert.equal(cut, true); // Real control loss, no forged drained event.
          assert.equal(writes.filter(v => /term|revoke/.test(v)).length, 0);
        }
        await assert.rejects(shell.pending, /OWNERSHIP_UNKNOWN/);
      }
      assert.throws(() => h.readFile('src/file'), /PARENT_NOT_ACTIVE|CANCELLED|OWNERSHIP_UNKNOWN/); checked = true;
    } });
  const result = await f.build().run();
  // Held diagnostics can precede the outstanding command's nonauthorizing result.
  if (shell) await shell.pending.catch(() => {});
  await pause(0); assert.equal(checked, true);
  assert.equal(result.held, boundary.startsWith('loss'));
  if (result.held) {
    assert.equal(f.state().nodes[0].joined, false); assert.equal(f.runtime.inspect().reservedLiveSlots, 3);
    assert.equal(f.state().nodes[0].result, null); assert.equal(f.events.filter(e => e.kind === 'restored').length, 0);
    assert.ok(f.state().commands.some(c => c.slots.length)); assert.equal(f.state().budget.freeWorkflow, 0);
  } else { assert.equal(f.content(f.state().nodes[0]).cause, 'CALLBACK_ERROR'); verifyClosed(f); }
});

for (const cause of ['user', 'deadline']) test(`S2-R1 ${cause} observed with callback retains genuine stop precedence`, async t => {
  let handle, checked = false, shell;
  const f = fixture(t, { permissions: ['rwx'], modes: { root: 'tail' },
    ...(cause === 'deadline' ? { phases: [{ type: 'agent', name: 'root', timeoutMs: 650 }] } : {}),
    onStdout(chunk) {
      if (!chunk.includes('display-trigger')) return;
      if (cause === 'user') queueMicrotask(() => f.runtime.cancel()); // after callback's own veto
      else {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, handle.assignment.authority.deadlineAt - Date.now()));
        assert.throws(() => handle.readFile('src/file'), /DEADLINE_EXPIRED/);
      }
      throw Error('display');
    },
    async drive(h, f) {
      handle = h; shell = activeShell(h, f); await shellReady(shell.ready);
      fs.writeFileSync(f.gates.get(h.assignment.nodeId).gate + '.trigger', 'go');
      assert.equal((await shell.pending).classification, 'cancelled'); checked = true;
    } });
  const result = await f.build().run(); assert.equal(result.held, false); assert.equal(checked, true);
  assert.equal(f.content(f.state().nodes[0]).cause, cause === 'user' ? 'CANCELLED' : 'TIMEOUT');
  assert.equal(fs.existsSync(shell.mutation), false); verifyClosed(f);
});

test('callback lifetime: never-settling start cannot release original lane/credits or queued root at expiry', async t => {
  let reject;
  const deferred = new Promise((_, r) => { reject = r; });
  const f = fixture(t, { phases: [{ type: 'fanout', name: 'roots', items: ['first', 'later'], concurrency: 2, failOnItemFailure: false }],
    permissions: ['rw', 'rw'], budgets: [2], onChildStart() { return deferred; } });
  const before = Date.now(), result = await f.build().run();
  assert.equal(result.held, true); assert.equal(f.starts.length, 1); assert.ok(Date.now() - before < 2500);
  assert.equal(f.runtime.inspect().reservedLiveSlots, 3); assert.equal(f.state().budget.freeWorkflow, 0);
  assert.equal(f.state().nodes[0].result, null); assert.equal(f.state().commands[0].result.classification, 'clean');
  const snapshot = f.j.snapshot(); reject(Error('after bounded unknown')); await pause(0);
  assert.deepEqual(f.j.snapshot(), snapshot); assert.equal(f.starts.length, 1);
});

for (const boundary of ['reject', 'never', 'cancel', 'deadline', 'loss'])
  test(`callback lifetime: invocation ${boundary} after physical acknowledgement, before node finalization`, async t => {
    const abort = new AbortController(); let reject;
    const deferred = new Promise((_, r) => { reject = r; });
    const f = fixture(t, { signal: abort.signal,
      ...(boundary === 'deadline' ? { phases: [{ type: 'agent', name: 'root', timeoutMs: 500 }] } : {}) });
    const runtime = f.build({ async onInvocation(h) {
      await f.gates.get(h.assignment.nodeId).promise;
      f.complete(h); f.release(h);
      if (boundary !== 'never' && boundary !== 'deadline') {
        const until = Date.now() + 2000;
        while (!f.state().commands[0].result && Date.now() < until) await pause(5);
        assert.equal(f.state().commands[0].result.classification, 'clean');
        assert.equal(f.state().nodes[0].result, null);
        if (boundary === 'loss') f.j.dispose();
        else if (boundary === 'cancel') abort.abort('actual user cancellation');
        else reject(Error('invocation rejection while scope still open'));
      }
      return deferred;
    } });
    const before = Date.now(), result = await runtime.run();
    assert.ok(Date.now() - before < 3000); assert.equal(result.held, boundary === 'loss');
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    if (boundary === 'loss') { assert.equal(f.state().nodes[0].result, null); assert.equal(runtime.inspect().reservedLiveSlots, 3); }
    else assert.equal(f.content(f.state().nodes[0]).cause, boundary === 'cancel' ? 'CANCELLED' : boundary === 'deadline' ? 'TIMEOUT' : 'SCHEDULER_FAILURE');
    const snapshot = f.j.snapshot(); reject(Error('post-seal')); await pause(0); assert.deepEqual(f.j.snapshot(), snapshot);
  });

for (const boundary of ['phase', 'joined']) test(`callback lifetime: ${boundary} event cannot await forever or release queued roots on observed failure`, async t => {
  let reject, seen = false;
  const deferred = new Promise((_, r) => { reject = r; });
  const f = fixture(t, { phases: [{ type: 'fanout', name: 'roots', items: ['first', 'later'], concurrency: 2, failOnItemFailure: false }], permissions: ['rw', 'rw'] });
  const runtime = f.build({ onEvent(e) {
    if (!seen && e.kind === boundary) {
      seen = true;
      if (boundary === 'joined') setTimeout(() => {
        assert.equal(f.starts.length, 1); assert.equal(f.state().nodes[1].invocationId, null);
        reject(Error('observed join notification failure'));
      }, 20);
      return deferred;
    }
  } });
  const result = await runtime.run(); assert.equal(result.held, false); assert.equal(result.status, 'failed'); assert.equal(seen, true);
  assert.equal(f.starts.length, boundary === 'phase' ? 0 : 1);
  const snapshot = f.j.snapshot(); reject(Error('after workflow observer seal')); await pause(0);
  assert.deepEqual(f.j.snapshot(), snapshot); assert.ok(f.state().nodes.every(n => n.joined));
});

for (const transition of ['cancel', 'park', 'complete', 'callback']) for (const operation of ['read', 'write', 'edit'])
  test(`CL2 original active node ${operation} denies reentrant ${transition} during preparation`, async t => {
    let stream, failNow = false, checked = false;
    const f = fixture(t, { permissions: ['rw'], onChildStart(p) { stream ??= p.stdout; },
      onStdout() { if (failNow) throw Error('observed callback failure'); },
      async drive(h, f) {
        if (f.state().nodes.find(n => n.nodeId === h.assignment.nodeId).parentNodeId) { f.complete(h); f.release(h); return; }
        const original = fs.realpathSync; let fired = false, batch;
        fs.realpathSync = function(path, ...args) {
          const value = original.call(this, path, ...args);
          if (!fired && path === join(f.dir, 'workspace')) {
            fired = true;
            if (transition === 'cancel') f.runtime.cancel();
            else if (transition === 'park') batch = f.delegate(h, [child('lent')]);
            else if (transition === 'complete') f.complete(h);
            else { failNow = true; stream.emit('data', ''); }
          }
          return value;
        };
        try { assert.throws(() => operation === 'read' ? h.readFile('src/file') : operation === 'write' ? h.writeFile('src/file', 'changed') : h.editFile('src/file', 'parent', 'changed'), /CANCELLED|PARENT_NOT_ACTIVE/); }
        finally { fs.realpathSync = original; }
        assert.equal(fired, true); assert.equal(f.runtime.inspect().held, false);
        assert.equal(fs.readFileSync(join(f.dir, 'workspace/src/file'), 'utf8'), 'parent');
        assert.deepEqual(fs.readdirSync(join(f.dir, 'workspace/src')).sort(), ['file', 'narrow']); checked = true;
        if (batch) { await batch; h.writeFile('src/file', 'restored'); f.complete(h); }
        f.release(h);
      } });
    const outcome = await f.build().run(); assert.equal(checked, true); assert.equal(outcome.held, false);
    assert.equal(outcome.status, transition === 'cancel' ? 'cancelled' : transition === 'callback' ? 'failed' : 'success');
  });

test('CL2 mutation entry holds even for validation-shaped errors; guards consume no extra admissions', async t => {
  let checked = false;
  const f = fixture(t, { permissions: ['rw'], drive(h, f) {
    for (let i = 0; i < 120; i++) assert.equal(h.readFile('src/file').toString(), 'parent');
    const original = fs.writeSync;
    const mock = t.mock.method(fs, 'writeSync', (fd, ...args) => {
      const value = original(fd, ...args);
      throw Error('RESULT_INVALID: after actual temporary write');
    });
    try { assert.throws(() => h.editFile('src/file', 'parent', 'changed'), /RESULT_INVALID/); }
    finally { mock.mock.restore(); }
    assert.equal(f.runtime.inspect().held, true); assert.equal(fs.readFileSync(join(f.dir, 'workspace/src/file'), 'utf8'), 'parent');
    assert.throws(() => h.readFile('src/file'), /OWNERSHIP_UNKNOWN/); checked = true;
  } });
  assert.equal((await f.build().run()).held, true); assert.equal(checked, true);
});

test('S2-R1 delayed async worker start rejection cancels active shell but start_error remains unknown', async t => {
  let rejectStart, shell, triggered = false;
  const f = fixture(t, { permissions: ['rwx'], modes: { root: 'tail' },
    onChildStart() { return new Promise((_, reject) => { rejectStart = reject; }); },
    async drive(h, f) {
      shell = activeShell(h, f); await shellReady(shell.ready);
      rejectStart(Error('observed delayed start failure')); triggered = true;
      await shell.pending.catch(() => {});
    } });
  const result = await f.build().run(); assert.equal(result.status, 'unknown'); assert.equal(triggered, true);
  const shellResult = await shell.pending.catch(error => ({ error: error.message }));
  assert.notEqual(shellResult.ok, true); assert.equal(fs.existsSync(shell.mutation), false);
  const until = Date.now() + 2000;
  let command;
  do {
    command = f.runtime.inspect().executor.scopes[0].commands[0];
    if (command.classification) break;
    await pause(5);
  } while (Date.now() < until);
  assert.equal(command.classification, 'start_error'); assert.equal(command.disposition, 'unknown');
  assert.equal(f.state().nodes[0].result, null); assert.equal(f.state().nodes[0].joined, false);
  assert.equal(f.runtime.inspect().reservedLiveSlots, 3); assert.equal(f.state().budget.freeWorkflow, 0);
});
