// INTERNAL only: trusted central sequencing, not a scheduler or worker bridge.
import { claimResultExecutor } from './delegation-executor.mjs';
import { applyDelegationResult } from './delegation-journal.mjs';
import { invocationUsage } from './delegation-usage.mjs';
import { object, fail } from './delegation-contract.mjs';

const capabilities = new WeakMap();
// Used only by the journal. Serialized fields cannot enter this WeakMap. Taking
// a capability before failed/ambiguous persistence is intentionally irreversible.
export function takeResultCapability(capability, journal, operation) {
  const p = capabilities.get(capability);
  if (!p || p.journal !== journal || p.failed) fail('UNAUTHORIZED', 'live result capability');
  p.access.validate(p.scope, p.receipt);
  if (operation === 'result') {
    if (p.phase !== 'ready') fail('UNAUTHORIZED', 'spent finalization');
    p.phase = 'spent';
    p.access.consume(p.scope, p.receipt);
  } else if (!['lookup', 'join'].includes(operation) || p.phase !== 'published') fail('UNAUTHORIZED');
  return p;
}

export function createDelegationResults(options) {
  object(options, ['journal', 'executor']);
  const { journal, executor } = options, access = claimResultExecutor(executor, journal), workers = new Map();
  function own(scope) {
    access.guard();
    const w = workers.get(scope);
    if (!w) fail('UNAUTHORIZED', 'coordinator-owned worker lifetime required');
    return w;
  }
  return Object.freeze({
    startInvocation(nodeId, command, args, options = {}) {
      access.guard();
      let usage;
      const started = access.startInvocation(nodeId, command, args, options, invocationId => {
        usage = invocationUsage(invocationId);
        return { push: chunk => usage.push(chunk), close: complete => usage.finish(complete) };
      });
      const w = { scope: started.scope, receipt: null, pending: null, capability: null, reference: null, failed: false };
      w.done = started.result.then(() => {
        w.usage = usage.finish();
        w.candidate = journal.snapshot().state.nodes.find(n => n.invocationId === started.scope.invocationId).candidate;
      });
      workers.set(started.scope, w);
      // Keep only bounded source/binding data, not resolved worker output per node.
      return Object.freeze({ scope: started.scope, result: started.result });
    },
    async finalize(scope, receipt) {
      const w = own(scope);
      if (w.failed) fail('UNAUTHORIZED', 'failed finalization cannot replay');
      if (w.pending) {
        if (w.receipt !== receipt) fail('REQUEST_CONFLICT', 'original whole receipt required');
        await w.pending;
        return applyDelegationResult(journal, w.capability, 'lookup');
      }
      access.check(scope, receipt);
      w.receipt = receipt;
      w.pending = (async () => {
        await w.done;
        access.check(scope, receipt);
        const capability = Object.freeze({});
        const proof = { journal, access, scope, receipt, usage: w.usage, candidate: w.candidate, phase: 'ready', reference: null, failed: false };
        capabilities.set(capability, proof); w.capability = capability;
        try {
          const reference = applyDelegationResult(journal, capability, 'result');
          proof.reference = reference; proof.phase = 'published'; w.reference = reference;
          return reference;
        } catch (error) { proof.failed = true; throw error; }
      })();
      try { return await w.pending; }
      catch (error) { w.failed = true; throw error; }
    },
    join(scope, reference) {
      const w = own(scope);
      if (!w.reference || reference !== w.reference || w.failed) fail('UNAUTHORIZED', 'original final result required');
      try { return applyDelegationResult(journal, w.capability, 'join'); }
      catch (error) {
        w.failed = true;
        capabilities.get(w.capability).failed = true;
        throw error;
      }
    },
  });
}
