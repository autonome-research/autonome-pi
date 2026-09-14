// Strict storage reducer. Reconstruction is INSPECTION ONLY, never launch resumption.
import { createBudgetState, reserveRoots, reserveChildren, chargeLaunchIntent, joinAllocation, calculateJournalHeadroom } from './delegation-budget.mjs';
import { LIMITS, object, list, integer, id, hash, text, enumValue, fail, validateDelegationPolicy,
  validateAssignment, validateDelegationRequest, validateCompletionRequest, RESULT_STATUSES } from './delegation-contract.mjs';
import { narrowScope, narrowAuthority, validateDirectoryScope, intersectTools } from './delegation-scope.mjs';
import { canonicalJSON, sha256, validateStoredReference } from './delegation-storage.mjs';

export const JOURNAL_SCHEMA = 'pi-workflow-delegation-journal/v1';
export const MANIFEST_SCHEMA = 'pi-workflow-delegation-manifest/v1';
export const STATE_SCHEMA = 'pi-workflow-delegation-state/v1';
export const uuid = value => { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail('INVALID_REQUEST', 'generated UUID'); return value; };
export function validateAuthority(a) {
  object(a, ['permissions', 'directoryScope', 'grantedTools', 'deadlineAt']);
  validateDirectoryScope(a.directoryScope, a.permissions);
  if (canonicalJSON(intersectTools(a.permissions, a.grantedTools)) !== canonicalJSON(a.grantedTools)) fail('PERMISSION_DENIED');
  if (a.deadlineAt !== null) integer(a.deadlineAt);
}
function definition(n) {
  object(n, ['nodeId', 'agentBudget', 'label', 'assignment', 'authority', 'index'], ['phaseIndex', 'itemIndex']);
  uuid(n.nodeId); integer(n.agentBudget, 1, 128); text(n.label, 80); validateAssignment(n.assignment); validateAuthority(n.authority);
  validateStoredReference(n.index);
  if (n.phaseIndex !== undefined) integer(n.phaseIndex);
  if (n.itemIndex !== undefined) integer(n.itemIndex, 0, 127);
}
export function validateManifest(m) {
  object(m, ['schema', 'resumable', 'runId', 'budgetScopeId', 'ownerEpoch', 'ownerPid', 'hostname', 'createdAt', 'specDigest', 'profileDigest', 'policyDigest', 'policy', 'roots', 'workspace', 'protectedDirectories']);
  if (m.schema !== MANIFEST_SCHEMA || m.resumable !== false) fail('UNSUPPORTED_VERSION');
  id(m.runId); uuid(m.budgetScopeId); uuid(m.ownerEpoch); integer(m.ownerPid, 1); text(m.hostname, 256); integer(m.createdAt);
  hash(m.specDigest); hash(m.profileDigest); hash(m.policyDigest); validateDelegationPolicy(m.policy);
  text(m.workspace, 4096); list(m.protectedDirectories, 32, 1).forEach(p => text(p, 4096));
  if (sha256(canonicalJSON(m.policy)) !== m.policyDigest) fail('OWNERSHIP_UNKNOWN', 'policy digest');
  list(m.roots, 128, 1).forEach(n => {
    definition(n); integer(n.phaseIndex);
    narrowScope(m.policy.directoryScope, n.authority.directoryScope);
  });
  const positions = m.roots.map(n => `${n.phaseIndex}:${n.itemIndex ?? '-'}`);
  if (new Set(positions).size !== positions.length) fail('INVALID_REQUEST', 'root positions');
  for (let i = 0; i < m.roots.length; i++) {
    const n = m.roots[i], before = m.roots[i - 1];
    if (before && n.phaseIndex < before.phaseIndex || before?.phaseIndex === n.phaseIndex &&
        (before.itemIndex === undefined || n.itemIndex !== before.itemIndex + 1) ||
        before?.phaseIndex !== n.phaseIndex && n.itemIndex !== undefined && n.itemIndex !== 0) fail('INVALID_REQUEST', 'root enumeration order');
  }
  reserveRoots(createBudgetState(m.policy), m.roots.map(({ nodeId, agentBudget }) => ({ nodeId, agentBudget })), 'preflight');
  if (Buffer.byteLength(canonicalJSON(m)) > 1024 * 1024) fail('JOURNAL_LIMIT', 'manifest');
  return m;
}
export function initialState(manifest) {
  return { schema: STATE_SCHEMA, resumable: false, budget: createBudgetState(manifest.policy), nodes: [], batches: [], requests: [],
    requestCount: 0, slots: {}, workflowOpen: true, sequence: 0 };
}
export function nodeOf(s, nodeId) { const n = s.nodes.find(n => n.nodeId === nodeId); if (!n) fail('INVALID_REQUEST', 'unknown node'); return n; }
export function invocationNode(s, invocationId) {
  uuid(invocationId); const n = s.nodes.find(n => n.invocationId === invocationId);
  if (!n) fail('UNAUTHORIZED'); return n;
}
const grants = nodes => nodes.map(({ nodeId, agentBudget }) => ({ nodeId, agentBudget }));
function addNode(s, n, parentNodeId = null) {
  s.nodes.push({ ...structuredClone(n), parentNodeId, invocationId: null, processToken: null, pid: null,
    candidate: null, result: null, joined: false, closed: false, calls: 0 });
  s.slots[n.nodeId] = ['result', 'join', 'close'];
}
function active(s, n) {
  if (!n.pid || n.candidate || n.result || n.joined || s.batches.some(b => b.parentNodeId === n.nodeId && !b.joined)) fail('PARENT_NOT_ACTIVE');
}
export function requestPrior(s, invocationId, requestId) {
  id(requestId); invocationNode(s, invocationId);
  return s.requests.find(r => r.invocationId === invocationId && r.requestId === requestId);
}
export function countRequest(s, invocationId) {
  const n = invocationNode(s, invocationId);
  if (s.requestCount >= 4096 || n.calls >= 128) fail('REQUEST_LIMIT');
  s.requestCount++; n.calls++;
}
function registerRequest(s, p, kind) {
  uuid(p.invocationId); id(p.requestId); hash(p.digest);
  if (requestPrior(s, p.invocationId, p.requestId)) fail('REQUEST_CONFLICT');
  countRequest(s, p.invocationId);
  s.requests.push({ invocationId: p.invocationId, requestId: p.requestId, digest: p.digest, kind });
}
function consume(s, nodeId, slot) {
  const slots = s.slots[nodeId];
  if (!slots?.includes(slot)) fail('INVALID_REQUEST', 'terminal reservation');
  slots.splice(slots.indexOf(slot), 1);
}
export function reservedBytes(s) {
  const nodeCount = Object.keys(s.slots).length;
  const consumed = 3 * nodeCount - Object.values(s.slots).reduce((sum, slots) => sum + slots.length, 0);
  return calculateJournalHeadroom({ outstandingNodes: nodeCount,
    outstandingBatches: s.batches.filter(b => !b.joined).length, outstandingCommands: 0, workflowOpen: s.workflowOpen }) - consumed * LIMITS.terminalRecordBytes
    + (s.commands ?? []).reduce((sum, c) => sum + c.slots.length * LIMITS.terminalRecordBytes, 0);
}
export function terminalType(type) { return ['node_result', 'node_joined', 'node_closed', 'delegation_joined', 'workflow_delegation_closed', 'command_result', 'command_drained', 'command_closed'].includes(type); }
export function checkCapacity(state, usedBytes, recordBytes, type) {
  integer(recordBytes, 1, terminalType(type) ? LIMITS.terminalRecordBytes : LIMITS.frameBytes);
  if (usedBytes + recordBytes + reservedBytes(state) > LIMITS.journalBytes) fail('JOURNAL_LIMIT');
  // Separate bounded projection growth allowance, not disk-space reservation. Node result,
  // join/index replacement + budget transition, and closure fit these compact allowances.
  const projectionReserve = Object.values(state.slots).reduce((sum, slots) => sum + slots.length * 1024, 0) + state.batches.filter(b => !b.joined).length * 512
    + (state.commands ?? []).reduce((sum, c) => sum + c.slots.length * 1024, 0);
  if (Buffer.byteLength(canonicalJSON(state)) + projectionReserve > 1024 * 1024 - 1024) fail('JOURNAL_LIMIT', 'projection headroom');
}
export function reduceEvent(previous, event, manifest) {
  const s = structuredClone(previous), p = event.payload;
  const tid = event.eventId;
  if (!s.workflowOpen || event.sequence !== s.sequence + 1) fail('OWNERSHIP_UNKNOWN', 'closed or nonmonotonic');
  const requireRequest = () => { hash(p.digest); uuid(p.invocationId); id(p.requestId); };
  switch (event.type) {
    case 'command_scope': {
      object(p, ['scopeId', 'invocationId', 'kind']); uuid(p.scopeId); uuid(p.invocationId);
      enumValue(p.kind, ['worker', 'declared-shell']);
      s.commandScopes ??= []; s.commands ??= [];
      if (s.commandScopes.length >= 128 || s.commandScopes.some(x => x.scopeId === p.scopeId || x.invocationId === p.invocationId)) fail('ADMISSION_LIMIT');
      if (p.kind === 'worker') invocationNode(s, p.invocationId);
      else if (s.nodes.some(n => n.invocationId === p.invocationId)) fail('UNAUTHORIZED');
      s.commandScopes.push({ ...p, frozen: false }); break;
    }
    case 'command_accepted': {
      object(p, ['scopeId', 'commandId', 'processToken', 'occurrence', 'digest', 'kind']);
      uuid(p.commandId); uuid(p.processToken); integer(p.occurrence, 1, 128); hash(p.digest);
      enumValue(p.kind, ['worker', 'shell']);
      const scope = s.commandScopes?.find(x => x.scopeId === p.scopeId);
      if (!scope || scope.frozen) fail('PARENT_NOT_ACTIVE');
      if (s.commands.length >= 128) fail('ADMISSION_LIMIT');
      if (s.commands.some(c => c.commandId === p.commandId || c.processToken === p.processToken || c.scopeId === p.scopeId && c.occurrence === p.occurrence)) fail('REQUEST_CONFLICT');
      const own = s.commands.filter(c => c.scopeId === p.scopeId);
      if (p.kind === 'worker' && (scope.kind !== 'worker' || own.length || invocationNode(s, scope.invocationId).processToken !== p.processToken) ||
          p.kind === 'shell' && (own.some(c => c.kind === 'shell' && c.slots.length) ||
            scope.kind === 'worker' && !own.some(c => c.kind === 'worker' && c.pid && !c.result))) fail('PARENT_NOT_ACTIVE');
      s.commands.push({ ...p, invocationId: scope.invocationId, pid: null, result: null, disposition: null, slots: ['result', 'drain', 'close'] }); break;
    }
    case 'command_started': {
      object(p, ['commandId', 'pid']); integer(p.pid, 1);
      const c = s.commands?.find(c => c.commandId === p.commandId);
      if (!c || c.pid || c.result) fail('OWNERSHIP_UNKNOWN'); c.pid = p.pid; break;
    }
    case 'command_scope_frozen': {
      object(p, ['scopeId']); const scope = s.commandScopes?.find(x => x.scopeId === p.scopeId);
      if (!scope || scope.frozen) fail('PARENT_NOT_ACTIVE'); scope.frozen = true; break;
    }
    case 'command_result': {
      object(p, ['commandId', 'classification', 'code', 'signal']);
      enumValue(p.classification, ['clean', 'residual_cleanup', 'cancelled', 'timeout', 'callback_error', 'start_error', 'spawn_error', 'signal', 'nonzero', 'validation_error']);
      if (p.code !== null) integer(p.code, 0, 255);
      if (p.signal !== null) text(p.signal, 32);
      const c = s.commands?.find(c => c.commandId === p.commandId);
      if (!c || c.result || !c.slots.includes('result') ||
          ['clean', 'residual_cleanup'].includes(p.classification) && (!c.pid || p.code !== 0 || p.signal !== null) ||
          p.classification === 'signal' && (p.signal === null || p.code !== null) ||
          p.classification === 'nonzero' && (p.code === null || p.code === 0 || p.signal !== null)) fail('OWNERSHIP_UNKNOWN');
      c.result = { classification: p.classification, code: p.code, signal: p.signal }; c.slots.splice(c.slots.indexOf('result'), 1); break;
    }
    case 'command_drained': {
      object(p, ['commandId', 'disposition']); enumValue(p.disposition, ['drained', 'no_child']);
      const c = s.commands?.find(c => c.commandId === p.commandId);
      if (!c?.result || c.disposition || !c.slots.includes('drain') ||
          p.disposition === 'drained' && !c.pid || p.disposition === 'no_child' &&
          (c.pid || !['cancelled', 'spawn_error', 'validation_error'].includes(c.result.classification))) fail('OWNERSHIP_UNKNOWN');
      c.disposition = p.disposition; c.slots.splice(c.slots.indexOf('drain'), 1); break;
    }
    case 'command_closed': {
      object(p, ['commandId']); const c = s.commands?.find(c => c.commandId === p.commandId);
      if (!c?.disposition || c.slots.length !== 1 || c.slots[0] !== 'close') fail('OWNERSHIP_UNKNOWN'); c.slots = []; break;
    }
    case 'root_reserved':
      object(p, ['rootPlanHash', 'count']);
      if (s.sequence || p.count !== manifest.roots.length || p.rootPlanHash !== sha256(canonicalJSON(manifest.roots))) fail('OWNERSHIP_UNKNOWN', 'root plan');
      s.budget = reserveRoots(s.budget, grants(manifest.roots), tid);
      manifest.roots.forEach(n => addNode(s, n)); break;
    case 'delegation_accepted': {
      object(p, ['invocationId', 'requestId', 'digest', 'request', 'children', 'batchId']); requireRequest(); uuid(p.batchId);
      validateDelegationRequest(p.request);
      if (p.digest !== sha256(canonicalJSON({ kind: 'delegate', payload: p.request }))) fail('REQUEST_CONFLICT');
      const parent = invocationNode(s, p.invocationId); active(s, parent);
      if (p.request.directoryRevision !== s.sequence) fail('STALE_CONTEXT');
      list(p.children, 4, 1).forEach(definition);
      if (p.children.length !== p.request.children.length || s.batches.some(b => b.batchId === p.batchId)) fail('INVALID_REQUEST');
      p.children.forEach((n, i) => {
        const c = p.request.children[i];
        const authority = narrowAuthority(parent.authority, c, event.at);
        const assignment = { task: c.task, acceptance: c.acceptance, ...(c.contextSummary === undefined ? {} : { parentContextSummary: c.contextSummary }) };
        if (n.phaseIndex !== undefined || n.itemIndex !== undefined || n.agentBudget !== c.agentBudget || n.label !== c.label ||
            canonicalJSON(n.assignment) !== canonicalJSON(assignment) || canonicalJSON(n.authority) !== canonicalJSON(authority)) fail('PERMISSION_DENIED');
      });
      registerRequest(s, p, 'delegate');
      s.budget = reserveChildren(s.budget, parent.nodeId, grants(p.children), tid);
      p.children.forEach(n => addNode(s, n, parent.nodeId));
      s.batches.push({ batchId: p.batchId, parentNodeId: parent.nodeId, invocationId: p.invocationId, requestId: p.requestId,
        children: p.children.map(c => c.nodeId), joined: false }); break;
    }
    case 'request_denied':
      object(p, ['invocationId', 'requestId', 'digest', 'code']); requireRequest();
      enumValue(p.code, ['INVALID_REQUEST', 'SCOPE_DENIED', 'PERMISSION_DENIED', 'STALE_CONTEXT', 'DEPTH_LIMIT', 'BUDGET_EXHAUSTED', 'ADMISSION_LIMIT', 'PARENT_NOT_ACTIVE', 'DEADLINE_EXPIRED', 'CONTEXT_LIMIT', 'RESULT_INVALID']);
      registerRequest(s, p, p.code); break;
    case 'request_repeated': {
      object(p, ['invocationId', 'requestId', 'digest', 'conflict']); requireRequest();
      const prior = requestPrior(s, p.invocationId, p.requestId);
      if (!prior || p.conflict !== (prior.digest !== p.digest)) fail('REQUEST_CONFLICT');
      countRequest(s, p.invocationId); break;
    }
    case 'launch_intent': {
      object(p, ['nodeId', 'invocationId', 'processToken']); uuid(p.invocationId); uuid(p.processToken);
      const n = nodeOf(s, p.nodeId);
      if (n.result || n.invocationId || s.nodes.some(x => x.invocationId === p.invocationId || x.processToken === p.processToken)) fail('INVALID_REQUEST');
      s.budget = chargeLaunchIntent(s.budget, n.nodeId, tid);
      n.invocationId = p.invocationId; n.processToken = p.processToken; break;
    }
    case 'worker_started': {
      object(p, ['nodeId', 'invocationId', 'pid', 'processToken', 'profileDigest']); integer(p.pid, 1);
      const n = nodeOf(s, p.nodeId);
      if (!n.invocationId || n.pid || n.result || n.invocationId !== p.invocationId || n.processToken !== p.processToken || p.profileDigest !== manifest.profileDigest) fail('OWNERSHIP_UNKNOWN');
      n.pid = p.pid; break;
    }
    case 'completion_submitted': {
      object(p, ['invocationId', 'requestId', 'digest', 'candidate']); requireRequest(); validateStoredReference(p.candidate);
      const n = invocationNode(s, p.invocationId); active(s, n);
      if (s.budget.nodes.find(b => b.nodeId === n.nodeId).children.some(child => !nodeOf(s, child).joined)) fail('RESULT_INVALID', 'unjoined children');
      registerRequest(s, p, 'complete'); n.candidate = p.candidate; break;
    }
    case 'node_result': {
      object(p, ['nodeId', 'result', 'status', 'disposition']); validateStoredReference(p.result); enumValue(p.status, RESULT_STATUSES);
      const n = nodeOf(s, p.nodeId);
      if (n.result || ['success', 'partial'].includes(p.status)) fail('UNSUPPORTED_MODE', 'live executor settlement not implemented');
      if (s.nodes.some(c => c.parentNodeId === n.nodeId && !c.joined) || s.batches.some(b => b.parentNodeId === n.nodeId && !b.joined)) fail('OWNERSHIP_UNKNOWN', 'descendants not structurally settled');
      if (p.disposition !== (n.invocationId ? 'unknown' : 'never_launched') || !n.invocationId && !['cancelled', 'timeout', 'infrastructure_error'].includes(p.status)) fail('OWNERSHIP_UNKNOWN');
      consume(s, n.nodeId, 'result'); n.result = { ...p.result, status: p.status, disposition: p.disposition }; break;
    }
    case 'node_joined': {
      object(p, ['nodeId', 'resultHash', 'parentIndex']); hash(p.resultHash);
      const n = nodeOf(s, p.nodeId);
      // Deliberate blocker: the existing process journal cannot prove this invocation's
      // complete command/group set or clean exit. No supplied groupsInactive boolean.
      if (n.invocationId || !n.result || n.result.sha256 !== p.resultHash) fail('OWNERSHIP_UNKNOWN', 'no live executor settlement proof');
      if (n.parentNodeId) { validateStoredReference(p.parentIndex); nodeOf(s, n.parentNodeId).index = p.parentIndex; }
      else if (p.parentIndex !== null) fail('INVALID_REQUEST');
      consume(s, n.nodeId, 'join');
      s.budget = joinAllocation(s.budget, n.nodeId, { terminal: true, groupsInactive: true, structuralJoin: true }, tid);
      n.joined = true; break;
    }
    case 'delegation_joined': {
      object(p, ['batchId']); const b = s.batches.find(b => b.batchId === p.batchId);
      if (!b || b.joined || b.children.some(c => !nodeOf(s, c).joined)) fail('INVALID_REQUEST');
      b.joined = true; break;
    }
    case 'node_closed': {
      object(p, ['nodeId']); const n = nodeOf(s, p.nodeId);
      if (!n.joined || s.batches.some(b => b.parentNodeId === n.nodeId && !b.joined)) fail('INVALID_REQUEST');
      consume(s, n.nodeId, 'close'); n.closed = true; break;
    }
    case 'workflow_delegation_closed':
      object(p, []);
      if (!s.nodes.length || s.nodes.some(n => !n.closed) || s.batches.some(b => !b.joined) ||
          s.commands?.some(c => c.slots.length) || s.commandScopes?.some(c => !c.frozen)) fail('OWNERSHIP_UNKNOWN');
      s.workflowOpen = false; break;
    default: fail('UNSUPPORTED_VERSION', 'event type');
  }
  s.sequence = event.sequence; return s;
}
export function completionAuthority(s, n) {
  return { assignment: n.assignment,
    joinedChildren: s.nodes.filter(c => c.parentNodeId === n.nodeId && c.joined).map(c => ({ childNodeId: c.nodeId, resultHash: c.result.sha256 })),
    // Only own/direct joined children artifacts. Explicit inherited evidence requires
    // a future separately validated visibility grant, not caller-supplied IDs here.
    visibleArtifactIds: s.nodes.filter(c => c.parentNodeId === n.nodeId && c.joined).flatMap(c => [c.result.artifactId]) };
}
export function validateCandidate(content, s, n) {
  object(content, ['schema', 'nodeId', 'request', 'evidence']);
  if (content.schema !== 'pi-workflow-delegation-candidate/v1' || content.nodeId !== n.nodeId) fail('RESULT_INVALID');
  validateCompletionRequest(content.request, completionAuthority(s, n));
  list(content.evidence, 8).forEach(e => { object(e, ['label', 'reference']); text(e.label, 80); validateStoredReference(e.reference); });
  if (content.evidence.length !== content.request.evidence.length || content.evidence.some((e, i) => e.label !== content.request.evidence[i].label) ||
      content.evidence.some(e => e.reference.bytes > 256 * 1024) || content.evidence.reduce((sum, e) => sum + e.reference.bytes, 0) > 1024 * 1024) fail('RESULT_INVALID');
  return content;
}
