import { createHash } from 'node:crypto';
import { VERSIONS, LIMITS, NODE_STATES, RESULT_STATUSES, object, integer, text, list, id, hash,
  unique, enumValue, artifactId as validateArtifactId, fail, boundedJSON, validateWorkflowContext, validateAssignment,
  validateContextRequest, validateNodeResult } from './delegation-contract.mjs';
import { validateDirectoryScope, validatePermissions, intersectTools } from './delegation-scope.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const digest = value => createHash('sha256').update(value).digest('hex');
export function clipPreview(value, maxBytes) {
  text(value, Number.MAX_SAFE_INTEGER, true); integer(maxBytes, 0, LIMITS.contextBytes);
  let result = ''; let size = 0;
  for (const character of value) { const next = Buffer.byteLength(character); if (size + next > maxBytes) break; result += character; size += next; }
  return result;
}
export function validateContextRevision(requested, current) {
  integer(requested); integer(current); if (requested !== current) fail('STALE_CONTEXT'); return current;
}
function validateDirectory(nodes) {
  list(nodes, 128, 1); unique(nodes.map(n => n.nodeId));
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  for (const n of nodes) {
    object(n, ['nodeId', 'treeRootNodeId', 'phaseIndex', 'depth', 'label', 'state', 'task', 'scopePreview', 'createdSequence'],
      ['parentNodeId', 'itemIndex', 'resultArtifactId', 'resultStatus']);
    id(n.nodeId); id(n.treeRootNodeId); integer(n.phaseIndex); integer(n.depth, 0, 4); integer(n.createdSequence);
    if (n.itemIndex !== undefined) integer(n.itemIndex, 0, 127);
    text(n.label, 80); text(n.task, 4096); text(n.scopePreview, 4096, true); enumValue(n.state, NODE_STATES);
    if (n.parentNodeId !== undefined) {
      id(n.parentNodeId); const parent = byId.get(n.parentNodeId);
      if (!parent || parent.depth + 1 !== n.depth || parent.treeRootNodeId !== n.treeRootNodeId ||
          parent.phaseIndex !== n.phaseIndex || parent.itemIndex !== n.itemIndex) fail('INVALID_REQUEST', 'hierarchy');
    } else if (n.depth !== 0 || n.treeRootNodeId !== n.nodeId) fail('INVALID_REQUEST', 'root');
    if ((n.resultArtifactId === undefined) !== (n.resultStatus === undefined)) fail('RESULT_INVALID', 'incomplete result reference');
    if (n.resultArtifactId !== undefined) {
      validateArtifactId(n.resultArtifactId); enumValue(n.resultStatus, RESULT_STATUSES);
      if (!['joined', 'failed', 'cancelled'].includes(n.state)) fail('RESULT_INVALID', 'nonterminal result');
      if (n.state === 'failed' && ['success', 'partial', 'cancelled'].includes(n.resultStatus) || n.state === 'cancelled' && n.resultStatus !== 'cancelled') fail('RESULT_INVALID', 'contradictory status');
    }
    if (n.state === 'joined' && n.resultArtifactId === undefined) fail('RESULT_INVALID', 'joined without result');
  }
  return byId;
}
function hierarchy(nodes, selfNodeId) {
  const byId = validateDirectory(nodes); id(selfNodeId);
  const self = byId.get(selfNodeId); if (!self) fail('INVALID_REQUEST', 'missing self');
  const ancestors = []; let current = self;
  while (current.parentNodeId !== undefined) { current = byId.get(current.parentNodeId); ancestors.unshift(current); }
  return { self, ancestors };
}
export function selectDirectoryEntries(nodes, selfNodeId) {
  const { self, ancestors } = hierarchy(nodes, selfNodeId);
  const rank = n => n.nodeId === selfNodeId ? 0 : ancestors.some(a => a.nodeId === n.nodeId) ? 1 :
    n.parentNodeId === selfNodeId ? 2 : n.parentNodeId !== undefined && n.parentNodeId === self.parentNodeId &&
    ['running', 'waiting_children', 'queued', 'result_pending_exit'].includes(n.state) ? 3 : 4;
  const ordered = [...nodes].sort((a, b) => rank(a) - rank(b) || a.phaseIndex - b.phaseIndex ||
    (a.itemIndex ?? -1) - (b.itemIndex ?? -1) || a.createdSequence - b.createdSequence || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  const directory = [];
  for (const n of ordered) {
    const { task, scopePreview, createdSequence, ...rest } = n;
    const entry = { ...rest, assignmentPreview: clipPreview(task, 160), scopePreview: clipPreview(scopePreview, 160) };
    if (directory.length < 32 && bytes([...directory, entry]) <= 8192) directory.push(entry);
  }
  return { directory, omitted: nodes.length - directory.length };
}
export function buildOwnChildJoinIndex({ artifactId, ownerNodeId, revision, children }) {
  validateArtifactId(artifactId); id(ownerNodeId); integer(revision); list(children, 127).forEach(validateNodeResult);
  unique(children.map(c => c.childNodeId));
  const index = { schema: VERSIONS.joinIndex, ownerNodeId, revision,
    children: children.map(({ childNodeId, resultHash, status, resultArtifactId }) => ({ childNodeId, resultHash, status, resultArtifactId })) };
  const content = JSON.stringify(index);
  boundedJSON(index, 1024 * 1024);
  return { index, content, reference: { artifactId, revision, bytes: Buffer.byteLength(content), sha256: digest(content), childCount: children.length } };
}
function artifactRef(ref) {
  validateArtifactId(ref.artifactId); integer(ref.bytes, 0, 1024 * 1024); hash(ref.sha256);
}
// Byte pages are base64 so arbitrary offsets cannot corrupt a UTF-8 code point.
// Caller supplies already-authorized immutable bytes, never a filesystem path.
export function projectArtifactRead(reference, content, request, visibleArtifactIds) {
  validateContextRequest(request); artifactRef(reference); list(visibleArtifactIds, 2048).forEach(validateArtifactId);
  if (request.view !== 'artifact' || request.artifactId !== reference.artifactId || !visibleArtifactIds.includes(request.artifactId)) fail('PERMISSION_DENIED');
  if (typeof content !== 'string' && !Buffer.isBuffer(content)) fail('INVALID_REQUEST');
  const buffer = Buffer.from(content);
  if (buffer.length !== reference.bytes || digest(buffer) !== reference.sha256) fail('RESULT_INVALID', 'artifact integrity');
  const offsetBytes = request.offsetBytes ?? 0; const limitBytes = request.limitBytes ?? 4096;
  integer(offsetBytes, 0, buffer.length);
  const endOffsetBytes = Math.min(buffer.length, offsetBytes + limitBytes);
  return { artifactId: reference.artifactId, sha256: reference.sha256, bytes: buffer.length,
    offsetBytes, endOffsetBytes, truncated: endOffsetBytes < buffer.length, encoding: 'base64',
    data: buffer.subarray(offsetBytes, endOffsetBytes).toString('base64') };
}
export function projectDelegationResults(results) {
  list(results, 4, 1).forEach(validateNodeResult);
  unique(results.map(r => r.childNodeId));
  return boundedJSON({ status: 'joined', results: results.map(r => ({ ...r, summary: clipPreview(r.summary, 2048), summaryTruncated: Buffer.byteLength(r.summary) > 2048 })) }, LIMITS.contextBytes);
}
export function buildDelegationContext(input) {
  object(input, ['runId', 'budgetScopeId', 'directoryRevision', 'asOfEventSequence', 'workflowContext', 'self',
    'assignment', 'ancestors', 'nodes', 'evidence', 'inheritedArtifactIds', 'ownChildJoinIndex']);
  id(input.runId); id(input.budgetScopeId); integer(input.asOfEventSequence); integer(input.directoryRevision, 0, input.asOfEventSequence);
  validateWorkflowContext(input.workflowContext); validateAssignment(input.assignment);
  const { self: record, ancestors } = hierarchy(input.nodes, input.self.nodeId);
  input.nodes.forEach(n => integer(n.createdSequence, 0, input.asOfEventSequence));
  if (input.assignment.task !== record.task) fail('INVALID_REQUEST', 'assignment mismatch');
  const s = input.self;
  object(s, ['nodeId', 'treeRootNodeId', 'depth', 'state', 'label', 'grantedPermissions', 'grantedTools',
    'directoryScope', 'agentBudget', 'spent', 'available', 'reservedForChildren'], ['parentNodeId', 'deadlineAt']);
  for (const key of ['nodeId', 'treeRootNodeId', 'parentNodeId', 'depth', 'state', 'label']) if (s[key] !== record[key]) fail('INVALID_REQUEST', 'self mismatch');
  validatePermissions(s.grantedPermissions); validateDirectoryScope(s.directoryScope, s.grantedPermissions);
  const tools = intersectTools(s.grantedPermissions, s.grantedTools);
  if (tools.length !== s.grantedTools.length) fail('PERMISSION_DENIED', 'tool expansion');
  integer(s.agentBudget, 1, 128); integer(s.spent, 0, s.agentBudget); integer(s.available, 0, s.agentBudget); integer(s.reservedForChildren, 0, s.agentBudget);
  if (s.spent + s.available + s.reservedForChildren > s.agentBudget) fail('INVALID_REQUEST', 'balances');
  if (s.deadlineAt !== undefined) integer(s.deadlineAt);
  list(input.ancestors, 4);
  if (input.ancestors.length !== ancestors.length) fail('INVALID_REQUEST', 'ancestors');
  input.ancestors.forEach((a, i) => {
    object(a, ['nodeId', 'label', 'constraintsSummary']); text(a.constraintsSummary, 512, true);
    if (a.nodeId !== ancestors[i].nodeId || a.label !== ancestors[i].label) fail('INVALID_REQUEST', 'ancestor mismatch');
  });
  const index = input.ownChildJoinIndex;
  object(index, ['artifactId', 'revision', 'bytes', 'sha256', 'childCount']); artifactRef(index);
  integer(index.revision, 0, input.directoryRevision); integer(index.childCount, 0, 127);
  if (index.childCount !== input.nodes.filter(n => n.parentNodeId === s.nodeId && n.state === 'joined').length) fail('RESULT_INVALID', 'join index count');
  list(input.inheritedArtifactIds, 2048).forEach(validateArtifactId); unique(input.inheritedArtifactIds);
  list(input.evidence, 2048); unique(input.evidence.map(e => e.artifactId));
  const childIds = input.nodes.filter(n => n.parentNodeId === s.nodeId && n.state === 'joined').map(n => n.nodeId);
  const visible = input.evidence.filter(e => {
    object(e, ['artifactId', 'ownerNodeId', 'bytes', 'sha256', 'preview']); artifactRef(e); id(e.ownerNodeId); text(e.preview, 4096, true);
    return e.ownerNodeId === s.nodeId || childIds.includes(e.ownerNodeId) || input.inheritedArtifactIds.includes(e.artifactId);
  }).sort((a, b) => a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0);
  const { directory } = selectDirectoryEntries(input.nodes, s.nodeId);
  const result = { schema: VERSIONS.context, runId: input.runId, budgetScopeId: input.budgetScopeId,
    directoryRevision: input.directoryRevision, asOfEventSequence: input.asOfEventSequence,
    workflowContext: structuredClone(input.workflowContext), self: structuredClone(s),
    ownChildJoinIndex: structuredClone(index), assignment: structuredClone(input.assignment), ancestors: structuredClone(input.ancestors),
    directory, visibleEvidence: visible.slice(0, 32).map(e => ({ ...e, preview: clipPreview(e.preview, 160) })),
    omitted: {}, limits: { directoryEntries: 32, directoryBytes: 8192, evidenceEntries: 32, contextBytes: LIMITS.contextBytes } };
  const updateOmitted = () => {
    const included = new Set(result.directory.map(n => n.nodeId)); const states = {};
    for (const n of input.nodes) if (!included.has(n.nodeId)) states[n.state] = (states[n.state] ?? 0) + 1;
    result.omitted = { directoryEntries: input.nodes.length - result.directory.length,
      evidenceEntries: visible.length - result.visibleEvidence.length, directoryStates: states };
  };
  updateOmitted();
  while (bytes(result) > LIMITS.contextBytes && (result.visibleEvidence.length || result.directory.length)) {
    if (result.visibleEvidence.length) result.visibleEvidence.pop(); else result.directory.pop(); updateOmitted();
  }
  return boundedJSON(result, LIMITS.contextBytes, 'CONTEXT_LIMIT');
}
