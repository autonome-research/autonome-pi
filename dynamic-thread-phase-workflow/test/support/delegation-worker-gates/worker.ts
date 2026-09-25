// FIXTURE ONLY worker bridge. In-memory runner replies are NOT durable grants/results.
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { createBashTool } from '@earendil-works/pi-coding-agent';
import { assertToolProfile } from '../../../worker/profile.mjs';
import { toolOccurrence, replaceDelegationContext, runnerBashOperations } from '../../../worker/adapter-primitives.mjs';
import { validateDelegationRequest, validateContextRequest } from '../../../lib/delegation-contract.mjs';
import { frames, send } from './frames.mjs';
import { scopedFiles } from './scoped-files.mjs';
const audit = value => process.stderr.write(JSON.stringify({ type: 'fixture_worker', ...value }) + '\n');
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: { accounting: 'display-only', childTokens: 999 } });
// Throwing from session_start/context is NOT fail-closed in Pi. A private worker can
// terminate its own process; do not use this fixture fail-stop policy in the mainchat.
function fatal(code) { process.stderr.write(`FIXTURE_FAIL_STOP:${code}\n`); process.exit(70); }
export default async function worker(pi) {
  let bootstrap;
  try {
    let data = ''; const input = createReadStream('', { fd: 3, autoClose: true });
    for await (const chunk of input) { if (Buffer.byteLength(data) + chunk.length > 4096) fatal('BOOTSTRAP_LIMIT'); data += chunk.toString(); }
    bootstrap = JSON.parse(data);
    if (bootstrap.schema !== 'fixture-bootstrap/v1' || !/^[a-f0-9]{64}$/.test(bootstrap.capability) || !bootstrap.socketPath || !bootstrap.invocationId) fatal('UNAUTHORIZED');
  } catch { fatal('UNAUTHORIZED'); }
  let socket, pending, count = 0, closed = false, candidate = false, compacted = false;
  const ownPath = fileURLToPath(import.meta.url);
  const names = ['grep', 'read', 'workflow_complete', 'workflow_context', ...(bootstrap.depth === 0 ? ['bash', 'write'] : []), ...(bootstrap.depth < 2 ? ['workflow_delegate'] : [])].sort();
  const expectedSource = { path: ownPath, source: 'cli', scope: 'temporary', origin: 'top-level' };
  function profile() { assertToolProfile(pi.getActiveTools(), pi.getAllTools(), Object.fromEntries(names.map(n => [n, expectedSource]))); }
  function request(payload) {
    if (closed || pending) return Promise.reject(new Error(JSON.stringify({ status: 'error', code: 'ACCEPTANCE_UNKNOWN' })));
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, requestId: payload.requestId };
      send(socket, { schema: 'fixture-request/v1', capability: bootstrap.capability, ...payload });
    });
  }
  const localRequest = (type, args = {}) => request({ type, requestId: `${bootstrap.invocationId}:fixture:${++count}`, ...args });
  function disconnect() {
    closed = true;
    pending?.reject(new Error(JSON.stringify({ status: 'error', code: 'ACCEPTANCE_UNKNOWN' })));
    pending = undefined;
  }
  pi.on('project_trust', () => ({ trusted: 'no' }));
  pi.on('session_start', async (_event, ctx) => {
    try {
      profile();
      socket = connect(bootstrap.socketPath);
      socket.on('close', disconnect);
      frames(socket, response => {
        if (!pending || response.requestId !== pending.requestId || response.schema !== 'fixture-response/v1') { disconnect(); socket.destroy(); return; }
        const current = pending; pending = undefined; current.resolve(response);
      }, () => { disconnect(); socket.destroy(); });
      const response = await localRequest('hello');
      if (response.status !== 'ready') fatal('UNAUTHORIZED');
      audit({ stage: 'profile', active: pi.getActiveTools(), sources: pi.getAllTools().map(t => ({ name: t.name, sourceInfo: t.sourceInfo })),
        sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), hasUI: ctx.hasUI,
        inheritedAuthorityPresent: ['PI_SESSION_ID', 'PI_PROVIDER', 'OPENAI_API_KEY', 'PI_DYNAMIC_WORKFLOW_LAUNCH_AUTH', 'PI_THREAD_PHASE_SHELL_BRIDGE_SOCKET'].some(k => !!process.env[k]) });
    } catch (error) { audit({ stage: 'profile-failure', message: String(error), sources: pi.getAllTools().map(t => ({ name: t.name, sourceInfo: t.sourceInfo })) }); fatal('PROFILE_UNAVAILABLE'); }
  });
  pi.on('before_agent_start', (event) => {
    if (event.systemPromptOptions.contextFiles.length || event.systemPromptOptions.skills.length) fatal('DISCOVERY');
  });
  pi.on('context', async (event) => {
    try {
      profile();
      const response = await localRequest('context');
      if (response.status !== 'context') fatal('CONTEXT_UNAVAILABLE');
      let messages = event.messages;
      // A deliberate compaction-shaped context transformation, NOT persisted compaction.
      if (bootstrap.mode === 'tree' && response.context.ownChildJoinIndex.childCount && !compacted) {
        compacted = true;
        messages = [...event.messages.filter(m => m.role === 'system'), event.messages.find(m => m.role === 'user'),
          { role: 'compactionSummary', summary: 'FIXTURE_COMPACTION_SHAPE', tokensBefore: 100, timestamp: 0 }];
      }
      return { messages: replaceDelegationContext(messages, response.context) };
    } catch { fatal('CONTEXT_UNAVAILABLE'); }
  });
  pi.on('tool_call', (event, ctx) => {
    profile();
    if (candidate || closed) return { block: true, reason: 'PARENT_NOT_ACTIVE', terminate: true };
    const requestId = toolOccurrence(ctx.sessionManager.getBranch(), event, bootstrap.invocationId);
    audit({ stage: 'preflight', toolName: event.toolName, requestId });
  });
  const occurrence = (name, toolCallId, ctx) => toolOccurrence(ctx.sessionManager.getBranch(), { toolName: name, toolCallId }, bootstrap.invocationId);
  pi.registerTool({ name: 'workflow_delegate', label: 'delegate', description: 'FIXTURE blocking delegation',
    parameters: Type.Object({ directoryRevision: Type.Number(), children: Type.Array(Type.Any()) }, { additionalProperties: false }),
    async execute(toolCallId, args, _signal, _update, ctx) {
      validateDelegationRequest(args);
      audit({ stage: 'waiting', sessionId: ctx.sessionManager.getSessionId(), pid: process.pid });
      const response = await request({ type: 'delegate', requestId: occurrence('workflow_delegate', toolCallId, ctx), args });
      audit({ stage: 'resumed', sessionId: ctx.sessionManager.getSessionId(), pid: process.pid });
      if (response.status === 'error') throw new Error(JSON.stringify(response));
      return result(response);
    } });
  pi.registerTool({ name: 'workflow_context', label: 'context', description: 'FIXTURE own context/index',
    parameters: Type.Object({ view: Type.String(), artifactId: Type.Optional(Type.String()), offsetBytes: Type.Optional(Type.Number()), limitBytes: Type.Optional(Type.Number()) }, { additionalProperties: false }),
    async execute(toolCallId, args, _signal, _update, ctx) {
      validateContextRequest(args);
      return result(await request({ type: 'artifact', requestId: occurrence('workflow_context', toolCallId, ctx), args }));
    } });
  pi.registerTool({ name: 'workflow_complete', label: 'complete', description: 'FIXTURE candidate only',
    parameters: Type.Object({ status: Type.String(), summary: Type.String(), acceptance: Type.Array(Type.Any()), evidence: Type.Array(Type.Any()), childReviews: Type.Array(Type.Any()), remainingWork: Type.Array(Type.String()) }, { additionalProperties: false }),
    async execute(toolCallId, args, _signal, _update, ctx) {
      const response = await request({ type: 'complete', requestId: occurrence('workflow_complete', toolCallId, ctx), args });
      if (response.status !== 'completion_recorded') throw new Error(JSON.stringify(response));
      candidate = true;
      if (bootstrap.mode === 'nonzero') process.exitCode = 23;
      return { ...result(response), terminate: true };
    } });
  const files = scopedFiles(process.cwd());
  pi.registerTool({ name: 'read', label: 'scoped fixture read', description: 'FIXTURE text only, 8KiB max',
    parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
    async execute(_id, args) { const content = await files.read(args.path); if (Buffer.byteLength(content) > 8192) throw new Error('CONTEXT_LIMIT'); return { content: [{ type: 'text', text: content }] }; } });
  pi.registerTool({ name: 'grep', label: 'scoped fixture grep', description: 'FIXTURE literal search only',
    parameters: Type.Object({ path: Type.String(), pattern: Type.String(), literal: Type.Boolean() }, { additionalProperties: false }),
    async execute(_id, args) { return { content: [{ type: 'text', text: await files.grep(args) }] }; } });
  pi.registerTool({ name: 'write', label: 'fixture mutation sentinel', description: 'FIXTURE one fixed file only',
    parameters: Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }),
    async execute(_id, args) {
      if (args.path !== 'allowed/mutation' || Buffer.byteLength(args.content) > 128) throw new Error('SCOPE_DENIED');
      await writeFile(join(process.cwd(), 'allowed/mutation'), args.content, { flag: 'wx' });
      return result({ mutation: true });
    } });
  const bash = createBashTool(process.cwd(), { exposeSessionEnvironment: false });
  pi.registerTool({ ...bash, async execute(toolCallId, args, signal, update, ctx) {
    const requestId = occurrence('bash', toolCallId, ctx);
    const tool = createBashTool(process.cwd(), { exposeSessionEnvironment: false,
      operations: runnerBashOperations(requestId, payload => request(payload)) });
    return tool.execute(toolCallId, args, signal, update);
  } });
  pi.on('session_shutdown', () => { socket?.end(); });
}
