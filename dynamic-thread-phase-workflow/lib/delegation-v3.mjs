// Strict v3 spec compiler: pi-dynamic-workflow/v3 spec -> delegation runtime plan.
// compileV3Spec and makeV3Render are pure (no I/O). buildV3WorkerRecipe performs
// only per-node profile directory creation, the sync recipe contract. No
// runtime/store imports: the runner lazy-loads this module inside the
// post-receipt path so v2/harness startup never pays for these modules in
// THREAD_PHASE_CORE_PATH fallback environments.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { enumValue, fail, integer, list, object, text, validateDelegationPolicy, validateRootAllocations } from './delegation-contract.mjs';
import { validateDirectoryScope } from './delegation-scope.mjs';
import { canonicalJSON } from './delegation-storage.mjs';
import { profileDirectories, workerEnvironment } from '../worker/profile.mjs';
import { validateWorkerSetup } from '../worker/sdk-runner.mjs';

const SPEC_SCHEMA = 'pi-dynamic-workflow/v3';
const PHASE_NAME = /^[A-Za-z0-9_.:-]+$/;
const PERMISSIONS = ['r', 'w', 'rw', 'rwx'];
const MAX_TIMEOUT_MS = 2147483647;

const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) freeze(value[key]);
    Object.freeze(value);
  }
  return value;
};

function phaseName(value) {
  text(value, 80);
  if (!PHASE_NAME.test(value)) fail('INVALID_REQUEST', 'phase name');
  return value;
}

// Global mode rejections, checked before the exact per-type key gate so that
// unsupported modes report UNSUPPORTED_MODE instead of INVALID_REQUEST. The
// launch binding pins openai-codex/gpt-5.6-sol; retries and dynamic fanout
// items are not expressible in v3. attempts:1 falls through to the key gate.
function rejectUnsupportedModes(container) {
  if (container.model !== undefined) fail('UNSUPPORTED_MODE', 'model is pinned by the launch binding');
  if (container.retry !== undefined || (container.attempts !== undefined && container.attempts !== 1)) fail('UNSUPPORTED_MODE', 'no retries');
  if (container.itemsFrom !== undefined) fail('UNSUPPORTED_MODE', 'no dynamic fanout items');
}

export function compileV3Spec(spec) {
  if (!spec || Object.getPrototypeOf(spec) !== Object.prototype) fail('INVALID_REQUEST', 'v3 spec');
  rejectUnsupportedModes(spec);
  object(spec, ['schema', 'delegation', 'phases'], ['name']);
  if (spec.schema !== SPEC_SCHEMA) fail('UNSUPPORTED_VERSION', 'spec schema');
  if (spec.name !== undefined) phaseName(spec.name);
  const policy = validateDelegationPolicy(spec.delegation);
  const phases = list(spec.phases, 30, 1);
  const names = new Set();
  const groups = [];
  const rootInfo = new Map();
  const artifactContents = new Map();
  const compiledPhases = phases.map((phase, phaseIndex) => {
    if (!phase || Object.getPrototypeOf(phase) !== Object.prototype) fail('INVALID_REQUEST', 'phase');
    rejectUnsupportedModes(phase);
    phaseName(phase.name);
    if (names.has(phase.name)) fail('INVALID_REQUEST', 'duplicate phase name');
    names.add(phase.name);
    if (phase.type === 'agent' || phase.type === 'fanout') {
      object(phase, ['type', 'name', 'prompt'], ['contextTemplate', 'agentBudget', 'permissions', 'directoryScope', 'timeoutMs',
        ...(phase.type === 'fanout' ? ['items', 'concurrency', 'failOnItemFailure'] : [])]);
      text(phase.prompt, 4096);
      if (phase.contextTemplate !== undefined) text(phase.contextTemplate, 2048, true);
      const agentBudget = phase.agentBudget === undefined ? 1 : integer(phase.agentBudget, 1, 128);
      const permissions = phase.permissions === undefined ? 'r' : enumValue(phase.permissions, PERMISSIONS);
      const directoryScope = phase.directoryScope === undefined ? undefined : validateDirectoryScope(phase.directoryScope, permissions);
      if (phase.timeoutMs !== undefined) integer(phase.timeoutMs, 1, MAX_TIMEOUT_MS);
      const group = { phaseIndex, agentBudget, ...(directoryScope ? { directoryScope } : {}) };
      const compiled = { type: phase.type, name: phase.name, ...(phase.timeoutMs === undefined ? {} : { timeoutMs: phase.timeoutMs }) };
      if (phase.type === 'fanout') {
        list(phase.items, 128, 1).forEach((item) => {
          if (typeof item !== 'string') fail('INVALID_REQUEST', 'static string fanout items');
          text(item, 4096, true);
        });
        group.items = [...phase.items];
        compiled.items = [...phase.items];
        if (phase.concurrency !== undefined) compiled.concurrency = integer(phase.concurrency, 1, 64);
        if (phase.failOnItemFailure !== undefined) {
          if (typeof phase.failOnItemFailure !== 'boolean') fail('INVALID_REQUEST', 'failOnItemFailure');
          compiled.failOnItemFailure = phase.failOnItemFailure;
        }
      }
      groups.push(group);
      rootInfo.set(phaseIndex, { name: phase.name, items: group.items, taskTemplate: phase.prompt,
        ...(phase.contextTemplate === undefined ? {} : { contextTemplate: phase.contextTemplate }), permissions });
      return compiled;
    }
    if (phase.type === 'shell') {
      object(phase, ['type', 'name', 'command'], ['timeoutMs']);
      text(phase.command, 16384);
      if (phase.timeoutMs !== undefined) integer(phase.timeoutMs, 1, MAX_TIMEOUT_MS);
      // Shell/artifact phases get NO delegation roots structurally; the runtime's
      // enumerated check hard-fails any mismatch.
      return { type: 'shell', name: phase.name, command: phase.command, permissions: 'rwx',
        ...(phase.timeoutMs === undefined ? {} : { timeoutMs: phase.timeoutMs }) };
    }
    if (phase.type === 'artifact') {
      object(phase, ['type', 'name'], ['content', 'from']);
      const hasContent = phase.content !== undefined, hasFrom = phase.from !== undefined;
      if (hasContent === hasFrom) fail('INVALID_REQUEST', 'exactly one of content or from');
      if (hasContent) { text(phase.content, 1024 * 1024, true); artifactContents.set(phase.name, phase.content); }
      if (hasFrom && (typeof phase.from !== 'string' || !names.has(phase.from) || phase.from === phase.name)) {
        fail('INVALID_REQUEST', 'artifact source must be a prior phase');
      }
      return { type: 'artifact', name: phase.name, ...(hasFrom ? { from: phase.from } : {}) };
    }
    fail('UNSUPPORTED_MODE', 'agent/fanout/shell/artifact phases only');
  });
  if (!groups.length) fail('INVALID_REQUEST', 'v3 spec has no agent/fanout delegation roots');
  // Budget/depth/scope narrowing and (phaseIndex, itemIndex) enumeration order
  // are contract-owned; allocations zip back to phases in that order.
  const allocations = validateRootAllocations(policy, groups);
  const roots = allocations.map((allocation) => {
    const info = rootInfo.get(allocation.phaseIndex);
    return freeze({
      phaseIndex: allocation.phaseIndex,
      ...(allocation.itemIndex === undefined ? {} : { itemIndex: allocation.itemIndex }),
      agentBudget: allocation.agentBudget,
      label: allocation.itemIndex === undefined ? info.name : String(info.items[allocation.itemIndex]),
      permissions: info.permissions,
      directoryScope: allocation.directoryScope,
      deadlineAt: null,
      taskTemplate: info.taskTemplate,
      ...(info.contextTemplate === undefined ? {} : { contextTemplate: info.contextTemplate }),
    });
  });
  return freeze({ policy, phases: freeze(compiledPhases), roots: freeze(roots), artifactContents });
}

// Trusted render callback for createDelegationRuntime. Unknown/forward phase
// references are already rejected statically by the runtime's
// validatePriorReferences; a missing resolved output still fails closed here.
export function makeV3Render(compiled) {
  const substitute = (template, outputs, root) => String(template).replace(/\{\{\s*([^}]+?)\s*\}\}/gu, (_match, raw) => {
    const key = String(raw).trim();
    if (key === 'item' || key === 'index') {
      if (!root || root.itemIndex === undefined) fail('INVALID_REQUEST', `${key} outside a fanout root`);
      return key === 'item' ? root.label : String(root.itemIndex);
    }
    const name = key.startsWith('outputs.') ? key.slice('outputs.'.length) : key.startsWith('output:') ? key.slice('output:'.length) : null;
    if (name === null || !Object.hasOwn(outputs, name)) fail('INVALID_REQUEST', `unknown phase output: ${key}`);
    const value = outputs[name];
    return typeof value === 'string' ? value : canonicalJSON(value);
  });
  return (input) => {
    if (input?.kind === 'roots') {
      return input.roots.map((root) => {
        const task = substitute(root.taskTemplate, input.outputs, root);
        text(task, 4096);
        if (root.contextTemplate === undefined) return { task };
        const parentContextSummary = substitute(root.contextTemplate, input.outputs, root);
        text(parentContextSummary, 2048, true);
        return { task, parentContextSummary };
      });
    }
    if (input?.kind === 'shell') return substitute(input.value, input.outputs);
    if (input?.kind === 'artifact') {
      if (compiled.artifactContents.has(input.phase?.name)) return compiled.artifactContents.get(input.phase.name);
      const source = input.value;
      return typeof source === 'string' ? source : canonicalJSON(source === undefined ? null : source);
    }
    fail('INVALID_REQUEST', 'render kind');
  };
}

// Runtime worker recipe. tools mirrors the runtime's own computation, so
// bridge-prepared tools, setup tools and assertToolProfile names are identical.
export function buildV3WorkerRecipe({ node, nodes, binding, workersRoot, policy }) {
  let depth = 0, current = node;
  while (current.parentNodeId) {
    depth++;
    current = nodes.find((entry) => entry.nodeId === current.parentNodeId);
    if (!current) fail('INVALID_REQUEST', 'parent chain');
  }
  const tools = [...node.authority.grantedTools, 'workflow_context', 'workflow_complete',
    ...(depth < policy.maxDepth ? ['workflow_delegate'] : [])];
  const dirs = profileDirectories(join(workersRoot, node.nodeId));
  for (const directory of Object.values(dirs)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const setup = validateWorkerSetup({
    schema: 'pi-workflow-sdk-worker/v1',
    sdkPackagePath: binding.worker.sdkPackagePath,
    authPath: binding.worker.authPath,
    agentDir: dirs.agentDir,
    tools,
    prompt: node.assignment.task,
  });
  // No onStdout: the usage tap is independent of recipe callbacks. No socket
  // env: the FD4 bootstrap carries the bridge endpoint.
  return {
    command: process.execPath,
    args: [binding.worker.workerEntryPath, JSON.stringify(setup)],
    tools,
    env: workerEnvironment({ ...dirs, nodePath: process.execPath }),
  };
}
