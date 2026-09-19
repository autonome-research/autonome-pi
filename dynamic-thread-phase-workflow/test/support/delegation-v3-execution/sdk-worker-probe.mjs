// FIXTURE ONLY: synthetic SDK worker probe for consent-gated v3 execution
// tests. Installed as the synthetic launch profile's workerEntryPath via
// __setV3LaunchProfileForTests; the runner spawns it verbatim with the trusted
// recipe (`node <probe> <setupJSON>`) and delivers the bridge bootstrap on fd 4.
//
// Two adaptations from test/support/delegation-worker-gates/shared-auth-probe.mjs,
// both forced by the runner-controlled worker environment (workerEnvironment
// builds the full env; no ambient variable is inherited):
// 1. PI_DELEGATION_COMPAT_FIXTURES cannot reach this process, so consent is
//    proven positively instead: the bound auth file must parse and contain
//    only synthetic sentinel credentials. The consent-gated test files
//    (PI_DELEGATION_COMPAT_FIXTURES=1) remain the arming layer.
// 2. strict-no-network's endpoint equality check cannot run here either (the
//    bridge socket path arrives via the FD4 bootstrap after import time), so
//    its owned-private-socket filesystem checks are retained without the env
//    comparison: only a uid-owned 0600 socket inside a uid-owned 0700
//    directory with no symlink ancestors may be contacted.
import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWorker } from '../../../worker/sdk-runner.mjs';

const deny = () => { throw new Error('FIXTURE_NETWORK_FORBIDDEN'); };
globalThis.fetch = deny;
http.request = http.get = https.request = https.get = tls.connect = deny;
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const innerConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const path = typeof first === 'object' && first !== null ? first.path : typeof first === 'string' ? first : undefined;
  const privateSocket = typeof path === 'string' && uid !== null && path.startsWith('/') && !path.includes('\0') &&
    resolve(path) === path && Buffer.byteLength(path) <= 107 && (() => {
      try {
        const socket = lstatSync(path);
        const privateRoot = lstatSync(dirname(path));
        if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600) return false;
        if (!privateRoot.isDirectory() || privateRoot.uid !== uid || (privateRoot.mode & 0o777) !== 0o700) return false;
        for (let current = dirname(path); ; current = dirname(current)) {
          if (lstatSync(current).isSymbolicLink()) return false;
          if (current === '/') break;
        }
        return true;
      } catch { return false; }
    })();
  if (!privateSocket) return deny();
  return innerConnect.apply(this, args);
};

assert.throws(() => globalThis.fetch('https://fixture.invalid'), /FIXTURE_NETWORK_FORBIDDEN/);
assert.throws(() => net.connect({ host: '127.0.0.1', port: 1 }), /FIXTURE_NETWORK_FORBIDDEN/);

const usage = { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: 'gpt-5.6-sol', name: 'SYNTHETIC gpt-5.6-sol', api: 'openai-codex-responses', provider: 'openai-codex',
  baseUrl: 'https://fixture.invalid', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
const plain = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((part) => part.type === 'text').map((part) => part.text).join('') : '';
let setup;
let ai;

// The delegation decision comes from the context snapshot alone: grantedTools
// contains workflow_delegate iff depth < maxDepth. A node with no children yet
// delegates exactly one child on a narrowed (equal) scope; otherwise it
// completes, reviewing every joined child from the delegate tool result.
function decideToolCall(context) {
  const snapshots = context.messages.filter((message) => message.role === 'user' && plain(message.content).includes('pi-workflow-delegation-context/v1'));
  const snapshot = snapshots.length === 1 && JSON.parse(plain(snapshots[0].content));
  if (snapshot?.schema !== 'pi-workflow-delegation-context/v1' || snapshot.self?.nodeId === undefined) throw new Error('CONTEXT_UNAVAILABLE');
  const self = snapshot.self;
  // Delegability comes from the worker's configured tool set (setup.tools), which
  // buildV3WorkerRecipe sets to include workflow_delegate iff depth < maxDepth.
  // The context snapshot's self.grantedTools is journal-level authority (read/write
  // tools only) and never carries workflow_delegate.
  const canDelegate = setup.tools.includes('workflow_delegate');
  const priorResults = [];
  for (const message of context.messages) {
    if (message.role !== 'toolResult') continue;
    let parsed;
    try { parsed = JSON.parse(plain(message.content)); } catch { continue; }
    if (parsed?.status === 'joined' && Array.isArray(parsed.results)) priorResults.push(...parsed.results);
  }
  const hasChildren = (snapshot.directory || []).some((node) => node.parentNodeId === self.nodeId);
  if (canDelegate && !hasChildren && !priorResults.length) {
    return { type: 'toolCall', id: 'synthetic-delegate', name: 'workflow_delegate', arguments: {
      directoryRevision: snapshot.directoryRevision,
      children: [{ label: `synthetic-child-depth-${self.depth + 1}`,
        task: `Complete the synthetic bounded child assignment at depth ${self.depth + 1}.`,
        acceptance: [{ id: 'assignment', criterion: 'Satisfy the assigned synthetic child task and cite supporting evidence.' }],
        agentBudget: Math.max(1, Math.min(self.available, 128)), permissions: 'r',
        directoryScope: self.directoryScope }] } };
  }
  return { type: 'toolCall', id: 'synthetic-complete', name: 'workflow_complete', arguments: {
    status: 'success', summary: 'synthetic private SDK worker completed',
    acceptance: snapshot.assignment.acceptance.map((item) => ({ id: item.id, outcome: 'passed', evidenceIds: [] })),
    evidence: [],
    childReviews: priorResults.map((result) => ({ childNodeId: result.childNodeId, resultHash: result.resultHash,
      decision: 'accepted', reason: 'synthetic review' })),
    remainingWork: [] } };
}

function stream(selected, context, options) {
  const output = ai.createAssistantMessageEventStream();
  queueMicrotask(() => {
    try {
      if (typeof options?.apiKey !== 'string' || !options.apiKey.startsWith('synthetic-')) throw new Error('AUTH_UNAVAILABLE');
      if (setup.prompt.includes('synthetic-await-abort')) {
        // Cancellation fixture: a long-running stream that only ends on abort.
        options?.signal?.addEventListener('abort', () => {
          try {
            const message = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id,
              content: [], usage, stopReason: 'aborted', timestamp: Date.now() };
            output.push({ type: 'error', reason: 'aborted', error: message });
            output.end();
          } catch { /* stream already closed */ }
        }, { once: true });
        return;
      }
      const toolCall = decideToolCall(context);
      // Delegating turns carry no usage so each node settles exactly 7 tokens
      // (its completion turn); a missing intermediate source is partial, never
      // a failure, in the exclusive usage accounting.
      const message = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id,
        content: [toolCall], ...(toolCall.name === 'workflow_complete' ? { usage } : {}), stopReason: 'toolUse', timestamp: Date.now() };
      output.push({ type: 'start', partial: { ...message, content: [] } });
      output.push({ type: 'toolcall_start', contentIndex: 0, partial: { ...message, content: [] } });
      output.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message });
      output.push({ type: 'done', reason: 'toolUse', message });
      output.end();
    } catch (error) {
      const message = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, content: [], usage,
        stopReason: 'error', errorMessage: String(error?.message ?? error), timestamp: Date.now() };
      output.push({ type: 'error', reason: 'error', error: message });
      output.end();
    }
  });
  return output;
}

function configureModelRuntime(runtime) {
  runtime.registerNativeProvider({
    id: 'openai-codex', name: 'Synthetic Codex', baseUrl: model.baseUrl,
    auth: { oauth: {
      async refresh(credential, signal) {
        signal?.throwIfAborted();
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        signal?.throwIfAborted();
        return { type: 'oauth', access: 'synthetic-refreshed-access', refresh: credential.refresh, expires: Date.now() + 3600000 };
      },
      async toAuth(credential) { return { apiKey: credential.access }; },
    } },
    getModels: () => [model],
    stream,
    streamSimple: stream,
  });
}

try {
  setup = JSON.parse(process.argv[2] || '');
  // Positive fixture ownership (consent proof, see header): the bound auth
  // file must parse and every credential token in it must be synthetic.
  const auth = JSON.parse(await readFile(setup.authPath, 'utf8'));
  const tokens = [];
  const collectTokens = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (['access', 'refresh', 'apiKey', 'key', 'token'].includes(key) && typeof nested === 'string') tokens.push(nested);
      else collectTokens(nested);
    }
  };
  collectTokens(auth);
  if (!tokens.length || tokens.some((token) => !token.startsWith('synthetic-'))) throw new Error('FIXTURE_EXECUTION_NOT_ENABLED');
  const aiRoots = [join(setup.sdkPackagePath, 'node_modules/@earendil-works/pi-ai'),
    join(setup.sdkPackagePath, '..', 'pi-ai')];
  let aiRoot;
  for (const candidate of aiRoots) {
    try { await access(join(candidate, 'package.json')); aiRoot = candidate; break; } catch { /* next candidate */ }
  }
  if (!aiRoot) throw new Error('UNSUPPORTED_VERSION');
  ai = await import(pathToFileURL(join(aiRoot, 'dist/index.js')).href);
  await runWorker(setup, { configureModelRuntime });
} catch {
  process.stderr.write('PI_WORKER_FAIL_STOP:SDK_WORKER\n');
  process.exitCode = 70;
}
