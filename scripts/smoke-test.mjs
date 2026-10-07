#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(new URL('..', import.meta.url).pathname);
const tmp = mkdtempSync(join(tmpdir(), 'autonome-pi-test-'));
const store = join(tmp, 'store');
const testHome = join(tmp, 'home');
mkdirSync(testHome, { recursive: true });
const realHome = process.env.HOME || '';
const realThreadPhaseCorePath = process.env.THREAD_PHASE_CORE_PATH || join(realHome, '.npm-global', 'lib', 'node_modules', '@autonome-research', 'thread-phase-cli', 'node_modules', '@autonome-research', 'thread-phase', 'dist', 'index.js');
const env = { ...process.env, HOME: testHome, PI_THREAD_PHASE_STORE_DIR: store, ...(existsSync(realThreadPhaseCorePath) ? { THREAD_PHASE_CORE_PATH: realThreadPhaseCorePath } : {}) };
process.env.PI_THREAD_PHASE_STORE_DIR = store;
const visualizerStore = await import(pathToFileURL(join(root, 'thread-phase-visualizer/lib/store.mjs')).href);
const detachHelpers = await import(pathToFileURL(join(root, 'detach/index.ts')).href);
let failures = 0;

function log(ok, name, detail = '') {
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const parsedDetach = detachHelpers.parseArgs('--name work --wait "continue the task"');
log(parsedDetach.name === 'work' && parsedDetach.wait === true && parsedDetach.now === false && parsedDetach.prompt === 'continue the task', 'detach parser handles name, wait mode, and quoted prompts');
log(detachHelpers.parseArgs('-- --prompt-like-text').prompt === '--prompt-like-text' && detachHelpers.sanitizeTmuxName(' bad/name ') === 'bad-name' && detachHelpers.sanitizeTmuxName('project.js') === 'project-js', 'detach parser supports option-like prompts and safe tmux names');
log(detachHelpers.shellCommand('mise exec -- pi') === "'mise' 'exec' '--' 'pi'", 'detach command override is shell-quoted token by token');
const resumedLaunchArgs = detachHelpers.preservedLaunchArgs(['--model', 'stale/model', '--thinking', 'low', '--no-context-files', '-e', './guard.ts', '--session', '/old.jsonl', '--tools', 'read', 'initial prompt'], ['read', 'grep'], '/launch', { model: 'current/model', thinking: 'high', trusted: true });
log(resumedLaunchArgs.includes('--no-context-files') && resumedLaunchArgs.includes('/launch/guard.ts') && !resumedLaunchArgs.includes('/old.jsonl') && !resumedLaunchArgs.includes('stale/model') && resumedLaunchArgs.includes('current/model') && resumedLaunchArgs.includes('high') && resumedLaunchArgs.includes('--approve') && resumedLaunchArgs.at(-1) === 'read,grep', 'detach preserves absolute runtime resources, current model/thinking/trust, and the exact effective tool allowlist');
for (const unsafeArgs of [['--api-key', 'secret'], ['--custom-security-flag']]) {
  let rejected = false;
  try { detachHelpers.preservedLaunchArgs(unsafeArgs, ['read']); } catch { rejected = true; }
  log(rejected, `detach rejects launch configuration it cannot safely preserve: ${unsafeArgs[0]}`);
}
const maxName = 'x'.repeat(80);
const suffixedName = detachHelpers.tmuxNameWithSuffix(maxName, 2);
log(suffixedName.length === 80 && suffixedName.endsWith('-2') && suffixedName !== maxName, 'detach collision names reserve room for a unique suffix');
const longDefaultName = detachHelpers.defaultTmuxName(`/tmp/${'project'.repeat(20)}`, '/tmp/session.jsonl');
const expectedSessionHash = createHash('sha1').update('/tmp/session.jsonl').digest('hex').slice(0, 7);
log(longDefaultName.length <= 80 && longDefaultName.endsWith(`-${expectedSessionHash}`), 'detach default names preserve the session hash when truncated');
log(['--flag', '-x', '@secret.txt'].every((prompt) => !detachHelpers.safeInitialPrompt(prompt).startsWith(prompt[0])), 'detach resume prompts cannot be parsed as flags or file attachments');
log(detachHelpers.choosePrompt('', false)?.includes('may have been interrupted') && detachHelpers.choosePrompt('', true) === undefined, 'detach prompt selection resumes interrupted work only');
const preservedDetachEnv = detachHelpers.preservedEnvironmentExports({ TERM: 'xterm-old', GPG_TTY: '/dev/pts/old', PATH: '/bin', OPENAI_API_KEY: 'secret', NVIDIA_API_KEY: 'nvidia', CUSTOM_PROVIDER_KEY: 'custom', PI_DETACH_PRESERVE_ENV: 'CUSTOM_PROVIDER_KEY', DATABASE_PASSWORD: 'unrelated' });
log(!preservedDetachEnv.includes('TERM=') && !preservedDetachEnv.includes('GPG_TTY=') && !preservedDetachEnv.includes('DATABASE_PASSWORD=') && preservedDetachEnv.includes('OPENAI_API_KEY=') && preservedDetachEnv.includes('NVIDIA_API_KEY=') && preservedDetachEnv.includes('CUSTOM_PROVIDER_KEY='), 'detach handoff preserves built-in and configured provider credentials without stale terminal or unrelated secret variables');
log(detachHelpers.shellQuote('/home/user name/wrapper.sh') === "'/home/user name/wrapper.sh'", 'detach wrapper paths with spaces are shell-quoted');
log(detachHelpers.isLastDetach({ name: 'work', cwd: '/tmp', sessionFile: '/tmp/session.jsonl', createdAt: 1 }) && !detachHelpers.isLastDetach({ name: 'work' }), 'detach status restore rejects malformed persisted state');
for (const [name, input] of [['conflicting modes', '--now --wait'], ['missing name', '--name'], ['unterminated quote', '"prompt']]) {
  let rejected = false;
  try { detachHelpers.parseArgs(input); } catch { rejected = true; }
  log(rejected, `detach parser rejects ${name}`);
}

function run(name, args, options = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: options.cwd || root,
    env: { ...env, ...(options.env || {}) },
    encoding: 'utf8',
    timeout: options.timeout || 45_000,
  });
  return result;
}

const projectedTerminalRun = visualizerStore.projectRun([
  { schema: 'thread-phase-ui/v1', eventId: 'e1', timestamp: '2026-01-01T00:00:00.000Z', runId: 'projection-smoke', workflow: 'smoke', type: 'workflow_start', status: 'running' },
  { schema: 'thread-phase-ui/v1', eventId: 'e2', timestamp: '2026-01-01T00:00:01.000Z', runId: 'projection-smoke', workflow: 'smoke', type: 'phase_event', phase: 'worker-a', message: 'work' },
  { schema: 'thread-phase-ui/v1', eventId: 'e3', timestamp: '2026-01-01T00:00:02.000Z', runId: 'projection-smoke', workflow: 'smoke', type: 'artifact', status: 'success', artifact: { kind: 'file', title: 'old', path: '/tmp/repeated-artifact.txt' } },
  { schema: 'thread-phase-ui/v1', eventId: 'e4', timestamp: '2026-01-01T00:00:03.000Z', runId: 'projection-smoke', workflow: 'smoke', type: 'artifact', status: 'success', artifact: { kind: 'file', title: 'new', path: '/tmp/repeated-artifact.txt' } },
  { schema: 'thread-phase-ui/v1', eventId: 'e5', timestamp: '2026-01-01T00:00:04.000Z', runId: 'projection-smoke', workflow: 'smoke', type: 'artifact', status: 'success', artifact: { kind: 'markdown', title: 'inline-a', content: `${'x'.repeat(500)}a` } },
  { schema: 'thread-phase-ui/v1', eventId: 'e6', timestamp: '2026-01-01T00:00:05.000Z', runId: 'projection-smoke', workflow: 'smoke', type: 'artifact', status: 'success', artifact: { kind: 'markdown', title: 'inline-a', content: `${'x'.repeat(500)}b` } },
  { schema: 'thread-phase-ui/v1', eventId: 'e7', timestamp: '2026-01-01T00:00:06.000Z', runId: 'projection-smoke', workflow: 'smoke', type: 'workflow_end', status: 'success' },
]);
log(projectedTerminalRun.phases?.[0]?.normalizedStatus === 'success', 'thread-phase projection closes open phase-event-only phases on successful workflows');
log(projectedTerminalRun.artifacts?.filter((artifact) => artifact.path === '/tmp/repeated-artifact.txt')?.length === 1 && projectedTerminalRun.artifacts.find((artifact) => artifact.path === '/tmp/repeated-artifact.txt')?.title === 'new', 'thread-phase projection dedupes repeated artifact paths');
log(projectedTerminalRun.artifacts?.filter((artifact) => artifact.title === 'inline-a')?.length === 2, 'thread-phase projection does not collapse distinct inline artifacts with shared prefixes');
const projectedRunningRun = visualizerStore.projectRun([
  { schema: 'thread-phase-ui/v1', eventId: 'r1', timestamp: '2026-01-01T00:00:00.000Z', runId: 'running-projection-smoke', workflow: 'smoke', type: 'workflow_start' },
  { schema: 'thread-phase-ui/v1', eventId: 'r2', timestamp: '2026-01-01T00:00:01.000Z', runId: 'running-projection-smoke', workflow: 'smoke', type: 'phase_event', phase: 'worker-a', message: 'still running' },
]);
log(projectedRunningRun.normalizedStatus === 'running' && projectedRunningRun.phases?.[0]?.normalizedStatus === 'running', 'thread-phase projection keeps workflow_start-only runs running');
const projectedUnknownEndRun = visualizerStore.projectRun([
  { schema: 'thread-phase-ui/v1', eventId: 'u1', timestamp: '2026-01-01T00:00:00.000Z', runId: 'unknown-end-projection-smoke', workflow: 'smoke', type: 'workflow_start', status: 'running' },
  { schema: 'thread-phase-ui/v1', eventId: 'u2', timestamp: '2026-01-01T00:00:01.000Z', runId: 'unknown-end-projection-smoke', workflow: 'smoke', type: 'phase_event', phase: 'worker-a', message: 'custom terminal' },
  { schema: 'thread-phase-ui/v1', eventId: 'u3', timestamp: '2026-01-01T00:00:02.000Z', runId: 'unknown-end-projection-smoke', workflow: 'smoke', type: 'workflow_end', status: 'custom-terminal' },
]);
log(projectedUnknownEndRun.normalizedStatus === 'unknown' && projectedUnknownEndRun.phases?.[0]?.normalizedStatus === 'unknown', 'thread-phase projection does not coerce unknown terminal statuses to success');

function expectExit(name, args, expected, options = {}) {
  const result = run(name, args, options);
  const ok = result.status === expected;
  log(ok, name, ok ? '' : `exit ${result.status}; stderr=${(result.stderr || '').slice(0, 300)}`);
  return result;
}

try {
  process.env.PI_THREAD_PHASE_STORE_DIR = store;
  const storeApi = await import('../thread-phase-visualizer/lib/store.mjs');
  const smokeRun = storeApi.createRun({ workflow: 'usage-test', cwd: root, metadata: { sessionId: 'test' } });
  log(String(smokeRun.runFile || '').startsWith(store), 'thread-phase smoke store is isolated to temp directory', smokeRun.runFile || '');
  storeApi.phaseStart(smokeRun, 'agent');
  storeApi.phaseEvent(smokeRun, 'agent', { kind: 'usage', model: 'unit-model', usage: [{ input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 10 }] });
  storeApi.phaseEvent(smokeRun, 'agent', { kind: 'active_io', componentId: 'agent-1', component: 'unit agent --token rawsecret', role: 'pi', status: 'running', inputPreview: 'hello TOKEN="supersecret" --password hunter2', outputPreview: 'world' });
  storeApi.emitActiveIo(smokeRun, 'agent', { componentId: 'agent-1', component: 'unit agent --token rawsecret2', role: 'pi', status: 'running', message: 'Authorization: Bearer abc123', outputPreview: 'tail sk-testsecret1234567890 --token=abc123' });
  storeApi.phaseEnd(smokeRun, 'agent', storeApi.STATUSES.SUCCESS);
  storeApi.completeRun(smokeRun, storeApi.STATUSES.SUCCESS);
  const summary = storeApi.getRunSummary(smokeRun.runId);
  log(summary.usage?.inputTokens === 100 && summary.usage?.outputTokens === 25 && summary.phases?.[0]?.usage?.cachedInputTokens === 10, 'usage projection aggregates run and phase usage', JSON.stringify(summary.usage));
  log(summary.activeIo?.component?.includes('--token [redacted]') && summary.activeIo?.inputPreview?.includes('--password [redacted]') && summary.phases?.[0]?.activeIo?.outputPreview?.includes('[redacted-api-key]') && summary.phases?.[0]?.activeIo?.outputPreview?.includes('--token=[redacted]') && summary.activeIo?.message?.includes('[redacted]'), 'active I/O projection merges snapshots and redacts secrets', JSON.stringify(summary.activeIo));
  const rawIoRun = storeApi.createRun({ workflow: 'active-io-raw-emit-test', cwd: root });
  storeApi.emit(rawIoRun, { type: 'phase_event', phase: 'agent', message: 'TOKEN=rawsecret', data: { kind: 'active_io', component: 'raw --password rawsecret', outputPreview: 'Authorization: Bearer rawsecret', rawPrompt: 'SECRET=leak' } });
  const rawIoEvent = storeApi.readRun(rawIoRun.runId).find((event) => event.data?.kind === 'active_io');
  log(rawIoEvent?.message?.includes('[redacted]') && rawIoEvent?.data?.component?.includes('[redacted]') && rawIoEvent?.data?.outputPreview?.includes('[redacted]') && rawIoEvent?.data?.rawPrompt === undefined, 'raw emit active I/O is allowlisted/redacted before persistence', JSON.stringify(rawIoEvent));
  const autoContinueRun = storeApi.createRun({ workflow: 'autocontinue-test', cwd: root, trigger: { kind: 'background' } });
  storeApi.completeRun(autoContinueRun, storeApi.STATUSES.SUCCESS);
  log(storeApi.getRunSummary(autoContinueRun.runId).metadata?.autoContinue !== true, 'thread-phase auto-continue is opt-in only');

  const noIdIoRun = storeApi.createRun({ workflow: 'active-io-no-id-test', cwd: root });
  storeApi.emitActiveIo(noIdIoRun, 'agent', { component: 'first', inputPreview: 'first input' });
  storeApi.emitActiveIo(noIdIoRun, 'agent', { component: 'second', outputPreview: 'second output' });
  const noIdIoSummary = storeApi.getRunSummary(noIdIoRun.runId);
  log(noIdIoSummary.activeIo?.component === 'second' && !noIdIoSummary.activeIo?.inputPreview, 'active I/O without componentId projects latest snapshot without merging unrelated components', JSON.stringify(noIdIoSummary.activeIo));

  const disabledIoRun = storeApi.createRun({ workflow: 'active-io-disabled-test', cwd: root });
  process.env.PI_THREAD_PHASE_ACTIVE_IO = '0';
  storeApi.phaseEvent(disabledIoRun, 'agent', { kind: 'active_io', component: 'disabled', outputPreview: 'should not persist' });
  storeApi.emit(disabledIoRun, { type: 'phase_event', phase: 'agent', data: { kind: 'active_io', outputPreview: 'should not persist either' } });
  delete process.env.PI_THREAD_PHASE_ACTIVE_IO;
  log(!storeApi.readRun(disabledIoRun.runId).some((event) => event.data?.kind === 'active_io'), 'active I/O kill switch suppresses direct phaseEvent and raw emit active_io');

  expectExit('Pi extension package loads', ['pi', '--no-extensions', '-e', '.', '--list-models'], 0, { env: { PI_OFFLINE: '1' }, timeout: 60_000 });

  const cli = join(root, 'dynamic-thread-phase-workflow/bin/dynamic-thread-phase-workflow.mjs');

  const badTools = join(tmp, 'bad-tools.json');
  writeFileSync(badTools, JSON.stringify({ name: 'bad-tools', permissions: 'r', phases: [{ type: 'pi', name: 'bad', prompt: 'hi', tools: 'read' }] }, null, 2));
  expectExit('structured specs reject non-array phase.tools', ['node', cli, '--spec-file', badTools, '--cwd', root], 1);

  const deniedSideEffect = join(tmp, 'side-effect-created');
  const deniedHarness = join(tmp, 'denied-harness.mjs');
  writeFileSync(deniedHarness, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(deniedSideEffect)}, 'bad');\nexport default async function workflow(ctx) { await ctx.artifact('bad', 'bad'); }\n`);
  expectExit('harness denied by max permissions before import', ['node', cli, '--js-file', deniedHarness, '--cwd', root, '--name', 'denied-harness', '--permissions', 'rwx'], 1, { env: { PI_DYNAMIC_WORKFLOW_MAX_PERMISSIONS: 'r' } });
  log(!existsSync(deniedSideEffect), 'denied harness did not run top-level side effect');

  const okHarness = join(tmp, 'ok-harness.mjs');
  writeFileSync(okHarness, `export default async function workflow(ctx) { await ctx.artifact('Harness result', 'ok'); }\n`);
  expectExit('harness requires explicit permissions', ['node', cli, '--js-file', okHarness, '--cwd', root, '--name', 'missing-permissions'], 1);
  expectExit('harness succeeds with explicit rwx', ['node', cli, '--js-file', okHarness, '--cwd', root, '--name', 'ok-harness', '--permissions', 'rwx'], 0);
  const circularHarness = join(tmp, 'circular-harness.mjs');
  writeFileSync(circularHarness, `export default async function workflow(ctx) { await ctx.phase('circular', async () => { const value = { big: 1n }; value.self = value; return value; }); }\n`);
  expectExit('harness safely persists BigInt and circular partial results', ['node', cli, '--js-file', circularHarness, '--cwd', root, '--name', 'circular-harness', '--permissions', 'rwx'], 0);

  const shellSpec = join(tmp, 'shell-spec.json');
  writeFileSync(shellSpec, JSON.stringify({ name: 'shell-smoke', permissions: 'rwx', phases: [{ type: 'shell', name: 'hello', command: 'printf hello' }, { type: 'artifact', name: 'report', from: 'hello' }] }, null, 2));
  expectExit('structured shell workflow succeeds', ['node', cli, '--spec-file', shellSpec, '--cwd', root], 0);
  expectExit('dynamic CLI rejects timeout outside policy', ['node', cli, '--spec-file', shellSpec, '--cwd', root, '--timeout', '-1'], 1);
  expectExit('dynamic CLI rejects malformed environment resource policy', ['node', cli, '--spec-file', shellSpec, '--cwd', root], 1, { env: { PI_DYNAMIC_WORKFLOW_MAX_CONCURRENCY: 'NaN' } });
  const backgroundShell = expectExit('dynamic background launch waits for readiness and returns runId', ['node', cli, '--spec-file', shellSpec, '--cwd', root, '--background'], 0);
  let backgroundShellDetails;
  try { backgroundShellDetails = JSON.parse(backgroundShell.stdout); } catch { backgroundShellDetails = undefined; }
  log(Boolean(backgroundShellDetails?.background && backgroundShellDetails?.runId && backgroundShellDetails?.pid), 'dynamic background readiness acknowledgement includes runId and pid', JSON.stringify(backgroundShellDetails));
  if (backgroundShellDetails?.runId) {
    const backgroundRunFile = join(store, 'runs', `${backgroundShellDetails.runId}.jsonl`);
    for (let i = 0; i < 100; i++) {
      if (existsSync(backgroundRunFile) && readFileSync(backgroundRunFile, 'utf8').includes('"type":"workflow_end"')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    log(existsSync(backgroundRunFile) && readFileSync(backgroundRunFile, 'utf8').includes('"status":"success"'), 'dynamic ready background run reaches durable terminal state', backgroundRunFile);
  }

  const invalidReferenceSpec = join(tmp, 'invalid-reference-spec.json');
  writeFileSync(invalidReferenceSpec, JSON.stringify({ name: 'invalid-reference', permissions: 'r', phases: [{ type: 'artifact', name: 'report', from: 'missing' }] }, null, 2));
  expectExit('dynamic structured preflight rejects unresolved references', ['node', cli, '--spec-file', invalidReferenceSpec, '--cwd', root, '--background'], 1);

  const invalidConcurrencySpec = join(tmp, 'invalid-concurrency-spec.json');
  writeFileSync(invalidConcurrencySpec, JSON.stringify({ name: 'invalid-concurrency', permissions: 'r', phases: [{ type: 'fanout_pi', name: 'fan', items: ['a'], concurrency: 0, promptTemplate: '{{item}}' }] }, null, 2));
  expectExit('dynamic structured preflight rejects unsafe concurrency before background launch', ['node', cli, '--spec-file', invalidConcurrencySpec, '--cwd', root, '--background'], 1);

  const partialFailureSpec = join(tmp, 'partial-failure-spec.json');
  writeFileSync(partialFailureSpec, JSON.stringify({ name: 'partial-failure', permissions: 'rwx', phases: [{ type: 'shell', name: 'first', command: 'printf first-output' }, { type: 'shell', name: 'fail', command: 'exit 7' }] }, null, 2));
  const partialFailure = expectExit('failed dynamic workflow writes partial result artifact', ['node', cli, '--spec-file', partialFailureSpec, '--cwd', root], 1);
  let partialFailureDetails;
  try { partialFailureDetails = JSON.parse(partialFailure.stdout); } catch { partialFailureDetails = undefined; }
  const partialResultPath = partialFailureDetails?.runId ? join(store, 'artifacts', partialFailureDetails.runId, 'workflow-result.json') : undefined;
  const partialResult = partialResultPath && existsSync(partialResultPath) ? JSON.parse(readFileSync(partialResultPath, 'utf8')) : undefined;
  log(partialResult?.status === 'failed' && partialResult?.outputs?.first === 'first-output', 'dynamic partial result preserves completed phase output after later failure', partialResultPath || 'missing result path');

  const retryMarker = join(tmp, 'dynamic-retry-marker');
  const retrySpec = join(tmp, 'retry-spec.json');
  writeFileSync(retrySpec, JSON.stringify({ name: 'retry-smoke', permissions: 'rwx', phases: [{ type: 'shell', name: 'flaky', command: `if [ ! -f ${JSON.stringify(retryMarker)} ]; then touch ${JSON.stringify(retryMarker)}; exit 1; else printf recovered; fi`, attempts: 2 }] }, null, 2));
  expectExit('dynamic structured attempts policy recovers an explicitly retryable phase', ['node', cli, '--spec-file', retrySpec, '--cwd', root], 0);

  const fakePiMultipart = join(tmp, 'fake-pi-multipart.mjs');
  writeFileSync(fakePiMultipart, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-multipart', content: [{ type: 'text', text: 'intermediate-ignored' }] } }));\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-multipart', usage: { input: 2, output: 2, totalTokens: 4 }, content: [{ type: 'text', text: 'alpha' }, { type: 'text', text: 'beta' }] } }));\n`);
  expectExit('fake multipart pi is executable', ['chmod', '+x', fakePiMultipart], 0);
  const fanoutSpec = join(tmp, 'fanout-spec.json');
  writeFileSync(fanoutSpec, JSON.stringify({ name: 'fanout-smoke', permissions: 'r', phases: [{ type: 'fanout_pi', name: 'fan', items: ['a/b', 'a-b'], concurrency: 2, promptTemplate: 'Process {{item}}' }] }, null, 2));
  const fanoutRun = expectExit('dynamic structured fanout succeeds with deterministic bounded subagents', ['node', cli, '--spec-file', fanoutSpec, '--cwd', root], 0, { env: { PI_DYNAMIC_WORKFLOW_PI_BIN: fakePiMultipart } });
  let fanoutDetails;
  try { fanoutDetails = JSON.parse(fanoutRun.stdout); } catch { fanoutDetails = undefined; }
  const fanoutResult = fanoutDetails?.resultPath && existsSync(fanoutDetails.resultPath) ? JSON.parse(readFileSync(fanoutDetails.resultPath, 'utf8')) : undefined;
  const fanoutArtifactDir = fanoutDetails?.runId ? join(store, 'artifacts', fanoutDetails.runId) : undefined;
  const fanoutArtifacts = fanoutArtifactDir && existsSync(fanoutArtifactDir) ? readdirSync(fanoutArtifactDir).filter((name) => name.startsWith('fan-') && name.endsWith('.md')) : [];
  log(fanoutResult?.outputs?.fan === 'alphabeta\n\n---\n\nalphabeta', 'dynamic Pi parser preserves multipart assistant text in order', JSON.stringify(fanoutResult?.outputs));
  log(fanoutArtifacts.length === 2 && new Set(fanoutArtifacts).size === 2, 'dynamic fanout artifact names remain distinct after safe-name collisions', JSON.stringify(fanoutArtifacts));

} finally {
  if (process.env.KEEP_AUTONOME_PI_TEST_TMP !== '1' && process.env.KEEP_PI_THREAD_PHASE_TEST_TMP !== '1') {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} smoke test(s) failed.`);
  process.exit(1);
}
console.log('\nAll smoke tests passed.');
