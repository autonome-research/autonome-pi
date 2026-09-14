// Private, transport-independent primitives. No scheduler, persistence or spawn authority.
import { createHash } from 'node:crypto';
import { LIMITS, id, boundedJSON } from '../lib/delegation-contract.mjs';
const EXCLUSIVE = new Set(['workflow_delegate', 'workflow_complete', 'bash']);
export const CONTEXT_TYPE = 'workflow-delegation-context';

export function toolOccurrence(branch, event, invocationId) {
  id(invocationId);
  const entry = branch.findLast(e => e.type === 'message' && e.message?.role === 'assistant');
  if (!entry || typeof entry.id !== 'string') throw new Error('INVALID_REQUEST: missing assistant occurrence');
  const calls = entry.message.content.map((c, index) => ({ ...c, index })).filter(c => c.type === 'toolCall');
  // Duplicate provider IDs within a batch cannot be disambiguated by execute(id).
  if (new Set(calls.map(c => c.id)).size !== calls.length) throw new Error('INVALID_REQUEST: ambiguous tool occurrence');
  if (calls.length > 1 && calls.some(c => EXCLUSIVE.has(c.name))) throw new Error('INVALID_REQUEST: exclusive tool batch');
  const call = calls.find(c => c.id === event.toolCallId && c.name === event.toolName);
  if (!call) throw new Error('INVALID_REQUEST: tool not in current assistant');
  return `request:${createHash('sha256').update(JSON.stringify([invocationId, entry.id, call.index])).digest('hex')}`;
}

// Snapshot must already have been built/validated by the trusted runner. This only bounds
// replacement/injection. Callers MUST fail-stop on refresh failure: Pi swallows context errors.
export function replaceDelegationContext(messages, snapshot) {
  boundedJSON(snapshot, LIMITS.contextBytes, 'CONTEXT_LIMIT');
  if (!snapshot?.ownChildJoinIndex || snapshot.schema !== 'pi-workflow-delegation-context/v1') throw new Error('CONTEXT_LIMIT: missing required context');
  return [...messages.filter(m => !(m.role === 'custom' && m.customType === CONTEXT_TYPE)),
    { role: 'custom', customType: CONTEXT_TYPE, content: JSON.stringify(snapshot), display: false, timestamp: 0 }];
}

// One tool execution owns the closure; no global "current bash call" mutable slot.
// Hook receives no worker env or capability. Runner owns cwd/deadline/permissions/output.
export function runnerBashOperations(requestId, request) {
  id(requestId);
  return { async exec(command, _cwd, { onData, signal, timeout }) {
    signal?.throwIfAborted();
    if (typeof command !== 'string' || Buffer.byteLength(command) > 16 * 1024) throw new Error('INVALID_REQUEST: shell command');
    if (timeout !== undefined && (!Number.isSafeInteger(timeout * 1000) || timeout <= 0 || timeout > 3600)) throw new Error('INVALID_REQUEST: shell timeout');
    const result = await request({ type: 'shell_execute', requestId, command,
      ...(timeout === undefined ? {} : { timeoutMs: timeout * 1000 }) }, signal);
    if (!result || result.status !== 'command_result' || !Number.isInteger(result.exitCode) || typeof result.output !== 'string' || Buffer.byteLength(result.output) > 8192) throw new Error('OWNERSHIP_UNKNOWN: shell result');
    onData(Buffer.from(result.output));
    return { exitCode: result.exitCode };
  } };
}
