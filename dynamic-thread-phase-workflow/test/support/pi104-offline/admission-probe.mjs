// FIXTURE ONLY: offline admission evidence for the exact production
// createWorkerModelRuntime path in worker/sdk-runner.mjs. Synthetic
// non-expired credential only: no refresh, no inference, no network, no real
// auth. Prints exactly one JSON evidence line on stdout; the process still
// fail-stops with exit 70 whenever the bound production runner rejects the
// SDK, so a rejection can never masquerade as a pass.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { createWorkerModelRuntime } from '../../../worker/sdk-runner.mjs';

if (process.env.PI_DELEGATION_COMPAT_FIXTURES !== '1') throw new Error('FIXTURE_EXECUTION_NOT_ENABLED');
assert.throws(() => globalThis.fetch('https://fixture.invalid'), /FIXTURE_NETWORK_FORBIDDEN/);
assert.throws(() => connect({ host: '127.0.0.1', port: 1 }), /FIXTURE_NETWORK_FORBIDDEN/);

const model = { id: 'gpt-5.6-sol', name: 'SYNTHETIC gpt-5.6-sol', api: 'openai-codex-responses', provider: 'openai-codex',
  baseUrl: 'https://fixture.invalid', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
const inferenceForbidden = () => { throw new Error('INFERENCE_FORBIDDEN'); };
const configureModelRuntime = (runtime) => runtime.registerNativeProvider({
  id: 'openai-codex', name: 'Synthetic Codex', baseUrl: model.baseUrl,
  auth: { oauth: {
    async refresh() { throw new Error('REFRESH_FORBIDDEN'); }, // non-expired fixture credential: refresh must not run
    async toAuth(credential) { return { apiKey: credential.access }; },
  } },
  getModels: () => [model],
  stream: inferenceForbidden,
  streamSimple: inferenceForbidden,
});

const setup = JSON.parse(process.argv[2] || '');
try {
  const { setup: bound, sdk, modelRuntime, model: selected } = await createWorkerModelRuntime(setup, { configureModelRuntime });
  const manifest = JSON.parse(await readFile(join(bound.sdkPackagePath, 'package.json'), 'utf8'));
  process.stdout.write(`${JSON.stringify({ admitted: true, sdkVersion: manifest.version, sdkVersionExport: sdk.VERSION,
    provider: selected.provider, model: selected.id,
    authSource: modelRuntime.getProviderAuthStatus('openai-codex').source })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ admitted: false, error: String(error?.message ?? error) })}\n`);
  process.stderr.write('PI_WORKER_FAIL_STOP:ADMISSION_PROBE\n');
  process.exitCode = 70;
}
