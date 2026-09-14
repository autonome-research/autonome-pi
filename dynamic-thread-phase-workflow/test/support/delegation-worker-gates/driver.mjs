// FIXTURE ONLY AUTHORITY: three-node, in-memory responder, not the production scheduler.
// No fsync journal, durable grants, leases, cancellation or process-group settlement proof.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, chmod, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { workerEnvironment, profileDirectories } from '../../../worker/profile.mjs';
import { buildDelegationContext, buildOwnChildJoinIndex, projectArtifactRead } from '../../../lib/delegation-context.mjs';
import { validateDelegationRequest, validateCompletionRequest, VERSIONS } from '../../../lib/delegation-contract.mjs';
import { runBoundedProcess } from '../../../lib/subprocess.mjs';
import { createProcessJournal } from '../../../lib/process-journal.mjs';
import { frames, send } from './frames.mjs';
export const supportDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(supportDir, '../../../..');
export const versions = [
  { version: '0.85.1', packageDir: '/home/velvet/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent', cliPath: '/home/velvet/.npm-global/bin/pi' },
  { version: '0.84.2', packageDir: join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent'), cliPath: join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js') },
];
export const sha = text => createHash('sha256').update(text).digest('hex');
const assignment = { task: 'fixture assignment', acceptance: [{ id: 'assignment', criterion: 'fixture criterion' }] };
export const workerNames = depth => ['grep', 'read', 'workflow_complete', 'workflow_context', ...(depth === 0 ? ['bash', 'write'] : []), ...(depth < 2 ? ['workflow_delegate'] : [])].sort();

export async function runFixture(version, mode = 'tree', options = {}) {
  if (process.env.PI_DELEGATION_COMPAT_FIXTURES !== '1') throw new Error('FIXTURE_EXECUTION_NOT_ENABLED');
  const manifest = JSON.parse(await readFile(join(version.packageDir, 'package.json'), 'utf8'));
  if (manifest.version !== version.version) throw new Error('UNSUPPORTED_VERSION: explicit Pi package changed');
  const root = await mkdtemp(join(tmpdir(), 'worker-gates-'));
  const cwd = join(root, 'workspace'); const socketPath = join(root, 'bridge.sock');
  const records = []; const trace = []; const active = new Set(); const sockets = new Set();
  let sequence = 0, commandStarts = 0, infrastructureError, server;
  try {
  await chmod(root, 0o700);
  await mkdir(join(cwd, 'allowed'), { recursive: true }); await mkdir(join(cwd, 'denied'));
  await writeFile(join(cwd, 'allowed/ok.txt'), 'NEEDLE allowed\n');
  await writeFile(join(cwd, 'denied/secret.txt'), 'NEEDLE forbidden-secret\n');
  await symlink('../denied/secret.txt', join(cwd, 'allowed/link'));
  const poison = "import {writeFileSync} from 'node:fs'; export default function(){writeFileSync('DISCOVERY_EXECUTED','bad');throw new Error('DISCOVERY_EXECUTED')}";
  await mkdir(join(cwd, '.pi/extensions'), { recursive: true });
  await writeFile(join(cwd, '.pi/extensions/poison.ts'), poison);
  await writeFile(join(cwd, '.pi/settings.json'), JSON.stringify({ extensions: ['./extensions/poison.ts'], defaultProjectTrust: 'always' }));
  await writeFile(join(cwd, 'AGENTS.md'), 'POISON_CONTEXT');
  server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let owner;
    frames(socket, frame => {
      void handle(frame).catch(error => { infrastructureError = error; socket.destroy(); });
    }, error => { infrastructureError = error; socket.destroy(); });
    async function handle(frame) {
      if (frame.schema !== 'fixture-request/v1') throw new Error('UNSUPPORTED_VERSION');
      const record = records.find(r => r.capability === frame.capability);
      if (!record || (owner && owner !== record) || (record.socket && record.socket !== socket)) throw new Error('UNAUTHORIZED');
      owner = record; record.socket = socket;
      if (++record.requests > 64) throw new Error('REQUEST_LIMIT');
      const response = data => send(socket, { schema: 'fixture-response/v1', requestId: frame.requestId, ...data });
      trace.push({ sequence: ++sequence, stage: 'request', depth: record.depth, type: frame.type, requestId: frame.requestId });
      const index = () => buildOwnChildJoinIndex({ artifactId: `artifact:index-${record.depth}-${record.results.length}`, ownerNodeId: record.nodeId,
        revision: record.results.length, children: record.results });
      switch (frame.type) {
        case 'hello': return response({ status: 'ready' });
        case 'context': {
          if (options.failContext) { socket.destroy(); return; }
          const nodes = records.map(r => ({ nodeId: r.nodeId, treeRootNodeId: 'node0', ...(r.depth ? { parentNodeId: `node${r.depth - 1}` } : {}),
            phaseIndex: 0, depth: r.depth, label: `depth${r.depth}`, state: r.joined ? 'joined' : 'running', task: assignment.task,
            scopePreview: 'fixture scope', createdSequence: r.depth,
            ...(r.joined ? { resultArtifactId: r.result.resultArtifactId, resultStatus: r.result.status } : {}) }));
          const self = nodes.find(n => n.nodeId === record.nodeId);
          const context = buildDelegationContext({ runId: 'fixture-run', budgetScopeId: 'fixture-budget', directoryRevision: sequence, asOfEventSequence: sequence,
            workflowContext: { objective: 'FIXTURE ONLY', constraints: ['No network', 'No operational workflow'] },
            self: { nodeId: self.nodeId, treeRootNodeId: self.treeRootNodeId, ...(record.depth ? { parentNodeId: self.parentNodeId } : {}),
              depth: self.depth, state: self.state, label: self.label, grantedPermissions: record.depth ? 'r' : 'rwx',
              grantedTools: record.depth ? ['read', 'grep'] : ['read', 'grep', 'write', 'bash'],
              directoryScope: { read: ['allowed'], write: record.depth ? [] : ['allowed'] }, agentBudget: 3 - record.depth,
              spent: 1, available: 2 - record.depth, reservedForChildren: 0 }, assignment,
            ancestors: nodes.filter(n => n.depth < record.depth).map(n => ({ nodeId: n.nodeId, label: n.label, constraintsSummary: 'fixture ancestor' })),
            nodes, evidence: [], inheritedArtifactIds: [], ownChildJoinIndex: index().reference });
          record.revision = sequence;
          return response({ status: 'context', context });
        }
        case 'delegate': {
          validateDelegationRequest(frame.args);
          if (record.candidate || record.depth >= 2 || record.results.length || record.delegating) return response({ status: 'denied', accepted: false, code: 'PARENT_NOT_ACTIVE' });
          if (frame.args.directoryRevision !== record.revision) return response({ status: 'denied', accepted: false, code: 'STALE_CONTEXT' });
          if (frame.args.children.length !== 1) throw new Error('UNSUPPORTED_MODE: fixture single child');
          record.delegating = true;
          trace.push({ sequence: ++sequence, stage: 'park', depth: record.depth, pid: record.pid });
          if (mode === 'disconnect') { trace.push({ stage: 'fixture-accepted-no-durable-record' }); socket.destroy(); return; }
          const child = await launch(record.depth + 1);
          if (child.code !== 0 || !child.candidate) throw new Error('FIXTURE_CHILD_FAILED');
          const childResult = { schema: VERSIONS.result, childNodeId: child.nodeId, status: 'success', summary: child.candidate.summary,
            resultHash: sha(JSON.stringify(child.candidate)), resultArtifactId: `artifact:result-${child.depth}` };
          child.joined = true; child.result = childResult; record.results.push(childResult); record.delegating = false;
          trace.push({ sequence: ++sequence, stage: 'return', depth: record.depth, pid: record.pid });
          return response({ status: 'joined', accepted: true, results: [childResult] });
        }
        case 'artifact': {
          const own = index();
          return response({ status: 'context', page: projectArtifactRead(own.reference, own.content, frame.args, [own.reference.artifactId]) });
        }
        case 'complete':
          validateCompletionRequest(frame.args, { assignment, joinedChildren: record.results, visibleArtifactIds: [] });
          if (record.delegating || record.candidate) throw new Error('PARENT_NOT_ACTIVE');
          record.candidate = frame.args;
          trace.push({ sequence: ++sequence, stage: 'candidate-not-process-success', depth: record.depth, pid: record.pid });
          return response({ status: 'completion_recorded', accepted: true });
        case 'shell_execute': {
          if (record.depth || record.candidate || frame.command !== 'printf fixture-shell') throw new Error('PERMISSION_DENIED');
          // REAL existing bounded runner executor; acceptance/journal authority is fixture-only.
          // Fixed no-descendant command; this does not test orphan-group draining.
          const journal = createProcessJournal(root, 'fixture-run');
          const token = journal.reserve();
          const output = await runBoundedProcess('/bin/bash', ['--noprofile', '--norc', '-c', frame.command], {
            cwd, env: record.env, timeoutMs: Math.min(1000, frame.timeoutMs ?? 1000), killGraceMs: 100,
            maxStdoutBytes: 4096, maxStderrBytes: 4096,
            onNoChild() { journal.noChild(token); },
            onChildStart(child) { journal.started(token, child.pid); commandStarts++; trace.push({ stage: 'runner-command-start', requestId: frame.requestId, pid: child.pid, token }); },
            onChildEnd() { journal.ended(token); },
          });
          if (!output.ok) throw new Error('FIXTURE_COMMAND_FAILED');
          trace.push({ stage: 'real-process-journal', journal: JSON.parse(await readFile(join(root, 'workflow-processes.json'), 'utf8')) });
          return response({ status: 'command_result', exitCode: output.code, output: output.stdout });
        }
        default: throw new Error('INVALID_REQUEST');
      }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  const socketMode = (await stat(socketPath)).mode & 0o777;
  async function launch(depth) {
    if (depth > 2 || records.length >= 3) throw new Error('FIXTURE_NODE_LIMIT');
    const directories = profileDirectories(join(root, `worker${depth}`));
    for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true, mode: 0o700 });
    const env = workerEnvironment({ ...directories, tmpDir: root, nodePath: process.execPath });
    await mkdir(join(directories.agentDir, 'extensions'));
    await writeFile(join(directories.agentDir, 'extensions/poison.ts'), poison);
    await writeFile(join(directories.agentDir, 'AGENTS.md'), 'POISON_GLOBAL_CONTEXT');
    await writeFile(join(directories.agentDir, 'settings.json'), JSON.stringify({ packages: [], extensions: [], skills: [], prompts: [],
      defaultProjectTrust: 'never', compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 } }));
    await writeFile(join(directories.agentDir, 'auth.json'), '{}');
    await writeFile(join(directories.agentDir, 'models.json'), '{}');
    const record = { depth, nodeId: `node${depth}`, invocationId: `fixture-invocation-${depth}`, capability: randomBytes(32).toString('hex'),
      requests: 0, events: [], results: [], env, stderr: '', stdout: '', code: null };
    records.push(record);
    const args = ['--import', join(supportDir, 'no-network.mjs'), version.cliPath,
      '--mode', 'json', '--print', '--no-session', '--no-approve', '--no-extensions', '--no-skills', '--no-themes', '--no-prompt-templates', '--no-context-files',
      '--system-prompt', 'FIXTURE ONLY deterministic protocol compatibility', '--append-system-prompt', 'No discovery.',
      '--tools', workerNames(depth).join(','), ...(options.missingProvider ? [] : ['-e', join(supportDir, 'provider.ts')]), '-e', join(supportDir, 'worker.ts'),
      ...(options.impostor ? ['-e', join(supportDir, 'impostor.ts')] : []),
      '--provider', 'delegation-fixture', '--model', 'deterministic', '--thinking', 'off', JSON.stringify({ depth, mode })];
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], detached: true });
    record.pid = child.pid; active.add(child);
    child.stdio[3].on('error', () => {});
    child.stdio[3].end(options.missingBootstrap ? '' : JSON.stringify({ schema: 'fixture-bootstrap/v1', capability: record.capability,
      socketPath, invocationId: record.invocationId, depth, mode }));
    let outputBytes = 0;
    frames(child.stdout, event => { record.events.push(event); trace.push({ sequence: ++sequence, stage: 'worker-event', depth, eventType: event.type }); }, error => {
      infrastructureError = error; try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, 256 * 1024);
    child.stdout.on('data', data => { outputBytes += data.length; if (outputBytes > 2 * 1024 * 1024) { infrastructureError = new Error('FIXTURE_OUTPUT_LIMIT'); try { process.kill(-child.pid, 'SIGKILL'); } catch {} } else record.stdout += data.toString(); });
    let stderrPending = '', stderrBytes = 0;
    child.stderr.on('data', data => {
      stderrBytes += data.length;
      if (stderrBytes > 256 * 1024) { infrastructureError = new Error('FIXTURE_STDERR_LIMIT'); try { process.kill(-child.pid, 'SIGKILL'); } catch {} return; }
      if (record.stderr.length < 32768) record.stderr += data.toString();
      stderrPending += data.toString();
      if (stderrPending.length > 65536) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} infrastructureError = new Error('FIXTURE_STDERR_LIMIT'); return; }
      let newline;
      while ((newline = stderrPending.indexOf('\n')) >= 0) {
        const line = stderrPending.slice(0, newline); stderrPending = stderrPending.slice(newline + 1);
        if (line.startsWith('{"type":"fixture_')) {
          try { const event = JSON.parse(line); record.events.push(event); trace.push({ sequence: ++sequence, stage: 'worker-event', depth, eventType: event.type }); }
          catch { infrastructureError = new Error('FIXTURE_AUDIT_INVALID'); }
        }
      }
    });
    const timer = setTimeout(() => { infrastructureError = new Error('FIXTURE_TIMEOUT'); try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 20000);
    try {
      const [code, signal] = await once(child, 'close'); record.code = code; record.signal = signal;
      trace.push({ sequence: ++sequence, stage: 'exit', depth, pid: child.pid, code });
    } finally { clearTimeout(timer); active.delete(child); }
    return record;
  }
    await launch(0);
    if (infrastructureError) throw infrastructureError;
    const mutation = await readFile(join(cwd, 'allowed/mutation'), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    const poisonExecuted = await readFile(join(cwd, 'DISCOVERY_EXECUTED'), 'utf8').catch(e => { if (e.code === 'ENOENT') return false; throw e; });
    for (const record of records) if (record.stdout.includes(record.capability) || record.stderr.includes(record.capability)) throw new Error('FIXTURE_CAPABILITY_LEAK');
    return { version: manifest.version, packageDir: version.packageDir, records: records.map(({ capability, socket, env, ...rest }) => rest),
      trace, mutation, poisonExecuted, commandStarts, socketMode, cleaned: true };
  } finally {
    for (const child of active) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    await Promise.all([...active].map(child => once(child, 'close').catch(() => {})));
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
