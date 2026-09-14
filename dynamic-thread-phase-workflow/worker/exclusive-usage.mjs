// Private event classifier for a single live invocation. Not wired into the legacy
// NDJSON collector/store. Caller supplies bounded parsed events in wire order; no replay
// across process loss. Final result/display totals never become new source events.
// observe returns a source observation, a diagnostic-only {invocationId, identity,
// diagnostic} (NO source/usage), or undefined for an ignored/duplicate event. First
// failed compaction sources also carry diagnostic. Callers must route diagnostics
// to execution settlement separately from accounting; neither implies success.
import { createHash } from 'node:crypto';
import { id } from '../lib/delegation-contract.mjs';
const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
function usage(value) {
  if (!value || tokenKeys.some(k => !Number.isSafeInteger(value[k]) || value[k] < 0)) return undefined;
  if (!value.cost || ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].some(k => !Number.isFinite(value.cost[k]) || value.cost[k] < 0)) return undefined;
  return { ...Object.fromEntries(tokenKeys.map(k => [k, value[k]])),
    cost: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'total'].map(k => [k, value.cost[k]])) };
}
export function exclusiveUsageObserver(invocationId) {
  id(invocationId);
  let turn = 0, compaction = 0, assistantSeen, compactionSeen;
  let compactionReason, retrySummary = false, diagnosticSeen;
  const digestOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const next = value => {
    if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) throw new Error('USAGE_LIMIT');
    return value + 1;
  };
  const counters = { assistant: 0, compaction: 0, missing: 0, partial: 0, ignoredTool: 0 };
  function accept(source, identity, raw, partial, seen, lifecycle) {
    const normalized = usage(raw);
    const digest = digestOf([normalized ?? null, partial, lifecycle]);
    if (seen) { if (seen !== digest) throw new Error('USAGE_CONFLICT'); return { digest }; }
    const updated = { [source]: next(counters[source]),
      missing: normalized ? counters.missing : next(counters.missing),
      partial: partial ? next(counters.partial) : counters.partial };
    Object.assign(counters, updated);
    return { digest, observation: { invocationId, identity, source, completeness: normalized ? partial ? 'partial' : 'reported' : 'missing', ...(normalized ? { usage: normalized } : {}) } };
  }
  return { counters, observe(event) {
    if (event.type === 'turn_start') { turn = next(turn); assistantSeen = undefined; return; }
    if (event.type === 'compaction_start') {
      if ((compaction && !compactionSeen) ||
          (event.reason !== undefined && !['manual', 'threshold', 'overflow'].includes(event.reason))) throw new Error('USAGE_LIFECYCLE_AMBIGUOUS');
      compaction = next(compaction); compactionReason = event.reason;
      compactionSeen = diagnosticSeen = undefined; retrySummary = false; return;
    }
    if (event.type === 'message_end' && event.message?.role === 'toolResult') { if (event.message.usage) counters.ignoredTool = next(counters.ignoredTool); return; }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      if (!turn) throw new Error('USAGE_IDENTITY_MISSING');
      const result = accept('assistant', `${invocationId}:turn:${turn}`, event.message.usage,
        ['error', 'aborted'].includes(event.message.stopReason), assistantSeen);
      assistantSeen = result.digest; return result.observation;
    }
    if (event.type === 'compaction_end') {
      if (!compaction) throw new Error('USAGE_IDENTITY_MISSING');
      const identity = `${invocationId}:compaction:${compaction}`;
      const hasResult = event.result !== undefined;
      if (event.reason !== compactionReason || event.usage !== undefined ||
          (hasResult && (!event.result || typeof event.result !== 'object' || Array.isArray(event.result))) ||
          (event.aborted !== undefined && typeof event.aborted !== 'boolean') ||
          (event.willRetry !== undefined && typeof event.willRetry !== 'boolean') ||
          (event.errorMessage !== undefined && (typeof event.errorMessage !== 'string' || !event.errorMessage.length)) ||
          (!hasResult && !event.aborted && !event.errorMessage)) throw new Error('USAGE_LIFECYCLE_AMBIGUOUS');
      const diagnostic = event.aborted || event.errorMessage ? {
        type: 'compaction_failure', reason: event.reason, aborted: !!event.aborted,
        willRetry: event.willRetry, ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
      } : undefined;
      // Pi's second overflow dispatch settles execution, NOT the completed summary.
      // Only this explicit successful compact-and-retry predecessor permits a second
      // terminal channel. Keep one digest per channel; never retain events or retry.
      if (retrySummary && !hasResult && event.reason === 'overflow' &&
          event.aborted === false && event.willRetry === false && event.errorMessage) {
        const digest = digestOf(diagnostic);
        if (diagnosticSeen) {
          if (diagnosticSeen !== digest) throw new Error('USAGE_CONFLICT');
          return;
        }
        diagnosticSeen = digest;
        return { invocationId, identity, diagnostic }; // deliberately NO source/usage
      }
      const result = accept('compaction', identity, event.result?.usage,
        !!diagnostic, compactionSeen, [hasResult, event.reason, event.aborted, event.willRetry, event.errorMessage]);
      compactionSeen = result.digest;
      retrySummary = hasResult && !diagnostic && event.reason === 'overflow' &&
        event.aborted === false && event.willRetry === true;
      return result.observation && { ...result.observation, ...(diagnostic ? { diagnostic } : {}) };
    }
  } };
}
