import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { claimDelegationScheduler, createDelegationJournal, inspectDelegationJournal, readDelegationArtifactPage } from '../lib/delegation-journal.mjs';
import { canonicalJSON, sha256, readStoredArtifact } from '../lib/delegation-storage.mjs';
import { checkCapacity, initialState, reservedBytes, reduceEvent } from '../lib/delegation-journal-model.mjs';
import { createProcessJournal } from '../lib/process-journal.mjs';
import { exclusiveUsageObserver } from '../worker/exclusive-usage.mjs';
import { LIMITS } from '../lib/delegation-contract.mjs';

function options(t, patch = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'delegation-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['workspace', 'workspace/src', 'profile', 'artifacts']) fs.mkdirSync(join(root, dir), { mode: 0o700 });
  const scope = { read: ['src'], write: [] };
  return { artifactDirectory: join(root, 'artifacts'), workspace: join(root, 'workspace'), protectedDirectories: [join(root, 'profile')],
    runId: 'fixture-run', specDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
    policy: { maxDepth: 2, totalAgentBudget: 8, directoryScope: scope, context: { objective: 'Review', constraints: ['Read only'] } },
    roots: [{ phaseIndex: 0, agentBudget: 8, label: 'root', task: 'Review src', permissions: 'r', directoryScope: scope, deadlineAt: null }], ...patch };
}
function fixture(t, patch = {}) {
  const opts = options(t, patch); const j = createDelegationJournal(opts); t.after(() => j.dispose());
  return { opts, j, rootId: j.snapshot().state.nodes[0].nodeId };
}
function launched(f, pid = process.pid) {
  // Storage-order fixture only: records an actual local PID, not a worker/clean-exit
  // attestation. Every launched join remains denied regardless of this metadata.
  const pj = createProcessJournal(f.opts.artifactDirectory, f.opts.runId);
  const token = pj.reserve(); const { invocationId } = f.j.launchIntent(f.rootId, token);
  pj.started(token, pid); f.j.workerStarted(invocationId, pid);
  return { pj, token, invocationId };
}
const failure = (status = 'cancelled') => ({ status, summary: 'not executed', cause: 'CANCELLED', usageCompleteness: 'missing' });
const request = j => ({ directoryRevision: j.snapshot().state.sequence, children: [{ label: 'child', task: 'Review one part',
  acceptance: [{ id: 'a', criterion: 'Cite evidence' }], agentBudget: 2, permissions: 'r', directoryScope: { read: ['src'], write: [] } }] });
const complete = () => ({ status: 'success', summary: 'Agent claim, not execution proof', acceptance: [{ id: 'assignment', outcome: 'passed', evidenceIds: ['local:report'] }],
  evidence: [{ label: 'report', path: 'src/report', description: 'file evidence' }], childReviews: [], remainingWork: [] });
const inspect = j => inspectDelegationJournal(j.directory, j.binding);
function bindingFromFixtureDisk(opts) {
  const bytes = fs.readFileSync(join(opts.artifactDirectory, 'delegation/manifest.json'));
  return { manifestDigest: sha256(bytes), runId: opts.runId, specDigest: opts.specDigest, profileDigest: opts.profileDigest };
}

test('exclusive create, generated immutable bindings, exact roots and inspection cannot reopen/reclaim', t => {
  const { j, opts } = fixture(t);
  const seen = inspect(j);
  assert.equal(seen.inspectionOnly, true); assert.equal(seen.resumable, false); assert.equal(seen.launchAuthorized, false);
  assert.equal(seen.state.budget.acceptedNodes, 1); assert.equal(seen.state.budget.spent, 0);
  assert.equal(Object.hasOwn(seen.state, 'materializations'), false); // old immediate-root state shape remains unchanged
  assert.equal(seen.reservedBytes, 4 * 4096); assert.equal(seen.projection, 'current');
  assert.equal(seen.manifest.policyDigest, sha256(canonicalJSON(opts.policy)));
  assert.match(seen.manifest.ownerEpoch, /^[0-9a-f-]{36}$/);
  opts.policy.totalAgentBudget = 1; assert.equal(inspect(j).manifest.policy.totalAgentBudget, 8);
  assert.throws(() => { seen.state.budget.freeWorkflow = 999; }, TypeError);
  assert.equal(j.snapshot().state.budget.freeWorkflow, 0);
  j.dispose(); assert.throws(() => j.closeWorkflow(), /writer unavailable/);
  assert.throws(() => createDelegationJournal({ ...opts, policy: inspect(j).manifest.policy }), /EEXIST/);
  assert.equal(inspect(j).unresolved[0].classification, 'reserved_without_intent');
  assert.equal(fs.statSync(join(j.directory, 'manifest.json')).mode & 0o777, 0o400);
});

test('strict options reject caller node/root/epoch/capability metadata before allocation', t => {
  for (const patch of [{ ownerEpoch: randomUUID() }, { capability: 'secret' }, { budgetScopeId: randomUUID() }, { resume: true }]) {
    const opts = options(t); assert.throws(() => createDelegationJournal({ ...opts, ...patch }), /INVALID_REQUEST/);
    assert.equal(fs.existsSync(join(opts.artifactDirectory, 'delegation')), false);
  }
  const opts = options(t); opts.roots[0].nodeId = 'forged'; assert.throws(() => createDelegationJournal(opts), /INVALID_REQUEST/);
});

test('deferred phase materializes one complete immutable assignment artifact through original scheduler authority', t => {
  const opts = options(t);
  opts.policy.totalAgentBudget = 2;
  const { task: _task, ...root } = opts.roots[0];
  opts.roots = ['duplicate', 'duplicate'].map((label, itemIndex) => ({ ...root, phaseIndex: 2, itemIndex,
    agentBudget: 1, label, taskTemplate: `Review {{item}} at {{index}}`, contextTemplate: 'Use prior verified output' }));
  const j = createDelegationJournal(opts); t.after(() => j.dispose());
  const before = j.snapshot(), roots = before.state.nodes;
  assert.ok(roots.every(n => n.assignment === undefined && n.taskTemplate));
  const pj = createProcessJournal(opts.artifactDirectory, opts.runId), token = pj.reserve();
  assert.throws(() => j.launchIntent(roots[0].nodeId, token), /deferred root assignment unresolved/);
  assert.equal(j.snapshot().poisoned, false); assert.equal(j.snapshot().state.sequence, before.state.sequence);
  const scheduler = claimDelegationScheduler(j, { maxConcurrentAgents: 2, maxLiveAgents: 6, rootTimeouts: [null, null] });
  const afterConfiguration = j.snapshot();
  const assignments = roots.map((n, itemIndex) => ({ nodeId: n.nodeId, task: `Rendered duplicate item ${itemIndex}`,
    parentContextSummary: `context ${itemIndex}` }));
  assert.throws(() => ({ ...scheduler }).materializePhase(2, assignments), /original scheduler capability/);
  const foreignOpts = options(t); const { task: _foreignTask, ...foreignRoot } = foreignOpts.roots[0];
  foreignOpts.roots[0] = { ...foreignRoot, taskTemplate: 'foreign deferred' };
  const foreign = createDelegationJournal(foreignOpts); t.after(() => foreign.dispose());
  const foreignScheduler = claimDelegationScheduler(foreign, { maxConcurrentAgents: 1, maxLiveAgents: 3, rootTimeouts: [null] });
  const foreignBefore = foreign.snapshot();
  assert.throws(() => foreignScheduler.materializePhase(2, assignments), /complete deferred phase/);
  assert.deepEqual(foreign.snapshot(), foreignBefore);
  const targetArtifactsBefore = fs.readdirSync(join(j.directory, 'nodes')).sort();
  const targetEventsBefore = fs.readFileSync(join(j.directory, 'events.jsonl'));
  const assertTargetUnchanged = () => {
    assert.deepEqual(j.snapshot(), afterConfiguration);
    assert.deepEqual(fs.readdirSync(join(j.directory, 'nodes')).sort(), targetArtifactsBefore);
    assert.deepEqual(fs.readFileSync(join(j.directory, 'events.jsonl')), targetEventsBefore);
  };
  assert.throws(() => scheduler.materializePhase.call(foreignScheduler, 2, assignments), /UNAUTHORIZED/);
  assertTargetUnchanged(); assert.deepEqual(foreign.snapshot(), foreignBefore);
  foreign.dispose();
  assert.throws(() => scheduler.materializePhase.call(foreignScheduler, 2, assignments), /UNAUTHORIZED/);
  assertTargetUnchanged(); assert.deepEqual(foreign.snapshot(), foreignBefore);
  assert.throws(() => scheduler.materializePhase(2, assignments.slice(0, 1)), /complete deferred phase/);
  assert.throws(() => scheduler.materializePhase(2, assignments.map((a, i) => ({ ...a, task: i ? 'x'.repeat(4097) : a.task }))), /text/);
  assert.deepEqual(j.snapshot(), afterConfiguration); // validation failures issue no assignment artifact/event
  const reference = scheduler.materializePhase(2, assignments);
  const content = JSON.parse(readStoredArtifact(j.directory, reference));
  assert.equal(content.schema, 'pi-workflow-delegation-root-assignments/v1');
  assert.deepEqual(content.roots.map(r => r.itemIndex), [0, 1]);
  assert.deepEqual(content.roots.map(r => r.assignment.task), assignments.map(a => a.task));
  content.roots.forEach(r => assert.match(r.assignment.acceptance[0].criterion, new RegExp(r.taskHash)));
  const state = j.snapshot().state;
  assert.equal(state.materializations.length, 1); assert.deepEqual(state.nodes.map(n => n.assignment.task), assignments.map(a => a.task));
  assert.equal(state.budget.acceptedNodes, 2); assert.equal(state.budget.spent, 0); assert.equal(state.budget.freeWorkflow, 0);
  assert.throws(() => scheduler.materializePhase(2, assignments), /phase cannot materialize/);
  assert.deepEqual(inspectDelegationJournal(j.directory, j.binding).state, state);
  const events = fs.readFileSync(join(j.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.type === 'root_assignments_materialized').length, 1);
  assert.ok(events.find(e => e.type === 'root_assignments_materialized').payload.assignments.artifactId);
  const blob = join(j.directory, 'nodes', `${reference.artifactId.slice(9)}.blob`);
  fs.chmodSync(blob, 0o600); fs.writeFileSync(blob, 'corrupt');
  assert.throws(() => inspectDelegationJournal(j.directory, j.binding), /integrity|canonical|JSON/);
});

test('materialization append ambiguity poisons writer; inspection verifies durable artifact without granting replay', t => {
  let armed = false;
  const opts = options(t, { fault(point) { if (armed && point === 'after:event-fsync') throw Error('materialization acknowledgement lost'); } });
  const { task: _task, ...root } = opts.roots[0];
  opts.roots[0] = { ...root, taskTemplate: 'Deferred {{outputs.prior}}' };
  const j = createDelegationJournal(opts); t.after(() => j.dispose());
  const scheduler = claimDelegationScheduler(j, { maxConcurrentAgents: 1, maxLiveAgents: 3, rootTimeouts: [null] });
  const nodeId = j.snapshot().state.nodes[0].nodeId; armed = true;
  assert.throws(() => scheduler.materializePhase(0, [{ nodeId, task: 'rendered' }]), /acknowledgement lost/);
  armed = false; assert.equal(j.snapshot().poisoned, true);
  const view = inspectDelegationJournal(j.directory, j.binding);
  assert.equal(view.launchAuthorized, false); assert.equal(view.state.materializations.length, 1);
  assert.equal(view.state.nodes[0].assignment.task, 'rendered');
  assert.throws(() => scheduler.activateRoot(nodeId), /writer unavailable/);
});

test('128 roots fit one compact root-plan reference and reserve admission at once', t => {
  const opts = options(t);
  opts.policy.maxDepth = 0; opts.policy.totalAgentBudget = 128;
  opts.roots = Array.from({ length: 128 }, (_, phaseIndex) => ({ ...opts.roots[0], phaseIndex, agentBudget: 1 }));
  const j = createDelegationJournal(opts); t.after(() => j.dispose());
  assert.equal(inspect(j).state.budget.acceptedNodes, 128);
  assert.ok(fs.statSync(join(j.directory, 'events.jsonl')).size < 4096);
  const invalid = options(t); invalid.roots.push({ ...invalid.roots[0], phaseIndex: 1 });
  assert.throws(() => createDelegationJournal(invalid), /BUDGET/);
  assert.equal(fs.existsSync(join(invalid.artifactDirectory, 'delegation')), false);
});

test('launch charge follows durable process reservation and precedes start; inspection does not dispatch', t => {
  const f = fixture(t); const pj = createProcessJournal(f.opts.artifactDirectory, f.opts.runId);
  const token = pj.reserve(); const receipt = f.j.launchIntent(f.rootId, token), { invocationId } = receipt;
  assert.equal(receipt.recordedNow, true);
  assert.equal(f.j.snapshot().state.budget.spent, 1);
  assert.deepEqual(f.j.launchIntent(f.rootId, token), { invocationId, recordedNow: false });
  assert.throws(() => f.j.launchIntent(f.rootId, randomUUID()), /REQUEST_CONFLICT/);
  const restored = inspect(f.j); assert.equal(restored.unresolved[0].classification, 'intent_without_start');
  assert.equal(restored.state.budget.spent, 1); assert.equal(restored.state.budget.nodes[0].available, 7);
  assert.throws(() => f.j.workerStarted(invocationId, process.pid), /OWNERSHIP_UNKNOWN/);
  assert.equal(f.j.snapshot().poisoned, true); // PID write failed ordering, no second start
});

test('local process identity fixture: process-journal PID binding is verified, never treated as clean settlement', async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { detached: true, stdio: 'ignore', env: process.env });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } });
  const { invocationId } = launched(f, child.pid);
  assert.equal(inspect(f.j).state.nodes[0].pid, child.pid);
  assert.equal(inspect(f.j).unresolved[0].classification, 'started_without_result');
  const exited = once(child, 'exit'); process.kill(-child.pid, 'SIGTERM'); await exited;
  assert.throws(() => f.j.recordFailure(f.rootId, failure('success')), /UNSUPPORTED_MODE/);
  f.j.recordFailure(f.rootId, failure());
  assert.throws(() => f.j.joinUnlaunched(f.rootId), /OWNERSHIP_UNKNOWN/);
  assert.equal(f.j.snapshot().state.budget.spent, 1);
  assert.equal(f.j.snapshot().state.nodes[0].invocationId, invocationId);
});

test('entire batch atomic, idempotent identity+digest, conflicts denied without duplicate reservation', t => {
  const f = fixture(t); const { invocationId } = launched(f);
  const req = request(f.j); req.children.push({ ...req.children[0], label: 'sibling' });
  const batch = f.j.acceptDelegation(invocationId, 'call:1', req);
  assert.equal(batch.children.length, 2); assert.equal(f.j.snapshot().state.budget.acceptedNodes, 3);
  assert.deepEqual(f.j.acceptDelegation(invocationId, 'call:1', req), batch);
  const altered = structuredClone(req); altered.children[0].task = 'different';
  assert.throws(() => f.j.acceptDelegation(invocationId, 'call:1', altered), /REQUEST_CONFLICT/);
  assert.equal(f.j.snapshot().state.budget.acceptedNodes, 3);
  assert.equal(inspect(f.j).state.requestCount, 3);
  assert.throws(() => f.j.acceptDelegation(invocationId, 'parallel', request(f.j)), /PARENT_NOT_ACTIVE/);
  const before = f.j.snapshot().state.budget;
  assert.deepEqual(inspect(f.j).state.budget, before);
});

test('invalid/oversubscribed/stale grants leave no child artifacts or credit changes; denial replays bounded', t => {
  const f = fixture(t); const { invocationId } = launched(f);
  const baseline = fs.readdirSync(join(f.j.directory, 'nodes')).length;
  for (const [key, mutate, error] of [
    ['budget', r => { r.children[0].agentBudget = 8; }, /BUDGET/],
    ['stale', r => { r.directoryRevision = 0; }, /STALE/],
    ['scope', r => { r.children[0].directoryScope.read = ['.']; }, /SCOPE/],
    ['forged', r => { r.capability = 'never-log-this-secret'; }, /INVALID/],
  ]) {
    const req = request(f.j); mutate(req);
    assert.throws(() => f.j.acceptDelegation(invocationId, key, req), error);
    assert.equal(typeof f.j.acceptDelegation(invocationId, key, req).kind, 'string');
  }
  assert.equal(fs.readdirSync(join(f.j.directory, 'nodes')).length, baseline);
  assert.equal(f.j.snapshot().state.budget.acceptedNodes, 1);
  assert.doesNotMatch(fs.readFileSync(join(f.j.directory, 'events.jsonl'), 'utf8'), /never-log-this-secret|capability/);
});

test('unlaunched result -> join -> batch join returns credit once, pins immutable acceptance-order index versions', t => {
  const f = fixture(t); const { invocationId } = launched(f);
  const req = request(f.j); req.children.push({ ...req.children[0], label: 'second' });
  const beforeIndex = f.j.snapshot().state.nodes[0].index;
  const batch = f.j.acceptDelegation(invocationId, 'call', req);
  assert.throws(() => f.j.joinBatch(batch.batchId), /INVALID/);
  for (const childId of [...batch.children].reverse()) {
    const ref = f.j.recordFailure(childId, failure());
    assert.deepEqual(f.j.recordFailure(childId, failure()), ref);
    assert.throws(() => f.j.recordFailure(childId, { ...failure(), cause: 'OTHER' }), /REQUEST_CONFLICT/);
    f.j.joinUnlaunched(childId); const spent = f.j.snapshot().state.budget;
    f.j.joinUnlaunched(childId); assert.deepEqual(f.j.snapshot().state.budget, spent);
    f.j.closeNode(childId); f.j.closeNode(childId);
  }
  f.j.joinBatch(batch.batchId); const budget = f.j.snapshot().state.budget;
  f.j.joinBatch(batch.batchId); assert.deepEqual(f.j.snapshot().state.budget, budget);
  assert.equal(budget.spent, 1); assert.equal(budget.nodes[0].available, 7);
  const afterIndex = f.j.snapshot().state.nodes[0].index;
  assert.notEqual(beforeIndex.artifactId, afterIndex.artifactId);
  assert.equal(JSON.parse(readStoredArtifact(f.j.directory, beforeIndex)).children.length, 0);
  const entries = JSON.parse(readStoredArtifact(f.j.directory, afterIndex)).children;
  assert.deepEqual(entries.map(e => e.childNodeId), batch.children);
  assert.equal(inspect(f.j).state.batches[0].joined, true);
});

test('candidate snapshots durable files before references, not success; pages verify hash and visibility', t => {
  const f = fixture(t); const { invocationId } = launched(f);
  fs.writeFileSync(join(f.opts.workspace, 'src/report'), 'café 😀 evidence');
  const ref = f.j.submitCompletion(invocationId, 'complete', complete());
  assert.deepEqual(f.j.submitCompletion(invocationId, 'complete', complete()), ref);
  const candidate = JSON.parse(readStoredArtifact(f.j.directory, ref));
  assert.equal(candidate.schema, 'pi-workflow-delegation-candidate/v1');
  fs.writeFileSync(join(f.opts.workspace, 'src/report'), 'changed workspace');
  const evidence = candidate.evidence[0].reference;
  assert.equal(readStoredArtifact(f.j.directory, evidence).toString(), 'café 😀 evidence');
  const request = { view: 'artifact', artifactId: evidence.artifactId, offsetBytes: 3, limitBytes: 2 };
  assert.throws(() => readDelegationArtifactPage(f.j.directory, evidence, request, []), /PERMISSION/);
  const page = readDelegationArtifactPage(f.j.directory, evidence, request, [evidence.artifactId]);
  assert.deepEqual(Buffer.from(page.data, 'base64'), Buffer.from('café 😀 evidence').subarray(3, 5));
  assert.throws(() => f.j.acceptDelegation(invocationId, 'after-complete', request), /INVALID/);
  assert.equal(inspect(f.j).state.nodes[0].result, null);
  f.j.recordFailure(f.rootId, { ...failure('failed'), cause: 'SDK_COMPACTION_DIAGNOSTIC', summary: 'summary usage retained; execution failed' });
  assert.throws(() => f.j.joinUnlaunched(f.rootId), /OWNERSHIP_UNKNOWN/);
});

test('candidate rejects stale reviews and unsafe evidence before publication', t => {
  const f = fixture(t); const { invocationId } = launched(f);
  const req = complete(); const before = fs.readdirSync(join(f.j.directory, 'nodes')).length;
  req.childReviews = [{ childNodeId: 'forged', resultHash: 'a'.repeat(64), decision: 'accepted', reason: 'x' }];
  assert.throws(() => f.j.submitCompletion(invocationId, 'bad', req), /stale review/);
  req.childReviews = []; req.evidence[0].path = '../profile/auth';
  assert.throws(() => f.j.submitCompletion(invocationId, 'bad', req), /REQUEST_CONFLICT/);
  assert.throws(() => f.j.submitCompletion(invocationId, 'bad-path', req), /SCOPE/);
  assert.equal(fs.readdirSync(join(f.j.directory, 'nodes')).length, before);
});

test('completion replay resolves the exact denied/accepted request, never another request candidate', t => {
  const f = fixture(t); const { invocationId } = launched(f);
  fs.writeFileSync(join(f.opts.workspace, 'src/report'), 'evidence B');
  const a = complete(); a.acceptance[0].id = 'wrong';
  assert.throws(() => f.j.submitCompletion(invocationId, 'A', a), /RESULT_INVALID/);
  const deniedA = f.j.submitCompletion(invocationId, 'A', a);
  assert.equal(deniedA.kind, 'RESULT_INVALID');
  const b = complete(); b.summary = 'candidate B';
  const candidateB = f.j.submitCompletion(invocationId, 'B', b);
  assert.deepEqual(JSON.parse(readStoredArtifact(f.j.directory, candidateB)).request, b);
  assert.deepEqual(f.j.submitCompletion(invocationId, 'A', a), deniedA);
  assert.throws(() => f.j.submitCompletion(invocationId, 'C', b), /PARENT_NOT_ACTIVE/);
  const deniedC = f.j.submitCompletion(invocationId, 'C', b);
  assert.equal(deniedC.kind, 'PARENT_NOT_ACTIVE');
  fs.unlinkSync(join(f.opts.workspace, 'src/report'));
  assert.deepEqual(f.j.submitCompletion(invocationId, 'B', b), candidateB);
  assert.throws(() => f.j.submitCompletion(invocationId, 'A', b), /REQUEST_CONFLICT/);
  assert.throws(() => f.j.submitCompletion(invocationId, 'B', a), /REQUEST_CONFLICT/);
  assert.deepEqual(f.j.submitCompletion(invocationId, 'A', a), deniedA);
  const live = f.j.snapshot(); const restored = inspect(f.j);
  assert.deepEqual(restored.state, live.state);
  assert.equal(restored.state.requestCount, 10); assert.equal(restored.state.nodes[0].calls, 10);
  assert.deepEqual(restored.state.requests.map(r => [r.requestId, r.kind]), [['A', 'RESULT_INVALID'], ['B', 'complete'], ['C', 'PARENT_NOT_ACTIVE']]);
  assert.equal(restored.state.requests[0].digest, sha256(canonicalJSON({ kind: 'complete', payload: a })));
  assert.equal(restored.state.requests[1].digest, sha256(canonicalJSON({ kind: 'complete', payload: b })));
  assert.deepEqual(restored.state.nodes[0].candidate, candidateB);
  assert.equal(restored.state.budget.spent, 1); assert.equal(restored.state.budget.acceptedNodes, 1);
  assert.equal(restored.launchAuthorized, false);
});

test('same request ID in different invocations cannot share completion outcomes', t => {
  const opts = options(t);
  opts.roots = [0, 1].map(phaseIndex => ({ ...opts.roots[0], phaseIndex, agentBudget: 4 }));
  const j = createDelegationJournal(opts); t.after(() => j.dispose());
  const pj = createProcessJournal(opts.artifactDirectory, opts.runId);
  const invocations = j.snapshot().state.nodes.map(n => {
    const token = pj.reserve(); const { invocationId } = j.launchIntent(n.nodeId, token);
    pj.started(token, process.pid); j.workerStarted(invocationId, process.pid); return invocationId;
  });
  fs.writeFileSync(join(opts.workspace, 'src/report'), 'evidence');
  const bad = complete(); bad.acceptance[0].id = 'wrong';
  assert.throws(() => j.submitCompletion(invocations[0], 'shared-id', bad), /RESULT_INVALID/);
  const ref = j.submitCompletion(invocations[1], 'shared-id', complete());
  assert.equal(j.submitCompletion(invocations[0], 'shared-id', bad).kind, 'RESULT_INVALID');
  assert.deepEqual(j.submitCompletion(invocations[1], 'shared-id', complete()), ref);
  assert.throws(() => j.acceptDelegation(invocations[1], 'shared-id', complete()), /REQUEST_CONFLICT/);
  const view = inspect(j);
  assert.equal(view.state.requestCount, 5); assert.deepEqual(view.state.nodes.map(n => n.calls), [2, 3]);
  assert.deepEqual(view.state.requests.map(r => r.invocationId), invocations);
  assert.deepEqual(view.state, j.snapshot().state);
});

// Deterministic syscall faults, not chmod assumptions (tests also work as root).
// Sync namespace exports because production uses both default and namespace fs imports.
function withFsFault(t, method, matches, code, action) {
  const original = fs[method];
  const mock = t.mock.method(fs, method, (...args) => {
    if (matches(...args)) throw Object.assign(new Error(`${code}: private-raw-detail-${'x'.repeat(10000)}`), { code });
    return original(...args);
  });
  syncBuiltinESMExports();
  try { return action(); } finally { mock.mock.restore(); syncBuiltinESMExports(); }
}

for (const kind of ['evidence', 'scope']) test(`missing ${kind} denials persist identity through filesystem repair, conflicts and acceptance`, t => {
  const f = fixture(t); const { invocationId } = launched(f);
  const req = kind === 'evidence' ? complete() : request(f.j);
  const path = join(f.opts.workspace, kind === 'evidence' ? 'src/report' : 'src/missing');
  if (kind === 'scope') req.children[0].directoryScope.read = ['src/missing'];
  const call = (id, payload) => kind === 'evidence' ? f.j.submitCompletion(invocationId, id, payload) : f.j.acceptDelegation(invocationId, id, payload);
  const before = f.j.snapshot(); const files = fs.readdirSync(join(f.j.directory, 'nodes'));
  assert.throws(() => call('missing', req), /^Error: SCOPE_DENIED: scope\/evidence path unavailable$/);
  const denied = call('missing', req);
  assert.equal(denied.kind, 'SCOPE_DENIED');
  assert.deepEqual(fs.readdirSync(join(f.j.directory, 'nodes')), files);
  assert.deepEqual(f.j.snapshot().state.budget, before.state.budget);
  if (kind === 'evidence') fs.writeFileSync(path, 'now exists'); else fs.mkdirSync(path);
  // Replay never rechecks the filesystem and cannot replace the first denial.
  withFsFault(t, 'realpathSync', p => p === f.opts.workspace, 'EIO', () => assert.deepEqual(call('missing', req), denied));
  const changed = structuredClone(req);
  if (kind === 'evidence') changed.summary = 'changed'; else changed.children[0].task = 'changed';
  assert.throws(() => call('missing', changed), /REQUEST_CONFLICT/);
  const fresh = structuredClone(req);
  if (kind === 'scope') fresh.directoryRevision = f.j.snapshot().state.sequence;
  const accepted = call('fresh', fresh);
  assert.ok(kind === 'scope' ? accepted.batchId : accepted.artifactId);
  assert.deepEqual(call('missing', req), denied);
  const restored = inspect(f.j);
  assert.deepEqual(restored.state, f.j.snapshot().state);
  assert.equal(restored.state.requestCount, 6); assert.equal(restored.state.nodes[0].calls, 6);
  assert.equal(restored.state.requests.length, 2); assert.equal(f.j.snapshot().poisoned, false);
  assert.equal(restored.state.budget.spent, 1);
});

for (const kind of ['evidence', 'scope']) test(`${kind} permission/path syscall errors become bounded durable denials only before mutation`, t => {
  const methods = kind === 'scope' ? ['realpathSync'] : ['lstatSync', 'openSync', 'readSync'];
  for (const method of methods) for (const code of ['EACCES', 'EPERM', 'ENOTDIR', 'ELOOP']) {
    const f = fixture(t); const { invocationId } = launched(f);
    const req = kind === 'evidence' ? complete() : request(f.j);
    const target = join(f.opts.workspace, kind === 'evidence' ? 'src/report' : 'src/child');
    if (kind === 'scope') { req.children[0].directoryScope.read = ['src/child']; fs.mkdirSync(target); }
    else fs.writeFileSync(target, 'readable without injected error');
    const call = payload => kind === 'evidence' ? f.j.submitCompletion(invocationId, 'denied', payload) : f.j.acceptDelegation(invocationId, 'denied', payload);
    const semantic = ['EACCES', 'EPERM'].includes(code) ? 'PERMISSION_DENIED' : 'SCOPE_DENIED';
    const matches = method === 'readSync' ? fd => {
      const opened = fs.fstatSync(fd), named = fs.statSync(target);
      return opened.dev === named.dev && opened.ino === named.ino;
    } : p => p === target;
    withFsFault(t, method, matches, code, () => assert.throws(() => call(req), error => {
      assert.match(error.message, new RegExp(`^${semantic}:`)); assert.ok(error.message.length < 100); return true;
    }));
    const denied = call(req); assert.equal(denied.kind, semantic);
    assert.equal(denied.invocationId, invocationId); assert.equal(denied.requestId, 'denied');
    const changed = structuredClone(req);
    if (kind === 'scope') changed.children[0].task = 'different'; else changed.summary = 'different';
    assert.throws(() => call(changed), /REQUEST_CONFLICT/);
    const restored = inspect(f.j);
    assert.deepEqual(restored.state, f.j.snapshot().state);
    assert.equal(restored.state.requestCount, 3); assert.equal(restored.state.nodes[0].calls, 3);
    assert.equal(restored.state.requests.length, 1); assert.equal(restored.state.budget.acceptedNodes, 1);
    assert.equal(f.j.snapshot().poisoned, false);
    assert.doesNotMatch(fs.readFileSync(join(f.j.directory, 'events.jsonl'), 'utf8'), /private-raw-detail/);
  }
});

for (const kind of ['evidence', 'scope']) test(`128 distinct missing ${kind} requests exhaust disk-backed counts, retain terminal headroom`, t => {
  const f = fixture(t); const { invocationId } = launched(f);
  const req = kind === 'evidence' ? complete() : request(f.j);
  if (kind === 'scope') req.children[0].directoryScope.read = ['src/absent'];
  const call = id => kind === 'evidence' ? f.j.submitCompletion(invocationId, id, req) : f.j.acceptDelegation(invocationId, id, req);
  for (let i = 0; i < 128; i++) assert.throws(() => call(`missing:${i}`), /SCOPE_DENIED/);
  const before = f.j.snapshot();
  for (const id of ['missing:128', 'missing:129', 'missing:0']) assert.throws(() => call(id), /REQUEST_LIMIT/);
  assert.deepEqual(f.j.snapshot(), before);
  fs.unlinkSync(join(f.j.directory, 'state.json')); // reconstruct counters from authority, not cache
  const restored = inspect(f.j);
  assert.equal(restored.projection, 'missing'); assert.deepEqual(restored.state, before.state);
  assert.equal(restored.state.requestCount, 128); assert.equal(restored.state.nodes[0].calls, 128);
  assert.equal(restored.state.requests.length, 128); assert.equal(restored.state.budget.acceptedNodes, 1);
  assert.equal(restored.state.budget.spent, 1);
  f.j.recordFailure(f.rootId, { ...failure('infrastructure_error'), cause: 'REQUEST_LIMIT' });
  assert.equal(inspect(f.j).reservedBytes, 3 * 4096);
});

test('4096 workflow calls: deterministic reducer denial/repeat/conflict replay, independent per-node limits', t => {
  const opts = options(t); opts.policy.totalAgentBudget = 33;
  opts.roots = Array.from({ length: 33 }, (_, phaseIndex) => ({ ...opts.roots[0], phaseIndex, agentBudget: 1 }));
  const j = createDelegationJournal(opts); t.after(() => j.dispose());
  const manifest = inspect(j).manifest;
  let state = initialState(manifest); const events = [];
  function event(type, payload) { return { sequence: state.sequence + 1, eventId: randomUUID(), at: manifest.createdAt, type, payload }; }
  function apply(type, payload) {
    const e = event(type, payload); state = reduceEvent(state, e, manifest); events.push(e);
  }
  apply('root_reserved', { rootPlanHash: sha256(canonicalJSON(manifest.roots)), count: 33 });
  for (const n of manifest.roots) apply('launch_intent', { nodeId: n.nodeId, invocationId: randomUUID(), processToken: randomUUID() });
  const invocations = state.nodes.map(n => n.invocationId);
  for (let i = 0; i < 32; i++) {
    const payload = { invocationId: invocations[i], requestId: 'missing', digest: 'a'.repeat(64) };
    apply('request_denied', { ...payload, code: i % 2 ? 'PERMISSION_DENIED' : 'SCOPE_DENIED' });
    for (let call = 1; call < 128; call++) apply('request_repeated', { ...payload,
      digest: call % 2 ? 'a'.repeat(64) : 'b'.repeat(64), conflict: call % 2 === 0 });
    assert.throws(() => reduceEvent(state, event('request_repeated', { ...payload, conflict: false }), manifest), /REQUEST_LIMIT/);
  }
  assert.equal(state.requestCount, 4096); assert.equal(state.requests.length, 32);
  assert.deepEqual(state.nodes.map(n => n.calls), [...Array(32).fill(128), 0]);
  assert.throws(() => reduceEvent(state, event('request_denied', { invocationId: invocations[32], requestId: 'new', digest: 'c'.repeat(64), code: 'SCOPE_DENIED' }), manifest), /REQUEST_LIMIT/);
  const replay = events.reduce((s, e) => reduceEvent(s, e, manifest), initialState(manifest));
  assert.deepEqual(replay, state); assert.equal(state.budget.spent, 33);
  checkCapacity(state, 0, 4096, 'node_result');
  t.diagnostic('4096 in-memory reducer calls + replay, NOT 4096 writer/fsync operations; disk-backed missing-path exhaustion tested separately');
});

test('unexpected validation I/O poisons without a denial; permission/missing mutation faults never become denials', t => {
  for (const kind of ['evidence', 'scope']) for (const code of ['EIO', 'EMFILE', 'ENOSPC']) {
    const f = fixture(t); const { invocationId } = launched(f);
    const req = kind === 'evidence' ? complete() : request(f.j);
    fs.writeFileSync(join(f.opts.workspace, 'src/report'), 'evidence');
    const call = () => kind === 'evidence' ? f.j.submitCompletion(invocationId, 'fault', req) : f.j.acceptDelegation(invocationId, 'fault', req);
    withFsFault(t, 'realpathSync', p => p === f.opts.workspace, code, () => assert.throws(call, /^Error: OWNERSHIP_UNKNOWN: scope\/evidence validation failed; inspection only$/));
    assert.equal(f.j.snapshot().poisoned, true); assert.throws(call, /writer unavailable/);
    assert.equal(inspect(f.j).state.requestCount, 0);
  }
  for (const boundary of ['before:publish-link', 'after:event-fsync', 'after:projection-rename']) for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    let armed = false;
    const f = fixture(t, { fault: p => { if (armed && p === boundary) throw Object.assign(new Error('mutation fault'), { code }); } });
    const { invocationId } = launched(f);
    fs.writeFileSync(join(f.opts.workspace, 'src/report'), 'evidence');
    armed = true;
    assert.throws(() => f.j.submitCompletion(invocationId, 'fault', complete()), /mutation fault/);
    armed = false;
    assert.equal(f.j.snapshot().poisoned, true);
    assert.throws(() => f.j.submitCompletion(invocationId, 'fault', complete()), /writer unavailable/);
    const view = inspect(f.j);
    assert.ok(view.state.requests.every(r => r.kind === 'complete')); // no safe-denial conversion
    assert.equal(view.state.requestCount, boundary === 'before:publish-link' ? 0 : 1);
    assert.equal(view.launchAuthorized, false);
  }
});

test('read-time evidence changes are ambiguous infrastructure, never safe denials or retryable candidates', t => {
  const f = fixture(t); const { invocationId } = launched(f);
  const path = join(f.opts.workspace, 'src/report'); fs.writeFileSync(path, 'before');
  const original = fs.readSync; let changed = false;
  const mocked = t.mock.method(fs, 'readSync', (...args) => {
    const result = original(...args);
    if (!changed) { changed = true; fs.writeFileSync(path, 'changed during evidence read'); }
    return result;
  });
  syncBuiltinESMExports();
  try { assert.throws(() => f.j.submitCompletion(invocationId, 'race', complete()), /OWNERSHIP_UNKNOWN: scope\/evidence validation failed/); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(changed, true); assert.equal(f.j.snapshot().poisoned, true);
  assert.throws(() => f.j.submitCompletion(invocationId, 'race', complete()), /writer unavailable/);
  assert.equal(inspect(f.j).state.requestCount, 0); assert.equal(inspect(f.j).state.nodes[0].candidate, null);
});

test('filesystem denial acknowledgement still waits for fsync and projection; failed denial never double-counts', t => {
  for (const boundary of ['before:event-fsync', 'after:event-fsync', 'before:projection-rename', 'after:projection-rename']) {
    let armed = false;
    const f = fixture(t, { fault: p => { if (armed && p === boundary) throw new Error('denial persistence fault'); } });
    const { invocationId } = launched(f); armed = true;
    assert.throws(() => f.j.submitCompletion(invocationId, 'absent', complete()), /denial persistence fault/);
    armed = false;
    assert.equal(f.j.snapshot().poisoned, true);
    assert.throws(() => f.j.submitCompletion(invocationId, 'absent', complete()), /writer unavailable/);
    const restored = inspect(f.j);
    assert.equal(restored.state.requestCount, 1); assert.equal(restored.state.requests[0].kind, 'SCOPE_DENIED');
    assert.equal(restored.launchAuthorized, false); // full write observed is not power-loss proof
  }
});

test('128-call bound includes duplicates and denials; terminal failure still fits and no automatic retry', t => {
  const f = fixture(t); const { invocationId } = launched(f);
  const req = request(f.j); req.children[0].agentBudget = 8;
  assert.throws(() => f.j.acceptDelegation(invocationId, 'denied', req), /BUDGET/);
  for (let i = 1; i < 128; i++) f.j.acceptDelegation(invocationId, 'denied', req);
  const before = f.j.snapshot();
  assert.throws(() => f.j.acceptDelegation(invocationId, 'denied', req), /REQUEST_LIMIT/);
  assert.equal(f.j.snapshot().usedBytes, before.usedBytes);
  f.j.recordFailure(f.rootId, { ...failure('infrastructure_error'), cause: 'REQUEST_LIMIT' });
  const restored = inspect(f.j);
  assert.equal(restored.state.requestCount, 128); assert.equal(restored.state.budget.acceptedNodes, 1);
  assert.equal(restored.reservedBytes, 3 * 4096); // root join + close + workflow
});

test('terminal slots release only matching obligations; actual encoded-byte capacity includes escaping and LF', t => {
  const f = fixture(t); const s = f.j.snapshot().state;
  const room = reservedBytes(s);
  const encoded = Buffer.byteLength(canonicalJSON({ text: 'x' + '\n'.repeat(100) })) + 1;
  assert.ok(encoded > 200);
  assert.doesNotThrow(() => checkCapacity(s, LIMITS.journalBytes - room - encoded, encoded, 'request_denied'));
  assert.throws(() => checkCapacity(s, LIMITS.journalBytes - room - encoded + 1, encoded, 'request_denied'), /JOURNAL_LIMIT/);
  assert.throws(() => checkCapacity(s, 0, 4097, 'node_result'));
  assert.throws(() => checkCapacity(s, 0, LIMITS.frameBytes + 1, 'request_denied'));
  f.j.recordFailure(f.rootId, failure()); assert.equal(f.j.snapshot().reservedBytes, room - 4096);
  f.j.joinUnlaunched(f.rootId); assert.equal(f.j.snapshot().reservedBytes, room - 8192);
  f.j.closeNode(f.rootId); f.j.closeWorkflow();
  const restored = inspect(f.j); assert.equal(restored.reservedBytes, 0); assert.equal(restored.state.budget.freeWorkflow, 8);
  assert.equal(restored.unresolved.length, 0); assert.equal(restored.launchAuthorized, false);
});

test('manifest binding, unknown versions, corrupted references and hash-linked records fail closed', t => {
  const f = fixture(t);
  for (const key of ['manifestDigest', 'specDigest', 'profileDigest']) assert.throws(() => inspectDelegationJournal(f.j.directory, { ...f.j.binding, [key]: '0'.repeat(64) }), /OWNERSHIP/);
  const file = join(f.j.directory, 'events.jsonl'), original = fs.readFileSync(file);
  const event = JSON.parse(original);
  const malformedUTF8 = Buffer.from(original); malformedUTF8[malformedUTF8.indexOf('root_reserved')] = 255;
  fs.writeFileSync(file, malformedUTF8); assert.throws(() => inspect(f.j), /invalid UTF-8/);
  for (const change of [{ sequence: 2 }, { schema: 'v2' }, { ownerEpoch: randomUUID() }, { previousHash: '0'.repeat(64) }, { payload: { count: 0 } }, { capability: 'bad' }]) {
    fs.writeFileSync(file, `${canonicalJSON({ ...event, ...change })}\n`);
    assert.throws(() => inspect(f.j));
  }
  fs.writeFileSync(file, original);
  const blob = join(f.j.directory, 'nodes', `${f.j.snapshot().state.nodes[0].index.artifactId.slice(9)}.blob`);
  fs.chmodSync(blob, 0o600); fs.writeFileSync(blob, 'corrupt'); assert.throws(() => inspect(f.j), /integrity/);
});

test('torn tail, duplicate record, removed acknowledged tail, symlink and oversized authority all reject', t => {
  const f = fixture(t); f.j.recordFailure(f.rootId, failure());
  const file = join(f.j.directory, 'events.jsonl'), original = fs.readFileSync(file);
  const first = original.subarray(0, original.indexOf(10) + 1);
  for (const bytes of [original.subarray(0, original.length - 1), Buffer.concat([original, Buffer.from('{')]), Buffer.concat([first, first]), first, Buffer.alloc(LIMITS.journalBytes + 1)]) {
    fs.writeFileSync(file, bytes); assert.throws(() => inspect(f.j));
  }
  fs.writeFileSync(file, original);
  const target = join(f.opts.artifactDirectory, 'elsewhere'); fs.renameSync(file, target); fs.symlinkSync(target, file);
  assert.throws(() => inspect(f.j));
});

test('derived state may be missing or atomically stale, but cannot authorize replay or contradict log', t => {
  const f = fixture(t); const path = join(f.j.directory, 'state.json'), old = fs.readFileSync(path);
  f.j.recordFailure(f.rootId, failure());
  fs.writeFileSync(path, old); assert.equal(inspect(f.j).projection, 'stale');
  fs.unlinkSync(path); const restored = inspect(f.j); assert.equal(restored.projection, 'missing');
  assert.equal(restored.unresolved[0].classification, 'result_without_join'); assert.equal(restored.state.budget.freeWorkflow, 0);
  fs.writeFileSync(path, '{'); assert.throws(() => inspect(f.j));
});

test('every constructor I/O boundary fault leaves exclusive allocation or no allocation, never a reopened writer', t => {
  const steps = [];
  const baseline = fixture(t, { fault: point => steps.push(point) });
  baseline.j.dispose();
  assert.ok(steps.includes('after:allocation-mkdir') && steps.includes('after:event-fsync') && steps.includes('after:projection-rename'));
  for (let stop = 0; stop < steps.length; stop++) {
    let count = 0; const opts = options(t, { fault: () => { if (count++ === stop) throw new Error(`injected-${stop}`); } });
    assert.throws(() => createDelegationJournal(opts), /injected/);
    const directory = join(opts.artifactDirectory, 'delegation');
    if (!fs.existsSync(directory)) continue;
    const { fault, ...retry } = opts;
    assert.throws(() => createDelegationJournal(retry), /EEXIST/);
    if (fs.existsSync(join(directory, 'manifest.json'))) {
      try { const view = inspectDelegationJournal(directory, bindingFromFixtureDisk(opts)); assert.equal(view.launchAuthorized, false); assert.equal(view.state.budget.spent, 0); }
      catch (error) { assert.match(error.message, /ENOENT|OWNERSHIP|unsafe|JSON|Unexpected|canonical|integrity/); }
    }
  }
  t.diagnostic(`${steps.length} constructor before/after I/O fault points tested`);
});

test('every result publication/append/projection fault poisons live writer and retains budget or fails inspection', t => {
  const points = []; let armed = false;
  const f = fixture(t, { fault: p => { if (armed) points.push(p); } });
  armed = true; f.j.recordFailure(f.rootId, failure()); armed = false;
  for (let stop = 0; stop < points.length; stop++) {
    let count = 0, enabled = false;
    const c = fixture(t, { fault: () => { if (enabled && count++ === stop) throw new Error('injected result'); } });
    enabled = true; assert.throws(() => c.j.recordFailure(c.rootId, failure()), /injected/); enabled = false;
    assert.equal(c.j.snapshot().poisoned, true);
    assert.throws(() => c.j.recordFailure(c.rootId, failure()), /writer unavailable/);
    try {
      const restored = inspect(c.j);
      assert.equal(restored.launchAuthorized, false); assert.equal(restored.state.budget.freeWorkflow, 0);
      assert.ok(restored.reservedBytes === 4 * 4096 || restored.reservedBytes === 3 * 4096);
    } catch (error) { assert.match(error.message, /unsafe|OWNERSHIP|JSON|integrity/); }
  }
  t.diagnostic(`${points.length} result before/after I/O fault points tested`);
});

test('actual partial append followed by failure never yields an acknowledgement or trusted prefix', t => {
  let enabled = false, dir, writes = 0;
  const f = fixture(t, { fault: point => {
    if (enabled && point === 'after:write' && writes++ === 1) {
      // First write publishes the result blob; second is the authoritative append.
      const path = join(dir, 'events.jsonl'); fs.truncateSync(path, fs.statSync(path).size - 3); throw new Error('disconnect during write');
    }
  } }); dir = f.j.directory; enabled = true;
  assert.throws(() => f.j.recordFailure(f.rootId, failure()), /disconnect/);
  assert.equal(f.j.snapshot().poisoned, true); assert.throws(() => inspect(f.j), /torn/);
});

test('crashed local journal owner after event fsync is inspection-only in a different process', t => {
  const opts = options(t); const moduleURL = new URL('../lib/delegation-journal.mjs', import.meta.url).href;
  const script = `import {createDelegationJournal} from ${JSON.stringify(moduleURL)};
    const opts=${JSON.stringify(opts)}; let armed=false;
    const j=createDelegationJournal({...opts,fault:p=>{if(armed&&p==='after:event-fsync')process.exit(71)}});
    process.stdout.write(JSON.stringify({directory:j.directory,binding:j.binding})+'\\n');
    armed=true; j.recordFailure(j.snapshot().state.nodes[0].nodeId,${JSON.stringify(failure())});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 71, result.stderr);
  const recorded = JSON.parse(result.stdout.trim());
  const view = inspectDelegationJournal(recorded.directory, recorded.binding);
  assert.equal(view.projection, 'stale'); assert.notEqual(view.manifest.ownerPid, process.pid);
  assert.equal(view.unresolved[0].classification, 'result_without_join'); assert.equal(view.state.budget.freeWorkflow, 0);
  assert.equal(view.launchAuthorized, false);
  assert.throws(() => createDelegationJournal(opts), /EEXIST/);
});

test('accepted child deadline is bound to the exact durable acceptance timestamp', t => {
  const f = fixture(t); const { invocationId } = launched(f);
  const req = request(f.j); req.children[0].timeoutMs = 1234;
  const b = f.j.acceptDelegation(invocationId, 'deadline', req);
  const view = inspect(f.j);
  const accepted = fs.readFileSync(join(f.j.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(e => e.type === 'delegation_accepted');
  assert.equal(view.state.nodes.find(n => n.nodeId === b.children[0]).authority.deadlineAt, accepted.at + 1234);
});

test('cumulative cancelled-child admission is never refunded and full 127-entry index remains pageable', t => {
  const f = fixture(t); const { invocationId } = launched(f);
  for (let i = 0; i < 127; i++) {
    const b = f.j.acceptDelegation(invocationId, `batch:${i}`, request(f.j));
    const childId = b.children[0];
    f.j.recordFailure(childId, failure()); f.j.joinUnlaunched(childId); f.j.closeNode(childId); f.j.joinBatch(b.batchId);
  }
  assert.equal(f.j.snapshot().state.budget.acceptedNodes, 128);
  assert.equal(f.j.snapshot().state.budget.nodes[0].available, 7);
  assert.throws(() => f.j.acceptDelegation(invocationId, 'excess', request(f.j)), /ADMISSION_LIMIT/);
  const view = inspect(f.j), ref = view.state.nodes[0].index;
  let offsetBytes = 0; const pages = [];
  while (offsetBytes < ref.bytes) {
    const page = readDelegationArtifactPage(f.j.directory, ref, { view: 'artifact', artifactId: ref.artifactId, offsetBytes, limitBytes: 8192 }, [ref.artifactId]);
    pages.push(Buffer.from(page.data, 'base64')); offsetBytes = page.endOffsetBytes;
  }
  assert.equal(JSON.parse(Buffer.concat(pages)).children.length, 127);
  assert.equal(view.state.budget.spent, 1);
});

test('each transition fsync crash boundary reconstructs only committed storage, never dispatch/credit replay', t => {
  const cases = ['accepted', 'intent', 'started', 'candidate', 'joined', 'batch', 'closed', 'workflow'];
  for (const kind of cases) for (const boundary of ['before:event-fsync', 'after:event-fsync', 'before:projection-rename', 'after:projection-rename']) {
    let armed = false;
    const f = fixture(t, { fault: p => { if (armed && p === boundary) throw new Error('transition crash'); } });
    let action;
    if (kind === 'intent' || kind === 'started') {
      const pj = createProcessJournal(f.opts.artifactDirectory, f.opts.runId), token = pj.reserve();
      if (kind === 'intent') action = () => f.j.launchIntent(f.rootId, token);
      else { const { invocationId } = f.j.launchIntent(f.rootId, token); pj.started(token, process.pid); action = () => f.j.workerStarted(invocationId, process.pid); }
    } else if (kind === 'accepted' || kind === 'candidate' || kind === 'batch') {
      const { invocationId } = launched(f);
      if (kind === 'accepted') { const req = request(f.j); action = () => f.j.acceptDelegation(invocationId, 'request', req); }
      if (kind === 'candidate') { fs.writeFileSync(join(f.opts.workspace, 'src/report'), 'e'); action = () => f.j.submitCompletion(invocationId, 'request', complete()); }
      if (kind === 'batch') {
        const b = f.j.acceptDelegation(invocationId, 'request', request(f.j));
        f.j.recordFailure(b.children[0], failure()); f.j.joinUnlaunched(b.children[0]);
        action = () => f.j.joinBatch(b.batchId);
      }
    } else {
      f.j.recordFailure(f.rootId, failure());
      if (kind === 'joined') action = () => f.j.joinUnlaunched(f.rootId);
      else {
        f.j.joinUnlaunched(f.rootId);
        if (kind === 'closed') action = () => f.j.closeNode(f.rootId);
        else { f.j.closeNode(f.rootId); action = () => f.j.closeWorkflow(); }
      }
    }
    armed = true; assert.throws(action, /transition crash/); armed = false;
    assert.equal(f.j.snapshot().poisoned, true);
    const view = inspect(f.j); assert.equal(view.launchAuthorized, false); assert.equal(view.resumable, false);
    // A full write seen before a failed fsync is conservatively inspection evidence,
    // not a claim it survived a real power loss or permission to act on it.
    assert.equal(view.state.budget.spent, ['accepted', 'intent', 'started', 'candidate', 'batch'].includes(kind) ? 1 : 0);
  }
  t.diagnostic('32 transition-specific fsync/rename crash boundaries tested');
});

test('forged stale projection, manifest/profile link aliases and writer log replacement fail closed', t => {
  const f = fixture(t); const file = join(f.j.directory, 'state.json'), old = JSON.parse(fs.readFileSync(file));
  f.j.recordFailure(f.rootId, failure()); old.state.budget.freeWorkflow = 7;
  fs.writeFileSync(file, canonicalJSON(old)); assert.throws(() => inspect(f.j), /projection mismatch/);
  const manifest = join(f.j.directory, 'manifest.json'), alias = join(f.opts.artifactDirectory, 'alias');
  fs.linkSync(manifest, alias); assert.throws(() => inspect(f.j), /unsafe/); fs.unlinkSync(alias);
  const log = join(f.j.directory, 'events.jsonl'), bytes = fs.readFileSync(log);
  fs.renameSync(log, `${log}.old`); fs.writeFileSync(log, bytes, { mode: 0o600 });
  assert.throws(() => f.j.joinUnlaunched(f.rootId), /journal replaced/); assert.equal(f.j.snapshot().poisoned, true);
});

test('M1 usage diagnostic channel stays separate from saved source usage; no helper modifications', () => {
  const observer = exclusiveUsageObserver('invocation:fixture');
  observer.observe({ type: 'compaction_start', reason: 'overflow' });
  const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const source = observer.observe({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true, result: { usage } });
  const diagnostic = observer.observe({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: false, errorMessage: 'Context overflow recovery failed after one compact-and-retry attempt.' });
  assert.equal(source.usage.totalTokens, 3); assert.equal(diagnostic.source, undefined); assert.equal(diagnostic.usage, undefined);
  assert.match(diagnostic.diagnostic.errorMessage, /failed/);
  assert.equal(observer.counters.compaction, 1); assert.equal(observer.counters.missing, 0);
});
