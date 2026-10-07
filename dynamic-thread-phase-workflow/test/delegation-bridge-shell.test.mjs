// Offline integration regression for the worker-bash result contract spanning
// the REAL runtime node handle, the REAL bridge transport and the REAL
// runnerBashOperations primitive (only the Pi SDK/model is a finite fixture
// process). Baseline v0.19.0 fails here: the handle dropped the executor exit
// code, so every shell_execute reached the worker without an integer exitCode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDelegationRuntime } from '../lib/delegation-runtime.mjs';
import { createDelegationBridge } from '../lib/delegation-bridge.mjs';
import { createDelegationJournal } from '../lib/delegation-journal.mjs';
import { createProcessJournal } from '../lib/process-journal.mjs';
import { readStoredArtifact, decodeCanonical } from '../lib/delegation-storage.mjs';
import { probeGroup } from '../lib/scoped-process.mjs';

const worker = new URL('./support/delegation-runtime/bridge-shell-worker.mjs', import.meta.url).pathname;
const pause = ms => new Promise(r => setTimeout(r, ms));

test('worker bash result contract: real handle + real bridge + real runnerBashOperations', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'v3-bash-contract-'));
  for (const d of ['workspace/src', 'profile', 'artifacts', 'bridge']) fs.mkdirSync(join(dir, d), { recursive: true, mode: 0o700 });
  const scope = { read: ['src'], write: ['src'] };
  const j = createDelegationJournal({ artifactDirectory: join(dir, 'artifacts'), workspace: join(dir, 'workspace'),
    protectedDirectories: [join(dir, 'profile')], runId: 'bash-contract-fixture',
    specDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
    policy: { maxDepth: 0, totalAgentBudget: 1, directoryScope: scope, context: { objective: 'finite', constraints: [] } },
    roots: [{ phaseIndex: 0, agentBudget: 1, label: 'root', task: 'finite bash contract', permissions: 'rwx', directoryScope: scope, deadlineAt: null }] });
  const pj = createProcessJournal(join(dir, 'artifacts'), 'bash-contract-fixture');
  const owned = new Set();
  const originalStarted = pj.started;
  pj.started = (token, pid) => { owned.add(pid); originalStarted(token, pid); };
  const bridge = await createDelegationBridge({ tmpDir: join(dir, 'bridge') });
  // The worker child inherits the no-network preload, which only permits
  // AF_UNIX connects under TMPDIR; the bridge must not fall back outside it.
  assert.ok(bridge.socketPath.startsWith(`${dir}/`), `bridge socket inside isolated fixture dir: ${bridge.socketPath}`);
  const gate = join(dir, 'gate');
  const results = new Map();
  let ready, handle, partial = '';
  const allResults = new Promise(r => { ready = r; });
  const runtime = createDelegationRuntime({ journal: j, processJournal: pj, bridge,
    phases: [{ type: 'agent', name: 'root' }], deadlinePolicy: { supervised: true },
    worker() {
      return { command: process.execPath, args: [worker, gate], env: { ...process.env },
        onStdout(chunk) {
          partial += chunk;
          while (partial.includes('\n')) {
            const at = partial.indexOf('\n'), line = partial.slice(0, at);
            partial = partial.slice(at + 1);
            const event = JSON.parse(line);
            if (event.type === 'session' && event.id === 'shell-result') results.set(event.name, event);
            if (event.type === 'session' && event.id === 'ready') ready();
          }
        } };
    },
    onInvocation(h) {
      handle = h;
      return allResults.then(() => {
        h.complete('complete', { status: 'success', summary: 'finite claim',
          acceptance: [{ id: 'assignment', outcome: 'passed', evidenceIds: [] }],
          evidence: [], remainingWork: [], childReviews: [] });
        fs.writeFileSync(gate, 'done');
      });
    } });
  t.after(async () => {
    fs.writeFileSync(gate, 'finite cleanup release');
    for (const pid of owned) {
      const end = Date.now() + 6500;
      while (probeGroup(pid) === 'present' && Date.now() < end) await pause(20);
      assert.equal(probeGroup(pid), 'gone', `live-owned group ${pid}`);
    }
    await bridge.close(); j.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  const result = await runtime.run();
  // The timed-out shell taints the scope settlement: the node's durable result
  // is timeout/TIMEOUT and the phase fails, never collapsed into success.
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'PHASE_FAILED');
  assert.equal(result.held, false); assert.equal(result.closed, true);
  assert.ok(handle, 'real runtime node handle was bound through the real bridge');
  const node = j.snapshot().state.nodes[0];
  const content = decodeCanonical(readStoredArtifact(j.directory,
    { artifactId: node.result.artifactId, bytes: node.result.bytes, sha256: node.result.sha256 }));
  assert.equal(content.status, 'timeout'); assert.equal(content.cause, 'TIMEOUT');
  assert.equal(runtime.inspect().outputs.root.status, 'timeout');

  // Normal zero exit: real exit code and bounded stdout reach the worker.
  assert.equal(results.get('zero')?.exitCode, 0);
  assert.equal(results.get('zero')?.data, 'zero-ok');
  // Ordinary nonzero exit is ordinary completion with the real code, not an
  // error and not collapsed to success; bounded stderr stays at the runner.
  assert.equal(results.get('nonzero')?.exitCode, 3);
  assert.equal(results.get('nonzero')?.data, 'out-line');
  assert.ok(!results.get('nonzero')?.data?.includes('err-line'));
  // Timeout has no exit code: fail-closed, never a fabricated command_result.
  assert.match(results.get('timeout')?.error ?? '', /OWNERSHIP_UNKNOWN/);
  assert.equal(results.get('timeout')?.exitCode, undefined);
  // Pre-aborted signal throws before any bridge dispatch.
  assert.match(results.get('aborted')?.error ?? '', /cancelled before dispatch/);
  assert.equal(results.get('aborted')?.exitCode, undefined);

  // Durable side: exactly worker + 3 shells; the aborted scenario dispatched
  // nothing; timeout is journaled with null code and its real signal.
  const commands = j.snapshot().state.commands;
  assert.equal(commands.length, 4);
  const shells = commands.filter(c => c.occurrence >= 2);
  assert.equal(shells.length, 3);
  assert.deepEqual(shells.map(c => c.result.classification), ['clean', 'nonzero', 'timeout']);
  assert.equal(shells[0].result.code, 0);
  assert.equal(shells[1].result.code, 3);
  assert.equal(shells[2].result.code, null);
  assert.equal(shells[2].result.signal, 'SIGTERM');
  assert.ok(commands.every(c => !c.slots.length && c.disposition === 'drained' && probeGroup(c.pid) === 'gone'));
});
