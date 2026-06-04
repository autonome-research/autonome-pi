#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const tmp = mkdtempSync(join(tmpdir(), 'pi-thread-phase-tools-test-'));
const store = join(tmp, 'store');
const testHome = join(tmp, 'home');
mkdirSync(testHome, { recursive: true });
const realHome = process.env.HOME || '';
const realThreadPhaseCorePath = process.env.THREAD_PHASE_CORE_PATH || join(realHome, '.npm-global', 'lib', 'node_modules', '@autonome-research', 'thread-phase-cli', 'node_modules', '@autonome-research', 'thread-phase', 'dist', 'index.js');
const env = { ...process.env, HOME: testHome, PI_THREAD_PHASE_STORE_DIR: store, ...(existsSync(realThreadPhaseCorePath) ? { THREAD_PHASE_CORE_PATH: realThreadPhaseCorePath } : {}) };
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
  storeApi.phaseStart(smokeRun, 'agent');
  storeApi.phaseEvent(smokeRun, 'agent', { kind: 'usage', model: 'unit-model', usage: [{ input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 10 }] });
  storeApi.phaseEnd(smokeRun, 'agent', storeApi.STATUSES.SUCCESS);
  storeApi.completeRun(smokeRun, storeApi.STATUSES.SUCCESS);
  const summary = storeApi.getRunSummary(smokeRun.runId);
  log(summary.usage?.inputTokens === 100 && summary.usage?.outputTokens === 25 && summary.phases?.[0]?.usage?.cachedInputTokens === 10, 'usage projection aggregates run and phase usage', JSON.stringify(summary.usage));

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
  const missionPlan = expectExit('mission workflow mock plan succeeds', ['node', missionCli, 'plan', '--planner', 'mock', '--goal', 'No-op smoke mission', '--cwd', missionRepo], 0);
  let missionPlanDetails;
  try { missionPlanDetails = JSON.parse(missionPlan.stdout); } catch { missionPlanDetails = undefined; }
  log(Boolean(missionPlanDetails?.planPath), 'mission workflow plan emits planPath');
  const missionActivate = missionPlanDetails?.planPath
    ? expectExit('mission workflow mock activate succeeds', ['node', missionCli, 'activate', '--approved', '--plan-path', missionPlanDetails.planPath, '--cwd', missionRepo], 0)
    : undefined;
  let missionActivateDetails;
  try { missionActivateDetails = missionActivate?.stdout ? JSON.parse(missionActivate.stdout) : undefined; } catch { missionActivateDetails = undefined; }
  log(Boolean(missionActivateDetails?.branch), 'mission workflow activation emits mission branch');
  log(Boolean(missionActivateDetails?.registryPath) && existsSync(missionActivateDetails.registryPath), 'mission workflow activation creates durable registry');
  const registryState = missionActivateDetails?.registryPath ? JSON.parse(readFileSync(missionActivateDetails.registryPath, 'utf8')) : undefined;
  log(registryState?.status === 'completed' && Array.isArray(registryState.completedFeatures), 'mission workflow registry records completed state');
  log(Boolean(missionActivateDetails?.finalCoveragePath) && existsSync(missionActivateDetails.finalCoveragePath), 'mission workflow writes final coverage report');
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
    worktreeBaseDir: join(tmp, 'prefixed-handoff-worktrees'), validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'f1', description: 'f1', assertions: ['assertion-003'] }] }],
    validationContract: { assertions: [{ id: 'assertion-003', description: 'assertion three', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] }
  }, null, 2));
  const fakePiPrefixedHandoff = join(tmp, 'fake-pi-prefixed-handoff.mjs');
  writeFileSync(fakePiPrefixedHandoff, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nmkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\nwriteFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: [], commandsRun: [], assertionsAddressed: ['assertion-003: detailed repair evidence'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'ok' }));\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'prefixed handoff accepted', objections: [], assertionResults: [{ assertionId: 'assertion-003', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-prefixed', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi prefixed handoff is executable', ['chmod', '+x', fakePiPrefixedHandoff], 0);
  expectExit('mission workflow canonicalizes prefixed handoff assertion ids', ['node', missionCli, 'activate', '--approved', '--plan-path', prefixedHandoffPlanPath, '--cwd', prefixedHandoffRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiPrefixedHandoff }, timeout: 60_000 });

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

  const completedHeadRepo = join(tmp, 'completed-head-repo');
  mkdirSync(completedHeadRepo, { recursive: true });
  expectExit('completed head repo git init', ['git', 'init', '-q'], 0, { cwd: completedHeadRepo });
  expectExit('completed head repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: completedHeadRepo });
  expectExit('completed head repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: completedHeadRepo });
  writeFileSync(join(completedHeadRepo, 'README.md'), 'completed head initial\n');
  expectExit('completed head repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: completedHeadRepo });
  expectExit('completed head mission branch with feature commit', ['sh', '-c', "base=$(git branch --show-current) && git switch -q -c mission/completed-head-smoke && printf 'already completed feature\\n' > README.md && git add README.md && git commit -q -m 'mission(completed-head-smoke): Done Feature' -m 'Mission-Feature-Id: f1' && git branch mission-feature/completed-head-smoke/f1 HEAD && git switch -q $base"], 0, { cwd: completedHeadRepo });
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
  const completedRegistryPath = join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'completed-head-smoke', 'state.json');
  const completedRegistryBeforeBadPlan = existsSync(completedRegistryPath) ? JSON.parse(readFileSync(completedRegistryPath, 'utf8')) : undefined;
  const badCompletedPlanPath = join(tmp, 'completed-head-bad-plan.json');
  writeFileSync(badCompletedPlanPath, JSON.stringify({ ...JSON.parse(readFileSync(completedHeadPlanPath, 'utf8')), goal: 'bad replacement goal', validationContract: { assertions: [{ id: 'bad', description: 'bad', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] } }, null, 2));
  expectExit('completed registry later activate failure', ['node', missionCli, 'activate', '--approved', '--plan-path', badCompletedPlanPath, '--cwd', completedHeadRepo], 1, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiCompletedHead }, timeout: 60_000 });
  const completedRegistry = existsSync(completedRegistryPath) ? JSON.parse(readFileSync(completedRegistryPath, 'utf8')) : undefined;
  const completedRegistryPlanCopy = existsSync(join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'completed-head-smoke', 'mission-plan.json')) ? JSON.parse(readFileSync(join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'completed-head-smoke', 'mission-plan.json'), 'utf8')) : undefined;
  log(completedRegistry?.status === 'completed' && completedRegistry?.lastFailedAttempt && completedRegistry?.goal === completedRegistryBeforeBadPlan?.goal && completedRegistry?.planPath === completedRegistryBeforeBadPlan?.planPath && completedRegistryPlanCopy?.goal === completedRegistryBeforeBadPlan?.goal, 'completed registry is not downgraded or overwritten by later failed invocation', completedRegistry?.status || 'missing registry');

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

  const staleCommitRepo = join(tmp, 'stale-commit-repo');
  mkdirSync(staleCommitRepo, { recursive: true });
  expectExit('stale commit repo git init', ['git', 'init', '-q'], 0, { cwd: staleCommitRepo });
  expectExit('stale commit repo git config email', ['git', 'config', 'user.email', 'test@example.com'], 0, { cwd: staleCommitRepo });
  expectExit('stale commit repo git config name', ['git', 'config', 'user.name', 'Test'], 0, { cwd: staleCommitRepo });
  writeFileSync(join(staleCommitRepo, 'README.md'), 'stale commit initial\n');
  expectExit('stale commit repo initial commit', ['sh', '-c', 'git add README.md && git commit -q -m init'], 0, { cwd: staleCommitRepo });
  const staleBase = expectExit('stale commit base rev', ['git', 'rev-parse', 'HEAD'], 0, { cwd: staleCommitRepo }).stdout.trim();
  expectExit('stale commit branches at base', ['sh', '-c', 'git branch mission/stale-commit-smoke HEAD && git branch mission-feature/stale-commit-smoke/f1 HEAD'], 0, { cwd: staleCommitRepo });
  const staleCommitWorktrees = join(tmp, 'stale-commit-worktrees');
  expectExit('stale commit integration worktree exists', ['git', 'worktree', 'add', '-q', join(staleCommitWorktrees, 'integration'), 'mission/stale-commit-smoke'], 0, { cwd: staleCommitRepo });
  const staleCommitPlanPath = join(tmp, 'stale-commit-plan.json');
  writeFileSync(staleCommitPlanPath, JSON.stringify({ schema: 'pi-mission-workflow/v1', missionId: 'stale-commit-smoke', goal: 'stale commit rerun', cwd: staleCommitRepo, baseRef: 'HEAD', planner: 'pi', maxRepairIterations: 1, worktreeBaseDir: staleCommitWorktrees, validationCommands: [], milestones: [{ id: 'm1', title: 'm1', features: [{ id: 'f1', title: 'Stale Commit Feature', description: 'f1', assertions: ['a1'] }] }], validationContract: { assertions: [{ id: 'a1', description: 'a1', priority: 'must', coveredBy: ['f1'], validationMethod: 'both' }] } }, null, 2));
  const staleCommitRegistryDir = join(testHome, '.pi', 'agent', 'mission-workflow', 'registry', 'stale-commit-smoke');
  mkdirSync(staleCommitRegistryDir, { recursive: true });
  writeFileSync(join(staleCommitRegistryDir, 'state.json'), JSON.stringify({ schema: 'pi-mission-workflow/registry/v1', missionId: 'stale-commit-smoke', status: 'running', completedFeatures: [{ featureId: 'f1', branch: 'mission-feature/stale-commit-smoke/f1', commit: staleBase }] }, null, 2));
  const fakePiStaleCommit = join(tmp, 'fake-pi-stale-commit.mjs');
  writeFileSync(fakePiStaleCommit, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst prompt = process.argv.includes('-p') ? process.argv[process.argv.indexOf('-p') + 1] : '';\nif (prompt.includes('mission worker')) {\n  writeFileSync(join(process.cwd(), 'README.md'), 'reran stale commit feature\\n');\n  mkdirSync(join(process.cwd(), '.mission', 'handoffs'), { recursive: true });\n  writeFileSync(join(process.cwd(), '.mission', 'handoffs', 'f1.json'), JSON.stringify({ featureId: 'f1', completed: true, changedFiles: ['README.md'], commandsRun: [], assertionsAddressed: ['a1'], issuesDiscovered: [], leftUndone: [], notesForValidator: 'reran' }));\n}\nconst report = { schema: 'pi-mission-workflow/adversarial-validation/v1', milestoneId: 'm1', passed: true, summary: 'ok', objections: [], assertionResults: [{ assertionId: 'a1', status: 'pass', evidence: 'ok' }], correctiveFeatures: [] };\nconsole.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', model: 'fake-stale-commit', content: [{ type: 'text', text: JSON.stringify(report) }] } }));\n`);
  expectExit('fake pi stale commit is executable', ['chmod', '+x', fakePiStaleCommit], 0);
  expectExit('mission workflow ignores stale registry commit at base', ['node', missionCli, 'resume', '--approved', '--plan-path', staleCommitPlanPath, '--cwd', staleCommitRepo], 0, { env: { PI_MISSION_WORKFLOW_PI_BIN: fakePiStaleCommit }, timeout: 60_000 });
  const staleCommitReadme = expectExit('stale commit mission output contains rerun changes', ['git', 'show', 'mission/stale-commit-smoke:README.md'], 0, { cwd: staleCommitRepo });
  log((staleCommitReadme.stdout || '').includes('reran stale commit feature'), 'stale registry commit at base was not falsely trusted');

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
