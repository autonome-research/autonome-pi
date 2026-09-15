// Private SDK worker extension. It is loaded only by a trusted runner recipe;
// this file is not in the package extension manifest.
import { createReadStream } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { createBashTool } from '@earendil-works/pi-coding-agent';
import { assertToolProfile } from './profile.mjs';
import { toolOccurrence, replaceDelegationContext, runnerBashOperations } from './adapter-primitives.mjs';

const FRAME = 64 * 1024;
const ownPath = fileURLToPath(import.meta.url);
const audit = code => process.stderr.write(`PI_WORKER_FAIL_STOP:${code}\n`);
function fatal(code: string): never { audit(code); process.exit(70); }
function json(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) + 1 > FRAME) throw new Error('FRAME_LIMIT');
  return `${text}\n`;
}
async function bootstrap() {
  try {
    let text = '';
    for await (const chunk of createReadStream('', { fd: 4, autoClose: true })) {
      text += chunk.toString(); if (Buffer.byteLength(text) > 4096) throw new Error();
    }
    const value = JSON.parse(text);
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || value.schema !== 'pi-workflow-worker-bootstrap/v1' ||
        typeof value.capability !== 'string' || !/^[a-f0-9]{64}$/.test(value.capability) || typeof value.socketPath !== 'string' ||
        typeof value.requestNamespace !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestNamespace) ||
        !Array.isArray(value.tools) || Object.keys(value).some(k => !['schema', 'capability', 'socketPath', 'requestNamespace', 'tools'].includes(k))) throw new Error();
    return value;
  } catch { fatal('UNAUTHORIZED'); }
}

export default async function worker(pi: any) {
  const boot = await bootstrap();
  let socket: any, closed = false, pending: any = null, counter = 0;
  const queue: any[] = [];
  const pump = () => {
    if (closed || pending || !queue.length) return;
    pending = queue.shift();
    try { socket.write(json({ schema: 'pi-workflow-delegation-request/v1', capability: boot.capability, type: pending.type, args: pending.args, requestId: pending.requestId })); }
    catch (error) { const current = pending; pending = null; current.reject(error); pump(); }
  };
  const request = (type: string, args: any, requestId: string) => new Promise((resolve, reject) => {
    if (closed || queue.length >= 4) { reject(new Error(JSON.stringify({ status: 'error', code: 'ACCEPTANCE_UNKNOWN' }))); return; }
    queue.push({ resolve, reject, type, args, requestId }); pump();
  });
  const localId = (ctx: any, name: string, callId: string) => {
    const occurrence = toolOccurrence(ctx.sessionManager.getBranch(), { toolName: name, toolCallId: callId }, boot.requestNamespace);
    return occurrence;
  };
  const failResponse = (response: any) => {
    if (response?.status === 'denied') throw new Error(JSON.stringify(response));
    if (response?.status === 'error') throw new Error(JSON.stringify(response));
    return response;
  };
  function profile() {
    assertToolProfile(pi.getActiveTools(), pi.getAllTools(), Object.fromEntries(boot.tools.map((name: string) => [name,
      { path: ownPath, source: 'cli', scope: 'temporary', origin: 'top-level' }])))
  }
  pi.on('project_trust', () => ({ trusted: 'no' }));
  pi.on('session_start', async () => {
    try {
      profile();
      socket = connect(boot.socketPath);
      let buffer = Buffer.alloc(0);
      const disconnect = () => {
        if (closed) return; closed = true;
        pending?.reject(new Error(JSON.stringify({ status: 'error', code: 'ACCEPTANCE_UNKNOWN' })));
        for (const item of queue.splice(0)) item.reject(new Error(JSON.stringify({ status: 'error', code: 'ACCEPTANCE_UNKNOWN' })));
        pending = null;
      };
      socket.on('close', disconnect); socket.on('error', disconnect);
      socket.on('data', (chunk: Buffer) => {
        if (closed) return;
        buffer = Buffer.concat([buffer, chunk]); if (buffer.length > FRAME) return disconnect();
        let at;
        while (!closed && (at = buffer.indexOf(10)) >= 0) {
          const line = buffer.subarray(0, at); buffer = buffer.subarray(at + 1);
          if (!line.length || line.includes(13)) return disconnect();
          let response: any;
          try { response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); } catch { return disconnect(); }
          if (!pending || response.schema !== 'pi-workflow-delegation-response/v1' || response.requestId !== pending.requestId) return disconnect();
          const current = pending; pending = null; current.resolve(response); pump();
        }
      });
      const hello = await request('hello', undefined, `hello:${++counter}`);
      if (hello.status !== 'ready') fatal('UNAUTHORIZED');
    } catch { fatal('PROFILE_UNAVAILABLE'); }
  });
  pi.on('before_agent_start', (event: any) => {
    if (event.systemPromptOptions.contextFiles.length || event.systemPromptOptions.skills.length) fatal('DISCOVERY');
  });
  pi.on('context', async (event: any) => {
    try {
      profile();
      const response = failResponse(await request('context', {}, `context:${++counter}`));
      if (response.status !== 'context') fatal('CONTEXT_UNAVAILABLE');
      return { messages: replaceDelegationContext(event.messages, response.context) };
    } catch { fatal('CONTEXT_UNAVAILABLE'); }
  });
  pi.on('tool_call', (event: any, ctx: any) => {
    try { profile(); localId(ctx, event.toolName, event.toolCallId); }
    catch (error) { return { block: true, reason: String(error).includes('exclusive') ? 'exclusive tool batch' : 'PARENT_NOT_ACTIVE', terminate: true }; }
  });
  const register = (name: string, parameters: any, execute: any) => pi.registerTool({ name, label: name, description: 'Private workflow worker tool', parameters, execute });
  if (boot.tools.includes('workflow_delegate')) register('workflow_delegate', Type.Object({ directoryRevision: Type.Number(), children: Type.Array(Type.Any()) }, { additionalProperties: false }), async (id: string, args: any, _signal: any, _update: any, ctx: any) => {
    const response = failResponse(await request('delegate', args, localId(ctx, 'workflow_delegate', id)));
    return { content: [{ type: 'text', text: JSON.stringify(response) }], details: { accounting: 'display-only' } };
  });
  if (boot.tools.includes('workflow_context')) register('workflow_context', Type.Object({ view: Type.String(), artifactId: Type.Optional(Type.String()), offsetBytes: Type.Optional(Type.Number()), limitBytes: Type.Optional(Type.Number()) }, { additionalProperties: false }), async (id: string, args: any, _signal: any, _update: any, ctx: any) => {
    const response = failResponse(await request(args.view === 'artifact' ? 'artifact' : 'context', args.view === 'artifact' ? args : {}, localId(ctx, 'workflow_context', id)));
    return { content: [{ type: 'text', text: JSON.stringify(response) }], details: { accounting: 'display-only' } };
  });
  if (boot.tools.includes('workflow_complete')) register('workflow_complete', Type.Object({ status: Type.String(), summary: Type.String(), acceptance: Type.Array(Type.Any()), evidence: Type.Array(Type.Any()), childReviews: Type.Array(Type.Any()), remainingWork: Type.Array(Type.String()) }, { additionalProperties: false }), async (id: string, args: any, _signal: any, _update: any, ctx: any) => {
    const response = failResponse(await request('complete', args, localId(ctx, 'workflow_complete', id)));
    return { content: [{ type: 'text', text: JSON.stringify(response) }], details: { accounting: 'display-only' }, terminate: true };
  });
  const read = Type.Object({ path: Type.String() }, { additionalProperties: false });
  if (boot.tools.includes('read')) register('read', read, async (id: string, args: any, _signal: any, _update: any, ctx: any) => {
    const response = failResponse(await request('file_read', args, localId(ctx, 'read', id)));
    return { content: [{ type: 'text', text: Buffer.from(response.data, 'base64').toString('utf8') }] };
  });
  if (boot.tools.includes('grep')) register('grep', Type.Object({ path: Type.String(), pattern: Type.String(), literal: Type.Boolean() }, { additionalProperties: false }), async (id: string, args: any, _signal: any, _update: any, ctx: any) => {
    const response = failResponse(await request('file_grep', args, localId(ctx, 'grep', id))); return { content: [{ type: 'text', text: response.output }] };
  });
  if (boot.tools.includes('find')) register('find', read, async (id: string, args: any, _signal: any, _update: any, ctx: any) => {
    const response = failResponse(await request('file_find', args, localId(ctx, 'find', id))); return { content: [{ type: 'text', text: response.output }] };
  });
  if (boot.tools.includes('ls')) register('ls', read, async (id: string, args: any, _signal: any, _update: any, ctx: any) => {
    const response = failResponse(await request('file_ls', args, localId(ctx, 'ls', id))); return { content: [{ type: 'text', text: response.entries.join('\n') }] };
  });
  if (boot.tools.includes('write')) register('write', Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }), async (id: string, args: any, _signal: any, _update: any, ctx: any) => {
    const response = failResponse(await request('file_write', args, localId(ctx, 'write', id))); return { content: [{ type: 'text', text: JSON.stringify(response.result) }] };
  });
  if (boot.tools.includes('edit')) register('edit', Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }, { additionalProperties: false }), async (id: string, args: any, _signal: any, _update: any, ctx: any) => {
    const response = failResponse(await request('file_edit', args, localId(ctx, 'edit', id))); return { content: [{ type: 'text', text: JSON.stringify(response.result) }] };
  });
  if (boot.tools.includes('bash')) {
    const bash = createBashTool(process.cwd(), { exposeSessionEnvironment: false });
    pi.registerTool({ ...bash, async execute(id: string, args: any, signal: any, update: any, ctx: any) {
      const requestId = localId(ctx, 'bash', id);
      const tool = createBashTool(process.cwd(), { exposeSessionEnvironment: false, operations: runnerBashOperations(requestId, (payload: any) => request('shell_execute', { command: payload.command, ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }) }, requestId)) });
      return tool.execute(id, args, signal, update);
    } });
  }
  pi.on('session_shutdown', () => {
    if (closed) return;
    closed = true;
    try {
      socket?.end(json({ schema: 'pi-workflow-delegation-request/v1', capability: boot.capability,
        type: 'shutdown', requestId: `shutdown:${++counter}` }));
    } catch { socket?.destroy(); }
  });
}
