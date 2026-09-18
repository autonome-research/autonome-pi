// UNEXECUTED: parent validation runs this file in the fixed offline shell.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createHostedLaunchAuthority, receiveLaunchEnvelope,
  LAUNCH_BINDING_SCHEMA, LAUNCH_ENVELOPE_SCHEMA } from '../lib/delegation-launch-authorization.mjs';
import { canonicalJSON, sha256 } from '../lib/delegation-storage.mjs';
import { validateDelegationPolicy } from '../lib/delegation-contract.mjs';
import { isolatedResourceOptions } from '../worker/profile.mjs';

const root = mkdtempSync(join(tmpdir(), 'launch-auth-'));
after(() => rmSync(root, { recursive: true, force: true }));
const workspace = join(root, 'workspace'); mkdirSync(workspace);
const sdkDir = join(root, 'sdk'); mkdirSync(sdkDir);
const workerEntry = join(root, 'sdk-runner.mjs'); writeFileSync(workerEntry, '// launch fixture entry\n');
// Synthetic sentinel fixture: positively owned, never a real credential. The module
// binds the nonsecret path only and must never read or leak this content.
const SENTINEL = 'PRIVATE_SENTINEL_LAUNCH_AUTH';
const authFile = join(root, 'auth.json');
writeFileSync(authFile, `{"openai-codex":{"type":"oauth","access":"${SENTINEL}"}}\n`, { mode: 0o600 });
symlinkSync(workspace, join(root, 'alias'));
const SESSION_ID = 'hosted-session-1';
const sessionFile = join(root, 'session.jsonl');

const profile = () => ({ sdkPackagePath: sdkDir, workerEntryPath: workerEntry, authPath: authFile,
  resourceProfile: isolatedResourceOptions(), limits: { maxConcurrentAgents: 4, maxLiveAgents: 8 } });
const ctx = (mode = 'tui', sessionId = SESSION_ID) => ({ mode,
  sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } });
const spec = () => ({ schema: 'pi-dynamic-workflow/v3', name: 'launch-fixture',
  delegation: { maxDepth: 2, totalAgentBudget: 8, directoryScope: { read: ['src'], write: [] },
    context: { objective: 'Review bounded changes', constraints: ['stay in scope'] } } });
const launch = (over = {}) => {
  const value = { spec: spec(), cwd: join(root, 'alias'), background: true,
    progressReviewIntervalMs: 120_000, operator: { maxConcurrentAgents: 2 }, ...over };
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
};
const workerAssertion = Object.freeze({ setup: 'pi-workflow-sdk-worker/v1', provider: 'openai-codex',
  model: 'gpt-5.6-sol', thinking: 'high', sdkPackagePath: sdkDir, workerEntryPath: workerEntry, authPath: authFile });
const resourceDigest = sha256(canonicalJSON(isolatedResourceOptions()));
const baseAssertion = (l, sessionId = SESSION_ID) => ({
  hostMode: 'tui', sessionId, sessionFile, model: 'openai-codex/gpt-5.6-sol',
  cwd: realpathSync(l.cwd),
  specDigest: sha256(canonicalJSON(l.spec)),
  policyDigest: sha256(canonicalJSON(validateDelegationPolicy(l.spec.delegation))),
  background: l.background, supervision: l.background ? 'supervised' : 'foreground',
  progressReviewIntervalMs: l.progressReviewIntervalMs ?? null,
  effective: { maxConcurrentAgents: l.operator?.maxConcurrentAgents ?? 4,
    maxLiveAgents: l.operator?.maxLiveAgents ?? 8 },
  worker: workerAssertion, resourceProfileDigest: resourceDigest,
});
function streamOf(chunks) {
  const stream = new PassThrough();
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  return stream;
}
async function roundTrip(mode = 'tui') {
  const authority = createHostedLaunchAuthority(profile());
  const l = launch();
  const expected = { ...baseAssertion(l), hostMode: mode };
  const grant = authority.prepare(ctx(mode), l);
  const transfer = authority.consume(grant, expected);
  const initial = transfer.initialEnvelope();
  const received = await receiveLaunchEnvelope(streamOf([initial]), { stage: 'initial', expected });
  return { authority, grant, transfer, initial, received, l, expected };
}

test('hosted tui and rpc contexts mint opaque grants and one exact bounded frame', async () => {
  for (const mode of ['tui', 'rpc']) {
    const { transfer, initial, received, l } = await roundTrip(mode);
    assert.ok(initial.length <= 64 * 1024);
    assert.equal(initial.at(-1), 10);
    const text = initial.toString('utf8');
    assert.equal(text.indexOf('\n'), text.length - 1);
    assert.equal(text.slice(0, -1), canonicalJSON(JSON.parse(text)));
    const envelope = JSON.parse(text);
    assert.deepEqual(Object.keys(envelope).sort(), ['binding', 'schema', 'stage']);
    assert.equal(envelope.schema, LAUNCH_ENVELOPE_SCHEMA);
    assert.equal(envelope.stage, 'initial');
    assert.deepEqual(Object.keys(envelope.binding).sort(), ['background', 'cwd', 'effective', 'hostMode',
      'launchId', 'model', 'policyDigest', 'progressReviewIntervalMs', 'resourceProfileDigest', 'schema',
      'sessionFile', 'sessionId', 'specDigest', 'supervision', 'worker']);
    const binding = envelope.binding;
    assert.equal(binding.schema, LAUNCH_BINDING_SCHEMA);
    assert.equal(binding.hostMode, mode);
    assert.equal(binding.sessionId, SESSION_ID);
    assert.equal(binding.sessionFile, sessionFile);
    assert.equal(binding.model, 'openai-codex/gpt-5.6-sol');
    assert.equal(binding.cwd, realpathSync(l.cwd));
    assert.equal(binding.background, true);
    assert.equal(binding.supervision, 'supervised');
    assert.equal(binding.progressReviewIntervalMs, 120_000);
    assert.deepEqual(binding.effective, { maxConcurrentAgents: 2, maxLiveAgents: 8 });
    assert.deepEqual(binding.worker, workerAssertion);
    assert.equal(binding.resourceProfileDigest, resourceDigest);
    assert.equal(binding.specDigest, sha256(canonicalJSON(l.spec)));
    assert.ok(transfer.initialEnvelope().equals(initial));
    assert.notEqual(transfer.initialEnvelope(), initial);
    assert.ok(Object.isFrozen(received.binding) && Object.isFrozen(received.binding.worker) &&
      Object.isFrozen(received.binding.effective));
    received.handoffEnvelope(); // settle the receipt exactly once
  }
});

test('grants are opaque; foreground binds null cadence; cadence and caps are range-checked', () => {
  const authority = createHostedLaunchAuthority(profile());
  const l = launch({ progressReviewIntervalMs: undefined, operator: undefined });
  const grant = authority.prepare(ctx('tui'), l);
  assert.deepEqual(Object.keys(grant), []);
  assert.equal(JSON.stringify(grant), '{}');
  const binding = JSON.parse(authority.consume(grant, baseAssertion(l)).initialEnvelope().toString('utf8')).binding;
  assert.equal(binding.progressReviewIntervalMs, null);
  assert.deepEqual(binding.effective, { maxConcurrentAgents: 4, maxLiveAgents: 8 });
  const fg = launch({ background: false, progressReviewIntervalMs: undefined, operator: undefined });
  const fgGrant = authority.prepare(ctx('rpc'), fg);
  const fgBinding = JSON.parse(authority.consume(fgGrant, { ...baseAssertion(fg), hostMode: 'rpc' })
    .initialEnvelope().toString('utf8')).binding;
  assert.equal(fgBinding.supervision, 'foreground');
  assert.equal(fgBinding.progressReviewIntervalMs, null);
  for (const bad of [
    launch({ background: false }),                                   // cadence requires background
    launch({ progressReviewIntervalMs: 30_000 }),                    // below runner cadence floor
    launch({ progressReviewIntervalMs: 86_400_001 }),                // above runner cadence ceiling
    launch({ operator: { maxConcurrentAgents: 5 } }),                // above profile ceiling
    launch({ operator: { maxLiveAgents: 0 } }),                      // below range
    launch({ operator: { maxConcurrentAgents: 2, extra: 1 } }),      // unknown operator key
  ]) assert.throws(() => authority.prepare(ctx('tui'), bad), /INVALID_REQUEST/);
});

test('json, print, missing-mode and worker contexts are denied before any grant exists', () => {
  const authority = createHostedLaunchAuthority(profile());
  for (const bad of [ctx('json'), ctx('print'), { mode: undefined, sessionManager: ctx().sessionManager }, {}, null, undefined,
    { mode: 'tui' }, { mode: 'tui', sessionManager: {} }, { mode: 'worker', sessionManager: ctx().sessionManager }]) {
    assert.throws(() => authority.prepare(bad, launch()), /UNAUTHORIZED/);
  }
  const noSessionFile = { mode: 'tui', sessionManager: { getSessionId: () => SESSION_ID } };
  const l = launch();
  const grant = authority.prepare(noSessionFile, l);
  const binding = JSON.parse(authority.consume(grant, { ...baseAssertion(l), sessionFile: null })
    .initialEnvelope().toString('utf8')).binding;
  assert.equal(binding.sessionFile, null);
});

test('missing session is denied; a changed session mismatches and burns the grant', () => {
  const authority = createHostedLaunchAuthority(profile());
  for (const empty of ['', '   ']) {
    assert.throws(() => authority.prepare(ctx('tui', empty), launch()), /INVALID_REQUEST/);
  }
  const l = launch();
  const grant = authority.prepare(ctx('tui'), l);
  assert.throws(() => authority.consume(grant, baseAssertion(l, 'changed-session')),
    /LAUNCH_MISMATCH: launch field sessionId/);
  assert.throws(() => authority.consume(grant, baseAssertion(l)), /UNAUTHORIZED/); // burned
});

test('canonical cwd alias is accepted; wrong, missing or non-directory cwd is denied', () => {
  const authority = createHostedLaunchAuthority(profile());
  const l = launch(); // cwd enters through the symlink alias and binds the realpath
  const grant = authority.prepare(ctx('tui'), l);
  const binding = JSON.parse(authority.consume(grant, baseAssertion(l)).initialEnvelope().toString('utf8')).binding;
  assert.equal(binding.cwd, workspace);
  const wrong = authority.prepare(ctx('tui'), launch());
  assert.throws(() => authority.consume(wrong, { ...baseAssertion(launch()), cwd: realpathSync(root) }),
    /LAUNCH_MISMATCH: launch field cwd/);
  assert.throws(() => authority.prepare(ctx('tui'), launch({ cwd: join(root, 'missing') })), /SCOPE_DENIED/);
  assert.throws(() => authority.prepare(ctx('tui'), launch({ cwd: workerEntry })), /SCOPE_DENIED/);
});

test('every changed bound fact is a mismatch and burns the grant', () => {
  const mutations = [
    ['sessionId', 'changed-session'],
    ['sessionFile', join(root, 'other-session.jsonl')],
    ['hostMode', 'rpc'],
    ['model', 'openai-codex/gpt-5.6-sol-pro'],
    ['cwd', realpathSync(root)],
    ['specDigest', sha256('changed spec')],
    ['policyDigest', sha256('changed policy')],
    ['background', false],
    ['supervision', 'foreground'],
    ['progressReviewIntervalMs', 300_000],
    ['effective', { maxConcurrentAgents: 3, maxLiveAgents: 8 }],
    ['effective', { maxConcurrentAgents: 2, maxLiveAgents: 7 }],
    ['worker', { ...workerAssertion, model: 'other-model' }],
    ['worker', { ...workerAssertion, thinking: 'low' }],
    ['worker', { ...workerAssertion, sdkPackagePath: join(root, 'other-sdk') }],
    ['resourceProfileDigest', sha256('changed profile')],
  ];
  for (const [key, value] of mutations) {
    const authority = createHostedLaunchAuthority(profile());
    const l = launch();
    const grant = authority.prepare(ctx('tui'), l);
    const forged = { ...baseAssertion(l), [key]: value };
    assert.throws(() => authority.consume(grant, forged), new RegExp(`LAUNCH_MISMATCH: launch field ${key}`), key);
    assert.throws(() => authority.consume(grant, baseAssertion(l)), /UNAUTHORIZED/, `${key} burned`);
  }
});

test('grant and receipt identity is exact: plain, cloned and foreign objects denied', async () => {
  const authority = createHostedLaunchAuthority(profile());
  const foreign = createHostedLaunchAuthority(profile());
  const l = launch();
  const grant = authority.prepare(ctx('tui'), l);
  const foreignGrant = foreign.prepare(ctx('tui'), l);
  const expected = baseAssertion(l);
  assert.throws(() => authority.consume({}, expected), /UNAUTHORIZED/);
  assert.throws(() => authority.consume({ ...grant }, expected), /UNAUTHORIZED/);
  assert.throws(() => authority.consume(foreignGrant, expected), /UNAUTHORIZED/);
  assert.throws(() => foreign.consume(grant, expected), /UNAUTHORIZED/);
  // Foreign and malformed attempts never burn the owning authority's live grant.
  const transfer = authority.consume(grant, expected);
  assert.ok(Buffer.isBuffer(transfer.initialEnvelope()));
  assert.equal(typeof foreign.consume(foreignGrant, expected).initialEnvelope, 'function');
  const received = await receiveLaunchEnvelope(streamOf([transfer.initialEnvelope()]), { stage: 'initial', expected });
  const clone = { ...received };
  assert.throws(() => clone.handoffEnvelope(), /UNAUTHORIZED/);
  assert.throws(() => received.handoffEnvelope.call({}), /UNAUTHORIZED/);
  assert.throws(() => received.handoffEnvelope.call(clone), /UNAUTHORIZED/);
  assert.ok(Buffer.isBuffer(received.handoffEnvelope())); // original still wins exactly once
  assert.throws(() => received.handoffEnvelope(), /UNAUTHORIZED/);
  // An empty expectation asserts nothing and is rejected; the attempt still burns.
  const l2 = launch();
  const g2 = authority.prepare(ctx('tui'), l2);
  assert.throws(() => authority.consume(g2, {}), /INVALID_REQUEST/);
  assert.throws(() => authority.consume(g2, baseAssertion(l2)), /UNAUTHORIZED/);
});

test('consume and handoff replay plus concurrent attempts have exactly one winner', async () => {
  const authority = createHostedLaunchAuthority(profile());
  const l = launch();
  const grant = authority.prepare(ctx('tui'), l);
  const expected = baseAssertion(l);
  const consumes = await Promise.allSettled([
    Promise.resolve().then(() => authority.consume(grant, expected)),
    Promise.resolve().then(() => authority.consume(grant, expected)),
    Promise.resolve().then(() => authority.consume(grant, expected)),
  ]);
  assert.equal(consumes.filter(a => a.status === 'fulfilled').length, 1);
  const transfer = consumes.find(a => a.status === 'fulfilled').value;
  const received = await receiveLaunchEnvelope(streamOf([transfer.initialEnvelope()]), { stage: 'initial', expected });
  let winners = 0;
  await Promise.all([
    Promise.resolve().then(() => { try { received.handoffEnvelope(); winners++; } catch {} }),
    Promise.resolve().then(() => { try { received.handoffEnvelope(); winners++; } catch {} }),
  ]);
  assert.equal(winners, 1);
  assert.throws(() => received.handoffEnvelope(), /UNAUTHORIZED/);
});

test('initial and detached stages are distinct; stage-confused and forged frames denied', async () => {
  const { initial, received, expected, l } = await roundTrip();
  await assert.rejects(receiveLaunchEnvelope(streamOf([initial]), { stage: 'detached', expected }), /UNAUTHORIZED/);
  const handoff = received.handoffEnvelope();
  await assert.rejects(receiveLaunchEnvelope(streamOf([handoff]), { stage: 'initial', expected }), /UNAUTHORIZED/);
  const detached = await receiveLaunchEnvelope(streamOf([handoff]), { stage: 'detached', expected });
  assert.equal(detached.binding.launchId, received.binding.launchId);
  assert.throws(() => detached.handoffEnvelope.call({}), /UNAUTHORIZED/);
  assert.ok(Buffer.isBuffer(detached.handoffEnvelope()));
  assert.throws(() => detached.handoffEnvelope(), /UNAUTHORIZED/);
  // Receiver-side expectation changes deny the authentic frame.
  const changedSpec = { ...l.spec, name: 'renamed' };
  await assert.rejects(receiveLaunchEnvelope(streamOf([initial]), { stage: 'initial',
    expected: { ...expected, specDigest: sha256(canonicalJSON(changedSpec)) } }), /LAUNCH_MISMATCH/);
  await assert.rejects(receiveLaunchEnvelope(streamOf([initial]), { stage: 'initial',
    expected: { ...expected, policyDigest: sha256('changed policy') } }), /LAUNCH_MISMATCH/);
  await assert.rejects(receiveLaunchEnvelope(streamOf([initial]), { stage: 'initial',
    expected: { ...expected, resourceProfileDigest: sha256('changed profile') } }), /LAUNCH_MISMATCH/);
  // Forged wire bindings fail strict validation before any assertion runs.
  const forgedFrame = mutate => {
    const envelope = JSON.parse(initial.toString('utf8'));
    mutate(envelope);
    return Buffer.from(`${canonicalJSON(envelope)}\n`);
  };
  for (const mutate of [
    e => { e.binding.model = 'openai-codex/other'; },
    e => { e.binding.worker.provider = 'other-provider'; },
    e => { e.binding.worker.model = 'other-model'; },
    e => { e.binding.worker.thinking = 'low'; },
    e => { e.binding.worker.setup = 'pi-workflow-sdk-worker/v2'; },
    e => { e.binding.hostMode = 'json'; },
    e => { e.binding.supervision = 'foreground'; },   // contradicts background: true
    e => { e.binding.progressReviewIntervalMs = null; }, // contradicts bound cadence assertion
    e => { e.binding.specDigest = 'f'.repeat(64); },
    e => { e.schema = 'pi-workflow-launch-envelope/v2'; },
    e => { e.binding.extra = 1; },
    e => { delete e.binding.sessionId; },
  ]) await assert.rejects(receiveLaunchEnvelope(streamOf([forgedFrame(mutate)]), { stage: 'initial', expected }));
});

test('fragmented frames accepted; malformed, oversized, multiple, trailing, incomplete denied', async () => {
  const { initial, expected } = await roundTrip();
  const pieces = [];
  for (let i = 0; i < initial.length; i += 5) pieces.push(initial.subarray(i, i + 5));
  const ok = await receiveLaunchEnvelope(streamOf(pieces), { stage: 'initial', expected });
  assert.equal(ok.binding.specDigest, expected.specDigest);
  ok.handoffEnvelope();
  const deny = async (chunks, pattern) => {
    const stream = streamOf(chunks);
    await assert.rejects(receiveLaunchEnvelope(stream, { stage: 'initial', expected }), pattern);
    assert.equal(stream.destroyed, true);
  };
  await deny([initial.subarray(0, initial.length / 2)], /FRAME_PROTOCOL/);          // incomplete
  await deny([Buffer.from('not json\n')], /FRAME_PROTOCOL/);                         // malformed
  await deny([Buffer.from('{"z":1,"a":2}\n')], /FRAME_PROTOCOL/);                    // noncanonical
  await deny([Buffer.from('\n')], /FRAME_PROTOCOL/);                                 // empty frame
  await deny([Buffer.alloc(70 * 1024, 97)], /FRAME_LIMIT/);                          // oversized, no LF
  await deny([Buffer.concat([Buffer.alloc(64 * 1024, 97), Buffer.from('\n')])], /FRAME_LIMIT/); // oversized line
  await deny([initial, initial], /FRAME_PROTOCOL/);                                  // multiple frames
  await deny([Buffer.concat([initial, initial])], /FRAME_PROTOCOL/);                 // multiple, one chunk
  await deny([Buffer.concat([initial, Buffer.from('x')])], /FRAME_PROTOCOL/);        // trailing data
  await deny([Buffer.concat([initial.subarray(0, initial.length - 1), Buffer.from('\r\n')])], /FRAME_PROTOCOL/); // CR
});

test('receiver cancellation and EOF close the stream and create no files', async () => {
  const before = readdirSync(root).sort();
  const pre = new AbortController(); pre.abort();
  const preStream = new PassThrough();
  await assert.rejects(receiveLaunchEnvelope(preStream, { stage: 'initial',
    expected: { sessionId: 'x' }, signal: pre.signal }), /LAUNCH_CANCELLED/);
  assert.equal(preStream.destroyed, true);
  const hanging = new PassThrough();
  const controller = new AbortController();
  const pending = receiveLaunchEnvelope(hanging, { stage: 'initial',
    expected: { sessionId: 'x' }, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /LAUNCH_CANCELLED/);
  assert.equal(hanging.destroyed, true);
  const empty = new PassThrough(); empty.end();
  await assert.rejects(receiveLaunchEnvelope(empty, { stage: 'initial', expected: { sessionId: 'x' } }), /FRAME_PROTOCOL/);
  assert.equal(empty.destroyed, true);
  assert.deepEqual(readdirSync(root).sort(), before);
});

test('v3 schema gate reuses delegation validators without becoming the v3 compiler', () => {
  const authority = createHostedLaunchAuthority(profile());
  assert.throws(() => authority.prepare(ctx('tui'), launch({ spec: { ...spec(), schema: 'pi-dynamic-workflow/v2' } })),
    /UNSUPPORTED_VERSION/);
  assert.throws(() => authority.prepare(ctx('tui'), launch({ spec: { schema: 'pi-dynamic-workflow/v3', delegation: { maxDepth: 99 } } })),
    /INVALID_REQUEST/);
  const extended = { ...spec(), futureField: { anything: [1, 2, 3] } };
  const l = launch({ spec: extended });
  const grant = authority.prepare(ctx('tui'), l);
  const binding = JSON.parse(authority.consume(grant, baseAssertion(l)).initialEnvelope().toString('utf8')).binding;
  assert.equal(binding.specDigest, sha256(canonicalJSON(extended)));
});

test('no credential contents appear in envelopes, receipts, or diagnostics', async () => {
  const { initial, received, expected } = await roundTrip();
  const sentinel = new RegExp(SENTINEL);
  assert.doesNotMatch(initial.toString('utf8'), sentinel);
  assert.doesNotMatch(JSON.stringify(received.binding), sentinel);
  assert.doesNotMatch(received.handoffEnvelope().toString('utf8'), sentinel);
  let diagnostic = '';
  try {
    await receiveLaunchEnvelope(streamOf([initial]), { stage: 'initial', expected: { ...expected, sessionId: 'changed' } });
  } catch (error) { diagnostic = String(error?.message ?? error); }
  assert.match(diagnostic, /LAUNCH_MISMATCH/);
  assert.doesNotMatch(diagnostic, sentinel);
  assert.doesNotMatch(diagnostic, /auth\.json/);
});
