import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createDelegationJournal, inspectDelegationJournal, applyDelegationResult, claimDelegationExecutor, readDelegationArtifactPage, applyObserverSeal } from '../lib/delegation-journal.mjs';
import { createDelegationExecutor } from '../lib/delegation-executor.mjs';
import { createDelegationResults } from '../lib/delegation-results.mjs';
import { createProcessJournal } from '../lib/process-journal.mjs';
import { readStoredArtifact, canonicalJSON, sha256 } from '../lib/delegation-storage.mjs';
import { probeGroup } from '../lib/scoped-process.mjs';
import { assertBudgetInvariants } from '../lib/delegation-budget.mjs';
import { invocationUsage } from '../lib/delegation-usage.mjs';
import { initialState, reduceEvent } from '../lib/delegation-journal-model.mjs';
import { PiJsonEventCollector } from '../lib/pi-json-stream.mjs';
const worker = new URL('./support/delegation-results/worker.mjs', import.meta.url).pathname;
const oldWorker = new URL('./support/delegation-executor/process.mjs', import.meta.url).pathname;
const pause = ms => new Promise(r => setTimeout(r, ms));
const scope = { read: ['src'], write: [] };
function fixture(t, { budgets = [8], fault } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'delegation-results-'));
  for (const d of ['workspace', 'workspace/src', 'profile', 'artifacts']) fs.mkdirSync(join(root, d), { mode: 0o700 });
  fs.writeFileSync(join(root, 'workspace/src/evidence'), 'owned evidence 😀');
  const j = createDelegationJournal({ artifactDirectory: join(root, 'artifacts'), workspace: join(root, 'workspace'),
    protectedDirectories: [join(root, 'profile')], runId: 'results-fixture', specDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
    policy: { maxDepth: 3, totalAgentBudget: budgets.reduce((a, b) => a + b), directoryScope: scope, context: { objective: 'fixture', constraints: [] } },
    roots: budgets.map((agentBudget, phaseIndex) => ({ phaseIndex, agentBudget, label: 'fixture', task: 'finite worker', permissions: 'r', directoryScope: scope, deadlineAt: null })),
    ...(fault ? { fault } : {}) });
  const pj = createProcessJournal(join(root, 'artifacts'), 'results-fixture'), pids = new Set(), promises = [], gates = [];
  const started = pj.started;
  pj.started = (token, pid) => { pids.add(pid); return started(token, pid); };
  const e = createDelegationExecutor({ journal: j, processJournal: pj }), c = createDelegationResults({ journal: j, executor: e });
  const state = () => j.snapshot().state;
  const read = ref => JSON.parse(readStoredArtifact(j.directory, ref));
  function start(nodeId = state().nodes[0].nodeId, mode = 'clean', options = {}) {
    const gate = join(root, `gate-${gates.length}`); gates.push(gate);
    let ready;
    const readiness = new Promise(r => { ready = r; });
    const w = c.startInvocation(nodeId, process.execPath, [worker, mode, gate], { timeoutMs: 8000, killGraceMs: 100, ...options,
      onStdout(chunk) { if (chunk.includes('fixture-ready')) ready(); options.onStdout?.(chunk); } });
    promises.push(w.result);
    return { ...w, nodeId, gate, ready: readiness, release() { fs.writeFileSync(gate, 'done'); } };
  }
  function completion(w, status = 'success', patch = {}) {
    const n = state().nodes.find(n => n.nodeId === w.nodeId);
    return { status, summary: 'Agent semantic claim, not a runner test certification',
      acceptance: n.assignment.acceptance.map(a => ({ id: a.id, outcome: status === 'success' ? 'passed' : 'unverified', evidenceIds: ['local:report'] })),
      evidence: [{ label: 'report', path: 'src/evidence', description: 'snapshot' }],
      childReviews: state().nodes.filter(n => n.parentNodeId === w.nodeId && n.joined).map(n => ({ childNodeId: n.nodeId, resultHash: n.result.sha256, decision: 'accepted', reason: 'read and integrated' })),
      remainingWork: [], ...patch };
  }
  const submit = (w, status, patch) => j.submitCompletion(w.scope.invocationId, 'complete', completion(w, status, patch));
  async function finalize(w) {
    w.release(); await w.result;
    const settled = await e.settleScope(w.scope);
    const ref = await c.finalize(w.scope, settled.receipt);
    return { ref, receipt: settled.receipt, content: read(ref) };
  }
  function delegate(w, budgets, inherited = []) {
    return j.acceptDelegation(w.scope.invocationId, `batch-${state().batches.length}`, { directoryRevision: state().sequence,
      children: budgets.map((agentBudget, i) => ({ label: `child-${i}`, task: 'finite subtask', acceptance: [{ id: 'a', criterion: 'cite' }],
        agentBudget, permissions: 'r', directoryScope: scope })) }, inherited);
  }
  t.after(async () => {
    gates.forEach(g => fs.writeFileSync(g, 'teardown finite release'));
    await Promise.allSettled(promises);
    for (const pid of pids) {
      const until = Date.now() + 12000;
      while (probeGroup(pid) === 'present' && Date.now() < until) await pause(20);
      assert.equal(probeGroup(pid), 'gone', `fixture group ${pid} at ${root}`);
    }
    j.dispose();
    fs.writeFileSync(join(root, 'cleanup.json'), JSON.stringify({ groups: [...pids].map(pid => ({ pid, disposition: 'ESRCH' })), signals: 0 }));
    t.diagnostic(`retained ${root}; ${pids.size} live-owned groups ESRCH; no teardown signals`);
  });
  return { root, j, pj, e, c, state, read, start, completion, submit, finalize, delegate, promises };
}
const inspect = f => inspectDelegationJournal(f.j.directory, f.j.binding);

for (const status of ['success', 'partial', 'failed']) test(`real clean ${status} candidate -> immutable normalized final -> exactly-once root return`, async t => {
  const f = fixture(t), w = f.start(); await w.ready; f.submit(w, status);
  const { ref, receipt, content } = await f.finalize(w);
  assert.equal(content.status, status); assert.equal(content.usage.totals.totalTokens, 17);
  assert.equal(content.usage.counters.assistant, 1); assert.equal(content.usage.counters.ignoredTool, 1);
  assert.equal(content.usage.completeness, 'reported');
  const evidence = content.completion.evidence[0];
  assert.equal(evidence.ownerNodeId, w.nodeId);
  assert.deepEqual(content.completion.acceptance[0].evidenceIds, [evidence.reference.artifactId]);
  assert.equal(content.completion.evidence[0].path, undefined);
  const before = f.j.snapshot(), files = fs.readdirSync(join(f.j.directory, 'nodes'));
  assert.equal(await f.c.finalize(w.scope, receipt), ref);
  assert.deepEqual(f.j.snapshot(), before); assert.deepEqual(fs.readdirSync(join(f.j.directory, 'nodes')), files);
  assert.throws(() => f.e.consumeReceipt(w.scope, receipt), /UNAUTHORIZED/);
  assert.throws(() => f.j.joinUnlaunched(w.nodeId), /OWNERSHIP_UNKNOWN/);
  assert.throws(() => f.c.join(w.scope, { ...ref }), /UNAUTHORIZED/);
  f.c.join(w.scope, ref); const joined = f.j.snapshot(); f.c.join(w.scope, ref);
  assert.deepEqual(f.j.snapshot(), joined); assert.equal(joined.state.budget.freeWorkflow, 7);
  assert.equal(joined.state.budget.spent, 1); assert.equal(joined.state.budget.acceptedNodes, 1);
  f.j.closeWorkflow(); assert.equal(inspect(f).reservedBytes, 0); assert.equal(inspect(f).launchAuthorized, false);
});

test('clean exit without candidate is MISSING_COMPLETION, not text success or empty scope success', async t => {
  const f = fixture(t), w = f.start(); await w.ready;
  const r = await f.finalize(w); assert.equal(r.content.status, 'missing_completion'); assert.equal(r.content.cause, 'MISSING_COMPLETION');
  f.c.join(w.scope, r.ref); assert.equal(f.state().budget.spent, 1);
  const empty = f.e.openDeclaredShell(), receipt = (await f.e.settleScope(empty)).receipt;
  await assert.rejects(() => f.c.finalize(empty, receipt), /UNAUTHORIZED/);
});

for (const [mode, expected] of [['nonzero', 'failed'], ['signal', 'failed'], ['residual', 'failed'], ['m1', 'failed'],
  ['conflict', 'infrastructure_error'], ['malformed', 'infrastructure_error'], ['oversized', 'infrastructure_error'],
  ['missing-usage', 'success'], ['unfinished', 'infrastructure_error']]) test(`success candidate cannot mask ${mode}; exclusive usage retained honestly`, async t => {
  const f = fixture(t), w = f.start(undefined, mode); await w.ready; f.submit(w);
  const r = await f.finalize(w); assert.equal(r.content.status, expected);
  if (mode === 'm1') {
    assert.equal(r.content.cause, 'COMPACTION_FAILURE'); assert.equal(r.content.usage.totals.totalTokens, 34);
    assert.equal(r.content.usage.counters.compaction, 1); assert.equal(r.content.usage.counters.missing, 0);
    assert.equal(r.content.usage.diagnostic.errorMessage, 'finite overflow recovery failure');
  }
  if (['missing-usage', 'unfinished'].includes(mode)) assert.equal(r.content.usage.completeness, 'missing');
  if (mode === 'residual') assert.equal(r.content.cause, 'RESIDUAL_CLEANUP');
  f.c.join(w.scope, r.ref); assert.equal(f.state().budget.freeWorkflow, 7);
});

for (const kind of ['timeout', 'cancel', 'callback', 'end-callback']) test(`success candidate with real ${kind} stays nonclean but stopped subtree can join`, async t => {
  const f = fixture(t), abort = new AbortController();
  const w = f.start(undefined, 'clean', { signal: abort.signal, timeoutMs: kind === 'timeout' ? 400 : 8000,
    ...(kind === 'callback' ? { onStdout() { throw new Error('fixture callback'); } } : {}),
    ...(kind === 'end-callback' ? { onChildEnd() { throw new Error('fixture callback'); } } : {}) });
  // Starts are already durably acknowledged when startInvocation returns.
  f.submit(w);
  if (kind === 'cancel') { await w.ready; abort.abort('operator'); }
  if (kind === 'end-callback') w.release();
  await w.result;
  const receipt = (await f.e.settleScope(w.scope)).receipt;
  const ref = await f.c.finalize(w.scope, receipt), content = f.read(ref);
  assert.equal(content.status, kind === 'timeout' ? 'timeout' : kind === 'cancel' ? 'cancelled' : 'infrastructure_error');
  f.c.join(w.scope, ref); assert.equal(f.state().budget.spent, 1);
});

test('whole worker scope includes shell nonclean outcomes, not only clean worker receipt', async t => {
  const f = fixture(t), w = f.start(); await w.ready;
  const shell = await f.e.runShell(w.scope, 2, process.execPath, [oldWorker, 'nonzero'], { timeoutMs: 2000 });
  assert.equal(shell.classification, 'nonzero'); f.submit(w);
  w.release(); const outcome = await w.result; assert.equal(outcome.classification, 'clean');
  await assert.rejects(() => f.c.finalize(w.scope, outcome.receipt), /UNAUTHORIZED/);
  const receipt = (await f.e.settleScope(w.scope)).receipt;
  assert.equal(receipt.commands.length, 2);
  const ref = await f.c.finalize(w.scope, receipt); assert.equal(f.read(ref).cause, 'NONZERO'); f.c.join(w.scope, ref);
});

test('real child/grandchild and sequential siblings: live ancestor/unrelated lane, current reviews/indexes, forest exclusive sum', async t => {
  const f = fixture(t, { budgets: [9, 1] }), parent = f.start(), lane = f.start(f.state().nodes[1].nodeId);
  await Promise.all([parent.ready, lane.ready]);
  const emptyIndex = f.state().nodes[0].index;
  const b = f.delegate(parent, [5, 2]), child = f.start(b.children[0]); await child.ready;
  const sub = f.delegate(child, [2]), grand = f.start(sub.children[0]); await grand.ready;
  f.submit(grand); const g = await f.finalize(grand); f.c.join(grand.scope, g.ref);
  const gcEvidence = g.content.completion.evidence[0].reference.artifactId;
  // Grandchild evidence is visible to its direct parent, not automatically root.
  const childRequest = f.completion(child); childRequest.acceptance[0].evidenceIds.push(gcEvidence);
  f.j.submitCompletion(child.scope.invocationId, 'complete', childRequest);
  const ch = await f.finalize(child); f.c.join(child.scope, ch.ref);
  assert.equal(f.state().batches.find(x => x.batchId === b.batchId).joined, false);
  assert.equal(f.state().nodes.find(n => n.nodeId === child.nodeId).closed, false);
  assert.throws(() => f.j.closeNode(child.nodeId), /INVALID_REQUEST/);
  assert.equal(probeGroup(f.state().nodes.find(n => n.nodeId === parent.nodeId).pid), 'present');
  assert.equal(probeGroup(f.state().nodes.find(n => n.nodeId === lane.nodeId).pid), 'present');
  const firstIndex = f.state().nodes[0].index;
  const sibling = f.start(b.children[1], 'nonzero'); await sibling.ready; f.submit(sibling);
  const sib = await f.finalize(sibling); f.c.join(sibling.scope, sib.ref);
  assert.equal(f.state().batches.find(x => x.batchId === b.batchId).joined, true);
  const rootIndex = f.state().nodes[0].index;
  assert.deepEqual(f.read(rootIndex).children.map(c => c.childNodeId), b.children);
  assert.equal(f.read(emptyIndex).children.length, 0); assert.equal(f.read(firstIndex).children.length, 1);
  assert.equal(f.state().budget.nodes[0].available, 5); // 9 minus parent, child, grandchild, sibling activations
  const bad = f.completion(parent); bad.acceptance[0].evidenceIds.push(gcEvidence);
  assert.throws(() => f.j.submitCompletion(parent.scope.invocationId, 'hidden-grandchild', bad), /unknown evidence/);
  const stale = f.completion(parent); stale.childReviews[0].resultHash = '0'.repeat(64);
  assert.throws(() => f.j.submitCompletion(parent.scope.invocationId, 'stale', stale), /stale review/);
  // Explicit grant of previously joined DIRECT child evidence to a new child.
  const inherited = ch.content.completion.evidence[0].reference, next = f.delegate(parent, [2], [inherited.artifactId]);
  const revised = f.start(next.children[0]); await revised.ready;
  const req = f.completion(revised); req.acceptance[0].evidenceIds.push(inherited.artifactId);
  f.j.submitCompletion(revised.scope.invocationId, 'complete', req);
  const rev = await f.finalize(revised); f.c.join(revised.scope, rev.ref);
  const page = readDelegationArtifactPage(f.j.directory, inherited, { view: 'artifact', artifactId: inherited.artifactId }, [inherited.artifactId]);
  assert.ok(Buffer.from(page.data, 'base64').toString().includes('owned evidence'));
  assert.throws(() => readDelegationArtifactPage(f.j.directory, inherited, { view: 'artifact', artifactId: inherited.artifactId }, []), /PERMISSION_DENIED/);
  f.submit(parent, 'partial'); f.submit(lane);
  const p = await f.finalize(parent), l = await f.finalize(lane);
  f.c.join(parent.scope, p.ref); f.c.join(lane.scope, l.ref); f.j.closeWorkflow();
  const results = [g, ch, sib, rev, p, l];
  assert.equal(results.reduce((sum, x) => sum + x.content.usage.totals.totalTokens, 0), 6 * 17);
  const s = f.state(); assertBudgetInvariants(s.budget); assert.equal(s.budget.spent, 6);
  assert.equal(s.budget.freeWorkflow, 4); assert.equal(s.budget.acceptedNodes, 6);
  assert.deepEqual(inspect(f).state, s); assert.equal(inspect(f).reservedBytes, 0);
});

test('forged/copied/serialized/cross-scope/cross-journal and consumed receipts denied; no new raw capability', async t => {
  const f = fixture(t, { budgets: [4, 4] }), other = fixture(t), w = f.start(), sibling = f.start(f.state().nodes[1].nodeId);
  await Promise.all([w.ready, sibling.ready]); f.submit(w); f.submit(sibling);
  w.release(); sibling.release(); await Promise.all([w.result, sibling.result]);
  const receipt = (await f.e.settleScope(w.scope)).receipt, second = (await f.e.settleScope(sibling.scope)).receipt;
  for (const bad of [{ ...receipt }, JSON.parse(JSON.stringify(receipt)), inspect(f), second, null]) {
    await assert.rejects(() => f.c.finalize(w.scope, bad), /UNAUTHORIZED/);
  }
  assert.throws(() => applyDelegationResult(f.j, { scope: w.scope, receipt, usage: { completeness: 'reported' } }, 'result'), /UNAUTHORIZED/);
  await assert.rejects(() => other.c.finalize(w.scope, receipt), /UNAUTHORIZED/);
  assert.throws(() => createDelegationResults({ journal: other.j, executor: f.e }), /UNAUTHORIZED/);
  assert.throws(() => createDelegationResults({ journal: f.j, executor: { ...f.e } }), /UNAUTHORIZED/);
  assert.throws(() => createDelegationResults({ journal: f.j, executor: f.e }), /UNAUTHORIZED/);
  f.e.consumeReceipt(sibling.scope, second);
  await assert.rejects(() => f.c.finalize(sibling.scope, second), /UNAUTHORIZED/);
  const refs = await Promise.all([f.c.finalize(w.scope, receipt), f.c.finalize(w.scope, receipt)]);
  assert.equal(refs[0], refs[1]);
  await assert.rejects(() => f.c.finalize(w.scope, { ...receipt }), /REQUEST_CONFLICT/);
  f.c.join(w.scope, refs[0]);
});

test('preabort/no child and actual payload spawn failure are charged once and joinable failures', async t => {
  for (const kind of ['preabort', 'spawn']) {
    const f = fixture(t), abort = new AbortController(); abort.abort('before child');
    const w = kind === 'preabort' ? f.start(undefined, 'clean', { signal: abort.signal }) :
      f.c.startInvocation(f.state().nodes[0].nodeId, '/definitely/absent/results-worker', [], { timeoutMs: 2000 });
    const r = await w.result;
    assert.equal(r.disposition, kind === 'preabort' ? 'no_child' : 'drained');
    const receipt = (await f.e.settleScope(w.scope)).receipt, ref = await f.c.finalize(w.scope, receipt);
    assert.equal(f.read(ref).status, kind === 'preabort' ? 'cancelled' : 'infrastructure_error');
    f.c.join(w.scope, ref); assert.equal(f.state().budget.spent, 1); assert.equal(f.state().budget.freeWorkflow, 7);
  }
});

for (const loss of ['revoke', 'dispose', 'start-hook']) test(`observed ${loss} holds unknown/live authority forever; finite self-exit never upgrades`, async t => {
  const f = fixture(t);
  const w = f.start(undefined, 'clean', loss === 'start-hook' ? { onChildStart() { throw new Error('start ambiguity'); } } : {});
  if (loss !== 'start-hook') {
    await w.ready; f.submit(w);
    assert.equal(probeGroup(f.state().nodes[0].pid), 'present');
    if (loss === 'dispose') f.j.dispose(); else f.e.revoke();
  }
  const r = await w.result; assert.equal(r.disposition, 'unknown'); assert.equal(r.receipt, null);
  await assert.rejects(() => f.c.finalize(w.scope, null), /OWNERSHIP_UNKNOWN/);
  w.release();
  assert.equal(f.state().budget.freeWorkflow, 0); assert.equal(f.state().budget.nodes[0].available, 7);
  assert.equal(inspect(f).launchAuthorized, false);
});

test('persisted unknown failure cannot be overwritten by later real clean receipt or inspection', async t => {
  const f = fixture(t), w = f.start(); await w.ready; f.submit(w);
  const old = f.j.recordFailure(w.nodeId, { status: 'infrastructure_error', summary: 'unknown ownership', cause: 'OWNERSHIP_UNKNOWN', usageCompleteness: 'missing' });
  w.release(); await w.result; const receipt = (await f.e.settleScope(w.scope)).receipt;
  await assert.rejects(() => f.c.finalize(w.scope, receipt), /REQUEST_CONFLICT/);
  assert.equal(f.state().nodes[0].result.sha256, old.sha256); assert.equal(f.state().budget.freeWorkflow, 0);
  assert.throws(() => f.j.joinUnlaunched(w.nodeId), /OWNERSHIP_UNKNOWN/);
});

test('revoke/dispose after result acknowledgement invalidates idempotent lookup and join, without extra grants', async t => {
  for (const loss of ['revoke', 'dispose']) {
    const f = fixture(t), w = f.start(); await w.ready; f.submit(w); const r = await f.finalize(w);
    if (loss === 'dispose') f.j.dispose(); else f.e.revoke();
    await assert.rejects(() => f.c.finalize(w.scope, r.receipt), /OWNERSHIP_UNKNOWN/);
    assert.throws(() => f.c.join(w.scope, r.ref), /OWNERSHIP_UNKNOWN/);
    assert.equal(inspect(f).state.budget.freeWorkflow, 0);
  }
});

test('observed revoke during result/join acknowledgement stops subsequent batch/close writes', async t => {
  for (const operation of ['result', 'join']) {
    let armed = false, executor;
    const f = fixture(t, { fault: p => { if (armed && p === 'after:event-fsync') executor.revoke(); } }); executor = f.e;
    const parent = f.start(); await parent.ready;
    const batch = f.delegate(parent, [3]), abort = new AbortController(); abort.abort('no child');
    const w = f.start(batch.children[0], 'clean', { signal: abort.signal }); await w.result;
    const receipt = (await f.e.settleScope(w.scope)).receipt;
    let ref;
    if (operation === 'join') ref = await f.c.finalize(w.scope, receipt);
    armed = true;
    if (operation === 'result') await assert.rejects(() => f.c.finalize(w.scope, receipt), /OWNERSHIP_UNKNOWN/);
    else assert.throws(() => f.c.join(w.scope, ref), /OWNERSHIP_UNKNOWN/);
    armed = false;
    const s = f.state(), child = s.nodes.find(n => n.nodeId === w.nodeId);
    assert.ok(child.result); assert.equal(child.joined, operation === 'join'); assert.equal(child.closed, false);
    assert.equal(s.batches[0].joined, false); assert.equal(s.budget.nodes[0].available, operation === 'join' ? 6 : 4);
    parent.release();
  }
});

test('changed durable candidate/result/evidence/index bytes fail integrity before another result/join', async t => {
  for (const target of ['candidate', 'result', 'evidence', 'index']) {
    const f = fixture(t), w = f.start(); await w.ready; f.submit(w); const r = await f.finalize(w);
    const ref = target === 'candidate' ? f.state().nodes[0].candidate : target === 'index' ? f.state().nodes[0].index :
      target === 'evidence' ? r.content.completion.evidence[0].reference : r.ref;
    const file = join(f.j.directory, 'nodes', `${ref.artifactId.slice(9)}.blob`);
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, '{}');
    await assert.rejects(() => f.c.finalize(w.scope, r.receipt), /integrity/);
    assert.throws(() => f.c.join(w.scope, r.ref), /integrity/);
    assert.equal(f.state().budget.freeWorkflow, 0); assert.throws(() => inspect(f), /integrity/);
  }
});

test('result artifact/event cuts consume live receipt before I/O and never replay/refund', async t => {
  let cases = 0;
  for (const cut of ['before:temporary-open', 'after:publish-link', 'after:temporary-unlink', 'before:event-fsync', 'after:event-fsync', 'before:projection-rename', 'after:projection-rename']) {
    let armed = false;
    const f = fixture(t, { fault: p => { if (armed && p === cut) throw new Error('result cut'); } });
    const abort = new AbortController(); abort.abort('no child'); const w = f.start(undefined, 'clean', { signal: abort.signal });
    await w.result; const receipt = (await f.e.settleScope(w.scope)).receipt;
    armed = true; await assert.rejects(() => f.c.finalize(w.scope, receipt), /result cut/); armed = false;
    assert.equal(f.j.snapshot().poisoned, true);
    await assert.rejects(() => f.c.finalize(w.scope, receipt), /OWNERSHIP_UNKNOWN|UNAUTHORIZED/);
    assert.throws(() => f.e.consumeReceipt(w.scope, receipt), /OWNERSHIP_UNKNOWN|UNAUTHORIZED/);
    const view = inspect(f); assert.equal(view.state.budget.spent, 1); assert.equal(view.state.budget.freeWorkflow, 0);
    assert.equal(view.launchAuthorized, false); assert.ok([3 * 4096, 4 * 4096].includes(view.reservedBytes)); cases++;
  }
  t.diagnostic(`${cases} actual filesystem fault cuts with real executor preabort/no-child; not physical power loss`);
});

test('launched child join/index/batch/close cuts reconstruct exactly one structural return, no recovery writer', async t => {
  let cases = 0;
  for (const operation of ['index', 'join', 'batch', 'close']) for (const boundary of operation === 'index' ? ['publish-link'] : ['event-fsync', 'projection-rename']) for (const edge of ['before', 'after']) {
    let armed = false, events = 0;
    const f = fixture(t, { fault: p => {
      if (!armed) return;
      if (operation === 'index' && p === `${edge}:publish-link`) throw new Error('join cut');
      if (operation !== 'index' && p === `${edge}:${boundary}` && ++events === ['join', 'batch', 'close'].indexOf(operation) + 1) throw new Error('join cut');
    } });
    const parent = f.start(); await parent.ready;
    const batch = f.delegate(parent, [3]), abort = new AbortController(); abort.abort('no child');
    const w = f.start(batch.children[0], 'clean', { signal: abort.signal }); await w.result;
    const receipt = (await f.e.settleScope(w.scope)).receipt, ref = await f.c.finalize(w.scope, receipt);
    assert.equal(f.state().budget.nodes[0].available, 4);
    armed = true; assert.throws(() => f.c.join(w.scope, ref), /join cut/); armed = false;
    assert.throws(() => f.c.join(w.scope, ref), /OWNERSHIP_UNKNOWN|UNAUTHORIZED/);
    const view = inspect(f), child = view.state.nodes.find(n => n.nodeId === w.nodeId);
    assert.equal(view.state.budget.nodes[0].available, child.joined ? 6 : 4);
    assert.equal(view.state.budget.spent, 2); assert.equal(view.state.budget.acceptedNodes, 2);
    assertBudgetInvariants(view.state.budget); assert.equal(view.launchAuthorized, false);
    assert.throws(() => createDelegationResults({ journal: view, executor: f.e }), /UNAUTHORIZED/);
    parent.release(); cases++;
  }
  t.diagnostic(`${cases} real index/result/join/batch/close filesystem cuts; parent cleanup does NOT restore authority`);
});

test('OS worker scope alone cannot finalize a parent with an unjoined child/batch', async t => {
  const f = fixture(t), parent = f.start(); await parent.ready;
  const batch = f.delegate(parent, [3]), child = f.start(batch.children[0]); await child.ready;
  parent.release(); await parent.result;
  const receipt = (await f.e.settleScope(parent.scope)).receipt;
  assert.ok(receipt); assert.equal(probeGroup(f.state().nodes.find(n => n.nodeId === child.nodeId).pid), 'present');
  await assert.rejects(() => f.c.finalize(parent.scope, receipt), /descendants not structurally settled/);
  assert.equal(f.state().nodes[0].result, null); assert.equal(f.state().budget.nodes[0].available, 4);
  assert.throws(() => f.e.consumeReceipt(parent.scope, receipt), /UNAUTHORIZED/);
  child.release();
});

test('malformed rehashed stored finals fail strict result/usage/inventory validation and cannot supply live capabilities', async t => {
  for (const mutate of [c => { c.usage.invocationId = 'other'; }, c => { c.status = 'success'; c.cause = 'caller-clean'; },
    c => { c.settlement.inventoryHash = '0'.repeat(64); }, c => { c.groupsInactive = true; }, c => { c.schema = 'unknown'; }]) {
    const f = fixture(t), w = f.start(); await w.ready; f.submit(w); const r = await f.finalize(w);
    const content = structuredClone(r.content); mutate(content);
    const bytes = Buffer.from(canonicalJSON(content)), reference = { ...r.ref, bytes: bytes.length, sha256: sha256(bytes) };
    const blob = join(f.j.directory, 'nodes', `${r.ref.artifactId.slice(9)}.blob`);
    fs.chmodSync(blob, 0o600); fs.writeFileSync(blob, bytes);
    const log = join(f.j.directory, 'events.jsonl'), events = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const last = events.at(-1); assert.equal(last.type, 'node_result'); last.payload.result = reference;
    last.payloadDigest = sha256(canonicalJSON(last.payload)); const { hash, ...body } = last; last.hash = sha256(canonicalJSON(body));
    fs.writeFileSync(log, events.map(canonicalJSON).join('\n') + '\n'); fs.unlinkSync(join(f.j.directory, 'state.json'));
    assert.throws(() => inspect(f));
    assert.throws(() => applyDelegationResult(f.j, last.payload, 'join'), /UNAUTHORIZED/);
    assert.equal(f.state().budget.freeWorkflow, 0);
  }
});

test('actual finite owner process crashes after result or join fsync: inspection only, held/returned balances exact', t => {
  for (const at of ['result', 'join']) {
    const root = fs.mkdtempSync(join(tmpdir(), 'results-owner-crash-'));
    for (const d of ['workspace', 'workspace/src', 'profile', 'artifacts']) fs.mkdirSync(join(root, d), { mode: 0o700 });
    const options = { artifactDirectory: join(root, 'artifacts'), workspace: join(root, 'workspace'), protectedDirectories: [join(root, 'profile')],
      runId: 'crash', specDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64), policy: { maxDepth: 1, totalAgentBudget: 3, directoryScope: scope, context: { objective: 'crash', constraints: [] } },
      roots: [{ phaseIndex: 0, agentBudget: 3, label: 'crash', task: 'no-child proof', permissions: 'r', directoryScope: scope, deadlineAt: null }] };
    const url = name => new URL(`../lib/${name}.mjs`, import.meta.url).href;
    const script = `import {createDelegationJournal} from ${JSON.stringify(url('delegation-journal'))};
      import {createProcessJournal} from ${JSON.stringify(url('process-journal'))};
      import {createDelegationExecutor} from ${JSON.stringify(url('delegation-executor'))};
      import {createDelegationResults} from ${JSON.stringify(url('delegation-results'))};
      let armed=false; const options=${JSON.stringify(options)};
      const j=createDelegationJournal({...options,fault:p=>{if(armed&&p==='after:event-fsync')process.exit(71)}});
      const e=createDelegationExecutor({journal:j,processJournal:createProcessJournal(options.artifactDirectory,options.runId)});
      const c=createDelegationResults({journal:j,executor:e}); const abort=new AbortController();abort.abort('preabort');
      const w=c.startInvocation(j.snapshot().state.nodes[0].nodeId,'/bin/true',[],{timeoutMs:1000,signal:abort.signal});
      await w.result;const receipt=(await e.settleScope(w.scope)).receipt;
      process.stdout.write(JSON.stringify({directory:j.directory,binding:j.binding})+'\\n');
      armed=${at === 'result'}; const result=await c.finalize(w.scope,receipt);armed=true;c.join(w.scope,result);`;
    const processResult = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: process.env, encoding: 'utf8', timeout: 8000 });
    assert.equal(processResult.status, 71, processResult.stderr);
    const binding = JSON.parse(processResult.stdout.trim()), view = inspectDelegationJournal(binding.directory, binding.binding);
    assert.equal(view.projection, 'stale'); assert.equal(view.state.budget.spent, 1);
    assert.equal(view.state.budget.freeWorkflow, at === 'join' ? 2 : 0);
    assert.equal(view.state.budget.nodes[0].available, at === 'join' ? 0 : 2);
    assert.equal(view.launchAuthorized, false); assert.equal(view.resumable, false);
    assert.throws(() => createDelegationJournal(options), /EEXIST/);
    fs.writeFileSync(join(root, 'evidence.json'), JSON.stringify({ at, binding, ownerExit: processResult.status, spawnedWorker: false }));
    t.diagnostic(`retained ${root}; actual owner exit71 after ${at} fsync, worker preabort/no-child, no cleanup signals`);
  }
});

test('late candidate after worker settlement cannot upgrade missing completion; old executor claim does not leak final writer', async t => {
  const f = fixture(t), w = f.start(); await w.ready; w.release(); await w.result;
  const receipt = (await f.e.settleScope(w.scope)).receipt;
  f.submit(w);
  await assert.rejects(() => f.c.finalize(w.scope, receipt), /candidate changed/);
  assert.equal(f.state().nodes[0].result, null); assert.equal(f.state().budget.freeWorkflow, 0);
  assert.throws(() => claimDelegationExecutor({ ...f.j }), /UNAUTHORIZED/);
  // A fresh create-only journal may claim the OLD executor recording guard,
  // but that returned object must never expose the new private result writer.
  const root = fs.mkdtempSync(join(tmpdir(), 'results-raw-'));
  for (const d of ['workspace', 'workspace/src', 'profile', 'artifacts']) fs.mkdirSync(join(root, d), { mode: 0o700 });
  const j = createDelegationJournal({ artifactDirectory: join(root, 'artifacts'), workspace: join(root, 'workspace'), protectedDirectories: [join(root, 'profile')],
    runId: 'raw', specDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64), policy: { maxDepth: 0, totalAgentBudget: 1, directoryScope: scope, context: { objective: 'raw', constraints: [] } },
    roots: [{ phaseIndex: 0, agentBudget: 1, label: 'raw', task: 'raw', permissions: 'r', directoryScope: scope, deadlineAt: null }] });
  t.after(() => j.dispose());
  assert.deepEqual(Object.keys(claimDelegationExecutor(j)).sort(), ['guard', 'onOwnerLoss', 'ownerEpoch', 'runId']);
  assert.throws(() => applyDelegationResult(j, {}, 'result'), /UNAUTHORIZED/);
});

test('terminal records retain canonical <=4096 byte slots and inventory hashes bind entire scope', async t => {
  const f = fixture(t), w = f.start(); await w.ready; f.submit(w); const r = await f.finalize(w); f.c.join(w.scope, r.ref);
  const events = fs.readFileSync(join(f.j.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const e of events.filter(e => ['node_result', 'node_joined', 'node_closed'].includes(e.type))) assert.ok(Buffer.byteLength(canonicalJSON(e)) + 1 <= 4096);
  const commands = f.state().commands.filter(c => c.scopeId === w.scope.scopeId);
  assert.equal(r.content.settlement.inventoryHash, sha256(canonicalJSON(commands)));
  assert.equal(f.j.snapshot().usedBytes, fs.statSync(join(f.j.directory, 'events.jsonl')).size);
  assert.equal(f.j.snapshot().reservedBytes, 4096);
});

// RJ2: invalid source envelopes cannot disappear behind the permissive M1
// classifier. These are real worker pipe records, not supplied final totals.
test('RJ2 malformed/unsupported envelopes before/after/no source fail durably; later valid source survives', async t => {
  for (let shape = 0; shape < 11; shape++) for (const position of ['before', 'after', 'only']) {
    const f = fixture(t), w = f.start(undefined, `repair-envelope-${shape}-${position}`);
    await w.ready; f.submit(w); const r = await f.finalize(w);
    assert.equal(r.content.status, 'infrastructure_error'); assert.equal(r.content.cause, 'SOURCE_PROTOCOL');
    assert.equal(r.content.usage.totals.totalTokens, position === 'only' ? 0 : 7);
    assert.equal(r.content.usage.completeness, position === 'only' ? 'missing' : 'partial');
    f.c.join(w.scope, r.ref); assert.deepEqual(inspect(f).state, f.state());
    assert.equal(f.state().budget.spent, 1); assert.equal(f.state().budget.freeWorkflow, 7);
  }
});

test('RJ2 actual Pi base and extended non-accounting roles remain supported, never display/user/final usage', async t => {
  const f = fixture(t), w = f.start(undefined, 'repair-roles'); await w.ready; f.submit(w);
  const r = await f.finalize(w);
  assert.equal(r.content.status, 'success'); assert.equal(r.content.usage.totals.totalTokens, 7);
  assert.equal(r.content.usage.counters.ignoredTool, 1); assert.equal(r.content.usage.completeness, 'reported');
  f.c.join(w.scope, r.ref); assert.deepEqual(inspect(f).state, f.state());
});

for (const stream of ['stdout', 'stderr']) for (const capture of ['full', 'none', 'truncated'])
  test(`RJ1 ${stream} display failure: TERM source survives with ${capture} capture and split UTF8`, async t => {
    const f = fixture(t), calls = { stdout: 0, stderr: 0 }; let atFailure;
    const observe = which => chunk => {
      calls[which]++;
      if (which === stream && chunk.includes('display-trigger')) {
        atFailure = { ...calls }; throw new Error('optional display failed');
      }
    };
    const w = f.start(undefined, `repair-callback-${stream}`, {
      onStdout: observe('stdout'), onStderr: observe('stderr'),
      ...(capture === 'none' ? { captureStdout: false } : capture === 'truncated' ? { maxStdoutBytes: 64 } : {}),
    });
    await w.ready; f.submit(w); const outcome = await w.result;
    assert.equal(outcome.classification, 'callback_error'); assert.equal(outcome.disposition, 'drained');
    assert.deepEqual(calls, atFailure, 'legacy optional callbacks BOTH stay suppressed');
    const receipt = (await f.e.settleScope(w.scope)).receipt, ref = await f.c.finalize(w.scope, receipt), content = f.read(ref);
    assert.equal(content.status, 'infrastructure_error'); assert.equal(content.cause, 'CALLBACK_ERROR');
    assert.equal(content.usage.totals.totalTokens, 14); assert.equal(content.usage.counters.assistant, 2);
    assert.equal(content.usage.completeness, 'reported'); assert.equal(content.usage.problem, null);
    if (capture === 'full') {
      assert.match(outcome.stdout, /split-😀-tail/u); assert.doesNotMatch(outcome.stdout, /\uFFFD/u);
      const actual = invocationUsage(w.scope.invocationId); actual.push(outcome.stdout);
      assert.deepEqual(content.usage, actual.finish(), 'evidence comparison only, never production capture replay');
    } else if (capture === 'none') assert.equal(outcome.stdout, '');
    else assert.equal(outcome.stdoutTruncated, true);
    assert.ok(content.usage.streamBytes > 64);
    f.c.join(w.scope, ref); const before = f.j.snapshot();
    assert.equal(await f.c.finalize(w.scope, receipt), ref); f.c.join(w.scope, ref);
    assert.deepEqual(f.j.snapshot(), before); assert.deepEqual(inspect(f).state, f.state());
  });

for (const when of ['first', 'later']) test(`RJ1 authoritative parser throws ${when}: delivered prefix retained, explicitly incomplete, original receipt finalizes`, async t => {
  const push = PiJsonEventCollector.prototype.push;
  t.mock.method(PiJsonEventCollector.prototype, 'push', function (chunk) {
    if (when === 'first' || chunk.includes('tap-failure')) throw new Error('injected source parser failure');
    return push.call(this, chunk);
  });
  const f = fixture(t), w = f.start(undefined, 'repair-callback-tap'); f.submit(w);
  const outcome = await w.result;
  assert.equal(outcome.classification, 'callback_error'); assert.equal(outcome.disposition, 'drained');
  const receipt = (await f.e.settleScope(w.scope)).receipt, ref = await f.c.finalize(w.scope, receipt), content = f.read(ref);
  assert.equal(content.status, 'infrastructure_error'); assert.equal(content.cause, 'SOURCE_PROTOCOL');
  assert.equal(content.usage.totals.totalTokens, when === 'first' ? 0 : 7);
  assert.equal(content.usage.completeness, when === 'first' ? 'missing' : 'partial');
  assert.match(outcome.stdout, /split-😀-tail/u, 'later source actually delivered, but failed tap cannot claim it');
  f.c.join(w.scope, ref); assert.deepEqual(inspect(f).state, f.state());
});

test('RJ1 parser finish failure retains usage and publishes protocol failure, not a stranded receipt', async t => {
  t.mock.method(PiJsonEventCollector.prototype, 'finish', () => { throw new Error('parser flush failure'); });
  const f = fixture(t), w = f.start(); await w.ready; f.submit(w); const r = await f.finalize(w);
  assert.equal(r.content.status, 'infrastructure_error'); assert.equal(r.content.usage.problem, 'SOURCE_PROTOCOL');
  assert.equal(r.content.usage.totals.totalTokens, 17); assert.equal(r.content.usage.completeness, 'partial');
  f.c.join(w.scope, r.ref); assert.deepEqual(inspect(f).state, f.state());
});

test('RJ1 premature stdout closure retains prior usage, fails nonclean and closes before finalization', async t => {
  let child;
  const f = fixture(t), w = f.start(undefined, 'repair-callback-stdout', { onChildStart(c) { child = c; } });
  await w.ready; f.submit(w); child.stdout.destroy(); // positively owned reader, no operational signal
  const outcome = await w.result;
  assert.equal(child.stdout.closed, true); assert.equal(outcome.classification, 'callback_error');
  const receipt = (await f.e.settleScope(w.scope)).receipt, ref = await f.c.finalize(w.scope, receipt), content = f.read(ref);
  assert.equal(content.status, 'infrastructure_error'); assert.equal(content.usage.problem, 'SOURCE_PROTOCOL');
  assert.equal(content.usage.completeness, 'partial'); assert.equal(content.usage.totals.totalTokens, 7);
  f.c.join(w.scope, ref); assert.deepEqual(inspect(f).state, f.state());
});

test('RJ3 diagnostic rejection never loses independent valid source or strands the original receipt', async t => {
  for (const diagnostic of ['large', 'utf8', 'space', 'nul', 'surrogate']) for (const position of ['first', 'prior', 'later', 'missing']) {
    const f = fixture(t), w = f.start(undefined, `repair-diagnostic-${diagnostic}-${position}`);
    await w.ready; f.submit(w); const r = await f.finalize(w), u = r.content.usage;
    assert.equal(r.content.status, 'infrastructure_error'); assert.equal(r.content.cause, 'SOURCE_PROTOCOL');
    assert.equal(u.completeness, position === 'missing' ? 'missing' : 'partial');
    assert.equal(u.totals.totalTokens, position === 'missing' ? 0 : position === 'first' ? 7 : 14);
    assert.equal(u.counters.compaction, 1); assert.equal(u.counters.missing, Number(position === 'missing')); assert.equal(u.counters.partial, 1);
    assert.equal(u.diagnostic, null, 'reject, do not silently truncate into a valid diagnostic');
    assert.ok(Buffer.byteLength(canonicalJSON(u)) < 1024);
    f.c.join(w.scope, r.ref); const before = f.j.snapshot();
    assert.equal(await f.c.finalize(w.scope, r.receipt), r.ref); f.c.join(w.scope, r.ref);
    assert.deepEqual(f.j.snapshot(), before); assert.deepEqual(inspect(f).state, f.state());
    assert.throws(() => f.e.consumeReceipt(w.scope, r.receipt), /UNAUTHORIZED/);
  }
});

test('RJ1 trusted source hook cannot enter ordinary executor command options', async t => {
  const f = fixture(t), declared = f.e.openDeclaredShell();
  for (const key of ['stdoutSource', 'sourceFactory', 'lifecycle']) {
    assert.throws(() => f.e.runShell(declared, 1, '/bin/true', [], { timeoutMs: 1000, [key]: {} }), /INVALID_REQUEST/);
  }
  assert.equal(f.e.inspect().acceptedCommands, 0);
  const receipt = (await f.e.settleScope(declared)).receipt;
  await assert.rejects(() => f.c.finalize(declared, receipt), /UNAUTHORIZED/);
  assert.equal(f.state().budget.spent, 0);
});

test('callback lifetime: late stdout/stderr/end evidence is separate from immutable command/source and rejects forged seals', async t => {
  for (const [hook, bit] of [['onStdout', 2], ['onStderr', 4], ['onChildEnd', 8]]) {
    const f = fixture(t); let reject, delivered = '';
    const deferred = new Promise((_, r) => { reject = r; });
    const source = JSON.stringify({ type: 'turn_start' }) + '\n' + JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: {
      input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } } }) + '\n';
    const w = f.c.startInvocation(f.state().nodes[0].nodeId, process.execPath,
      ['-e', `process.stdout.write(${JSON.stringify(source)});process.stderr.write('err');`], { timeoutMs: 2000,
        onChildStart(p) { p.stdout.on('data', chunk => { delivered += chunk; }); }, [hook]() { return deferred; } });
    f.promises.push(w.result);
    const physical = await w.result; assert.equal(physical.classification, 'clean');
    const command = structuredClone(f.state().commands[0]);
    assert.throws(() => applyObserverSeal(f.j, { scopeId: w.scope.scopeId, failures: [bit] }), /UNAUTHORIZED/);
    reject(Error('actual opted callback rejection after acknowledgement')); await pause(0);
    assert.deepEqual(f.state().commands[0], command);
    const settled = await f.e.settleScope(w.scope); assert.equal(settled.ok, false);
    const ref = await f.c.finalize(w.scope, settled.receipt), content = f.read(ref);
    assert.equal(content.cause, 'CALLBACK_ERROR'); assert.deepEqual(content.callbackFailures, [bit]);
    assert.equal(content.usage.problem, null); assert.equal(content.usage.diagnostic, null);
    assert.equal(content.usage.streamBytes, Buffer.byteLength(delivered)); assert.equal(content.usage.streamHash, sha256(delivered));
    assert.equal(content.usage.totals.totalTokens, 7); assert.equal(content.usage.completeness, 'reported');
    f.c.join(w.scope, ref); const before = f.j.snapshot();
    assert.equal(await f.c.finalize(w.scope, settled.receipt), ref); f.c.join(w.scope, ref);
    assert.deepEqual(f.j.snapshot(), before); assert.deepEqual(f.state().commands[0], command);
    const view = inspect(f), events = fs.readFileSync(join(f.j.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    let state = initialState(view.manifest);
    for (const event of events) {
      if (event.type === 'scope_observers_sealed') {
        for (const failures of [[], [1], [15], ['2'], [16], [bit, 0]])
          assert.throws(() => reduceEvent(state, { ...event, payload: { ...event.payload, failures } }, view.manifest));
        const sealed = reduceEvent(state, event, view.manifest);
        assert.throws(() => reduceEvent(sealed, { ...event, sequence: sealed.sequence + 1 }, view.manifest), /OWNERSHIP_UNKNOWN/);
        assert.equal(Buffer.byteLength(canonicalJSON(event)) < 4096, true);
      }
      state = reduceEvent(state, event, view.manifest);
    }
    assert.deepEqual(state, view.state);
  }
});

test('callback lifetime: finite end expiry seals immutable evidence before receipt/finalize/join; later rejection is inert', async t => {
  const f = fixture(t); let reject;
  const deferred = new Promise((_, r) => { reject = r; });
  const w = f.start(undefined, 'clean', { onChildEnd() { return deferred; } });
  await w.ready; f.submit(w); w.release();
  assert.equal((await w.result).classification, 'clean');
  const settled = await f.e.settleScope(w.scope);
  assert.deepEqual(settled.receipt.callbackFailures, [8]); assert.equal(settled.ok, false);
  const pending = f.c.finalize(w.scope, settled.receipt);
  reject(Error('after seal, during finalize await')); await Promise.resolve();
  const ref = await pending; assert.equal(f.read(ref).cause, 'CALLBACK_ERROR');
  const beforeJoin = f.read(ref); f.c.join(w.scope, ref);
  assert.deepEqual(f.read(ref), beforeJoin); assert.equal(await f.c.finalize(w.scope, settled.receipt), ref);
  assert.equal(f.state().budget.freeWorkflow, 7); assert.deepEqual(inspect(f).state, f.state());
});

test('CL1 consumed original authority must survive event preparation before any new publication', async t => {
  for (const type of ['node_result', 'node_joined', 'node_closed']) {
    const f = fixture(t), w = f.start(); await w.ready; f.submit(w);
    w.release(); await w.result;
    const receipt = (await f.e.settleScope(w.scope)).receipt;
    const ref = type === 'node_result' ? null : await f.c.finalize(w.scope, receipt);
    let before, files;
    const stringify = JSON.stringify;
    JSON.stringify = function(value, ...args) {
      if (!before && value === type) {
        before = f.state(); files = fs.readdirSync(join(f.j.directory, 'nodes')).sort();
        f.e.revoke(); // Observed synchronously during encoding, BEFORE disk mutation.
      }
      return stringify(value, ...args);
    };
    try {
      if (ref) assert.throws(() => f.c.join(w.scope, ref), /OWNERSHIP_UNKNOWN/);
      else await assert.rejects(f.c.finalize(w.scope, receipt), /OWNERSHIP_UNKNOWN/);
    } finally { JSON.stringify = stringify; }
    assert.ok(before); assert.deepEqual(f.state(), before); assert.deepEqual(inspect(f).state, before);
    assert.deepEqual(fs.readdirSync(join(f.j.directory, 'nodes')).sort(), files);
    await assert.rejects(f.c.finalize(w.scope, receipt), /OWNERSHIP_UNKNOWN|UNAUTHORIZED/);
  }
});

test('RJ3 token/cost aggregate overflow retains representable prefix AND independent bounded diagnostic', async t => {
  for (const field of ['tokens', 'cost']) {
    const f = fixture(t), w = f.start(undefined, `repair-overflow-${field}`); await w.ready; f.submit(w);
    const r = await f.finalize(w), u = r.content.usage;
    assert.equal(r.content.status, 'infrastructure_error'); assert.equal(r.content.cause, 'USAGE_LIMIT');
    assert.equal(u.completeness, 'partial'); assert.equal(u.counters.assistant, 1); assert.equal(u.counters.compaction, 1);
    assert.equal(u.counters.missing, 0); assert.equal(u.diagnostic.errorMessage, 'bounded failure');
    assert.equal(u.totals.totalTokens, field === 'tokens' ? Number.MAX_SAFE_INTEGER : 7);
    assert.equal(u.totals.cost.total, field === 'cost' ? Number.MAX_VALUE : 0);
    f.c.join(w.scope, r.ref); assert.deepEqual(inspect(f).state, f.state());
  }
});
