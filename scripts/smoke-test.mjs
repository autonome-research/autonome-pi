#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const tmp = mkdtempSync(join(tmpdir(), 'pi-thread-phase-tools-test-'));
const store = join(tmp, 'store');
const env = { ...process.env, PI_THREAD_PHASE_STORE_DIR: store };
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
    ? expectExit('mission workflow mock resume succeeds', ['node', missionCli, 'resume', '--approved', '--plan-path', missionPlanDetails.planPath, '--cwd', missionRepo], 0)
    : undefined;
  let missionResumeDetails;
  try { missionResumeDetails = missionResume?.stdout ? JSON.parse(missionResume.stdout) : undefined; } catch { missionResumeDetails = undefined; }
  log(Boolean(missionResumeDetails?.branch) && Boolean(missionResumeDetails?.registryPath), 'mission workflow resume emits branch and registry pointer');

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

  if (missionPlanDetails?.plan?.worktreeBaseDir) rmSync(missionPlanDetails.plan.worktreeBaseDir, { recursive: true, force: true });
} finally {
  if (process.env.KEEP_PI_THREAD_PHASE_TEST_TMP !== '1') rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} smoke test(s) failed.`);
  process.exit(1);
}
console.log('\nAll smoke tests passed.');
