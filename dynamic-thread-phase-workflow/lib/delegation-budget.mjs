import { createHash } from 'node:crypto';
import { LIMITS, validateDelegationPolicy, object, list, integer, id, unique, fail } from './delegation-contract.mjs';

// Deterministic single-writer model, NOT persistence, admission locking or process proof.
// Transition IDs are supplied by a trusted caller. No retries/recovery are authorized here.
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function transition(state, transitionId, payload, apply) {
  assertBudgetInvariants(state); id(transitionId);
  const digest = createHash('sha256').update(canonical(payload)).digest('hex');
  const prior = state.transitions.find(t => t.id === transitionId);
  if (prior) { if (prior.digest !== digest) fail('REQUEST_CONFLICT'); return state; }
  if (state.transitions.length >= 4096) fail('REQUEST_LIMIT');
  const next = structuredClone(state);
  apply(next); next.transitions.push({ id: transitionId, digest });
  assertBudgetInvariants(next); return freeze(next);
}
export function createBudgetState(policy) {
  validateDelegationPolicy(policy);
  return freeze({ total: policy.totalAgentBudget, maxDepth: policy.maxDepth, spent: 0,
    freeWorkflow: policy.totalAgentBudget, rootsReserved: false, acceptedNodes: 0,
    nodes: [], transitions: [] });
}
function node(state, nodeId) { id(nodeId); const n = state.nodes.find(n => n.nodeId === nodeId); if (!n) fail('INVALID_REQUEST', 'unknown node'); return n; }
function grants(children) {
  list(children, 128, 1).forEach(c => { object(c, ['nodeId', 'agentBudget']); id(c.nodeId); integer(c.agentBudget, 1, 128); });
  unique(children.map(c => c.nodeId));
}
function add(state, grant, parent) {
  if (state.nodes.some(n => n.nodeId === grant.nodeId)) fail('INVALID_REQUEST', 'duplicate node');
  state.nodes.push({ nodeId: grant.nodeId, parentNodeId: parent?.nodeId ?? null,
    rootNodeId: parent?.rootNodeId ?? grant.nodeId, depth: parent ? parent.depth + 1 : 0,
    agentBudget: grant.agentBudget, available: grant.agentBudget, charged: false, joined: false, children: [] });
  if (parent) parent.children.push(grant.nodeId);
  state.acceptedNodes++;
}
export function reserveRoots(state, roots, transitionId) {
  grants(roots);
  return transition(state, transitionId, { type: 'roots', roots }, next => {
    if (next.rootsReserved) fail('INVALID_REQUEST', 'roots already reserved');
    const sum = roots.reduce((sum, r) => sum + r.agentBudget, 0);
    if (sum > next.freeWorkflow) fail('BUDGET_EXHAUSTED');
    if (next.maxDepth === 0 && roots.some(r => r.agentBudget !== 1)) fail('DEPTH_LIMIT');
    roots.forEach(r => add(next, r, null)); next.freeWorkflow -= sum; next.rootsReserved = true;
  });
}
export function reserveChildren(state, parentNodeId, children, transitionId) {
  grants(children); list(children, 4, 1); id(parentNodeId);
  return transition(state, transitionId, { type: 'children', parentNodeId, children }, next => {
    const parent = node(next, parentNodeId);
    if (!parent.charged || parent.joined || parent.children.some(c => !node(next, c).joined)) fail('PARENT_NOT_ACTIVE');
    if (parent.depth >= next.maxDepth) fail('DEPTH_LIMIT');
    if (next.acceptedNodes + children.length > 128 || parent.children.length + children.length > 127) fail('ADMISSION_LIMIT');
    const sum = children.reduce((sum, c) => sum + c.agentBudget, 0);
    if (sum > parent.available) fail('BUDGET_EXHAUSTED');
    children.forEach(c => add(next, c, parent)); parent.available -= sum;
  });
}
export function chargeLaunchIntent(state, nodeId, transitionId) {
  id(nodeId);
  return transition(state, transitionId, { type: 'launch', nodeId }, next => {
    const n = node(next, nodeId);
    if (n.joined || n.charged || n.available < 1) fail('INVALID_REQUEST', 'not launchable');
    if (n.parentNodeId !== null) {
      const parent = node(next, n.parentNodeId);
      const earlier = parent.children.slice(0, parent.children.indexOf(nodeId));
      if (earlier.some(c => !node(next, c).joined)) fail('PARENT_NOT_ACTIVE', 'serial children');
    }
    n.available--; n.charged = true; next.spent++;
  });
}
export function joinAllocation(state, nodeId, settlement, transitionId) {
  id(nodeId); object(settlement, ['terminal', 'groupsInactive', 'structuralJoin']);
  if (Object.values(settlement).some(v => v !== true)) fail('OWNERSHIP_UNKNOWN');
  return transition(state, transitionId, { type: 'join', nodeId, settlement }, next => {
    const n = node(next, nodeId);
    if (n.joined || n.children.some(c => !node(next, c).joined)) fail('INVALID_REQUEST', 'unsettled or duplicate join');
    if (n.parentNodeId === null) next.freeWorkflow += n.available;
    else {
      const parent = node(next, n.parentNodeId);
      if (parent.joined) fail('INVALID_REQUEST', 'closed parent');
      parent.available += n.available;
    }
    n.available = 0; n.joined = true;
  });
}
export function allocationCounters(state, nodeId) {
  assertBudgetInvariants(state); const n = node(state, nodeId);
  const descendants = new Set([nodeId]);
  for (const entry of state.nodes) if (descendants.has(entry.parentNodeId)) descendants.add(entry.nodeId);
  const entries = state.nodes.filter(e => descendants.has(e.nodeId));
  return { agentBudget: n.agentBudget, spent: entries.filter(e => e.charged).length,
    available: n.available, reservedForChildren: entries.filter(e => e !== n).reduce((sum, e) => sum + e.available, 0) };
}
export function assertBudgetInvariants(state) {
  integer(state.total, 1, 128); integer(state.maxDepth, 0, 4); integer(state.spent, 0, state.total);
  integer(state.freeWorkflow, 0, state.total); integer(state.acceptedNodes, 0, 128);
  list(state.nodes, 128); list(state.transitions, 4096);
  if (typeof state.rootsReserved !== 'boolean' || state.acceptedNodes !== state.nodes.length || (!state.rootsReserved && state.nodes.length)) fail('BUDGET_INVARIANT');
  unique(state.nodes.map(n => n.nodeId)); unique(state.transitions.map(t => t.id));
  const roots = state.nodes.filter(n => n.parentNodeId === null);
  if (state.rootsReserved && !roots.length || roots.reduce((sum, n) => sum + n.agentBudget, 0) > state.total) fail('BUDGET_INVARIANT', 'fixed root quotas');
  const seen = new Map(); let held = 0; let charged = 0;
  for (const n of state.nodes) {
    id(n.nodeId); integer(n.depth, 0, state.maxDepth); integer(n.agentBudget, 1, 128); integer(n.available, 0, n.agentBudget);
    if (typeof n.charged !== 'boolean' || typeof n.joined !== 'boolean') fail('BUDGET_INVARIANT');
    list(n.children, 127); unique(n.children);
    const parent = seen.get(n.parentNodeId);
    if (n.parentNodeId !== null && (!parent || !parent.charged || parent.depth + 1 !== n.depth || parent.rootNodeId !== n.rootNodeId || !parent.children.includes(n.nodeId))) fail('BUDGET_INVARIANT');
    if (n.parentNodeId === null && (n.depth !== 0 || n.rootNodeId !== n.nodeId || state.maxDepth === 0 && n.agentBudget !== 1)) fail('BUDGET_INVARIANT');
    if (n.joined && (n.available !== 0 || n.children.some(c => !state.nodes.find(e => e.nodeId === c)?.joined))) fail('BUDGET_INVARIANT');
    if (n.children.some(c => state.nodes.find(e => e.nodeId === c)?.parentNodeId !== n.nodeId)) fail('BUDGET_INVARIANT');
    held += n.available; charged += Number(n.charged); seen.set(n.nodeId, n);
  }
  if (charged !== state.spent || charged + held + state.freeWorkflow !== state.total) fail('BUDGET_INVARIANT', 'conservation');
  for (const n of state.nodes) {
    const subtree = new Set([n.nodeId]);
    for (const e of state.nodes) if (subtree.has(e.parentNodeId)) subtree.add(e.nodeId);
    const used = state.nodes.filter(e => subtree.has(e.nodeId)).reduce((sum, e) => sum + Number(e.charged) + e.available, 0);
    if (used > n.agentBudget) fail('BUDGET_INVARIANT', 'subtree quota');
  }
  return true;
}
// Byte-reservation arithmetic only. Future journal must reserve/consume these atomically,
// using actual encoded record lengths; these functions neither write nor certify a log.
export function calculateJournalHeadroom({ outstandingNodes, outstandingBatches, outstandingCommands, workflowOpen }) {
  integer(outstandingNodes, 0, 128); integer(outstandingBatches, 0, 128); integer(outstandingCommands, 0, 128);
  if (typeof workflowOpen !== 'boolean') fail('INVALID_REQUEST');
  return (3 * outstandingNodes + outstandingBatches + 3 * outstandingCommands + Number(workflowOpen)) * LIMITS.terminalRecordBytes;
}
export function assertJournalCapacity({ usedBytes, nextRecordBytes, ...obligations }) {
  integer(usedBytes, 0, LIMITS.journalBytes); integer(nextRecordBytes, 0, LIMITS.frameBytes);
  const reservedBytes = calculateJournalHeadroom(obligations);
  if (usedBytes + nextRecordBytes + reservedBytes > LIMITS.journalBytes) fail('JOURNAL_LIMIT');
  return reservedBytes;
}
