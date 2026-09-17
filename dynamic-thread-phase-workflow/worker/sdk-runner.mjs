// Private SDK worker entry. Trusted recipes pass only paths/setup metadata; FD4
// remains the existing bridge bootstrap consumed by worker/index.ts.
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatedResourceOptions } from './profile.mjs';

const SCHEMA = 'pi-workflow-sdk-worker/v1';
const VERSIONS = new Set(['0.85.1', '0.84.2']);
const PROVIDER = 'openai-codex';
const MODEL = 'gpt-5.6-sol';
const extensionPath = fileURLToPath(new URL('./index.ts', import.meta.url));
const ownPath = fileURLToPath(import.meta.url);
const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
const costKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'];
const stopReasons = new Set(['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']);
const compactionReasons = new Set(['manual', 'threshold', 'overflow']);

const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const validDiagnostic = value => typeof value === 'string' && value.trim() && !value.includes('\0') &&
  Buffer.from(value).toString('utf8') === value && Buffer.byteLength(value) <= 4096;
const projectUsage = value => plain(value) && tokenKeys.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0 && !Object.is(value[key], -0)) &&
  plain(value.cost) && costKeys.every(key => Number.isFinite(value.cost[key]) && value.cost[key] >= 0 && !Object.is(value.cost[key], -0)) ? {
    ...Object.fromEntries(tokenKeys.map(key => [key, value[key]])),
    cost: Object.fromEntries(costKeys.map(key => [key, value.cost[key]])),
  } : undefined;

export function projectWorkerEvent(event) {
  if (!plain(event)) return;
  if (event.type === 'turn_start') return { type: 'turn_start' };
  if (event.type === 'message_end' && plain(event.message) && event.message.role === 'assistant') {
    const usage = projectUsage(event.message.usage);
    return { type: 'message_end', message: { role: 'assistant',
      stopReason: stopReasons.has(event.message.stopReason) ? event.message.stopReason : 'error',
      ...(usage ? { usage } : {}) } };
  }
  if (event.type === 'compaction_start') return { type: 'compaction_start',
    reason: compactionReasons.has(event.reason) ? event.reason : null };
  if (event.type !== 'compaction_end') return;
  const projected = { type: 'compaction_end', reason: compactionReasons.has(event.reason) ? event.reason : null,
    aborted: typeof event.aborted === 'boolean' ? event.aborted : null,
    willRetry: typeof event.willRetry === 'boolean' ? event.willRetry : null };
  if (event.result !== undefined) {
    const usage = plain(event.result) && projectUsage(event.result.usage);
    projected.result = plain(event.result) ? { ...(usage ? { usage } : {}) } : null;
  }
  if (event.errorMessage !== undefined) projected.errorMessage =
    validDiagnostic(event.errorMessage) ? 'SDK_COMPACTION_ERROR' : null;
  return projected;
}
const absolute = (value, name) => {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) throw new Error(`INVALID_REQUEST: ${name}`);
  return value;
};

export function validateWorkerSetup(value) {
  if (!plain(value)) throw new Error('INVALID_REQUEST: setup');
  const keys = ['schema', 'sdkPackagePath', 'authPath', 'agentDir', 'tools', 'prompt'];
  if (value.schema !== SCHEMA || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value)))
    throw new Error('INVALID_REQUEST: setup');
  const sdkPackagePath = absolute(value.sdkPackagePath, 'sdkPackagePath');
  const authPath = absolute(value.authPath, 'authPath');
  const agentDir = absolute(value.agentDir, 'agentDir');
  const insideProfile = relative(agentDir, authPath);
  if (!insideProfile || !insideProfile.startsWith('..') && !isAbsolute(insideProfile)) throw new Error('INVALID_REQUEST: authPath must be outside worker profile');
  if (!Array.isArray(value.tools) || !value.tools.length || value.tools.length > 32 ||
      value.tools.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) ||
      new Set(value.tools).size !== value.tools.length) throw new Error('INVALID_REQUEST: tools');
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || Buffer.byteLength(value.prompt) > 16384 || value.prompt.includes('\0'))
    throw new Error('INVALID_REQUEST: prompt');
  return Object.freeze({ schema: SCHEMA, sdkPackagePath, authPath, agentDir, tools: Object.freeze([...value.tools]), prompt: value.prompt });
}

export async function createWorkerModelRuntime(input, hooks = {}) {
  const setup = validateWorkerSetup(input);
  if (hooks.configureModelRuntime !== undefined && typeof hooks.configureModelRuntime !== 'function') throw new Error('INVALID_REQUEST: test hook');
  const [realAgentDir, realAuthPath, authStat] = await Promise.all([realpath(setup.agentDir), realpath(setup.authPath), lstat(setup.authPath)]);
  const physical = relative(realAgentDir, realAuthPath);
  if (!authStat.isFile() || !physical || !physical.startsWith('..') && !isAbsolute(physical)) throw new Error('AUTH_UNAVAILABLE');
  const manifest = JSON.parse(await readFile(join(setup.sdkPackagePath, 'package.json'), 'utf8'));
  if (!VERSIONS.has(manifest.version)) throw new Error('UNSUPPORTED_VERSION');
  const sdk = await import(pathToFileURL(join(setup.sdkPackagePath, 'dist/index.js')).href);
  if (sdk.VERSION !== manifest.version) throw new Error('UNSUPPORTED_VERSION');
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: setup.authPath, modelsPath: null, allowModelNetwork: false });
  await hooks.configureModelRuntime?.(modelRuntime, sdk, setup);
  const model = modelRuntime.getModel(PROVIDER, MODEL);
  if (!model || modelRuntime.getProviderAuthStatus(PROVIDER).source !== 'stored') throw new Error('AUTH_UNAVAILABLE');
  const resolved = await modelRuntime.getAuth(model);
  if (!resolved || (!resolved.auth?.apiKey && !Object.keys(resolved.auth?.headers ?? {}).length)) throw new Error('AUTH_UNAVAILABLE');
  return Object.freeze({ setup, sdk, modelRuntime, model });
}

export async function createWorkerSession(input, hooks = {}) {
  const { setup, sdk, modelRuntime, model } = await createWorkerModelRuntime(input, hooks);
  if (process.env.PI_CODING_AGENT_DIR !== setup.agentDir) throw new Error('PROFILE_UNAVAILABLE');
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: process.cwd(), agentDir: setup.agentDir, settingsManager,
    additionalExtensionPaths: [extensionPath], ...isolatedResourceOptions(),
    systemPrompt: 'Execute the bounded workflow assignment using only the active private worker tools.',
    appendSystemPrompt: [],
  });
  await resourceLoader.reload();
  const extensions = resourceLoader.getExtensions();
  if (extensions.errors.length || extensions.extensions.length !== 1 || extensions.extensions[0].resolvedPath !== extensionPath)
    throw new Error('PROFILE_UNAVAILABLE');
  const { session } = await sdk.createAgentSession({
    cwd: process.cwd(), agentDir: setup.agentDir, modelRuntime, model, thinkingLevel: 'high',
    tools: setup.tools, settingsManager, resourceLoader, sessionManager: sdk.SessionManager.inMemory(process.cwd()),
  });
  return Object.freeze({ setup, session, resourceLoader });
}

export async function runWorker(input, hooks = {}) {
  const { setup, session, resourceLoader } = await createWorkerSession(input, hooks);
  let extensionFailed = false;
  const unsubscribe = session.subscribe(event => {
    const projected = projectWorkerEvent(event);
    if (projected) process.stdout.write(`${JSON.stringify(projected)}\n`);
  });
  const stop = () => { void session.abort(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    await session.bindExtensions({ mode: 'json', onError: () => { extensionFailed = true; void session.abort(); } });
    if (resourceLoader.getAgentsFiles().agentsFiles.length || resourceLoader.getSkills().skills.length || resourceLoader.getPrompts().prompts.length)
      throw new Error('DISCOVERY');
    await session.prompt(setup.prompt, { expandPromptTemplates: false });
    if (extensionFailed) throw new Error('PROFILE_UNAVAILABLE');
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); unsubscribe();
    try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); } catch {}
    session.dispose();
  }
}

if (process.argv[1] === ownPath) {
  let setup;
  try { setup = JSON.parse(process.argv[2]); await runWorker(setup); }
  catch { process.stderr.write('PI_WORKER_FAIL_STOP:SDK_WORKER\n'); process.exitCode = 70; }
}
