import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDelegationBridge } from '../lib/delegation-bridge.mjs';
import { createDelegationJournal } from '../lib/delegation-journal.mjs';
import { createProcessJournal } from '../lib/process-journal.mjs';
import { createDelegationRuntime } from '../lib/delegation-runtime.mjs';
import { workerEnvironment, profileDirectories } from '../worker/profile.mjs';
import { workerNames, supportDir, versions } from './support/delegation-worker-gates/driver.mjs';

for (const version of versions) test(`consent-gated production bridge Pi ${version.version}: parent-child-grandchild continuation`, { skip: process.env.PI_DELEGATION_COMPAT_FIXTURES !== '1', timeout: 90000 }, async t => {
  if (process.platform !== 'linux') return t.skip('production bridge requires Linux anchor');
  const root = await mkdtemp(join(tmpdir(), 'delegation-integration-'));
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts'), profile = join(root, 'profile');
  const directories = profileDirectories(profile);
  await mkdir(join(workspace, 'allowed'), { recursive: true });
  await writeFile(join(workspace, 'allowed/input.txt'), 'fixture bridge input\n');
  for (const path of [artifacts, profile, ...Object.values(directories)]) await mkdir(path, { recursive: true });
  let bridge, journal, output = '';
  try {
    const scope = { read: ['allowed'], write: ['allowed'] };
    const policy = { maxDepth: 2, totalAgentBudget: 3, directoryScope: scope, context: { objective: 'deterministic bridge fixture', constraints: ['No network', 'Use only the private worker bridge'] } };
    journal = createDelegationJournal({ artifactDirectory: artifacts, workspace, protectedDirectories: [profile], runId: 'bridge-fixture-run',
      specDigest: createHash('sha256').update('bridge-fixture-spec').digest('hex'), profileDigest: createHash('sha256').update(version.version).digest('hex'), policy,
      roots: [{ phaseIndex: 0, agentBudget: 3, label: 'root', task: 'fixture assignment', permissions: 'rwx', directoryScope: scope, deadlineAt: null }] });
    const processJournal = createProcessJournal(artifacts, 'bridge-fixture-run');
    // Keep the bridge directly under the process-isolated TMPDIR: nested
    // profile paths can exceed Linux's AF_UNIX pathname limit.
    bridge = await createDelegationBridge({ tmpDir: tmpdir() });
    const runtime = createDelegationRuntime({ journal, processJournal, bridge, phases: [{ type: 'agent', name: 'root' }],
      operator: { maxConcurrentAgents: 1, maxLiveAgents: 3 }, deadlinePolicy: { supervised: true },
      worker(node) {
        let depth = 0, current = node;
        const all = journal.snapshot().state.nodes;
        while (current.parentNodeId) { depth++; current = all.find(item => item.nodeId === current.parentNodeId); }
        const tools = workerNames(depth);
        const args = ['--import', join(supportDir, 'no-network.mjs'), '--import', join(supportDir, 'strict-no-network.mjs'), version.cliPath, '--mode', 'json', '--print', '--no-session', '--no-approve', '--no-extensions', '--no-skills', '--no-themes', '--no-prompt-templates', '--no-context-files', '--system-prompt', 'FIXTURE ONLY', '--tools', tools.join(','), '-e', join(supportDir, 'provider.ts'), '-e', join(process.cwd(), 'dynamic-thread-phase-workflow/worker/index.ts'), '--provider', 'delegation-fixture', '--model', 'deterministic', '--thinking', 'off', JSON.stringify({ depth, mode: 'tree' })];
        return { command: process.execPath, args, tools, onStdout: chunk => { output += chunk; }, env: {
          ...workerEnvironment({ ...directories, tmpDir: dirname(bridge.socketPath), nodePath: process.execPath }),
          PI_DELEGATION_BRIDGE_SOCKET: bridge.socketPath, PI_DELEGATION_COMPAT_FIXTURES: '1',
        } };
      },
    });
    const result = await runtime.run();
    assert.deepEqual(result, { status: 'success', held: false, closed: true, code: null });
    const state = journal.snapshot().state;
    assert.equal(state.nodes.length, 3); assert.equal(state.budget.spent, 3);
    assert.ok(state.nodes.every(node => node.joined && node.closed && node.result));
    assert.equal(state.batches.length, 2); assert.ok(state.batches.every(batch => batch.joined));
    t.diagnostic(`production bridge ${version.version}: 3 real SDK workers, 2 durable delegation batches, 3 charged activations, closed journal`);
  } finally {
    await bridge?.close().catch(() => {}); journal?.dispose(); await rm(root, { recursive: true, force: true });
  }
});
