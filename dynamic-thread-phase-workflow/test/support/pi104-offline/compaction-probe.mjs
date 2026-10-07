// FIXTURE ONLY: offline SDK resource/profile preflight and compaction
// accounting probe for the explicit lane (1.0.4). Deterministic
// extension-supplied summary/usage only; no inference, network, real
// credentials, or provider equivalence claims.
//
// Explicitly OUT OF SCOPE (skipped here, not passed): the historical
// stock-grep counterexample is a bypass reproduction outside this task's
// safety scope; real-provider compaction/overflow recovery is live-provider
// behavior this offline probe cannot demonstrate.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedResourceOptions } from '../../../worker/profile.mjs';

if (process.env.PI_DELEGATION_COMPAT_FIXTURES !== '1') throw new Error('FIXTURE_EXECUTION_NOT_ENABLED');
assert.throws(() => globalThis.fetch('https://fixture.invalid'), /FIXTURE_NETWORK_FORBIDDEN/);
assert.throws(() => connect({ host: '127.0.0.1', port: 1 }), /FIXTURE_NETWORK_FORBIDDEN/);

const [packageDir, expectedVersion, mode = 'preflight'] = process.argv.slice(2);
assert.ok(['preflight', 'overflow'].includes(mode));
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
assert.equal(manifest.version, expectedVersion, 'explicit lane package manifest');
const sdk = await import(pathToFileURL(join(packageDir, 'dist/index.js')).href);
assert.equal(sdk.VERSION, expectedVersion, 'sdk.VERSION export matches the real manifest');
const { ModelRuntime, SettingsManager, SessionManager, DefaultResourceLoader, createAgentSession } = sdk;

const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
const modelsPath = join(agentDir, 'models.json');
await writeFile(modelsPath, JSON.stringify({ providers: { 'fixture-static': { baseUrl: 'https://fixture.invalid', api: 'openai-completions',
  apiKey: 'fixture-only-literal', models: [{ id: 'static-model' }] } } }));
await writeFile(join(agentDir, 'auth.json'), '{}');
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath, allowModelNetwork: false });
const model = modelRuntime.getModel('fixture-static', 'static-model');
assert.ok(model); assert.equal(modelRuntime.getModel('not-configured', 'not-configured'), undefined);
assert.ok((await modelRuntime.getAvailable('fixture-static')).some(m => m.id === 'static-model'));
assert.ok(modelRuntime.getModels('anthropic').length > 0); // built-in catalogue resolution, not auth/inference

const compactionUsage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: mode === 'overflow', keepRecentTokens: 1, reserveTokens: 1024 }, retry: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
  ...isolatedResourceOptions(),
  systemPrompt: 'FIXTURE ONLY', appendSystemPrompt: [],
  extensionFactories: [pi => {
    pi.on('session_before_compact', event => ({ compaction: { summary: 'FIXTURE custom compaction; no inference',
      firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, usage: compactionUsage } }));
    pi.on('session_start', () => {
      pi.registerTool({ name: 'forbidden_after_start', label: 'fixture', description: 'fixture', parameters: { type: 'object', properties: {} },
        async execute() { throw new Error('not allowed'); } });
      pi.setActiveTools(['read', 'forbidden_after_start', 'bash']);
    });
  }] });
await resourceLoader.reload();
const sessionManager = SessionManager.inMemory(cwd);
for (let i = 0; i < 3; i++) {
  sessionManager.appendMessage({ role: 'user', content: 'fixture historical text '.repeat(100), timestamp: i * 2 });
  sessionManager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `fixture reply ${i}` }], api: model.api,
    provider: model.provider, model: model.id, usage: compactionUsage, stopReason: 'stop', timestamp: i * 2 + 1 });
}
const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, settingsManager, resourceLoader,
  tools: ['read'], sessionManager });
session.agent.streamFunction = () => { throw new Error('INFERENCE_FORBIDDEN'); };
const compactionEvents = [];
session.subscribe(event => {
  if (event.type === 'compaction_start' || event.type === 'compaction_end') {
    assert.ok(compactionEvents.length < 3, 'bounded dispatcher event capture');
    compactionEvents.push(event);
  }
});
try {
  await session.bindExtensions({ mode: 'json' });
  assert.deepEqual(session.getActiveToolNames(), ['read']);
  assert.equal(session.getAllTools().length, 1);
  assert.equal(session.getAllTools()[0].sourceInfo.source, 'builtin');
  assert.equal(resourceLoader.getAgentsFiles().agentsFiles.length, 0);
  assert.equal(resourceLoader.getSkills().skills.length, 0);
  assert.equal(resourceLoader.getPrompts().prompts.length, 0);
  if (mode === 'overflow') {
    const overflow = () => ({ role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: compactionUsage, stopReason: 'error', errorMessage: 'context_length_exceeded', timestamp: Date.now() + 10000 });
    // Actual Pi dispatcher, exactly the independent M1 repro. No prompt(),
    // agent.continue(), provider request or summarizer inference is invoked.
    assert.equal(await session._checkCompaction(overflow()), true);
    assert.equal(await session._checkCompaction(overflow()), false);
    assert.deepEqual(compactionEvents.map(e => e.type), ['compaction_start', 'compaction_end', 'compaction_end']);
    assert.equal(compactionEvents[1].willRetry, true);
    assert.equal(compactionEvents[2].willRetry, false);
    assert.equal(compactionEvents[2].result, undefined);
    assert.match(compactionEvents[2].errorMessage, /recovery failed after one compact-and-retry attempt/);
  } else {
    const result = await session.compact(); // real SDK lifecycle, extension-provided deterministic summary/usage
    assert.equal(result.usage.totalTokens, 3);
    assert.deepEqual(compactionEvents.map(e => e.type), ['compaction_start', 'compaction_end']);
  }
  assert.deepEqual(compactionEvents[1].result.usage, compactionUsage);
  assert.deepEqual(sessionManager.getEntries().filter(e => e.type === 'compaction').map(e => e.usage), [compactionUsage]);
} finally { session.dispose(); }

console.log(JSON.stringify({ version: expectedVersion, sdkVersionExport: sdk.VERSION, entrypoint: join(packageDir, 'dist/index.js'),
  mode, staticModel: `${model.provider}/${model.id}`, builtinCatalogue: true, refreshAllowlist: ['read'],
  compactionEvents: compactionEvents.map(e => ({ type: e.type, reason: e.reason, willRetry: e.willRetry, aborted: e.aborted,
    hasResult: e.result !== undefined, errorMessage: e.errorMessage })),
  summaryUsage: compactionUsage, noInference: true, networkGuard: 'fetch-and-TCP-denied',
  skippedOutOfScope: ['stock-grep-counterexample', 'real-provider-overflow-recovery'] }));
