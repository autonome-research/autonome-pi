#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(new URL('..', import.meta.url).pathname);
const tmp = mkdtempSync(join(tmpdir(), 'pi-thread-phase-tools-test-'));
const store = join(tmp, 'store');
const testHome = join(tmp, 'home');
mkdirSync(testHome, { recursive: true });
const realHome = process.env.HOME || '';
const realThreadPhaseCorePath = process.env.THREAD_PHASE_CORE_PATH || join(realHome, '.npm-global', 'lib', 'node_modules', '@autonome-research', 'thread-phase-cli', 'node_modules', '@autonome-research', 'thread-phase', 'dist', 'index.js');
const env = { ...process.env, HOME: testHome, PI_THREAD_PHASE_STORE_DIR: store, ...(existsSync(realThreadPhaseCorePath) ? { THREAD_PHASE_CORE_PATH: realThreadPhaseCorePath } : {}) };
process.env.PI_THREAD_PHASE_STORE_DIR = store;
const visualizerStore = await import(pathToFileURL(join(root, 'thread-phase-visualizer/lib/store.mjs')).href);
let failures = 0;

function log(ok, name, detail = '') {
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
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

function featureFingerprint({ milestoneId, featureId, title, description = '', repair = false, assertions = [], localAssertions = [], contractAssertions = [] }) {
  const contract = new Map(contractAssertions.map((assertion) => [String(assertion.id), assertion]));
  const assertionIds = assertions.map(String).sort();
  const contractData = assertionIds.map((id) => {
    const assertion = contract.get(id) || { id };
    return { id, description: String(assertion.description || '').replace(/\s+/g, ' ').trim(), priority: String(assertion.priority || ''), validationMethod: String(assertion.validationMethod || ''), coveredBy: (assertion.coveredBy || []).map(String).sort() };
  });
  return createHash('sha256').update(JSON.stringify({ schema: 'pi-mission-feature-fingerprint/v2', milestoneId, featureId, title: String(title || '').replace(/\s+/g, ' ').trim(), description: repair ? '' : String(description || '').replace(/\s+/g, ' ').trim(), repair: Boolean(repair), assertions: assertionIds, contractAssertions: contractData, localAssertions: localAssertions.map(String).sort() })).digest('hex').slice(0, 24);
}

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

  const bugSolverCli = join(root, 'bug-solver-workflow/bin/bug-solver-workflow.mjs');
  expectExit('bug-solver workflow CLI help succeeds', ['node', bugSolverCli, '--help'], 0);
  const inRepoArtifactDir = join(root, '.bug-solver-artifacts-smoke');
  rmSync(inRepoArtifactDir, { recursive: true, force: true });
  const inRepoArtifactResult = expectExit('bug-solver workflow rejects absolute in-repo artifact root', ['node', bugSolverCli, 'precheck', '--cwd', root, '--bug', 'Fix malicious in-repo artifact root bug', '--json'], 1, { env: { PI_BUG_SOLVER_ARTIFACT_DIR: inRepoArtifactDir } });
  log(!existsSync(inRepoArtifactDir) && /outside the repository/i.test(inRepoArtifactResult.stdout || inRepoArtifactResult.stderr || ''), 'bug-solver refuses malicious in-repo PI_BUG_SOLVER_ARTIFACT_DIR before writing artifacts');
  const relativeInRepoArtifactDir = '.bug-solver-relative-artifacts-smoke';
  const relativeInRepoArtifactPath = join(root, relativeInRepoArtifactDir);
  rmSync(relativeInRepoArtifactPath, { recursive: true, force: true });
  const relativeArtifactResult = expectExit('bug-solver workflow rejects relative in-repo artifact root', ['node', bugSolverCli, 'precheck', '--cwd', root, '--bug', 'Fix accidental relative artifact root bug', '--json'], 1, { env: { PI_BUG_SOLVER_ARTIFACT_DIR: relativeInRepoArtifactDir } });
  log(!existsSync(relativeInRepoArtifactPath) && /outside the repository/i.test(relativeArtifactResult.stdout || relativeArtifactResult.stderr || ''), 'bug-solver refuses accidental relative in-repo PI_BUG_SOLVER_ARTIFACT_DIR before writing artifacts');
  const symlinkToRepo = join(tmp, 'lexically-external-link-to-repo');
  rmSync(symlinkToRepo, { recursive: true, force: true });
  symlinkSync(root, symlinkToRepo, 'dir');
  const symlinkArtifactDir = join(symlinkToRepo, '.bug-solver-symlink-artifacts-smoke');
  rmSync(join(root, '.bug-solver-symlink-artifacts-smoke'), { recursive: true, force: true });
  const symlinkPrecheckResult = expectExit('bug-solver workflow rejects symlink artifact root resolving inside repo during precheck', ['node', bugSolverCli, 'precheck', '--cwd', root, '--bug', 'Fix symlink artifact root bug', '--json'], 1, { env: { PI_BUG_SOLVER_ARTIFACT_DIR: symlinkArtifactDir } });
  log(!existsSync(join(root, '.bug-solver-symlink-artifacts-smoke')) && /physicalArtifactRoot=.*\.bug-solver-symlink-artifacts-smoke/i.test(symlinkPrecheckResult.stdout || symlinkPrecheckResult.stderr || ''), 'bug-solver refuses lexically external symlink artifact root before precheck writes artifacts');
  const symlinkStatusResult = expectExit('bug-solver workflow rejects symlink artifact root resolving inside repo during status', ['node', bugSolverCli, 'status', '--cwd', root, '--transaction-id', 'missing-symlink-status', '--json'], 1, { env: { PI_BUG_SOLVER_ARTIFACT_DIR: symlinkArtifactDir } });
  log(/physicalArtifactRoot=.*\.bug-solver-symlink-artifacts-smoke/i.test(symlinkStatusResult.stdout || symlinkStatusResult.stderr || ''), 'bug-solver status uses realpath containment checks for artifact root safety');
  const bugPrecheck = expectExit('bug-solver workflow precheck writes durable artifact', ['node', bugSolverCli, 'precheck', '--cwd', root, '--bug', 'Fix smoke-test bug transaction', '--json'], 0);
  let bugPrecheckDetails;
  try { bugPrecheckDetails = JSON.parse(bugPrecheck.stdout); } catch { bugPrecheckDetails = undefined; }
  log(Boolean(bugPrecheckDetails?.precheckPath) && existsSync(bugPrecheckDetails.precheckPath) && bugPrecheckDetails.precheckPath.includes('bug-solver-workflow') && !bugPrecheckDetails.precheckPath.startsWith(root), 'bug-solver precheck artifact is durable and outside target repo', bugPrecheckDetails?.precheckPath || '');
  log(Boolean(bugPrecheckDetails?.planPath) && existsSync(bugPrecheckDetails.planPath) && Boolean(bugPrecheckDetails?.validationContractPath) && existsSync(bugPrecheckDetails.validationContractPath), 'bug-solver precheck writes transaction plan and validation contract artifacts');
  const bugPlan = bugPrecheckDetails?.planPath ? JSON.parse(readFileSync(bugPrecheckDetails.planPath, 'utf8')) : undefined;
  const bugPrecheckArtifact = bugPrecheckDetails?.precheckPath ? JSON.parse(readFileSync(bugPrecheckDetails.precheckPath, 'utf8')) : undefined;
  const bugContract = bugPrecheckDetails?.validationContractPath ? JSON.parse(readFileSync(bugPrecheckDetails.validationContractPath, 'utf8')) : undefined;
  const bugArtifactRegistry = bugPrecheckDetails?.artifactRegistryPath ? JSON.parse(readFileSync(bugPrecheckDetails.artifactRegistryPath, 'utf8')) : undefined;
  const bugRegistryEntries = bugArtifactRegistry?.entries || [];
  const bugFinalReport = bugPlan?.evidencePaths?.finalReport ? JSON.parse(readFileSync(bugPlan.evidencePaths.finalReport, 'utf8')) : undefined;
  const bugPrecheckReport = bugPlan?.artifacts?.precheckReport ? JSON.parse(readFileSync(bugPlan.artifacts.precheckReport, 'utf8')) : undefined;
  log(bugPlan?.schema === 'pi-bug-solver-workflow/transaction-plan/v1' && bugPlan?.editingAllowed === false && bugPlan?.confirmationRequired === true && bugPlan?.transaction?.exactlyOneBug === true && bugPlan?.repairPolicy?.maxRepairIterations === 8 && Boolean(bugPlan?.validation?.baseline?.evidencePath) && Boolean(bugPlan?.allowlist?.decisionsPath), 'bug-solver transaction plan captures explicit editing lock, one-bug schema, baseline, allowlist, and repair policy');
  log(bugPrecheckArtifact?.readOnly === true && bugPrecheckArtifact?.editingAllowed === false && bugPrecheckArtifact?.readOnlyAudit?.targetRepositoryEdited === false && bugPrecheckArtifact?.readOnlyAudit?.unchangedDuringPrecheck === true && bugPlan?.repo?.baseCommit && typeof bugPlan?.repo?.dirtyAtPrecheck?.hasDirtyWorktree === 'boolean', 'bug-solver precheck records read-only audit, base metadata, and dirty-signal snapshot');
  log(bugContract?.schema === 'pi-bug-solver-workflow/validation-contract/v1' && bugContract?.createdBeforeImplementation === true && bugContract?.assertions?.length >= 4 && Object.keys(bugContract?.workflowEvidenceMap || {}).includes('single-bug-scope'), 'bug-solver validation contract maps explicit assertions to durable evidence');
  const requiredBugContractIds = ['single-bug-scope', 'baseline-aware-validation', 'bug-reproduction-before-broad-validation', 'allowlisted-scope-control', 'capped-repair-loop', 'outcome-based-final-verification', 'durable-reports'];
  const bugContractIds = new Set((bugContract?.assertions || []).map((assertion) => assertion.id));
  const bugContractEvidencePaths = Object.values(bugContract?.workflowEvidenceMap || {}).flat();
  log(requiredBugContractIds.every((id) => bugContractIds.has(id)) && bugContract?.evidenceMappingCreatedBeforeImplementation === true && bugContractEvidencePaths.length >= bugContract?.assertions?.length && bugContractEvidencePaths.every((file) => existsSync(file)) && bugFinalReport?.finalVerification?.outcomeBased === true, 'bug-solver expanded validation contract covers solve guarantees with materialized evidence paths before implementation');
  log(bugRegistryEntries.length >= 12 && bugRegistryEntries.every((entry) => entry.externalToTargetRepo === true && entry.lifecycleStatus === 'materialized_at_precheck' && entry.durableAtPrecheck === true && existsSync(entry.path)), 'bug-solver precheck materializes every claimed registry artifact outside the target repo');
  log(bugFinalReport?.schema === 'pi-bug-solver-workflow/final-report/v1' && bugFinalReport?.status === 'pending' && ['summary', 'commands', 'failures', 'repairs', 'commits', 'evidencePaths'].every((key) => key in bugFinalReport) && bugPrecheckReport?.schema === 'pi-bug-solver-workflow/intermediate-report/v1', 'bug-solver pending reports include required summary sections and evidence paths');
  const bugRunSummary = bugPrecheckDetails?.runId ? storeApi.getRunSummary(bugPrecheckDetails.runId) : undefined;
  log(bugRunSummary?.workflow === 'bug-solver-workflow' && bugRunSummary?.normalizedStatus === 'success', 'bug-solver workflow emits generic thread-phase events');
  const bugRunEvents = bugPrecheckDetails?.runId ? storeApi.readRun(bugPrecheckDetails.runId) : [];
  const genericThreadPhaseTypes = new Set(['workflow_start', 'phase_start', 'phase_event', 'artifact', 'phase_end', 'workflow_end']);
  log(bugRunEvents.length >= 6 && bugRunEvents.every((event) => event.schema === 'thread-phase-ui/v1' && genericThreadPhaseTypes.has(event.type)) && bugRunEvents.some((event) => event.type === 'artifact' && event.artifact?.path === bugPrecheckDetails.precheckPath), 'bug-solver observability persists only generic thread-phase event types');
  const bugStatus = bugPrecheckDetails?.transactionId ? expectExit('bug-solver workflow status inspects transaction state by id', ['node', bugSolverCli, 'status', '--transaction-id', bugPrecheckDetails.transactionId, '--json'], 0) : undefined;
  let bugStatusDetails;
  try { bugStatusDetails = bugStatus?.stdout ? JSON.parse(bugStatus.stdout) : undefined; } catch { bugStatusDetails = undefined; }
  log(bugStatusDetails?.readOnly === true && bugStatusDetails?.targetRepositoryEdited === false && bugStatusDetails?.recoverable === true && bugStatusDetails?.latestPhase === 'precheck' && bugStatusDetails?.reports?.finalReport?.path && bugStatusDetails?.worktree?.path && bugStatusDetails?.terminalOutcome?.terminal === false, 'bug-solver status reports recoverable state, latest phase, reports, worktree, and non-terminal outcome');
  const bugDirStatus = bugPrecheckDetails?.artifactDir ? expectExit('bug-solver workflow status inspects explicit transaction directory', ['node', bugSolverCli, 'status', '--transaction-dir', bugPrecheckDetails.artifactDir, '--json'], 0) : undefined;
  let bugDirStatusDetails;
  try { bugDirStatusDetails = bugDirStatus?.stdout ? JSON.parse(bugDirStatus.stdout) : undefined; } catch { bugDirStatusDetails = undefined; }
  log(bugDirStatusDetails?.transactionId === bugPrecheckDetails?.transactionId && bugDirStatusDetails?.artifactRegistryPath === bugPrecheckDetails?.artifactRegistryPath, 'bug-solver status can recover transaction details from a directory without a target repo edit');
  const repeatedPrecheckRepo = join(tmp, 'repeated-precheck-repo');
  mkdirSync(repeatedPrecheckRepo, { recursive: true });
  expectExit('bug-solver repeated-precheck repo git init', ['git', 'init', '-q'], 0, { cwd: repeatedPrecheckRepo });
  expectExit('bug-solver repeated-precheck repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: repeatedPrecheckRepo });
  expectExit('bug-solver repeated-precheck repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: repeatedPrecheckRepo });
  writeFileSync(join(repeatedPrecheckRepo, 'README.md'), 'first\n');
  expectExit('bug-solver repeated-precheck repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m first'], 0, { cwd: repeatedPrecheckRepo });
  const repeatedFirstHead = expectExit('bug-solver repeated-precheck captures first head', ['git', 'rev-parse', 'HEAD'], 0, { cwd: repeatedPrecheckRepo }).stdout.trim();
  const stableTransactionId = 'smoke-repeated-precheck-identity';
  const repeatedFirst = expectExit('bug-solver workflow first stable-id precheck succeeds', ['node', bugSolverCli, 'precheck', '--cwd', repeatedPrecheckRepo, '--bug', 'Fix repeated precheck identity bug', '--transaction-id', stableTransactionId, '--json'], 0);
  let repeatedFirstDetails;
  try { repeatedFirstDetails = JSON.parse(repeatedFirst.stdout); } catch { repeatedFirstDetails = undefined; }
  writeFileSync(join(repeatedPrecheckRepo, 'README.md'), 'second\n');
  expectExit('bug-solver repeated-precheck repo second commit', ['sh', '-c', 'git add README.md && git commit -q -m second'], 0, { cwd: repeatedPrecheckRepo });
  const repeatedSecondHead = expectExit('bug-solver repeated-precheck captures second head', ['git', 'rev-parse', 'HEAD'], 0, { cwd: repeatedPrecheckRepo }).stdout.trim();
  expectExit('bug-solver workflow repeated stable-id precheck succeeds', ['node', bugSolverCli, 'precheck', '--cwd', repeatedPrecheckRepo, '--bug', 'Fix repeated precheck identity bug', '--transaction-id', stableTransactionId, '--json'], 0);
  const repeatedState = repeatedFirstDetails?.statePath ? JSON.parse(readFileSync(repeatedFirstDetails.statePath, 'utf8')) : undefined;
  const repeatedPlan = repeatedFirstDetails?.planPath ? JSON.parse(readFileSync(repeatedFirstDetails.planPath, 'utf8')) : undefined;
  log(repeatedState?.repo?.baseCommit === repeatedFirstHead && repeatedState?.branch?.baseCommit === repeatedFirstHead && repeatedState?.worktree?.rootedAtBaseCommit === repeatedFirstHead && repeatedPlan?.repo?.baseCommit === repeatedFirstHead && repeatedPlan?.repo?.dirtyAtPrecheck?.hasDirtyWorktree === false && repeatedSecondHead !== repeatedFirstHead, 'bug-solver repeated precheck preserves immutable base commit/ref, clean dirty-signal snapshot, branch, and worktree identity');
  log(repeatedState?.observations?.prechecks?.length >= 2 && repeatedState?.observations?.latestPrecheck?.repo?.head === repeatedSecondHead, 'bug-solver repeated precheck records later repo observations separately from immutable identity');
  expectExit('bug-solver workflow solve requires explicit approval before activation', ['node', bugSolverCli, 'solve', '--cwd', repeatedPrecheckRepo, '--plan-path', repeatedFirstDetails?.planPath || join(tmp, 'missing-unapproved-plan.json'), '--json'], 1);
  const gatedSolveRepo = join(tmp, 'gated-solve-repo');
  mkdirSync(gatedSolveRepo, { recursive: true });
  expectExit('bug-solver gated-solve repo git init', ['git', 'init', '-q'], 0, { cwd: gatedSolveRepo });
  expectExit('bug-solver gated-solve repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: gatedSolveRepo });
  expectExit('bug-solver gated-solve repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: gatedSolveRepo });
  writeFileSync(join(gatedSolveRepo, 'README.md'), 'clean gated solve\n');
  expectExit('bug-solver gated-solve repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: gatedSolveRepo });
  const gatedPrecheck = expectExit('bug-solver workflow precheck for approved gated solve succeeds', ['node', bugSolverCli, 'precheck', '--cwd', gatedSolveRepo, '--bug', 'Fix gated activation integrity bug', '--user-test-command', 'printf targeted-baseline', '--validation-command', 'sh -c "printf broad-baseline >&2 && false"', '--json'], 0);
  let gatedPrecheckDetails;
  try { gatedPrecheckDetails = JSON.parse(gatedPrecheck.stdout); } catch { gatedPrecheckDetails = undefined; }
  const gatedSolve = expectExit('bug-solver workflow approved solve records gated activation after integrity checks', ['node', bugSolverCli, 'solve', '--cwd', gatedSolveRepo, '--plan-path', gatedPrecheckDetails?.planPath || join(tmp, 'missing-gated-plan.json'), '--approved', '--json'], 0);
  let gatedSolveDetails;
  try { gatedSolveDetails = JSON.parse(gatedSolve.stdout); } catch { gatedSolveDetails = undefined; }
  const gatedActivation = gatedSolveDetails?.activationPath ? JSON.parse(readFileSync(gatedSolveDetails.activationPath, 'utf8')) : undefined;
  const gatedWorktreeMetadata = gatedSolveDetails?.worktreeMetadataPath ? JSON.parse(readFileSync(gatedSolveDetails.worktreeMetadataPath, 'utf8')) : undefined;
  const gatedPlan = gatedPrecheckDetails?.planPath ? JSON.parse(readFileSync(gatedPrecheckDetails.planPath, 'utf8')) : undefined;
  const gatedState = gatedPrecheckDetails?.statePath ? JSON.parse(readFileSync(gatedPrecheckDetails.statePath, 'utf8')) : undefined;
  const gatedCallerStatusAfterSolve = expectExit('bug-solver gated solve caller worktree remains clean', ['git', 'status', '--short'], 0, { cwd: gatedSolveRepo }).stdout.trim();
  const gatedWorktreeHead = gatedSolveDetails?.worktreePath ? expectExit('bug-solver gated solve worktree is rooted at recorded base', ['git', 'rev-parse', 'HEAD'], 0, { cwd: gatedSolveDetails.worktreePath }).stdout.trim() : '';
  log(gatedActivation?.schema === 'pi-bug-solver-workflow/gated-activation/v1' && gatedActivation?.integrityChecks?.validationContract === 'materialized_with_evidence_map' && gatedActivation?.editCapableResourcesCreated === true && existsSync(gatedSolveDetails?.worktreePath || '') && gatedWorktreeMetadata?.status === 'ready' && gatedWorktreeMetadata?.branch?.baseCommit === gatedPlan?.repo?.baseCommit && gatedWorktreeHead === gatedPlan?.repo?.baseCommit && gatedCallerStatusAfterSolve === '' && gatedState?.worktree?.status === 'ready', 'bug-solver approved solve creates isolated transaction worktree/branch at recorded base without dirtying caller worktree');
  const gatedBaseline = gatedSolveDetails?.baselinePath ? JSON.parse(readFileSync(gatedSolveDetails.baselinePath, 'utf8')) : undefined;
  log(gatedBaseline?.status === 'completed_with_pre_existing_failures' && gatedBaseline?.beforeImplementation === true && gatedBaseline?.unmodifiedTransactionBase === true && gatedBaseline?.commandResults?.[0]?.kind === 'targeted_user_test' && gatedBaseline?.commandResults?.[1]?.kind === 'broad_validation' && gatedBaseline?.commandResults?.[0]?.status === 0 && gatedBaseline?.commandResults?.[1]?.status === 1 && gatedBaseline?.failures?.preExisting?.[0]?.type === 'pre_existing_failure' && gatedBaseline?.commandResults?.[0]?.stdout?.text === 'targeted-baseline' && gatedBaseline?.commandResults?.[1]?.stderr?.text === 'broad-baseline', 'bug-solver solve records targeted-before-broad baseline validation and classifies pre-existing broad failures');
  const gatedPostValidation = gatedSolveDetails?.postValidationPath ? JSON.parse(readFileSync(gatedSolveDetails.postValidationPath, 'utf8')) : undefined;
  const gatedFinalReportAfterSolve = gatedPlan?.evidencePaths?.finalReport ? JSON.parse(readFileSync(gatedPlan.evidencePaths.finalReport, 'utf8')) : undefined;
  log(gatedPostValidation?.schema === 'pi-bug-solver-workflow/post-change-validation/v1' && gatedPostValidation?.targetedBeforeBroad === true && gatedPostValidation?.commandResults?.[0]?.kind === 'targeted_user_test' && gatedPostValidation?.commandResults?.[1]?.kind === 'broad_validation' && gatedPostValidation?.comparison?.unchangedPreExisting?.[0]?.command?.includes('broad-baseline') && gatedPostValidation?.comparison?.newlyRegressed?.length === 0 && gatedPostValidation?.finalVerification?.outcomeBased === true && gatedPostValidation?.finalVerification?.reproductionAware === true && gatedPostValidation?.finalVerification?.status === 'inconclusive' && gatedPostValidation?.finalVerification?.notReproduced === true && gatedPostValidation?.finalVerification?.bugFixed === false && gatedFinalReportAfterSolve?.failures?.unchangedPreExisting?.length === 1 && gatedFinalReportAfterSolve?.failures?.regressions?.length === 0, 'bug-solver post-change validation reports targeted baseline pass as inconclusive/not reproduced instead of proving a fix from exit codes');
  const reproAwareRepo = join(tmp, 'repro-aware-solve-repo');
  mkdirSync(reproAwareRepo, { recursive: true });
  expectExit('bug-solver repro-aware repo git init', ['git', 'init', '-q'], 0, { cwd: reproAwareRepo });
  expectExit('bug-solver repro-aware repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: reproAwareRepo });
  expectExit('bug-solver repro-aware repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: reproAwareRepo });
  writeFileSync(join(reproAwareRepo, 'README.md'), 'repro aware solve\n');
  expectExit('bug-solver repro-aware repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: reproAwareRepo });
  const reproMarker = join(tmp, 'repro-aware-targeted-marker');
  const reproCommand = `sh -c 'test -f ${JSON.stringify(reproMarker)} && exit 0; touch ${JSON.stringify(reproMarker)}; exit 1'`;
  const reproPrecheck = expectExit('bug-solver workflow precheck for reproduction-aware final verification succeeds', ['node', bugSolverCli, 'precheck', '--cwd', reproAwareRepo, '--bug', 'Fix reproduction-aware final verification bug', '--user-test-command', reproCommand, '--json'], 0);
  let reproPrecheckDetails;
  try { reproPrecheckDetails = JSON.parse(reproPrecheck.stdout); } catch { reproPrecheckDetails = undefined; }
  const reproSolve = expectExit('bug-solver workflow approved solve does not report fixed without implementation evidence', ['node', bugSolverCli, 'solve', '--cwd', reproAwareRepo, '--plan-path', reproPrecheckDetails?.planPath || join(tmp, 'missing-repro-plan.json'), '--approved', '--json'], 0);
  let reproSolveDetails;
  try { reproSolveDetails = JSON.parse(reproSolve.stdout); } catch { reproSolveDetails = undefined; }
  const reproPostValidation = reproSolveDetails?.postValidationPath ? JSON.parse(readFileSync(reproSolveDetails.postValidationPath, 'utf8')) : undefined;
  log(reproPostValidation?.status === 'inconclusive_not_implemented' && reproPostValidation?.finalVerification?.status === 'inconclusive' && reproPostValidation?.finalVerification?.bugFixed === false && reproPostValidation?.finalVerification?.notImplemented === true && reproPostValidation?.finalVerification?.implementationBacked === false && reproPostValidation?.finalVerification?.targetedTransitions?.[0]?.baselineStatus === 1 && reproPostValidation?.finalVerification?.targetedTransitions?.[0]?.postStatus === 0 && reproPostValidation?.finalVerification?.targetedTransitions?.[0]?.fixedByOutcomeTransition === true, 'bug-solver final verification refuses bugFixed for a targeted pass transition without implementation evidence');

  const fakeEvidenceRepo = join(tmp, 'fake-evidence-solve-repo');
  mkdirSync(fakeEvidenceRepo, { recursive: true });
  expectExit('bug-solver fake-evidence repo git init', ['git', 'init', '-q'], 0, { cwd: fakeEvidenceRepo });
  expectExit('bug-solver fake-evidence repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: fakeEvidenceRepo });
  expectExit('bug-solver fake-evidence repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: fakeEvidenceRepo });
  writeFileSync(join(fakeEvidenceRepo, 'README.md'), 'fake evidence solve\n');
  expectExit('bug-solver fake-evidence repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: fakeEvidenceRepo });
  const fakeEvidenceMarker = join(tmp, 'fake-evidence-targeted-marker');
  const fakeEvidenceMetadata = join(tmp, 'fake-evidence-metadata.json');
  const fakeEvidenceCommandScript = join(tmp, 'fake-evidence-targeted-command.mjs');
  writeFileSync(fakeEvidenceCommandScript, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';\nconst marker = ${JSON.stringify(fakeEvidenceMarker)};\nconst metadataPath = ${JSON.stringify(fakeEvidenceMetadata)};\nif (!existsSync(marker)) { writeFileSync(marker, 'baseline reproduced\\n'); process.exit(1); }\nconst metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));\nappendFileSync(metadata.implementationEvidencePath, JSON.stringify({ type: 'explicit_bug_resolution', status: 'resolved', phase: 'implementation', owner: 'bug-solver-workflow', transactionId: metadata.transactionId, worktreePath: process.cwd(), createdAt: new Date(Date.now() + 1000).toISOString(), evidence: 'fake explicit resolution written by externally stateful targeted command without any isolated worktree implementation change', changedFiles: [], implementationChangedWorktree: false, worktreeChangedAfterBaseline: false }) + '\\n');\nprocess.exit(0);\n`);
  const fakeEvidenceCommand = `node ${JSON.stringify(fakeEvidenceCommandScript)}`;
  const fakeEvidencePrecheck = expectExit('bug-solver workflow precheck for fake implementation evidence final verification succeeds', ['node', bugSolverCli, 'precheck', '--cwd', fakeEvidenceRepo, '--bug', 'Fix fake implementation evidence final verification bug', '--user-test-command', fakeEvidenceCommand, '--json'], 0);
  let fakeEvidencePrecheckDetails;
  try { fakeEvidencePrecheckDetails = JSON.parse(fakeEvidencePrecheck.stdout); } catch { fakeEvidencePrecheckDetails = undefined; }
  const fakeEvidencePlan = fakeEvidencePrecheckDetails?.planPath ? JSON.parse(readFileSync(fakeEvidencePrecheckDetails.planPath, 'utf8')) : undefined;
  writeFileSync(fakeEvidenceMetadata, JSON.stringify({ transactionId: fakeEvidencePrecheckDetails?.transactionId, implementationEvidencePath: fakeEvidencePlan?.evidencePaths?.implementation }, null, 2));
  const fakeEvidenceSolve = expectExit('bug-solver workflow approved solve rejects externally stateful targeted pass with fake explicit resolution evidence', ['node', bugSolverCli, 'solve', '--cwd', fakeEvidenceRepo, '--plan-path', fakeEvidencePrecheckDetails?.planPath || join(tmp, 'missing-fake-evidence-plan.json'), '--approved', '--json'], 0);
  let fakeEvidenceSolveDetails;
  try { fakeEvidenceSolveDetails = JSON.parse(fakeEvidenceSolve.stdout); } catch { fakeEvidenceSolveDetails = undefined; }
  const fakeEvidencePostValidation = fakeEvidenceSolveDetails?.postValidationPath ? JSON.parse(readFileSync(fakeEvidenceSolveDetails.postValidationPath, 'utf8')) : undefined;
  log(fakeEvidencePostValidation?.status === 'inconclusive_not_implemented' && fakeEvidencePostValidation?.finalVerification?.status === 'inconclusive' && fakeEvidencePostValidation?.finalVerification?.bugFixed === false && fakeEvidencePostValidation?.finalVerification?.implementationBacked === false && fakeEvidencePostValidation?.finalVerification?.notImplemented === true && fakeEvidencePostValidation?.finalVerification?.targetedTransitions?.[0]?.baselineStatus === 1 && fakeEvidencePostValidation?.finalVerification?.targetedTransitions?.[0]?.postStatus === 0 && fakeEvidencePostValidation?.finalVerification?.implementationEvidence?.explicitlyResolvedBug === false && fakeEvidencePostValidation?.finalVerification?.implementationEvidence?.ignoredExplicitResolutionRecords?.some((record) => record.reason === 'not_tied_to_isolated_worktree_change_or_commit'), 'bug-solver final verification ignores fake explicit resolution evidence from an externally stateful targeted command unless tied to a trusted isolated worktree implementation change');

  const fakeClaimRepo = join(tmp, 'fake-claimed-change-solve-repo');
  mkdirSync(fakeClaimRepo, { recursive: true });
  expectExit('bug-solver fake-claimed-change repo git init', ['git', 'init', '-q'], 0, { cwd: fakeClaimRepo });
  expectExit('bug-solver fake-claimed-change repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: fakeClaimRepo });
  expectExit('bug-solver fake-claimed-change repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: fakeClaimRepo });
  writeFileSync(join(fakeClaimRepo, 'README.md'), 'fake claimed change solve\n');
  expectExit('bug-solver fake-claimed-change repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: fakeClaimRepo });
  const fakeClaimMarker = join(tmp, 'fake-claimed-change-targeted-marker');
  const fakeClaimMetadata = join(tmp, 'fake-claimed-change-metadata.json');
  const fakeClaimScript = join(tmp, 'fake-claimed-change-targeted-command.mjs');
  writeFileSync(fakeClaimScript, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';\nconst marker = ${JSON.stringify(fakeClaimMarker)};\nconst metadataPath = ${JSON.stringify(fakeClaimMetadata)};\nif (!existsSync(marker)) { writeFileSync(marker, 'baseline reproduced\\n'); process.exit(1); }\nconst metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));\nappendFileSync(metadata.implementationEvidencePath, JSON.stringify({ type: 'explicit_bug_resolution', status: 'resolved', phase: 'implementation', owner: 'bug-solver-workflow', transactionId: metadata.transactionId, worktreePath: process.cwd(), createdAt: new Date(Date.now() + 1000).toISOString(), evidence: 'fake claimed changed file from validation command', changedFiles: ['README.md'] }) + '\\n');\nprocess.exit(0);\n`);
  const fakeClaimPrecheck = expectExit('bug-solver workflow precheck for fake claimed changed-files evidence succeeds', ['node', bugSolverCli, 'precheck', '--cwd', fakeClaimRepo, '--bug', 'Fix fake claimed changed-files final verification bug', '--user-test-command', `node ${JSON.stringify(fakeClaimScript)}`, '--json'], 0);
  let fakeClaimPrecheckDetails;
  try { fakeClaimPrecheckDetails = JSON.parse(fakeClaimPrecheck.stdout); } catch { fakeClaimPrecheckDetails = undefined; }
  const fakeClaimPlan = fakeClaimPrecheckDetails?.planPath ? JSON.parse(readFileSync(fakeClaimPrecheckDetails.planPath, 'utf8')) : undefined;
  writeFileSync(fakeClaimMetadata, JSON.stringify({ transactionId: fakeClaimPrecheckDetails?.transactionId, implementationEvidencePath: fakeClaimPlan?.evidencePaths?.implementation }, null, 2));
  const fakeClaimSolve = expectExit('bug-solver workflow approved solve rejects fake claimed changed-files evidence', ['node', bugSolverCli, 'solve', '--cwd', fakeClaimRepo, '--plan-path', fakeClaimPrecheckDetails?.planPath || join(tmp, 'missing-fake-claim-plan.json'), '--approved', '--json'], 0);
  let fakeClaimSolveDetails;
  try { fakeClaimSolveDetails = JSON.parse(fakeClaimSolve.stdout); } catch { fakeClaimSolveDetails = undefined; }
  const fakeClaimPostValidation = fakeClaimSolveDetails?.postValidationPath ? JSON.parse(readFileSync(fakeClaimSolveDetails.postValidationPath, 'utf8')) : undefined;
  log(fakeClaimPostValidation?.finalVerification?.bugFixed === false && fakeClaimPostValidation?.finalVerification?.implementationBacked === false && fakeClaimPostValidation?.finalVerification?.implementationEvidence?.explicitResolutionCorroborationRequired === true && fakeClaimPostValidation?.finalVerification?.implementationEvidence?.ignoredExplicitResolutionRecords?.some((record) => record.reason === 'claimed_change_not_corroborated_by_isolated_worktree_git_evidence'), 'bug-solver final verification rejects explicit bug resolution records whose claimed changed files are not corroborated by isolated worktree git diff/status evidence');

  const backedRepo = join(tmp, 'implementation-backed-solve-repo');
  mkdirSync(backedRepo, { recursive: true });
  expectExit('bug-solver implementation-backed repo git init', ['git', 'init', '-q'], 0, { cwd: backedRepo });
  expectExit('bug-solver implementation-backed repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: backedRepo });
  expectExit('bug-solver implementation-backed repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: backedRepo });
  writeFileSync(join(backedRepo, 'README.md'), 'implementation backed solve\n');
  expectExit('bug-solver implementation-backed repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: backedRepo });
  const backedMarker = join(tmp, 'implementation-backed-targeted-marker');
  const backedCommand = `sh -c 'test -f ${JSON.stringify(backedMarker)} && exit 0; touch ${JSON.stringify(backedMarker)}; exit 1'`;
  const backedPrecheck = expectExit('bug-solver workflow precheck for implementation-backed final verification succeeds', ['node', bugSolverCli, 'precheck', '--cwd', backedRepo, '--bug', 'Fix implementation-backed final verification bug', '--user-test-command', backedCommand, '--json'], 0);
  let backedPrecheckDetails;
  try { backedPrecheckDetails = JSON.parse(backedPrecheck.stdout); } catch { backedPrecheckDetails = undefined; }
  const backedPlan = backedPrecheckDetails?.planPath ? JSON.parse(readFileSync(backedPrecheckDetails.planPath, 'utf8')) : undefined;
  if (backedPlan?.evidencePaths?.implementation) writeFileSync(backedPlan.evidencePaths.implementation, `${JSON.stringify({ type: 'explicit_bug_resolution', status: 'resolved', explicitlyResolvedBug: true, createdAt: new Date().toISOString(), evidence: 'smoke test durable implementation-backed final verification marker' })}\n`, { flag: 'a' });
  const backedSolve = expectExit('bug-solver workflow approved solve ignores manually injected pre-baseline implementation evidence', ['node', bugSolverCli, 'solve', '--cwd', backedRepo, '--plan-path', backedPrecheckDetails?.planPath || join(tmp, 'missing-backed-plan.json'), '--approved', '--json'], 0);
  let backedSolveDetails;
  try { backedSolveDetails = JSON.parse(backedSolve.stdout); } catch { backedSolveDetails = undefined; }
  const backedPostValidation = backedSolveDetails?.postValidationPath ? JSON.parse(readFileSync(backedSolveDetails.postValidationPath, 'utf8')) : undefined;
  log(backedPostValidation?.finalVerification?.status === 'inconclusive' && backedPostValidation?.finalVerification?.bugFixed === false && backedPostValidation?.finalVerification?.implementationBacked === false && backedPostValidation?.finalVerification?.notImplemented === true && backedPostValidation?.finalVerification?.implementationEvidence?.explicitlyResolvedBug === false && backedPostValidation?.finalVerification?.implementationEvidence?.trustedExplicitResolutionRequired === true && backedPostValidation?.finalVerification?.implementationEvidence?.ignoredExplicitResolutionRecords?.some((record) => record.reason === 'not_from_trusted_implementation_or_repair_phase') && backedPostValidation?.finalVerification?.targetedTransitions?.[0]?.fixedByOutcomeTransition === true, 'bug-solver final verification ignores pre-existing or manually injected implementation-evidence.jsonl resolution records for bugFixed');

  const implementationPhaseRepo = join(tmp, 'implementation-phase-solve-repo');
  mkdirSync(implementationPhaseRepo, { recursive: true });
  expectExit('bug-solver implementation-phase repo git init', ['git', 'init', '-q'], 0, { cwd: implementationPhaseRepo });
  expectExit('bug-solver implementation-phase repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: implementationPhaseRepo });
  expectExit('bug-solver implementation-phase repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: implementationPhaseRepo });
  writeFileSync(join(implementationPhaseRepo, 'README.md'), 'implementation phase before solve\n');
  expectExit('bug-solver implementation-phase repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: implementationPhaseRepo });
  const implementationPhasePrecheck = expectExit('bug-solver workflow precheck for implementation command succeeds', ['node', bugSolverCli, 'precheck', '--cwd', implementationPhaseRepo, '--bug', 'Fix implementation phase command bug', '--user-test-command', 'grep solved README.md', '--json'], 0);
  let implementationPhasePrecheckDetails;
  try { implementationPhasePrecheckDetails = JSON.parse(implementationPhasePrecheck.stdout); } catch { implementationPhasePrecheckDetails = undefined; }
  const implementationPhaseSolve = expectExit('bug-solver workflow approved solve runs implementation command between baseline and post validation', ['node', bugSolverCli, 'solve', '--cwd', implementationPhaseRepo, '--plan-path', implementationPhasePrecheckDetails?.planPath || join(tmp, 'missing-implementation-phase-plan.json'), '--approved', '--implementation-command', 'printf "solved\\n" >> README.md', '--json'], 0);
  let implementationPhaseSolveDetails;
  try { implementationPhaseSolveDetails = JSON.parse(implementationPhaseSolve.stdout); } catch { implementationPhaseSolveDetails = undefined; }
  const implementationPhaseEvidenceRecords = implementationPhaseSolveDetails?.implementationEvidencePath ? readFileSync(implementationPhaseSolveDetails.implementationEvidencePath, 'utf8').trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)) : [];
  const implementationPhaseRecord = implementationPhaseEvidenceRecords.find((record) => record.phase === 'implementation' && record.runnerOwnedImplementationMetadata === true);
  const implementationPhasePostValidation = implementationPhaseSolveDetails?.postValidationPath ? JSON.parse(readFileSync(implementationPhaseSolveDetails.postValidationPath, 'utf8')) : undefined;
  log(implementationPhaseRecord?.editCapable === true && implementationPhaseRecord?.commandProvided === true && implementationPhaseRecord?.worktreeChangedAfterBaseline === true && implementationPhaseRecord?.changedFiles?.includes('README.md') && implementationPhasePostValidation?.finalVerification?.targetedTransitions?.[0]?.baselineStatus === 1 && implementationPhasePostValidation?.finalVerification?.targetedTransitions?.[0]?.postStatus === 0 && implementationPhasePostValidation?.finalVerification?.targetedTransitions?.[0]?.fixedByOutcomeTransition === true && implementationPhasePostValidation?.finalVerification?.bugFixed === true && implementationPhasePostValidation?.finalVerification?.implementationBacked === true, 'bug-solver solve proves a successful outcome-based bug fix: targeted command fails at baseline, implementation changes isolated worktree, targeted command passes afterward, and finalVerification.bugFixed is true');

  const allowlistBlockedRepo = join(tmp, 'allowlist-blocked-repo');
  mkdirSync(allowlistBlockedRepo, { recursive: true });
  expectExit('bug-solver allowlist-blocked repo git init', ['git', 'init', '-q'], 0, { cwd: allowlistBlockedRepo });
  expectExit('bug-solver allowlist-blocked repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: allowlistBlockedRepo });
  expectExit('bug-solver allowlist-blocked repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: allowlistBlockedRepo });
  writeFileSync(join(allowlistBlockedRepo, 'README.md'), 'allowlist blocked before solve\n');
  expectExit('bug-solver allowlist-blocked repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: allowlistBlockedRepo });
  const allowlistBlockedPrecheck = expectExit('bug-solver workflow precheck records restrictive allowlist', ['node', bugSolverCli, 'precheck', '--cwd', allowlistBlockedRepo, '--bug', 'Fix allowlist blocked bug', '--allowlist', 'README.md', '--user-test-command', 'test -f src/out.txt', '--json'], 0);
  let allowlistBlockedPrecheckDetails;
  try { allowlistBlockedPrecheckDetails = JSON.parse(allowlistBlockedPrecheck.stdout); } catch { allowlistBlockedPrecheckDetails = undefined; }
  const allowlistBlockedSolve = expectExit('bug-solver workflow detects out-of-scope implementation changes', ['node', bugSolverCli, 'solve', '--cwd', allowlistBlockedRepo, '--plan-path', allowlistBlockedPrecheckDetails?.planPath || join(tmp, 'missing-allowlist-blocked-plan.json'), '--approved', '--implementation-command', 'mkdir -p src && touch src/out.txt', '--json'], 0);
  let allowlistBlockedSolveDetails;
  try { allowlistBlockedSolveDetails = JSON.parse(allowlistBlockedSolve.stdout); } catch { allowlistBlockedSolveDetails = undefined; }
  const allowlistBlockedRecords = allowlistBlockedSolveDetails?.implementationEvidencePath ? readFileSync(allowlistBlockedSolveDetails.implementationEvidencePath, 'utf8').trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)) : [];
  const allowlistBlockedRecord = allowlistBlockedRecords.find((record) => record.phase === 'implementation' && record.runnerOwnedImplementationMetadata === true);
  const allowlistBlockedPost = allowlistBlockedSolveDetails?.postValidationPath ? JSON.parse(readFileSync(allowlistBlockedSolveDetails.postValidationPath, 'utf8')) : undefined;
  log(allowlistBlockedRecord?.status === 'blocked_out_of_scope_changes' && allowlistBlockedRecord?.allowlist?.accepted === false && allowlistBlockedRecord?.allowlist?.outOfScopeFiles?.includes('src/out.txt') && allowlistBlockedPost?.finalVerification?.implementationBacked === false && allowlistBlockedPost?.finalVerification?.implementationEvidence?.allowlistAccepted === false, 'bug-solver allowlist enforcement blocks out-of-scope changes without a durable justified expansion');

  const allowlistExpansionRepo = join(tmp, 'allowlist-expansion-repo');
  mkdirSync(allowlistExpansionRepo, { recursive: true });
  expectExit('bug-solver allowlist-expansion repo git init', ['git', 'init', '-q'], 0, { cwd: allowlistExpansionRepo });
  expectExit('bug-solver allowlist-expansion repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: allowlistExpansionRepo });
  expectExit('bug-solver allowlist-expansion repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: allowlistExpansionRepo });
  writeFileSync(join(allowlistExpansionRepo, 'README.md'), 'allowlist expansion before solve\n');
  expectExit('bug-solver allowlist-expansion repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: allowlistExpansionRepo });
  const allowlistExpansionPrecheck = expectExit('bug-solver workflow precheck records expandable allowlist', ['node', bugSolverCli, 'precheck', '--cwd', allowlistExpansionRepo, '--bug', 'Fix allowlist expansion bug', '--allowlist', 'README.md', '--user-test-command', 'test -f src/out.txt', '--json'], 0);
  let allowlistExpansionPrecheckDetails;
  try { allowlistExpansionPrecheckDetails = JSON.parse(allowlistExpansionPrecheck.stdout); } catch { allowlistExpansionPrecheckDetails = undefined; }
  const allowlistExpansionPlan = allowlistExpansionPrecheckDetails?.planPath ? JSON.parse(readFileSync(allowlistExpansionPrecheckDetails.planPath, 'utf8')) : undefined;
  if (allowlistExpansionPlan?.allowlist?.decisionsPath) writeFileSync(allowlistExpansionPlan.allowlist.decisionsPath, `${JSON.stringify({ type: 'allowlist_expansion', createdAt: new Date().toISOString(), paths: ['src'], justification: 'The failing reproduction requires adding the missing src/out.txt artifact.' })}\n`, { flag: 'a' });
  const allowlistExpansionSolve = expectExit('bug-solver workflow accepts justified allowlist expansion', ['node', bugSolverCli, 'solve', '--cwd', allowlistExpansionRepo, '--plan-path', allowlistExpansionPrecheckDetails?.planPath || join(tmp, 'missing-allowlist-expansion-plan.json'), '--approved', '--implementation-command', 'mkdir -p src && touch src/out.txt', '--json'], 0);
  let allowlistExpansionSolveDetails;
  try { allowlistExpansionSolveDetails = JSON.parse(allowlistExpansionSolve.stdout); } catch { allowlistExpansionSolveDetails = undefined; }
  const allowlistExpansionRecords = allowlistExpansionSolveDetails?.implementationEvidencePath ? readFileSync(allowlistExpansionSolveDetails.implementationEvidencePath, 'utf8').trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)) : [];
  const allowlistExpansionRecord = allowlistExpansionRecords.find((record) => record.phase === 'implementation' && record.runnerOwnedImplementationMetadata === true);
  const allowlistExpansionReport = allowlistExpansionSolveDetails?.postValidationPath ? JSON.parse(readFileSync(allowlistExpansionSolveDetails.postValidationPath, 'utf8')) : undefined;
  log(allowlistExpansionRecord?.allowlist?.accepted === true && allowlistExpansionRecord?.allowlist?.acceptedExpansions?.some((record) => record.paths?.includes('src') && record.justification) && allowlistExpansionReport?.finalVerification?.implementationBacked === true, 'bug-solver adaptive allowlist accepts expanded paths only when a durable justification exists before acceptance');

  const gatedRepeatSolve = expectExit('bug-solver workflow repeated approved solve reuses isolated worktree safely', ['node', bugSolverCli, 'solve', '--cwd', gatedSolveRepo, '--plan-path', gatedPrecheckDetails?.planPath || join(tmp, 'missing-gated-plan.json'), '--approved', '--json'], 0);
  let gatedRepeatSolveDetails;
  try { gatedRepeatSolveDetails = JSON.parse(gatedRepeatSolve.stdout); } catch { gatedRepeatSolveDetails = undefined; }
  const gatedRepeatMetadata = gatedRepeatSolveDetails?.worktreeMetadataPath ? JSON.parse(readFileSync(gatedRepeatSolveDetails.worktreeMetadataPath, 'utf8')) : undefined;
  log(gatedRepeatMetadata?.worktree?.action === 'reused' && gatedRepeatMetadata?.branch?.action === 'reused' && gatedRepeatMetadata?.cleanup?.durableReuse === true, 'bug-solver repeated solve records durable worktree/branch reuse and cleanup metadata');
  const gatedBaselineBeforeDirtyReuse = gatedSolveDetails?.baselinePath ? JSON.parse(readFileSync(gatedSolveDetails.baselinePath, 'utf8')) : undefined;
  if (gatedSolveDetails?.worktreePath) writeFileSync(join(gatedSolveDetails.worktreePath, 'dirty-reused-worktree.txt'), 'dirty reuse should be refused before baseline\n');
  expectExit('bug-solver workflow refuses dirty reused transaction worktree before baseline validation', ['node', bugSolverCli, 'solve', '--cwd', gatedSolveRepo, '--plan-path', gatedPrecheckDetails?.planPath || join(tmp, 'missing-gated-plan.json'), '--approved', '--json'], 1);
  const dirtyReuseMetadata = gatedSolveDetails?.worktreeMetadataPath ? JSON.parse(readFileSync(gatedSolveDetails.worktreeMetadataPath, 'utf8')) : undefined;
  const gatedBaselineAfterDirtyReuse = gatedSolveDetails?.baselinePath ? JSON.parse(readFileSync(gatedSolveDetails.baselinePath, 'utf8')) : undefined;
  log(dirtyReuseMetadata?.status === 'refused_before_baseline_validation' && dirtyReuseMetadata?.baselineReadiness?.type === 'baseline_worktree_integrity_refusal' && dirtyReuseMetadata?.baselineReadiness?.assessment?.checks?.cleanWorktree === false && gatedBaselineAfterDirtyReuse?.completedAt === gatedBaselineBeforeDirtyReuse?.completedAt, 'bug-solver dirty reused worktree refusal is durable and does not rewrite baseline-validation.json');
  const copiedRegisteredPlan = join(tmp, 'copied-registered-transaction-plan.json');
  writeFileSync(copiedRegisteredPlan, JSON.stringify(gatedPlan, null, 2));
  expectExit('bug-solver workflow solve gate rejects copied transaction plans not at the registered durable path', ['node', bugSolverCli, 'solve', '--cwd', gatedSolveRepo, '--plan-path', copiedRegisteredPlan, '--approved', '--json'], 1);
  const tamperedRegistryPath = gatedPrecheckDetails?.artifactRegistryPath;
  if (tamperedRegistryPath) {
    const originalRegistry = JSON.parse(readFileSync(tamperedRegistryPath, 'utf8'));
    const tamperedContract = join(tmp, 'tampered-validation-contract.json');
    writeFileSync(tamperedContract, JSON.stringify(bugContract || {}, null, 2));
    writeFileSync(tamperedRegistryPath, JSON.stringify({ ...originalRegistry, entries: originalRegistry.entries.map((entry) => entry.kind === 'validationContract' ? { ...entry, path: tamperedContract } : entry) }, null, 2));
    expectExit('bug-solver workflow solve gate rejects artifact-registry validation contract mismatches before edits', ['node', bugSolverCli, 'solve', '--cwd', gatedSolveRepo, '--plan-path', gatedPrecheckDetails?.planPath || join(tmp, 'missing-gated-plan.json'), '--approved', '--json'], 1);
  }
  const forgedInRepoContractPlan = join(tmp, 'forged-in-repo-contract-plan.json');
  writeFileSync(forgedInRepoContractPlan, JSON.stringify({ ...gatedPlan, validation: { ...(gatedPlan?.validation || {}), contractPath: join(gatedSolveRepo, 'contract.json') }, validationContractPath: join(gatedSolveRepo, 'contract.json') }, null, 2));
  expectExit('bug-solver workflow solve gate rejects validation contract paths inside target repo before edits', ['node', bugSolverCli, 'solve', '--cwd', gatedSolveRepo, '--plan-path', forgedInRepoContractPlan, '--approved', '--json'], 1);
  const dirtyPrecheckRepo = join(tmp, 'dirty-precheck-repo');
  mkdirSync(dirtyPrecheckRepo, { recursive: true });
  expectExit('bug-solver dirty-precheck repo git init', ['git', 'init', '-q'], 0, { cwd: dirtyPrecheckRepo });
  expectExit('bug-solver dirty-precheck repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: dirtyPrecheckRepo });
  expectExit('bug-solver dirty-precheck repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: dirtyPrecheckRepo });
  writeFileSync(join(dirtyPrecheckRepo, 'README.md'), 'clean\n');
  expectExit('bug-solver dirty-precheck repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: dirtyPrecheckRepo });
  writeFileSync(join(dirtyPrecheckRepo, 'dirty.txt'), 'untracked\n');
  const dirtyPrecheck = expectExit('bug-solver workflow precheck records dirty worktree signals without editing repo', ['node', bugSolverCli, 'precheck', '--cwd', dirtyPrecheckRepo, '--bug', 'Fix dirty precheck signal bug', '--json'], 0);
  let dirtyPrecheckDetails;
  try { dirtyPrecheckDetails = JSON.parse(dirtyPrecheck.stdout); } catch { dirtyPrecheckDetails = undefined; }
  const dirtyPlan = dirtyPrecheckDetails?.planPath ? JSON.parse(readFileSync(dirtyPrecheckDetails.planPath, 'utf8')) : undefined;
  log(dirtyPlan?.repo?.dirtyAtPrecheck?.hasDirtyWorktree === true && dirtyPlan?.repo?.dirtyAtPrecheck?.counts?.untracked === 1 && dirtyPlan?.editingAllowed === false, 'bug-solver dirty precheck preserves editingAllowed=false and records untracked dirty signal');
  expectExit('bug-solver workflow solve rejects dirty precheck plan before activation scaffold', ['node', bugSolverCli, 'solve', '--cwd', dirtyPrecheckRepo, '--plan-path', dirtyPrecheckDetails?.planPath || join(tmp, 'missing-dirty-plan.json'), '--approved', '--json'], 1);
  const interruptedArtifacts = join(tmp, 'interrupted-bug-solver-artifacts');
  const interruptedRepo = join(tmp, 'interrupted-precheck-repo');
  mkdirSync(interruptedRepo, { recursive: true });
  expectExit('bug-solver interrupted-precheck repo git init', ['git', 'init', '-q'], 0, { cwd: interruptedRepo });
  expectExit('bug-solver interrupted-precheck repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: interruptedRepo });
  expectExit('bug-solver interrupted-precheck repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: interruptedRepo });
  writeFileSync(join(interruptedRepo, 'README.md'), 'interrupted\n');
  expectExit('bug-solver interrupted-precheck repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: interruptedRepo });
  const interruptedId = 'smoke-interrupted-precheck';
  expectExit('bug-solver injected interruption fails after files before registry', ['node', bugSolverCli, 'precheck', '--cwd', interruptedRepo, '--bug', 'Fix interrupted precheck artifact bug', '--transaction-id', interruptedId, '--json'], 1, { env: { PI_BUG_SOLVER_ARTIFACT_DIR: interruptedArtifacts, PI_BUG_SOLVER_INTERRUPT_PRECHECK_AFTER: 'files' } });
  const interruptedStatus = expectExit('bug-solver status recovers interrupted precheck by immutable id', ['node', bugSolverCli, 'status', '--transaction-id', interruptedId, '--json'], 0, { env: { PI_BUG_SOLVER_ARTIFACT_DIR: interruptedArtifacts } });
  let interruptedStatusDetails;
  try { interruptedStatusDetails = JSON.parse(interruptedStatus.stdout); } catch { interruptedStatusDetails = undefined; }
  log(interruptedStatusDetails?.recoverable === true && interruptedStatusDetails?.precheckMaterialization?.status === 'incomplete' && interruptedStatusDetails?.artifacts?.files?.artifactRegistry?.exists === false, 'bug-solver interrupted precheck is marked incomplete without a premature artifact registry');
  const interruptedRetry = expectExit('bug-solver retry completes interrupted precheck with same immutable id', ['node', bugSolverCli, 'precheck', '--cwd', interruptedRepo, '--bug', 'Fix interrupted precheck artifact bug', '--transaction-id', interruptedId, '--json'], 0, { env: { PI_BUG_SOLVER_ARTIFACT_DIR: interruptedArtifacts } });
  let interruptedRetryDetails;
  try { interruptedRetryDetails = JSON.parse(interruptedRetry.stdout); } catch { interruptedRetryDetails = undefined; }
  const interruptedRegistry = interruptedRetryDetails?.artifactRegistryPath ? JSON.parse(readFileSync(interruptedRetryDetails.artifactRegistryPath, 'utf8')) : undefined;
  log(interruptedRegistry?.materializationComplete === true && interruptedRegistry.entries.every((entry) => existsSync(entry.path)), 'bug-solver writes artifact registry only after all registered artifacts exist on retry');
  const malformedLockArtifacts = join(tmp, 'malformed-lock-bug-solver-artifacts');
  const malformedLockId = 'smoke-malformed-precheck-lock';
  const malformedLockDir = join(malformedLockArtifacts, 'transactions', malformedLockId);
  mkdirSync(malformedLockDir, { recursive: true });
  writeFileSync(join(malformedLockDir, '.precheck.lock'), '{not-json');
  const malformedLockStatus = expectExit('bug-solver status marks malformed precheck lock recoverable', ['node', bugSolverCli, 'status', '--cwd', interruptedRepo, '--transaction-id', malformedLockId, '--json'], 0, { env: { PI_BUG_SOLVER_ARTIFACT_DIR: malformedLockArtifacts } });
  let malformedLockStatusDetails;
  try { malformedLockStatusDetails = JSON.parse(malformedLockStatus.stdout); } catch { malformedLockStatusDetails = undefined; }
  log(malformedLockStatusDetails?.recoverable === true && malformedLockStatusDetails?.precheckMaterialization?.status === 'recoverable_stale_lock' && malformedLockStatusDetails?.precheckMaterialization?.lockRecoverable === true, 'bug-solver stale malformed precheck lock is explicitly recoverable in status');
  const malformedLockRetry = expectExit('bug-solver retry recovers malformed precheck lock and completes', ['node', bugSolverCli, 'precheck', '--cwd', interruptedRepo, '--bug', 'Fix malformed precheck lock recovery bug', '--transaction-id', malformedLockId, '--json'], 0, { env: { PI_BUG_SOLVER_ARTIFACT_DIR: malformedLockArtifacts } });
  let malformedLockRetryDetails;
  try { malformedLockRetryDetails = JSON.parse(malformedLockRetry.stdout); } catch { malformedLockRetryDetails = undefined; }
  const malformedLockRegistry = malformedLockRetryDetails?.artifactRegistryPath ? JSON.parse(readFileSync(malformedLockRetryDetails.artifactRegistryPath, 'utf8')) : undefined;
  log(malformedLockRegistry?.materializationComplete === true && !existsSync(join(malformedLockDir, '.precheck.lock')), 'bug-solver retry removes malformed stale lock without corrupting durable state');
  const visualizerStoreSource = readFileSync(join(root, 'thread-phase-visualizer/lib/store.mjs'), 'utf8');
  const visualizerIndexSource = readFileSync(join(root, 'thread-phase-visualizer/index.ts'), 'utf8');
  log(!/bug[-_]solver|pi-bug-solver/i.test(`${visualizerStoreSource}\n${visualizerIndexSource}`), 'generic thread-phase visualizer has no bug-solver-specific coupling');
  expectExit('bug-solver workflow accepts single-bug phrasing with non-independent conjunction', ['node', bugSolverCli, 'precheck', '--cwd', root, '--bug', 'Fix crash when loading and saving the same profile', '--json'], 0);
  expectExit('bug-solver workflow rejects multi-bug transaction before solve', ['node', bugSolverCli, 'precheck', '--cwd', root, '--bug', 'Fix login bug and also repair billing bug plus update exports', '--json'], 1);
  expectExit('bug-solver workflow rejects single-conjunction two-bug phrasing', ['node', bugSolverCli, 'precheck', '--cwd', root, '--bug', 'Fix login timeout and repair billing total bug', '--json'], 1);
  expectExit('bug-solver workflow rejects semicolon two-bug phrasing', ['node', bugSolverCli, 'precheck', '--cwd', root, '--bug', 'Fix login timeout; repair billing total bug', '--json'], 1);
  expectExit('bug-solver workflow rejects comma-separated two-bug phrasing', ['node', bugSolverCli, 'precheck', '--cwd', root, '--bug', 'Fix login bug, repair billing bug', '--json'], 1);
  expectExit('bug-solver workflow rejects comma-separated multi-action phrasing before solve activation', ['node', bugSolverCli, 'precheck', '--cwd', root, '--bug', 'Fix login bug, repair billing bug, update exports', '--json'], 1);
  const unknownSchemaPlan = join(tmp, 'unknown-schema-plan.json');
  writeFileSync(unknownSchemaPlan, JSON.stringify({ schema: 'unknown/transaction-plan/v1', transactionId: 'unknown-schema-plan', status: 'awaiting_confirmation', editingAllowed: false, transaction: { exactlyOneBug: true, bugDescription: 'Fix one bug', multiplicity: { likelyMultiple: false } }, validation: { contractPath: join(tmp, 'unknown-contract.json') } }, null, 2));
  expectExit('bug-solver workflow solve gate rejects unknown-schema plan artifacts before edits', ['node', bugSolverCli, 'solve', '--cwd', root, '--plan-path', unknownSchemaPlan, '--approved', '--json'], 1);
  const forgedMinimalPlan = join(tmp, 'forged-minimal-plan.json');
  writeFileSync(forgedMinimalPlan, JSON.stringify({ schema: 'pi-bug-solver-workflow/transaction-plan/v1', transactionId: 'forged-minimal-plan', status: 'awaiting_confirmation', editingAllowed: false, confirmationRequired: true, transaction: { bugDescription: 'Fix one bug' }, validation: { contractPath: join(tmp, 'forged-contract.json') } }, null, 2));
  expectExit('bug-solver workflow solve gate rejects minimally forged plans without explicit one-bug evidence', ['node', bugSolverCli, 'solve', '--cwd', root, '--plan-path', forgedMinimalPlan, '--approved', '--json'], 1);
  const forgedUnlockedPlan = join(tmp, 'forged-unlocked-plan.json');
  writeFileSync(forgedUnlockedPlan, JSON.stringify({ schema: 'pi-bug-solver-workflow/transaction-plan/v1', transactionId: 'forged-unlocked-plan', status: 'awaiting_confirmation', confirmationRequired: true, transaction: { exactlyOneBug: true, bugDescription: 'Fix one bug', multiplicity: { likelyMultiple: false }, splitRequired: false }, validation: { contractPath: join(tmp, 'forged-unlocked-contract.json') } }, null, 2));
  expectExit('bug-solver workflow solve gate rejects recognized plans omitting explicit editingAllowed=false lock', ['node', bugSolverCli, 'solve', '--cwd', root, '--plan-path', forgedUnlockedPlan, '--approved', '--json'], 1);
  const forgedPrecheckWithoutReadonly = join(tmp, 'forged-precheck-without-readonly.json');
  writeFileSync(forgedPrecheckWithoutReadonly, JSON.stringify({ schema: 'pi-bug-solver-workflow/precheck/v1', transactionId: 'forged-precheck-without-readonly', status: 'awaiting_confirmation', editingAllowed: false, confirmationRequired: true, bug: 'Fix one bug', multiplicity: { likelyMultiple: false }, validationContractPath: join(tmp, 'forged-precheck-contract.json') }, null, 2));
  expectExit('bug-solver workflow solve gate rejects precheck artifacts missing readOnly=true marker', ['node', bugSolverCli, 'solve', '--cwd', root, '--plan-path', forgedPrecheckWithoutReadonly, '--approved', '--json'], 1);
  const forgedPrecheckWithoutConfirmation = join(tmp, 'forged-precheck-without-confirmation.json');
  writeFileSync(forgedPrecheckWithoutConfirmation, JSON.stringify({ schema: 'pi-bug-solver-workflow/precheck/v1', transactionId: 'forged-precheck-without-confirmation', status: 'awaiting_confirmation', readOnly: true, editingAllowed: false, bug: 'Fix one bug', multiplicity: { likelyMultiple: false }, validationContractPath: join(tmp, 'forged-precheck-contract.json') }, null, 2));
  expectExit('bug-solver workflow solve gate rejects precheck artifacts missing confirmationRequired=true marker', ['node', bugSolverCli, 'solve', '--cwd', root, '--plan-path', forgedPrecheckWithoutConfirmation, '--approved', '--json'], 1);
  const legacyCommaPlan = join(tmp, 'legacy-comma-plan.json');
  writeFileSync(legacyCommaPlan, JSON.stringify({ schema: 'pi-bug-solver-workflow/transaction-plan/v1', transactionId: 'legacy-comma-plan', status: 'awaiting_confirmation', editingAllowed: false, transaction: { exactlyOneBug: true, bugDescription: 'Fix login bug, repair billing bug', multiplicity: { likelyMultiple: false } }, validation: { contractPath: join(tmp, 'legacy-contract.json') } }, null, 2));
  expectExit('bug-solver workflow solve gate reclassifies and rejects legacy comma-separated multi-bug plans', ['node', bugSolverCli, 'solve', '--cwd', root, '--plan-path', legacyCommaPlan, '--approved', '--json'], 1);
  expectExit('bug-solver workflow rejects bullet-list two-bug phrasing', ['node', bugSolverCli, 'precheck', '--cwd', root, '--bug', '- Fix login timeout\n- Repair billing total bug', '--json'], 1);
  expectExit('bug-solver workflow rejects numbered two-bug phrasing', ['node', bugSolverCli, 'precheck', '--cwd', root, '--bug', '1. Fix login timeout 2. Repair billing total bug', '--json'], 1);

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

  const shellSpec = join(tmp, 'shell-spec.json');
  writeFileSync(shellSpec, JSON.stringify({ name: 'shell-smoke', permissions: 'rwx', phases: [{ type: 'shell', name: 'hello', command: 'printf hello', artifact: true }] }, null, 2));
  expectExit('structured shell workflow succeeds', ['node', cli, '--spec-file', shellSpec, '--cwd', root], 0);

  const missionCli = join(root, 'mission-workflow/bin/mission-workflow.mjs');
  const missionRepo = join(tmp, 'mission-repo');
  mkdirSync(missionRepo, { recursive: true });
  expectExit('mission smoke repo git init', ['git', 'init', '-q'], 0, { cwd: missionRepo });
  expectExit('mission smoke repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: missionRepo });
  expectExit('mission smoke repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: missionRepo });
  writeFileSync(join(missionRepo, 'README.md'), 'hello\n');
  expectExit('mission smoke repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: missionRepo });
  const missionPlan = expectExit('mission workflow mock plan succeeds', ['node', missionCli, 'plan', '--planner', 'mock', '--goal', 'No-op smoke mission', '--cwd', missionRepo, '--validation-command', 'true', '--user-test-command', 'none provided'], 0);
  let missionPlanDetails;
  try { missionPlanDetails = JSON.parse(missionPlan.stdout); } catch { missionPlanDetails = undefined; }
  log(Boolean(missionPlanDetails?.planPath), 'mission workflow plan emits planPath');
  const plannedMissionArtifact = missionPlanDetails?.planPath ? JSON.parse(readFileSync(missionPlanDetails.planPath, 'utf8')) : undefined;
  log(plannedMissionArtifact?.userTestCommand === undefined, 'mission workflow normalizes CLI user-test sentinel to absent optional command in plan');
  const missionPlanEquivalentPlaceholder = expectExit('mission workflow mock plan normalizes equivalent user-test placeholder', ['node', missionCli, 'plan', '--planner', 'mock', '--goal', 'Equivalent no user tests placeholder mission', '--cwd', missionRepo, '--validation-command', 'true', '--user-test-command', 'No user tests provided.'], 0);
  let missionPlanEquivalentDetails;
  try { missionPlanEquivalentDetails = JSON.parse(missionPlanEquivalentPlaceholder.stdout); } catch { missionPlanEquivalentDetails = undefined; }
  const missionPlanEquivalentArtifact = missionPlanEquivalentDetails?.planPath ? JSON.parse(readFileSync(missionPlanEquivalentDetails.planPath, 'utf8')) : undefined;
  log(missionPlanEquivalentArtifact?.userTestCommand === undefined, 'mission workflow treats prose user-test placeholders as absent optional commands');
  if (missionPlanDetails?.planPath) writeFileSync(missionPlanDetails.planPath, JSON.stringify({ ...plannedMissionArtifact, userTestCommand: 'none provided' }, null, 2));
  const missionActivate = missionPlanDetails?.planPath
    ? expectExit('mission workflow mock activate succeeds with sentinel in existing plan artifact', ['node', missionCli, 'activate', '--approved', '--plan-path', missionPlanDetails.planPath, '--cwd', missionRepo], 0)
    : undefined;
  let missionActivateDetails;
  try { missionActivateDetails = missionActivate?.stdout ? JSON.parse(missionActivate.stdout) : undefined; } catch { missionActivateDetails = undefined; }
  log(Boolean(missionActivateDetails?.branch), 'mission workflow activation emits mission branch');
  log(Boolean(missionActivateDetails?.registryPath) && existsSync(missionActivateDetails.registryPath), 'mission workflow activation creates durable registry');
  const registryState = missionActivateDetails?.registryPath ? JSON.parse(readFileSync(missionActivateDetails.registryPath, 'utf8')) : undefined;
  log(registryState?.status === 'completed' && Array.isArray(registryState.completedFeatures), 'mission workflow registry records completed state');
  log(Boolean(missionActivateDetails?.finalCoveragePath) && existsSync(missionActivateDetails.finalCoveragePath), 'mission workflow writes final coverage report');
  const missionPlanArtifact = missionPlanDetails?.planPath ? JSON.parse(readFileSync(missionPlanDetails.planPath, 'utf8')) : undefined;
  log(missionPlanArtifact?.userTestCommand === undefined, 'mission workflow normalizes existing plan-artifact user-test sentinel before validation');
  const missionFinalCoverage = missionActivateDetails?.finalCoveragePath && existsSync(missionActivateDetails.finalCoveragePath) ? JSON.parse(readFileSync(missionActivateDetails.finalCoveragePath, 'utf8')) : undefined;
  log(missionFinalCoverage?.scope === 'final' && missionFinalCoverage?.gaps?.length === 0 && missionFinalCoverage?.assertions?.every((assertion) => assertion.status === 'pass'), 'mission workflow final coverage passes after skipped optional user test');
  const missionValidationReportPath = missionActivateDetails?.runId ? join(store, 'artifacts', missionActivateDetails.runId, 'validation', 'milestone-001-report.json') : undefined;
  const missionValidationReport = missionValidationReportPath && existsSync(missionValidationReportPath) ? JSON.parse(readFileSync(missionValidationReportPath, 'utf8')) : undefined;
  log(missionValidationReport?.reports?.some((report) => report.validator === 'user-testing-command' && report.skipped === true && report.notApplicable === true && report.passed === true && report.command === null), 'mission workflow records absent user-test command as skipped validation');
  log(!missionValidationReport?.reports?.some((report) => report.validator === 'user-testing-command' && report.command === 'none provided'), 'mission workflow does not execute user-test sentinel as a shell command');
  const missionMilestoneCoverage = missionValidationReport?.coveragePath && existsSync(missionValidationReport.coveragePath) ? JSON.parse(readFileSync(missionValidationReport.coveragePath, 'utf8')) : undefined;
  const missionCoverageValidators = missionMilestoneCoverage?.assertions?.flatMap((assertion) => assertion.validators || []) || [];
  log(missionCoverageValidators.some((validator) => validator.validator === 'user-testing-command' && validator.command === null && validator.passed === true && validator.skipped === true && validator.notApplicable === true), 'mission workflow milestone coverage records skipped optional user test validator');
  const missionResume = missionPlanDetails?.planPath
    ? expectExit('mission workflow rejects resume after completed mission', ['node', missionCli, 'resume', '--approved', '--plan-path', missionPlanDetails.planPath, '--cwd', missionRepo], 1)
    : undefined;
  const registryAfterCompletedResume = missionActivateDetails?.registryPath ? JSON.parse(readFileSync(missionActivateDetails.registryPath, 'utf8')) : undefined;
  log(registryAfterCompletedResume?.status === 'completed' && Boolean(registryAfterCompletedResume?.lastFailedAttempt), 'mission workflow completed registry survives invalid resume');

  const largeRepo = join(tmp, 'large-jsonl-repo');
  mkdirSync(largeRepo, { recursive: true });
  expectExit('large JSONL repo git init', ['git', 'init', '-q'], 0, { cwd: largeRepo });
  expectExit('large JSONL repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: largeRepo });
  expectExit('large JSONL repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: largeRepo });
  writeFileSync(join(largeRepo, 'README.md'), 'large-jsonl\n');
  expectExit('large JSONL repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: largeRepo });
  const largePlanPath = join(tmp, 'large-jsonl-plan.json');
  writeFileSync(largePlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'large-jsonl-smoke', goal: 'large jsonl parser smoke', cwd: largeRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'large-jsonl-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'f1', description: 'f1', assertions: ['a1'] }] }],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePiLarge = join(tmp, 'fake-pi-large-jsonl.mjs');
  writeFileSync(fakePiLarge, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nmkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\nwriteFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: [], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'ok' }));\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'x'.repeat(300000), objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-large', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi large JSONL is executable', ['chmod', '+x', fakePiLarge], 0);
  expectExit('mission workflow handles large Pi JSONL records', ['node', missionCli, 'activate', '--approved', '--plan-path', largePlanPath, '--cwd', largeRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiLarge }, timeout: 60_000 });

  const unsafeRepo = join(tmp, 'unsafe-assertion-repo');
  mkdirSync(unsafeRepo, { recursive: true });
  expectExit('unsafe assertion repo git init', ['git', 'init', '-q'], 0, { cwd: unsafeRepo });
  expectExit('unsafe assertion repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: unsafeRepo });
  expectExit('unsafe assertion repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: unsafeRepo });
  writeFileSync(join(unsafeRepo, 'README.md'), 'unsafe\n');
  expectExit('unsafe assertion repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: unsafeRepo });
  const unsafePlanPath = join(tmp, 'unsafe-assertion-plan.json');
  writeFileSync(unsafePlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'unsafe-assertion-smoke', goal: 'unsafe assertion normalization', cwd: unsafeRepo, baseRef: 'HEAD', planner: 'mock', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'unsafe-assertion-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'f1', description: 'f1', assertions: ['unsafe assertion id'] }] }],
    validationContract: { assertions: [{ id: 'unsafe assertion id', description: 'unsafe assertion description', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const unsafeActivate = expectExit('mission workflow normalizes unsafe assertion ids', ['node', missionCli, 'activate', '--approved', '--plan-path', unsafePlanPath, '--cwd', unsafeRepo], 0);
  let unsafeDetails;
  try { unsafeDetails = unsafeActivate.stdout ? JSON.parse(unsafeActivate.stdout) : undefined; } catch { unsafeDetails = undefined; }
  const unsafeCoverage = unsafeDetails?.finalCoveragePath ? JSON.parse(readFileSync(unsafeDetails.finalCoveragePath, 'utf8')) : undefined;
  log(unsafeCoverage?.gaps?.length === 0, 'unsafe assertion final coverage has no gaps');

  const typoRepo = join(tmp, 'typo-assertion-repo');
  mkdirSync(typoRepo, { recursive: true });
  expectExit('typo assertion repo git init', ['git', 'init', '-q'], 0, { cwd: typoRepo });
  expectExit('typo assertion repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: typoRepo });
  expectExit('typo assertion repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: typoRepo });
  writeFileSync(join(typoRepo, 'README.md'), 'typo\n');
  expectExit('typo assertion repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: typoRepo });
  const typoPlanPath = join(tmp, 'typo-assertion-plan.json');
  writeFileSync(typoPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'typo-assertion-smoke', goal: 'typo assertion rejection', cwd: typoRepo, baseRef: 'HEAD', planner: 'mock', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'typo-assertion-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'f1', description: 'f1', assertions: ['a-1'] }] }],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  expectExit('mission workflow rejects unknown feature assertion references', ['node', missionCli, 'activate', '--approved', '--plan-path', typoPlanPath, '--cwd', typoRepo], 1);

  const localCollisionRepo = join(tmp, 'local-collision-repo');
  mkdirSync(localCollisionRepo, { recursive: true });
  expectExit('local collision repo git init', ['git', 'init', '-q'], 0, { cwd: localCollisionRepo });
  expectExit('local collision repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: localCollisionRepo });
  expectExit('local collision repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: localCollisionRepo });
  writeFileSync(join(localCollisionRepo, 'README.md'), 'local collision\n');
  expectExit('local collision repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: localCollisionRepo });
  const localCollisionPlanPath = join(tmp, 'local-collision-plan.json');
  writeFileSync(localCollisionPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'local-collision-smoke', goal: 'local collision rejection', cwd: localCollisionRepo, baseRef: 'HEAD', planner: 'mock', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'local-collision-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'f1', description: 'f1', assertions: ['a1'], localAssertions: ['a1'] }] }],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  expectExit('mission workflow rejects local assertion contract collisions', ['node', missionCli, 'activate', '--approved', '--plan-path', localCollisionPlanPath, '--cwd', localCollisionRepo], 1);

  const localSupplementRepo = join(tmp, 'local-supplement-repo');
  mkdirSync(localSupplementRepo, { recursive: true });
  expectExit('local supplement repo git init', ['git', 'init', '-q'], 0, { cwd: localSupplementRepo });
  expectExit('local supplement repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: localSupplementRepo });
  expectExit('local supplement repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: localSupplementRepo });
  writeFileSync(join(localSupplementRepo, 'README.md'), 'local supplement\n');
  expectExit('local supplement repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: localSupplementRepo });
  const localSupplementPlanPath = join(tmp, 'local-supplement-plan.json');
  writeFileSync(localSupplementPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'local-supplement-smoke', goal: 'local supplement coverage', cwd: localSupplementRepo, baseRef: 'HEAD', planner: 'mock', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'local-supplement-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'f1', description: 'f1', localAssertions: ['local acceptance check'] }] }],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const localSupplementActivate = expectExit('mission workflow treats localAssertions as supplemental by default', ['node', missionCli, 'activate', '--approved', '--plan-path', localSupplementPlanPath, '--cwd', localSupplementRepo], 0);
  let localSupplementDetails;
  try { localSupplementDetails = localSupplementActivate.stdout ? JSON.parse(localSupplementActivate.stdout) : undefined; } catch { localSupplementDetails = undefined; }
  const localSupplementCoverage = localSupplementDetails?.finalCoveragePath ? JSON.parse(readFileSync(localSupplementDetails.finalCoveragePath, 'utf8')) : undefined;
  log(localSupplementCoverage?.gaps?.length === 0, 'local supplement final coverage has no gaps');

  const failedValidatorRepo = join(tmp, 'failed-validator-repo');
  mkdirSync(failedValidatorRepo, { recursive: true });
  expectExit('failed validator repo git init', ['git', 'init', '-q'], 0, { cwd: failedValidatorRepo });
  expectExit('failed validator repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: failedValidatorRepo });
  expectExit('failed validator repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: failedValidatorRepo });
  writeFileSync(join(failedValidatorRepo, 'README.md'), 'validator\n');
  expectExit('failed validator repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: failedValidatorRepo });
  const failedValidatorPlanPath = join(tmp, 'failed-validator-plan.json');
  writeFileSync(failedValidatorPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'failed-validator-smoke', goal: 'validator false blocks', cwd: failedValidatorRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'failed-validator-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'f1', description: 'f1', assertions: ['a1'] }] }],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePiValidatorFalse = join(tmp, 'fake-pi-validator-false.mjs');
  writeFileSync(fakePiValidatorFalse, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nmkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\nwriteFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: [], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'ok' }));\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: false, summary: 'validator says no', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-false', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi validator false is executable', ['chmod', '+x', fakePiValidatorFalse], 0);
  expectExit('mission workflow treats validator passed false as blocking', ['node', missionCli, 'activate', '--approved', '--plan-path', failedValidatorPlanPath, '--cwd', failedValidatorRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiValidatorFalse }, timeout: 60_000 });

  const omittedValidatorRepo = join(tmp, 'omitted-validator-repo');
  mkdirSync(omittedValidatorRepo, { recursive: true });
  expectExit('omitted validator repo git init', ['git', 'init', '-q'], 0, { cwd: omittedValidatorRepo });
  expectExit('omitted validator repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: omittedValidatorRepo });
  expectExit('omitted validator repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: omittedValidatorRepo });
  writeFileSync(join(omittedValidatorRepo, 'README.md'), 'validator omitted\n');
  expectExit('omitted validator repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: omittedValidatorRepo });
  const omittedValidatorPlanPath = join(tmp, 'omitted-validator-plan.json');
  writeFileSync(omittedValidatorPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'omitted-validator-smoke', goal: 'validator omissions block', cwd: omittedValidatorRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'omitted-validator-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'f1', description: 'f1', assertions: ['a1'] }] }],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePiValidatorOmitted = join(tmp, 'fake-pi-validator-omitted.mjs');
  writeFileSync(fakePiValidatorOmitted, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nmkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\nwriteFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: [], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'ok' }));\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'omitted assertion result', objections: [], assertionResults: [], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-omitted', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi validator omitted is executable', ['chmod', '+x', fakePiValidatorOmitted], 0);
  expectExit('mission workflow treats omitted validator assertion results as blocking', ['node', missionCli, 'activate', '--approved', '--plan-path', omittedValidatorPlanPath, '--cwd', omittedValidatorRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiValidatorOmitted }, timeout: 60_000 });

  const prefixedHandoffRepo = join(tmp, 'prefixed-handoff-repo');
  mkdirSync(prefixedHandoffRepo, { recursive: true });
  expectExit('prefixed handoff repo git init', ['git', 'init', '-q'], 0, { cwd: prefixedHandoffRepo });
  expectExit('prefixed handoff repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: prefixedHandoffRepo });
  expectExit('prefixed handoff repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: prefixedHandoffRepo });
  writeFileSync(join(prefixedHandoffRepo, 'README.md'), 'prefixed handoff\n');
  expectExit('prefixed handoff repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: prefixedHandoffRepo });
  const prefixedHandoffPlanPath = join(tmp, 'prefixed-handoff-plan.json');
  writeFileSync(prefixedHandoffPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'prefixed-handoff-smoke', goal: 'prefixed handoff normalization', cwd: prefixedHandoffRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'prefixed-handoff-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'f1', description: 'f1', assertions: ['risk-approval'], localAssertions: ['python -m compileall auto_trading tests succeeds'] }] }],
    validationContract: { assertions: [{ id: 'risk-approval', description: 'risk approval assertion', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }, { id: 'other-contract', description: 'unassigned contract assertion', priority: 'should', coveredBy: ['other'], validationMethod: 'validator' }] }
  }, null, 2));
  const fakePiPrefixedHandoff = join(tmp, 'fake-pi-prefixed-handoff.mjs');
  writeFileSync(fakePiPrefixedHandoff, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nmkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\nwriteFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: [], commandsRun: [], assertionsAddressed: ['risk-approval: detailed repair evidence', 'Local assertion: python -m compileall auto_trading tests succeeds. Verified with compileall.', { id: 'other-contract', type: 'local', status: 'addressed', summary: 'supplemental local evidence may collide with unassigned contract IDs without becoming contract coverage' }], issuesDiscovered: [], leftUndone: [], notesForValidator: 'ok' }));\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'prefixed handoff accepted', objections: [], assertionResults: [{ assertionId: 'risk-approval', status: 'pass', evidence: 'ok' }, { assertionId: 'python -m compileall auto_trading tests succeeds', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-prefixed', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi prefixed handoff is executable', ['chmod', '+x', fakePiPrefixedHandoff], 0);
  expectExit('mission workflow canonicalizes prefixed handoff assertion ids', ['node', missionCli, 'activate', '--approved', '--plan-path', prefixedHandoffPlanPath, '--cwd', prefixedHandoffRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiPrefixedHandoff }, timeout: 60_000 });

  const canonicalFeatureIdRepo = join(tmp, 'canonical-feature-id-repo');
  mkdirSync(canonicalFeatureIdRepo, { recursive: true });
  expectExit('canonical feature id repo git init', ['git', 'init', '-q'], 0, { cwd: canonicalFeatureIdRepo });
  expectExit('canonical feature id repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: canonicalFeatureIdRepo });
  expectExit('canonical feature id repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: canonicalFeatureIdRepo });
  writeFileSync(join(canonicalFeatureIdRepo, 'README.md'), 'canonical feature id\n');
  expectExit('canonical feature id repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: canonicalFeatureIdRepo });
  const canonicalFeatureIdPlanPath = join(tmp, 'canonical-feature-id-plan.json');
  writeFileSync(canonicalFeatureIdPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'canonical-feature-id-smoke', goal: 'canonical feature id handoff', cwd: canonicalFeatureIdRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: join(tmp, 'canonical-feature-id-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Feature One', description: 'f1', assertions: ['a1'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] } }, null, 2));
  const fakePiCanonicalFeatureId = join(tmp, 'fake-pi-canonical-feature-id.mjs');
  writeFileSync(fakePiCanonicalFeatureId, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1-', completed: true, changedFiles: [], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'trailing punctuation canonicalized' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-canonical-feature-id', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi canonical feature id is executable', ['chmod', '+x', fakePiCanonicalFeatureId], 0);
  expectExit('mission workflow canonicalizes safeName-equivalent handoff featureId', ['node', missionCli, 'activate', '--approved', '--plan-path', canonicalFeatureIdPlanPath, '--cwd', canonicalFeatureIdRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiCanonicalFeatureId }, timeout: 60_000 });

  const shortRepairRepo = join(tmp, 'short-repair-repo');
  mkdirSync(shortRepairRepo, { recursive: true });
  expectExit('short repair repo git init', ['git', 'init', '-q'], 0, { cwd: shortRepairRepo });
  expectExit('short repair repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: shortRepairRepo });
  expectExit('short repair repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: shortRepairRepo });
  writeFileSync(join(shortRepairRepo, 'README.md'), 'short repair\n');
  expectExit('short repair repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: shortRepairRepo });
  const shortRepairPlanPath = join(tmp, 'short-repair-plan.json');
  writeFileSync(shortRepairPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'short-repair-smoke', goal: 'short repair ids', cwd: shortRepairRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 2, worktreeBaseDir: join(tmp, 'short-repair-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Feature One', description: 'f1', assertions: ['a1'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] } }, null, 2));
  const shortRepairMarker = join(tmp, 'short-repair-validator-seen');
  const fakePiShortRepair = join(tmp, 'fake-pi-short-repair.mjs');
  writeFileSync(fakePiShortRepair, `#!/usr/bin/env node\nimport { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  const match = prompt.match(/\\.mission\\/handoffs\\/([^\\s]+?)\\.json/);\n  const featureId = match ? match[1] : 'f1';\n  if (featureId.startsWith('repair-')) appendFileSync(join(process.cwd(), 'README.md'), 'repair ran\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', featureId + '.json'), JSON.stringify({ featureId, completed: true, changedFiles: featureId.startsWith('repair-') ? ['README.md'] : [], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'ok' }));\n} else if (!existsSync(${JSON.stringify(shortRepairMarker)})) {\n  writeFileSync(${JSON.stringify(shortRepairMarker)}, 'seen');\n  const report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: false, summary: 'needs repair', objections: [{ level: 'must', assertionId: 'a1', description: 'needs repair', evidence: 'test', repairHint: 'repair' }], assertionResults: [{ assertionId: 'a1', status: 'fail', evidence: 'test' }], correctiveFeatures: [{ title: 'Very long human readable repair title should not enter the id', description: 'repair content', assertions: ['a1'], rationale: 'repair rationale' }] };\n  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-short-repair', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n  process.exit(0);\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-short-repair', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi short repair is executable', ['chmod', '+x', fakePiShortRepair], 0);
  const shortRepairActivate = expectExit('mission workflow uses short content-addressed repair ids', ['node', missionCli, 'activate', '--approved', '--plan-path', shortRepairPlanPath, '--cwd', shortRepairRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiShortRepair }, timeout: 60_000 });
  let shortRepairDetails;
  try { shortRepairDetails = shortRepairActivate.stdout ? JSON.parse(shortRepairActivate.stdout) : undefined; } catch { shortRepairDetails = undefined; }
  const shortRepairArtifactDir = shortRepairDetails?.runId ? join(store, 'artifacts', shortRepairDetails.runId, 'handoffs') : '';
  const shortRepairHandoffs = existsSync(shortRepairArtifactDir) ? spawnSync('find', [shortRepairArtifactDir, '-maxdepth', '1', '-type', 'f', '-name', 'repair-*.json'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/).filter(Boolean).map((p) => p.split('/').pop()) : [];
  log(shortRepairHandoffs.some((name) => /^repair-m1-1-[0-9a-f]{10}\.json$/.test(name)), 'repair handoff artifact uses short hash id', JSON.stringify(shortRepairHandoffs));

  const transientLockRepo = join(tmp, 'transient-lock-repo');
  mkdirSync(transientLockRepo, { recursive: true });
  expectExit('transient lock repo git init', ['git', 'init', '-q'], 0, { cwd: transientLockRepo });
  expectExit('transient lock repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: transientLockRepo });
  expectExit('transient lock repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: transientLockRepo });
  writeFileSync(join(transientLockRepo, 'README.md'), 'transient lock\n');
  expectExit('transient lock repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: transientLockRepo });
  const transientLockPlanPath = join(tmp, 'transient-lock-plan.json');
  writeFileSync(transientLockPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'transient-lock-smoke', goal: 'transient lock cleanup', cwd: transientLockRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'transient-lock-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Transient Lock Feature', description: 'f1', assertions: ['a1'] }] }],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePiTransientLock = join(tmp, 'fake-pi-transient-lock.mjs');
  writeFileSync(fakePiTransientLock, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'app.py'), 'print(\\"ok\\")\\n');\n  writeFileSync(join(process.cwd(), 'uv.lock'), 'accidental lock\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['app.py'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: ['uv.lock was accidentally generated by tooling'], leftUndone: [], notesForValidator: 'uv.lock is transient and omitted' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-transient-lock', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi transient lock is executable', ['chmod', '+x', fakePiTransientLock], 0);
  const transientLockActivate = expectExit('mission workflow auto-cleans omitted untracked uv.lock without manifest changes', ['node', missionCli, 'activate', '--approved', '--plan-path', transientLockPlanPath, '--cwd', transientLockRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiTransientLock }, timeout: 60_000 });
  let transientLockDetails;
  try { transientLockDetails = transientLockActivate.stdout ? JSON.parse(transientLockActivate.stdout) : undefined; } catch { transientLockDetails = undefined; }
  expectExit('transient lock mission committed app change', ['git', 'show', 'mission/transient-lock-smoke:app.py'], 0, { cwd: transientLockRepo });
  expectExit('transient lock mission did not commit accidental uv.lock', ['git', 'cat-file', '-e', 'mission/transient-lock-smoke:uv.lock'], 128, { cwd: transientLockRepo });
  log(Boolean(transientLockDetails?.runId) && existsSync(join(store, 'artifacts', transientLockDetails.runId, 'handoffs', 'f1-auto-cleaned-transient-artifacts.json')), 'transient lock cleanup writes audit artifact');

  const manifestLockRepo = join(tmp, 'manifest-lock-repo');
  mkdirSync(manifestLockRepo, { recursive: true });
  expectExit('manifest lock repo git init', ['git', 'init', '-q'], 0, { cwd: manifestLockRepo });
  expectExit('manifest lock repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: manifestLockRepo });
  expectExit('manifest lock repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: manifestLockRepo });
  writeFileSync(join(manifestLockRepo, 'README.md'), 'manifest lock\n');
  expectExit('manifest lock repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: manifestLockRepo });
  const manifestLockPlanPath = join(tmp, 'manifest-lock-plan.json');
  writeFileSync(manifestLockPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'manifest-lock-smoke', goal: 'manifest lock strictness', cwd: manifestLockRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'manifest-lock-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Manifest Lock Feature', description: 'f1', assertions: ['a1'] }] }],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePiManifestLock = join(tmp, 'fake-pi-manifest-lock.mjs');
  writeFileSync(fakePiManifestLock, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nif ((process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '').includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'pyproject.toml'), '[project]\\nname = \\"manifest-lock-smoke\\"\\nversion = \\"0.1.0\\"\\n');\n  writeFileSync(join(process.cwd(), 'uv.lock'), 'intentional lock must be declared\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['pyproject.toml'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'bad omitted lock' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-manifest-lock', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi manifest lock is executable', ['chmod', '+x', fakePiManifestLock], 0);
  expectExit('mission workflow commits runner-derived uv.lock when dependency manifest changed', ['node', missionCli, 'activate', '--approved', '--plan-path', manifestLockPlanPath, '--cwd', manifestLockRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiManifestLock }, timeout: 60_000 });
  expectExit('manifest lock mission committed intentional uv.lock', ['git', 'cat-file', '-e', 'mission/manifest-lock-smoke:uv.lock'], 0, { cwd: manifestLockRepo });

  const mergeLockRepo = join(tmp, 'merge-lock-repo');
  mkdirSync(mergeLockRepo, { recursive: true });
  expectExit('merge lock repo git init', ['git', 'init', '-q'], 0, { cwd: mergeLockRepo });
  expectExit('merge lock repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: mergeLockRepo });
  expectExit('merge lock repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: mergeLockRepo });
  writeFileSync(join(mergeLockRepo, 'README.md'), 'merge lock\n');
  expectExit('merge lock repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: mergeLockRepo });
  const mergeLockTouch = join(tmp, 'merge-lock-touch.mjs');
  writeFileSync(mergeLockTouch, `import { writeFileSync } from 'node:fs';\nwriteFileSync('uv.lock', 'transient integration lock\\n');\n`);
  const mergeLockPlanPath = join(tmp, 'merge-lock-plan.json');
  writeFileSync(mergeLockPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'merge-lock-smoke', goal: 'merge-blocking lock cleanup', cwd: mergeLockRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'merge-lock-worktrees'), validationCommands: [`node ${JSON.stringify(mergeLockTouch)}`], milestones: [
      { id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'No Change Before Lock', description: 'f1', assertions: ['a1'] }] },
      { id: 'm2', title: 'm2', features: [{ id: 'f2', title: 'Commit Lock After Manifest Change', description: 'f2', assertions: ['a2'] }] }
    ],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }, { id: 'a2', description: 'a2', priority: 'must', coveredBy: ['f2'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePiMergeLock = join(tmp, 'fake-pi-merge-lock.mjs');
  writeFileSync(fakePiMergeLock, `#!/usr/bin/env node\nimport { basename, join } from 'node:path';\nimport { mkdirSync, writeFileSync } from 'node:fs';\nconst featureId = basename(process.cwd());\nmkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\nif (featureId === 'f2') {\n  writeFileSync(join(process.cwd(), 'pyproject.toml'), '[project]\\nname = "merge-lock-smoke"\\nversion = "0.1.0"\\ndependencies = ["pyarrow"]\\n');\n  writeFileSync(join(process.cwd(), 'uv.lock'), 'intentional tracked lock\\n');\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f2.json'), JSON.stringify({ featureId: 'f2', completed: true, changedFiles: ['pyproject.toml', 'uv.lock'], commandsRun: [], assertionsAddressed: ['a2'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'intentional lock' }));\n} else if (featureId === 'f1') {\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, outcome: 'already_satisfied', evidence: ['ok'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'no change' }));\n}\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: prompt.includes('m2') ? 'm2' : 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }, { assertionId: 'a2', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-merge-lock', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi merge lock is executable', ['chmod', '+x', fakePiMergeLock], 0);
  const mergeLockActivate = expectExit('mission workflow cleans merge-blocking untracked uv.lock before intentional lock merge', ['node', missionCli, 'activate', '--approved', '--plan-path', mergeLockPlanPath, '--cwd', mergeLockRepo, '--model-validator', 'stable-validator'], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiMergeLock }, timeout: 60_000 });
  let mergeLockDetails;
  try { mergeLockDetails = mergeLockActivate.stdout ? JSON.parse(mergeLockActivate.stdout) : undefined; } catch { mergeLockDetails = undefined; }
  expectExit('merge lock mission committed intentional uv.lock', ['git', 'cat-file', '-e', 'mission/merge-lock-smoke:uv.lock'], 0, { cwd: mergeLockRepo });
  const mergeLockAuditPath = mergeLockDetails?.runId ? join(store, 'artifacts', mergeLockDetails.runId, 'handoffs', 'f2-auto-cleaned-merge-blocking-transient-artifacts.json') : '';
  log(Boolean(mergeLockAuditPath) && existsSync(mergeLockAuditPath), 'merge-blocking lock cleanup writes audit artifact');
  const mergeLockAudit = mergeLockAuditPath && existsSync(mergeLockAuditPath) ? JSON.parse(readFileSync(mergeLockAuditPath, 'utf8')) : undefined;
  const mergeLockBackup = mergeLockAudit?.quarantined?.[0]?.backupPath;
  const mergeLockBackupBytes = mergeLockBackup && existsSync(mergeLockBackup) ? readFileSync(mergeLockBackup) : undefined;
  log(Boolean(mergeLockBackupBytes) && mergeLockAudit.quarantined[0].bytes === mergeLockBackupBytes.length && mergeLockAudit.quarantined[0].sha256 === createHash('sha256').update(mergeLockBackupBytes).digest('hex'), 'merge-blocking lock quarantine records recoverable bytes and hash');

  const symlinkLockRepo = join(tmp, 'symlink-lock-repo');
  mkdirSync(symlinkLockRepo, { recursive: true });
  expectExit('symlink lock repo git init', ['git', 'init', '-q'], 0, { cwd: symlinkLockRepo });
  expectExit('symlink lock repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: symlinkLockRepo });
  expectExit('symlink lock repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: symlinkLockRepo });
  writeFileSync(join(symlinkLockRepo, 'README.md'), 'symlink lock\n');
  expectExit('symlink lock repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: symlinkLockRepo });
  const symlinkSecret = join(tmp, 'symlink-secret.txt');
  writeFileSync(symlinkSecret, 'DO-NOT-COPY-SYMLINK-SECRET\n');
  const symlinkLockTouch = join(tmp, 'symlink-lock-touch.mjs');
  writeFileSync(symlinkLockTouch, `import { rmSync, symlinkSync } from 'node:fs';\nrmSync('uv.lock', { force: true });\nsymlinkSync(${JSON.stringify(symlinkSecret)}, 'uv.lock');\n`);
  const symlinkLockPlanPath = join(tmp, 'symlink-lock-plan.json');
  writeFileSync(symlinkLockPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'symlink-lock-smoke', goal: 'symlink lock safety', cwd: symlinkLockRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'symlink-lock-worktrees'), validationCommands: [`node ${JSON.stringify(symlinkLockTouch)}`], milestones: [
      { id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'No Change Before Symlink', description: 'f1', assertions: ['a1'] }] },
      { id: 'm2', title: 'm2', features: [{ id: 'f2', title: 'Commit Lock Against Symlink', description: 'f2', assertions: ['a2'] }] }
    ],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }, { id: 'a2', description: 'a2', priority: 'must', coveredBy: ['f2'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePiSymlinkLock = join(tmp, 'fake-pi-symlink-lock.mjs');
  writeFileSync(fakePiSymlinkLock, `#!/usr/bin/env node\nimport { basename, join } from 'node:path';\nimport { mkdirSync, writeFileSync } from 'node:fs';\nconst featureId = basename(process.cwd());\nmkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\nif (featureId === 'f2') {\n  writeFileSync(join(process.cwd(), 'pyproject.toml'), '[project]\\nname = "symlink-lock-smoke"\\nversion = "0.1.0"\\n');\n  writeFileSync(join(process.cwd(), 'uv.lock'), 'intentional tracked lock\\n');\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f2.json'), JSON.stringify({ featureId: 'f2', completed: true, changedFiles: ['pyproject.toml', 'uv.lock'], commandsRun: [], assertionsAddressed: ['a2'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'intentional lock' }));\n} else if (featureId === 'f1') {\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, outcome: 'already_satisfied', evidence: ['ok'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'no change' }));\n}\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: prompt.includes('m2') ? 'm2' : 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }, { assertionId: 'a2', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-symlink-lock', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi symlink lock is executable', ['chmod', '+x', fakePiSymlinkLock], 0);
  const symlinkLockResult = expectExit('mission workflow refuses to quarantine symlink merge-blocking uv.lock', ['node', missionCli, 'activate', '--approved', '--plan-path', symlinkLockPlanPath, '--cwd', symlinkLockRepo, '--model-validator', 'stable-validator'], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiSymlinkLock }, timeout: 60_000 });
  let symlinkLockDetails;
  try { symlinkLockDetails = symlinkLockResult.stdout ? JSON.parse(symlinkLockResult.stdout) : undefined; } catch { symlinkLockDetails = undefined; }
  const symlinkAuditPath = symlinkLockDetails?.runId ? join(store, 'artifacts', symlinkLockDetails.runId, 'handoffs', 'f2-auto-cleaned-merge-blocking-transient-artifacts.json') : '';
  const symlinkAudit = symlinkAuditPath && existsSync(symlinkAuditPath) ? JSON.parse(readFileSync(symlinkAuditPath, 'utf8')) : undefined;
  log(symlinkAudit?.quarantined?.length === 0 && symlinkAudit?.skipped?.some((entry) => entry.file === 'uv.lock' && entry.reason === 'symlink'), 'merge-blocking symlink lock is audited but not read/quarantined');

  const localContractCollisionRepo = join(tmp, 'local-contract-collision-repo');
  mkdirSync(localContractCollisionRepo, { recursive: true });
  expectExit('local contract collision repo git init', ['git', 'init', '-q'], 0, { cwd: localContractCollisionRepo });
  expectExit('local contract collision repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: localContractCollisionRepo });
  expectExit('local contract collision repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: localContractCollisionRepo });
  writeFileSync(join(localContractCollisionRepo, 'README.md'), 'local contract collision\n');
  expectExit('local contract collision repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: localContractCollisionRepo });
  const localContractCollisionPlanPath = join(tmp, 'local-contract-collision-plan.json');
  writeFileSync(localContractCollisionPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'local-contract-collision-smoke', goal: 'local evidence cannot satisfy contract', cwd: localContractCollisionRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'local-contract-collision-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'f1', description: 'f1', assertions: ['risk-approval'] }] }],
    validationContract: { assertions: [{ id: 'risk-approval', description: 'risk approval assertion', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePiLocalContractCollision = join(tmp, 'fake-pi-local-contract-collision.mjs');
  writeFileSync(fakePiLocalContractCollision, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nmkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\nwriteFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: [], commandsRun: [], assertionsAddressed: [{ id: 'risk-approval', type: 'local', status: 'addressed', summary: 'local evidence must not satisfy contract coverage' }], issuesDiscovered: [], leftUndone: [], notesForValidator: 'bad local-only coverage' }));\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'should not matter', objections: [], assertionResults: [{ assertionId: 'risk-approval', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-local-contract-collision', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi local contract collision is executable', ['chmod', '+x', fakePiLocalContractCollision], 0);
  expectExit('mission workflow treats worker assertion tags as non-authoritative handoff evidence', ['node', missionCli, 'activate', '--approved', '--plan-path', localContractCollisionPlanPath, '--cwd', localContractCollisionRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiLocalContractCollision }, timeout: 60_000 });

  const commandTimeoutRepo = join(tmp, 'command-timeout-repo');
  mkdirSync(commandTimeoutRepo, { recursive: true });
  expectExit('command timeout repo git init', ['git', 'init', '-q'], 0, { cwd: commandTimeoutRepo });
  expectExit('command timeout repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: commandTimeoutRepo });
  expectExit('command timeout repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: commandTimeoutRepo });
  writeFileSync(join(commandTimeoutRepo, 'README.md'), 'command timeout\n');
  expectExit('command timeout repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: commandTimeoutRepo });
  const commandTimeoutPlanPath = join(tmp, 'command-timeout-plan.json');
  writeFileSync(commandTimeoutPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'command-timeout-smoke', goal: 'timeout validation commands', cwd: commandTimeoutRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'command-timeout-worktrees'), validationCommands: ['node -e "process.on(\\\"SIGTERM\\\",()=>process.exit(0)); require(\\\"child_process\\\").spawn(process.execPath,[\\\"-e\\\",\\\"setTimeout(()=>{},2000)\\\"],{stdio:[\\\"ignore\\\",1,2],detached:true}).unref(); setTimeout(()=>{},2000)"'], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'f1', description: 'f1', assertions: ['a1'] }] }],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePiCommandTimeout = join(tmp, 'fake-pi-command-timeout.mjs');
  writeFileSync(fakePiCommandTimeout, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nmkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\nwriteFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: [], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'ok' }));\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'validator ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-command-timeout', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi command timeout is executable', ['chmod', '+x', fakePiCommandTimeout], 0);
  const commandTimeoutResult = expectExit('mission workflow times out hanging validation command', ['node', missionCli, 'activate', '--approved', '--plan-path', commandTimeoutPlanPath, '--cwd', commandTimeoutRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiCommandTimeout, PI_MISSION_WORKFLOW_COMMAND_TIMEOUT_MS: '100ms', PI_MISSION_WORKFLOW_TERMINATION_GRACE_MS: '100ms' }, timeout: 60_000 });
  const commandTimeoutOutput = JSON.parse(commandTimeoutResult.stdout || '{}');
  const commandTimeoutReport = JSON.parse(readFileSync(join(store, 'artifacts', commandTimeoutOutput.runId, 'validation', 'm1-report.json'), 'utf8'));
  log(commandTimeoutReport.reports?.[0]?.timedOut === true && commandTimeoutReport.reports?.[0]?.exitCode === 124 && commandTimeoutReport.reports?.[0]?.passed === false, 'validation timeout reports non-zero synthetic exit code', JSON.stringify(commandTimeoutReport.reports?.[0] || {}));

  const staleBranchRepo = join(tmp, 'stale-branch-repo');
  mkdirSync(staleBranchRepo, { recursive: true });
  expectExit('stale branch repo git init', ['git', 'init', '-q'], 0, { cwd: staleBranchRepo });
  expectExit('stale branch repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: staleBranchRepo });
  expectExit('stale branch repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: staleBranchRepo });
  writeFileSync(join(staleBranchRepo, 'README.md'), 'stale branch initial\n');
  expectExit('stale branch repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: staleBranchRepo });
  expectExit('stale feature branch exists at mission head', ['git', 'branch', 'mission-feature/stale-branch-smoke/f1', 'HEAD'], 0, { cwd: staleBranchRepo });
  const staleBranchPlanPath = join(tmp, 'stale-branch-plan.json');
  writeFileSync(staleBranchPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'stale-branch-smoke', goal: 'stale branch rerun', cwd: staleBranchRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'stale-branch-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Implement stale branch feature', description: 'f1', assertions: ['a1'] }] }],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePiStaleBranch = join(tmp, 'fake-pi-stale-branch.mjs');
  writeFileSync(fakePiStaleBranch, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync, readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'README.md'), 'stale branch worker ran\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'worker ran' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-stale', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi stale branch is executable', ['chmod', '+x', fakePiStaleBranch], 0);
  expectExit('mission workflow reruns stale branch at mission head', ['node', missionCli, 'activate', '--approved', '--plan-path', staleBranchPlanPath, '--cwd', staleBranchRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiStaleBranch }, timeout: 60_000 });
  const staleReadme = expectExit('stale branch mission output contains worker changes', ['git', 'show', 'mission/stale-branch-smoke:README.md'], 0, { cwd: staleBranchRepo });
  log((staleReadme.stdout || '').includes('stale branch worker ran'), 'stale branch was not falsely skipped');

  const checkpointRepo = join(tmp, 'trusted-checkpoint-repo');
  mkdirSync(checkpointRepo, { recursive: true });
  expectExit('trusted checkpoint repo git init', ['git', 'init', '-q'], 0, { cwd: checkpointRepo });
  expectExit('trusted checkpoint repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: checkpointRepo });
  expectExit('trusted checkpoint repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: checkpointRepo });
  writeFileSync(join(checkpointRepo, 'README.md'), 'checkpoint initial\n');
  expectExit('trusted checkpoint repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: checkpointRepo });
  const checkpointWorktrees = join(tmp, 'trusted-checkpoint-worktrees');
  const checkpointIntegration = join(checkpointWorktrees, 'integration');
  const checkpointPlanPath = join(tmp, 'trusted-checkpoint-plan.json');
  writeFileSync(checkpointPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'trusted-checkpoint-smoke', goal: 'trusted checkpoint reset', cwd: checkpointRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: checkpointWorktrees, validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Checkpoint Feature One', description: 'f1', assertions: ['a1'] }, { id: 'f2', title: 'Checkpoint Feature Two', description: 'f2', assertions: ['a2'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }, { id: 'a2', description: 'a2', priority: 'must', coveredBy: ['f2'], validationMethod: 'both' }] } }, null, 2));
  const checkpointMarker = join(tmp, 'trusted-checkpoint-f2-failed');
  const fakePiCheckpoint = join(tmp, 'fake-pi-trusted-checkpoint.mjs');
  writeFileSync(fakePiCheckpoint, `#!/usr/bin/env node\nimport { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  if (prompt.includes('"id": "f1"')) {\n    appendFileSync(join(process.cwd(), 'README.md'), 'trusted f1\\n');\n    writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'f1' }));\n  } else if (!existsSync(${JSON.stringify(checkpointMarker)})) {\n    writeFileSync(${JSON.stringify(checkpointMarker)}, 'failed once');\n    writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f2.json'), JSON.stringify({ featureId: 'f2', completed: false, outcome: 'blocked', commandsRun: [], issuesDiscovered: ['synthetic failure after first trusted checkpoint'], leftUndone: ['f2'], notesForValidator: 'bad f2' }));\n  } else {\n    appendFileSync(join(process.cwd(), 'README.md'), 'trusted f2\\n');\n    writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f2.json'), JSON.stringify({ featureId: 'f2', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a2'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'f2' }));\n  }\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }, { assertionId: 'a2', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-checkpoint', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi trusted checkpoint is executable', ['chmod', '+x', fakePiCheckpoint], 0);
  expectExit('mission workflow records trusted checkpoint before later strict failure', ['node', missionCli, 'activate', '--approved', '--plan-path', checkpointPlanPath, '--cwd', checkpointRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiCheckpoint }, timeout: 60_000 });
  expectExit('trusted checkpoint integration worktree removed before resume', ['git', 'worktree', 'remove', '--force', checkpointIntegration], 0, { cwd: checkpointRepo });
  expectExit('trusted checkpoint contaminated mission branch manually', ['sh', '-c', "base=$(git branch --show-current) && git switch -q mission/trusted-checkpoint-smoke && printf 'untrusted contamination\\n' >> README.md && git add README.md && git commit -q -m 'untrusted contamination' && git switch -q $base"], 0, { cwd: checkpointRepo });
  expectExit('mission workflow resets contaminated branch to trusted checkpoint on resume', ['node', missionCli, 'resume', '--approved', '--plan-path', checkpointPlanPath, '--cwd', checkpointRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiCheckpoint }, timeout: 60_000 });
  const checkpointBackups = expectExit('trusted checkpoint reset creates backup branch', ['git', 'branch', '--list', 'mission-backup/mission-trusted-checkpoint-smoke/*'], 0, { cwd: checkpointRepo });
  log((checkpointBackups.stdout || '').includes('mission-backup/mission-trusted-checkpoint-smoke/'), 'trusted checkpoint reset preserved pre-reset branch');
  const checkpointReadme = expectExit('trusted checkpoint reset output excludes contamination', ['git', 'show', 'mission/trusted-checkpoint-smoke:README.md'], 0, { cwd: checkpointRepo });
  log((checkpointReadme.stdout || '').includes('trusted f1') && (checkpointReadme.stdout || '').includes('trusted f2') && !(checkpointReadme.stdout || '').includes('untrusted contamination'), 'trusted checkpoint reset discarded untrusted branch tail');
  const checkpointRegistry = JSON.parse(readFileSync(join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'trusted-checkpoint-smoke', 'state.json'), 'utf8'));
  log(checkpointRegistry.status === 'completed' && !checkpointRegistry.lastError && checkpointRegistry.lastResolvedError?.resolvedBy, 'mission workflow clears stale lastError after successful resume');

  const resumeCursorRepo = join(tmp, 'resume-cursor-repo');
  mkdirSync(resumeCursorRepo, { recursive: true });
  expectExit('resume cursor repo git init', ['git', 'init', '-q'], 0, { cwd: resumeCursorRepo });
  expectExit('resume cursor repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: resumeCursorRepo });
  expectExit('resume cursor repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: resumeCursorRepo });
  writeFileSync(join(resumeCursorRepo, 'README.md'), 'resume cursor initial\n');
  expectExit('resume cursor repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: resumeCursorRepo });
  const resumeCursorBase = expectExit('resume cursor base ref', ['git', 'rev-parse', 'HEAD'], 0, { cwd: resumeCursorRepo }).stdout.trim();
  const resumeCursorPlanPath = join(tmp, 'resume-cursor-plan.json');
  writeFileSync(resumeCursorPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'resume-cursor-smoke', goal: 'resume cursor hardening', cwd: resumeCursorRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: join(tmp, 'resume-cursor-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Resume Cursor Feature One', description: 'f1', assertions: ['a1'] }] }, { id: 'm2', title: 'm2', features: [{ id: 'f2', title: 'Resume Cursor Feature Two', description: 'f2', assertions: ['a2'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }, { id: 'a2', description: 'a2', priority: 'must', coveredBy: ['f2'], validationMethod: 'both' }] } }, null, 2));
  const fakePiResumeCursor = join(tmp, 'fake-pi-resume-cursor.mjs');
  writeFileSync(fakePiResumeCursor, `#!/usr/bin/env node\nimport { basename, join } from 'node:path';\nimport { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';\nconst featureId = basename(process.cwd());\nif (featureId === 'f1') {\n  appendFileSync(join(process.cwd(), 'README.md'), 'resume cursor f1 ran\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'f1' }));\n}\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: prompt.includes('m2') ? 'm2' : 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }, { assertionId: 'a2', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-resume-cursor', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi resume cursor is executable', ['chmod', '+x', fakePiResumeCursor], 0);
  expectExit('mission workflow creates passed cursor before later failure', ['node', missionCli, 'activate', '--approved', '--plan-path', resumeCursorPlanPath, '--cwd', resumeCursorRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiResumeCursor }, timeout: 60_000 });
  const resumeCursorRegistryPath = join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'resume-cursor-smoke', 'state.json');
  const resumeCursorState = JSON.parse(readFileSync(resumeCursorRegistryPath, 'utf8'));
  const resumeCursorInitialM1Reports = (resumeCursorState.validationReports || []).filter((report) => report.milestoneId === 'm1' && report.passed === true).length;
  resumeCursorState.validationReports = (resumeCursorState.validationReports || []).map((report) => report.milestoneId === 'm1' && report.passed === true ? { ...report, trustedHead: resumeCursorBase } : report);
  writeFileSync(resumeCursorRegistryPath, JSON.stringify(resumeCursorState, null, 2));
  expectExit('mission workflow ignores validation cursor whose trustedHead predates feature commits', ['node', missionCli, 'resume', '--approved', '--plan-path', resumeCursorPlanPath, '--cwd', resumeCursorRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiResumeCursor }, timeout: 60_000 });
  const resumeCursorAfter = JSON.parse(readFileSync(resumeCursorRegistryPath, 'utf8'));
  const resumeCursorAfterM1Reports = (resumeCursorAfter.validationReports || []).filter((report) => report.milestoneId === 'm1' && report.passed === true).length;
  log(resumeCursorAfterM1Reports > resumeCursorInitialM1Reports, 'invalid resume cursor did not skip milestone validation');

  const noChangeCursorRepo = join(tmp, 'no-change-cursor-repo');
  mkdirSync(noChangeCursorRepo, { recursive: true });
  expectExit('no-change cursor repo git init', ['git', 'init', '-q'], 0, { cwd: noChangeCursorRepo });
  expectExit('no-change cursor repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: noChangeCursorRepo });
  expectExit('no-change cursor repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: noChangeCursorRepo });
  writeFileSync(join(noChangeCursorRepo, 'README.md'), 'no-change cursor initial\n');
  expectExit('no-change cursor repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: noChangeCursorRepo });
  const noChangeCursorPlanPath = join(tmp, 'no-change-cursor-plan.json');
  writeFileSync(noChangeCursorPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'no-change-cursor-smoke', goal: 'no-change cursor hardening', cwd: noChangeCursorRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: join(tmp, 'no-change-cursor-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'No Change Cursor Feature', description: 'f1', assertions: ['a1'] }] }, { id: 'm2', title: 'm2', features: [{ id: 'f2', title: 'Failing Followup Feature', description: 'f2', assertions: ['a2'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }, { id: 'a2', description: 'a2', priority: 'must', coveredBy: ['f2'], validationMethod: 'both' }] } }, null, 2));
  const noChangeResumeMarker = join(tmp, 'no-change-cursor-resume-marker');
  const fakePiNoChangeCursor = join(tmp, 'fake-pi-no-change-cursor.mjs');
  writeFileSync(fakePiNoChangeCursor, `#!/usr/bin/env node\nimport { basename, join } from 'node:path';\nimport { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';\nconst featureId = basename(process.cwd());\nif (featureId === 'f1') {\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  if (existsSync(${JSON.stringify(noChangeResumeMarker)})) appendFileSync(join(process.cwd(), 'README.md'), 'no-change f1 reran on resume\\n');\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, outcome: 'already_satisfied', evidence: ['already satisfied'], commandsRun: [], issuesDiscovered: [], leftUndone: [], notesForValidator: 'no assertion ids on purpose' }));\n} else if (featureId === 'f2') {\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f2.json'), JSON.stringify({ featureId: 'f2', completed: false, outcome: 'blocked', commandsRun: [], issuesDiscovered: ['synthetic failure'], leftUndone: ['f2'], notesForValidator: 'fail' }));\n}\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: prompt.includes('m2') ? 'm2' : 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }, { assertionId: 'a2', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-no-change-cursor', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi no-change cursor is executable', ['chmod', '+x', fakePiNoChangeCursor], 0);
  expectExit('mission workflow records no-change passed cursor before later failure', ['node', missionCli, 'activate', '--approved', '--plan-path', noChangeCursorPlanPath, '--cwd', noChangeCursorRepo, '--model-validator', 'stable-validator'], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiNoChangeCursor }, timeout: 60_000 });
  writeFileSync(noChangeResumeMarker, 'resume');
  expectExit('mission workflow skips no-change milestone via trusted cursor', ['node', missionCli, 'resume', '--approved', '--plan-path', noChangeCursorPlanPath, '--cwd', noChangeCursorRepo, '--model-validator', 'stable-validator'], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiNoChangeCursor }, timeout: 60_000 });
  const noChangeCursorReadme = expectExit('no-change cursor resume did not rerun f1', ['git', 'show', 'mission/no-change-cursor-smoke:README.md'], 0, { cwd: noChangeCursorRepo });
  log(!(noChangeCursorReadme.stdout || '').includes('no-change f1 reran on resume'), 'trusted cursor skipped no-change feature with omitted worker assertion tags');
  const noChangeChangedValidationPlanPath = join(tmp, 'no-change-cursor-changed-validation-plan.json');
  writeFileSync(noChangeChangedValidationPlanPath, JSON.stringify({ ...JSON.parse(readFileSync(noChangeCursorPlanPath, 'utf8')), validationCommands: ['true'] }, null, 2));
  const noChangeReportsBeforeChangedValidation = (JSON.parse(readFileSync(join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'no-change-cursor-smoke', 'state.json'), 'utf8')).validationReports || []).filter((report) => report.milestoneId === 'm1').length;
  expectExit('mission workflow invalidates trusted cursor when validation commands change', ['node', missionCli, 'resume', '--approved', '--plan-path', noChangeChangedValidationPlanPath, '--cwd', noChangeCursorRepo, '--model-validator', 'stable-validator'], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiNoChangeCursor }, timeout: 60_000 });
  const noChangeReportsAfterChangedValidation = (JSON.parse(readFileSync(join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'no-change-cursor-smoke', 'state.json'), 'utf8')).validationReports || []).filter((report) => report.milestoneId === 'm1').length;
  log(noChangeReportsAfterChangedValidation > noChangeReportsBeforeChangedValidation, 'validation command changes invalidate milestone resume cursor');
  const noChangeChangedGoalPlanPath = join(tmp, 'no-change-cursor-changed-goal-plan.json');
  writeFileSync(noChangeChangedGoalPlanPath, JSON.stringify({ ...JSON.parse(readFileSync(noChangeChangedValidationPlanPath, 'utf8')), goal: 'changed no-change cursor validation context' }, null, 2));
  expectExit('mission workflow invalidates trusted cursor when goal changes', ['node', missionCli, 'resume', '--approved', '--plan-path', noChangeChangedGoalPlanPath, '--cwd', noChangeCursorRepo, '--model-validator', 'stable-validator'], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiNoChangeCursor }, timeout: 60_000 });
  const noChangeReportsAfterChangedGoal = (JSON.parse(readFileSync(join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'no-change-cursor-smoke', 'state.json'), 'utf8')).validationReports || []).filter((report) => report.milestoneId === 'm1').length;
  log(noChangeReportsAfterChangedGoal > noChangeReportsAfterChangedValidation, 'goal changes invalidate milestone resume cursor');

  const mockModeCursorRepo = join(tmp, 'mock-mode-cursor-repo');
  mkdirSync(mockModeCursorRepo, { recursive: true });
  expectExit('mock-mode cursor repo git init', ['git', 'init', '-q'], 0, { cwd: mockModeCursorRepo });
  expectExit('mock-mode cursor repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: mockModeCursorRepo });
  expectExit('mock-mode cursor repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: mockModeCursorRepo });
  writeFileSync(join(mockModeCursorRepo, 'README.md'), 'mock mode cursor initial\n');
  expectExit('mock-mode cursor repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: mockModeCursorRepo });
  const mockModeCounter = join(tmp, 'mock-mode-validation-count');
  const mockModeCounterScript = join(tmp, 'mock-mode-validation-count.mjs');
  writeFileSync(mockModeCounterScript, `import { existsSync, readFileSync, writeFileSync } from 'node:fs';\nconst p = ${JSON.stringify(mockModeCounter)};\nconst n = (existsSync(p) ? Number(readFileSync(p, 'utf8')) : 0) + 1;\nwriteFileSync(p, String(n));\nprocess.exit(n === 1 ? 0 : 1);\n`);
  const mockModeCommand = `node ${JSON.stringify(mockModeCounterScript)}`;
  const mockModePlanPath = join(tmp, 'mock-mode-cursor-plan.json');
  writeFileSync(mockModePlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'mock-mode-cursor-smoke', goal: 'mock mode cursor hardening', cwd: mockModeCursorRepo, baseRef: 'HEAD', planner: 'mock', maxRepairIterations: 1, worktreeBaseDir: join(tmp, 'mock-mode-cursor-worktrees'), validationCommands: [mockModeCommand], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Mock Mode Cursor Feature One', description: 'f1', assertions: ['a1'] }] }, { id: 'm2', title: 'm2', features: [{ id: 'f2', title: 'Mock Mode Cursor Feature Two', description: 'f2', assertions: ['a2'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }, { id: 'a2', description: 'a2', priority: 'must', coveredBy: ['f2'], validationMethod: 'both' }] } }, null, 2));
  expectExit('mission workflow creates mock-mode passed cursor before later failure', ['node', missionCli, 'activate', '--approved', '--plan-path', mockModePlanPath, '--cwd', mockModeCursorRepo], 1, { timeout: 60_000 });
  const mockModeRegistryPath = join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'mock-mode-cursor-smoke', 'state.json');
  const mockModeInitialReports = (JSON.parse(readFileSync(mockModeRegistryPath, 'utf8')).validationReports || []).filter((report) => report.milestoneId === 'm1' && report.passed === true);
  log(mockModeInitialReports.length === 1, 'mock-mode setup created a passed m1 cursor');
  const mockModePiPlanPath = join(tmp, 'mock-mode-cursor-pi-plan.json');
  writeFileSync(mockModePiPlanPath, JSON.stringify({ ...JSON.parse(readFileSync(mockModePlanPath, 'utf8')), planner: 'pi' }, null, 2));
  const fakePiMockModeCursor = join(tmp, 'fake-pi-mock-mode-cursor.mjs');
  writeFileSync(fakePiMockModeCursor, `#!/usr/bin/env node\nimport { basename, join } from 'node:path';\nimport { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';\nconst featureId = basename(process.cwd());\nif (featureId === 'f1') {\n  appendFileSync(join(process.cwd(), 'README.md'), 'mock-mode f1 reran under pi\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'reran under pi' }));\n}\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: prompt.includes('m2') ? 'm2' : 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }, { assertionId: 'a2', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-mock-mode-cursor', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi mock-mode cursor is executable', ['chmod', '+x', fakePiMockModeCursor], 0);
  const mockModeReportsBeforePi = (JSON.parse(readFileSync(mockModeRegistryPath, 'utf8')).validationReports || []).filter((report) => report.milestoneId === 'm1').length;
  expectExit('mission workflow invalidates mock validator cursor under pi planner', ['node', missionCli, 'resume', '--approved', '--plan-path', mockModePiPlanPath, '--cwd', mockModeCursorRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiMockModeCursor }, timeout: 60_000 });
  const mockModeReportsAfterPi = (JSON.parse(readFileSync(mockModeRegistryPath, 'utf8')).validationReports || []).filter((report) => report.milestoneId === 'm1').length;
  log(mockModeReportsAfterPi > mockModeReportsBeforePi, 'mock planner validation cursors are not reused under pi planner');

  const completedHeadRepo = join(tmp, 'completed-head-repo');
  mkdirSync(completedHeadRepo, { recursive: true });
  expectExit('completed head repo git init', ['git', 'init', '-q'], 0, { cwd: completedHeadRepo });
  expectExit('completed head repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: completedHeadRepo });
  expectExit('completed head repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: completedHeadRepo });
  writeFileSync(join(completedHeadRepo, 'README.md'), 'completed head initial\n');
  expectExit('completed head repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: completedHeadRepo });
  const completedHeadFingerprint = featureFingerprint({ milestoneId: 'm1', featureId: 'f1', title: 'Done\nFeature', description: 'f1', assertions: ['a1'], localAssertions: [], contractAssertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] });
  expectExit('completed head mission branch with feature commit', ['sh', '-c', `base=$(git branch --show-current) && git switch -q -c mission/completed-head-smoke && printf 'already completed feature\\n' > README.md && git add README.md && git commit -q -m 'mission(completed-head-smoke): Done Feature' -m 'Mission-Feature-Id: f1
Mission-Feature-Fingerprint: ${completedHeadFingerprint}' && git branch mission-feature/completed-head-smoke/f1 HEAD && git switch -q $base`], 0, { cwd: completedHeadRepo });
  const completedHeadWorktrees = join(tmp, 'completed-head-worktrees');
  mkdirSync(completedHeadWorktrees, { recursive: true });
  expectExit('completed head integration worktree exists', ['git', 'worktree', 'add', '-q', join(completedHeadWorktrees, 'integration'), 'mission/completed-head-smoke'], 0, { cwd: completedHeadRepo });
  const completedHeadPlanPath = join(tmp, 'completed-head-plan.json');
  writeFileSync(completedHeadPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'completed-head-smoke', goal: 'completed head skip', cwd: completedHeadRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: completedHeadWorktrees, validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Done\nFeature', description: 'f1', assertions: ['a1'] }] }],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePiCompletedHead = join(tmp, 'fake-pi-completed-head.mjs');
  writeFileSync(fakePiCompletedHead, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'README.md'), 'reran completed feature\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'reran' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-completed-head', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi completed head is executable', ['chmod', '+x', fakePiCompletedHead], 0);
  expectExit('mission workflow skips branch-only completed head feature', ['node', missionCli, 'resume', '--approved', '--plan-path', completedHeadPlanPath, '--cwd', completedHeadRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiCompletedHead }, timeout: 60_000 });
  const completedHeadReadme = expectExit('completed head mission output remains original feature commit', ['git', 'show', 'mission/completed-head-smoke:README.md'], 0, { cwd: completedHeadRepo });
  log((completedHeadReadme.stdout || '').includes('already completed feature') && !(completedHeadReadme.stdout || '').includes('reran completed feature'), 'completed branch at mission head was skipped without registry');

  const trustedCommitRepo = join(tmp, 'trusted-commit-repo');
  mkdirSync(trustedCommitRepo, { recursive: true });
  expectExit('trusted commit repo git init', ['git', 'init', '-q'], 0, { cwd: trustedCommitRepo });
  expectExit('trusted commit repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: trustedCommitRepo });
  expectExit('trusted commit repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: trustedCommitRepo });
  writeFileSync(join(trustedCommitRepo, 'README.md'), 'trusted commit initial\n');
  expectExit('trusted commit repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: trustedCommitRepo });
  const trustedCommitFingerprint = featureFingerprint({ milestoneId: 'm1', featureId: 'f1', title: 'Trusted Commit Feature', description: 'f1', assertions: ['a1'], localAssertions: [], contractAssertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] });
  expectExit('trusted commit mission branch without feature branch', ['sh', '-c', `base=$(git branch --show-current) && git switch -q -c mission/trusted-commit-smoke && printf 'trusted branch commit feature\n' > README.md && git add README.md && git commit -q -m 'mission(trusted-commit-smoke): Trusted Commit Feature' -m 'Mission-Feature-Id: f1
Mission-Feature-Fingerprint: ${trustedCommitFingerprint}' && git switch -q $base`], 0, { cwd: trustedCommitRepo });
  const trustedCommitWorktrees = join(tmp, 'trusted-commit-worktrees');
  mkdirSync(trustedCommitWorktrees, { recursive: true });
  expectExit('trusted commit integration worktree exists', ['git', 'worktree', 'add', '-q', join(trustedCommitWorktrees, 'integration'), 'mission/trusted-commit-smoke'], 0, { cwd: trustedCommitRepo });
  const trustedCommitPlanPath = join(tmp, 'trusted-commit-plan.json');
  writeFileSync(trustedCommitPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'trusted-commit-smoke', goal: 'trusted commit skip', cwd: trustedCommitRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: trustedCommitWorktrees, validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Trusted Commit Feature', description: 'f1', assertions: ['a1'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] } }, null, 2));
  const fakePiTrustedCommit = join(tmp, 'fake-pi-trusted-commit.mjs');
  writeFileSync(fakePiTrustedCommit, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'README.md'), 'reran trusted commit feature\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'reran' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-trusted-commit', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi trusted commit is executable', ['chmod', '+x', fakePiTrustedCommit], 0);
  expectExit('mission workflow skips trusted branch commit without feature branch', ['node', missionCli, 'resume', '--approved', '--plan-path', trustedCommitPlanPath, '--cwd', trustedCommitRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiTrustedCommit }, timeout: 60_000 });
  const trustedCommitReadme = expectExit('trusted commit mission output remains original feature commit', ['git', 'show', 'mission/trusted-commit-smoke:README.md'], 0, { cwd: trustedCommitRepo });
  log((trustedCommitReadme.stdout || '').includes('trusted branch commit feature') && !(trustedCommitReadme.stdout || '').includes('reran trusted commit feature'), 'trusted branch commit without feature branch was reused');
  const completedRegistryPath = join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'completed-head-smoke', 'state.json');
  const completedRegistryBeforeBadPlan = existsSync(completedRegistryPath) ? JSON.parse(readFileSync(completedRegistryPath, 'utf8')) : undefined;

  const contractDriftRepo = join(tmp, 'contract-drift-repo');
  mkdirSync(contractDriftRepo, { recursive: true });
  expectExit('contract drift repo git init', ['git', 'init', '-q'], 0, { cwd: contractDriftRepo });
  expectExit('contract drift repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: contractDriftRepo });
  expectExit('contract drift repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: contractDriftRepo });
  writeFileSync(join(contractDriftRepo, 'README.md'), 'contract drift initial\n');
  expectExit('contract drift repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: contractDriftRepo });
  const oldContractFingerprint = featureFingerprint({ milestoneId: 'm1', featureId: 'f1', title: 'Contract Drift Feature', description: 'f1', assertions: ['a1'], localAssertions: [], contractAssertions: [{ id: 'a1', description: 'old contract meaning', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] });
  expectExit('contract drift branch has old fingerprint', ['sh', '-c', `base=$(git branch --show-current) && git switch -q -c mission/contract-drift-smoke && printf 'old contract feature\\n' > README.md && git add README.md && git commit -q -m 'mission(contract-drift-smoke): Contract Drift Feature' -m 'Mission-Feature-Id: f1
Mission-Feature-Fingerprint: ${oldContractFingerprint}' && git branch mission-feature/contract-drift-smoke/f1 HEAD && git switch -q $base`], 0, { cwd: contractDriftRepo });
  const contractDriftWorktrees = join(tmp, 'contract-drift-worktrees');
  expectExit('contract drift integration worktree exists', ['git', 'worktree', 'add', '-q', join(contractDriftWorktrees, 'integration'), 'mission/contract-drift-smoke'], 0, { cwd: contractDriftRepo });
  const contractDriftPlanPath = join(tmp, 'contract-drift-plan.json');
  writeFileSync(contractDriftPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'contract-drift-smoke', goal: 'contract drift rerun', cwd: contractDriftRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: contractDriftWorktrees, validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Contract Drift Feature', description: 'f1', assertions: ['a1'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'new contract meaning', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] } }, null, 2));
  const fakePiContractDrift = join(tmp, 'fake-pi-contract-drift.mjs');
  writeFileSync(fakePiContractDrift, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'README.md'), 'reran contract drift feature\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'reran' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-contract-drift', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi contract drift is executable', ['chmod', '+x', fakePiContractDrift], 0);
  expectExit('mission workflow reruns old fingerprint after contract description changes', ['node', missionCli, 'resume', '--approved', '--plan-path', contractDriftPlanPath, '--cwd', contractDriftRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiContractDrift }, timeout: 60_000 });
  const contractDriftReadme = expectExit('contract drift mission output contains rerun changes', ['git', 'show', 'mission/contract-drift-smoke:README.md'], 0, { cwd: contractDriftRepo });
  log((contractDriftReadme.stdout || '').includes('reran contract drift feature'), 'fingerprinted branch reran after validation contract description changed');

  const registryDriftRepo = join(tmp, 'registry-drift-repo');
  mkdirSync(registryDriftRepo, { recursive: true });
  expectExit('registry drift repo git init', ['git', 'init', '-q'], 0, { cwd: registryDriftRepo });
  expectExit('registry drift repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: registryDriftRepo });
  expectExit('registry drift repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: registryDriftRepo });
  writeFileSync(join(registryDriftRepo, 'README.md'), 'registry drift initial\n');
  expectExit('registry drift repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: registryDriftRepo });
  const registryDriftOldFingerprint = featureFingerprint({ milestoneId: 'm1', featureId: 'f1', title: 'Registry Drift Feature', description: 'f1', assertions: ['a1'], localAssertions: [], contractAssertions: [{ id: 'a1', description: 'old registry contract', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] });
  expectExit('registry drift mission branch has old fingerprint', ['sh', '-c', `base=$(git branch --show-current) && git switch -q -c mission/registry-drift-smoke && printf 'old registry feature\n' > README.md && git add README.md && git commit -q -m 'mission(registry-drift-smoke): Registry Drift Feature' -m 'Mission-Feature-Id: f1
Mission-Feature-Fingerprint: ${registryDriftOldFingerprint}' && git branch mission-feature/registry-drift-smoke/f1 HEAD && git switch -q $base`], 0, { cwd: registryDriftRepo });
  const registryDriftWorktrees = join(tmp, 'registry-drift-worktrees');
  expectExit('registry drift integration worktree exists', ['git', 'worktree', 'add', '-q', join(registryDriftWorktrees, 'integration'), 'mission/registry-drift-smoke'], 0, { cwd: registryDriftRepo });
  const registryDriftPlanPath = join(tmp, 'registry-drift-plan.json');
  writeFileSync(registryDriftPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'registry-drift-smoke', goal: 'registry drift contamination', cwd: registryDriftRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: registryDriftWorktrees, validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Registry Drift Feature', description: 'f1', assertions: ['a1'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'new registry contract', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] } }, null, 2));
  const registryDriftRegistryDir = join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'registry-drift-smoke');
  mkdirSync(registryDriftRegistryDir, { recursive: true });
  const registryDriftCommit = expectExit('registry drift old commit ref', ['git', 'rev-parse', 'mission/registry-drift-smoke'], 0, { cwd: registryDriftRepo }).stdout.trim();
  writeFileSync(join(registryDriftRegistryDir, 'state.json'), JSON.stringify({ schema: 'pi-mission-workflow/registry/v1', missionId: 'registry-drift-smoke', status: 'running', completedFeatures: [{ featureId: 'f1', milestoneId: 'm1', branch: 'mission-feature/registry-drift-smoke/f1', commit: registryDriftCommit, changedFiles: ['README.md'], assertions: ['a1'], localAssertions: [], assignedAssertions: ['a1'], assignedLocalAssertions: [], featureFingerprint: registryDriftOldFingerprint }] }, null, 2));
  expectExit('mission workflow rejects registry commit with stale fingerprint under current plan', ['node', missionCli, 'resume', '--approved', '--plan-path', registryDriftPlanPath, '--cwd', registryDriftRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiContractDrift }, timeout: 60_000 });

  const badCompletedPlanPath = join(tmp, 'completed-head-bad-plan.json');
  writeFileSync(badCompletedPlanPath, JSON.stringify({ ...JSON.parse(readFileSync(completedHeadPlanPath, 'utf8')), goal: 'bad replacement goal', validationContract: { assertions: [{ id: 'bad', description: 'bad', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] } }, null, 2));
  expectExit('completed registry later activate failure', ['node', missionCli, 'activate', '--approved', '--plan-path', badCompletedPlanPath, '--cwd', completedHeadRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiCompletedHead }, timeout: 60_000 });
  const completedRegistry = existsSync(completedRegistryPath) ? JSON.parse(readFileSync(completedRegistryPath, 'utf8')) : undefined;
  const completedRegistryPlanCopy = existsSync(join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'completed-head-smoke', 'mission-plan.json')) ? JSON.parse(readFileSync(join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'completed-head-smoke', 'mission-plan.json'), 'utf8')) : undefined;
  log(completedRegistry?.status === 'completed' && completedRegistry?.lastFailedAttempt && completedRegistry?.goal === completedRegistryBeforeBadPlan?.goal && completedRegistry?.planPath === completedRegistryBeforeBadPlan?.planPath && completedRegistryPlanCopy?.goal === completedRegistryBeforeBadPlan?.goal, 'completed registry is not downgraded or overwritten by later failed invocation', completedRegistry?.status || 'missing registry');

  const legacyTrailerRepo = join(tmp, 'legacy-trailer-repo');
  mkdirSync(legacyTrailerRepo, { recursive: true });
  expectExit('legacy trailer repo git init', ['git', 'init', '-q'], 0, { cwd: legacyTrailerRepo });
  expectExit('legacy trailer repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: legacyTrailerRepo });
  expectExit('legacy trailer repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: legacyTrailerRepo });
  writeFileSync(join(legacyTrailerRepo, 'README.md'), 'legacy trailer initial\n');
  expectExit('legacy trailer repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: legacyTrailerRepo });
  expectExit('legacy trailer mission branch with feature-id-only commit', ['sh', '-c', "base=$(git branch --show-current) && git switch -q -c mission/legacy-trailer-smoke && printf 'legacy feature id only\\n' > README.md && git add README.md && git commit -q -m 'mission(legacy-trailer-smoke): Legacy Trailer Feature' -m 'Mission-Feature-Id: f1' && git branch mission-feature/legacy-trailer-smoke/f1 HEAD && git switch -q $base"], 0, { cwd: legacyTrailerRepo });
  const legacyTrailerWorktrees = join(tmp, 'legacy-trailer-worktrees');
  expectExit('legacy trailer integration worktree exists', ['git', 'worktree', 'add', '-q', join(legacyTrailerWorktrees, 'integration'), 'mission/legacy-trailer-smoke'], 0, { cwd: legacyTrailerRepo });
  const legacyTrailerPlanPath = join(tmp, 'legacy-trailer-plan.json');
  writeFileSync(legacyTrailerPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'legacy-trailer-smoke', goal: 'legacy trailer skip', cwd: legacyTrailerRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: legacyTrailerWorktrees, validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Legacy Trailer Feature', description: 'f1', assertions: ['a1'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] } }, null, 2));
  const fakePiLegacyTrailer = join(tmp, 'fake-pi-legacy-trailer.mjs');
  writeFileSync(fakePiLegacyTrailer, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'README.md'), 'reran legacy trailer feature\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'reran' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-legacy-trailer', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi legacy trailer is executable', ['chmod', '+x', fakePiLegacyTrailer], 0);
  expectExit('mission workflow reruns branch-only feature-id legacy commit without fingerprint', ['node', missionCli, 'resume', '--approved', '--plan-path', legacyTrailerPlanPath, '--cwd', legacyTrailerRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiLegacyTrailer }, timeout: 60_000 });
  const legacyTrailerReadme = expectExit('legacy trailer mission output contains rerun changes', ['git', 'show', 'mission/legacy-trailer-smoke:README.md'], 0, { cwd: legacyTrailerRepo });
  log((legacyTrailerReadme.stdout || '').includes('reran legacy trailer feature'), 'branch-only feature-id legacy commit without fingerprint was not trusted');

  const sameSubjectRepo = join(tmp, 'same-subject-repo');
  mkdirSync(sameSubjectRepo, { recursive: true });
  expectExit('same subject repo git init', ['git', 'init', '-q'], 0, { cwd: sameSubjectRepo });
  expectExit('same subject repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: sameSubjectRepo });
  expectExit('same subject repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: sameSubjectRepo });
  writeFileSync(join(sameSubjectRepo, 'README.md'), 'same subject initial\n');
  expectExit('same subject repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: sameSubjectRepo });
  expectExit('same subject branch lacks feature trailer', ['sh', '-c', "base=$(git branch --show-current) && git switch -q -c mission/same-subject-smoke && printf 'wrong same subject commit\\n' > README.md && git add README.md && git commit -q -m 'mission(same-subject-smoke): Shared Title' && git branch mission-feature/same-subject-smoke/f1 HEAD && git switch -q $base"], 0, { cwd: sameSubjectRepo });
  const sameSubjectWorktrees = join(tmp, 'same-subject-worktrees');
  mkdirSync(sameSubjectWorktrees, { recursive: true });
  expectExit('same subject integration worktree exists', ['git', 'worktree', 'add', '-q', join(sameSubjectWorktrees, 'integration'), 'mission/same-subject-smoke'], 0, { cwd: sameSubjectRepo });
  const sameSubjectPlanPath = join(tmp, 'same-subject-plan.json');
  writeFileSync(sameSubjectPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'same-subject-smoke', goal: 'same subject rerun', cwd: sameSubjectRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: sameSubjectWorktrees, validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Shared Title', description: 'f1', assertions: ['a1'] }] }],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePiSameSubject = join(tmp, 'fake-pi-same-subject.mjs');
  writeFileSync(fakePiSameSubject, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'README.md'), 'reran same subject feature\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'reran' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-same-subject', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi same subject is executable', ['chmod', '+x', fakePiSameSubject], 0);
  expectExit('mission workflow reruns same-subject branch without feature trailer', ['node', missionCli, 'resume', '--approved', '--plan-path', sameSubjectPlanPath, '--cwd', sameSubjectRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiSameSubject }, timeout: 60_000 });
  const sameSubjectReadme = expectExit('same subject mission output contains rerun changes', ['git', 'show', 'mission/same-subject-smoke:README.md'], 0, { cwd: sameSubjectRepo });
  log((sameSubjectReadme.stdout || '').includes('reran same subject feature'), 'same-subject branch without feature trailer was not falsely skipped');

  const legacySkippedRepo = join(tmp, 'legacy-skipped-repo');
  mkdirSync(legacySkippedRepo, { recursive: true });
  expectExit('legacy skipped repo git init', ['git', 'init', '-q'], 0, { cwd: legacySkippedRepo });
  expectExit('legacy skipped repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: legacySkippedRepo });
  expectExit('legacy skipped repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: legacySkippedRepo });
  writeFileSync(join(legacySkippedRepo, 'README.md'), 'legacy initial\n');
  expectExit('legacy skipped repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: legacySkippedRepo });
  expectExit('legacy skipped stale branch at mission head', ['sh', '-c', 'git branch mission/legacy-skipped-smoke HEAD && git branch mission-feature/legacy-skipped-smoke/f1 HEAD'], 0, { cwd: legacySkippedRepo });
  const legacySkippedWorktrees = join(tmp, 'legacy-skipped-worktrees');
  expectExit('legacy skipped integration worktree exists', ['git', 'worktree', 'add', '-q', join(legacySkippedWorktrees, 'integration'), 'mission/legacy-skipped-smoke'], 0, { cwd: legacySkippedRepo });
  const legacySkippedPlanPath = join(tmp, 'legacy-skipped-plan.json');
  writeFileSync(legacySkippedPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'legacy-skipped-smoke', goal: 'legacy skipped rerun', cwd: legacySkippedRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: legacySkippedWorktrees, validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Legacy Feature', description: 'f1', assertions: ['a1'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] } }, null, 2));
  const legacyRegistryDir = join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'legacy-skipped-smoke');
  mkdirSync(legacyRegistryDir, { recursive: true });
  writeFileSync(join(legacyRegistryDir, 'state.json'), JSON.stringify({ schema: 'pi-mission-workflow/registry/v1', missionId: 'legacy-skipped-smoke', status: 'running', completedFeatures: [{ featureId: 'f1', branch: 'mission-feature/legacy-skipped-smoke/f1', skipped: true }] }, null, 2));
  const fakePiLegacySkipped = join(tmp, 'fake-pi-legacy-skipped.mjs');
  writeFileSync(fakePiLegacySkipped, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'README.md'), 'reran legacy skipped feature\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'reran' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-legacy-skipped', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi legacy skipped is executable', ['chmod', '+x', fakePiLegacySkipped], 0);
  expectExit('mission workflow ignores stale legacy skipped registry record', ['node', missionCli, 'resume', '--approved', '--plan-path', legacySkippedPlanPath, '--cwd', legacySkippedRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiLegacySkipped }, timeout: 60_000 });
  const legacySkippedReadme = expectExit('legacy skipped mission output contains rerun changes', ['git', 'show', 'mission/legacy-skipped-smoke:README.md'], 0, { cwd: legacySkippedRepo });
  log((legacySkippedReadme.stdout || '').includes('reran legacy skipped feature'), 'legacy skipped record at mission head was not falsely trusted');

  const legacyCompletedRepo = join(tmp, 'legacy-completed-repo');
  mkdirSync(legacyCompletedRepo, { recursive: true });
  expectExit('legacy completed repo git init', ['git', 'init', '-q'], 0, { cwd: legacyCompletedRepo });
  expectExit('legacy completed repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: legacyCompletedRepo });
  expectExit('legacy completed repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: legacyCompletedRepo });
  writeFileSync(join(legacyCompletedRepo, 'README.md'), 'legacy completed initial\n');
  expectExit('legacy completed repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: legacyCompletedRepo });
  expectExit('legacy completed no-change branch behind mission head', ['sh', '-c', "base=$(git branch --show-current) && git branch mission/legacy-completed-smoke HEAD && git branch mission-feature/legacy-completed-smoke/f1 HEAD && git switch -q mission/legacy-completed-smoke && printf 'later mission commit\\n' >> README.md && git add README.md && git commit -q -m 'later mission work' && git switch -q $base"], 0, { cwd: legacyCompletedRepo });
  const legacyCompletedWorktrees = join(tmp, 'legacy-completed-worktrees');
  expectExit('legacy completed integration worktree exists', ['git', 'worktree', 'add', '-q', join(legacyCompletedWorktrees, 'integration'), 'mission/legacy-completed-smoke'], 0, { cwd: legacyCompletedRepo });
  const legacyCompletedPlanPath = join(tmp, 'legacy-completed-plan.json');
  writeFileSync(legacyCompletedPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'legacy-completed-smoke', goal: 'legacy completed skip', cwd: legacyCompletedRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: legacyCompletedWorktrees, validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Legacy Completed Feature', description: 'f1', assertions: ['a1'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] } }, null, 2));
  const legacyCompletedRegistryDir = join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'legacy-completed-smoke');
  mkdirSync(legacyCompletedRegistryDir, { recursive: true });
  const legacyCompletedHandoff = join(tmp, 'legacy-completed-handoff.json');
  writeFileSync(legacyCompletedHandoff, JSON.stringify({ featureId: 'f1', completed: true, changedFiles: [], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'legacy no-change handoff' }));
  writeFileSync(join(legacyCompletedRegistryDir, 'state.json'), JSON.stringify({ schema: 'pi-mission-workflow/registry/v1', missionId: 'legacy-completed-smoke', status: 'running', completedFeatures: [{ featureId: 'f1', milestoneId: 'm1', branch: 'mission-feature/legacy-completed-smoke/f1', assertions: ['a1'], localAssertions: [], handoffArtifact: legacyCompletedHandoff, skipped: true }] }, null, 2));
  const fakePiLegacyCompleted = join(tmp, 'fake-pi-legacy-completed.mjs');
  writeFileSync(fakePiLegacyCompleted, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'README.md'), 'reran legacy completed feature\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'reran' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-legacy-completed', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi legacy completed is executable', ['chmod', '+x', fakePiLegacyCompleted], 0);
  expectExit('mission workflow rejects contaminated branch with legacy no-change registry evidence', ['node', missionCli, 'resume', '--approved', '--plan-path', legacyCompletedPlanPath, '--cwd', legacyCompletedRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiLegacyCompleted }, timeout: 60_000 });
  const legacyCompletedAfterReject = JSON.parse(readFileSync(join(legacyCompletedRegistryDir, 'state.json'), 'utf8'));
  log(legacyCompletedAfterReject?.status === 'failed', 'contaminated legacy branch is blocked before trusting no-change evidence');

  const extraHandoffRepo = join(tmp, 'extra-handoff-repo');
  mkdirSync(extraHandoffRepo, { recursive: true });
  expectExit('extra handoff repo git init', ['git', 'init', '-q'], 0, { cwd: extraHandoffRepo });
  expectExit('extra handoff repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: extraHandoffRepo });
  expectExit('extra handoff repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: extraHandoffRepo });
  writeFileSync(join(extraHandoffRepo, 'README.md'), 'extra handoff initial\n');
  expectExit('extra handoff repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: extraHandoffRepo });
  expectExit('extra handoff no-change branch exists', ['sh', '-c', 'git branch mission/extra-handoff-smoke HEAD && git branch mission-feature/extra-handoff-smoke/f1 HEAD'], 0, { cwd: extraHandoffRepo });
  const extraHandoffWorktrees = join(tmp, 'extra-handoff-worktrees');
  expectExit('extra handoff integration worktree exists', ['git', 'worktree', 'add', '-q', join(extraHandoffWorktrees, 'integration'), 'mission/extra-handoff-smoke'], 0, { cwd: extraHandoffRepo });
  const extraHandoffPlanPath = join(tmp, 'extra-handoff-plan.json');
  writeFileSync(extraHandoffPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'extra-handoff-smoke', goal: 'extra handoff assertion rerun', cwd: extraHandoffRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: extraHandoffWorktrees, validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Extra Handoff Feature', description: 'f1', assertions: ['a1'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }, { id: 'a2', description: 'unassigned to f1', priority: 'should', coveredBy: ['other'], validationMethod: 'validator' }] } }, null, 2));
  const extraHandoffRegistryDir = join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'extra-handoff-smoke');
  mkdirSync(extraHandoffRegistryDir, { recursive: true });
  const extraHandoffArtifact = join(tmp, 'extra-handoff-artifact.json');
  writeFileSync(extraHandoffArtifact, JSON.stringify({ featureId: 'f1', completed: true, changedFiles: [], commandsRun: [], assertionsAddressed: ['a1', 'a2'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'extra assertion should not be trusted' }));
  writeFileSync(join(extraHandoffRegistryDir, 'state.json'), JSON.stringify({ schema: 'pi-mission-workflow/registry/v1', missionId: 'extra-handoff-smoke', status: 'running', completedFeatures: [{ featureId: 'f1', milestoneId: 'm1', branch: 'mission-feature/extra-handoff-smoke/f1', assertions: ['a1'], localAssertions: [], handoffArtifact: extraHandoffArtifact, skipped: true }] }, null, 2));
  const fakePiExtraHandoff = join(tmp, 'fake-pi-extra-handoff.mjs');
  writeFileSync(fakePiExtraHandoff, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'README.md'), 'reran extra assertion handoff feature\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'reran' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-extra-handoff', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi extra handoff is executable', ['chmod', '+x', fakePiExtraHandoff], 0);
  expectExit('mission workflow rejects no-change handoff with unassigned assertion', ['node', missionCli, 'resume', '--approved', '--plan-path', extraHandoffPlanPath, '--cwd', extraHandoffRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiExtraHandoff }, timeout: 60_000 });
  const extraHandoffReadme = expectExit('extra handoff mission output contains rerun changes', ['git', 'show', 'mission/extra-handoff-smoke:README.md'], 0, { cwd: extraHandoffRepo });
  log((extraHandoffReadme.stdout || '').includes('reran extra assertion handoff feature'), 'no-change handoff with unassigned assertion was not trusted');

  const legacyLocalMismatchRepo = join(tmp, 'legacy-local-mismatch-repo');
  mkdirSync(legacyLocalMismatchRepo, { recursive: true });
  expectExit('legacy local mismatch repo git init', ['git', 'init', '-q'], 0, { cwd: legacyLocalMismatchRepo });
  expectExit('legacy local mismatch repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: legacyLocalMismatchRepo });
  expectExit('legacy local mismatch repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: legacyLocalMismatchRepo });
  writeFileSync(join(legacyLocalMismatchRepo, 'README.md'), 'legacy local initial\n');
  expectExit('legacy local mismatch repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: legacyLocalMismatchRepo });
  expectExit('legacy local mismatch branch behind mission head', ['sh', '-c', "base=$(git branch --show-current) && git switch -q -c mission/legacy-local-mismatch-smoke && printf 'legacy local feature\\n' > README.md && git add README.md && git commit -q -m 'mission(legacy-local-mismatch-smoke): Legacy Local Feature' && git branch mission-feature/legacy-local-mismatch-smoke/f1 HEAD && printf 'later mission commit\\n' >> README.md && git add README.md && git commit -q -m 'later mission work' && git switch -q $base"], 0, { cwd: legacyLocalMismatchRepo });
  const legacyLocalMismatchWorktrees = join(tmp, 'legacy-local-mismatch-worktrees');
  expectExit('legacy local mismatch integration worktree exists', ['git', 'worktree', 'add', '-q', join(legacyLocalMismatchWorktrees, 'integration'), 'mission/legacy-local-mismatch-smoke'], 0, { cwd: legacyLocalMismatchRepo });
  const legacyLocalMismatchPlanPath = join(tmp, 'legacy-local-mismatch-plan.json');
  writeFileSync(legacyLocalMismatchPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'legacy-local-mismatch-smoke', goal: 'legacy local mismatch rerun', cwd: legacyLocalMismatchRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: legacyLocalMismatchWorktrees, validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Legacy Local Feature', description: 'f1', assertions: ['a1'], localAssertions: ['new-local-check'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] } }, null, 2));
  const legacyLocalMismatchRegistryDir = join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'legacy-local-mismatch-smoke');
  mkdirSync(legacyLocalMismatchRegistryDir, { recursive: true });
  writeFileSync(join(legacyLocalMismatchRegistryDir, 'state.json'), JSON.stringify({ schema: 'pi-mission-workflow/registry/v1', missionId: 'legacy-local-mismatch-smoke', status: 'running', completedFeatures: [{ featureId: 'f1', milestoneId: 'm1', branch: 'mission-feature/legacy-local-mismatch-smoke/f1', assertions: ['a1'], localAssertions: [], skipped: true }] }, null, 2));
  const fakePiLegacyLocalMismatch = join(tmp, 'fake-pi-legacy-local-mismatch.mjs');
  writeFileSync(fakePiLegacyLocalMismatch, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'README.md'), 'reran legacy local mismatch feature\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1', 'new-local-check'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'reran' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }, { assertionId: 'new-local-check', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-legacy-local-mismatch', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi legacy local mismatch is executable', ['chmod', '+x', fakePiLegacyLocalMismatch], 0);
  expectExit('mission workflow rejects contaminated branch with legacy local mismatch registry', ['node', missionCli, 'resume', '--approved', '--plan-path', legacyLocalMismatchPlanPath, '--cwd', legacyLocalMismatchRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiLegacyLocalMismatch }, timeout: 60_000 });

  const staleCommitRepo = join(tmp, 'stale-commit-repo');
  mkdirSync(staleCommitRepo, { recursive: true });
  expectExit('stale commit repo git init', ['git', 'init', '-q'], 0, { cwd: staleCommitRepo });
  expectExit('stale commit repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: staleCommitRepo });
  expectExit('stale commit repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: staleCommitRepo });
  writeFileSync(join(staleCommitRepo, 'README.md'), 'stale commit initial\n');
  expectExit('stale commit repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: staleCommitRepo });
  const staleBase = expectExit('stale commit base rev', ['git', 'rev-parse', 'HEAD'], 0, { cwd: staleCommitRepo }).stdout.trim();
  expectExit('stale commit branch has matching subject but registry points at base', ['sh', '-c', "base=$(git branch --show-current) && git switch -q -c mission/stale-commit-smoke && printf 'stale subject feature\\n' > README.md && git add README.md && git commit -q -m 'mission(stale-commit-smoke): Stale Commit Feature' && git branch mission-feature/stale-commit-smoke/f1 HEAD && printf 'later stale mission commit\\n' >> README.md && git add README.md && git commit -q -m 'later mission work' && git switch -q $base"], 0, { cwd: staleCommitRepo });
  const staleCommitWorktrees = join(tmp, 'stale-commit-worktrees');
  expectExit('stale commit integration worktree exists', ['git', 'worktree', 'add', '-q', join(staleCommitWorktrees, 'integration'), 'mission/stale-commit-smoke'], 0, { cwd: staleCommitRepo });
  const staleCommitPlanPath = join(tmp, 'stale-commit-plan.json');
  writeFileSync(staleCommitPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'stale-commit-smoke', goal: 'stale commit rerun', cwd: staleCommitRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: staleCommitWorktrees, validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Stale Commit Feature', description: 'f1', assertions: ['a1'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] } }, null, 2));
  const staleCommitRegistryDir = join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'stale-commit-smoke');
  mkdirSync(staleCommitRegistryDir, { recursive: true });
  const staleCommitHandoff = join(tmp, 'stale-commit-handoff.json');
  writeFileSync(staleCommitHandoff, JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'stale handoff' }));
  writeFileSync(join(staleCommitRegistryDir, 'state.json'), JSON.stringify({ schema: 'pi-mission-workflow/registry/v1', missionId: 'stale-commit-smoke', status: 'running', completedFeatures: [{ featureId: 'f1', milestoneId: 'm1', branch: 'mission-feature/stale-commit-smoke/f1', commit: staleBase, handoffArtifact: staleCommitHandoff, changedFiles: ['README.md'], assertions: ['a1'], skipped: true }] }, null, 2));
  const fakePiStaleCommit = join(tmp, 'fake-pi-stale-commit.mjs');
  writeFileSync(fakePiStaleCommit, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'README.md'), 'reran stale commit feature\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'reran' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-stale-commit', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi stale commit is executable', ['chmod', '+x', fakePiStaleCommit], 0);
  expectExit('mission workflow rejects contaminated branch with stale registry commit at base', ['node', missionCli, 'resume', '--approved', '--plan-path', staleCommitPlanPath, '--cwd', staleCommitRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiStaleCommit }, timeout: 60_000 });

  const ignoreText = readFileSync(join(root, '.gitignore'), 'utf8');
  log(['__pycache__/', '.pytest_cache/', '.venv/', '*.egg-info/'].every((pattern) => ignoreText.includes(pattern)), 'package .gitignore protects generated junk');

  const strictRepo = join(tmp, 'strict-handoff-repo');
  mkdirSync(strictRepo, { recursive: true });
  expectExit('strict handoff repo git init', ['git', 'init', '-q'], 0, { cwd: strictRepo });
  expectExit('strict handoff repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: strictRepo });
  expectExit('strict handoff repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: strictRepo });
  writeFileSync(join(strictRepo, 'README.md'), 'strict\n');
  expectExit('strict handoff repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: strictRepo });
  const strictPlanPath = join(tmp, 'strict-plan.json');
  writeFileSync(strictPlanPath, JSON.stringify({
    schema: 'pi-mission-workflow/v1', missionId: 'strict-handoff-smoke', goal: 'strict handoff rejection', cwd: strictRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1,
    worktreeBaseDir: join(tmp, 'strict-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'f1', description: 'f1', assertions: ['a1'] }] }],
    validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePi = join(tmp, 'fake-pi-no-handoff.mjs');
  writeFileSync(fakePi, `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'message_end', message:{role:'assistant', model:'fake', content:[{type:'text', text:'done without handoff'}]}}));\n`);
  expectExit('fake pi no-handoff is executable', ['chmod', '+x', fakePi], 0);
  expectExit('mission workflow rejects missing strict handoff', ['node', missionCli, 'activate', '--approved', '--plan-path', strictPlanPath, '--cwd', strictRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePi } });
  const strictRegistryPath = join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'strict-handoff-smoke', 'state.json');
  const strictRegistry = existsSync(strictRegistryPath) ? JSON.parse(readFileSync(strictRegistryPath, 'utf8')) : undefined;
  log(strictRegistry?.status === 'failed', 'mission workflow marks registry failed on strict handoff failure', strictRegistry?.status || 'missing registry');

  if (missionPlanDetails?.plan?.worktreeBaseDir) rmSync(missionPlanDetails.plan.worktreeBaseDir, { recursive: true, force: true });
} finally {
  if (process.env.KEEP_PI_THREAD_PHASE_TEST_TMP !== '1') rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} smoke test(s) failed.`);
  process.exit(1);
}
console.log('\nAll smoke tests passed.');
