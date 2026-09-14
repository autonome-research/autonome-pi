import test from 'node:test';
import assert from 'node:assert/strict';
import { VERSIONS, validateVersion, validateDelegationPolicy, validateRootAllocations,
  validateDelegationRequest, validateCompletionRequest, validateContextRequest, validateNodeResult } from '../lib/delegation-contract.mjs';

const scope = { read: ['src'], write: [] };
const policy = () => ({ maxDepth: 4, totalAgentBudget: 128, directoryScope: scope, context: { objective: 'Review', constraints: ['Do not write'] } });
const assignment = { task: 'Inspect', acceptance: [{ id: 'a', criterion: 'Cite evidence' }] };
const child = () => ({ label: 'child', ...assignment, agentBudget: 1, permissions: 'r', directoryScope: scope });
const request = () => ({ directoryRevision: 0, children: [child()] });
const completion = () => ({ status: 'success', summary: 'done', acceptance: [{ id: 'a', outcome: 'passed', evidenceIds: ['local:report'] }],
  evidence: [{ label: 'report', path: 'src/report.txt', description: 'report' }], childReviews: [], remainingWork: [] });
const authority = () => ({ assignment, joinedChildren: [], visibleArtifactIds: [] });

test('strict required typed policy limits and exact version dispatch; no historical upgrade', () => {
  assert.deepEqual(validateDelegationPolicy(policy()), policy());
  for (const field of ['maxDepth', 'totalAgentBudget']) {
    for (const value of [undefined, null, true, '1', -1, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
      assert.throws(() => validateDelegationPolicy({ ...policy(), [field]: value }));
    }
    const missing = policy(); delete missing[field]; assert.throws(() => validateDelegationPolicy(missing));
  }
  assert.throws(() => validateDelegationPolicy({ ...policy(), maxDepth: 5 }));
  assert.throws(() => validateDelegationPolicy({ ...policy(), totalAgentBudget: 0 }));
  assert.throws(() => validateDelegationPolicy({ ...policy(), totalAgentBudget: 129 }));
  for (const key of ['owner', 'schema', 'retry', 'model', 'background']) assert.throws(() => validateDelegationPolicy({ ...policy(), [key]: 'x' }));
  for (const version of ['pi-dynamic-workflow/v1', 'pi-dynamic-workflow/v2', 'pi-dynamic-workflow/v3', undefined, 'pi-workflow-delegation-policy/v2']) {
    assert.throws(() => validateVersion(version, VERSIONS.policy), /UNSUPPORTED_VERSION/);
    assert.throws(() => validateDelegationPolicy({ ...policy(), schema: version }));
  }
  validateVersion(VERSIONS.policy, VERSIONS.policy);
  assert.throws(() => validateDelegationPolicy(Object.assign(Object.create(null), policy())));
  assert.throws(() => validateDelegationPolicy({ ...policy(), [Symbol('authority')]: 1 }));
});

test('UTF-8 bounds, malformed Unicode, sparse arrays and nested unknown keys', () => {
  const p = policy(); p.context.objective = '😀'.repeat(512); validateDelegationPolicy(p);
  p.context.objective += 'a'; assert.throws(() => validateDelegationPolicy(p));
  p.context.objective = '\ud800'; assert.throws(() => validateDelegationPolicy(p));
  for (const constraints of [new Array(1), Array(9).fill('x'), [true], ['x'.repeat(257)]]) assert.throws(() => validateDelegationPolicy({ ...policy(), context: { objective: 'x', constraints } }));
  assert.throws(() => validateDelegationPolicy({ ...policy(), context: { objective: 'x', constraints: [], owner: 'forged' } }));
  const r = request(); r.children[0].task = '😀'.repeat(1024); validateDelegationRequest(r);
  r.children[0].task += 'x'; assert.throws(() => validateDelegationRequest(r));
});

test('whole-workflow static enumeration, fixed root quotas, zero depth, duplicate labels', () => {
  const roots = validateRootAllocations(policy(), [{ phaseIndex: 2, agentBudget: 2 }, { phaseIndex: 0, agentBudget: 3, items: ['same', 'same'] }]);
  assert.deepEqual(roots.map(r => [r.phaseIndex, r.itemIndex, r.agentBudget]), [[0, 0, 3], [0, 1, 3], [2, undefined, 2]]);
  assert.equal(validateRootAllocations(policy(), [{ phaseIndex: 0, agentBudget: 1, items: Array(128).fill('same') }]).length, 128);
  const zero = { ...policy(), maxDepth: 0 };
  assert.equal(validateRootAllocations(zero, Array.from({ length: 128 }, (_, phaseIndex) => ({ phaseIndex, agentBudget: 1 }))).length, 128);
  for (const groups of [[], [{ phaseIndex: 0, agentBudget: 2 }], [{ phaseIndex: 0, agentBudget: 1, items: [] }]]) assert.throws(() => validateRootAllocations(zero, groups));
  for (const groups of [[{ phaseIndex: 0, agentBudget: 128, items: ['a', 'b'] }], [{ phaseIndex: 0, agentBudget: 1, items: Array(129).fill('x') }],
    [{ phaseIndex: 0, agentBudget: 1 }, { phaseIndex: 0, agentBudget: 1 }], [{ phaseIndex: 0, agentBudget: 1, itemsFrom: 'x' }],
    [{ phaseIndex: 0, agentBudget: 1, directoryScope: { read: ['src-other'], write: [] } }]]) assert.throws(() => validateRootAllocations(policy(), groups));
});

test('worker requests reject identity, retry, expansion fields; bounded batch and context variants', () => {
  for (const key of ['runId', 'rootRunId', 'owner', 'capability', 'budgetScopeId', 'depth', 'model', 'after', 'resumeRunId', 'background', 'attempts', 'retry']) {
    assert.throws(() => validateDelegationRequest({ ...request(), [key]: 'x' }));
    assert.throws(() => validateDelegationRequest({ directoryRevision: 0, children: [{ ...child(), [key]: 'x' }] }));
  }
  for (const value of [0, '1', null, 3_600_001]) assert.throws(() => validateDelegationRequest({ directoryRevision: 0, children: [{ ...child(), timeoutMs: value }] }));
  validateDelegationRequest({ directoryRevision: Number.MAX_SAFE_INTEGER, children: Array.from({ length: 4 }, () => ({ ...child(), timeoutMs: 3_600_000 })) });
  assert.throws(() => validateDelegationRequest({ directoryRevision: 0, children: Array.from({ length: 5 }, child) }));
  validateContextRequest({ view: 'directory' }); validateContextRequest({ view: 'artifact', artifactId: 'artifact:a', offsetBytes: 0, limitBytes: 8192 });
  for (const value of [{ view: 'directory', root: 'other' }, { view: 'artifact', artifactId: '/tmp/a' }, { view: 'artifact', artifactId: 'artifact:a', limitBytes: 8193 }, { view: 'artifact', artifactId: 'artifact:a', offsetBytes: -1 }]) assert.throws(() => validateContextRequest(value));
});

test('completion exact criteria, evidence namespaces, complete current reviews and meaningful maximum', () => {
  validateCompletionRequest(completion(), authority());
  const joinedChildren = Array.from({ length: 127 }, (_, i) => ({ childNodeId: `n${i}`, resultHash: 'a'.repeat(64) }));
  const c = completion(); c.childReviews = joinedChildren.map(r => ({ ...r, decision: 'rejected', reason: 'r'.repeat(128) }));
  c.acceptance = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, outcome: 'passed', evidenceIds: ['local:report'] }));
  const a = { ...authority(), joinedChildren, assignment: { task: 'x', acceptance: c.acceptance.map(r => ({ id: r.id, criterion: 'c'.repeat(512) })) } };
  validateCompletionRequest(c, a);
  assert.throws(() => validateCompletionRequest({ ...c, childReviews: c.childReviews.slice(1) }, a), /missing review/);
  const stale = structuredClone(c); stale.childReviews[0].resultHash = 'b'.repeat(64); assert.throws(() => validateCompletionRequest(stale, a), /stale review/);
  const duplicate = structuredClone(c); duplicate.childReviews[1] = duplicate.childReviews[0]; assert.throws(() => validateCompletionRequest(duplicate, a));
  for (const mutate of [c => c.acceptance[0].id = 'other', c => c.acceptance[0].outcome = 'unverified', c => c.acceptance[0].evidenceIds = ['report'],
    c => c.evidence.push(c.evidence[0]), c => c.evidence[0].path = '../escape', c => c.owner = 'forged']) {
    const bad = completion(); mutate(bad); assert.throws(() => validateCompletionRequest(bad, authority()));
  }
  const escaped = structuredClone(c); escaped.summary = 'x' + '\n'.repeat(4095); escaped.childReviews.forEach(r => r.reason = 'x' + '\n'.repeat(127));
  assert.throws(() => validateCompletionRequest(escaped, a), /serialized bytes/);
});

test('node results carry exact versions, explicit execution statuses and references, not inferred success', () => {
  const r = { schema: VERSIONS.result, childNodeId: 'c', status: 'timeout', summary: 'agent claimed success', resultHash: 'a'.repeat(64), resultArtifactId: 'artifact:r' };
  assert.equal(validateNodeResult(r).status, 'timeout');
  for (const change of [{ schema: 'v2' }, { status: 'joined' }, { resultHash: 'bad' }, { resultArtifactId: '../file' }, { usage: {} }]) assert.throws(() => validateNodeResult({ ...r, ...change }));
});
