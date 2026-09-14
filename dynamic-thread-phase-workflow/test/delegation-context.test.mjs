import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { VERSIONS, validateCompletionRequest } from '../lib/delegation-contract.mjs';
import { clipPreview, validateContextRevision, selectDirectoryEntries, buildOwnChildJoinIndex,
  projectArtifactRead, projectDelegationResults, buildDelegationContext } from '../lib/delegation-context.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const result = i => ({ schema: VERSIONS.result, childNodeId: `c${i}`, status: i % 2 ? 'failed' : 'success', summary: `child ${i}`, resultHash: sha(`result ${i}`), resultArtifactId: `artifact:result${i}` });
const root = () => ({ nodeId: 'r', treeRootNodeId: 'r', phaseIndex: 0, depth: 0, label: 'root', state: 'running', task: 'Inspect', scopePreview: 'read src', createdSequence: 0 });
function fixture(count = 0) {
  const children = Array.from({ length: count }, (_, i) => ({ nodeId: `c${i}`, parentNodeId: 'r', treeRootNodeId: 'r', phaseIndex: 0,
    depth: 1, label: `child ${i}`, state: 'joined', task: `private child assignment ${i}`, scopePreview: 'read src', createdSequence: i + 1,
    resultArtifactId: result(i).resultArtifactId, resultStatus: result(i).status }));
  const index = buildOwnChildJoinIndex({ artifactId: `artifact:index${count}`, ownerNodeId: 'r', revision: count, children: Array.from({ length: count }, (_, i) => result(i)) });
  return { index, input: { runId: 'run', budgetScopeId: 'budget', directoryRevision: count, asOfEventSequence: count,
    workflowContext: { objective: 'Review everything', constraints: ['Never modify files'] },
    self: { nodeId: 'r', treeRootNodeId: 'r', depth: 0, state: 'running', label: 'root', grantedPermissions: 'r', grantedTools: ['read', 'grep'],
      directoryScope: { read: ['src'], write: [] }, agentBudget: 128, spent: count + 1, available: 127 - count, reservedForChildren: 0 },
    assignment: { task: 'Inspect', acceptance: [{ id: 'assignment', criterion: 'Cite evidence' }], parentContextSummary: 'Advisory only' },
    ancestors: [], nodes: [root(), ...children], evidence: [], inheritedArtifactIds: [], ownChildJoinIndex: index.reference } };
}

test('deterministic Unicode-safe preview clipping; strict revisions', () => {
  assert.equal(clipPreview('A😀éB', 6), 'A😀'); assert.equal(clipPreview('😀', 3), '');
  assert.equal(clipPreview('A😀éB', 8), 'A😀éB');
  assert.throws(() => clipPreview('\ud800', 2));
  assert.equal(validateContextRevision(7, 7), 7);
  for (const revision of [6, 8]) assert.throws(() => validateContextRevision(revision, 7), /STALE_CONTEXT/);
  for (const revision of ['7', -1, NaN]) assert.throws(() => validateContextRevision(revision, 7), /INVALID/);
});

test('128-node bounded directory: stable priority, truthful versions/statuses and omitted counts', () => {
  const { input } = fixture(127);
  input.nodes.forEach(n => { n.task = '😀'.repeat(1024); n.scopePreview = 'x'.repeat(4096); });
  input.assignment.task = input.nodes[0].task;
  const first = buildDelegationContext(input); const second = buildDelegationContext(input);
  assert.deepEqual(first, second); assert.equal(first.schema, VERSIONS.context);
  assert.equal(first.directory[0].nodeId, 'r'); assert.ok(first.directory.length <= 32);
  assert.ok(Buffer.byteLength(JSON.stringify(first.directory)) <= 8192);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 24 * 1024);
  assert.equal(first.omitted.directoryEntries + first.directory.length, 128);
  assert.equal(first.omitted.directoryStates.joined, first.omitted.directoryEntries);
  for (const d of first.directory) { assert.ok(Buffer.byteLength(d.assignmentPreview) <= 160); assert.ok(!Object.hasOwn(d, 'task')); }
  assert.equal(first.directory.find(d => d.nodeId === 'c1').resultStatus, 'failed');
  assert.deepEqual(first.workflowContext, input.workflowContext);
  const reversed = { ...input, nodes: [...input.nodes].reverse() };
  assert.deepEqual(buildDelegationContext(reversed), first);
});

test('compaction recovery with 127 joined children through mandatory pinned index and bounded byte reader', () => {
  const { input, index } = fixture(127);
  const snapshot = buildDelegationContext(input);
  assert.ok(snapshot.omitted.directoryEntries > 0); assert.equal(snapshot.visibleEvidence.length, 0);
  assert.deepEqual(snapshot.ownChildJoinIndex, index.reference);
  const chunks = []; let offsetBytes = 0;
  do {
    const page = projectArtifactRead(snapshot.ownChildJoinIndex, index.content,
      { view: 'artifact', artifactId: index.reference.artifactId, offsetBytes, limitBytes: 211 }, [index.reference.artifactId]);
    chunks.push(Buffer.from(page.data, 'base64')); assert.ok(page.endOffsetBytes - offsetBytes <= 211);
    offsetBytes = page.endOffsetBytes;
    assert.equal(page.truncated, offsetBytes < index.reference.bytes);
  } while (offsetBytes < index.reference.bytes);
  const recovered = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(recovered.schema, VERSIONS.joinIndex); assert.equal(recovered.children.length, 127);
  assert.deepEqual(recovered.children[126], { childNodeId: 'c126', resultHash: result(126).resultHash, status: 'success', resultArtifactId: 'artifact:result126' });
  validateCompletionRequest({ status: 'partial', summary: 'Reviewed successes and failures', acceptance: [{ id: 'assignment', outcome: 'unverified', evidenceIds: [] }],
    evidence: [], childReviews: recovered.children.map(c => ({ childNodeId: c.childNodeId, resultHash: c.resultHash, decision: 'accepted', reason: 'considered' })), remainingWork: ['Resolve failed children'] },
  { assignment: input.assignment, joinedChildren: recovered.children, visibleArtifactIds: [] });
  const empty = fixture(); assert.equal(buildDelegationContext(empty.input).ownChildJoinIndex.childCount, 0);
  assert.notEqual(empty.index.reference.artifactId, index.reference.artifactId); assert.equal(empty.index.index.children.length, 0);
  const bad = structuredClone(input); delete bad.ownChildJoinIndex; assert.throws(() => buildDelegationContext(bad));
  assert.throws(() => buildDelegationContext({ ...input, ownChildJoinIndex: empty.index.reference }), /join index count/);
});

test('artifact visibility, integrity, EOF boundaries and arbitrary UTF-8 byte offsets', () => {
  const content = 'A😀B'; const reference = { artifactId: 'artifact:unicode', bytes: Buffer.byteLength(content), sha256: sha(content) };
  const request = { view: 'artifact', artifactId: reference.artifactId, offsetBytes: 2, limitBytes: 2 };
  const page = projectArtifactRead(reference, content, request, [reference.artifactId]);
  assert.deepEqual(Buffer.from(page.data, 'base64'), Buffer.from(content).subarray(2, 4));
  assert.throws(() => projectArtifactRead(reference, content, request, []), /PERMISSION/);
  assert.throws(() => projectArtifactRead(reference, 'changed', request, [reference.artifactId]), /integrity/);
  assert.throws(() => projectArtifactRead(reference, content, { ...request, offsetBytes: 7 }, [reference.artifactId]));
  const eof = projectArtifactRead(reference, content, { ...request, offsetBytes: 6 }, [reference.artifactId]);
  assert.equal(eof.data, ''); assert.equal(eof.truncated, false);
});

test('hidden evidence stays hidden; only direct joined child, own or explicitly inherited references', () => {
  const { input } = fixture(1);
  input.evidence = Array.from({ length: 40 }, (_, i) => ({ artifactId: `artifact:e${String(i).padStart(2, '0')}`, ownerNodeId: 'c0', bytes: 1, sha256: sha('x'), preview: '😀'.repeat(1024) }));
  input.evidence.push({ artifactId: 'artifact:hidden', ownerNodeId: 'other', bytes: 1, sha256: sha('x'), preview: 'SECRET' });
  const snapshot = buildDelegationContext(input);
  assert.equal(snapshot.visibleEvidence.length, 32); assert.equal(snapshot.omitted.evidenceEntries, 8);
  assert.ok(!JSON.stringify(snapshot).includes('SECRET')); assert.ok(snapshot.visibleEvidence.every(e => Buffer.byteLength(e.preview) <= 160));
  const inherited = { ...input, evidence: input.evidence.slice(-1), inheritedArtifactIds: ['artifact:hidden'] };
  assert.equal(buildDelegationContext(inherited).visibleEvidence[0].artifactId, 'artifact:hidden');
});

test('full hierarchy, immutable workflow constraints, required overflow is rejected rather than trimmed', () => {
  const { input } = fixture();
  for (let depth = 1; depth <= 4; depth++) input.nodes.push({ ...root(), nodeId: `d${depth}`, parentNodeId: depth === 1 ? 'r' : `d${depth - 1}`, depth, createdSequence: depth, label: `depth ${depth}` });
  input.asOfEventSequence = 4;
  input.self = { ...input.self, nodeId: 'd4', parentNodeId: 'd3', depth: 4, label: 'depth 4' };
  input.ancestors = input.nodes.slice(0, 4).map(n => ({ nodeId: n.nodeId, label: n.label, constraintsSummary: 'Advisory constraints' }));
  input.ownChildJoinIndex = buildOwnChildJoinIndex({ artifactId: 'artifact:d4index', ownerNodeId: 'd4', revision: 0, children: [] }).reference;
  const context = buildDelegationContext(input);
  assert.equal(context.ancestors.length, 4); assert.deepEqual(context.workflowContext.constraints, ['Never modify files']);
  assert.equal(context.directory[0].nodeId, 'd4');
  assert.throws(() => buildDelegationContext({ ...input, ancestors: [] }));
  const bad = structuredClone(input); bad.nodes[4].parentNodeId = 'd4'; assert.throws(() => buildDelegationContext(bad), /hierarchy/);
  const maximal = structuredClone(input);
  maximal.workflowContext = { objective: 'o'.repeat(2048), constraints: Array(8).fill('c'.repeat(256)) };
  maximal.assignment = { task: 't'.repeat(4096), parentContextSummary: 's'.repeat(2048), acceptance: Array.from({ length: 8 }, (_, i) => ({ id: `${i}${'i'.repeat(63)}`, criterion: 'a'.repeat(512) })) };
  maximal.nodes[4].task = maximal.assignment.task;
  maximal.ancestors.forEach(a => { a.constraintsSummary = 's'.repeat(512); });
  maximal.self.grantedPermissions = 'rw';
  maximal.self.directoryScope = { read: Array.from({ length: 8 }, (_, i) => `r${i}${'x'.repeat(254)}`), write: Array.from({ length: 8 }, (_, i) => `w${i}${'x'.repeat(254)}`) };
  const bounded = buildDelegationContext(maximal);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 24 * 1024);
  assert.deepEqual(bounded.assignment, maximal.assignment); assert.deepEqual(bounded.self.directoryScope, maximal.self.directoryScope);
  const escaped = n => 'a' + '\n'.repeat(n - 1);
  input.workflowContext = { objective: escaped(2048), constraints: Array(8).fill(escaped(256)) };
  input.assignment = { task: escaped(4096), parentContextSummary: escaped(2048), acceptance: Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, criterion: escaped(512) })) };
  input.nodes[4].task = input.assignment.task;
  input.ancestors.forEach(a => { a.constraintsSummary = escaped(512); });
  assert.throws(() => buildDelegationContext(input), /CONTEXT_LIMIT/);
});

test('joined result projection preserves failure status/reference and only clips display summaries', () => {
  const results = Array.from({ length: 4 }, (_, i) => ({ ...result(i), summary: '😀'.repeat(1024) }));
  const projection = projectDelegationResults(results);
  assert.equal(projection.status, 'joined'); assert.equal(projection.results[1].status, 'failed');
  assert.equal(projection.results[1].resultHash, results[1].resultHash);
  assert.equal(Buffer.byteLength(projection.results[1].summary), 2048); assert.equal(projection.results[1].summaryTruncated, true);
  assert.ok(!Object.hasOwn(projection, 'usage')); assert.ok(!Object.hasOwn(projection, 'schema')); // Not a transport response envelope.
  const { input } = fixture(1); input.nodes[1].state = 'unknown'; assert.throws(() => selectDirectoryEntries(input.nodes, 'r'), /nonterminal result/);
  input.nodes[1].state = 'joined'; delete input.nodes[1].resultStatus; assert.throws(() => selectDirectoryEntries(input.nodes, 'r'), /incomplete result/);
});
