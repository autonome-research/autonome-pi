// Offline Pi 1.0.4 qualification for the recursive SDK worker.
//
// Lanes are EXPLICIT: the requested SDK version is 1.0.4, resolved at the
// repo's node_modules/@earendil-works/pi-coding-agent and cross-checked
// against PI_DELEGATION_EXPECT_SDK_VERSION whenever the fixture consent flag
// (PI_DELEGATION_COMPAT_FIXTURES=1) is armed; a missing SDK or a version
// mismatch fails the file at load, never silently substitutes or skips.
//
// The file binds every result to the actual tree it runs in:
// - UNMODIFIED production tree (worker/sdk-runner.mjs admits only
//   0.86.0/0.85.1/0.84.2): the 1.0.4 admission MUST reject with
//   UNSUPPORTED_VERSION; candidate-only lanes are skipped explicitly.
// - PHYSICAL SCRATCH CANDIDATE tree (the single admission-list entry '1.0.4'
//   added, nothing else): candidate lanes exercise actual 1.0.4 SDK behavior
//   offline. A candidate pass is NOT production admission, live-provider/OAuth
//   qualification, or permission to activate recursion.
//
// Safety scope: functional compatibility and defensive validation only.
// Vulnerability/bypass reproductions (including the historical stock-grep
// counterexample), hostile launch-envelope probes, real credentials/providers
// and OAuth flows are out of scope and registered as explicit skips below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runBoundedProcess } from '../lib/subprocess.mjs';
import { workerEnvironment, profileDirectories } from '../worker/profile.mjs';
import { supportDir } from './support/delegation-worker-gates/driver.mjs';
import { explicitSdkLane } from './support/pi104-offline/explicit-lane.mjs';

const EXPECTED_VERSION = '1.0.4';
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const lane = explicitSdkLane(repoRoot); // throws under consent when the explicit lane mismatches
const probes = join(repoRoot, 'dynamic-thread-phase-workflow/test/support/pi104-offline');
const noNetwork = join(supportDir, 'no-network.mjs');
const strictNoNetwork = join(supportDir, 'strict-no-network.mjs');
const runnerPath = join(repoRoot, 'dynamic-thread-phase-workflow/worker/sdk-runner.mjs');
const runnerSource = await readFile(runnerPath, 'utf8');
const runnerSha256 = createHash('sha256').update(runnerSource).digest('hex');
const versionsLiteral = /const VERSIONS = new Set\(\[([^\]]*)\]\)/.exec(runnerSource)?.[1];
const admitted = versionsLiteral ? [...versionsLiteral.matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
const admits104 = admitted.includes(EXPECTED_VERSION);
const consentTest = (name, options, fn) => test(name, { ...options, skip: options.skip || process.env.PI_DELEGATION_COMPAT_FIXTURES !== '1' }, fn);
const candidateTest = (name, options, fn) => consentTest(name, { ...options, skip: options.skip || (admits104 ? false : 'production tree: scratch-candidate lane not applicable') }, fn);
// Credential material of the synthetic fixture; must never appear in output.
const CREDENTIAL_PATTERN = /synthetic-(?:access|refresh-value)/;

console.log(JSON.stringify({ qualification: 'pi104-offline', expectedVersion: EXPECTED_VERSION,
  lane: { version: lane.version, aiVersion: lane.aiVersion, packageDir: lane.packageDir },
  runner: { path: runnerPath, sha256: runnerSha256, admittedVersions: admitted, admits104 } }));

async function directories(root, name) {
  const value = profileDirectories(join(root, name));
  for (const path of Object.values(value)) await mkdir(path, { recursive: true, mode: 0o700 });
  return value;
}
function setup(dirs, authPath) {
  return { schema: 'pi-workflow-sdk-worker/v1', sdkPackagePath: lane.packageDir, authPath,
    agentDir: dirs.agentDir, tools: ['workflow_context', 'workflow_complete'], prompt: 'Complete the synthetic bounded assignment.' };
}
async function runProbe(args, dirs) {
  return runBoundedProcess(process.execPath, ['--import', noNetwork, '--import', strictNoNetwork, ...args], {
    cwd: dirs.home, env: { ...workerEnvironment({ ...dirs, nodePath: process.execPath }),
      PI_DELEGATION_COMPAT_FIXTURES: '1', PI_DELEGATION_EXPECT_SDK_VERSION: EXPECTED_VERSION },
    timeoutMs: 45000, killGraceMs: 100, maxStdoutBytes: 256 * 1024, maxStderrBytes: 64 * 1024 });
}

// ---------------------------------------------------------------------------
// Pure source identity (no consent): binds this file to the actual runner.
// ---------------------------------------------------------------------------

test('explicit lane resolved the real SDK package with no fallback', { skip: process.env.PI_DELEGATION_COMPAT_FIXTURES !== '1' &&
    `fixture consent not armed; installed SDK ${lane.version} noted, no lane executed` }, () => {
  assert.equal(lane.version, EXPECTED_VERSION, 'explicitly requested 1.0.4 lane must resolve exactly');
  assert.ok(lane.packageDir.endsWith('node_modules/@earendil-works/pi-coding-agent'));
  if (process.env.PI_DELEGATION_COMPAT_FIXTURES === '1')
    assert.equal(process.env.PI_DELEGATION_EXPECT_SDK_VERSION, EXPECTED_VERSION, 'armed lane consent must name the exact version');
});

test('production admission source is a closed literal set with no bypass', () => {
  assert.ok(versionsLiteral, 'VERSIONS literal present');
  assert.deepEqual([...versionsLiteral.matchAll(/'[^']+'/g)].length, admitted.length);
  assert.ok(admitted.length >= 3 && admitted.every(v => /^\d+\.\d+\.\d+$/.test(v)), `literal versions only: ${admitted}`);
  assert.equal(/process\.env|getenv/i.test(versionsLiteral), false, 'no environment-driven admission');
});

// ---------------------------------------------------------------------------
// Explicit lane helper coverage: a requested lane that is missing or
// mismatched MUST fail; nothing may silently substitute, inherit or skip.
// ---------------------------------------------------------------------------

test('explicit lane helper fails closed on missing or mismatched requested version', { timeout: 30000 }, async () => {
  const laneModule = pathToFileURL(join(probes, 'explicit-lane.mjs')).href;
  const script = `import { explicitSdkLane } from ${JSON.stringify(laneModule)}; explicitSdkLane(${JSON.stringify(repoRoot)}); console.log('LANE_ACCEPTED');`;
  const run = (env) => runBoundedProcess(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot, env: { PATH: process.env.PATH, ...env }, timeoutMs: 15000, killGraceMs: 100,
    maxStdoutBytes: 8192, maxStderrBytes: 8192 });
  // Positive control: the exact installed version is accepted under consent.
  const ok = await run({ PI_DELEGATION_COMPAT_FIXTURES: '1', PI_DELEGATION_EXPECT_SDK_VERSION: lane.version });
  assert.equal(ok.ok, true, ok.stderr);
  assert.match(ok.stdout, /LANE_ACCEPTED/);
  // Mismatched request fails; the installed SDK is never substituted.
  const mismatch = await run({ PI_DELEGATION_COMPAT_FIXTURES: '1', PI_DELEGATION_EXPECT_SDK_VERSION: '0.0.0-mismatch' });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.stderr, /UNSUPPORTED_VERSION/);
  assert.doesNotMatch(mismatch.stdout, /LANE_ACCEPTED/);
  // Missing requested version under consent fails; nothing is inherited.
  const missing = await run({ PI_DELEGATION_COMPAT_FIXTURES: '1' });
  assert.equal(missing.ok, false);
  assert.match(missing.stderr, /INVALID_REQUEST/);
  assert.doesNotMatch(missing.stdout, /LANE_ACCEPTED/);
  // Without consent the helper is inert metadata for skip paths.
  const inert = await run({});
  assert.equal(inert.ok, true, inert.stderr);
  assert.match(inert.stdout, /LANE_ACCEPTED/);
});

// ---------------------------------------------------------------------------
// Unmodified production rejection (unchanged rejection case, recorded first)
// ---------------------------------------------------------------------------

consentTest('unmodified production admission rejects 1.0.4 with UNSUPPORTED_VERSION', { timeout: 60000, skip: admits104 ? 'scratch candidate tree: rejection case not applicable' : false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi104-rejection-')); let clean = false;
  try {
    const dirs = await directories(root, 'worker');
    const authPath = join(root, 'auth.json');
    await writeFile(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'synthetic-access',
      refresh: 'synthetic-refresh-value', expires: Date.now() + 3600000 } }), { mode: 0o600 });
    const result = await runProbe([join(probes, 'admission-probe.mjs'), JSON.stringify(setup(dirs, authPath))], dirs);
    assert.equal(result.ok, false);
    assert.equal(result.code, 70);
    assert.equal(result.stderr, 'PI_WORKER_FAIL_STOP:ADMISSION_PROBE\n');
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.admitted, false);
    assert.match(evidence.error, /UNSUPPORTED_VERSION/);
    t.diagnostic(`rejection evidence: ${result.stdout.trim()}`);
    clean = true;
  } finally {
    if (clean) await rm(root, { recursive: true, force: true }); else t.diagnostic(`retained owned fixture ${root}`);
  }
});

// ---------------------------------------------------------------------------
// PHYSICAL SCRATCH CANDIDATE lanes (single admission-list entry '1.0.4')
// ---------------------------------------------------------------------------

candidateTest('scratch candidate source deviation is exactly the 1.0.4 admission entry', { timeout: 10000 }, async () => {
  assert.deepEqual(admitted, ['0.86.0', '0.85.1', '0.84.2', '1.0.4'], 'candidate set = production set + 1.0.4 only');
  assert.equal(runnerSource.split('1.0.4').length - 1, 1, 'exactly one 1.0.4 occurrence in the candidate runner');
});

candidateTest('scratch candidate admits 1.0.4 with synthetic stored auth; no network, refresh or inference', { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi104-admission-')); let clean = false;
  try {
    const dirs = await directories(root, 'worker');
    const authPath = join(root, 'auth.json');
    await writeFile(authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'synthetic-access',
      refresh: 'synthetic-refresh-value', expires: Date.now() + 3600000 } }), { mode: 0o600 });
    const result = await runProbe([join(probes, 'admission-probe.mjs'), JSON.stringify(setup(dirs, authPath))], dirs);
    assert.equal(result.ok, true, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { admitted: true, sdkVersion: '1.0.4', sdkVersionExport: '1.0.4',
      provider: 'openai-codex', model: 'gpt-5.6-sol', authSource: 'stored' });
    // Non-expired fixture: the stored credential must be untouched (no refresh ran).
    const stored = JSON.parse(await readFile(authPath, 'utf8'))['openai-codex'];
    assert.equal(stored.access, 'synthetic-access');
    assert.doesNotMatch(result.stdout + result.stderr, CREDENTIAL_PATTERN);
    clean = true;
  } finally {
    if (clean) await rm(root, { recursive: true, force: true }); else t.diagnostic(`retained owned fixture ${root}`);
  }
});

for (const [mode, name] of [['preflight', 'isolated resources, tool allowlist and manual compaction accounting'],
  ['overflow', 'overflow dispatcher retains summary usage and reports the execution failure separately (M1)']]) {
  candidateTest(`1.0.4 actual SDK: ${name}`, { timeout: 60000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `pi104-compaction-${mode}-`)); let clean = false;
    try {
      const dirs = await directories(root, 'worker');
      const result = await runProbe([join(probes, 'compaction-probe.mjs'), lane.packageDir, EXPECTED_VERSION, mode], dirs);
      assert.equal(result.ok, true, result.stderr || result.stdout);
      const evidence = JSON.parse(result.stdout.trim().split('\n').at(-1));
      assert.equal(evidence.version, '1.0.4');
      assert.equal(evidence.sdkVersionExport, '1.0.4');
      assert.deepEqual(evidence.skippedOutOfScope, ['stock-grep-counterexample', 'real-provider-overflow-recovery']);
      if (mode === 'overflow') {
        assert.deepEqual(evidence.compactionEvents.map(e => e.type), ['compaction_start', 'compaction_end', 'compaction_end']);
        assert.equal(evidence.compactionEvents[1].willRetry, true);
        assert.deepEqual(evidence.compactionEvents[2], { type: 'compaction_end', reason: 'overflow', willRetry: false, aborted: false,
          hasResult: false, errorMessage: evidence.compactionEvents[2].errorMessage });
        assert.match(evidence.compactionEvents[2].errorMessage, /recovery failed after one compact-and-retry attempt/);
      } else {
        assert.deepEqual(evidence.compactionEvents.map(e => e.type), ['compaction_start', 'compaction_end']);
        assert.deepEqual(evidence.refreshAllowlist, ['read']);
      }
      assert.equal(evidence.summaryUsage.totalTokens, 3);
      t.diagnostic(`compaction evidence (${mode}): ${JSON.stringify(evidence.compactionEvents)}`);
      clean = true;
    } finally {
      if (clean) await rm(root, { recursive: true, force: true }); else t.diagnostic(`retained owned fixture ${root}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Explicitly out of scope for this task: recorded as skips, never as passes.
// ---------------------------------------------------------------------------

test('stock-grep counterexample (bypass reproduction)', { skip: 'OUT OF SCOPE: bypass reproductions are excluded from this offline qualification' }, () => {});
test('historical CLI driver lanes 0.86.0/0.84.2', { skip: 'OUT OF SCOPE: hardcoded historical lanes are not run blindly; see delegation-worker-gates README' }, () => {});
test('live provider, real credentials and OAuth flows', { skip: 'OUT OF SCOPE: no real auth/provider/OAuth; a candidate pass is not live qualification' }, () => {});
