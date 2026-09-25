// FIXTURE ONLY: synthetic shared credentials and deterministic provider; no network or real auth.
import assert from 'node:assert/strict';
import { access, appendFile, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkerModelRuntime, runWorker } from '../../../worker/sdk-runner.mjs';

if (process.env.PI_DELEGATION_COMPAT_FIXTURES !== '1') throw new Error('FIXTURE_EXECUTION_NOT_ENABLED');
assert.throws(() => globalThis.fetch('https://fixture.invalid'), /FIXTURE_NETWORK_FORBIDDEN/);
assert.throws(() => connect({ host: '127.0.0.1', port: 1 }), /FIXTURE_NETWORK_FORBIDDEN/);

const config = JSON.parse(process.argv[2]);
if (!config || !['auth', 'worker'].includes(config.mode) || !config.setup) throw new Error('INVALID_REQUEST');
const aiRoots = [join(config.setup.sdkPackagePath, 'node_modules/@earendil-works/pi-ai'),
  join(config.setup.sdkPackagePath, '..', 'pi-ai')];
let aiRoot;
for (const candidate of aiRoots) try { await access(join(candidate, 'package.json')); aiRoot = candidate; break; } catch {}
if (!aiRoot) throw new Error('UNSUPPORTED_VERSION');
const ai = await import(pathToFileURL(join(aiRoot, 'dist/index.js')).href);
const aiVersion = JSON.parse(await readFile(join(aiRoot, 'package.json'), 'utf8')).version;
const eventSecret = 'synthetic-sdk-event-secret';
const usage = { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, privateExtra: { eventSecret } };
const plain = content => typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('');
const model = { id: 'gpt-5.6-sol', name: 'SYNTHETIC gpt-5.6-sol', api: 'openai-codex-responses', provider: 'openai-codex',
  baseUrl: 'https://fixture.invalid', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };

function configureModelRuntime(runtime) {
  runtime.registerNativeProvider({
    id: 'openai-codex', name: 'Synthetic Codex', baseUrl: model.baseUrl,
    auth: { oauth: {
      async refresh(credential, signal) {
        signal?.throwIfAborted();
        if (config.refreshMarker) await appendFile(config.refreshMarker, 'refresh\n');
        await new Promise(resolve => setTimeout(resolve, 50));
        signal?.throwIfAborted();
        return { type: 'oauth', access: 'synthetic-refreshed-access', refresh: credential.refresh, expires: Date.now() + 3600000 };
      },
      async toAuth(credential) { return { apiKey: credential.access }; },
    } },
    getModels: () => [model],
    stream: stream,
    streamSimple: stream,
  });
}

function stream(selected, context, options) {
  const output = ai.createAssistantMessageEventStream();
  queueMicrotask(() => {
    try {
      if (typeof options?.apiKey !== 'string' || !options.apiKey.startsWith('synthetic-')) throw new Error('AUTH_UNAVAILABLE');
      const snapshots = context.messages.filter(message => message.role === 'user' && plain(message.content).includes('pi-workflow-delegation-context/v1'));
      const snapshot = snapshots.length === 1 && JSON.parse(plain(snapshots[0].content));
      if (snapshot?.schema !== 'pi-workflow-delegation-context/v1' || snapshot.self?.nodeId === undefined) throw new Error('CONTEXT_UNAVAILABLE');
      const tools = context.tools ?? context.messages.filter(message => message.role === 'system').flatMap(message => message.toolsAdded ?? []);
      if (JSON.stringify(tools.map(tool => tool.name).sort()) !== JSON.stringify(['workflow_complete', 'workflow_context']))
        throw new Error('PROFILE_UNAVAILABLE');
      const toolCall = { type: 'toolCall', id: 'synthetic-complete', name: 'workflow_complete', arguments: {
        status: 'success', summary: 'synthetic private SDK worker completed',
        acceptance: snapshot.assignment.acceptance.map(item => ({ id: item.id, outcome: 'passed', evidenceIds: [] })),
        evidence: [], childReviews: [], remainingWork: [],
      } };
      const message = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id,
        content: [toolCall], usage, stopReason: 'toolUse', timestamp: Date.now(),
        errorMessage: eventSecret, providerMetadata: { eventSecret } };
      output.push({ type: 'start', partial: { ...message, content: [] } });
      output.push({ type: 'toolcall_start', contentIndex: 0, partial: { ...message, content: [] } });
      output.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message });
      output.push({ type: 'done', reason: 'toolUse', message }); output.end();
    } catch (error) {
      const message = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, content: [], usage,
        stopReason: 'error', errorMessage: String(error?.message ?? error), timestamp: Date.now() };
      output.push({ type: 'error', reason: 'error', error: message }); output.end();
    }
  });
  return output;
}

try {
  if (config.mode === 'auth') {
    const { modelRuntime, model: selected } = await createWorkerModelRuntime(config.setup, { configureModelRuntime });
    assert.equal(selected.provider, 'openai-codex'); assert.equal(selected.id, 'gpt-5.6-sol');
    assert.equal(modelRuntime.getProviderAuthStatus('openai-codex').source, 'stored');
    process.stdout.write(JSON.stringify({ provider: selected.provider, model: selected.id, authSource: 'stored', network: 'guarded', aiVersion }) + '\n');
  } else await runWorker(config.setup, { configureModelRuntime });
} catch {
  process.stderr.write('PI_WORKER_FAIL_STOP:SYNTHETIC_AUTH_PROBE\n'); process.exitCode = 70;
}
