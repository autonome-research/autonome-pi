// Create-only single writer. NO open/recover/resume/dispatch API. Inspection below never
// mints capabilities or authorizes process launch. Keep disconnected from public v3.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { WORKFLOW_ARTIFACT_LAYOUT } from './artifact-layout.mjs';
import { object, list, text, integer, id, hash, fail, LIMITS, artifactId, validateContextRequest, validateDelegationPolicy, validateDelegationRequest, validateCompletionRequest } from './delegation-contract.mjs';
import { narrowAuthority, intersectTools } from './delegation-scope.mjs';
import { buildOwnChildJoinIndex, projectArtifactRead } from './delegation-context.mjs';
import { createScopedFilesystem } from './delegation-filesystem.mjs';
import { canonicalJSON, decodeCanonical, sha256, canonicalDirectory, boundedRead, storageIO, readStoredArtifact, validateStoredReference } from './delegation-storage.mjs';
import { JOURNAL_SCHEMA, MANIFEST_SCHEMA, STATE_SCHEMA, uuid, validateManifest, initialState, reduceEvent, checkCapacity,
  nodeOf, invocationNode, requestPrior, reservedBytes, completionAuthority, validateCandidate } from './delegation-journal-model.mjs';

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
const childResults = (s, parentId, extra) => s.nodes.filter(n => n.parentNodeId === parentId && (n.joined || n.nodeId === extra)).map(n => ({
  schema: 'pi-workflow-delegation-node-result/v1', childNodeId: n.nodeId, status: n.result.status,
  summary: '', resultHash: n.result.sha256, resultArtifactId: n.result.artifactId,
}));
function resultContent(bytes, s, n) {
  const content = decodeCanonical(bytes);
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
  if (event.type === 'root_reserved') manifest.roots.forEach(n => verifyIndex(read(n.index), s, n.nodeId, 0));
  if (event.type === 'delegation_accepted') p.children.forEach(n => verifyIndex(read(n.index), s, n.nodeId, 0));
  if (event.type === 'completion_submitted') {
    const n = invocationNode(s, p.invocationId);
    const c = validateCandidate(decodeCanonical(read(p.candidate)), s, n);
    if (p.digest !== sha256(canonicalJSON({ kind: 'complete', payload: c.request }))) fail('REQUEST_CONFLICT');
    c.evidence.forEach(e => read(e.reference));
  }
  if (event.type === 'node_result') {
    const c = resultContent(read(p.result), s, nodeOf(s, p.nodeId));
    if (c.status !== p.status || c.disposition !== p.disposition) fail('RESULT_INVALID');
  }
  if (event.type === 'node_joined') {
    const n = nodeOf(s, p.nodeId);
    if (n.parentNodeId) verifyIndex(read(p.parentIndex), s, n.parentNodeId, event.sequence, n.nodeId);
  }
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
  const io = storageIO(options.fault);
  const plans = [];
  const roots = options.roots.map(r => {
    object(r, ['phaseIndex', 'agentBudget', 'label', 'task', 'permissions', 'directoryScope', 'deadlineAt'], ['itemIndex']);
    const nodeId = randomUUID();
    const index = indexPlan(nodeId, 0, []); plans.push(index);
    return { nodeId, phaseIndex: r.phaseIndex, ...(r.itemIndex === undefined ? {} : { itemIndex: r.itemIndex }),
      agentBudget: r.agentBudget, label: r.label,
      assignment: { task: r.task, acceptance: [{ id: 'assignment', criterion: 'Satisfy the assigned phase task and cite supporting evidence.' }] },
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
  const publish = plan => io.publish(join(directory, 'nodes'), `${plan.reference.artifactId.slice(9)}.blob`, plan.bytes);
  function guard() { if (poisoned || stopped || busy || process.pid !== manifest.ownerPid) fail('OWNERSHIP_UNKNOWN', 'writer unavailable; inspection only'); }
  function persist(type, payload, artifacts = [], at = Math.max(Date.now(), manifest.createdAt)) {
    guard(); busy = true;
    try {
      const body = { schema: JOURNAL_SCHEMA, sequence: state.sequence + 1, eventId: randomUUID(), ownerEpoch: manifest.ownerEpoch,
        manifestDigest, previousHash: lastHash, at, type, payloadDigest: sha256(canonicalJSON(payload)), payload };
      const event = { ...body, hash: sha256(canonicalJSON(body)) };
      const bytes = Buffer.from(`${canonicalJSON(event)}\n`);
      const next = reduceEvent(state, event, manifest);
      checkCapacity(next, usedBytes, bytes.length, type);
      verifyEventArtifacts(event, state, manifest, ref => artifacts.find(a => canonicalJSON(a.reference) === canonicalJSON(ref))?.bytes ?? readStoredArtifact(directory, ref));
      // No disk mutation until reducers, encoded bytes, artifacts and projection fit.
      try {
        artifacts.forEach(publish);
        canonicalDirectory(directory, true);
        const opened = fs.fstatSync(fd), named = fs.lstatSync(join(directory, 'events.jsonl'));
        if (opened.size !== usedBytes || opened.ino !== named.ino || opened.dev !== named.dev ||
            !named.isFile() || named.nlink !== 1 || named.uid !== process.getuid() || (named.mode & 0o077)) fail('OWNERSHIP_UNKNOWN', 'journal replaced/changed');
        io.writeAll(fd, bytes); io.step('event-fsync', () => fs.fsyncSync(fd));
        state = next; lastHash = event.hash; usedBytes += bytes.length;
        const projection = encode({ schema: STATE_SCHEMA, resumable: false, manifestDigest, lastHash, usedBytes, state });
        if (projection.length > 1024 * 1024) fail('JOURNAL_LIMIT');
        io.publish(directory, 'state.json', projection, false);
      } catch (error) { poisoned = true; throw error; }
      return structuredClone(event);
    } finally { busy = false; }
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
  return Object.freeze({
    directory, binding: Object.freeze(binding),
    snapshot() { return structuredClone({ inspectionOnly: true, resumable: false, state, usedBytes, reservedBytes: reservedBytes(state), lastHash, poisoned }); },
    launchIntent(nodeId, processToken) {
      guard(); uuid(processToken);
      const n = nodeOf(state, nodeId);
      if (n.invocationId) {
        if (n.processToken !== processToken) fail('REQUEST_CONFLICT');
        return Object.freeze({ invocationId: n.invocationId, recordedNow: false });
      }
      const invocationId = randomUUID();
      try { processEntry(processToken, undefined); persist('launch_intent', { nodeId, invocationId, processToken }); }
      catch (error) { poisoned = true; throw error; } // reserve may already exist; never dispatch on failure
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
    acceptDelegation(invocationId, requestId, request) {
      guard(); const serialized = canonicalJSON(request);
      if (Buffer.byteLength(serialized) > LIMITS.frameBytes) fail('INVALID_REQUEST');
      const digest = sha256(canonicalJSON({ kind: 'delegate', payload: request }));
      if (duplicate(invocationId, requestId, digest)) return structuredClone(state.batches.find(b => b.invocationId === invocationId && b.requestId === requestId) ?? requestPrior(state, invocationId, requestId));
      try {
        validateDelegationRequest(request);
        const parent = invocationNode(state, invocationId);
        const artifacts = [], acceptedAt = Math.max(Date.now(), manifest.createdAt);
        const children = request.children.map(c => {
          const nodeId = randomUUID(), index = indexPlan(nodeId, 0, []); artifacts.push(index);
          const authority = narrowAuthority(parent.authority, c, acceptedAt);
          scopeCheck(() => createScopedFilesystem({ workspace, permissions: authority.permissions, directoryScope: authority.directoryScope, protectedDirectories: manifest.protectedDirectories }));
          return { nodeId, agentBudget: c.agentBudget, label: c.label, authority, index: index.reference,
            assignment: { task: c.task, acceptance: c.acceptance, ...(c.contextSummary === undefined ? {} : { parentContextSummary: c.contextSummary }) } };
        });
        const batchId = randomUUID();
        persist('delegation_accepted', { invocationId, requestId, digest, request: structuredClone(request), children, batchId }, artifacts, acceptedAt);
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
        validateCompletionRequest(request, completionAuthority(state, n));
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
      persist('node_result', { nodeId, result: result.reference, status: outcome.status, disposition }, [result]);
      return structuredClone(result.reference);
    },
    joinUnlaunched(nodeId) {
      guard(); const n = nodeOf(state, nodeId);
      if (n.joined) return structuredClone(n.result);
      if (n.invocationId || !n.result) fail('OWNERSHIP_UNKNOWN', 'launched settlement deferred');
      const plan = n.parentNodeId ? indexPlan(n.parentNodeId, state.sequence + 1, childResults(state, n.parentNodeId, n.nodeId)) : null;
      persist('node_joined', { nodeId, resultHash: n.result.sha256, parentIndex: plan?.reference ?? null }, plan ? [plan] : []);
      return structuredClone(nodeOf(state, nodeId).result);
    },
    joinBatch(batchId) {
      guard(); if (state.batches.find(b => b.batchId === batchId)?.joined) return;
      persist('delegation_joined', { batchId }); // no second credit return
    },
    closeNode(nodeId) { guard(); if (!nodeOf(state, nodeId).closed) persist('node_closed', { nodeId }); },
    closeWorkflow() { guard(); if (state.workflowOpen) persist('workflow_delegation_closed', {}); },
    dispose() { if (!stopped) { stopped = true; fs.closeSync(fd); } },
  });
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
    verifyEventArtifacts(event, state, manifest, ref => readStoredArtifact(directory, ref));
    const next = reduceEvent(state, event, manifest); checkCapacity(next, usedBytes, size, event.type);
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
