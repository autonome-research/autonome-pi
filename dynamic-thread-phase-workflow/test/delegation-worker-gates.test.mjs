import test from 'node:test';
import assert from 'node:assert/strict';
import { runFixture, versions, workerNames, supportDir } from './support/delegation-worker-gates/driver.mjs';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import registerDynamic from '../index.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { workerEnvironment, profileDirectories, assertToolProfile } from '../worker/profile.mjs';
import { toolOccurrence, replaceDelegationContext, runnerBashOperations } from '../worker/adapter-primitives.mjs';
import { exclusiveUsageObserver } from '../worker/exclusive-usage.mjs';
import { PiJsonEventCollector } from '../lib/pi-json-stream.mjs';
import { runBoundedProcess } from '../lib/subprocess.mjs';
import { projectRun } from '../../thread-phase-visualizer/lib/store.mjs';
import { frames } from './support/delegation-worker-gates/frames.mjs';

const fixtureTest = (name, options, run) => test(name, { ...options, skip: process.env.PI_DELEGATION_COMPAT_FIXTURES !== '1' }, run);
for (const version of versions) fixtureTest(`Pi ${version.version}: live deterministic parent-child-grandchild, isolated profile and terminating completion`, { timeout: 65000 }, async t => {
  const result = await runFixture(version);
  assert.equal(result.records.length, 3, JSON.stringify(result.records.map(r => ({ code: r.code, stderr: r.stderr, events: r.events }))));
  assert.equal(result.poisonExecuted, false); assert.equal(result.mutation, null); assert.equal(result.socketMode, 0o600);
  for (const record of result.records) {
    assert.equal(record.code, 0, record.stderr);
    assert.throws(() => process.kill(-record.pid, 0), { code: 'ESRCH' }); // settled fixed fixture workers, not a drain algorithm
    assert.doesNotMatch(record.stdout + record.stderr, /\x1b\](?:0|2);/); // no terminal title escape
    assert.ok(record.candidate, record.stdout);
    const profile = record.events.find(e => e.type === 'fixture_worker' && e.stage === 'profile');
    assert.ok(profile, record.stdout); assert.equal(profile.hasUI, false); assert.equal(profile.sessionFile, undefined);
    assert.equal(profile.inheritedAuthorityPresent, false);
    assert.deepEqual(profile.active.sort(), workerNames(record.depth));
    const turns = record.events.filter(e => e.type === 'fixture_provider');
    assert.equal(turns.length, record.depth < 2 ? 3 : 1, record.stdout);
    assert.ok(turns.every(e => e.tools.join(',') === workerNames(record.depth).join(',')));
    const occurrences = record.events.filter(e => e.type === 'fixture_worker' && e.stage === 'preflight').map(e => e.requestId);
    assert.equal(new Set(occurrences).size, occurrences.length); // actual provider reuses one id across all turns
    if (record.depth < 2) {
      assert.equal(turns[1].compacted, true);
      assert.equal(turns[1].index.childCount, 1);
      assert.equal(turns[2].lastTool, 'workflow_context');
      assert.equal(record.candidate.childReviews.length, 1);
      const parked = result.trace.find(e => e.stage === 'park' && e.depth === record.depth);
      const returned = result.trace.find(e => e.stage === 'return' && e.depth === record.depth);
      assert.equal(parked.pid, returned.pid);
      // These audit markers and provider calls share one stderr pipe, avoiding
      // arrival-order assumptions between the socket, stdout and stderr channels.
      const waiting = record.events.findIndex(e => e.type === 'fixture_worker' && e.stage === 'waiting');
      const resumed = record.events.findIndex(e => e.type === 'fixture_worker' && e.stage === 'resumed');
      assert.ok(waiting >= 0 && resumed > waiting);
      assert.equal(record.events[waiting].sessionId, profile.sessionId);
      assert.equal(record.events[resumed].sessionId, profile.sessionId);
      assert.equal(record.events[waiting].pid, record.events[resumed].pid);
      assert.ok(!record.events.slice(waiting + 1, resumed).some(e => e.type === 'fixture_provider'));
      assert.ok(result.trace.find(e => e.stage === 'exit' && e.depth === record.depth + 1).sequence < returned.sequence);
    }
    const completeEnd = record.events.find(e => e.type === 'tool_execution_end' && e.toolName === 'workflow_complete');
    assert.equal(completeEnd.isError, false); assert.equal(completeEnd.result.terminate, true);
  }
  const observations = []; let collectorTotal = 0;
  for (const record of result.records) {
    const observer = exclusiveUsageObserver(record.invocationId);
    for (const event of record.events) { const source = observer.observe(event); if (source) observations.push(source); }
    assert.equal(observer.counters.missing, 0);
    const collector = new PiJsonEventCollector(); collector.push(record.stdout);
    collectorTotal += collector.finish().usage[0].totalTokens;
    for (const event of record.events.filter(e => e.type === 'message_end' && e.message.role === 'toolResult')) assert.equal(event.message.usage, undefined);
  }
  assert.equal(observations.length, 7); assert.equal(collectorTotal, 119);
  const storeEvents = observations.map((o, i) => ({ type: 'phase_event', runId: 'fixture', phase: 'root', eventId: o.identity,
    timestamp: String(i).padStart(3, '0'), data: { type: 'usage', usage: o.usage } }));
  const display = { type: 'phase_event', runId: 'fixture', phase: 'root', eventId: 'display', data: { type: 'delegation/v1', details: { accounting: 'display-only', totalTokens: 999 } } };
  assert.equal(projectRun([display]).usage.entries, 0);
  assert.equal(projectRun([...storeEvents, display]).usage.totalTokens, 119);
  t.diagnostic(`provenance: package=${result.packageDir}, CLI=${version.cliPath}; 3 fixture-only Pi processes settled/cleaned; exclusive usage 7 assistant messages/119 tokens`);
});

for (const version of versions) {
  for (const mode of ['mixed-delegate', 'mixed-delegate-reverse', 'mixed-complete', 'mixed-complete-reverse', 'mixed-bash', 'mixed-bash-reverse', 'mixed-all']) {
    fixtureTest(`Pi ${version.version}: ${mode} blocks the whole batch before sibling mutation`, { timeout: 25000 }, async () => {
      const result = await runFixture(version, mode);
      const record = result.records[0]; assert.equal(record.code, 0, record.stderr);
      assert.equal(result.records.length, 1); assert.equal(result.commandStarts, 0); assert.equal(result.mutation, null);
      const ends = record.events.filter(e => e.type === 'tool_execution_end');
      const blocked = ends.slice(0, mode === 'mixed-all' ? 4 : 2);
      assert.equal(blocked.length, mode === 'mixed-all' ? 4 : 2);
      assert.ok(blocked.every(e => e.isError && JSON.stringify(e.result).includes('exclusive tool batch')), record.stdout);
      assert.equal(ends.at(-1).toolName, 'workflow_complete'); assert.equal(ends.at(-1).isError, false);
    });
  }
  fixtureTest(`Pi ${version.version}: scoped read/search prevents file and grep link/scope bypass`, { timeout: 25000 }, async () => {
    const result = await runFixture(version, 'scope'); const record = result.records[0];
    assert.equal(record.code, 0, record.stderr);
    const ends = record.events.filter(e => e.type === 'tool_execution_end');
    assert.equal(ends.find(e => e.toolCallId === 'g1').isError, false);
    assert.match(JSON.stringify(ends.find(e => e.toolCallId === 'g1').result), /NEEDLE allowed/);
    assert.equal(ends.find(e => e.toolCallId === 'g2').isError, true);
    assert.equal(ends.find(e => e.toolCallId === 'r1').isError, true);
    assert.equal(ends.find(e => e.toolCallId === 'r2').isError, false);
    assert.ok(!record.stdout.includes('forbidden-secret'));
  });
  fixtureTest(`Pi ${version.version}: actual bash backend routed by operations to runner-owned journaled executor`, { timeout: 25000 }, async () => {
    const result = await runFixture(version, 'shell'); const record = result.records[0];
    assert.equal(record.code, 0, record.stderr); assert.equal(result.commandStarts, 1);
    const started = result.trace.find(e => e.stage === 'runner-command-start');
    const journal = result.trace.find(e => e.stage === 'real-process-journal').journal;
    assert.equal(journal.runnerPid, process.pid); assert.equal(journal.groups[0].pid, started.pid); assert.equal(journal.groups[0].token, started.token);
    assert.equal(journal.hasSubprocesses, true);
    assert.match(JSON.stringify(record.events.find(e => e.type === 'tool_execution_end' && e.toolName === 'bash').result), /fixture-shell/);
    assert.throws(() => process.kill(-started.pid, 0), { code: 'ESRCH' }); // fixed leaf command only, NOT orphan draining proof
  });
  fixtureTest(`Pi ${version.version}: missing bootstrap/provider, provenance mismatch, context failure fail closed`, { timeout: 90000 }, async () => {
    for (const options of [{ missingBootstrap: true }, { missingProvider: true }, { impostor: true }, { failContext: true }]) {
      const result = await runFixture(version, 'missing', options); const record = result.records[0];
      assert.notEqual(record.code, 0, record.stderr); assert.equal(record.candidate, undefined);
      assert.ok(!record.events.some(e => e.type === 'fixture_provider'), record.stdout);
      assert.equal(result.commandStarts, 0); assert.equal(result.mutation, null);
    }
  });
  fixtureTest(`Pi ${version.version}: candidate, exit and transport acceptance are distinct`, { timeout: 70000 }, async () => {
    const missing = (await runFixture(version, 'missing')).records[0];
    assert.equal(missing.code, 0); assert.equal(missing.candidate, undefined); // MISSING_COMPLETION despite normal Pi exit
    const nonzero = (await runFixture(version, 'nonzero')).records[0];
    assert.ok(nonzero.candidate); assert.equal(nonzero.code, 23, nonzero.stderr); // claimed success cannot mask failed exit
    const disconnected = await runFixture(version, 'disconnect'); const record = disconnected.records[0];
    assert.equal(record.candidate, undefined); assert.equal(record.code, 70, record.stderr);
    const error = record.events.find(e => e.type === 'tool_execution_end' && e.toolName === 'workflow_delegate');
    assert.equal(error.isError, true); assert.match(JSON.stringify(error.result), /ACCEPTANCE_UNKNOWN/);
    assert.ok(!JSON.stringify(error.result).includes('accepted:false'));
    assert.equal(disconnected.records.length, 1); // fixture accepts, drops socket, never retries/replaces parent
  });
  fixtureTest(`Pi ${version.version}: direct SDK static/builtin preflight, refresh filtering and stock grep counterexample`, { timeout: 20000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-worker-gates-')); const directories = profileDirectories(root);
    for (const path of Object.values(directories)) await mkdir(path, { recursive: true });
    try {
      const result = await runBoundedProcess(process.execPath, ['--import', join(supportDir, 'no-network.mjs'), join(supportDir, 'sdk-probe.mjs'), version.packageDir, version.version], {
        cwd: root, env: { ...workerEnvironment({ ...directories, nodePath: process.execPath }), PI_DELEGATION_COMPAT_FIXTURES: '1' }, timeoutMs: 15000, killGraceMs: 100,
      });
      assert.equal(result.ok, true, result.stderr || result.stdout);
      const probe = JSON.parse(result.stdout.trim()); assert.equal(probe.stockGrepBypassesRead, true); assert.equal(probe.noInference, true);
      assert.equal(probe.staticModel, 'fixture-static/static-model');
      const observer = exclusiveUsageObserver('sdk-compaction');
      const sources = probe.compactionEvents.map(event => observer.observe(event)).filter(Boolean);
      assert.equal(sources.length, 1); assert.equal(sources[0].source, 'compaction'); assert.equal(sources[0].usage.totalTokens, 3);
      const { compactionEvents, ...provenance } = probe;
      t.diagnostic(JSON.stringify({ ...provenance, compactionEvents: compactionEvents.length, compactionTokens: 3 }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const version of versions) fixtureTest(`Pi ${version.version}: actual SDK repeated-overflow dispatcher retains summary usage AND execution failure (M1)`, { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-worker-overflow-')); const directories = profileDirectories(root);
  for (const path of Object.values(directories)) await mkdir(path, { recursive: true });
  try {
    const result = await runBoundedProcess(process.execPath, ['--import', join(supportDir, 'no-network.mjs'), join(supportDir, 'sdk-probe.mjs'), version.packageDir, version.version, 'overflow'], {
      cwd: root, env: { ...workerEnvironment({ ...directories, nodePath: process.execPath }), PI_DELEGATION_COMPAT_FIXTURES: '1' }, timeoutMs: 15000, killGraceMs: 100,
    });
    assert.equal(result.ok, true, result.stderr || result.stdout);
    const probe = JSON.parse(result.stdout.trim()); assert.equal(probe.noInference, true);
    assert.equal(probe.version, version.version); assert.equal(probe.dispatcher, '_checkCompaction twice');
    const observer = exclusiveUsageObserver(`sdk-overflow-${version.version}`);
    const [start, summary, terminal] = probe.compactionEvents;
    assert.deepEqual(probe.compactionEvents.map(e => e.type), ['compaction_start', 'compaction_end', 'compaction_end']);
    observer.observe(start);
    const source = observer.observe(summary), before = { ...observer.counters };
    const failure = observer.observe(terminal);
    assert.deepEqual(source.usage, probe.summaryUsage); assert.equal(source.completeness, 'reported');
    assert.equal(failure.identity, source.identity); assert.equal(failure.source, undefined); assert.equal(failure.usage, undefined);
    assert.equal(failure.diagnostic.errorMessage, terminal.errorMessage);
    assert.equal(failure.diagnostic.willRetry, false); assert.equal(failure.diagnostic.aborted, false);
    assert.deepEqual(observer.counters, before);
    assert.deepEqual(before, { assistant: 0, compaction: 1, missing: 0, partial: 0, ignoredTool: 0 });
    assert.equal(observer.observe(summary), undefined); assert.equal(observer.observe(terminal), undefined);
    assert.throws(() => observer.observe({ ...summary, result: { ...summary.result, usage: { ...probe.summaryUsage, totalTokens: 4 } } }), /USAGE_CONFLICT/);
    assert.deepEqual(source.usage, probe.summaryUsage); assert.deepEqual(observer.counters, before);
    t.diagnostic(JSON.stringify({ version: probe.version, entrypoint: probe.entrypoint, dispatcher: probe.dispatcher,
      noInference: true, summaryTokens: source.usage.totalTokens, retainedExecutionFailure: failure.diagnostic }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

const usage = { input: 11, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
test('exclusive source classifier: no streaming/final/result/tool/display double count; compaction and missing/partial explicit', () => {
  const observer = exclusiveUsageObserver('inv');
  observer.observe({ type: 'turn_start' });
  const assistant = { type: 'message_end', message: { role: 'assistant', usage, stopReason: 'stop' } };
  assert.equal(observer.observe(assistant).usage.totalTokens, 17);
  assert.equal(observer.observe(assistant), undefined);
  assert.equal(observer.observe({ type: 'message_update', usage }), undefined);
  assert.equal(observer.observe({ type: 'agent_end', messages: [assistant.message] }), undefined);
  assert.equal(observer.observe({ type: 'message_end', message: { role: 'toolResult', usage } }), undefined);
  observer.observe({ type: 'compaction_start' });
  const compacted = { type: 'compaction_end', result: { usage }, aborted: false };
  assert.equal(observer.observe(compacted).source, 'compaction'); assert.equal(observer.observe(compacted), undefined);
  observer.observe({ type: 'turn_start' });
  assert.equal(observer.observe({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } }).completeness, 'missing');
  assert.deepEqual(observer.counters, { assistant: 2, compaction: 1, missing: 1, partial: 1, ignoredTool: 1 });
  assert.throws(() => observer.observe({ type: 'message_end', message: { role: 'assistant', usage, stopReason: 'error' } }), /USAGE_CONFLICT/);
  // Existing collector counterexample: tool usage is counted unless omitted/classified before ingestion.
  const collector = new PiJsonEventCollector(); collector.push(JSON.stringify({ type: 'message_end', message: { role: 'toolResult', usage } }) + '\n');
  assert.equal(collector.finish().usage[0].totalTokens, 17);
});

const overflowStart = { type: 'compaction_start', reason: 'overflow' };
const summaryEnd = { type: 'compaction_end', reason: 'overflow', result: { usage }, aborted: false, willRetry: true };
const terminalEnd = { type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: false, errorMessage: 'overflow recovery failed' };

test('M1 pure: summary and diagnostic duplicate independently without changing source accounting', () => {
  const observer = exclusiveUsageObserver('inv'); observer.observe(overflowStart);
  const source = observer.observe(summaryEnd);
  assert.equal(observer.observe(summaryEnd), undefined);
  const failure = observer.observe(terminalEnd);
  assert.deepEqual(failure, { invocationId: 'inv', identity: source.identity, diagnostic: {
    type: 'compaction_failure', reason: 'overflow', aborted: false, willRetry: false, errorMessage: terminalEnd.errorMessage,
  } });
  for (let i = 0; i < 100; i++) {
    assert.equal(observer.observe(terminalEnd), undefined); assert.equal(observer.observe(summaryEnd), undefined);
  }
  assert.deepEqual(source.usage, usage);
  assert.deepEqual(observer.counters, { assistant: 0, compaction: 1, missing: 0, partial: 0, ignoredTool: 0 });
  assert.throws(() => observer.observe({ ...terminalEnd, errorMessage: 'different failure' }), /USAGE_CONFLICT/);
});

test('M1 pure: changed tokens, costs, missing usage and partial status still conflict at settled identity', () => {
  const observer = exclusiveUsageObserver('inv'); observer.observe(overflowStart); observer.observe(summaryEnd); observer.observe(terminalEnd);
  for (const changed of [
    { ...usage, input: 12 }, { ...usage, cost: { ...usage.cost, total: 0.5 } }, undefined,
  ]) assert.throws(() => observer.observe({ ...summaryEnd, result: { usage: changed } }), /USAGE_CONFLICT/);
  assert.throws(() => observer.observe({ ...summaryEnd, aborted: true }), /USAGE_CONFLICT/);
  assert.equal(observer.observe(summaryEnd), undefined);
  assert.deepEqual(observer.counters, { assistant: 0, compaction: 1, missing: 0, partial: 0, ignoredTool: 0 });
});

test('M1 pure: no start, overlapping start and ambiguous later terminal events fail closed', () => {
  for (const end of [summaryEnd, terminalEnd, { ...terminalEnd, aborted: true }]) {
    assert.throws(() => exclusiveUsageObserver('inv').observe(end), /USAGE_IDENTITY_MISSING/);
  }
  const observer = exclusiveUsageObserver('inv'); observer.observe(overflowStart);
  assert.throws(() => observer.observe(overflowStart), /USAGE_LIFECYCLE_AMBIGUOUS/);
  observer.observe(summaryEnd);
  for (const end of [
    { ...terminalEnd, reason: 'manual' }, { ...terminalEnd, willRetry: true }, { ...terminalEnd, aborted: true },
    { ...terminalEnd, errorMessage: undefined }, { ...terminalEnd, errorMessage: '' },
    { ...terminalEnd, result: {} }, { ...terminalEnd, result: null }, { ...terminalEnd, usage },
  ]) assert.throws(() => observer.observe(end), /USAGE_(CONFLICT|LIFECYCLE_AMBIGUOUS)/);
  for (const summary of [{ ...summaryEnd, willRetry: false }, { ...summaryEnd, willRetry: undefined }]) {
    const other = exclusiveUsageObserver('other'); other.observe(overflowStart); other.observe(summary);
    assert.throws(() => other.observe(terminalEnd), /USAGE_CONFLICT/);
  }
  assert.equal(observer.observe(terminalEnd).diagnostic.errorMessage, terminalEnd.errorMessage);
  const limited = exclusiveUsageObserver('limited'); limited.observe(overflowStart);
  limited.counters.compaction = Number.MAX_SAFE_INTEGER;
  assert.throws(() => limited.observe(summaryEnd), /USAGE_LIMIT/);
  assert.equal(limited.counters.compaction, Number.MAX_SAFE_INTEGER);
  assert.equal(limited.counters.missing, 0);
});

test('M1 pure: aborted/error first terminal is one partial/missing source, not a free diagnostic', () => {
  for (const end of [terminalEnd, { ...terminalEnd, errorMessage: undefined, aborted: true }, { ...terminalEnd, result: { usage } }]) {
    const observer = exclusiveUsageObserver('inv'); observer.observe(overflowStart);
    const source = observer.observe(end);
    assert.equal(source.source, 'compaction'); assert.equal(source.diagnostic.type, 'compaction_failure');
    assert.equal(source.completeness, end.result ? 'partial' : 'missing');
    assert.deepEqual(source.usage, end.result?.usage); assert.equal(observer.observe(end), undefined);
    assert.throws(() => observer.observe(summaryEnd), /USAGE_CONFLICT/);
    assert.deepEqual(observer.counters, { assistant: 0, compaction: 1, missing: end.result ? 0 : 1, partial: 1, ignoredTool: 0 });
  }
});

test('M1 pure: new compaction start retires settled source and diagnostic state only', () => {
  for (const first of [summaryEnd, terminalEnd, { ...terminalEnd, aborted: true, errorMessage: undefined }]) {
    const observer = exclusiveUsageObserver('inv'); observer.observe(overflowStart);
    const a = observer.observe(first); if (first === summaryEnd) observer.observe(terminalEnd);
    observer.observe({ type: 'compaction_start', reason: 'manual' });
    assert.throws(() => observer.observe(terminalEnd), /USAGE_LIFECYCLE_AMBIGUOUS/);
    const b = observer.observe({ ...summaryEnd, reason: 'manual', willRetry: false });
    assert.notEqual(a.identity, b.identity); assert.equal(b.identity, 'inv:compaction:2');
    assert.equal(observer.counters.compaction, 2); assert.deepEqual(b.usage, usage);
    assert.throws(() => observer.observe({ ...terminalEnd, reason: 'manual' }), /USAGE_CONFLICT/);
  }
});

test('M1 pure: missing summary stays missing once; zero usage and all token/cost fields preserved', () => {
  const reported = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } };
  for (const value of [undefined, reported, usage]) {
    const observer = exclusiveUsageObserver('inv'); observer.observe(overflowStart);
    const source = observer.observe({ ...summaryEnd, result: { usage: value } });
    const failure = observer.observe(terminalEnd);
    assert.deepEqual(source.usage, value); assert.equal(source.completeness, value ? 'reported' : 'missing');
    assert.equal(failure.usage, undefined); assert.equal(failure.source, undefined);
    assert.deepEqual(observer.counters, { assistant: 0, compaction: 1, missing: value ? 0 : 1, partial: 0, ignoredTool: 0 });
    if (value) { assert.notEqual(source.usage, value); assert.notEqual(source.usage.cost, value.cost); }
  }
});

test('occurrence identity binds invocation + assistant entry + index, not reusable provider id', () => {
  const entry = id => [{ id, type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'reused', name: 'workflow_delegate' }] } }];
  const event = { toolName: 'workflow_delegate', toolCallId: 'reused' };
  const a = toolOccurrence(entry('entry1'), event, 'inv');
  assert.equal(toolOccurrence(entry('entry1'), event, 'inv'), a);
  assert.notEqual(toolOccurrence(entry('entry2'), event, 'inv'), a);
  assert.notEqual(toolOccurrence(entry('entry1'), event, 'other'), a);
  const duplicate = entry('entry1'); duplicate[0].message.content.push(duplicate[0].message.content[0]);
  assert.throws(() => toolOccurrence(duplicate, event, 'inv'), /ambiguous/);
  assert.throws(() => toolOccurrence([], event, 'inv'), /missing/);
});

test('profile does not inherit authority; exact names are not enough without provenance', () => {
  const env = workerEnvironment({ ...profileDirectories('/tmp/fixture'), nodePath: process.execPath,
    inherited: { PI_DYNAMIC_WORKFLOW_BACKGROUND: '1', PI_DYNAMIC_THREAD_PHASE_BACKGROUND: '1', PI_SESSION_ID: 'parent', PI_DYNAMIC_WORKFLOW_LAUNCH_AUTH: 'forged', OPENAI_API_KEY: 'secret', PI_THREAD_PHASE_TERMINAL_TITLE: '1' } });
  assert.equal(env.PI_DYNAMIC_WORKFLOW_BACKGROUND, ''); assert.equal(env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND, '');
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.PI_SESSION_ID, undefined); assert.equal(env.PI_DYNAMIC_WORKFLOW_LAUNCH_AUTH, undefined);
  const source = { path: '/trusted/worker.ts', source: 'cli', scope: 'temporary', origin: 'top-level' };
  assertToolProfile(['read'], [{ name: 'read', sourceInfo: source }], { read: source });
  assert.throws(() => assertToolProfile(['read'], [{ name: 'read', sourceInfo: { ...source, path: '<builtin:read>' } }], { read: source }), /provenance/);
  assert.throws(() => assertToolProfile(['read', 'bash'], [{ name: 'read', sourceInfo: source }], { read: source }), /names/);
});

test('context replacement bounds one current mandatory index after compaction-shaped messages', () => {
  const snapshot = { schema: 'pi-workflow-delegation-context/v1', ownChildJoinIndex: { artifactId: 'artifact:current', childCount: 127 } };
  let messages = [{ role: 'compactionSummary', summary: 'shape' }];
  for (let i = 0; i < 100; i++) messages = replaceDelegationContext(messages, snapshot);
  assert.equal(messages.length, 2); assert.match(messages[1].content, /artifact:current/);
  assert.throws(() => replaceDelegationContext([], { ...snapshot, padding: 'x'.repeat(24576) }), /CONTEXT_LIMIT/);
  assert.throws(() => replaceDelegationContext([], { schema: snapshot.schema }), /missing/);
});

test('runner bash operations passes bounded request identity, not inherited env or detached executor', async () => {
  const seen = [], output = [];
  const ops = runnerBashOperations('request:1', async request => { seen.push(request); return { status: 'command_result', exitCode: 0, output: 'fixture' }; });
  await ops.exec('printf fixture', '/ignored-cwd', { timeout: 1, onData: data => output.push(data.toString()), env: { SECRET: 'forged' } });
  assert.deepEqual(seen, [{ type: 'shell_execute', requestId: 'request:1', command: 'printf fixture', timeoutMs: 1000 }]);
  assert.deepEqual(output, ['fixture']);
  await assert.rejects(() => ops.exec('x'.repeat(16385), '.', { onData() {} }), /INVALID_REQUEST/);
  await assert.rejects(() => ops.exec('x', '.', { timeout: 0, onData() {} }), /INVALID_REQUEST/);
  const controller = new AbortController(); controller.abort(new Error('fixture cancelled'));
  await assert.rejects(() => ops.exec('x', '.', { signal: controller.signal, onData() {} }), /fixture cancelled/);
  assert.equal(seen.length, 1); // no request after pre-existing cancellation
  const bad = runnerBashOperations('request:2', async () => ({ status: 'command_result', exitCode: null, output: '' }));
  await assert.rejects(() => bad.exec('x', '.', { onData() {} }), /OWNERSHIP_UNKNOWN/);
});

test('fixture-only JSONL transport: fragmented UTF-8, LF-only framing, malformed and oversized frames', () => {
  const stream = new PassThrough(); const received = [], errors = [];
  frames(stream, value => received.push(value), error => errors.push(error.message));
  const data = Buffer.from(JSON.stringify({ value: '😀\u2028line\u2029end' }) + '\n');
  for (const byte of data) stream.write(Buffer.from([byte]));
  assert.deepEqual(received, [{ value: '😀\u2028line\u2029end' }]); assert.deepEqual(errors, []);
  stream.write('not-json\n'); assert.equal(errors.length, 1); stream.destroy();
  const big = new PassThrough(); frames(big, () => assert.fail('oversized parsed'), error => errors.push(error.message), 16);
  big.write('x'.repeat(17)); assert.equal(errors.at(-1), 'FRAME_LIMIT'); big.destroy();
});

test('public v3 acceptance and package worker registration remain disabled', async () => {
  if (process.env.PI_DELEGATION_COMPAT_FIXTURES !== '1') {
    await assert.rejects(() => runFixture(versions[0]), /FIXTURE_EXECUTION_NOT_ENABLED/);
  }
  const tools = new Map(); registerDynamic({ registerTool: definition => tools.set(definition.name, definition) });
  assert.equal(tools.get('dynamic_workflow').parameters.properties.delegation, undefined);
  assert.equal(tools.has('workflow_delegate'), false); assert.equal(tools.has('workflow_complete'), false);
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.pi.extensions.every(path => !path.includes('/worker/') && !path.includes('/test/')));
});
