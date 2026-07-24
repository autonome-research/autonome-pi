#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PiJsonEventCollector } from "../lib/pi-json-stream.mjs";
import { normalizeTimeoutMs, runBoundedProcess, terminateChild } from "../lib/subprocess.mjs";
import {
  ARTIFACTS_DIR,
  STATUSES,
  artifact,
  completeRun,
  createRun,
  failRun,
  phaseEnd,
  phaseEvent,
  phaseStart,
  readCancellation,
  wrapPhases,
} from "../../thread-phase-visualizer/lib/store.mjs";

const DEFAULT_PI = process.env.PI_DYNAMIC_WORKFLOW_PI_BIN
  || process.env.PI_DYNAMIC_THREAD_PHASE_PI_BIN
  || (existsSync(join(homedir(), ".npm-global", "bin", "pi"))
    ? join(homedir(), ".npm-global", "bin", "pi")
    : "pi");

const PI_TOOL_REQUIREMENTS = Object.freeze({
  read: "r",
  grep: "r",
  find: "r",
  ls: "r",
  edit: "w",
  write: "w",
  bash: "rwx",
});
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_FANOUT_CONCURRENCY = 3;
const MAX_FANOUT_CONCURRENCY = Number(process.env.PI_DYNAMIC_WORKFLOW_MAX_CONCURRENCY || process.env.PI_DYNAMIC_THREAD_PHASE_MAX_CONCURRENCY || 64);
const MAX_FANOUT_ITEMS = Number(process.env.PI_DYNAMIC_WORKFLOW_MAX_FANOUT_ITEMS || process.env.PI_DYNAMIC_THREAD_PHASE_MAX_FANOUT_ITEMS || 1_000);
const MAX_PHASE_TIMEOUT_MS = Number(process.env.PI_DYNAMIC_WORKFLOW_MAX_PHASE_TIMEOUT_MS || process.env.PI_DYNAMIC_THREAD_PHASE_MAX_PHASE_TIMEOUT_MS || 60 * 60 * 1000);
const MAX_OUTPUT_BYTES = 250_000;
const DEFAULT_PERMISSIONS = normalizePermissions(process.env.PI_DYNAMIC_WORKFLOW_DEFAULT_PERMISSIONS || process.env.PI_DYNAMIC_THREAD_PHASE_DEFAULT_PERMISSIONS || "r", "PI_DYNAMIC_WORKFLOW_DEFAULT_PERMISSIONS");
const MAX_PERMISSIONS = normalizePermissions(process.env.PI_DYNAMIC_WORKFLOW_MAX_PERMISSIONS || process.env.PI_DYNAMIC_THREAD_PHASE_MAX_PERMISSIONS || "rwx", "PI_DYNAMIC_WORKFLOW_MAX_PERMISSIONS");

async function loadThreadPhaseCore() {
  try {
    const [core, patterns] = await Promise.all([
      import("@autonome-research/thread-phase"),
      import("@autonome-research/thread-phase/patterns"),
    ]);
    return { ...core, ...patterns };
  } catch {
    const corePath = process.env.THREAD_PHASE_CORE_PATH || join(
      homedir(), ".npm-global", "lib", "node_modules", "@autonome-research", "thread-phase-cli",
      "node_modules", "@autonome-research", "thread-phase", "dist", "index.js",
    );
    const patternsPath = join(resolve(corePath, ".."), "patterns", "index.js");
    const [core, patterns] = await Promise.all([import(corePath), import(patternsPath)]);
    return { ...core, ...patterns };
  }
}

const threadPhaseCore = await loadThreadPhaseCore();
for (const name of ["PipelineCache", "boundedFanout", "runPipeline", "withRetry"]) {
  if (typeof threadPhaseCore[name] !== "function") {
    throw new Error(`thread-phase v5 compatibility error: missing callable export ${name}`);
  }
}
const { PipelineCache, boundedFanout, runPipeline, withRetry } = threadPhaseCore;

const activeChildren = new Set();
let activeRun;
let activeAbortController;
let cancellationRequested = false;

function abortError(reason = "cancelled") {
  const error = new Error(String(reason));
  error.name = "AbortError";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError" || /aborted|cancelled/i.test(String(error?.message || error));
}

function requestCancel(signalName = "SIGTERM") {
  cancellationRequested = true;
  if (activeAbortController && !activeAbortController.signal.aborted) activeAbortController.abort(signalName);
  for (const child of activeChildren) terminateChild(child, "SIGTERM");
}

function watchCancellation(run, controller) {
  const timer = setInterval(() => {
    const request = readCancellation(run.runId);
    if (!request) return;
    cancellationRequested = true;
    if (!controller.signal.aborted) controller.abort(request.reason || "cancelled from monitor");
    for (const child of activeChildren) terminateChild(child, "SIGTERM");
  }, 250);
  timer.unref?.();
  return () => clearInterval(timer);
}

process.once("SIGTERM", () => requestCancel("SIGTERM"));
process.once("SIGINT", () => requestCancel("SIGINT"));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = arg.slice(2, eq === -1 ? undefined : eq);
      if (eq !== -1) out[key] = arg.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
      else out[key] = true;
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeName(value) {
  return String(value || "artifact").replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "artifact";
}

function compactText(text, maxBytes = MAX_OUTPUT_BYTES) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = text.slice(0, maxBytes);
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return `${out}\n\n[truncated: original output was ${Buffer.byteLength(text, "utf8")} bytes]`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function validateName(name, label) {
  if (!name || typeof name !== "string") throw new Error(`${label}.name must be a non-empty string`);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) throw new Error(`${label}.name may only contain letters, numbers, _, ., :, and -`);
}

function normalizePublicSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || !Array.isArray(spec.phases)) return spec;
  return {
    ...spec,
    phases: spec.phases.map((phase) => {
      if (!phase || typeof phase !== "object" || Array.isArray(phase)) return phase;
      if (phase.type === "agent") return { ...phase, type: "pi" };
      if (phase.type === "fanout") {
        const { prompt, ...rest } = phase;
        return { ...rest, type: "fanout_pi", promptTemplate: prompt };
      }
      return phase;
    }),
  };
}

function validateSpec(input) {
  const spec = normalizePublicSpec(input);
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("spec must be an object");
  const workflowKeys = new Set(["schema", "name", "description", "phases", "permissions", "cwd", "model", "timeoutMs", "concurrency", "autoContinue", "metadata"]);
  rejectUnknownKeys(spec, workflowKeys, "spec");
  if (spec.schema !== undefined && spec.schema !== "pi-dynamic-workflow/v1") throw new Error(`unsupported spec.schema: ${spec.schema}`);
  if (spec.name !== undefined) validateName(spec.name, "spec");
  if (!Array.isArray(spec.phases) || spec.phases.length === 0) throw new Error("spec.phases must be a non-empty array");
  if (spec.phases.length > 30) throw new Error("spec.phases is capped at 30 phases");
  if (spec.permissions !== undefined) {
    const permissions = normalizePermissions(spec.permissions, "spec.permissions");
    assertWithinMaxPermissions(permissions, "spec.permissions");
  }
  validatePositiveInteger(spec.concurrency, "spec.concurrency", MAX_FANOUT_CONCURRENCY);
  validateTimeout(spec.timeoutMs, "spec.timeoutMs");

  const seen = new Set();
  for (let i = 0; i < spec.phases.length; i++) {
    const phase = spec.phases[i];
    if (!phase || typeof phase !== "object" || Array.isArray(phase)) throw new Error(`phase ${i} must be an object`);
    validateName(phase.name, `phase ${i}`);
    if (seen.has(phase.name)) throw new Error(`duplicate phase name: ${phase.name}`);
    if (!["shell", "pi", "fanout_pi", "artifact"].includes(phase.type)) throw new Error(`unsupported phase type for ${phase.name}: ${phase.type}`);

    const common = ["type", "name", "description", "permissions", "timeoutMs", "artifact", "retry"];
    const typeKeys = {
      shell: ["command"],
      pi: ["prompt", "tools", "model"],
      fanout_pi: ["promptTemplate", "items", "itemsFrom", "concurrency", "label", "tools", "model", "failOnItemFailure"],
      artifact: ["content", "from", "title", "fileName", "kind"],
    }[phase.type];
    rejectUnknownKeys(phase, new Set([...common, ...typeKeys]), `phase ${phase.name}`);
    validateTimeout(phase.timeoutMs, `${phase.name}.timeoutMs`);
    validateRetry(phase.retry, phase.name);

    const effectivePermissions = normalizePermissions(phase.permissions ?? spec.permissions ?? DEFAULT_PERMISSIONS, `${phase.name}.permissions`);
    assertWithinMaxPermissions(effectivePermissions, `${phase.name}.permissions`);

    if (phase.type === "shell") {
      requireNonEmptyString(phase.command, `${phase.name}.command`);
      if (!permissionIncludesAll(effectivePermissions, "rwx")) throw new Error(`shell phase ${phase.name} requires rwx permissions`);
    }
    if (phase.type === "pi") {
      requireNonEmptyString(phase.prompt, `${phase.name}.prompt`);
      normalizePiTools(phase.tools, effectivePermissions, phase.name);
      validateTemplateReferences(phase.prompt, seen, `${phase.name}.prompt`);
    }
    if (phase.type === "fanout_pi") {
      requireNonEmptyString(phase.promptTemplate, `${phase.name}.promptTemplate`);
      const hasItems = phase.items !== undefined;
      const hasItemsFrom = phase.itemsFrom !== undefined;
      if (hasItems === hasItemsFrom) throw new Error(`${phase.name} must provide exactly one of items or itemsFrom`);
      if (hasItems) {
        if (!Array.isArray(phase.items) || phase.items.length === 0) throw new Error(`${phase.name}.items must be a non-empty array`);
        if (phase.items.length > MAX_FANOUT_ITEMS) throw new Error(`${phase.name}.items is capped at ${MAX_FANOUT_ITEMS} items`);
        if (!phase.items.every((item) => ["string", "number", "boolean"].includes(typeof item))) throw new Error(`${phase.name}.items may contain only strings, numbers, or booleans`);
      } else {
        requirePriorPhase(phase.itemsFrom, seen, `${phase.name}.itemsFrom`);
      }
      if (phase.concurrency !== undefined) validatePositiveInteger(phase.concurrency, `${phase.name}.concurrency`, MAX_FANOUT_CONCURRENCY);
      normalizePiTools(phase.tools, effectivePermissions, phase.name);
      validateTemplateReferences(phase.promptTemplate, seen, `${phase.name}.promptTemplate`);
    }
    if (phase.type === "artifact") {
      const hasContent = phase.content !== undefined;
      const hasFrom = phase.from !== undefined;
      if (hasContent === hasFrom) throw new Error(`${phase.name} must provide exactly one of content or from`);
      if (hasContent && typeof phase.content !== "string") throw new Error(`${phase.name}.content must be a string`);
      if (hasFrom) requirePriorPhase(phase.from, seen, `${phase.name}.from`);
      if (hasContent) validateTemplateReferences(phase.content, seen, `${phase.name}.content`);
    }
    validateArtifactSpec(phase.artifact, phase.name);
    seen.add(phase.name);
  }
  return spec;
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} has unsupported field(s): ${unknown.join(", ")}`);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function validatePositiveInteger(value, label, max) {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${label} must be an integer between 1 and ${max}`);
}

function validateTimeout(value, label) {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PHASE_TIMEOUT_MS) throw new Error(`${label} must be an integer between 1 and ${MAX_PHASE_TIMEOUT_MS}`);
}

function validateRetry(retry, phaseName) {
  if (retry === undefined) return;
  if (!retry || typeof retry !== "object" || Array.isArray(retry)) throw new Error(`${phaseName}.retry must be an object`);
  rejectUnknownKeys(retry, new Set(["maxAttempts", "baseDelayMs"]), `${phaseName}.retry`);
  validatePositiveInteger(retry.maxAttempts, `${phaseName}.retry.maxAttempts`, 5);
  if (retry.baseDelayMs !== undefined && (!Number.isSafeInteger(retry.baseDelayMs) || retry.baseDelayMs < 0 || retry.baseDelayMs > 60_000)) throw new Error(`${phaseName}.retry.baseDelayMs must be an integer from 0 to 60000`);
}

function requirePriorPhase(reference, seen, label) {
  if (typeof reference !== "string" || !seen.has(reference)) throw new Error(`${label} must reference an earlier phase`);
}

function validateTemplateReferences(template, seen, label) {
  for (const match of String(template).matchAll(/\{\{\s*(?:output:|outputs\.)([^}\s]+)\s*\}\}/g)) {
    if (!seen.has(match[1])) throw new Error(`${label} references unknown or later output: ${match[1]}`);
  }
}

function validateArtifactSpec(value, phaseName) {
  if (value === undefined || typeof value === "boolean") return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${phaseName}.artifact must be a boolean or object`);
  rejectUnknownKeys(value, new Set(["kind", "title", "fileName", "titleTemplate", "fileNameTemplate"]), `${phaseName}.artifact`);
}

function loadSpec(args) {
  if (args["spec-file"]) return JSON.parse(readFileSync(String(args["spec-file"]), "utf8"));
  if (args.spec) return JSON.parse(String(args.spec));
  throw new Error("Provide --spec-file PATH or --spec JSON, or --harness-file PATH");
}

function generatedInputDirectory(inputFile) {
  const file = resolve(String(inputFile));
  const directory = dirname(file);
  const tempRoot = realpathSync(tmpdir());
  const directoryStats = lstatSync(directory);
  const allowedFiles = new Set(["workflow-spec.json", "workflow-harness.mjs"]);
  // --cleanup-input is an internal handshake with the Pi extension. Validate
  // the real filesystem objects, not only a lexical /tmp prefix: a symlinked
  // matching directory must never redirect deletion into unrelated data.
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()
      || dirname(realpathSync(directory)) !== tempRoot
      || !basename(directory).startsWith("pi-dynamic-workflow-")
      || !allowedFiles.has(basename(file))) {
    throw new Error(`refusing to clean non-generated workflow input: ${file}`);
  }
  return directory;
}

function preflightHarnessFile(inputFile) {
  const file = resolve(String(inputFile));
  const stats = statSync(file);
  if (!stats.isFile()) throw new Error(`workflow harness must be a regular file: ${file}`);
  accessSync(file, fsConstants.R_OK);
  return file;
}

function cleanupGeneratedInput(inputFile) {
  const file = resolve(String(inputFile));
  const directory = generatedInputDirectory(file);
  const fileStats = lstatSync(file);
  if (fileStats.isSymbolicLink() || !fileStats.isFile()) throw new Error(`refusing to clean non-regular workflow input: ${file}`);
  // Delete only the owned input file. Removing the whole directory recursively
  // would let a caller erase unrelated files by choosing a matching temp name.
  rmSync(file, { force: true });
  try { rmdirSync(directory); } catch (error) {
    if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
  }
}

function isTruthyFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function isBooleanLiteral(value) {
  return ["1", "0", "true", "false", "yes", "no", "on", "off"].includes(String(value || "").trim().toLowerCase());
}

function stripBackgroundArgs(argv) {
  const next = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--background") {
      if (i + 1 < argv.length && isBooleanLiteral(argv[i + 1])) i++;
      continue;
    }
    if (arg.startsWith("--background=")) continue;
    next.push(arg);
  }
  return next;
}

async function maybeBackground(rawArgv, opts) {
  if (process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND || process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND) return false;
  if (!isTruthyFlag(opts.background)) return false;
  const readyDir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflow-ready-"));
  const readyFile = join(readyDir, "ready.json");
  const nextArgs = [...stripBackgroundArgs(rawArgv), "--ready-file", readyFile];
  const child = spawn(process.execPath, [process.argv[1], ...nextArgs], {
    cwd: opts.cwd ? resolve(String(opts.cwd)) : process.cwd(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PI_DYNAMIC_WORKFLOW_BACKGROUND: "1", PI_DYNAMIC_THREAD_PHASE_BACKGROUND: "1" },
  });
  const deadline = Date.now() + Number(process.env.PI_DYNAMIC_WORKFLOW_READY_TIMEOUT_MS || 5000);
  try {
    while (!existsSync(readyFile)) {
      if (child.exitCode !== null) throw new Error(`dynamic workflow child exited before readiness (code ${child.exitCode})`);
      if (Date.now() >= deadline) {
        terminateChild(child, "SIGTERM");
        setTimeout(() => terminateChild(child, "SIGKILL"), 2000).unref();
        throw new Error("dynamic workflow child did not become ready before timeout");
      }
      await sleep(25);
    }
    const ready = JSON.parse(readFileSync(readyFile, "utf8"));
    if (!ready?.ok || !ready?.runId) throw new Error("dynamic workflow child returned an invalid readiness record");
    child.unref();
    console.log(JSON.stringify({ ...ready, background: true, pid: child.pid }, null, 2));
    return true;
  } finally {
    rmSync(readyDir, { recursive: true, force: true });
  }
}

function renderTemplate(input, ctx, extra = {}) {
  return String(input ?? "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey) => {
    const key = String(rawKey).trim();
    if (key === "cwd") return ctx.cwd;
    if (key === "runId") return ctx.visualizerRun.runId;
    if (key === "item") return String(extra.item ?? "");
    if (key === "index") return String(extra.index ?? "");
    if (key.startsWith("output:")) return String(ctx.outputs[key.slice("output:".length)] ?? "");
    if (key.startsWith("outputs.")) return String(ctx.outputs[key.slice("outputs.".length)] ?? "");
    if (key.startsWith("spec.")) return String(ctx.spec[key.slice("spec.".length)] ?? "");
    return "";
  });
}

function validateRunnerLimits() {
  for (const [label, value, min, max] of [
    ["PI_DYNAMIC_WORKFLOW_MAX_CONCURRENCY", MAX_FANOUT_CONCURRENCY, 1, 64],
    ["PI_DYNAMIC_WORKFLOW_MAX_FANOUT_ITEMS", MAX_FANOUT_ITEMS, 1, 10_000],
    ["PI_DYNAMIC_WORKFLOW_MAX_PHASE_TIMEOUT_MS", MAX_PHASE_TIMEOUT_MS, 100, 24 * 60 * 60 * 1000],
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
}

function normalizePermissions(value, label = "permissions") {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error(`${label} must be a string containing any of r, w, x`);
  const raw = String(value).trim().toLowerCase();
  if (!/^[rwx]+$/.test(raw)) throw new Error(`${label} must contain only r, w, and x characters`);
  const chars = new Set(raw.split(""));
  return ["r", "w", "x"].filter((ch) => chars.has(ch)).join("");
}

function hasPermission(permissions, permission) {
  return String(permissions || "").includes(permission);
}

function assertWithinMaxPermissions(requested, label) {
  const rejected = [...String(requested || "")].filter((permission) => !hasPermission(MAX_PERMISSIONS, permission));
  if (rejected.length) throw new Error(`${label} requested permissions outside runner max policy (${MAX_PERMISSIONS || "none"}): ${rejected.join("")}`);
}

function permissionsForPhase(ctx, phase) {
  const requested = normalizePermissions(phase.permissions ?? ctx.spec.permissions ?? DEFAULT_PERMISSIONS, `${phase.name}.permissions`);
  assertWithinMaxPermissions(requested, `${phase.name}.permissions`);
  return requested;
}

function permissionIncludesAll(permissions, required) {
  return [...String(required || "")].every((permission) => hasPermission(permissions, permission));
}

function toolsForPermissions(permissions) {
  return Object.entries(PI_TOOL_REQUIREMENTS)
    .filter(([, required]) => permissionIncludesAll(permissions, required))
    .map(([tool]) => tool);
}

function normalizePiTools(tools, permissions, label) {
  if (tools !== undefined && (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string"))) throw new Error(`${label}.tools must be an array of strings`);
  if (Array.isArray(tools) && tools.length === 0) throw new Error(`${label}.tools must contain at least one tool when provided; omit tools to use all tools allowed by permissions`);
  const allowed = new Set(toolsForPermissions(permissions));
  const requested = tools === undefined ? [...allowed] : tools.map(String);
  const unknown = requested.filter((tool) => !PI_TOOL_REQUIREMENTS[tool]);
  if (unknown.length) throw new Error(`${label} requested unsupported Pi tools: ${unknown.join(", ")}`);
  const rejected = requested.filter((tool) => !allowed.has(tool));
  if (rejected.length) throw new Error(`${label} requested tools not allowed by permissions=${permissions || "none"}: ${rejected.join(", ")}`);
  if (!requested.length) throw new Error(`${label} has no Pi tools available; set permissions to include r, w, or x`);
  return requested;
}

async function runProcess(command, args, options) {
  return await runBoundedProcess(command, args, {
    ...options,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onChildStart: (child) => activeChildren.add(child),
    onChildEnd: (child) => activeChildren.delete(child),
  });
}

async function runPi({ cwd, prompt, model, tools, timeoutMs, signal }) {
  const args = [
    // Note: --no-extensions is intentionally omitted so that extensions
    // like local-vllm.ts can register dynamically-discovered local providers
    // (e.g. vllm-laguna) for use in pi phases. models.json providers are
    // always loaded as a static fallback.
    "--mode", "json", "--no-session", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--tools", tools.join(","), "-p", prompt,
  ];
  if (model) args.unshift("--model", model);

  // Parse Pi's NDJSON incrementally and do not retain raw message_update
  // records. Those records contain cumulative tool-call arguments and can make
  // a large generated file produce quadratic stdout volume in memory.
  const collector = new PiJsonEventCollector();
  const result = await runProcess(DEFAULT_PI, args, {
    cwd,
    timeoutMs,
    signal,
    captureStdout: false,
    onStdout: (chunk) => collector.push(chunk),
  });
  const parsed = collector.finish();
  return { ...result, ...parsed, ok: result.ok && Boolean(parsed.text), error: result.ok && parsed.text ? undefined : result.error || "pi produced no assistant text" };
}

function makeArtifactPath(ctx, phaseName, fileName) {
  const dir = join(ARTIFACTS_DIR, ctx.visualizerRun.runId);
  mkdirSync(dir, { recursive: true });
  return join(dir, safeName(fileName || `${phaseName}.md`));
}

function writeWorkflowResult(ctx, status, error) {
  const dir = join(ARTIFACTS_DIR, ctx.visualizerRun.runId);
  mkdirSync(dir, { recursive: true });
  const resultPath = join(dir, "workflow-result.json");
  const temporary = `${resultPath}.${process.pid}.tmp`;
  const payload = {
    schema: "pi-dynamic-workflow-result/v1",
    runId: ctx.visualizerRun.runId,
    status,
    updatedAt: new Date().toISOString(),
    error: error ? { name: error.name, message: error.message || String(error) } : undefined,
    outputs: ctx.outputs,
    results: ctx.results,
  };
  writeFileSync(temporary, safeStringify(payload), "utf8");
  renameSync(temporary, resultPath);
  artifact(ctx.visualizerRun, { kind: "json", title: status === STATUSES.SUCCESS ? "Workflow result" : "Partial workflow result", path: resultPath });
  return resultPath;
}

function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "bigint") return `${nested}n`;
    if (nested && typeof nested === "object") {
      if (seen.has(nested)) return "[Circular]";
      seen.add(nested);
    }
    return nested;
  }, 2);
}

function emitTextArtifact(ctx, phase, content, defaults = {}) {
  const artifactSpec = phase.artifact;
  if (artifactSpec === false) return undefined;
  const spec = artifactSpec && typeof artifactSpec === "object" ? artifactSpec : {};
  const kind = spec.kind || defaults.kind || "markdown";
  const title = renderTemplate(spec.title || defaults.title || phase.name, ctx);
  const fileName = renderTemplate(spec.fileName || defaults.fileName || `${phase.name}.${kind === "json" ? "json" : "md"}`, ctx);
  const path = makeArtifactPath(ctx, phase.name, fileName);
  writeFileSync(path, content, "utf8");
  artifact(ctx.visualizerRun, { kind, title, path, metadata: { phase: phase.name, type: phase.type } });
  return path;
}

function outputToItems(value) {
  if (Array.isArray(value)) return value.map(String);
  const text = String(value ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (parsed && typeof parsed === "object") return Object.values(parsed).flat().map(String);
  } catch { /* use line parsing */ }
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/^[-*]\s+/, ""));
}

function dynamicPhase(specPhase) {
  return {
    name: specPhase.name,
    async *run(ctx) {
      if (specPhase.type === "shell") yield* runShellPhase(ctx, specPhase);
      else if (specPhase.type === "pi") yield* runPiPhase(ctx, specPhase);
      else if (specPhase.type === "fanout_pi") yield* runFanoutPiPhase(ctx, specPhase);
      else if (specPhase.type === "artifact") yield* runArtifactPhase(ctx, specPhase);
      else throw new Error(`unsupported phase type: ${specPhase.type}`);
    },
  };
}

async function* runShellPhase(ctx, phase) {
  const permissions = permissionsForPhase(ctx, phase);
  const command = renderTemplate(phase.command, ctx);
  if (!permissionIncludesAll(permissions, "rwx")) throw new Error(`shell phase ${phase.name} requires rwx permissions because shell execution is not sandboxed`);
  yield { type: "data", kind: "data", key: "permissions", value: permissions, message: `Running shell command with ${permissions} permissions` };
  yield { type: "data", kind: "data", key: "command", value: command, message: `Running shell command` };
  if (ctx.signal?.aborted) throw abortError(ctx.signal.reason || "cancelled");
  const result = await runProcess(command, [], { cwd: ctx.cwd, shell: true, timeoutMs: phase.timeoutMs ?? ctx.timeoutMs, signal: ctx.signal });
  if (result.aborted) throw abortError(result.error || "cancelled");
  const output = compactText(result.stdout || "");
  ctx.outputs[phase.name] = output;
  ctx.results[phase.name] = { ...result, stdout: output, stderr: compactText(result.stderr || "") };
  if (phase.artifact) emitTextArtifact(ctx, phase, `# ${phase.name}\n\nCommand:\n\n\`\`\`sh\n${command}\n\`\`\`\n\nStdout:\n\n\`\`\`\n${output}\n\`\`\`\n\nStderr:\n\n\`\`\`\n${compactText(result.stderr || "")}\n\`\`\`\n`, { title: `Shell output: ${phase.name}` });
  yield { type: "data", kind: "data", key: "exitCode", value: result.code, message: result.ok ? "Shell command complete" : "Shell command failed" };
  if (!result.ok) throw new Error(result.error || `shell command exited ${result.code}`);
}

async function* runPiPhase(ctx, phase) {
  const prompt = renderTemplate(phase.prompt, ctx);
  const permissions = permissionsForPhase(ctx, phase);
  const tools = normalizePiTools(phase.tools, permissions, phase.name);
  yield { type: "data", kind: "data", key: "permissions", value: permissions, message: `Running pi agent with ${permissions} permissions` };
  yield { type: "data", kind: "data", key: "tools", value: tools, message: `Running pi agent` };
  if (ctx.signal?.aborted) throw abortError(ctx.signal.reason || "cancelled");
  const result = await runPi({ cwd: ctx.cwd, prompt, model: phase.model || ctx.model, tools, timeoutMs: phase.timeoutMs ?? ctx.timeoutMs, signal: ctx.signal });
  if (result.aborted) throw abortError(result.error || "cancelled");
  ctx.outputs[phase.name] = compactText(result.text || "");
  ctx.results[phase.name] = { ok: result.ok, model: result.model, stopReason: result.stopReason, code: result.code, signal: result.signal, timedOut: result.timedOut, durationMs: result.durationMs, termination: result.termination, error: result.error, piJson: result.piJson };
  if (result.usage?.length) phaseEvent(ctx.visualizerRun, phase.name, { kind: "usage", usage: result.usage, model: result.model });
  emitTextArtifact(ctx, phase, ctx.outputs[phase.name], { title: `Pi output: ${phase.name}`, fileName: `${phase.name}.md` });
  yield { type: "data", kind: "data", key: "model", value: result.model, message: result.ok ? "Pi agent complete" : "Pi agent failed" };
  if (!result.ok) throw new Error(result.error || "pi phase failed");
}

async function* runFanoutPiPhase(ctx, phase) {
  const items = phase.items !== undefined ? asArray(phase.items).map(String) : outputToItems(ctx.outputs[phase.itemsFrom]);
  if (!items.length) throw new Error(`${phase.name} has no fanout items`);
  if (items.length > MAX_FANOUT_ITEMS) throw new Error(`${phase.name}.items is capped at ${MAX_FANOUT_ITEMS} items`);
  const permissions = permissionsForPhase(ctx, phase);
  const tools = normalizePiTools(phase.tools, permissions, phase.name);
  const concurrency = Number(phase.concurrency || ctx.spec.concurrency || DEFAULT_FANOUT_CONCURRENCY);
  yield { type: "data", kind: "data", key: "permissions", value: permissions, message: `Running fanout with ${permissions} permissions` };
  yield { type: "fanout", kind: "fanout_start", total: items.length, label: phase.label || "items" };
  let terminal = 0;
  let successful = 0;
  let failed = 0;
  const queue = [];
  const push = (event) => queue.push(event);
  const worker = boundedFanout({
    items,
    concurrency,
    signal: ctx.signal,
    runner: async (item, index, itemSignal) => {
      push({ type: "fanout", kind: "fanout_item_start", itemId: `${index}:${item}`, label: item, index, total: items.length, message: `Running ${item}` });
      try {
        if (itemSignal?.aborted) throw abortError(itemSignal.reason || "cancelled");
        const prompt = renderTemplate(phase.promptTemplate, ctx, { item, index });
        const result = await runPi({ cwd: ctx.cwd, prompt, model: phase.model || ctx.model, tools, timeoutMs: phase.timeoutMs || ctx.timeoutMs, signal: itemSignal });
        if (result.aborted) throw abortError(result.error || "cancelled");
        const text = compactText(result.text || "");
        const itemHash = createHash("sha256").update(`${index}\0${item}`).digest("hex").slice(0, 10);
        const fileNameTemplate = phase.artifact && typeof phase.artifact === "object" ? phase.artifact.fileNameTemplate : undefined;
        const titleTemplate = phase.artifact && typeof phase.artifact === "object" ? phase.artifact.titleTemplate : undefined;
        const artifactPhase = {
          ...phase,
          name: `${phase.name}-${index}-${itemHash}-${safeName(item)}`,
          artifact: phase.artifact === false ? false : {
            ...(typeof phase.artifact === "object" ? phase.artifact : {}),
            title: titleTemplate ? renderTemplate(titleTemplate, ctx, { item, index }) : `${phase.name}: ${item}`,
            fileName: fileNameTemplate ? renderTemplate(fileNameTemplate, ctx, { item, index }) : `${phase.name}-${index}-${itemHash}-${safeName(item)}.md`,
          },
        };
        emitTextArtifact(ctx, artifactPhase, text, { title: `${phase.name}: ${item}` });
        if (result.usage?.length) phaseEvent(ctx.visualizerRun, phase.name, { kind: "usage", itemId: `${index}:${item}`, item, index, usage: result.usage, model: result.model });
        terminal++;
        if (result.ok) successful++; else failed++;
        push({ type: "fanout", kind: "fanout_item_end", itemId: `${index}:${item}`, label: item, index, status: result.ok ? STATUSES.SUCCESS : STATUSES.FAILED, message: result.ok ? `Complete ${item}` : `Failed ${item}`, error: result.error });
        push({ type: "progress", kind: "progress", completed: terminal, total: items.length, message: `${terminal}/${items.length} settled (${successful} successful)` });
        return { item, index, ok: result.ok, text, model: result.model, stopReason: result.stopReason, error: result.error };
      } catch (error) {
        terminal++;
        failed++;
        const cancelled = isAbortError(error) || itemSignal?.aborted || ctx.signal?.aborted;
        push({ type: "fanout", kind: "fanout_item_end", itemId: `${index}:${item}`, label: item, index, status: cancelled ? STATUSES.CANCELLED : STATUSES.FAILED, message: cancelled ? `Cancelled ${item}` : `Failed ${item}`, error: error?.message || String(error) });
        push({ type: "progress", kind: "progress", completed: terminal, total: items.length, message: `${terminal}/${items.length} settled (${successful} successful)` });
        throw error;
      }
    },
  });
  let settled = false;
  let workerError;
  let results;
  const settlement = worker.then(
    (value) => { results = value; settled = true; },
    (error) => { workerError = error; settled = true; },
  );
  while (!settled) {
    while (queue.length) yield queue.shift();
    // Core boundedFanout guarantees settlement after draining started workers;
    // racing it avoids an unnecessary polling delay at terminal transition.
    await Promise.race([settlement, sleep(100)]);
  }
  while (queue.length) yield queue.shift();
  if (workerError) throw workerError;
  ctx.outputs[phase.name] = results.map((result) => result.text).join("\n\n---\n\n");
  ctx.results[phase.name] = results;
  if (failed > 0 && phase.failOnItemFailure !== false) throw new Error(`${failed}/${items.length} fanout items failed`);
}

async function* runArtifactPhase(ctx, phase) {
  if (ctx.signal?.aborted) throw abortError(ctx.signal.reason || "cancelled");
  const base = phase.from ? String(ctx.outputs[phase.from] ?? "") : phase.content;
  const content = renderTemplate(base, ctx);
  ctx.outputs[phase.name] = content;
  emitTextArtifact(ctx, { ...phase, artifact: { kind: phase.kind || "markdown", title: phase.title || phase.name, fileName: phase.fileName || `${phase.name}.md` } }, content, { title: phase.title || phase.name });
  yield { type: "data", kind: "data", key: "bytes", value: Buffer.byteLength(content, "utf8"), message: "Artifact written" };
}

async function runHarness(ctx, harnessFile) {
  if (!permissionIncludesAll(ctx.spec.permissions || DEFAULT_PERMISSIONS, "rwx")) throw new Error("JavaScript harness mode requires workflow permissions=\"rwx\"");
  const moduleUrl = `${pathToFileURL(resolve(harnessFile)).href}?t=${Date.now()}`;
  const mod = await import(moduleUrl);
  const entry = mod.default || mod.workflow || mod.run;
  if (typeof entry !== "function") throw new Error("Harness module must export default async function(ctx), workflow(ctx), or run(ctx)");
  let autoPhase = 0;
  const harnessCtx = {
    cwd: ctx.cwd,
    runId: ctx.visualizerRun.runId,
    signal: ctx.signal,
    outputs: ctx.outputs,
    results: ctx.results,
    spec: ctx.spec,
    cancelled: () => Boolean(ctx.signal?.aborted),
    async phase(name, fn) {
      validateName(name, "harness phase");
      if (ctx.signal?.aborted) throw abortError(ctx.signal.reason || "cancelled");
      phaseStart(ctx.visualizerRun, name, { mode: "harness" });
      try {
        const value = await fn();
        if (ctx.signal?.aborted) throw abortError(ctx.signal.reason || "cancelled");
        ctx.outputs[name] = typeof value === "string" ? value : value === undefined ? "" : safeStringify(value);
        ctx.results[name] = value;
        phaseEnd(ctx.visualizerRun, name, STATUSES.SUCCESS, { outputBytes: Buffer.byteLength(String(ctx.outputs[name] || ""), "utf8") });
        return value;
      } catch (error) {
        const cancelled = isAbortError(error) || ctx.signal?.aborted;
        phaseEnd(ctx.visualizerRun, name, cancelled ? STATUSES.CANCELLED : STATUSES.FAILED, { error: { message: error?.message || String(error) } });
        throw error;
      }
    },
    async shell(command, options = {}) {
      return await harnessCtx.phase(options.name || `shell-${++autoPhase}`, async () => {
        const phase = { name: options.name || `shell-${autoPhase}`, permissions: options.permissions || ctx.spec.permissions || "rwx" };
        const permissions = permissionsForPhase(ctx, phase);
        if (!permissionIncludesAll(permissions, "rwx")) throw new Error(`shell helper requires rwx permissions because command execution is not sandboxed`);
        phaseEvent(ctx.visualizerRun, phase.name, { kind: "data", key: "command", value: command, message: "Running shell command" });
        const result = await runProcess(command, [], { cwd: options.cwd || ctx.cwd, shell: true, timeoutMs: options.timeoutMs || ctx.timeoutMs, signal: options.signal || ctx.signal });
        if (result.aborted) throw abortError(result.error || "cancelled");
        if (!result.ok && options.reject !== false) throw new Error(result.error || `shell command exited ${result.code}`);
        return compactText(result.stdout || "");
      });
    },
    async pi(prompt, options = {}) {
      return await harnessCtx.phase(options.name || `pi-${++autoPhase}`, async () => {
        const phase = { name: options.name || `pi-${autoPhase}`, permissions: options.permissions || ctx.spec.permissions || DEFAULT_PERMISSIONS };
        const permissions = permissionsForPhase(ctx, phase);
        const tools = normalizePiTools(options.tools, permissions, phase.name);
        const result = await runPi({ cwd: options.cwd || ctx.cwd, prompt, model: options.model || ctx.model, tools, timeoutMs: options.timeoutMs || ctx.timeoutMs, signal: options.signal || ctx.signal });
        if (result.aborted) throw abortError(result.error || "cancelled");
        if (result.usage?.length) phaseEvent(ctx.visualizerRun, phase.name, { kind: "usage", usage: result.usage, model: result.model });
        if (!result.ok && options.reject !== false) throw new Error(result.error || "pi helper failed");
        return compactText(result.text || "");
      });
    },
    async fanout(items, options = {}) {
      const name = options.name || `fanout-${++autoPhase}`;
      return await harnessCtx.phase(name, async () => {
        if (!Array.isArray(items)) throw new Error(`${name}.items must be an array`);
        const values = items;
        phaseEvent(ctx.visualizerRun, name, { kind: "fanout_start", total: values.length, label: options.label || "items" });
        if (values.length > MAX_FANOUT_ITEMS) throw new Error(`harness fanout ${name} exceeds max ${MAX_FANOUT_ITEMS}`);
        let completed = 0;
        const results = await boundedFanout({
          items: values,
          concurrency: Number(options.concurrency || DEFAULT_FANOUT_CONCURRENCY),
          signal: ctx.signal,
          runner: async (item, index, itemSignal) => {
            const itemId = `${index}:${String(item)}`;
            phaseEvent(ctx.visualizerRun, name, { kind: "fanout_item_start", itemId, label: String(item), index, total: values.length });
            try {
              const itemCtx = Object.create(harnessCtx);
              itemCtx.signal = itemSignal;
              itemCtx.cancelled = () => Boolean(itemSignal?.aborted);
              const itemHash = createHash("sha256").update(`${index}\0${String(item)}`).digest("hex").slice(0, 10);
              const result = options.run
                ? await options.run(item, index, itemCtx)
                : await harnessCtx.pi(
                    String(options.promptTemplate || options.prompt || "").replace(/\{\{\s*item\s*\}\}/g, String(item)),
                    { ...(options.pi || {}), name: `${name}-${index}-${itemHash}-${safeName(item)}`, signal: itemSignal },
                  );
              completed++;
              phaseEvent(ctx.visualizerRun, name, { kind: "fanout_item_end", itemId, label: String(item), index, status: STATUSES.SUCCESS });
              phaseEvent(ctx.visualizerRun, name, { kind: "progress", completed, total: values.length });
              return result;
            } catch (error) {
              const cancelled = isAbortError(error) || itemSignal?.aborted || ctx.signal?.aborted;
              phaseEvent(ctx.visualizerRun, name, { kind: "fanout_item_end", itemId, label: String(item), index, status: cancelled ? STATUSES.CANCELLED : STATUSES.FAILED, error: error?.message || String(error) });
              throw error;
            }
          },
        });
        return results;
      });
    },
    async artifact(title, content, options = {}) {
      const phaseName = options.name || safeName(title || "artifact");
      const text = typeof content === "string" ? content : safeStringify(content);
      const path = emitTextArtifact(ctx, { name: phaseName, type: "harness", artifact: { kind: options.kind || "markdown", title, fileName: options.fileName || `${phaseName}.${options.kind === "json" ? "json" : "md"}` } }, text, { title });
      return path;
    },
    emit(kind, data) {
      phaseEvent(ctx.visualizerRun, "harness", { kind, ...data });
    },
  };
  return await entry(harnessCtx);
}

async function main() {
  validateRunnerLimits();
  const rawArgv = process.argv.slice(2);
  const args = parseArgs(rawArgv);
  if (args.help || args.h) {
    console.log("Usage: dynamic-thread-phase-workflow.mjs --spec-file spec.json | --js-file workflow.mjs [--cwd REPO] [--background] [--model MODEL]");
    return;
  }

  const hasJsFile = args["js-file"] !== undefined;
  const hasHarnessFile = args["harness-file"] !== undefined;
  if (hasJsFile && hasHarnessFile) throw new Error("Provide only one of --js-file or --harness-file");
  const harnessInput = hasJsFile ? args["js-file"] : hasHarnessFile ? args["harness-file"] : undefined;
  if (harnessInput !== undefined && !String(harnessInput).trim()) throw new Error("workflow harness path must be non-empty");
  let harnessFile = harnessInput !== undefined ? preflightHarnessFile(harnessInput) : undefined;
  if (harnessFile && (args.spec || args["spec-file"])) throw new Error("Provide either spec input or --js-file, not both");
  const spec = harnessFile
    ? (() => {
        if (!args.permissions) throw new Error("JavaScript harness mode requires explicit --permissions rwx");
        const permissions = normalizePermissions(args.permissions, "harness permissions");
        if (!permissionIncludesAll(permissions, "rwx")) throw new Error("JavaScript harness mode requires permissions=\"rwx\"");
        assertWithinMaxPermissions(permissions, "harness permissions");
        return { name: args.name ? String(args.name) : safeName(basename(harnessFile).replace(/\.[cm]?js$/, "")), mode: "harness", permissions, harnessFile };
      })()
    : validateSpec(loadSpec(args));
  const cleanupInputFile = args["js-file"] || args["harness-file"] || args["spec-file"];
  if (isTruthyFlag(args["cleanup-input"]) && cleanupInputFile) generatedInputDirectory(cleanupInputFile);
  // Validate CLI timeout before creating a visualizer run so bad input cannot
  // leave a setup-stage run that needs terminal-state repair.
  const timeoutMs = normalizeTimeoutMs(args.timeout ?? spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, args.timeout !== undefined ? "--timeout" : "workflow timeoutMs");
  validateTimeout(timeoutMs, "workflow timeout");
  // Yield once so a SIGTERM delivered during startup is observed before the
  // launcher can detach a background child. The wrapper also guards signals
  // that were already aborted before spawn.
  await new Promise((resolveTick) => setImmediate(resolveTick));
  if (cancellationRequested) throw abortError("cancelled before background launch");
  if (await maybeBackground(rawArgv, args)) return;
  const cwd = resolve(String(args.cwd || spec.cwd || process.cwd()));
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`workflow cwd is not a directory: ${cwd}`);
  const workflow = spec.name || "dynamic-workflow";
  const visualizerRun = createRun({
    workflow,
    cwd,
    trigger: { kind: process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND || process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND ? "background" : "manual", dynamic: true },
    input: spec,
    metadata: { pid: process.pid, cancellable: true, cancelSignal: "SIGTERM", dynamic: true, mode: harnessFile ? "javascript" : "spec", permissions: spec.permissions || DEFAULT_PERMISSIONS, maxPermissions: MAX_PERMISSIONS, autoContinue: isTruthyFlag(args["auto-continue"] ?? spec.autoContinue), sessionId: args["session-id"], sessionFile: args["session-file"] },
    message: `${workflow} started`,
  });
  activeRun = visualizerRun;
  const controller = new AbortController();
  activeAbortController = controller;
  // Close the startup gap between the pre-background check and controller
  // registration. A signal in that interval sets the global flag first.
  if (cancellationRequested) controller.abort("cancelled during workflow startup");
  let stopWatchingCancellation = () => {};
  let ctx;

  // Everything after createRun is protected so setup failures receive a
  // terminal visualizer event and cancellation polling/global state is cleaned.
  try {
    stopWatchingCancellation = watchCancellation(visualizerRun, controller);
    const artifactsDir = join(ARTIFACTS_DIR, visualizerRun.runId);
    mkdirSync(artifactsDir, { recursive: true });
    const specPath = join(artifactsDir, harnessFile ? "workflow-harness-manifest.json" : "workflow-spec.json");
    writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf8");
    artifact(visualizerRun, { kind: "json", title: harnessFile ? "Workflow harness manifest" : "Compiled workflow spec", path: specPath });
    if (harnessFile) {
      // Artifacts must be durable copies, not references to temporary/user files.
      // Execute the copy as well so generated input can be securely removed once
      // this detached or foreground runner has taken ownership of it.
      const harnessArtifactPath = join(artifactsDir, "workflow-harness.mjs");
      copyFileSync(harnessFile, harnessArtifactPath);
      artifact(visualizerRun, { kind: "file", title: "Workflow harness source", path: harnessArtifactPath });
      harnessFile = harnessArtifactPath;
    }
    if (isTruthyFlag(args["cleanup-input"]) && cleanupInputFile) cleanupGeneratedInput(cleanupInputFile);

    ctx = {
      cache: new PipelineCache(),
      visualizerRun,
      spec,
      cwd,
      model: args.model ? String(args.model) : spec.model,
      timeoutMs,
      outputs: {},
      results: {},
      signal: controller.signal,
    };
    if (args["ready-file"]) {
      const readyFile = String(args["ready-file"]);
      const readyTemp = `${readyFile}.${process.pid}.tmp`;
      writeFileSync(readyTemp, JSON.stringify({ ok: true, ready: true, runId: visualizerRun.runId, workflow, cwd }, null, 2), "utf8");
      renameSync(readyTemp, readyFile);
    }
    if (harnessFile) {
      const phases = [{ name: "run-harness", async *run(runCtx) { await runHarness(runCtx, harnessFile); yield { type: "data", kind: "data", key: "mode", value: "harness", message: "Harness complete" }; } }];
      for await (const _event of runPipeline(wrapPhases(phases, visualizerRun), ctx, { signal: controller.signal })) {
        // wrapPhases mirrors phase lifecycle and yielded events to the visualizer.
      }
    } else {
      const compiled = spec.phases.map((phase) => {
        const base = dynamicPhase(phase);
        return phase.retry ? withRetry(base, phase.retry) : base;
      });
      const phases = wrapPhases(compiled, visualizerRun);
      for await (const _event of runPipeline(phases, ctx, { signal: controller.signal })) {
        // wrapPhases mirrors phase lifecycle and yielded events to the visualizer.
      }
    }
    if (controller.signal.aborted) throw abortError(controller.signal.reason || "cancelled");
    const resultPath = writeWorkflowResult(ctx, STATUSES.SUCCESS);
    completeRun(visualizerRun, STATUSES.SUCCESS, { ok: true, phases: spec.phases?.length ?? 1, mode: harnessFile ? "harness" : "spec", resultPath });
    activeRun = undefined;
    console.log(JSON.stringify({ ok: true, runId: visualizerRun.runId, workflow, cwd, resultPath }, null, 2));
  } catch (error) {
    const cancelled = cancellationRequested || isAbortError(error) || controller.signal.aborted;
    try {
      if (ctx) writeWorkflowResult(ctx, cancelled ? STATUSES.CANCELLED : STATUSES.FAILED, error);
    } catch (artifactError) {
      const message = artifactError?.message || String(artifactError);
      console.error(`failed to persist workflow result artifact: ${message}`);
      phaseEvent(visualizerRun, "workflow-result", { kind: "result_artifact_error", message });
    }
    if (cancelled) {
      if (activeRun === visualizerRun) completeRun(visualizerRun, STATUSES.CANCELLED, { cancelled: true, reason: controller.signal.reason || error?.message });
      console.log(JSON.stringify({ ok: false, cancelled: true, runId: visualizerRun.runId, workflow, cwd }, null, 2));
      process.exitCode = 130;
    } else {
      failRun(visualizerRun, error);
      console.log(JSON.stringify({ ok: false, runId: visualizerRun.runId, workflow, cwd, error: error.message }, null, 2));
      process.exitCode = 1;
    }
    activeRun = undefined;
  } finally {
    stopWatchingCancellation();
    if (activeRun === visualizerRun) activeRun = undefined;
    if (activeAbortController === controller) activeAbortController = undefined;
  }
}

const exitArgs = parseArgs(process.argv.slice(2));
try {
  await main();
} finally {
  // Backup cleanup for detached/foreground failures that occur before createRun
  // or before the normal setup block takes ownership of the generated input.
  const cleanupInputFile = exitArgs["js-file"] || exitArgs["harness-file"] || exitArgs["spec-file"];
  const ownsGeneratedInput = Boolean(process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND || process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND) || !isTruthyFlag(exitArgs.background);
  if (isTruthyFlag(exitArgs["cleanup-input"]) && cleanupInputFile && ownsGeneratedInput) {
    try { cleanupGeneratedInput(cleanupInputFile); } catch { /* preserve the primary workflow error */ }
  }
}
