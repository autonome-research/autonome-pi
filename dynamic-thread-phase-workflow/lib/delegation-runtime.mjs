// INTERNAL runner-local scheduling. No public decoder, worker transport or recovery.
import { PipelineCache, runPipeline } from '@autonome-research/thread-phase';
import { boundedFanout } from '@autonome-research/thread-phase/patterns';
import { claimDelegationScheduler, inspectDelegationJournal, readDelegationArtifactPage } from './delegation-journal.mjs';
import { createDelegationExecutor, guardDelegationExecutor, takeExecutorDenial } from './delegation-executor.mjs';
import { createDelegationResults } from './delegation-results.mjs';
import { buildDelegationContext, projectArtifactRead } from './delegation-context.mjs';
import { allocationCounters } from './delegation-budget.mjs';
import { canonicalJSON, decodeCanonical, readStoredArtifact, sha256 } from './delegation-storage.mjs';
import { createScopedFilesystem } from './delegation-filesystem.mjs';
import { leasesConflict } from './delegation-scope.mjs';
import { effectiveAuthority } from './delegation-journal-model.mjs';
import { MAX_TIMEOUT_MS, createCallbackLifetime } from './subprocess.mjs';
import { object, list, integer, text, id, fail } from './delegation-contract.mjs';

function immutable(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}
function validatePriorReferences(template, prior) {
  for (const match of String(template).matchAll(/\{\{\s*(?:output:|outputs\.)([^}\s]+)\s*\}\}/gu))
    if (!prior.has(match[1])) fail('INVALID_REQUEST', `unknown or forward phase output: ${match[1]}`);
}
export function delegationLaneCap(maxDepth, concurrency = 3, operator = {}) {
  object(operator, [], ['maxConcurrentAgents', 'maxLiveAgents']);
  integer(maxDepth, 0, 4); integer(concurrency, 1, 64);
  const execution = integer(operator.maxConcurrentAgents ?? 3, 1, 16);
  const live = integer(operator.maxLiveAgents ?? 24, 1, 128);
  const lanes = Math.min(concurrency, execution, Math.floor(live / (maxDepth + 1)));
  if (!lanes) fail('ADMISSION_LIMIT', 'D+1 live slots required before spawn');
  return lanes;
}

export function createDelegationRuntime(options) {
  object(options, ['journal', 'processJournal', 'phases', 'worker'],
    ['operator', 'deadlinePolicy', 'signal', 'onInvocation', 'onEvent', 'bridge', 'render', 'emitArtifact']);
  const { journal, processJournal, worker, signal, onInvocation, onEvent, bridge, render, emitArtifact } = options;
  if (typeof worker !== 'function' || onInvocation !== undefined && typeof onInvocation !== 'function' ||
      onEvent !== undefined && typeof onEvent !== 'function' || render !== undefined && typeof render !== 'function' ||
      emitArtifact !== undefined && typeof emitArtifact !== 'function' || bridge !== undefined &&
      (!bridge || typeof bridge.prepare !== 'function' || typeof bridge.bind !== 'function' || typeof bridge.close !== 'function')) fail('INVALID_REQUEST');
  if (options.operator !== undefined) object(options.operator, [], ['maxConcurrentAgents', 'maxLiveAgents']);
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_REQUEST', 'AbortSignal required');
  const operator = { maxConcurrentAgents: 3, maxLiveAgents: 24, ...options.operator };
  object(operator, ['maxConcurrentAgents', 'maxLiveAgents']);
  let policy = options.deadlinePolicy === undefined ? {} : options.deadlinePolicy;
  object(policy, [], ['workflowTimeoutMs', 'defaultTimeoutMs', 'supervised']);
  for (const key of ['workflowTimeoutMs', 'defaultTimeoutMs']) if (policy[key] !== undefined) integer(policy[key], 1, 2147483647);
  if (policy.supervised !== undefined && typeof policy.supervised !== 'boolean') fail('INVALID_REQUEST');
  policy = Object.freeze({ ...policy });
  const timeout = (phase, shell = false) => phase.timeoutMs ?? policy.workflowTimeoutMs ??
    (!shell && policy.supervised === true ? null : policy.defaultTimeoutMs ?? 600000);
  // Inspection checks immutable plan binding, but ONLY the subsequent original
  // live-writer claim can grant scheduling. Existing/log-replayed work is denied.
  const { manifest } = inspectDelegationJournal(journal.directory, journal.binding);
  const phases = structuredClone(options.phases);
  list(phases, 30, 1);
  const names = new Set(), enumerated = [];
  phases.forEach((p, phaseIndex) => {
    if (p.type === 'agent') object(p, ['type', 'name'], ['timeoutMs']);
    else if (p.type === 'fanout') {
      object(p, ['type', 'name', 'items'], ['concurrency', 'timeoutMs', 'failOnItemFailure']);
      list(p.items, 128, 1).forEach(v => text(v, 4096, true));
      if (p.failOnItemFailure !== undefined && typeof p.failOnItemFailure !== 'boolean') fail('INVALID_REQUEST');
    } else if (p.type === 'shell') {
      object(p, ['type', 'name', 'command', 'permissions'], ['timeoutMs']); text(p.command, 16384); validatePriorReferences(p.command, names);
      if (p.permissions !== 'rwx') fail('PERMISSION_DENIED');
    } else if (p.type === 'artifact') {
      object(p, ['type', 'name'], ['from']);
      if (p.from !== undefined && (!names.has(p.from) || typeof p.from !== 'string')) fail('INVALID_REQUEST', 'artifact source must be prior phase');
      if (!emitArtifact || p.from === undefined && !render) fail('UNSUPPORTED_MODE', 'artifact callbacks required');
    } else fail('UNSUPPORTED_MODE', 'static internal agent/fanout/shell/artifact phases only');
    text(p.name, 80); if (names.has(p.name)) fail('INVALID_REQUEST'); names.add(p.name);
    if (p.timeoutMs !== undefined) integer(p.timeoutMs, 1, 2147483647);
    if (p.type === 'agent' || p.type === 'fanout') {
      delegationLaneCap(manifest.policy.maxDepth, p.concurrency ?? 3, operator);
      for (const root of manifest.roots.filter(n => n.phaseIndex === phaseIndex)) {
        if (root.taskTemplate !== undefined) validatePriorReferences(root.taskTemplate, new Set([...names].filter(name => name !== p.name)));
        if (root.contextTemplate !== undefined) validatePriorReferences(root.contextTemplate, new Set([...names].filter(name => name !== p.name)));
      }
      for (let itemIndex = 0; itemIndex < (p.items?.length ?? 1); itemIndex++) enumerated.push({ phaseIndex, itemIndex: p.items ? itemIndex : undefined });
    }
  });
  if (enumerated.length !== manifest.roots.length || enumerated.some((r, i) =>
    r.phaseIndex !== manifest.roots[i].phaseIndex || r.itemIndex !== manifest.roots[i].itemIndex)) fail('INVALID_REQUEST', 'static manifest root enumeration');
  for (const p of phases.map((phase, phaseIndex) => ({ phase, phaseIndex }))) {
    const roots = manifest.roots.filter(n => n.phaseIndex === p.phaseIndex);
    const deferred = roots.filter(n => n.taskTemplate !== undefined).length;
    if (deferred && (deferred !== roots.length || !render)) fail('UNSUPPORTED_MODE', 'deferred roots require one trusted phase renderer');
  }
  const authority = claimDelegationScheduler(journal, { ...operator, rootTimeouts: manifest.roots.map(n => timeout(phases[n.phaseIndex])) });
  const executor = createDelegationExecutor({ journal, processJournal });
  const results = createDelegationResults({ journal, executor });
  const nodes = new Map(), lanes = new Map(), waiters = [];
  const eventCallbacks = createCallbackLifetime();
  let ran = false, held = false, cancelled = false, failure = false, calls = 0, phaseIndex = -1, declared = null;
  const outputs = {};
  let reportHeld;
  const heldDiagnostic = new Promise(resolve => { reportHeld = resolve; });
  // ponytail: scan detached snapshots at <=128 nodes; add indexed live reads
  // only if measured tool-call overhead warrants another authority seam.
  const state = () => journal.snapshot().state;
  const durable = nodeId => state().nodes.find(n => n.nodeId === nodeId);
  function guard() {
    if (held) fail('OWNERSHIP_UNKNOWN', 'held scheduler; no continuation');
    try { authority.guard(); guardDelegationExecutor(executor); }
    catch (error) { hold(); throw error; }
  }
  function hold() {
    if (held) return;
    held = true;
    // A scheduler/write ambiguity may still have live cooperative cancellation
    // authority. Observe that authority BEFORE acting; actual loss forbids it.
    try {
      authority.guard(); guardDelegationExecutor(executor);
      for (const n of nodes.values()) if (!n.joined) { n.controller.abort('scheduler held'); n.shellController.abort('scheduler held'); }
      declared?.abort('scheduler held');
    } catch { /* observed loss: no further executor action */ }
    reportHeld(); eventCallbacks.close(); signal?.removeEventListener('abort', cancel);
    for (const n of nodes.values()) {
      n.callbacks.close(); clearTimeout(n.timer); n.timer = null;
      if (!n.joined) n.mode = 'unknown';
    }
    while (waiters.length) waiters.shift().reject(new Error('OWNERSHIP_UNKNOWN: held lanes/leases'));
    // No revoke-before-cancel, no PID fallback. Actual authority loss already
    // invalidates executor actions; diagnostic return cannot reclaim these lanes.
  }
  function summary(n) {
    const d = durable(n.nodeId);
    return immutable({ nodeId: n.nodeId, parentNodeId: d.parentNodeId, label: d.label,
      state: n.mode, deadlineAt: n.deadlineAt, joined: n.joined, result: d.result });
  }
  function emit(kind, n) {
    if (!onEvent) return;
    const failed = () => { failure = true; stopAll('infrastructure_error'); };
    eventCallbacks.call(onEvent, [immutable({ kind, phaseIndex, ...(n ? { node: summary(n) } : {}) })], failed);
  }
  async function trustedCallback(callback, input) {
    const lifetime = createCallbackLifetime();
    let value, error;
    lifetime.call(() => Promise.resolve(callback(immutable(structuredClone(input)))).then(result => { value = result; }), [], caught => { error = caught; });
    await lifetime.seal();
    guard();
    if (cancelled || failure) fail('CANCELLED');
    if (error) fail('CALLBACK_ERROR', 'trusted phase callback failed');
    return value;
  }
  function setOutput(name, value) {
    const next = structuredClone(value);
    if (Buffer.byteLength(canonicalJSON(next)) > 1024 * 1024) fail('RESULT_INVALID', 'phase output bound');
    outputs[name] = immutable(next);
    if (Buffer.byteLength(canonicalJSON(outputs)) > 2 * 1024 * 1024) fail('RESULT_INVALID', 'phase output cache bound');
    return outputs[name];
  }
  function verifiedRootOutput(root) {
    try {
      const n = durable(root.nodeId);
      if (!n.joined || !n.result) fail('OWNERSHIP_UNKNOWN', 'root output before structural join');
      const reference = { artifactId: n.result.artifactId, bytes: n.result.bytes, sha256: n.result.sha256 };
      const content = decodeCanonical(readStoredArtifact(journal.directory, reference));
      if (content.nodeId !== n.nodeId || content.status !== n.result.status || typeof content.summary !== 'string' || Buffer.byteLength(content.summary) > 4096)
        fail('RESULT_INVALID', 'root result evidence');
      return { nodeId: n.nodeId, phaseIndex: root.phaseIndex, ...(root.itemIndex === undefined ? {} : { itemIndex: root.itemIndex }),
        label: n.label, status: n.result.status, summary: content.summary, cause: content.cause, result: reference };
    } catch (error) { hold(); throw error; }
  }
  function verifiedResultSummary(nodeId) {
    const d = durable(nodeId);
    if (!d.joined || !d.result) fail('OWNERSHIP_UNKNOWN', 'result summary before structural join');
    const content = decodeCanonical(readStoredArtifact(journal.directory,
      { artifactId: d.result.artifactId, bytes: d.result.bytes, sha256: d.result.sha256 }));
    if (content.nodeId !== nodeId || content.status !== d.result.status ||
        typeof content.summary !== 'string' || Buffer.byteLength(content.summary) > 4096)
      fail('RESULT_INVALID', 'result evidence binding');
    return content.summary; // from the immutable artifact, never worker-mutable output
  }
  async function materializeRoots(p, index, roots) {
    if (!roots.length || roots[0].taskTemplate === undefined) return;
    const rendered = await trustedCallback(render, { kind: 'roots', phaseIndex: index, phase: p,
      roots: roots.map(n => ({ nodeId: n.nodeId, phaseIndex: n.phaseIndex,
        ...(n.itemIndex === undefined ? {} : { itemIndex: n.itemIndex }), label: n.label,
        taskTemplate: n.taskTemplate, ...(n.contextTemplate === undefined ? {} : { contextTemplate: n.contextTemplate }), templateHash: n.templateHash })),
      outputs });
    list(rendered, roots.length, roots.length);
    const assignments = rendered.map((value, i) => {
      if (typeof value === 'string') value = { task: value };
      object(value, ['task'], ['parentContextSummary']); text(value.task, 4096);
      if (value.parentContextSummary !== undefined) text(value.parentContextSummary, 2048, true);
      return { nodeId: roots[i].nodeId, task: value.task,
        ...(value.parentContextSummary === undefined ? {} : { parentContextSummary: value.parentContextSummary }) };
    });
    guard();
    authority.materializePhase(index, assignments);
    guard();
  }
  function entry(nodeId) {
    let n = nodes.get(nodeId);
    if (!n) {
      const d = durable(nodeId);
      n = { nodeId, mode: 'queued', deadlineAt: effectiveAuthority(d).deadlineAt, controller: new AbortController(), shellController: new AbortController(),
        timer: null, callbacks: createCallbackLifetime(), stopCause: null, joined: false, calls: 0, requests: new Map(), nextShell: 2, batch: null, scope: null, workerDone: false };
      nodes.set(nodeId, n);
    }
    return n;
  }
  function stopTree(n, cause) {
    if (held || n.joined) return;
    const ids = new Set([n.nodeId]);
    for (const d of state().nodes) if (ids.has(d.parentNodeId)) ids.add(d.nodeId);
    try {
      for (const nodeId of ids) {
        const child = entry(nodeId);
        if (child.joined || child.stopCause) continue;
        child.stopCause = cause; child.mode = 'stopping';
        authority.stopNode(nodeId, cause);
      }
      // Persist causes first; then cooperate with still-live executor ownership.
      for (const nodeId of ids) {
        const child = nodes.get(nodeId);
        child.controller.abort(cause); child.shellController.abort(cause);
      }
    } catch { hold(); }
  }
  function workerStopped(n) {
    if (n.joined || held) return;
    n.workerDone = true; n.mode = 'stopping'; // Veto first, never drain proof.
    guard();
    // The shell owns a separate anchored group. Cancel it without aborting the
    // worker signal or recording a node stop that would erase its original cause.
    n.shellController.abort('worker stopped');
    guard(); // Cancellation itself can synchronously observe channel loss.
    for (const child of state().nodes.filter(c => c.parentNodeId === n.nodeId && !c.joined))
      stopTree(entry(child.nodeId), n.stopCause ?? 'infrastructure_error');
  }
  function stopAll(cause) {
    for (const root of manifest.roots) stopTree(entry(root.nodeId), cause);
    declared?.abort(cause);
    pump();
  }
  function cancel() { cancelled = true; stopAll('cancelled'); }
  function arm(n) {
    if (held || cancelled || n.stopCause || n.deadlineAt === null || n.timer || n.joined) return;
    const remaining = n.deadlineAt - Date.now();
    if (remaining <= 0) stopTree(n, 'timeout');
    else {
      n.timer = setTimeout(() => {
        n.timer = null;
        if (held || cancelled || n.stopCause || n.joined) return;
        try { guard(); arm(n); } catch { /* guard holds lost authority; never rearm it */ }
      }, Math.min(remaining, MAX_TIMEOUT_MS));
      n.timer.unref();
    }
  }
  function check(n) {
    guard();
    if (n.deadlineAt !== null && Date.now() >= n.deadlineAt) stopTree(n, 'timeout');
    const frozen = state().commandScopes?.find(s => s.scopeId === n.scope?.scopeId)?.frozen;
    guard();
    if (n.stopCause || cancelled || failure) fail(n.stopCause === 'timeout' ? 'DEADLINE_EXPIRED' : 'CANCELLED');
    if (n.mode !== 'active' || n.workerDone || frozen) fail('PARENT_NOT_ACTIVE');
  }
  function restore(n, mode) {
    guard();
    if (n.deadlineAt !== null && Date.now() >= n.deadlineAt) stopTree(n, 'timeout');
    guard();
    if (n.mode === mode && !n.stopCause && !n.workerDone && !cancelled && !failure &&
        !state().commandScopes?.find(s => s.scopeId === n.scope?.scopeId)?.frozen) n.mode = 'active';
  }
  function count(n) {
    guard();
    if (++calls > 4096 || ++n.calls > 128) { stopTree(n, 'infrastructure_error'); fail('REQUEST_LIMIT'); }
  }
  function requestOnce(n, requestId, kind, payload, action) {
    count(n); id(requestId);
    const encoded = canonicalJSON({ kind, payload });
    if (Buffer.byteLength(encoded) > 65536) fail('INVALID_REQUEST');
    const digest = sha256(encoded), prior = n.requests.get(requestId);
    if (prior) {
      if (prior.digest !== digest) fail('REQUEST_CONFLICT');
      if (prior.error) throw prior.error;
      return prior.value;
    }
    const record = { digest }; n.requests.set(requestId, record);
    try { check(n); record.value = action(); return record.value; }
    catch (error) { record.error = error; throw error; }
  }
  function finishBatch(batch) {
    if (!batch.children.every(id => durable(id).joined)) fail('OWNERSHIP_UNKNOWN');
    journal.joinBatch(batch.batchId);
    for (const id of batch.children) journal.closeNode(id);
  }
  function unlaunched(n, cause) {
    guard();
    journal.recordFailure(n.nodeId, { status: cause, summary: 'Accepted work did not launch', cause: cause.toUpperCase(), usageCompleteness: 'missing' });
    journal.joinUnlaunched(n.nodeId);
    const batch = state().batches.find(b => b.children.includes(n.nodeId));
    if (!batch) journal.closeNode(n.nodeId);
    else if (batch.children.every(id => durable(id).joined)) finishBatch(batch);
    settled(n);
    return summary(n);
  }
  function settled(n) {
    n.joined = true; n.mode = 'joined'; clearTimeout(n.timer); n.timer = null;
    emit('joined', n);
  }
  function contextState(d) {
    if (d.joined) return 'joined';
    if (d.result) return d.result.status === 'cancelled' ? 'cancelled' : 'failed';
    if (d.stopped) return d.stopped === 'cancelled' ? 'cancelled' : 'failed';
    return ({ waiting_children: 'waiting_children', result_pending_exit: 'result_pending_exit', running: 'running' })[d.schedulerState] ?? 'queued';
  }
  function treeRoot(d, all) {
    let current = d;
    while (current.parentNodeId) current = all.find(n => n.nodeId === current.parentNodeId);
    return current;
  }
  function visibleReferences(s, n) {
    return [...(n.inheritedEvidence ?? []).map(e => e.reference),
      ...s.nodes.filter(c => c.parentNodeId === n.nodeId && c.joined && c.result).map(c => ({
        artifactId: c.result.artifactId, bytes: c.result.bytes, sha256: c.result.sha256,
      })), n.index];
  }
  function page(reference, request) {
    return readDelegationArtifactPage(journal.directory, reference, request, [reference.artifactId]);
  }
  function scopedRead(action) {
    try { return action(); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) throw new Error('SCOPE_DENIED: path unavailable');
      if (['EACCES', 'EPERM'].includes(error?.code)) throw new Error('PERMISSION_DENIED: path access');
      throw error;
    }
  }
  function contextFor(n) {
    const s = state(), d = durable(n.nodeId), all = s.nodes;
    const nodes = all.map(item => {
      const root = treeRoot(item, all);
      return { nodeId: item.nodeId, treeRootNodeId: root.nodeId,
        ...(item.parentNodeId ? { parentNodeId: item.parentNodeId } : {}), phaseIndex: root.phaseIndex ?? 0,
        ...(item.itemIndex === undefined ? {} : { itemIndex: item.itemIndex }), depth: root.nodeId === item.nodeId ? 0 : allocationDepth(item, all),
        label: item.label, state: contextState(item), task: item.assignment?.task ?? item.taskTemplate, scopePreview: JSON.stringify(item.authority.directoryScope),
        createdSequence: 1, ...(item.result ? { resultArtifactId: item.result.artifactId, resultStatus: item.result.status } : {}) };
    });
    const selfNode = nodes.find(item => item.nodeId === d.nodeId);
    const counters = allocationCounters(s.budget, d.nodeId);
    const joinedChildren = all.filter(item => item.parentNodeId === d.nodeId && item.joined);
    const indexReference = { ...d.index, revision: joinedChildren.length ? s.sequence : 0, childCount: joinedChildren.length };
    const ancestors = [];
    let current = d;
    while (current.parentNodeId) { current = all.find(item => item.nodeId === current.parentNodeId); ancestors.unshift({ nodeId: current.nodeId, label: current.label, constraintsSummary: current.assignment.parentContextSummary ?? '' }); }
    const evidence = visibleReferences(s, d).map(reference => {
      const bytes = readStoredArtifact(journal.directory, reference);
      return { artifactId: reference.artifactId, ownerNodeId: d.nodeId, bytes: reference.bytes, sha256: reference.sha256,
        preview: bytes.subarray(0, 160).toString('utf8') };
    });
    return buildDelegationContext({ runId: manifest.runId, budgetScopeId: manifest.budgetScopeId,
      directoryRevision: s.sequence, asOfEventSequence: s.sequence, workflowContext: manifest.policy.context,
      self: { nodeId: d.nodeId, treeRootNodeId: selfNode.treeRootNodeId, ...(d.parentNodeId ? { parentNodeId: d.parentNodeId } : {}),
        depth: selfNode.depth, state: selfNode.state, label: d.label, grantedPermissions: d.authority.permissions,
        grantedTools: d.authority.grantedTools, directoryScope: d.authority.directoryScope,
        ...(effectiveAuthority(d).deadlineAt === null ? {} : { deadlineAt: effectiveAuthority(d).deadlineAt }),
        agentBudget: counters.agentBudget, spent: counters.spent, available: counters.available, reservedForChildren: counters.reservedForChildren },
      assignment: d.assignment, ancestors, nodes, evidence, inheritedArtifactIds: (d.inheritedEvidence ?? []).map(e => e.reference.artifactId), ownChildJoinIndex: indexReference });
  }
  function allocationDepth(item, all) {
    let depth = 0, current = item;
    while (current.parentNodeId) { depth++; current = all.find(n => n.nodeId === current.parentNodeId); }
    return depth;
  }
  function nodeHandle(n) {
    const d = durable(n.nodeId);
    const files = createScopedFilesystem({ workspace: manifest.workspace, permissions: d.authority.permissions,
      directoryScope: d.authority.directoryScope, protectedDirectories: manifest.protectedDirectories },
    { guard: () => check(n), onMutationError: hold });
    return Object.freeze({
      assignment: immutable({ ...structuredClone(d.assignment), authority: effectiveAuthority(d), nodeId: n.nodeId }),
      inspect() { count(n); return summary(n); },
      revision() { count(n); check(n); return state().sequence; },
      directoryRevision() { guard(); return state().sequence; },
      repeat(requestId) { count(n); id(requestId); check(n); return true; },
      context(requestId) { return requestOnce(n, requestId, 'context', {}, () => contextFor(n)); },
      artifact(requestId, request) { return requestOnce(n, requestId, 'artifact', request, () => {
        check(n); const refs = visibleReferences(state(), durable(n.nodeId));
        const reference = refs.find(ref => ref.artifactId === request.artifactId);
        if (!reference) fail('PERMISSION_DENIED');
        return page(reference, request);
      }); },
      fileRead(requestId, path, maxBytes) { return requestOnce(n, requestId, 'file_read', { path, maxBytes }, () => {
        check(n); return scopedRead(() => files.readFile(path, maxBytes));
      }); },
      fileGrep(requestId, path, pattern) { return requestOnce(n, requestId, 'file_grep', { path, pattern }, () => { check(n); return scopedRead(() => files.grep(path, pattern)); }); },
      fileFind(requestId, path) { return requestOnce(n, requestId, 'file_find', { path }, () => { check(n); return scopedRead(() => files.find(path)); }); },
      fileLs(requestId, path) { return requestOnce(n, requestId, 'file_ls', { path }, () => { check(n); return scopedRead(() => files.ls(path)); }); },
      fileWrite(requestId, path, bytes) { return requestOnce(n, requestId, 'file_write', { path, bytes: Buffer.from(bytes).toString('base64') }, () => { check(n); return files.writeFile(path, bytes); }); },
      fileEdit(requestId, path, oldText, newText) { return requestOnce(n, requestId, 'file_edit', { path, oldText, newText }, () => { check(n); return files.editFile(path, oldText, newText); }); },
      readFile(...args) {
        count(n); check(n);
        try { return files.readFile(...args); }
        catch (error) { check(n); if (error.message.startsWith('OWNERSHIP_UNKNOWN:')) hold(); throw error; }
      },
      writeFile(...args) {
        count(n); check(n);
        try { return files.writeFile(...args); }
        catch (error) { if (!held) check(n); if (!/^(SCOPE_DENIED|INVALID_REQUEST|RESULT_INVALID):/.test(error.message)) hold(); throw error; }
      },
      editFile(...args) {
        count(n); check(n);
        try { return files.editFile(...args); }
        catch (error) { if (!held) check(n); if (!/^(SCOPE_DENIED|INVALID_REQUEST|RESULT_INVALID):/.test(error.message)) hold(); throw error; }
      },
      delegate(requestId, request) { return requestOnce(n, requestId, 'delegate', request, () => {
        n.mode = 'admitting';
        let batch;
        try { batch = journal.acceptDelegation(n.scope.invocationId, requestId, request); }
        catch (error) {
          restore(n, 'admitting'); throw error;
        }
        n.mode = 'parked';
        batch.children.forEach(id => arm(entry(id)));
        // Start in a microtask so reentrant calls see parked state and the exact
        // occurrence promise BEFORE any child callback can run.
        const promise = Promise.resolve().then(async () => {
          emit('parked', n);
          const ordered = [];
          for (const id of batch.children) {
            guard(); const child = entry(id);
            if (n.stopCause) stopTree(child, n.stopCause);
            ordered.push(await runNode(child));
          }
          finishBatch(batch); guard();
          const entries = ordered.map(s => ({ ...s, summary: verifiedResultSummary(s.nodeId) }));
          restore(n, 'parked'); if (n.mode === 'active') emit('restored', n);
          return immutable(entries);
        }).catch(error => { hold(); throw error; });
        n.batch = promise;
        promise.catch(() => {}); // Also awaited by runNode even if the bridge disconnects.
        return promise;
      }); },
      complete(requestId, request) { return requestOnce(n, requestId, 'complete', request, () => {
        n.mode = 'completing';
        try {
          return immutable(journal.submitCompletion(n.scope.invocationId, requestId, request));
        } catch (error) {
          restore(n, 'completing'); throw error;
        }
      }); },
      shell(requestId, command, timeoutMs) { return requestOnce(n, requestId, 'shell', { command, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, () => {
        text(command, 16384); if (timeoutMs !== undefined) integer(timeoutMs, 1, 3600000);
        if (d.authority.permissions !== 'rwx') fail('PERMISSION_DENIED');
        n.mode = 'shell';
        const bound = Math.min(timeoutMs ?? policy.defaultTimeoutMs ?? 600000, n.deadlineAt === null ? Infinity : n.deadlineAt - Date.now());
        let commandResult;
        try {
          commandResult = executor.runShell(n.scope, n.nextShell++, '/bin/sh', ['-c', command],
            // matches runnerBashOperations in worker/adapter-primitives.mjs
            { cwd: manifest.workspace, env: {}, signal: n.shellController.signal, timeoutMs: Math.max(1, bound), maxStdoutBytes: 8192, maxStderrBytes: 16384 });
        } catch (error) {
          if (takeExecutorDenial(executor, error, n.scope, 'shell')) restore(n, 'shell');
          else hold();
          throw error;
        }
        const promise = commandResult.then(outcome => {
          if (outcome.disposition === 'unknown') { hold(); fail('OWNERSHIP_UNKNOWN'); }
          restore(n, 'shell');
          return immutable({ ok: outcome.ok, classification: outcome.classification, stdout: outcome.stdout, stderr: outcome.stderr });
        }).catch(error => { hold(); throw error; });
        promise.catch(() => {}); return promise;
      }); },
      disconnect() { count(n); stopTree(n, 'infrastructure_error'); },
    });
  }
  async function runNode(n) {
    guard(); arm(n);
    if (n.stopCause || cancelled || failure) return unlaunched(n, n.stopCause ?? (cancelled ? 'cancelled' : 'infrastructure_error'));
    let recipe, prepared;
    try {
      recipe = worker(immutable(structuredClone(durable(n.nodeId))));
      object(recipe, ['command', 'args'], ['env', 'onStdout', 'onStderr', 'onChildStart', 'tools']);
      if (recipe.tools !== undefined) list(recipe.tools, 32, 1).forEach(name => text(name, 64));
      text(recipe.command, 4096); list(recipe.args, 128).forEach(a => text(a, 16384, true));
    } catch { return unlaunched(n, 'infrastructure_error'); }
    try {
      // Trusted callback/recipe, never model-authorized executable/options.
      arm(n); if (n.deadlineAt !== null && n.deadlineAt <= Date.now()) stopTree(n, 'timeout');
      if (n.stopCause) return unlaunched(n, n.stopCause);
      if (bridge) {
        const depth = allocationDepth(durable(n.nodeId), state().nodes);
        const tools = recipe.tools ?? [...durable(n.nodeId).authority.grantedTools, 'workflow_context', 'workflow_complete',
          ...(depth < manifest.policy.maxDepth ? ['workflow_delegate'] : [])];
        prepared = bridge.prepare(n.nodeId, tools);
      }
      if (prepared !== undefined && (!prepared || !Buffer.isBuffer(prepared.bootstrap) || prepared.bootstrap.length > 4096)) fail('INVALID_REQUEST', 'worker bootstrap');
      const remaining = n.deadlineAt === null ? null : n.deadlineAt - Date.now();
      const launched = results.startInvocation(n.nodeId, recipe.command, recipe.args, {
        cwd: manifest.workspace, env: recipe.env ?? {}, signal: n.controller.signal,
        ...(remaining === null || remaining > MAX_TIMEOUT_MS ? { noDeadline: true } : { timeoutMs: Math.max(1, remaining) }),
        ...(prepared ? { workerBootstrap: prepared.bootstrap } : {}),
        ...(recipe.onStdout ? { onStdout: recipe.onStdout } : {}),
        ...(recipe.onStderr ? { onStderr: recipe.onStderr } : {}),
        onChildStart(child) {
          if (n.deadlineAt !== null && n.deadlineAt <= Date.now()) stopTree(n, 'timeout');
          return recipe.onChildStart?.(child);
        },
      });
      n.scope = launched.scope; guard();
      n.mode = n.stopCause || n.workerDone ? 'stopping' : 'active';
      if (n.mode === 'active') emit('running', n);
      const handle = nodeHandle(n);
      if (prepared) bridge.bind(n.nodeId, handle, n.scope.invocationId);
      if (onInvocation) Promise.resolve().then(() => {
        if (n.stopCause || n.workerDone || held) return;
        n.callbacks.call(onInvocation, [handle], () => stopTree(n, 'infrastructure_error'));
      }).catch(() => stopTree(n, 'infrastructure_error'));
      const outcome = await launched.result;
      if (outcome.disposition === 'unknown') { hold(); fail('OWNERSHIP_UNKNOWN'); }
      workerStopped(n);
      if (prepared) bridge.close(n.nodeId);
      n.mode = 'settling';
      // Receipt consumption is irreversible: subtree joins FIRST, whole scope
      // drain SECOND, actual coordinator publication/join LAST.
      if (n.batch) await n.batch;
      await n.callbacks.seal();
      await eventCallbacks.drain();
      guard(); const settlement = await executor.settleScope(n.scope);
      if (!settlement.receipt) { hold(); fail('OWNERSHIP_UNKNOWN'); }
      const reference = await results.finalize(n.scope, settlement.receipt);
      results.join(n.scope, reference); settled(n);
      await eventCallbacks.drain(); guard();
      return summary(n);
    } catch (error) {
      if (prepared) { try { bridge.close(n.nodeId); } catch {} }
      if (!n.scope && takeExecutorDenial(executor, error, n.nodeId, 'timeout')) {
        stopTree(n, 'timeout'); return unlaunched(n, 'timeout');
      }
      hold(); throw error;
    }
  }
  function pump() {
    if (held) return;
    // ponytail: strict FIFO head-of-line blocking; add compatible bypass only
    // with an explicit fairness contract. Waiting tickets occupy NO live slots.
    while (waiters.length) {
      const w = waiters[0];
      if (cancelled || failure || entry(w.root.nodeId).stopCause) { waiters.shift(); w.resolve(false); continue; }
      if (lanes.size >= w.cap || [...lanes.values()].some(r => leasesConflict(r.authority, w.root.authority))) break;
      waiters.shift(); lanes.set(w.root.nodeId, w.root); w.resolve(true);
    }
  }
  function acquire(root, cap) { return new Promise((resolve, reject) => { waiters.push({ root, cap, resolve, reject }); pump(); }); }
  async function rootsPhase(p, index) {
    const roots = manifest.roots.filter(n => n.phaseIndex === index);
    await materializeRoots(p, index, roots);
    const cap = delegationLaneCap(manifest.policy.maxDepth, p.type === 'agent' ? 1 : p.concurrency ?? 3, operator);
    const values = await boundedFanout({ items: roots, concurrency: cap, runner: async root => { try {
      const n = entry(root.nodeId), admitted = await acquire(root, cap);
      if (!admitted) return unlaunched(n, n.stopCause ?? 'cancelled');
      guard();
      if (!n.stopCause && !cancelled && !failure) { n.deadlineAt = authority.activateRoot(root.nodeId); arm(n); }
      const result = await runNode(n);
      guard(); if (!n.joined) fail('OWNERSHIP_UNKNOWN');
      lanes.delete(root.nodeId); pump(); return result;
    } catch (error) { hold(); throw error; } } });
    setOutput(p.name, p.type === 'agent' ? verifiedRootOutput(roots[0]) : roots.map(verifiedRootOutput));
    if (values.some(v => !['success', 'partial'].includes(v.result.status)) && p.failOnItemFailure !== false) fail('PHASE_FAILED');
  }
  async function shellPhase(p, index) {
    guard(); if (lanes.size || waiters.length) fail('OWNERSHIP_UNKNOWN');
    let commandText = p.command;
    if (render) {
      commandText = await trustedCallback(render, { kind: 'shell', phaseIndex: index, phase: p, value: p.command, outputs });
      text(commandText, 16384);
    }
    guard();
    const scope = executor.openDeclaredShell(); declared = new AbortController();
    if (cancelled || failure) declared.abort('cancelled');
    let command;
    try {
      command = executor.runShell(scope, 1, '/bin/sh', ['-c', commandText],
        { cwd: manifest.workspace, env: {}, signal: declared.signal, timeoutMs: timeout(p, true), maxStdoutBytes: 16384, maxStderrBytes: 16384 });
    } catch (error) {
      if (!takeExecutorDenial(executor, error, scope, 'shell')) { hold(); throw error; }
      // Exact preadmission denial leaves an originally owned empty declared
      // scope, not a launched worker. Settle through the normal receipt path.
      const settlement = await executor.settleScope(scope);
      executor.consumeReceipt(scope, settlement.receipt); declared = null;
      throw error;
    }
    const outcome = await command;
    const settlement = await executor.settleScope(scope);
    if (!settlement.receipt || outcome.disposition === 'unknown') { hold(); fail('OWNERSHIP_UNKNOWN'); }
    executor.consumeReceipt(scope, settlement.receipt); declared = null;
    setOutput(p.name, { status: outcome.ok && settlement.ok ? 'success' : 'failed', classification: outcome.classification,
      stdout: outcome.stdout, stderr: outcome.stderr, code: outcome.code, signal: outcome.signal });
    if (!outcome.ok || !settlement.ok) fail('PHASE_FAILED', 'declared shell did not settle cleanly');
  }
  async function artifactPhase(p, index) {
    guard();
    const source = p.from === undefined ? null : outputs[p.from];
    const content = render ? await trustedCallback(render, { kind: 'artifact', phaseIndex: index, phase: p, value: source, outputs }) : canonicalJSON(source);
    text(content, 1024 * 1024, true);
    await trustedCallback(emitArtifact, { phaseIndex: index, phase: p, content, source, outputs });
    guard();
    setOutput(p.name, { content, ...(p.from === undefined ? {} : { from: p.from }) });
  }
  authority.onScopeFrozen(scopeId => {
    try {
      const scope = state().commandScopes.find(s => s.scopeId === scopeId);
      // Start/callback failure can precede association of the returned handle.
      const n = [...nodes.values()].find(n => n.scope?.scopeId === scopeId || durable(n.nodeId).invocationId === scope?.invocationId);
      if (!n || n.joined || held) return;
      workerStopped(n);
    } catch { hold(); }
  });
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  return Object.freeze({
    cancel,
    inspect() {
      return immutable({ inspectionOnly: true, launchAuthorized: false, held, cancelled, phaseIndex,
        reservedLiveSlots: lanes.size * (manifest.policy.maxDepth + 1), lanes: [...lanes.keys()], waitingRoots: waiters.length,
        outputs: structuredClone(outputs), nodes: [...nodes.values()].map(summary), executor: executor.inspect() });
    },
    async run() {
      if (ran) fail('UNAUTHORIZED', 'no retry/resume'); ran = true;
      let error;
      try {
        const wrapped = phases.map((p, index) => ({ name: p.name, async *run() {
          guard(); if (cancelled || failure) fail('CANCELLED'); phaseIndex = index; emit('phase');
          await eventCallbacks.drain(); guard();
          if (cancelled || failure) fail('CANCELLED');
          if (p.type === 'shell') await shellPhase(p, index);
          else if (p.type === 'artifact') await artifactPhase(p, index);
          else await rootsPhase(p, index);
          guard(); if (cancelled || failure) fail('CANCELLED');
          yield { type: 'data', phase: p.name, joined: true };
        } }));
        const pipeline = (async () => {
          for await (const event of runPipeline(wrapped, { cache: new PipelineCache() })) { void event; }
        })();
        // Diagnostic abandonment never means the underlying lane settled. All
        // continuations still guard held state; no phase or lease can advance.
        await Promise.race([pipeline, heldDiagnostic]);
      } catch (caught) { error = caught; }
      if (!held) {
        try {
          for (const root of manifest.roots) {
            const n = entry(root.nodeId);
            if (!n.joined) {
              if (durable(n.nodeId).invocationId) { hold(); break; }
              unlaunched(n, cancelled ? 'cancelled' : 'infrastructure_error');
            }
          }
          if (!held) {
            await eventCallbacks.seal(); guard();
            journal.closeWorkflow(); signal?.removeEventListener('abort', cancel);
          }
        } catch (caught) { hold(); error ??= caught; }
      }
      return immutable({ status: held ? 'unknown' : cancelled ? 'cancelled' : error || failure ? 'failed' : 'success',
        held, closed: !held && !state().workflowOpen, code: held ? 'OWNERSHIP_UNKNOWN' : error ? String(error.message).split(':')[0] : null });
    },
  });
}
