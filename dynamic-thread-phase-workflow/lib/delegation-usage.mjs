// Private source lifetime, not provider authentication. No legacy collector changes.
import { createHash } from 'node:crypto';
import { PiJsonEventCollector } from './pi-json-stream.mjs';
import { exclusiveUsageObserver } from '../worker/exclusive-usage.mjs';
import { canonicalJSON } from './delegation-storage.mjs';
import { text } from './delegation-contract.mjs';

const ignored = new Set(['agent_start', 'agent_end', 'turn_end', 'message_start', 'message_update',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'session']);
// Pi Message + coding-agent CustomAgentMessages (both supported SDKs). Validate
// the accounting envelope, not display content or provider-specific metadata.
const roles = new Set(['assistant', 'user', 'toolResult', 'bashExecution', 'custom', 'branchSummary', 'compactionSummary']);
export function invocationUsage(invocationId) {
  const observer = exclusiveUsageObserver(invocationId), digest = createHash('sha256');
  let bytes = 0, closed = false, final, pendingTurn = false, pendingCompaction = false, unfinished = 0;
  let problem = null, diagnostic = null;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  function observe(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw new Error('SOURCE_PROTOCOL');
    if (ignored.has(event.type)) return;
    if (event.type === 'message_end' && (!event.message || typeof event.message !== 'object' ||
        Array.isArray(event.message) || !roles.has(event.message.role))) throw new Error('SOURCE_PROTOCOL');
    if (event.type === 'turn_start') { if (pendingTurn) { unfinished++; problem ??= 'USAGE_LIFECYCLE_AMBIGUOUS'; } pendingTurn = true; }
    else if (event.type === 'compaction_start') pendingCompaction = true;
    else if (!['message_end', 'compaction_end'].includes(event.type)) throw new Error('SOURCE_PROTOCOL');
    const entry = observer.observe(event);
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      pendingTurn = false;
      if (['error', 'aborted'].includes(event.message.stopReason)) diagnostic = { type: 'assistant_failure', stopReason: event.message.stopReason };
    }
    if (event.type === 'compaction_end') pendingCompaction = false;
    if (entry?.usage) {
      // The classifier already committed this source. Retain its independent
      // accounting even if its diagnostic is rejected; never undo its identity.
      const next = structuredClone(totals);
      for (const key of Object.keys(totals)) {
        if (key === 'cost') {
          for (const k of Object.keys(totals.cost)) next.cost[k] += entry.usage.cost[k];
        } else next[key] += entry.usage[key];
      }
      if (Object.keys(totals).some(k => k !== 'cost' && !Number.isSafeInteger(next[k])) ||
          Object.values(next.cost).some(v => !Number.isFinite(v))) problem ??= 'USAGE_LIMIT';
      else Object.assign(totals, next);
      // Overflow keeps the last representable totals, explicitly partial. Still
      // process the independent diagnostic and later deliverable sources.
    }
    if (entry?.diagnostic) {
      // Retain one bounded terminal diagnostic, never a growing event history.
      const value = JSON.parse(JSON.stringify(entry.diagnostic));
      if (value.errorMessage !== undefined) text(value.errorMessage, 4096);
      if (Buffer.byteLength(canonicalJSON(value)) > 8192) throw new Error('SOURCE_DIAGNOSTIC_LIMIT');
      diagnostic = value;
    }
  }
  // Reuse the existing bounded LF/chunk parser. Source mode deliberately parses
  // only <=64KiB records; legacy trace/output budgets and defaults are untouched.
  class SourceParser extends PiJsonEventCollector {
    consumeLine(line) {
      if (!line.trim()) return;
      try { observe(JSON.parse(line)); }
      catch (error) { problem ??= /^USAGE_[A-Z_]+$/.test(error.message) ? error.message : 'SOURCE_PROTOCOL'; }
    }
  }
  const parser = new SourceParser({ maxLineBytes: 64 * 1024, invocationId });
  return Object.freeze({
    push(chunk) {
      if (closed) throw new Error('SOURCE_CLOSED');
      const nextBytes = bytes + Buffer.byteLength(chunk);
      if (!Number.isSafeInteger(nextBytes)) throw new Error('USAGE_LIMIT');
      bytes = nextBytes; digest.update(chunk); parser.push(chunk);
    },
    finish(complete = true) {
      if (closed) return final;
      closed = true;
      if (!complete || parser.pending.trim() || parser.droppingLine) problem ??= 'SOURCE_PROTOCOL';
      try { parser.finish(); } catch { problem ??= 'SOURCE_PROTOCOL'; }
      if (parser.oversizedEvents || parser.malformedEvents) problem ??= 'SOURCE_PROTOCOL';
      unfinished += Number(pendingTurn) + Number(pendingCompaction);
      if (pendingTurn || pendingCompaction) problem ??= 'USAGE_LIFECYCLE_AMBIGUOUS';
      const counters = { ...observer.counters, unfinished };
      const completeness = counters.assistant + counters.compaction === counters.missing ? 'missing' :
        problem || unfinished || counters.missing || counters.partial ? 'partial' : 'reported';
      final = { schema: 'pi-workflow-exclusive-usage/v1', invocationId, source: 'worker-stdout',
        streamBytes: bytes, streamHash: digest.digest('hex'), completeness, counters, totals, problem, diagnostic };
      return final;
    },
  });
}
