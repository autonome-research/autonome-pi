// Private worker transport. This module is intentionally disconnected from the
// public decoder/manifest; only the trusted runtime may prepare and bind a node.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { chmod, mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { canonicalJSON } from './delegation-storage.mjs';
import { projectDelegationResults } from './delegation-context.mjs';
import { id, object, text, integer, fail, validateContextRequest } from './delegation-contract.mjs';

export const BRIDGE_REQUEST = 'pi-workflow-delegation-request/v1';
export const BRIDGE_RESPONSE = 'pi-workflow-delegation-response/v1';
export const BRIDGE_BOOTSTRAP = 'pi-workflow-worker-bootstrap/v1';
const MAX_FRAME = 64 * 1024;
const DENIALS = new Set(['INVALID_REQUEST', 'SCOPE_DENIED', 'PERMISSION_DENIED', 'STALE_CONTEXT', 'DEPTH_LIMIT',
  'BUDGET_EXHAUSTED', 'ADMISSION_LIMIT', 'JOURNAL_LIMIT', 'PARENT_NOT_ACTIVE', 'DEADLINE_EXPIRED',
  'CONTEXT_LIMIT', 'REQUEST_LIMIT', 'RESULT_INVALID', 'UNSUPPORTED_MODE']);
const errorCode = error => String(error?.message ?? error).split(':')[0];
const digest = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');

function frame(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) + 1 > MAX_FRAME) throw new Error('FRAME_LIMIT');
  return `${text}\n`;
}
function parseLine(bytes) {
  if (!bytes.length || bytes.includes(13)) throw new Error('FRAME_PROTOCOL');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('FRAME_PROTOCOL'); }
}
function checkRequest(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || value.schema !== BRIDGE_REQUEST ||
      typeof value.capability !== 'string' || !/^[a-f0-9]{64}$/.test(value.capability)) throw new Error('UNAUTHORIZED');
  id(value.requestId); text(value.type, 64);
  if (value.type === 'hello' || value.type === 'shutdown') object(value, ['schema', 'capability', 'requestId', 'type']);
  else object(value, ['schema', 'capability', 'requestId', 'type', 'args']);
  switch (value.type) {
    case 'delegate': case 'complete': object(value.args, value.type === 'delegate' ? ['directoryRevision', 'children'] : ['status', 'summary', 'acceptance', 'evidence', 'childReviews', 'remainingWork']); break;
    case 'shutdown': break;
    case 'context': validateContextRequest(value.args); if (value.args.view !== 'directory') throw new Error('INVALID_REQUEST'); break;
    case 'artifact': validateContextRequest(value.args); if (value.args.view !== 'artifact') throw new Error('INVALID_REQUEST'); break;
    case 'file_read': object(value.args, ['path'], ['maxBytes']); if (value.args.maxBytes !== undefined) integer(value.args.maxBytes, 1, 262144); break;
    case 'file_grep': object(value.args, ['path', 'pattern', 'literal']); if (value.args.literal !== true) throw new Error('UNSUPPORTED_MODE'); break;
    case 'file_find': case 'file_ls': object(value.args, ['path']); break;
    case 'file_write': object(value.args, ['path', 'content']); break;
    case 'file_edit': object(value.args, ['path', 'oldText', 'newText']); break;
    case 'shell_execute': object(value.args, ['command'], ['timeoutMs']); break;
    case 'hello': break;
    default: throw new Error('UNSUPPORTED_MODE');
  }
  return value;
}
function resultEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => item?.result ? {
    schema: 'pi-workflow-delegation-node-result/v1', childNodeId: item.nodeId,
    status: item.result.status,
    // Verified immutable-artifact summary from the paired runtime change; a handle
    // that omits it fails closed instead of minting an empty claim.
    summary: typeof item.summary === 'string' ? item.summary : fail('RESULT_INVALID', 'delegate result summary'),
    resultHash: item.result.sha256, resultArtifactId: item.result.artifactId,
  } : item);
}

export async function createDelegationBridge(options = {}) {
  object(options, [], ['maxConnections', 'maxActive', 'tmpDir']);
  if (options.tmpDir !== undefined && (typeof options.tmpDir !== 'string' || !isAbsolute(options.tmpDir) || options.tmpDir.includes('\0'))) fail('INVALID_REQUEST', 'bridge tmpDir');
  const maxConnections = options.maxConnections ?? 128, maxActive = options.maxActive ?? 32;
  integer(maxConnections, 1, 128); integer(maxActive, 1, maxConnections);
  const parent = options.tmpDir ?? tmpdir();
  const direct = options.tmpDir !== undefined && Buffer.byteLength(join(parent, 's00.sock')) <= 107;
  const ownsRoot = !direct;
  let root;
  if (direct) root = parent;
  else {
    const prefix = join(parent, 'pi-worker-bridge-');
    // Linux limits the complete AF_UNIX pathname to 107 bytes. If the caller's
    // isolated profile is too deep, own a short private directory instead.
    root = await mkdtemp(Buffer.byteLength(join(`${prefix}XXXXXX`, 'bridge.sock')) <= 107
      ? prefix : '/tmp/pi-worker-bridge-');
  }
  await chmod(root, 0o700);
  const socketPath = join(root, direct ? `s${randomBytes(1).toString('hex')}.sock` : 'bridge.sock');
  if (Buffer.byteLength(socketPath) > 107) fail('INVALID_REQUEST', 'bridge socket path');
  const records = new Map(), sockets = new Set();
  let connections = 0, active = 0, closed = false, server;
  const closeRecord = (record, cancel = true) => {
    if (record.closed) return;
    const handle = record.handle;
    record.closed = true; record.handle = null;
    if (cancel) try { handle?.disconnect(); } catch {}
    if (record.socket) { record.socket.destroy(); record.socket = null; }
  };
  async function dispatch(socket, record, request) {
    checkRequest(request);
    if (request.capability !== record.capability || record.closed || record.socket !== socket || !record.handle) throw new Error('UNAUTHORIZED');
    if (record.graceful) throw new Error('UNAUTHORIZED');
    if (request.type === 'hello') return { status: 'ready' };
    if (request.type === 'shutdown') { record.graceful = true; return { status: 'closed' }; }
    const key = request.requestId, current = digest({ type: request.type, args: request.args });
    const prior = record.requests.get(key);
    if (prior && prior !== current) throw new Error('REQUEST_CONFLICT');
    if (prior && record.responses.has(key)) {
      record.handle.repeat?.(key);
      return record.responses.get(key);
    }
    if (!prior) {
      if (record.requests.size >= 128) throw new Error('REQUEST_LIMIT');
      record.requests.set(key, current);
    }
    const h = record.handle, args = request.args;
    const output = await (async () => { switch (request.type) {
      case 'context': return { status: 'context', context: await h.context(key) };
      case 'artifact': return { status: 'context', page: await h.artifact(key, args) };
      case 'delegate': return { status: 'joined', accepted: true, results: projectDelegationResults(resultEntries(await h.delegate(key, args))).results };
      case 'complete': await h.complete(key, args); return { status: 'completion_recorded', accepted: true };
      case 'file_read': {
        const bytes = await h.fileRead(key, args.path, args.maxBytes);
        return { status: 'file_result', encoding: 'base64', data: bytes.toString('base64') };
      }
      case 'file_grep': {
        const output = await h.fileGrep(key, args.path, args.pattern);
        if (typeof output !== 'string') fail('RESULT_INVALID', 'grep output');
        return { status: 'file_result', output };
      }
      case 'file_find': {
        const output = await h.fileFind(key, args.path);
        if (typeof output !== 'string') fail('RESULT_INVALID', 'find output');
        return { status: 'file_result', output };
      }
      case 'file_ls': return { status: 'file_result', entries: await h.fileLs(key, args.path) };
      case 'file_write': return { status: 'file_result', result: await h.fileWrite(key, args.path, Buffer.from(args.content)) };
      case 'file_edit': return { status: 'file_result', result: await h.fileEdit(key, args.path, args.oldText, args.newText) };
      case 'shell_execute': {
        const output = await h.shell(key, args.command, args.timeoutMs);
        return { status: 'command_result', exitCode: output.code, output: output.stdout };
      }
      default: throw new Error('UNSUPPORTED_MODE');
    } })();
    record.responses.set(key, output);
    return output;
  }
  function acceptedError(error, request, record) {
    const code = errorCode(error), base = { schema: BRIDGE_RESPONSE, requestId: request?.requestId, directoryRevision: record?.handle?.directoryRevision?.() ?? 0 };
    if (DENIALS.has(code)) return { ...base, status: 'denied', accepted: false, code, message: String(error?.message ?? code).slice(0, 128) };
    return { ...base, status: 'error', ...(code === 'REQUEST_CONFLICT' ? { code } : { code: 'OWNERSHIP_UNKNOWN' }), message: String(error?.message ?? code).slice(0, 128) };
  }
  function onConnection(socket) {
    if (closed || connections >= maxConnections || active >= maxActive) { socket.destroy(); return; }
    connections++; active++;
    sockets.add(socket);
    let record = null, pending = Buffer.alloc(0), queue = Promise.resolve(), dead = false;
    const die = () => {
      if (dead) return; dead = true; active--; sockets.delete(socket);
      // Only an acknowledged shutdown or runner-owned settlement may close a
      // worker transport without revoking its original runtime handle. Any
      // other authoritative EOF/error/protocol loss is fail-stop.
      if (record?.socket === socket) closeRecord(record, !record.graceful); else socket.destroy();
    };
    const receive = request => {
      queue = queue.then(async () => {
        try {
          const checked = checkRequest(request);
          if (!record) {
            record = [...records.values()].find(candidate => candidate.capability === checked.capability);
            if (!record || checked.type !== 'hello' || record.closed || record.socket) throw new Error('UNAUTHORIZED');
            record.socket = socket;
          }
          const response = await dispatch(socket, record, checked);
          const payload = frame({ schema: BRIDGE_RESPONSE, requestId: checked.requestId,
            directoryRevision: record.handle?.directoryRevision?.() ?? 0, ...response });
          if (!socket.write(payload)) await new Promise(resolve => socket.once('drain', resolve));
        } catch (error) {
          try { socket.write(frame(acceptedError(error, request, record))); } catch {}
          if (!record || ['UNAUTHORIZED', 'FRAME_PROTOCOL', 'INVALID_REQUEST'].includes(errorCode(error))) die();
        }
      }).catch(die);
    };
    socket.on('data', chunk => {
      if (dead) return;
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > MAX_FRAME) { die(); return; }
      let at;
      while (!dead && (at = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, at); pending = pending.subarray(at + 1);
        if (line.length + 1 > MAX_FRAME) { die(); return; }
        try { receive(parseLine(line)); } catch { die(); }
      }
    });
    socket.on('error', die); socket.on('close', die);
  }
  await new Promise((resolve, reject) => {
    server = createServer(onConnection); server.once('error', reject); server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return Object.freeze({
    socketPath,
    prepare(nodeId, tools = []) {
      if (closed) fail('OWNERSHIP_UNKNOWN'); id(nodeId);
      if (!Array.isArray(tools) || tools.length > 32 || tools.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(name))) fail('INVALID_REQUEST', 'worker tools');
      if (records.has(nodeId)) fail('REQUEST_CONFLICT', 'node bridge already prepared');
      const capability = randomBytes(32).toString('hex');
      const requestNamespace = randomBytes(32).toString('hex');
      const record = { nodeId, capability, requestNamespace, tools: [...tools], socket: null, handle: null, requests: new Map(), responses: new Map(), closed: false };
      records.set(nodeId, record);
      const bootstrap = Buffer.from(JSON.stringify({ schema: BRIDGE_BOOTSTRAP, capability, socketPath, requestNamespace, tools: [...tools] }));
      return Object.freeze({ bootstrap });
    },
    bind(nodeId, handle, invocationId) {
      id(nodeId); id(invocationId);
      const record = records.get(nodeId);
      if (!record || record.closed || record.handle || !handle) fail('UNAUTHORIZED');
      record.invocationId = invocationId; record.handle = handle;
    },
    async close(nodeId) {
      if (nodeId !== undefined) { const record = records.get(nodeId); if (record) closeRecord(record, false); return; }
      if (closed) return;
      closed = true; for (const record of records.values()) closeRecord(record);
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      if (ownsRoot) await rm(root, { recursive: true, force: true });
      else await unlink(socketPath).catch(() => {});
    },
  });
}
