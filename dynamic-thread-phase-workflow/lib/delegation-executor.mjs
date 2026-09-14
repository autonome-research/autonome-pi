// Trusted create-only opt-in executor. No scheduler, bridge, join or recovery writer.
import { runBoundedProcess } from './subprocess.mjs';
import { claimDelegationExecutor } from './delegation-journal.mjs';
import { canonicalJSON, sha256 } from './delegation-storage.mjs';
import { createScopedProcess, ANCHOR_BINARY, ANCHOR_PATH, SCOPED_LIMITS } from './scoped-process.mjs';

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const resultOwners = new WeakMap();
export function claimResultExecutor(executor, journal) {
  const owner = resultOwners.get(executor);
  if (!owner || owner.journal !== journal || owner.claimed) throw new Error('UNAUTHORIZED: original executor/journal required');
  owner.access.guard(); owner.claimed = true; return owner.access;
}
const optionKeys = new Set(['cwd', 'env', 'signal', 'timeoutMs', 'noDeadline', 'killGraceMs', 'maxStdoutBytes', 'maxStderrBytes',
  'stdoutKeep', 'stderrKeep', 'captureStdout', 'captureStderr', 'onStdout', 'onStderr', 'onChildStart', 'onChildEnd']);

export function createDelegationExecutor({ journal, processJournal }) {
  const authority = claimDelegationExecutor(journal);
  const scopes = new Map(), receipts = new WeakMap();
  let accepted = 0, lost = false;
  const unsubscribe = authority.onOwnerLoss(revoke);
  function guard() {
    if (lost) throw new Error('OWNERSHIP_UNKNOWN: executor unavailable');
    try { authority.guard(); } catch (error) { revoke(); throw error; }
  }
  function revoke() {
    lost = true; unsubscribe();
    for (const scope of scopes.values()) {
      scope.frozen = true;
      for (const entry of scope.commands) if (!entry.done) entry.lifecycle?.revoke();
    }
  }
  function scopeOf(handle) {
    const scope = scopes.get(handle);
    if (!scope) throw new Error('UNAUTHORIZED: live scope required');
    return scope;
  }
  function open(kind, invocationId) {
    guard();
    if (scopes.size >= SCOPED_LIMITS.scopes) throw new Error('ADMISSION_LIMIT: scopes');
    const identity = journal.openCommandScope(kind, invocationId);
    const handle = freeze({ ...identity, kind });
    scopes.set(handle, { handle, commands: [], frozen: false, settlement: null });
    return handle;
  }
  function freezeAdmission(scope) {
    if (!scope.frozen) {
      scope.frozen = true;
      try { journal.freezeCommandScope(scope.handle.scopeId); } catch (error) { revoke(); throw error; }
    }
  }
  function mint(scope, command, inspection) {
    const receipt = freeze({ schema: 'pi-workflow-executor-receipt/v1', ...scope.handle,
      commandId: command?.commandId ?? null, occurrence: command?.occurrence ?? null, ...inspection });
    receipts.set(receipt, { scope, command, used: false }); return receipt;
  }
  function execute(handle, occurrence, command, args, options = {}, workerToken, stdoutSource) {
    guard(); const scope = scopeOf(handle);
    if (scope.frozen || scope.commands.some(c => c.kind === 'worker' && c.done)) throw new Error('PARENT_NOT_ACTIVE: command admission frozen');
    if (accepted >= SCOPED_LIMITS.commands) throw new Error('ADMISSION_LIMIT: commands');
    if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > 128 || scope.commands.some(c => c.occurrence === occurrence)) throw new Error('REQUEST_CONFLICT: occurrence');
    if (scope.commands.some(c => c.kind === 'shell' && !c.done)) throw new Error('PARENT_NOT_ACTIVE: shell in flight');
    if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0')) ||
        Object.keys(options).some(k => !optionKeys.has(k))) throw new Error('INVALID_REQUEST: command/options');
    if (!workerToken && options.noDeadline === true) throw new Error('INVALID_REQUEST: shell requires deadline');
    const argv = [command, ...args];
    const lifecycle = createScopedProcess(argv, options.killGraceMs, () => { if (workerToken) freezeAdmission(scope); });
    let token, commandId;
    try {
      token = workerToken ?? processJournal.reserve();
      commandId = journal.acceptCommand(handle.scopeId, occurrence, token, workerToken ? 'worker' : 'shell', sha256(canonicalJSON(argv)));
    } catch (error) { revoke(); throw error; }
    const entry = { commandId, occurrence, token, kind: workerToken ? 'worker' : 'shell', lifecycle, done: false, outcome: null };
    scope.commands.push(entry); accepted++;
    entry.promise = (async () => {
      let noChild = false, persistenceFailed = false, startFailed = false, endFailed = false, result;
      const persist = action => {
        try { return action(); } catch (error) { persistenceFailed = true; throw error; }
      };
      try {
        result = await runBoundedProcess(ANCHOR_BINARY, ['-I', '-S', '-B', ANCHOR_PATH], {
          ...options, lifecycle, ...(stdoutSource ? { stdoutSource } : {}),
          onNoChild() { noChild = true; persist(() => processJournal.noChild(token)); },
          onChildStart(child) {
            persist(() => {
              processJournal.started(token, child.pid);
              journal.commandStarted(commandId, child.pid);
              if (workerToken) journal.workerStarted(handle.invocationId, child.pid);
            });
            try { options.onChildStart?.(child); }
            catch (error) { startFailed = true; throw error; }
          },
          onChildEnd(child) {
            try { options.onChildEnd?.(child); } catch { endFailed = true; }
            // Do not prune recovery authority. POSIX ended() is deliberately a no-op.
            persist(() => processJournal.ended(token));
          },
        });
      } catch (error) {
        result = { ok: false, code: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false,
          error: error.message, termination: { kind: 'validation_error' } };
      }
      const physical = noChild ? 'no_child' : result.scopeSettlement?.disposition ?? 'unknown';
      const direct = result.scopeSettlement?.direct;
      const classification = result.timedOut ? 'timeout' : result.aborted ? 'cancelled' : startFailed ? 'start_error' :
        endFailed || result.termination?.kind === 'callback_error' ? 'callback_error' : result.termination?.kind === 'validation_error' ? 'validation_error' :
          direct?.spawnError || noChild ? 'spawn_error' : !direct ? 'unknown' : direct.signal ? 'signal' : direct.code !== 0 ? 'nonzero' :
            result.scopeSettlement?.residual ? 'residual_cleanup' : 'clean';
      let disposition = lost || persistenceFailed || startFailed ? 'unknown' : physical;
      if (disposition !== 'unknown') {
        try {
          guard();
          journal.settleCommand(commandId, { classification, disposition, code: direct ? direct.code : result.code, signal: direct ? direct.signal : result.signal });
        } catch { disposition = 'unknown'; persistenceFailed = true; }
      }
      // Failed durable acknowledgements hold all remaining authority, including
      // other active scopes. Cleanup already requested by the shared primitive
      // may finish; an explicit owner revoke never sends more signals.
      if (disposition === 'unknown') revoke();
      const observedSignal = direct ? direct.signal : result.signal;
      const outcome = { ...result, code: direct ? direct.code : result.code, signal: observedSignal,
        termination: result.termination ? { ...result.termination, observedSignal } : classification === 'clean' ? undefined : { kind: classification, observedSignal },
        error: disposition === 'unknown' ? 'OWNERSHIP_UNKNOWN: scoped execution is non-authorizing' :
          classification === 'clean' ? undefined : result.error ?? `${command}: ${classification}${direct?.code !== null && direct?.code !== undefined ? ` (exit ${direct.code})` : ''}`,
        ok: disposition !== 'unknown' && classification === 'clean', classification, disposition,
        physicalDisposition: physical, persistenceFailed, commandId, occurrence,
        receipt: disposition === 'unknown' ? null : mint(scope, entry, { disposition, classification, processToken: token }) };
      entry.done = true; entry.lifecycle = null; entry.outcome = freeze(outcome);
      // Large output is returned to the caller, not retained per accepted command.
      entry.summary = freeze({ commandId, occurrence, processToken: token, disposition, classification,
        code: outcome.code, signal: outcome.signal });
      return entry.outcome;
    })();
    // Drop resolved output/promise retention; only bounded compact inventory stays.
    const promise = entry.promise;
    promise.then(() => { entry.outcome = null; entry.promise = null; });
    return promise;
  }
  function startInvocation(nodeId, command, args, options = {}, sourceFactory) {
    guard();
    if (scopes.size >= SCOPED_LIMITS.scopes || accepted >= SCOPED_LIMITS.commands) throw new Error('ADMISSION_LIMIT');
    let token, invocationId;
    try {
      token = processJournal.reserve();
      const intent = journal.launchIntent(nodeId, token);
      if (!intent.recordedNow) throw new Error('UNAUTHORIZED: intent already used');
      invocationId = intent.invocationId;
    } catch (error) { revoke(); throw error; }
    try {
      const scope = open('worker', invocationId);
      // Private result-owner factory binds the generated identity BEFORE spawn
      // or dispatch. Ordinary executor options cannot supply/replace this tap.
      const stdoutSource = sourceFactory?.(invocationId);
      return Object.freeze({ scope, result: execute(scope, 1, command, args, options, token, stdoutSource) });
    } catch (error) { revoke(); throw error; }
  }
  const executor = Object.freeze({
    openDeclaredShell() { return open('declared-shell'); },
    startInvocation(nodeId, command, args, options = {}) { return startInvocation(nodeId, command, args, options); },
    runShell(handle, occurrence, command, args = [], options = {}) { return execute(handle, occurrence, command, args, options); },
    async settleScope(handle) {
      guard(); const scope = scopeOf(handle);
      if (handle.kind === 'worker' && scope.commands.filter(c => c.kind === 'worker').length !== 1) {
        revoke(); return freeze({ disposition: 'unknown', receipt: null });
      }
      freezeAdmission(scope);
      await Promise.all(scope.commands.map(c => c.promise).filter(Boolean));
      if (lost || scope.commands.some(c => !c.done || c.summary.disposition === 'unknown')) return freeze({ disposition: 'unknown', receipt: null });
      guard();
      // Inspection cannot grant permission, but disagreement with this genuine
      // live writer MUST veto it. External storage-only records cannot silently
      // enlarge an invocation outside the executor's private live inventory.
      const durable = journal.snapshot().state.commands?.filter(c => c.scopeId === handle.scopeId) ?? [];
      if (durable.length !== scope.commands.length || durable.some((c, i) => {
        const live = scope.commands[i];
        return c.commandId !== live.commandId || c.occurrence !== live.occurrence || c.processToken !== live.token ||
          c.invocationId !== handle.invocationId || c.slots.length || c.disposition !== live.summary.disposition ||
          canonicalJSON(c.result) !== canonicalJSON({ classification: live.summary.classification, code: live.summary.code, signal: live.summary.signal });
      })) { revoke(); return freeze({ disposition: 'unknown', receipt: null }); }
      scope.settlement ??= mint(scope, null, { disposition: 'drained', commands: scope.commands.map(c => c.summary) });
      return freeze({ disposition: 'drained', receipt: scope.settlement });
    },
    consumeReceipt(handle, receipt, commandId = null) {
      guard(); const scope = scopeOf(handle), provenance = receipts.get(receipt);
      if (!provenance || provenance.scope !== scope || provenance.used || (provenance.command?.commandId ?? null) !== commandId ||
          !commandId && (!scope.frozen || scope.commands.some(c => !c.done || c.summary.disposition === 'unknown'))) throw new Error('UNAUTHORIZED: live exact unused receipt required');
      provenance.used = true; return receipt;
    },
    inspect() {
      return freeze({ inspectionOnly: true, launchAuthorized: false, lost, acceptedCommands: accepted, limits: SCOPED_LIMITS,
        scopes: [...scopes.values()].map(s => ({ ...s.handle, frozen: s.frozen,
          commands: s.commands.map(c => c.summary ?? { commandId: c.commandId, occurrence: c.occurrence, processToken: c.token, disposition: 'pending' }) })) });
    },
    revoke,
  });
  resultOwners.set(executor, { journal, claimed: false, access: Object.freeze({
    guard, startInvocation,
    check(handle, receipt) {
      guard(); const scope = scopeOf(handle), provenance = receipts.get(receipt);
      if (!provenance || provenance.used || handle.kind !== 'worker' || scope.settlement !== receipt || scope.commands.filter(c => c.kind === 'worker').length !== 1)
        throw new Error('UNAUTHORIZED: original whole worker receipt required');
    },
    consume(handle, receipt) {
      this.check(handle, receipt);
      return executor.consumeReceipt(handle, receipt);
    },
  }) });
  return executor;
}
