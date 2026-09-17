// Create-only single writer. NO open/recover/resume/dispatch API. Inspection below never
// mints capabilities or authorizes process launch. Keep disconnected from public v3.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { WORKFLOW_ARTIFACT_LAYOUT } from './artifact-layout.mjs';
import { object, list, text, integer, id, hash, fail, LIMITS, artifactId, validateAssignment, validateContextRequest, validateDelegationPolicy, validateDelegationRequest, validateCompletionRequest } from './delegation-contract.mjs';
import { narrowAuthority, intersectTools } from './delegation-scope.mjs';
import { buildOwnChildJoinIndex, projectArtifactRead } from './delegation-context.mjs';
import { createScopedFilesystem } from './delegation-filesystem.mjs';
import { canonicalJSON, decodeCanonical, sha256, canonicalDirectory, boundedRead, storageIO, readStoredArtifact, validateStoredReference } from './delegation-storage.mjs';
import { JOURNAL_SCHEMA, MANIFEST_SCHEMA, STATE_SCHEMA, ROOT_ASSIGNMENTS_SCHEMA, uuid, validateManifest, initialState, reduceEvent, checkCapacity,
  nodeOf, invocationNode, requestPrior, reservedBytes, completionAuthority, validateCandidate, composeFinalResult, effectiveAuthority, launchDeadlineDenied,
  validateRootAssignmentsEvidence } from './delegation-journal-model.mjs';
import { takeResultCapability } from './delegation-results.mjs';
import { takeObserverSeal, delegationPublicationOwner } from './delegation-executor.mjs';
export function applyObserverSeal(writer, capability) {
  const authority = liveWriters.get(writer);
  if (!authority) fail('UNAUTHORIZED');
  authority.guard(); authority.sealObservers(takeObserverSeal(capability, writer)); authority.guard();
}

const liveWriters = new WeakMap();
// Private provenance/liveness check, NOT mutation entry: safe while persist is
// busy. Every recording API still uses guard(), so nested writes stay denied.
export function guardDelegationWriter(writer) {
  const authority = liveWriters.get(writer);
  if (!authority) fail('UNAUTHORIZED');
  authority.live();
}
const launchTimeouts = new WeakMap();
export function takeLaunchTimeout(writer, error, nodeId, token) {
  const denial = launchTimeouts.get(error);
  if (!denial || denial.writer !== writer || denial.nodeId !== nodeId || denial.token !== token) return false;
  liveWriters.get(writer).guard(); launchTimeouts.delete(error); return true;
}
const executorClaims = new WeakSet();
const schedulerClaims = new WeakSet();
// Local veto only, including failed start/persistence before handle association.
// Unlike freezeCommandScope this performs no I/O and grants no settlement.
export function vetoDelegationScope(writer, scopeId) {
  const authority = liveWriters.get(writer);
  if (!authority) fail('UNAUTHORIZED');
  authority.vetoScope(scopeId);
}
export function claimDelegationScheduler(writer, configuration) {
  const authority = liveWriters.get(writer);
  if (!authority || schedulerClaims.has(writer) || executorClaims.has(writer)) fail('UNAUTHORIZED', 'fresh original scheduler journal');
  authority.guard(); schedulerClaims.add(writer);
  return authority.scheduler(configuration);
}
// A stored snapshot or journal-shaped object cannot claim a live executor writer.
export function claimDelegationExecutor(writer) {
  const authority = liveWriters.get(writer);
  if (!authority || executorClaims.has(writer)) fail('UNAUTHORIZED', 'live executor writer');
  authority.guard(); executorClaims.add(writer);
  // Do not leak the private result writer through the older executor claim.
  return Object.freeze({ guard: authority.guard, runId: authority.runId, ownerEpoch: authority.ownerEpoch, onOwnerLoss: authority.onOwnerLoss });
}
// Exact in-memory coordinator provenance, NOT a raw-journal recording method.
export function applyDelegationResult(writer, capability, operation) {
  const authority = liveWriters.get(writer);
  if (!authority) fail('UNAUTHORIZED');
  authority.guard();
  return authority.resultOperation(takeResultCapability(capability, writer, operation), operation);
}
const encode = value => Buffer.from(canonicalJSON(value));
const plainRef = ({ artifactId, bytes, sha256 }) => ({ artifactId, bytes, sha256 });
function artifactPlan(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024) fail('RESULT_INVALID', 'artifact bound');
  bytes = Buffer.from(bytes);
  return { bytes, reference: { artifactId: `artifact:${randomUUID()}`, bytes: bytes.length, sha256: sha256(bytes) } };
}
function indexPlan(nodeId, revision, children) {
  const artifactId = `artifact:${randomUUID()}`;
  const built = buildOwnChildJoinIndex({ artifactId, ownerNodeId: nodeId, revision, children });
  return { bytes: Buffer.from(built.content), reference: plainRef(built.reference) };
}
function rootAssignmentsPlan(manifest, phaseIndex, assignments) {
  integer(phaseIndex); list(assignments, 128, 1);
  const roots = manifest.roots.filter(n => n.phaseIndex === phaseIndex);
  if (!roots.length || roots.some(n => n.taskTemplate === undefined) || assignments.length !== roots.length) fail('INVALID_REQUEST', 'complete deferred phase required');
  const rows = assignments.map((value, i) => {
    object(value, ['nodeId', 'task'], ['parentContextSummary']);
    text(value.task, 4096);
    if (value.parentContextSummary !== undefined) text(value.parentContextSummary, 2048, true);
    const root = roots[i];
    if (value.nodeId !== root.nodeId) fail('INVALID_REQUEST', 'ordered root identity');
    const taskHash = sha256(value.task);
    const assignment = { task: value.task, acceptance: [{ id: 'assignment',
      criterion: `Satisfy the assigned phase task (sha256:${taskHash}) and cite supporting evidence.` }],
      ...(value.parentContextSummary === undefined ? {} : { parentContextSummary: value.parentContextSummary }) };
    validateAssignment(assignment);
    return { nodeId: root.nodeId, ...(root.itemIndex === undefined ? {} : { itemIndex: root.itemIndex }),
      templateHash: root.templateHash, taskHash, assignmentHash: sha256(canonicalJSON(assignment)), assignment };
  });
  const content = { schema: ROOT_ASSIGNMENTS_SCHEMA, runId: manifest.runId, specDigest: manifest.specDigest, phaseIndex, roots: rows };
  validateRootAssignmentsEvidence(content, manifest, phaseIndex);
  const plan = artifactPlan(encode(content));
  return { plan, payload: { phaseIndex, count: roots.length, assignments: plan.reference } };
}
const childResults = (s, parentId, extra) => s.nodes.filter(n => n.parentNodeId === parentId && (n.joined || n.nodeId === extra)).map(n => ({
  schema: 'pi-workflow-delegation-node-result/v1', childNodeId: n.nodeId, status: n.result.status,
  summary: '', resultHash: n.result.sha256, resultArtifactId: n.result.artifactId,
}));
function visibleEvidence(s, n, read) {
  const entries = [...(n.inheritedEvidence ?? [])];
  for (const child of s.nodes.filter(c => c.parentNodeId === n.nodeId && c.joined)) {
    entries.push({ ownerNodeId: child.nodeId, reference: plainRef(child.result) });
    if (child.candidate) {
      const candidate = decodeCanonical(read(child.candidate));
      for (const e of candidate.evidence) entries.push({ ownerNodeId: child.nodeId, reference: e.reference });
    }
  }
  return [...new Map(entries.map(e => [e.reference.artifactId, e])).values()];
}
function candidateContent(s, n, reference, read) {
  const visible = visibleEvidence(s, n, read);
  const c = validateCandidate(decodeCanonical(read(reference)), s, n, visible.map(e => e.reference.artifactId));
  c.evidence.forEach(e => read(e.reference));
  for (const ref of new Set(c.request.acceptance.flatMap(a => a.evidenceIds).filter(id => !id.startsWith('local:')))) {
    read(visible.find(e => e.reference.artifactId === ref).reference);
  }
  return c;
}
function resultContent(bytes, s, n, manifest, read) {
  const content = decodeCanonical(bytes);
  if (content.schema === 'pi-workflow-delegation-result-evidence/v2') {
    const candidate = n.candidate ? candidateContent(s, n, n.candidate, read) : null;
    read(n.index);
    s.nodes.filter(c => c.parentNodeId === n.nodeId && c.joined).forEach(c => read(plainRef(c.result)));
    const expected = composeFinalResult(s, n, manifest, content.settlement?.scopeId, content.usage, candidate);
    if (canonicalJSON(expected) !== canonicalJSON(content)) fail('RESULT_INVALID', 'final result content/binding');
    return content;
  }
  object(content, ['schema', 'nodeId', 'status', 'summary', 'cause', 'usageCompleteness', 'candidate', 'disposition']);
  if (content.schema !== 'pi-workflow-delegation-result-evidence/v1' || content.nodeId !== n.nodeId ||
      !['missing', 'partial', 'reported'].includes(content.usageCompleteness) || canonicalJSON(content.candidate) !== canonicalJSON(n.candidate)) fail('RESULT_INVALID');
  text(content.summary, 4096, true); text(content.cause, 128);
  return content;
}
function verifyIndex(bytes, s, ownerId, revision, extra) {
  const actual = JSON.parse(bytes.toString('utf8'));
  const expected = buildOwnChildJoinIndex({ artifactId: 'artifact:inspection', ownerNodeId: ownerId, revision, children: childResults(s, ownerId, extra) });
  if (bytes.toString('utf8') !== expected.content || actual.ownerNodeId !== ownerId) fail('RESULT_INVALID', 'join index integrity/ownership');
}
function verifyEventArtifacts(event, s, manifest, read) {
  const p = event.payload;
  let evidence;
  if (event.type === 'root_assignments_materialized') {
    object(p, ['phaseIndex', 'count', 'assignments']); integer(p.phaseIndex); integer(p.count, 1, 128); validateStoredReference(p.assignments);
    evidence = validateRootAssignmentsEvidence(decodeCanonical(read(p.assignments)), manifest, p.phaseIndex);
  }
  if (event.type === 'root_reserved') manifest.roots.forEach(n => verifyIndex(read(n.index), s, n.nodeId, 0));
  if (event.type === 'delegation_accepted') {
    const parent = invocationNode(s, p.invocationId), allowed = visibleEvidence(s, parent, read);
    p.children.forEach(n => {
      if (canonicalJSON((n.inheritedEvidence ?? []).map(e => e.reference.artifactId)) !== canonicalJSON(p.inheritedArtifactIds ?? [])) fail('PERMISSION_DENIED');
      verifyIndex(read(n.index), s, n.nodeId, 0);
      for (const e of n.inheritedEvidence ?? []) {
        if (!allowed.some(a => canonicalJSON(a) === canonicalJSON(e))) fail('PERMISSION_DENIED', 'inherited evidence grant');
        read(e.reference);
      }
    });
  }
  if (event.type === 'completion_submitted') {
    const n = invocationNode(s, p.invocationId);
    const c = candidateContent(s, n, p.candidate, read);
    if (p.digest !== sha256(canonicalJSON({ kind: 'complete', payload: c.request }))) fail('REQUEST_CONFLICT');
  }
  if (event.type === 'node_result') {
    const c = resultContent(read(p.result), s, nodeOf(s, p.nodeId), manifest, read);
    if (c.status !== p.status || c.disposition !== p.disposition ||
        canonicalJSON(c.settlement ?? null) !== canonicalJSON(p.settlement ?? null)) fail('RESULT_INVALID');
  }
  if (event.type === 'node_joined') {
    const n = nodeOf(s, p.nodeId);
    if (n.parentNodeId) verifyIndex(read(p.parentIndex), s, n.parentNodeId, event.sequence, n.nodeId);
  }
  return evidence;
}
function validateEnvelope(e, s, manifest, manifestDigest, previousHash) {
  object(e, ['schema', 'sequence', 'eventId', 'ownerEpoch', 'manifestDigest', 'previousHash', 'at', 'type', 'payloadDigest', 'payload', 'hash']);
  if (e.schema !== JOURNAL_SCHEMA || e.sequence !== s.sequence + 1 || e.ownerEpoch !== manifest.ownerEpoch ||
      e.manifestDigest !== manifestDigest || e.previousHash !== previousHash) fail('OWNERSHIP_UNKNOWN', 'event binding/sequence');
  uuid(e.eventId); integer(e.at, manifest.createdAt); text(e.type, 64); hash(e.payloadDigest); hash(e.hash);
  if (sha256(canonicalJSON(e.payload)) !== e.payloadDigest) fail('OWNERSHIP_UNKNOWN', 'payload digest');
  const { hash: recordHash, ...body } = e;
  if (sha256(canonicalJSON(body)) !== recordHash) fail('OWNERSHIP_UNKNOWN', 'event hash');
}

/** Trusted runner-only constructor. Model/bridge JSON must never be spread into options.
 * Root identities/epoch/budget scope/invocations/artifacts are generated here. Host must
 * persist returned binding in its immutable start envelope before future exposure.
 */
export function createDelegationJournal(options) {
  object(options, ['artifactDirectory', 'workspace', 'protectedDirectories', 'runId', 'specDigest', 'profileDigest', 'policy', 'roots'], ['fault']);
  const artifactDirectory = canonicalDirectory(options.artifactDirectory);
  const workspace = canonicalDirectory(options.workspace);
  id(options.runId); hash(options.specDigest); hash(options.profileDigest); validateDelegationPolicy(options.policy);
  list(options.roots, 128, 1); list(options.protectedDirectories, 31, 1).forEach(p => canonicalDirectory(p));
  if (options.fault !== undefined && typeof options.fault !== 'function') fail('INVALID_REQUEST');
  const directory = join(artifactDirectory, WORKFLOW_ARTIFACT_LAYOUT.delegationDirectory);
  let publication, writer;
  const io = storageIO(point => {
    options.fault?.(point);
    // Reuse the existing last-before-syscall seam, AFTER fault instrumentation.
    // A previous write may exist; loss never authorizes the next one or rollback.
    if (publication && point.startsWith('before:')) { live(); publication.guard(); }
  });
  const plans = [];
  const roots = options.roots.map(r => {
    object(r, ['phaseIndex', 'agentBudget', 'label', 'permissions', 'directoryScope', 'deadlineAt'], ['itemIndex', 'task', 'taskTemplate', 'contextTemplate']);
    if ((r.task !== undefined) === (r.taskTemplate !== undefined) || r.contextTemplate !== undefined && r.taskTemplate === undefined)
      fail('INVALID_REQUEST', 'exactly one task or taskTemplate');
    if (r.task !== undefined) text(r.task, 4096);
    else { text(r.taskTemplate, 4096); if (r.contextTemplate !== undefined) text(r.contextTemplate, 2048, true); }
    const nodeId = randomUUID();
    const index = indexPlan(nodeId, 0, []); plans.push(index);
    const template = r.taskTemplate === undefined ? null : { task: r.taskTemplate,
      ...(r.contextTemplate === undefined ? {} : { parentContextSummary: r.contextTemplate }) };
    return { nodeId, phaseIndex: r.phaseIndex, ...(r.itemIndex === undefined ? {} : { itemIndex: r.itemIndex }),
      agentBudget: r.agentBudget, label: r.label,
      ...(template ? { taskTemplate: r.taskTemplate, ...(r.contextTemplate === undefined ? {} : { contextTemplate: r.contextTemplate }),
        templateHash: sha256(canonicalJSON(template)) } :
        { assignment: { task: r.task, acceptance: [{ id: 'assignment', criterion: 'Satisfy the assigned phase task and cite supporting evidence.' }] } }),
      authority: { permissions: r.permissions, directoryScope: structuredClone(r.directoryScope),
        grantedTools: intersectTools(r.permissions, ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']), deadlineAt: r.deadlineAt }, index: index.reference };
  });
  const manifest = validateManifest({ schema: MANIFEST_SCHEMA, resumable: false, runId: options.runId,
    budgetScopeId: randomUUID(), ownerEpoch: randomUUID(), ownerPid: process.pid, hostname: hostname(), createdAt: Date.now(),
    specDigest: options.specDigest, profileDigest: options.profileDigest, policyDigest: sha256(canonicalJSON(options.policy)),
    policy: structuredClone(options.policy), roots, workspace,
    protectedDirectories: [...new Set([...options.protectedDirectories, artifactDirectory])] });
  // Verify actual scope/protection facts before allocating any storage.
  roots.forEach(n => createScopedFilesystem({ workspace, ...{ permissions: n.authority.permissions, directoryScope: n.authority.directoryScope }, protectedDirectories: manifest.protectedDirectories }));
  const manifestBytes = encode(manifest), manifestDigest = sha256(manifestBytes);
  const binding = { manifestDigest, runId: manifest.runId, specDigest: manifest.specDigest, profileDigest: manifest.profileDigest };
  let state = initialState(manifest), lastHash = manifestDigest, usedBytes = 0, fd, poisoned = false, busy = false, stopped = false;
  const ownerLossListeners = new Set();
  let schedulerFreeze;
  const publish = plan => io.publish(join(directory, 'nodes'), `${plan.reference.artifactId.slice(9)}.blob`, plan.bytes);
  function live() { if (poisoned || stopped || process.pid !== manifest.ownerPid) fail('OWNERSHIP_UNKNOWN', 'writer unavailable; inspection only'); }
  function guard() { live(); if (busy) fail('OWNERSHIP_UNKNOWN', 'writer busy; nested mutation denied'); }
  const writerProof = Object.freeze({ guard: live });
  function persist(type, payload, artifacts = [], at = Math.max(Date.now(), manifest.createdAt), proof = delegationPublicationOwner(writer) ?? writerProof) {
    guard(); proof.guard(); busy = true; publication = proof;
    try {
      const body = { schema: JOURNAL_SCHEMA, sequence: state.sequence + 1, eventId: randomUUID(), ownerEpoch: manifest.ownerEpoch,
        manifestDigest, previousHash: lastHash, at, type, payloadDigest: sha256(canonicalJSON(payload)), payload };
      const event = { ...body, hash: sha256(canonicalJSON(body)) };
      const bytes = Buffer.from(`${canonicalJSON(event)}\n`);
      const evidence = verifyEventArtifacts(event, state, manifest, ref => artifacts.find(a => canonicalJSON(a.reference) === canonicalJSON(ref))?.bytes ?? readStoredArtifact(directory, ref));
      const next = reduceEvent(state, event, manifest, evidence);
      checkCapacity(next, usedBytes, bytes.length, type);
      const projection = encode({ schema: STATE_SCHEMA, resumable: false, manifestDigest,
        lastHash: event.hash, usedBytes: usedBytes + bytes.length, state: next });
      if (projection.length > 1024 * 1024) fail('JOURNAL_LIMIT');
      // Encoding/validation is preparation, NOT an issued write. Retain the
      // original consumed proof across it; frozen receipt JSON is insufficient.
      proof.validate?.(); live(); proof.guard();
      try {
        artifacts.forEach(publish);
        canonicalDirectory(directory, true);
        const opened = fs.fstatSync(fd), named = fs.lstatSync(join(directory, 'events.jsonl'));
        if (opened.size !== usedBytes || opened.ino !== named.ino || opened.dev !== named.dev ||
            !named.isFile() || named.nlink !== 1 || named.uid !== process.getuid() || (named.mode & 0o077)) fail('OWNERSHIP_UNKNOWN', 'journal replaced/changed');
        io.writeAll(fd, bytes); io.step('event-fsync', () => fs.fsyncSync(fd));
        state = next; lastHash = event.hash; usedBytes += bytes.length;
        io.publish(directory, 'state.json', projection, false);
        live(); proof.guard(); // Failed acknowledgement remains held, even after durable publication.
      } catch (error) { poisoned = true; throw error; }
      return structuredClone(event);
    } finally { publication = undefined; busy = false; }
  }
  // Exclusive allocation is the lock. It is NEVER removed by close/failure/restart.
  // Any failed construction leaves an unclaimable directory for manual inspection.
  try {
    io.step('allocation-mkdir', () => fs.mkdirSync(directory, { mode: 0o700 })); io.syncDirectory(artifactDirectory);
    io.step('nodes-mkdir', () => fs.mkdirSync(join(directory, 'nodes'), { mode: 0o700 })); io.syncDirectory(directory);
    plans.forEach(publish);
    io.publish(directory, 'manifest.json', manifestBytes);
    io.step('events-open', () => { fd = fs.openSync(join(directory, 'events.jsonl'), 'wx', 0o600); });
    io.step('events-create-fsync', () => fs.fsyncSync(fd)); io.syncDirectory(directory);
    persist('root_reserved', { rootPlanHash: sha256(canonicalJSON(roots)), count: roots.length });
  } catch (error) { if (fd !== undefined) fs.closeSync(fd); throw error; }
  function duplicate(invocationId, requestId, digest) {
    guard(); const prior = requestPrior(state, invocationId, requestId);
    if (!prior) return false;
    persist('request_repeated', { invocationId, requestId, digest, conflict: prior.digest !== digest });
    if (prior.digest !== digest) fail('REQUEST_CONFLICT');
    return prior;
  }
  function scopeCheck(action) {
    // Only read-only scope/evidence validation runs here, BEFORE publication. Never
    // normalize persistence/mutation errors (even ENOENT/EACCES) into safe denials.
    try { return action(); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) fail('SCOPE_DENIED', 'scope/evidence path unavailable');
      if (['EACCES', 'EPERM'].includes(error?.code)) fail('PERMISSION_DENIED', 'scope/evidence access denied');
      if (!error?.code && /^(INVALID_REQUEST|SCOPE_DENIED|PERMISSION_DENIED|RESULT_INVALID):/.test(error?.message)) throw error;
      // Unexpected I/O or ambiguous read integrity is infrastructure failure, not
      // a retryable request denial. No raw OS message/path enters worker outcomes.
      poisoned = true;
      fail('OWNERSHIP_UNKNOWN', 'scope/evidence validation failed; inspection only');
    }
  }
  function processEntry(token, pid) {
    // This only verifies reserve/PID write ordering. It is NOT group settlement proof.
    const j = JSON.parse(boundedRead(join(artifactDirectory, WORKFLOW_ARTIFACT_LAYOUT.processJournal), 1_000_000, { privateFile: false }).toString('utf8'));
    object(j, ['schema', 'runId', 'runnerPid', 'hostname', 'hasSubprocesses', 'groups']);
    if (j.schema !== 'pi-dynamic-workflow-processes/v1' || j.runId !== manifest.runId || j.runnerPid !== process.pid || j.hostname !== hostname() || typeof j.hasSubprocesses !== 'boolean') fail('OWNERSHIP_UNKNOWN');
    list(j.groups, 1024); const tokens = new Set();
    for (const g of j.groups) {
      object(g, ['token'], ['pid']); uuid(g.token);
      if (tokens.has(g.token)) fail('OWNERSHIP_UNKNOWN'); tokens.add(g.token);
      if (g.pid !== undefined) { integer(g.pid, 1); if (!j.hasSubprocesses) fail('OWNERSHIP_UNKNOWN'); }
    }
    if (!j.groups.some(g => g.token === token && g.pid === pid)) fail('OWNERSHIP_UNKNOWN', 'process journal ordering');
  }
  function joinBatch(batchId, proof) {
    guard(); if (state.batches.find(b => b.batchId === batchId)?.joined) return;
    persist('delegation_joined', { batchId }, [], undefined, proof); // no second credit return
  }
  function closeNode(nodeId, proof) {
    guard(); if (!nodeOf(state, nodeId).closed) persist('node_closed', { nodeId }, [], undefined, proof);
  }
  writer = Object.freeze({
    directory, binding: Object.freeze(binding),
    snapshot() { return structuredClone({ inspectionOnly: true, resumable: false, state, usedBytes, reservedBytes: reservedBytes(state), lastHash, poisoned }); },
    // Trusted live executor recording boundary only; these serializable records
    // never authorize joins or signal/replay. Unknown outcomes retain all slots.
    openCommandScope(kind, invocationId = randomUUID()) {
      guard(); const scopeId = randomUUID();
      persist('command_scope', { scopeId, invocationId, kind });
      return Object.freeze({ scopeId, invocationId, ownerEpoch: manifest.ownerEpoch, runId: manifest.runId });
    },
    acceptCommand(scopeId, occurrence, processToken, kind, digest, callbackHooks = 0) {
      guard(); const commandId = randomUUID();
      try { processEntry(processToken, undefined); persist('command_accepted', { scopeId, commandId, occurrence, processToken, kind, digest, ...(callbackHooks ? { callbackHooks } : {}) }); }
      catch (error) { poisoned = true; throw error; }
      return commandId;
    },
    commandStarted(commandId, pid) {
      guard(); const c = state.commands?.find(c => c.commandId === commandId);
      if (!c) fail('UNAUTHORIZED');
      try { processEntry(c.processToken, pid); persist('command_started', { commandId, pid }); }
      catch (error) { poisoned = true; throw error; }
    },
    freezeCommandScope(scopeId) {
      guard(); persist('command_scope_frozen', { scopeId });
      // Private scheduler veto only; durable direct-exit freeze is NOT drain.
      schedulerFreeze?.(scopeId);
    },
    settleCommand(commandId, { classification, code, signal, disposition }) {
      guard();
      persist('command_result', { commandId, classification, code, signal });
      persist('command_drained', { commandId, disposition });
      persist('command_closed', { commandId });
    },
    launchIntent(nodeId, processToken) {
      guard(); uuid(processToken);
      const n = nodeOf(state, nodeId);
      if (!n.assignment) fail('PARENT_NOT_ACTIVE', 'deferred root assignment unresolved');
      if (n.invocationId) {
        if (n.processToken !== processToken) fail('REQUEST_CONFLICT');
        return Object.freeze({ invocationId: n.invocationId, recordedNow: false });
      }
      const invocationId = randomUUID(), payload = { nodeId, invocationId, processToken };
      let at, deadlineDenied;
      try {
        processEntry(processToken, undefined);
        at = Math.max(Date.now(), manifest.createdAt);
        deadlineDenied = launchDeadlineDenied(state, payload, at);
      } catch (error) { poisoned = true; throw error; }
      if (deadlineDenied) {
        // Exact live semantic denial before ANY persist mutation. The process
        // reservation still belongs to the executor; this alone cannot clear it.
        const error = new Error('DEADLINE_EXPIRED: launch intent denied');
        launchTimeouts.set(error, { writer, nodeId, token: processToken }); throw error;
      }
      try { persist('launch_intent', payload, [], at); }
      catch (error) { poisoned = true; throw error; } // all persist ambiguity still poisons
      // recordedNow is an append outcome, NOT a process permit. A repeated intent
      // must never dispatch again; the future executor supplies all other launch gates.
      return Object.freeze({ invocationId, recordedNow: true });
    },
    workerStarted(invocationId, pid) {
      guard(); const n = invocationNode(state, invocationId); integer(pid, 1);
      if (n.pid) { if (n.pid !== pid) fail('REQUEST_CONFLICT'); return; }
      try {
        processEntry(n.processToken, pid);
        persist('worker_started', { nodeId: n.nodeId, invocationId, pid, processToken: n.processToken, profileDigest: manifest.profileDigest });
      } catch (error) { poisoned = true; throw error; }
    },
    acceptDelegation(invocationId, requestId, request, inheritedArtifactIds = []) {
      guard(); const serialized = canonicalJSON(request);
      if (Buffer.byteLength(serialized) > LIMITS.frameBytes) fail('INVALID_REQUEST');
      list(inheritedArtifactIds, 32).forEach(artifactId);
      const inheritance = inheritedArtifactIds.length ? { inheritedArtifactIds: [...inheritedArtifactIds] } : {};
      const digest = sha256(canonicalJSON({ kind: 'delegate', payload: request, ...inheritance }));
      if (duplicate(invocationId, requestId, digest)) return structuredClone(state.batches.find(b => b.invocationId === invocationId && b.requestId === requestId) ?? requestPrior(state, invocationId, requestId));
      try {
        validateDelegationRequest(request);
        const parent = invocationNode(state, invocationId);
        list(inheritedArtifactIds, 32).forEach(artifactId);
        if (new Set(inheritedArtifactIds).size !== inheritedArtifactIds.length) fail('INVALID_REQUEST');
        const visible = visibleEvidence(state, parent, ref => readStoredArtifact(directory, ref));
        const inheritedEvidence = inheritedArtifactIds.map(id => {
          const e = visible.find(e => e.reference.artifactId === id);
          if (!e) fail('PERMISSION_DENIED'); return e;
        });
        const artifacts = [], acceptedAt = Math.max(Date.now(), manifest.createdAt);
        const children = request.children.map(c => {
          const nodeId = randomUUID(), index = indexPlan(nodeId, 0, []); artifacts.push(index);
          const authority = narrowAuthority(effectiveAuthority(parent), c, acceptedAt);
          scopeCheck(() => createScopedFilesystem({ workspace, permissions: authority.permissions, directoryScope: authority.directoryScope, protectedDirectories: manifest.protectedDirectories }));
          return { nodeId, agentBudget: c.agentBudget, label: c.label, authority, index: index.reference,
            ...(inheritedEvidence.length ? { inheritedEvidence } : {}), assignment: { task: c.task, acceptance: c.acceptance, ...(c.contextSummary === undefined ? {} : { parentContextSummary: c.contextSummary }) } };
        });
        const batchId = randomUUID();
        persist('delegation_accepted', { invocationId, requestId, digest, request: structuredClone(request), children, batchId, ...inheritance }, artifacts, acceptedAt);
        return structuredClone(state.batches.find(b => b.batchId === batchId));
      } catch (error) {
        const code = error.message.split(':')[0];
        if (!poisoned && ['INVALID_REQUEST', 'SCOPE_DENIED', 'PERMISSION_DENIED', 'STALE_CONTEXT', 'DEPTH_LIMIT', 'BUDGET_EXHAUSTED', 'ADMISSION_LIMIT', 'PARENT_NOT_ACTIVE', 'DEADLINE_EXPIRED', 'CONTEXT_LIMIT'].includes(code)) persist('request_denied', { invocationId, requestId, digest, code });
        throw error;
      }
    },
    submitCompletion(invocationId, requestId, request) {
      guard();
      const serialized = canonicalJSON(request);
      if (Buffer.byteLength(serialized) > LIMITS.frameBytes) fail('INVALID_REQUEST');
      const digest = sha256(canonicalJSON({ kind: 'complete', payload: request }));
      const prior = duplicate(invocationId, requestId, digest);
      // The reducer admits at most one completion per invocation; its verified
      // event binds that candidate to this accepted request/digest. A denied
      // request must never borrow the invocation's later accepted candidate.
      if (prior) return structuredClone(prior.kind === 'complete' ? invocationNode(state, invocationId).candidate : prior);
      try {
        const n = invocationNode(state, invocationId);
        validateCompletionRequest(request, completionAuthority(state, n,
          visibleEvidence(state, n, ref => readStoredArtifact(directory, ref)).map(e => e.reference.artifactId)));
        const scoped = scopeCheck(() => createScopedFilesystem({ workspace, permissions: n.authority.permissions, directoryScope: n.authority.directoryScope, protectedDirectories: manifest.protectedDirectories }));
        const artifacts = [];
        const evidence = scopeCheck(() => scoped.snapshotEvidence(request.evidence)).map(e => {
          const plan = artifactPlan(e.bytes); artifacts.push(plan); return { label: e.label, reference: plan.reference };
        });
        const candidate = artifactPlan(encode({ schema: 'pi-workflow-delegation-candidate/v1', nodeId: n.nodeId, request, evidence })); artifacts.push(candidate);
        persist('completion_submitted', { invocationId, requestId, digest, candidate: candidate.reference }, artifacts);
        return structuredClone(candidate.reference); // candidate only, never success
      } catch (error) {
        const code = error.message.split(':')[0];
        if (!poisoned && ['INVALID_REQUEST', 'SCOPE_DENIED', 'PERMISSION_DENIED', 'RESULT_INVALID', 'PARENT_NOT_ACTIVE'].includes(code)) persist('request_denied', { invocationId, requestId, digest, code });
        throw error;
      }
    },
    recordFailure(nodeId, outcome) {
      guard(); object(outcome, ['status', 'summary', 'cause', 'usageCompleteness']);
      const n = nodeOf(state, nodeId), disposition = n.invocationId ? 'unknown' : 'never_launched';
      const content = encode({ schema: 'pi-workflow-delegation-result-evidence/v1', nodeId, ...outcome, candidate: n.candidate, disposition });
      if (n.result) { if (n.result.sha256 !== sha256(content)) fail('REQUEST_CONFLICT'); return plainRef(n.result); }
      const result = artifactPlan(content);
      // Raw launched failure is diagnostic unknown, never live settlement. Keep
      // its original-writer recording contract even after executor revocation.
      persist('node_result', { nodeId, result: result.reference, status: outcome.status, disposition }, [result], undefined, n.invocationId ? writerProof : undefined);
      return structuredClone(result.reference);
    },
    joinUnlaunched(nodeId) {
      guard(); const n = nodeOf(state, nodeId);
      if (n.invocationId || !n.result) fail('OWNERSHIP_UNKNOWN', 'live result capability required');
      if (n.joined) return structuredClone(n.result);
      const plan = n.parentNodeId ? indexPlan(n.parentNodeId, state.sequence + 1, childResults(state, n.parentNodeId, n.nodeId)) : null;
      persist('node_joined', { nodeId, resultHash: n.result.sha256, parentIndex: plan?.reference ?? null }, plan ? [plan] : []);
      return structuredClone(nodeOf(state, nodeId).result);
    },
    joinBatch(batchId) { joinBatch(batchId); },
    closeNode(nodeId) { closeNode(nodeId); },
    closeWorkflow() { guard(); if (state.workflowOpen) persist('workflow_delegation_closed', {}); },
    dispose() {
      if (!stopped) {
        stopped = true;
        for (const listener of ownerLossListeners) listener();
        ownerLossListeners.clear(); fs.closeSync(fd);
      }
    },
  });
  function resultOperation(proof, operation) {
    guard();
    const publication = { guard: proof.access.liveGuard,
      validate: () => proof.access.validatePublication(proof.scope, proof.receipt) };
    proof.access.validate(proof.scope, proof.receipt);
    const n = invocationNode(state, proof.scope.invocationId);
    if (canonicalJSON(n.candidate) !== canonicalJSON(proof.candidate)) fail('REQUEST_CONFLICT', 'candidate changed after worker settlement');
    const read = ref => readStoredArtifact(directory, ref);
    const candidate = n.candidate ? candidateContent(state, n, n.candidate, read) : null;
    read(n.index);
    state.nodes.filter(c => c.parentNodeId === n.nodeId && c.joined).forEach(c => read(plainRef(c.result)));
    const content = encode(composeFinalResult(state, n, manifest, proof.scope.scopeId, proof.usage, candidate));
    if (operation === 'result') {
      if (n.result) fail('REQUEST_CONFLICT', 'immutable existing result');
      const result = artifactPlan(content), c = decodeCanonical(content);
      proof.access.validate(proof.scope, proof.receipt);
      persist('node_result', { nodeId: n.nodeId, result: result.reference, status: c.status,
        disposition: c.disposition, settlement: c.settlement }, [result], undefined, publication);
      proof.access.guard();
      return Object.freeze({ ...result.reference });
    }
    if (!n.result || n.result.sha256 !== proof.reference.sha256 || canonicalJSON(plainRef(n.result)) !== canonicalJSON(proof.reference) ||
        !read(proof.reference).equals(content)) fail('REQUEST_CONFLICT', 'immutable result identity/content');
    proof.access.validate(proof.scope, proof.receipt);
    if (operation === 'lookup') return proof.reference;
    if (operation !== 'join') fail('UNAUTHORIZED');
    if (!n.joined) {
      const plan = n.parentNodeId ? indexPlan(n.parentNodeId, state.sequence + 1, childResults(state, n.parentNodeId, n.nodeId)) : null;
      proof.access.validate(proof.scope, proof.receipt);
      persist('node_joined', { nodeId: n.nodeId, resultHash: n.result.sha256, parentIndex: plan?.reference ?? null }, plan ? [plan] : [], undefined, publication);
    }
    proof.access.guard();
    // Structural delivery eligibility only. Scheduler later restores permits/leases.
    const batch = state.batches.find(b => b.children.includes(n.nodeId));
    if (batch && batch.children.every(id => nodeOf(state, id).joined)) {
      joinBatch(batch.batchId, publication);
      batch.children.forEach(id => { proof.access.guard(); closeNode(id, publication); });
    } else if (!batch) closeNode(n.nodeId, publication);
    proof.access.guard();
    return proof.reference;
  }
  liveWriters.set(writer, Object.freeze({ guard, live, resultOperation,
    sealObservers: proof => persist('scope_observers_sealed', proof.payload, [], undefined, proof), runId: manifest.runId, ownerEpoch: manifest.ownerEpoch,
    vetoScope(scopeId) { schedulerFreeze?.(scopeId); },
    scheduler(configuration) {
      persist('scheduler_configured', configuration);
      const capability = {
        guard,
        onScopeFrozen(listener) {
          guard(); if (schedulerFreeze || typeof listener !== 'function') fail('UNAUTHORIZED');
          schedulerFreeze = listener;
        },
        materializePhase(phaseIndex, assignments) {
          if (this !== capability) fail('UNAUTHORIZED', 'original scheduler capability required');
          guard();
          const { plan, payload } = rootAssignmentsPlan(manifest, phaseIndex, assignments);
          persist('root_assignments_materialized', payload, [plan]);
          return Object.freeze({ ...plan.reference });
        },
        activateRoot(nodeId) {
          guard(); const at = Math.max(Date.now(), manifest.createdAt), n = nodeOf(state, nodeId);
          if (!n.assignment) fail('PARENT_NOT_ACTIVE', 'deferred root assignment unresolved');
          const timeout = state.scheduler.rootTimeouts[manifest.roots.findIndex(r => r.nodeId === nodeId)];
          const deadline = Math.min(n.authority.deadlineAt ?? Infinity, timeout === null ? Infinity : at + timeout);
          persist('root_activated', { nodeId, deadlineAt: deadline === Infinity ? null : deadline }, [], at);
          return deadline === Infinity ? null : deadline;
        },
        stopNode(nodeId, cause) {
          guard(); const n = nodeOf(state, nodeId);
          if (!n.result && !n.stopped) persist('node_stopped', { nodeId, cause });
        },
      };
      return Object.freeze(capability);
    },
    onOwnerLoss(listener) { guard(); ownerLossListeners.add(listener); return () => ownerLossListeners.delete(listener); } }));
  return writer;
}

/** Strict trusted inspection. Required external binding is not inferred from editable
 * artifacts. No partial-prefix trust, append handle, process signalling or credit reclaim.
 * Hash links detect corruption, not hostile same-user rewriting of all trusted anchors.
 */
export function inspectDelegationJournal(directory, binding) {
  canonicalDirectory(directory, true);
  object(binding, ['manifestDigest', 'runId', 'specDigest', 'profileDigest']);
  hash(binding.manifestDigest); hash(binding.specDigest); hash(binding.profileDigest); id(binding.runId);
  const manifestBytes = boundedRead(join(directory, 'manifest.json'), 1024 * 1024, { privateFile: true });
  if (sha256(manifestBytes) !== binding.manifestDigest) fail('OWNERSHIP_UNKNOWN', 'manifest binding');
  const manifest = validateManifest(decodeCanonical(manifestBytes));
  for (const key of ['runId', 'specDigest', 'profileDigest']) if (manifest[key] !== binding[key]) fail('OWNERSHIP_UNKNOWN', 'start binding');
  const bytes = boundedRead(join(directory, 'events.jsonl'), LIMITS.journalBytes, { privateFile: true });
  if (!bytes.length || bytes.at(-1) !== 10) fail('OWNERSHIP_UNKNOWN', 'empty/torn journal');
  const logText = bytes.toString('utf8');
  if (!Buffer.from(logText).equals(bytes)) fail('OWNERSHIP_UNKNOWN', 'invalid UTF-8 journal');
  let state = initialState(manifest), lastHash = binding.manifestDigest, usedBytes = 0;
  const ids = new Set(), prefixes = new Map();
  for (const line of logText.split('\n').slice(0, -1)) {
    const size = Buffer.byteLength(line) + 1;
    if (size > LIMITS.frameBytes) fail('OWNERSHIP_UNKNOWN', 'record bound');
    const event = decodeCanonical(Buffer.from(line));
    validateEnvelope(event, state, manifest, binding.manifestDigest, lastHash);
    if (ids.has(event.eventId)) fail('OWNERSHIP_UNKNOWN', 'event identity'); ids.add(event.eventId);
    const evidence = verifyEventArtifacts(event, state, manifest, ref => readStoredArtifact(directory, ref));
    const next = reduceEvent(state, event, manifest, evidence); checkCapacity(next, usedBytes, size, event.type);
    state = next; lastHash = event.hash; usedBytes += size;
    prefixes.set(state.sequence, { lastHash, usedBytes, stateDigest: sha256(canonicalJSON(state)) });
  }
  let projection = 'missing';
  try {
    const cached = decodeCanonical(boundedRead(join(directory, 'state.json'), 1024 * 1024, { privateFile: true }));
    object(cached, ['schema', 'resumable', 'manifestDigest', 'lastHash', 'usedBytes', 'state']);
    if (cached.schema !== STATE_SCHEMA || cached.resumable !== false || cached.manifestDigest !== binding.manifestDigest ||
        !Number.isSafeInteger(cached.state?.sequence) || cached.state.sequence > state.sequence) fail('OWNERSHIP_UNKNOWN', 'projection contradicts authority');
    const prefix = prefixes.get(cached.state.sequence);
    if (!prefix || cached.lastHash !== prefix.lastHash || cached.usedBytes !== prefix.usedBytes || sha256(canonicalJSON(cached.state)) !== prefix.stateDigest) fail('OWNERSHIP_UNKNOWN', 'projection mismatch');
    projection = cached.state.sequence === state.sequence ? 'current' : 'stale';
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { inspectionOnly: true, resumable: false, launchAuthorized: false, manifest, state, lastHash, usedBytes, reservedBytes: reservedBytes(state), projection,
    unresolved: state.nodes.filter(n => !n.closed).map(n => ({ nodeId: n.nodeId, classification: n.result ? n.joined ? 'joined_not_closed' : 'result_without_join' : n.pid ? 'started_without_result' : n.invocationId ? 'intent_without_start' : 'reserved_without_intent' })),
  };
}

// Main-chat/trusted inspection primitive only. Worker visibility/request accounting must
// be composed in the bridge; this function never accepts a workspace path from a worker.
export function readDelegationArtifactPage(directory, reference, request, visibleArtifactIds) {
  canonicalDirectory(directory, true);
  validateStoredReference(reference); validateContextRequest(request); list(visibleArtifactIds, 2048).forEach(artifactId);
  if (request.view !== 'artifact' || request.artifactId !== reference.artifactId || !visibleArtifactIds.includes(reference.artifactId)) fail('PERMISSION_DENIED');
  return projectArtifactRead(reference, readStoredArtifact(directory, reference), request, visibleArtifactIds);
}
