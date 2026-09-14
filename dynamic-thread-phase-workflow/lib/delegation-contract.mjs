import { validateDirectoryScope, validatePermissions, normalizeScopePath, narrowScope } from './delegation-scope.mjs';

// Internal, import-safe contracts. These are NOT public workflow decoders.
export const VERSIONS = Object.freeze({ policy: 'pi-workflow-delegation-policy/v1',
  context: 'pi-workflow-delegation-context/v1', joinIndex: 'pi-workflow-delegation-join-index/v1',
  result: 'pi-workflow-delegation-node-result/v1' });
export const LIMITS = Object.freeze({ maxDepth: 4, totalAgentBudget: 128, acceptedNodes: 128,
  directChildren: 127, batch: 4, directoryEntries: 32, directoryBytes: 8192,
  contextBytes: 24 * 1024, completionBytes: 48 * 1024, frameBytes: 64 * 1024,
  journalBytes: 16 * 1024 * 1024, terminalRecordBytes: 4096 });
export function fail(code, message = code) { throw new Error(`${code}: ${message}`); }
export function object(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      required.some(k => !Object.hasOwn(value, k)) ||
      Reflect.ownKeys(value).some(k => typeof k !== 'string' || ![...required, ...optional].includes(k) ||
        !Object.getOwnPropertyDescriptor(value, k).enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k), 'value') || value[k] === undefined)) fail('INVALID_REQUEST', 'object fields');
  return value;
}
export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) fail('INVALID_REQUEST', 'integer');
  return value;
}
export function text(value, max, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0') ||
      Buffer.from(value).toString('utf8') !== value || Buffer.byteLength(value) > max) fail('INVALID_REQUEST', 'text');
  return value;
}
export function list(value, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1 ||
      Array.from({ length: value.length }, (_, i) => i).some(i => !Object.hasOwn(value, i))) fail('INVALID_REQUEST', 'array');
  return value;
}
export function unique(values) { if (new Set(values).size !== values.length) fail('INVALID_REQUEST', 'duplicates'); }
export function id(value) {
  text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)) fail('INVALID_REQUEST', 'identifier');
  return value;
}
export function artifactId(value) { id(value); if (!value.startsWith('artifact:') || value.length === 9) fail('INVALID_REQUEST', 'artifact identifier'); return value; }
export function hash(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('INVALID_REQUEST', 'sha256'); return value; }
export function enumValue(value, values) { if (!values.includes(value)) fail('INVALID_REQUEST', 'enum'); return value; }
export function boundedJSON(value, max, code = 'INVALID_REQUEST') {
  if (Buffer.byteLength(JSON.stringify(value)) > max) fail(code, 'serialized bytes');
  return value;
}
export function validateVersion(actual, expected) {
  if (!Object.values(VERSIONS).includes(expected) || actual !== expected) fail('UNSUPPORTED_VERSION');
}
export function validateWorkflowContext(value) {
  object(value, ['objective', 'constraints']); text(value.objective, 2048);
  list(value.constraints, 8).forEach(s => text(s, 256)); return structuredClone(value);
}
export function validateDelegationPolicy(value) {
  object(value, ['maxDepth', 'totalAgentBudget', 'directoryScope', 'context']);
  integer(value.maxDepth, 0, 4); integer(value.totalAgentBudget, 1, 128);
  validateDirectoryScope(value.directoryScope); validateWorkflowContext(value.context);
  return structuredClone(value);
}
// A minimal internal root plan, not caller phases. Each group has a unique phaseIndex;
// items, if present, are static labels (duplicates legal). Enumeration uses indexes.
export function validateRootAllocations(policy, groups) {
  validateDelegationPolicy(policy); list(groups, 128, 1);
  unique(groups.map(g => g.phaseIndex));
  const roots = []; let total = 0;
  for (const g of groups) {
    object(g, ['phaseIndex', 'agentBudget'], ['items', 'directoryScope']);
    integer(g.phaseIndex); integer(g.agentBudget, 1, 128);
    if (policy.maxDepth === 0 && g.agentBudget !== 1) fail('DEPTH_LIMIT');
    const scope = g.directoryScope ?? policy.directoryScope;
    narrowScope(policy.directoryScope, scope);
    if (g.items !== undefined) list(g.items, 128, 1).forEach(s => text(s, 4096, true));
    const count = g.items?.length ?? 1;
    // Both factors are already <=128: arithmetic is safe before addition.
    total += count * g.agentBudget;
    if (total > policy.totalAgentBudget || roots.length + count > 128) fail('BUDGET_EXHAUSTED');
    for (let i = 0; i < count; i++) roots.push({ phaseIndex: g.phaseIndex,
      ...(g.items ? { itemIndex: i } : {}), agentBudget: g.agentBudget, directoryScope: structuredClone(scope) });
  }
  return roots.sort((a, b) => a.phaseIndex - b.phaseIndex || (a.itemIndex ?? 0) - (b.itemIndex ?? 0));
}
export function validateAssignment(value) {
  object(value, ['task', 'acceptance'], ['parentContextSummary']); text(value.task, 4096);
  list(value.acceptance, 8, 1).forEach(a => { object(a, ['id', 'criterion']); text(a.id, 64); text(a.criterion, 512); });
  unique(value.acceptance.map(a => a.id));
  if (value.parentContextSummary !== undefined) text(value.parentContextSummary, 2048, true);
  return structuredClone(value);
}
export function validateDelegationRequest(value) {
  object(value, ['directoryRevision', 'children']); integer(value.directoryRevision);
  list(value.children, 4, 1).forEach(c => {
    object(c, ['label', 'task', 'acceptance', 'agentBudget', 'permissions', 'directoryScope'], ['contextSummary', 'timeoutMs']);
    text(c.label, 80); integer(c.agentBudget, 1, 128); validatePermissions(c.permissions);
    validateDirectoryScope(c.directoryScope, c.permissions);
    validateAssignment({ task: c.task, acceptance: c.acceptance,
      ...(c.contextSummary !== undefined ? { parentContextSummary: c.contextSummary } : {}) });
    if (c.timeoutMs !== undefined) integer(c.timeoutMs, 1, 3_600_000);
  });
  boundedJSON(value, LIMITS.frameBytes); return structuredClone(value);
}
export function validateContextRequest(value) {
  if (value?.view === 'directory') object(value, ['view']);
  else {
    object(value, ['view', 'artifactId'], ['offsetBytes', 'limitBytes']); enumValue(value.view, ['artifact']); artifactId(value.artifactId);
    if (value.offsetBytes !== undefined) integer(value.offsetBytes);
    if (value.limitBytes !== undefined) integer(value.limitBytes, 1, 8192);
  }
  return structuredClone(value);
}
export function validateCompletionRequest(value, { assignment, joinedChildren, visibleArtifactIds }) {
  validateAssignment(assignment); list(joinedChildren, 127); list(visibleArtifactIds, 2048).forEach(artifactId);
  unique(joinedChildren.map(c => c.childNodeId));
  joinedChildren.forEach(c => { id(c.childNodeId); hash(c.resultHash); });
  object(value, ['status', 'summary', 'acceptance', 'evidence', 'childReviews', 'remainingWork']);
  enumValue(value.status, ['success', 'partial', 'failed']); text(value.summary, 4096);
  list(value.evidence, 8).forEach(e => {
    object(e, ['label', 'path', 'description']); text(e.label, 80);
    if (!/^[A-Za-z0-9_-]+$/u.test(e.label)) fail('INVALID_REQUEST', 'evidence label');
    normalizeScopePath(e.path); if (e.path === '.') fail('INVALID_REQUEST', 'file path'); text(e.description, 512);
  });
  unique(value.evidence.map(e => e.label));
  const refs = new Set([...visibleArtifactIds, ...value.evidence.map(e => `local:${e.label}`)]);
  list(value.acceptance, 8, 1).forEach(a => {
    object(a, ['id', 'outcome', 'evidenceIds']); text(a.id, 64);
    enumValue(a.outcome, ['passed', 'failed', 'unverified']);
    list(a.evidenceIds, 8).forEach(ref => { id(ref); if (!refs.has(ref)) fail('RESULT_INVALID', 'unknown evidence'); }); unique(a.evidenceIds);
    if (value.status === 'success' && a.outcome !== 'passed') fail('RESULT_INVALID', 'unpassed success');
  });
  unique(value.acceptance.map(a => a.id));
  if (value.acceptance.length !== assignment.acceptance.length || value.acceptance.some(a => !assignment.acceptance.some(b => a.id === b.id))) fail('RESULT_INVALID', 'criteria mismatch');
  list(value.childReviews, 127).forEach(r => {
    object(r, ['childNodeId', 'resultHash', 'decision', 'reason']); id(r.childNodeId); hash(r.resultHash);
    enumValue(r.decision, ['accepted', 'rejected']); text(r.reason, 128);
    if (!joinedChildren.some(c => c.childNodeId === r.childNodeId && c.resultHash === r.resultHash)) fail('RESULT_INVALID', 'stale review');
  });
  unique(value.childReviews.map(r => r.childNodeId));
  if (value.childReviews.length !== joinedChildren.length) fail('RESULT_INVALID', 'missing review');
  list(value.remainingWork, 8).forEach(s => text(s, 512)); boundedJSON(value, LIMITS.completionBytes);
  return structuredClone(value);
}
export const NODE_STATES = Object.freeze(['reserved', 'queued', 'running', 'waiting_children', 'result_pending_exit', 'joined', 'failed', 'cancelled', 'unknown']);
export const RESULT_STATUSES = Object.freeze(['success', 'partial', 'failed', 'cancelled', 'timeout', 'missing_completion', 'infrastructure_error']);
export function validateNodeResult(value) {
  object(value, ['schema', 'childNodeId', 'status', 'summary', 'resultHash', 'resultArtifactId']);
  validateVersion(value.schema, VERSIONS.result); id(value.childNodeId); enumValue(value.status, RESULT_STATUSES);
  text(value.summary, 4096, true); hash(value.resultHash); artifactId(value.resultArtifactId);
  return structuredClone(value); // Hash is a supplied integrity reference, not verified content or success proof.
}
