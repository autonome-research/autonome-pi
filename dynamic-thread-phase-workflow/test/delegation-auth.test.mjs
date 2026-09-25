// UNEXECUTED: parent validation runs this consent-gated file in the fixed offline shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectWorkerEvent, validateWorkerSetup } from '../worker/sdk-runner.mjs';
import { invocationUsage } from '../lib/delegation-usage.mjs';
import { workerEnvironment, profileDirectories } from '../worker/profile.mjs';
import { createDelegationBridge } from '../lib/delegation-bridge.mjs';
import { createDelegationJournal } from '../lib/delegation-journal.mjs';
import { createDelegationRuntime } from '../lib/delegation-runtime.mjs';
import { createProcessJournal } from '../lib/process-journal.mjs';
import { readStoredArtifact } from '../lib/delegation-storage.mjs';
import { runBoundedProcess } from '../lib/subprocess.mjs';
import { versions, supportDir } from './support/delegation-worker-gates/driver.mjs';

const probe = join(supportDir, 'shared-auth-probe.mjs');
const noNetwork = join(supportDir, 'no-network.mjs');
const strictNoNetwork = join(supportDir, 'strict-no-network.mjs');
const aiVersions = Object.freeze({ '0.86.0': '0.86.0', '0.84.2': '0.84.2' });
const consentTest = (name, options, fn) => test(name, { ...options, skip: process.env.PI_DELEGATION_COMPAT_FIXTURES !== '1' }, fn);
const credential = (expires = 0) => ({ 'openai-codex': { type: 'oauth', access: 'synthetic-expired-access',
  refresh: 'synthetic-refresh-value', expires } });

async function directories(root, name) {
  const value = profileDirectories(join(root, name));
  for (const path of Object.values(value)) await mkdir(path, { recursive: true, mode: 0o700 });
  return value;
}
function setup(version, dirs, authPath, prompt = 'Complete the synthetic bounded assignment.') {
  return { schema: 'pi-workflow-sdk-worker/v1', sdkPackagePath: version.packageDir, authPath,
    agentDir: dirs.agentDir, tools: ['workflow_context', 'workflow_complete'], prompt };
}
function environment(dirs, socketPath) {
  return { ...workerEnvironment({ ...dirs, ...(socketPath ? { tmpDir: dirname(socketPath) } : {}), nodePath: process.execPath }),
    PI_DELEGATION_COMPAT_FIXTURES: '1', ...(socketPath ? { PI_DELEGATION_BRIDGE_SOCKET: socketPath } : {}) };
}
async function runProbe(config, dirs, socketPath) {
  return runBoundedProcess(process.execPath, ['--import', noNetwork, '--import', strictNoNetwork, probe, JSON.stringify(config)], {
    cwd: dirs.home, env: environment(dirs, socketPath), timeoutMs: 15000, killGraceMs: 100,
    maxStdoutBytes: 256 * 1024, maxStderrBytes: 64 * 1024,
  });
}
async function absent(path) {
  try { await readFile(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

test('SDK worker setup is explicit and keeps shared auth outside the isolated profile', () => {
  const valid = { schema: 'pi-workflow-sdk-worker/v1', sdkPackagePath: '/sdk', authPath: '/shared/auth.json',
    agentDir: '/worker/agent', tools: ['workflow_complete'], prompt: 'bounded' };
  assert.deepEqual(validateWorkerSetup(valid).tools, ['workflow_complete']);
  assert.throws(() => validateWorkerSetup({ ...valid, authPath: '/worker/agent/auth.json' }), /outside worker profile/);
  assert.throws(() => validateWorkerSetup({ ...valid, model: 'fallback' }), /setup/);
  assert.throws(() => validateWorkerSetup({ ...valid, sdkPackagePath: 'ambient' }), /sdkPackagePath/);
  assert.throws(() => validateWorkerSetup({ ...valid, tools: ['workflow_complete', 'workflow_complete'] }), /tools/);
});

test('SDK worker stdout projects only bounded lifecycle and usage fields', () => {
  const secret = 'PRIVATE_SENTINEL_EVENT_CONTENT';
  const usage = { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, extra: { secret } };
  const raw = [
    { type: 'turn_start', prompt: secret },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'error', usage,
      content: [{ type: 'text', text: secret }], errorMessage: secret, providerMetadata: { secret } }, rawError: { secret } },
    { type: 'compaction_start', reason: 'manual', context: secret },
    { type: 'compaction_end', reason: 'manual', result: { usage, summary: secret, details: { secret } },
      aborted: true, willRetry: false, errorMessage: secret, error: { secret } },
    { type: 'message_end', message: { role: 'toolResult', usage, content: [{ type: 'text', text: secret }] } },
    { type: 'tool_execution_end', result: { secret }, isError: true },
  ];
  const projected = raw.map(projectWorkerEvent).filter(Boolean);
  assert.deepEqual(projected, [
    { type: 'turn_start' },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'error', usage: {
      input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
    { type: 'compaction_start', reason: 'manual' },
    { type: 'compaction_end', reason: 'manual', aborted: true, willRetry: false,
      result: { usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }, errorMessage: 'SDK_COMPACTION_ERROR' },
  ]);
  const source = invocationUsage('projection-fixture');
  for (const event of projected) source.push(`${JSON.stringify(event)}\n`);
  const result = source.finish();
  assert.equal(result.completeness, 'partial'); assert.equal(result.totals.totalTokens, 14);
  assert.deepEqual(result.counters, { assistant: 1, compaction: 1, missing: 0, partial: 2, ignoredTool: 0, unfinished: 0 });
  assert.deepEqual(result.diagnostic, { type: 'compaction_failure', reason: 'manual', aborted: true,
    willRetry: false, errorMessage: 'SDK_COMPACTION_ERROR' });
  assert.doesNotMatch(projected.map(JSON.stringify).join('\n'), new RegExp(secret));

  const transcript = invocationUsage('sdk-system-message');
  for (const event of [{ type: 'message_end', message: { role: 'system' } }, { type: 'turn_start' },
    projectWorkerEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage } })])
    transcript.push(`${JSON.stringify(event)}\n`);
  assert.equal(transcript.finish().problem, null);
  assert.equal(transcript.finish().totals.totalTokens, 7);

  const malformed = invocationUsage('projection-malformed');
  for (const event of [{ type: 'turn_start' }, projectWorkerEvent({ type: 'message_end',
    message: { role: 'assistant', stopReason: 'stop', usage: { ...usage, output: -1 } } })])
    malformed.push(`${JSON.stringify(event)}\n`);
  assert.equal(malformed.finish().completeness, 'missing');

  for (const stopReason of [undefined, null, '', secret, 7, {}]) {
    const source = invocationUsage('projection-invalid-stop');
    source.push(`${JSON.stringify(projectWorkerEvent({ type: 'turn_start' }))}\n`);
    const projected = projectWorkerEvent({ type: 'message_end', message: { role: 'assistant', stopReason, usage } });
    source.push(`${JSON.stringify(projected)}\n`);
    const result = source.finish();
    assert.equal(result.completeness, 'partial'); assert.equal(result.counters.partial, 1);
    assert.equal(result.totals.totalTokens, 7);
    assert.deepEqual(result.diagnostic, { type: 'assistant_failure', stopReason: 'error' });
    assert.doesNotMatch(JSON.stringify(projected), new RegExp(secret));
  }
  for (const cost of [false, true]) for (const key of Object.keys(cost ? usage.cost : usage).filter(key => typeof (cost ? usage.cost : usage)[key] === 'number')) {
    const invalid = structuredClone(usage);
    (cost ? invalid.cost : invalid)[key] = -0;
    for (const compaction of [false, true]) {
      const source = invocationUsage('projection-negative-zero');
      const events = compaction ? [
        { type: 'compaction_start', reason: 'manual' },
        { type: 'compaction_end', reason: 'manual', result: { usage: invalid }, aborted: false, willRetry: false },
      ] : [{ type: 'turn_start' }, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: invalid } }];
      for (const event of events) source.push(`${JSON.stringify(projectWorkerEvent(event))}\n`);
      const result = source.finish();
      assert.equal(result.completeness, 'missing'); assert.equal(result.counters.missing, 1);
      assert.equal(result.totals.totalTokens, 0);
    }
  }

  const retry = invocationUsage('projection-retry');
  for (const event of [
    projectWorkerEvent({ type: 'compaction_start', reason: 'overflow', secret }),
    projectWorkerEvent({ type: 'compaction_end', reason: 'overflow', result: { usage, secret }, aborted: false, willRetry: true }),
    projectWorkerEvent({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: false, errorMessage: secret }),
  ]) retry.push(`${JSON.stringify(event)}\n`);
  const retried = retry.finish();
  assert.equal(retried.completeness, 'reported'); assert.equal(retried.counters.compaction, 1);
  assert.equal(retried.totals.totalTokens, 7); assert.equal(retried.diagnostic.errorMessage, 'SDK_COMPACTION_ERROR');
});

for (const version of versions) consentTest(`Pi ${version.version}: ordinary shared authPath refresh is native, persisted and lock-serialized`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'delegation-shared-auth-'));
  const authPath = join(root, 'shared', 'auth.json'), marker = join(root, 'refreshes');
  const a = await directories(root, 'a'), b = await directories(root, 'b');
  await mkdir(join(root, 'shared'), { recursive: true, mode: 0o700 });
  await writeFile(authPath, JSON.stringify(credential()), { mode: 0o600 });
  let clean = false;
  try {
    const [left, right] = await Promise.all([
      runProbe({ mode: 'auth', setup: setup(version, a, authPath), refreshMarker: marker }, a),
      runProbe({ mode: 'auth', setup: setup(version, b, authPath), refreshMarker: marker }, b),
    ]);
    for (const result of [left, right]) {
      assert.equal(result.ok, true, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout), { provider: 'openai-codex', model: 'gpt-5.6-sol', authSource: 'stored',
        network: 'guarded', aiVersion: aiVersions[version.version] });
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-(?:expired-access|refresh-value|refreshed-access)/);
    }
    assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1);
    const stored = JSON.parse(await readFile(authPath, 'utf8'))['openai-codex'];
    assert.equal(stored.type, 'oauth'); assert.equal(stored.access, 'synthetic-refreshed-access');
    assert.equal(stored.refresh, 'synthetic-refresh-value'); assert.ok(stored.expires > Date.now());
    assert.equal(await absent(join(a.agentDir, 'auth.json')), true); assert.equal(await absent(join(b.agentDir, 'auth.json')), true);
    clean = true;
  } finally {
    if (clean) await rm(root, { recursive: true, force: true }); else t.diagnostic(`retained owned fixture ${root}`);
  }
});

for (const version of versions) consentTest(`Pi ${version.version}: missing and invalid shared auth fail without provider/model fallback`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'delegation-shared-auth-negative-')); let clean = false;
  try {
    for (const [name, contents] of [['missing', null], ['invalid', '{not-json']]) {
      const dirs = await directories(root, name), authPath = join(root, `${name}.json`);
      if (contents !== null) await writeFile(authPath, contents, { mode: 0o600 });
      const result = await runProbe({ mode: 'auth', setup: setup(version, dirs, authPath), refreshMarker: join(root, `${name}.refresh`) }, dirs);
      assert.equal(result.ok, false); assert.equal(result.code, 70);
      assert.equal(result.stdout, ''); assert.equal(result.stderr, 'PI_WORKER_FAIL_STOP:SYNTHETIC_AUTH_PROBE\n');
      assert.equal(await absent(join(root, `${name}.refresh`)), true);
      if (contents === null) assert.equal(await absent(authPath), true);
    }
    clean = true;
  } finally {
    if (clean) await rm(root, { recursive: true, force: true }); else t.diagnostic(`retained owned fixture ${root}`);
  }
});

for (const version of versions) consentTest(`Pi ${version.version}: actual private SDK entry completes through production bridge/runtime`, { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'delegation-sdk-runtime-')); let clean = false, bridge, journal;
  const dirs = await directories(root, `worker-${'long-layout-'.repeat(8)}`);
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts'), authPath = join(root, 'shared-auth.json');
  const discoveryMarker = join(workspace, 'DISCOVERY_EXECUTED'), discoverySecret = 'synthetic-discovery-private-sentinel';
  await mkdir(workspace, { recursive: true }); await mkdir(artifacts, { recursive: true });
  await mkdir(join(dirs.agentDir, 'extensions'), { recursive: true });
  await writeFile(join(dirs.agentDir, 'AGENTS.md'), discoverySecret);
  await writeFile(join(dirs.agentDir, 'extensions/poison.ts'),
    `import {writeFileSync} from 'node:fs'; export default function(){writeFileSync(${JSON.stringify(discoveryMarker)}, ${JSON.stringify(discoverySecret)});throw new Error('DISCOVERY_EXECUTED')}`);
  await writeFile(authPath, JSON.stringify(credential(Date.now() + 3600000)), { mode: 0o600 });
  const output = { stdout: '', stderr: '' };
  try {
    journal = createDelegationJournal({ artifactDirectory: artifacts, workspace, protectedDirectories: [dirs.agentDir],
      runId: `shared-auth-${version.version}`, specDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
      policy: { maxDepth: 0, totalAgentBudget: 1, directoryScope: { read: ['.'], write: [] },
        context: { objective: 'Synthetic connected SDK worker', constraints: ['Offline fixture only'] } },
      roots: [{ phaseIndex: 0, agentBudget: 1, label: 'root', task: 'Complete through the private bridge.', permissions: 'r',
        directoryScope: { read: ['.'], write: [] }, deadlineAt: null }] });
    const processJournal = createProcessJournal(artifacts, `shared-auth-${version.version}`);
    assert.ok(Buffer.byteLength(join(dirs.tmpDir, 's00.sock')) > 107);
    bridge = await createDelegationBridge({ tmpDir: dirs.tmpDir });
    assert.notEqual(dirname(bridge.socketPath), dirs.tmpDir);
    assert.ok(Buffer.byteLength(bridge.socketPath) <= 107);
    const runtime = createDelegationRuntime({ journal, processJournal, bridge, phases: [{ type: 'agent', name: 'root' }],
      deadlinePolicy: { supervised: true }, operator: { maxConcurrentAgents: 1, maxLiveAgents: 1 },
      worker() {
        const workerSetup = setup(version, dirs, authPath);
        return { command: process.execPath,
          args: ['--import', noNetwork, '--import', strictNoNetwork, probe, JSON.stringify({ mode: 'worker', setup: workerSetup })],
          env: environment(dirs, bridge.socketPath), tools: workerSetup.tools,
          onStdout(chunk) { output.stdout += chunk; }, onStderr(chunk) { output.stderr += chunk; } };
      } });
    const result = await runtime.run();
    assert.deepEqual(result, { status: 'success', held: false, closed: true, code: null });
    const state = journal.snapshot().state, node = state.nodes[0];
    assert.equal(node.joined, true); assert.equal(node.closed, true); assert.equal(node.result.status, 'success');
    const evidence = JSON.parse(readStoredArtifact(journal.directory, {
      artifactId: node.result.artifactId, bytes: node.result.bytes, sha256: node.result.sha256,
    }));
    assert.equal(evidence.summary, 'synthetic private SDK worker completed');
    assert.equal(evidence.usage.totals.totalTokens, 7); assert.equal(evidence.usage.completeness, 'reported');
    assert.deepEqual(output.stdout.trim().split('\n').map(JSON.parse), [
      { type: 'turn_start' },
      { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', usage: {
        input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
    ]);
    assert.equal(output.stderr, '');
    const serialized = output.stdout + output.stderr + JSON.stringify(state) + JSON.stringify(evidence) +
      await readFile(join(journal.directory, 'manifest.json'), 'utf8') + await readFile(join(journal.directory, 'events.jsonl'), 'utf8');
    assert.doesNotMatch(serialized, /synthetic-(?:expired-access|refresh-value|refreshed-access|sdk-event-secret)|synthetic-discovery-private-sentinel/);
    assert.doesNotMatch(output.stdout, /toolName|arguments|content|provider|model|errorMessage/);
    assert.equal(await absent(discoveryMarker), true);
    assert.equal(await absent(join(dirs.agentDir, 'auth.json')), true);
    assert.deepEqual(await readdir(dirs.sessionDir), []);
    clean = true;
  } finally {
    await bridge?.close().catch(() => {}); journal?.dispose();
    if (clean) await rm(root, { recursive: true, force: true }); else t.diagnostic(`retained owned fixture ${root}`);
  }
});
