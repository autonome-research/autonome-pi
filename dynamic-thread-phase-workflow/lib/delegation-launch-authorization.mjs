// Private host-bound recursive launch authorization. PUBLIC V3 STAYS DISCONNECTED:
// neither index.ts nor bin/dynamic-thread-phase-workflow.mjs imports this module yet.
// Grants, transfers and receipts are exact in-process objects (WeakMap identity, no
// caller-visible fields); one bounded canonical LF-terminated frame crosses only the
// future trusted spawn/handoff pipe. An FD number, CLI flag, environment value or
// caller JSON is never authority. Hostile same-user code that duplicates the exact
// wire protocol and accessible descriptors is NOT contained (no broker/trust anchor).
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { canonicalJSON, decodeCanonical, sha256, canonicalDirectory } from './delegation-storage.mjs';
import { fail, object, text, integer, id, hash, enumValue, LIMITS, validateDelegationPolicy } from './delegation-contract.mjs';

export const LAUNCH_BINDING_SCHEMA = 'pi-workflow-launch-authorization/v1';
export const LAUNCH_ENVELOPE_SCHEMA = 'pi-workflow-launch-envelope/v1';
// Trusted worker recipe constants mirror worker/sdk-runner.mjs; never caller input.
const WORKER_SETUP_SCHEMA = 'pi-workflow-sdk-worker/v1';
const PROVIDER = 'openai-codex';
const WORKER_MODEL = 'gpt-5.6-sol';
const HOST_MODEL = `${PROVIDER}/${WORKER_MODEL}`;
const THINKING = 'high';
const STAGES = Object.freeze(['initial', 'detached']);
const MAX_FRAME = LIMITS.frameBytes;
const MIN_CADENCE_MS = 60_000;
const MAX_CADENCE_MS = 86_400_000;

const BINDING_KEYS = ['schema', 'launchId', 'hostMode', 'sessionId', 'sessionFile', 'model', 'cwd',
  'specDigest', 'policyDigest', 'background', 'supervision', 'progressReviewIntervalMs',
  'effective', 'worker', 'resourceProfileDigest'];
const WORKER_KEYS = ['setup', 'provider', 'model', 'thinking', 'sdkPackagePath', 'workerEntryPath', 'authPath'];
const ASSERTION_KEYS = BINDING_KEYS.filter(k => k !== 'schema' && k !== 'launchId');

const grantStates = new WeakMap();
const transferStates = new WeakMap();
const receiptStates = new WeakMap();

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
function pathString(value, name) {
  text(value, 4096);
  if (resolve(value) !== value) fail('INVALID_REQUEST', `${name} not normalized`);
  return value;
}
function canonicalPath(value, name) { // path form only; file contents are never read here
  pathString(value, name);
  let real;
  try { real = fs.realpathSync(value); } catch { fail('SCOPE_DENIED', `${name} unavailable`); }
  if (real !== value) fail('INVALID_REQUEST', `${name} not canonical`);
  return value;
}
function canonicalWorkingDirectory(value) {
  text(value, 4096);
  let real;
  try { real = fs.realpathSync(value); } catch { fail('SCOPE_DENIED', 'cwd unavailable'); }
  return canonicalDirectory(real);
}
function validateWorkerBinding(value) {
  object(value, WORKER_KEYS);
  if (value.setup !== WORKER_SETUP_SCHEMA) fail('UNAUTHORIZED', 'worker setup schema');
  if (value.provider !== PROVIDER || value.model !== WORKER_MODEL || value.thinking !== THINKING) fail('UNAUTHORIZED', 'worker recipe');
  pathString(value.sdkPackagePath, 'sdkPackagePath');
  pathString(value.workerEntryPath, 'workerEntryPath');
  pathString(value.authPath, 'authPath');
}
// Strict shape/policy gate for a binding, whether locally built or received off the
// wire. Digests and paths are bound, never recomputed or read here.
export function validateLaunchBinding(value) {
  object(value, BINDING_KEYS);
  if (value.schema !== LAUNCH_BINDING_SCHEMA) fail('UNAUTHORIZED', 'binding schema');
  id(value.launchId);
  enumValue(value.hostMode, ['tui', 'rpc']);
  text(value.sessionId, 256);
  if (value.sessionFile !== null) text(value.sessionFile, 4096);
  if (value.model !== HOST_MODEL) fail('UNAUTHORIZED', 'host model');
  pathString(value.cwd, 'cwd');
  hash(value.specDigest); hash(value.policyDigest); hash(value.resourceProfileDigest);
  if (typeof value.background !== 'boolean') fail('INVALID_REQUEST', 'background');
  enumValue(value.supervision, ['supervised', 'foreground']);
  if (value.supervision !== (value.background ? 'supervised' : 'foreground')) fail('UNAUTHORIZED', 'supervision');
  if (value.progressReviewIntervalMs !== null) {
    integer(value.progressReviewIntervalMs, MIN_CADENCE_MS, MAX_CADENCE_MS);
    if (!value.background) fail('UNAUTHORIZED', 'foreground cadence');
  }
  object(value.effective, ['maxConcurrentAgents', 'maxLiveAgents']);
  integer(value.effective.maxConcurrentAgents, 1, 128);
  integer(value.effective.maxLiveAgents, 1, 128);
  validateWorkerBinding(value.worker);
  return value;
}
function validAssertion(expected) {
  object(expected, [], ASSERTION_KEYS);
  if (!Object.keys(expected).length) fail('INVALID_REQUEST', 'empty launch expectation');
}
function matchAssertion(expected, binding) {
  for (const key of Object.keys(expected)) {
    if (canonicalJSON(expected[key]) !== canonicalJSON(binding[key])) fail('LAUNCH_MISMATCH', `launch field ${key}`);
  }
}
function envelopeFrame(stage, binding) {
  const bytes = Buffer.from(`${canonicalJSON({ schema: LAUNCH_ENVELOPE_SCHEMA, stage, binding })}\n`);
  if (bytes.length > MAX_FRAME) fail('FRAME_LIMIT');
  return bytes;
}

/** Trusted host-side authority. The profile carries only nonsecret canonical paths,
 * a JSON resource profile to digest, and operator-cap ceilings. No environment input,
 * no credential contents, no spec compilation beyond the v3 schema gate.
 */
export function createHostedLaunchAuthority(profile) {
  object(profile, ['sdkPackagePath', 'workerEntryPath', 'authPath', 'resourceProfile', 'limits']);
  const workerPaths = Object.freeze({
    sdkPackagePath: canonicalPath(profile.sdkPackagePath, 'sdkPackagePath'),
    workerEntryPath: canonicalPath(profile.workerEntryPath, 'workerEntryPath'),
    authPath: canonicalPath(profile.authPath, 'authPath'),
  });
  const resourceProfileDigest = sha256(canonicalJSON(profile.resourceProfile));
  object(profile.limits, ['maxConcurrentAgents', 'maxLiveAgents']);
  const ceilings = deepFreeze(structuredClone(profile.limits));
  integer(ceilings.maxConcurrentAgents, 1, 128);
  integer(ceilings.maxLiveAgents, 1, 128);
  const owner = {};
  return Object.freeze({
    prepare(ctx, launch) {
      if (ctx?.mode !== 'tui' && ctx?.mode !== 'rpc') fail('UNAUTHORIZED', 'hosted tui/rpc context required');
      if (typeof ctx.sessionManager?.getSessionId !== 'function') fail('UNAUTHORIZED', 'host session required');
      const sessionId = text(ctx.sessionManager.getSessionId(), 256);
      let sessionFile = null;
      if (typeof ctx.sessionManager.getSessionFile === 'function') {
        const file = ctx.sessionManager.getSessionFile();
        sessionFile = file === undefined ? null : text(file, 4096);
      }
      object(launch, ['spec', 'cwd', 'background'], ['progressReviewIntervalMs', 'operator']);
      if (typeof launch.background !== 'boolean') fail('INVALID_REQUEST', 'background');
      const spec = launch.spec;
      if (!spec || Object.getPrototypeOf(spec) !== Object.prototype) fail('INVALID_REQUEST', 'spec');
      // Schema gate only; the future v3 compiler owns full spec semantics.
      if (spec.schema !== 'pi-dynamic-workflow/v3') fail('UNSUPPORTED_VERSION', 'spec schema');
      const policy = validateDelegationPolicy(spec.delegation);
      const cadence = launch.progressReviewIntervalMs === undefined ? null
        : integer(launch.progressReviewIntervalMs, MIN_CADENCE_MS, MAX_CADENCE_MS);
      if (cadence !== null && !launch.background) fail('INVALID_REQUEST', 'cadence requires background');
      if (launch.operator !== undefined) object(launch.operator, [], ['maxConcurrentAgents', 'maxLiveAgents']);
      const effective = Object.freeze({
        maxConcurrentAgents: integer(launch.operator?.maxConcurrentAgents ?? ceilings.maxConcurrentAgents, 1, ceilings.maxConcurrentAgents),
        maxLiveAgents: integer(launch.operator?.maxLiveAgents ?? ceilings.maxLiveAgents, 1, ceilings.maxLiveAgents),
      });
      const binding = validateLaunchBinding({
        schema: LAUNCH_BINDING_SCHEMA, launchId: randomUUID(), hostMode: ctx.mode, sessionId, sessionFile,
        model: HOST_MODEL, cwd: canonicalWorkingDirectory(launch.cwd),
        specDigest: sha256(canonicalJSON(spec)), policyDigest: sha256(canonicalJSON(policy)),
        background: launch.background, supervision: launch.background ? 'supervised' : 'foreground',
        progressReviewIntervalMs: cadence, effective,
        worker: { setup: WORKER_SETUP_SCHEMA, provider: PROVIDER, model: WORKER_MODEL, thinking: THINKING, ...workerPaths },
        resourceProfileDigest,
      });
      envelopeFrame('initial', binding); // fail early if the binding cannot fit one frame
      const grant = Object.freeze({});
      grantStates.set(grant, { owner, binding: deepFreeze(binding), consumed: false });
      return grant;
    },
    consume(grant, expectedLaunch) {
      const record = grantStates.get(grant);
      if (!record || record.owner !== owner) fail('UNAUTHORIZED', 'unknown grant');
      if (record.consumed) fail('UNAUTHORIZED', 'grant consumed');
      record.consumed = true; // burn first: a mismatched or replayed grant never relaunches
      validAssertion(expectedLaunch);
      matchAssertion(expectedLaunch, record.binding);
      const transfer = Object.freeze({
        initialEnvelope() {
          const state = transferStates.get(this);
          if (!state) fail('UNAUTHORIZED', 'unknown transfer');
          return Buffer.from(state.frame);
        },
      });
      transferStates.set(transfer, { frame: envelopeFrame('initial', record.binding) });
      return transfer;
    },
  });
}

/** Receiver side of the trusted pipe. Exactly one bounded canonical LF frame; the
 * stream is always destroyed on return, denial, cancellation or EOF. No files are
 * created on any path.
 */
export async function receiveLaunchEnvelope(stream, options) {
  object(options, ['stage', 'expected'], ['signal']);
  enumValue(options.stage, STAGES);
  validAssertion(options.expected);
  const signal = options.signal;
  if (signal !== undefined && (typeof signal?.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) fail('INVALID_REQUEST', 'signal');
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function' || typeof stream.destroy !== 'function') fail('INVALID_REQUEST', 'stream');
  if (signal?.aborted) { stream.destroy(); fail('LAUNCH_CANCELLED'); }
  const onAbort = () => stream.destroy();
  signal?.addEventListener('abort', onAbort, { once: true });
  let frameLine = null, trailing = false, pending = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      if (frameLine !== null || trailing) { trailing = true; break; }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending = pending.length ? Buffer.concat([pending, bytes]) : Buffer.from(bytes);
      const at = pending.indexOf(10);
      if (at < 0) {
        if (pending.length > MAX_FRAME) fail('FRAME_LIMIT');
        continue;
      }
      if (at + 1 > MAX_FRAME) fail('FRAME_LIMIT');
      frameLine = pending.subarray(0, at);
      if (at + 1 < pending.length) { trailing = true; break; }
      pending = Buffer.alloc(0);
    }
  } catch (error) {
    // Abort destroys the stream; surface cancellation, never plumbing errors.
    if (signal?.aborted) fail('LAUNCH_CANCELLED');
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    stream.destroy();
  }
  if (signal?.aborted) fail('LAUNCH_CANCELLED');
  if (trailing) fail('FRAME_PROTOCOL', 'trailing frame data');
  if (frameLine === null) fail('FRAME_PROTOCOL', 'incomplete frame');
  if (frameLine.includes(13)) fail('FRAME_PROTOCOL', 'carriage return');
  let envelope;
  try { envelope = decodeCanonical(frameLine); }
  catch { fail('FRAME_PROTOCOL', 'malformed or noncanonical frame'); }
  object(envelope, ['schema', 'stage', 'binding']);
  if (envelope.schema !== LAUNCH_ENVELOPE_SCHEMA || envelope.stage !== options.stage) fail('UNAUTHORIZED', 'envelope stage/schema');
  const binding = validateLaunchBinding(envelope.binding);
  matchAssertion(options.expected, binding);
  const frozen = deepFreeze(structuredClone(binding));
  const receipt = Object.freeze({
    binding: frozen,
    handoffEnvelope() {
      const state = receiptStates.get(this);
      if (!state || state.used) fail('UNAUTHORIZED', 'handoff unavailable');
      state.used = true;
      return envelopeFrame('detached', frozen);
    },
  });
  receiptStates.set(receipt, { used: false });
  return receipt;
}
