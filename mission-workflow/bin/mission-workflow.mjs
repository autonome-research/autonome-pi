#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  ARTIFACTS_DIR,
  STATUSES,
  artifact,
  completeRun,
  createRun,
  failRun,
  emitActiveIo,
  phaseEvent,
  readCancellation,
  wrapPhases,
} from "../../thread-phase-visualizer/lib/store.mjs";

const DEFAULT_PI = process.env.PI_MISSION_WORKFLOW_PI_BIN || (existsSync(join(homedir(), ".npm-global", "bin", "pi")) ? join(homedir(), ".npm-global", "bin", "pi") : "pi");
const DEFAULT_MAX_REPAIR_ITERATIONS = 10;
const MAX_TEXT_BYTES = 250_000;
const MAX_JSON_LINE_BYTES = 10_000_000;
const MAX_USAGE_ENTRIES = 200;
const MAX_PROMPT_CONTEXT_BYTES = 120_000;
const REGISTRY_ROOT = join(homedir(), ".pi", "agent", "mission-workflow", "registry");
const GENERATED_JUNK_PATTERNS = [
  "__pycache__/", "*.py[cod]", ".pytest_cache/", ".venv/", "venv/", "env/", "*.egg-info/",
  ".mypy_cache/", ".ruff_cache/", ".tox/", ".coverage", "coverage/", "dist/", "build/",
];
const TRANSIENT_LOCKFILE_PATHS = new Set(["uv.lock"]);
const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_PI_TIMEOUT_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_PI_TIMEOUT_MS, 30 * 60 * 1000);
const DEFAULT_PI_IDLE_TIMEOUT_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_PI_IDLE_TIMEOUT_MS, 12 * 60 * 1000);
const DEFAULT_COMMAND_TIMEOUT_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_COMMAND_TIMEOUT_MS, 20 * 60 * 1000);
const DEFAULT_PROCESS_TIMEOUT_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_PROCESS_TIMEOUT_MS, 5 * 60 * 1000);
const DEFAULT_GIT_TIMEOUT_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_GIT_TIMEOUT_MS, 15 * 60 * 1000);
const DEFAULT_WATCHDOG_STALE_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_WATCHDOG_STALE_MS, 2 * 60 * 1000);
const TERMINATION_GRACE_MS = parseMillis(process.env.PI_MISSION_WORKFLOW_TERMINATION_GRACE_MS, 5000);
const ACTIVE_IO_INTERVAL_MS = parseMillis(process.env.PI_THREAD_PHASE_ACTIVE_IO_INTERVAL_MS, 5000);

async function loadThreadPhaseCore() {
  try { return await import("@autonome-research/thread-phase"); }
  catch {
    const globalPath = process.env.THREAD_PHASE_CORE_PATH || join(
      homedir(), ".npm-global", "lib", "node_modules", "@autonome-research", "thread-phase-cli",
      "node_modules", "@autonome-research", "thread-phase", "dist", "index.js",
    );
    return await import(globalPath);
  }
}

const { PipelineCache, runPipeline } = await loadThreadPhaseCore();

const activeChildren = new Set();
let activeRun;
let activeAbortController;
let cancellationRequested = false;
let finalizedRun = false;
let currentHeartbeat = {};
const activeOperations = new Map();
let operationCounter = 0;

function parseMillis(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return fallback;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  const unit = match[2] || "ms";
  const multiplier = unit === "h" ? 60 * 60 * 1000 : unit === "m" ? 60 * 1000 : unit === "s" ? 1000 : 1;
  return Math.max(1, Math.round(number * multiplier));
}

function selectOperation() {
  const operations = Array.from(activeOperations.values());
  if (!operations.length) return undefined;
  operations.sort((a, b) => a.startedAtMs - b.startedAtMs);
  return operations[0];
}

function operationView(operation = selectOperation()) {
  if (!operation) return undefined;
  const now = operation.endedAtMs || Date.now();
  return {
    id: operation.id,
    kind: operation.kind,
    label: operation.label,
    phase: operation.phase,
    cwd: operation.cwd,
    command: operation.command,
    childPid: operation.childPid,
    startedAt: operation.startedAt,
    endedAt: operation.endedAt,
    lastActivityAt: operation.lastActivityAt,
    elapsedMs: now - operation.startedAtMs,
    idleMs: now - operation.lastActivityAtMs,
    timeoutMs: operation.timeoutMs,
    idleTimeoutMs: operation.idleTimeoutMs,
  };
}

function syntheticExitCode({ timedOut = false, aborted = false, code, signal }) {
  if (timedOut) return 124;
  if (aborted) return 130;
  if (signal) return 1;
  if (typeof code === "number") return code;
  return 1;
}

function emitPhaseEvent(run, phase, data) {
  try { phaseEvent(run, phase, data); } catch { /* best effort observability */ }
}

function emitActiveIoEvent(run, phase, data) {
  try { emitActiveIo(run, phase, data); } catch { /* best effort observability */ }
}

function beginOperation(details = {}) {
  const now = Date.now();
  const operation = {
    id: `${Date.now().toString(36)}-${++operationCounter}`,
    kind: details.kind || "operation",
    label: details.label || details.command || details.kind || "operation",
    phase: details.phase || currentHeartbeat.phase || "execute-mission",
    cwd: details.cwd,
    command: details.command,
    timeoutMs: details.timeoutMs,
    idleTimeoutMs: details.idleTimeoutMs,
    startedAtMs: now,
    lastActivityAtMs: now,
    startedAt: new Date(now).toISOString(),
    lastActivityAt: new Date(now).toISOString(),
    childPid: undefined,
    lastWatchdogAtMs: 0,
  };
  activeOperations.set(operation.id, operation);
  if (activeRun) emitPhaseEvent(activeRun, operation.phase, { kind: "operation_start", operation: operationView(operation), message: `Started ${operation.label}` });
  const touch = () => {
    const at = Date.now();
    operation.lastActivityAtMs = at;
    operation.lastActivityAt = new Date(at).toISOString();
  };
  return {
    operation,
    touch,
    setChildPid(pid) { operation.childPid = pid; touch(); },
    finish(status = "success", extra = {}) {
      const endedAtMs = Date.now();
      operation.endedAtMs = endedAtMs;
      operation.endedAt = new Date(endedAtMs).toISOString();
      if (activeRun) emitPhaseEvent(activeRun, operation.phase, { kind: "operation_end", status, operation: operationView(operation), ...extra, message: `${operation.label} ${status}` });
      activeOperations.delete(operation.id);
    },
  };
}

function abortError(reason = "cancelled") {
  const error = new Error(String(reason));
  error.name = "AbortError";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError" || /aborted|cancelled/i.test(String(error?.message || error));
}

function terminateChild(child, signal = "SIGTERM") {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* ignore */ }
  }
}

function requestCancel(reason = "cancelled") {
  cancellationRequested = true;
  if (activeAbortController && !activeAbortController.signal.aborted) activeAbortController.abort(reason);
  for (const child of activeChildren) terminateChild(child, "SIGTERM");
}

function recordFatal(error) {
  if (!activeRun || finalizedRun) return;
  finalizedRun = true;
  try { failRun(activeRun, error); } catch { /* best effort */ }
}

function startHeartbeat(run, details = {}) {
  const timer = setInterval(() => {
    if (finalizedRun) return;
    const selectedOperation = selectOperation();
    const operation = operationView(selectedOperation);
    const phase = currentHeartbeat.phase || operation?.phase || "heartbeat";
    phaseEvent(run, phase, {
      kind: "heartbeat",
      pid: process.pid,
      childPids: Array.from(activeChildren).map((child) => child.pid).filter(Boolean),
      operation,
      ...details,
      ...currentHeartbeat,
      timestamp: new Date().toISOString(),
    });
    if (selectedOperation && operation && operation.idleMs >= DEFAULT_WATCHDOG_STALE_MS && Date.now() - selectedOperation.lastWatchdogAtMs >= DEFAULT_WATCHDOG_STALE_MS) {
      selectedOperation.lastWatchdogAtMs = Date.now();
      emitPhaseEvent(run, phase, { kind: "progress_watchdog", operation, message: `No child output/activity for ${operation.idleMs}ms during ${operation.label}` });
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
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
process.on("uncaughtException", (error) => { recordFatal(error); throw error; });
process.on("unhandledRejection", (reason) => { recordFatal(reason instanceof Error ? reason : new Error(String(reason))); });

function parseArgs(argv) {
  const out = { _: [] };
  const setOption = (key, value) => {
    if (out[key] === undefined) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = arg.slice(2, eq === -1 ? undefined : eq);
      if (eq !== -1) setOption(key, arg.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) setOption(key, argv[++i]);
      else setOption(key, true);
    } else out._.push(arg);
  }
  return out;
}

function isTruthyFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function stripBackgroundArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--background") continue;
    if (arg === "--background=true" || arg === "--background=false" || arg.startsWith("--background=")) continue;
    if (arg === "--background" && i + 1 < argv.length) { i++; continue; }
    out.push(arg);
  }
  return out;
}

function maybeBackground(rawArgv, args, cwd) {
  if (!isTruthyFlag(args.background) || process.env.PI_MISSION_WORKFLOW_BACKGROUND_CHILD === "1") return false;
  const childArgs = [new URL(import.meta.url).pathname, ...stripBackgroundArgs(rawArgv)];
  const child = spawn(process.execPath, childArgs, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    env: { ...process.env, PI_MISSION_WORKFLOW_BACKGROUND_CHILD: "1" },
  });
  child.unref();
  console.log(JSON.stringify({ ok: true, background: true, pid: child.pid, cwd }, null, 2));
  return true;
}

function safeName(value, fallback = "item") {
  return String(value || fallback).replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
}

function compactText(text, maxBytes = MAX_TEXT_BYTES) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = text.slice(0, maxBytes);
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return `${out}\n\n[truncated: original output was ${Buffer.byteLength(text, "utf8")} bytes]`;
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ""), "utf8");
}

function appendBounded(current, chunk, maxBytes = MAX_TEXT_BYTES) {
  const text = typeof chunk === "string" ? chunk : chunk.toString();
  if (!text || maxBytes <= 0) return current;
  const combined = current ? `${current}${text}` : text;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  const marker = "[truncated older output]\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const tailBudget = Math.max(0, maxBytes - markerBytes);
  if (tailBudget === 0) return marker.slice(0, maxBytes);
  let out = combined.slice(-tailBudget);
  while (Buffer.byteLength(out, "utf8") > tailBudget) out = out.slice(1);
  return `${marker}${out}`;
}

function compactJson(value, maxBytes = MAX_PROMPT_CONTEXT_BYTES) {
  return compactText(JSON.stringify(value, null, 2), maxBytes);
}

function readJsonFile(file, fallback = undefined) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function registryDirFor(missionId) {
  return join(REGISTRY_ROOT, safeName(missionId, "mission"));
}

function registryStatePath(missionId) {
  return join(registryDirFor(missionId), "state.json");
}

function defaultRegistryState(plan, patch = {}) {
  const now = new Date().toISOString();
  return {
    schema: "pi-mission-workflow/registry/v1",
    missionId: plan.missionId,
    goal: plan.goal,
    status: "planned",
    planPath: patch.planPath,
    branch: patch.branch,
    repoRoot: patch.repoRoot || plan.cwd,
    worktree: patch.worktree,
    worktreeBaseDir: plan.worktreeBaseDir,
    current: {},
    roleModels: { plan: plan.modelPlan, worker: plan.modelWorker, validator: plan.modelValidator },
    completedFeatures: [],
    trustedBaseHead: patch.trustedBaseHead,
    trustedHead: patch.trustedHead,
    trustedPlanFingerprint: patch.trustedPlanFingerprint,
    trustedCommits: [],
    validationReports: [],
    coverageReports: [],
    timestamps: { createdAt: now, updatedAt: now, startedAt: patch.startedAt },
    ...patch,
  };
}

function writeRegistryState(plan, state) {
  const dir = registryDirFor(plan.missionId);
  mkdirSync(dir, { recursive: true });
  const next = {
    ...state,
    timestamps: { ...(state.timestamps || {}), updatedAt: new Date().toISOString() },
  };
  writeFileSync(registryStatePath(plan.missionId), JSON.stringify(next, null, 2), "utf8");
  return { dir, statePath: registryStatePath(plan.missionId), state: next };
}

function updateRegistryState(plan, updater) {
  const existing = readJsonFile(registryStatePath(plan.missionId), defaultRegistryState(plan));
  const next = updater({ ...existing });
  return writeRegistryState(plan, next || existing);
}

function persistRegistryPlan(plan, planPath) {
  const dir = registryDirFor(plan.missionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mission-plan.json"), JSON.stringify(plan, null, 2), "utf8");
  writeFileSync(join(dir, "validation-contract.json"), JSON.stringify(plan.validationContract || {}, null, 2), "utf8");
  const existing = readJsonFile(registryStatePath(plan.missionId), {});
  const base = defaultRegistryState(plan, { planPath: planPath ? resolve(planPath) : existing.planPath });
  return writeRegistryState(plan, {
    ...base,
    ...existing,
    missionId: plan.missionId,
    goal: plan.goal,
    planPath: planPath ? resolve(planPath) : existing.planPath,
    roleModels: { ...base.roleModels, ...(existing.roleModels || {}) },
    timestamps: { ...(base.timestamps || {}), ...(existing.timestamps || {}) },
    status: existing.status || "planned",
  });
}

function markMissionRegistryTerminalFromArgs(args, cwd, status, error) {
  if (!args?.["plan-path"]) return;
  const planPath = resolve(cwd, String(args["plan-path"]));
  const plan = readJsonFile(planPath, undefined);
  if (!plan?.missionId) return;
  const at = new Date().toISOString();
  updateRegistryState(plan, (state) => ({
    ...state,
    status: state.status === "completed" ? state.status : status,
    planPath: state.planPath || planPath,
    lastError: state.status === "completed" ? state.lastError : (error ? { message: String(error.message || error), stack: error.stack ? String(error.stack) : undefined, at, status } : state.lastError),
    ...(state.status === "completed" ? { [`last${status === "cancelled" ? "Cancelled" : "Failed"}Attempt`]: { at, message: error ? String(error.message || error) : undefined } } : {}),
    timestamps: { ...(state.timestamps || {}), ...(state.status === "completed" ? {} : { [`${status}At`]: at }) },
  }));
}

function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitList);
  return String(value).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

function writeArtifact(run, fileName, content, kind = "markdown", title = fileName) {
  const dir = join(ARTIFACTS_DIR, run.runId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileName);
  mkdirSync(dirname(file), { recursive: true });
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  writeFileSync(file, text, "utf8");
  artifact(run, { kind, title, path: file });
  return file;
}

function parseJsonFromText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty JSON text");
  try { return JSON.parse(trimmed); } catch { /* continue */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
  throw new Error("could not parse JSON from model output");
}

function runProcess(command, args = [], options = {}) {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ ok: false, code: 130, stdout: "", stderr: String(options.signal.reason || "cancelled"), aborted: true });
      return;
    }
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_PROCESS_TIMEOUT_MS : options.timeoutMs;
    const op = beginOperation({ kind: "process", label: options.operationLabel || command, phase: options.phase, cwd: options.cwd, command: [command, ...args].join(" "), timeoutMs });
    const proc = spawn(command, args, {
      cwd: options.cwd,
      shell: Boolean(options.shell),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env || {}) },
      detached: process.platform !== "win32",
    });
    activeChildren.add(proc);
    op.setChildPid(proc.pid);
    let stdout = "";
    let stderr = "";
    let lastIoEmit = 0;
    let inputPreviewEmitted = false;
    const emitIo = (status = "running", force = false) => {
      if (!activeRun) return;
      const now = Date.now();
      if (!force && now - lastIoEmit < ACTIVE_IO_INTERVAL_MS) return;
      lastIoEmit = now;
      const includeInput = !inputPreviewEmitted && String(process.env.PI_THREAD_PHASE_ACTIVE_IO_COMMANDS || "0") === "1";
      const includePreviews = String(process.env.PI_THREAD_PHASE_ACTIVE_IO_PREVIEWS || "0") === "1";
      inputPreviewEmitted = true;
      const label = String(options.operationLabel || command);
      emitActiveIoEvent(activeRun, options.phase || currentHeartbeat.phase || "process", {
        componentId: op.operation.id,
        component: label.includes(":") ? label.split(":")[0] : label,
        role: "process",
        status,
        pid: proc.pid,
        cwd: options.cwd,
        command: String(process.env.PI_THREAD_PHASE_ACTIVE_IO_COMMANDS || "0") === "1" ? [command, ...args].join(" ") : undefined,
        inputPreview: includeInput ? [command, ...args].join(" ") : undefined,
        stdoutPreview: includePreviews ? stdout : undefined,
        stderrPreview: includePreviews ? stderr : undefined,
        stdoutBytes: byteLength(stdout),
        stderrBytes: byteLength(stderr),
      });
    };
    emitIo("running", true);
    let aborted = false;
    let timedOut = false;
    let settled = false;
    let forceTimer;
    let killTimer;
    const cleanup = () => {
      activeChildren.delete(proc);
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", terminate);
    };
    const finalize = ({ code = null, signalName, errorMessage, forced = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (forced) {
        try { proc.stdout?.destroy(); } catch { /* ignore */ }
        try { proc.stderr?.destroy(); } catch { /* ignore */ }
      }
      const exitCode = syntheticExitCode({ timedOut, aborted, code, signal: signalName });
      const error = errorMessage || (timedOut ? `process timed out after ${timeoutMs}ms: ${options.operationLabel || command}` : aborted ? String(options.signal?.reason || "cancelled") : signalName ? `process terminated by ${signalName}: ${options.operationLabel || command}` : undefined);
      const ok = code === 0 && !aborted && !signalName && !timedOut;
      op.finish(ok ? "success" : "failed", { ...(error ? { error } : {}), ...(signalName ? { signal: signalName } : {}), ...(forced ? { forced: true } : {}), timedOut });
      emitIo(ok ? "success" : timedOut ? "timeout" : aborted ? "cancelled" : "failed", true);
      resolve({ ok, code: exitCode, signal: signalName || undefined, stdout, stderr, aborted, timedOut, forced, error });
    };
    const terminate = (reason = "aborted") => {
      aborted = true;
      if (reason === "timeout") timedOut = true;
      terminateChild(proc, "SIGTERM");
      killTimer ||= setTimeout(() => { if (!settled) terminateChild(proc, "SIGKILL"); }, TERMINATION_GRACE_MS);
      killTimer.unref?.();
      forceTimer ||= setTimeout(() => finalize({ signalName: "SIGKILL", forced: true }), TERMINATION_GRACE_MS + 1000);
      forceTimer.unref?.();
    };
    const timer = timeoutMs ? setTimeout(() => terminate("timeout"), timeoutMs) : undefined;
    timer?.unref?.();
    options.signal?.addEventListener("abort", terminate, { once: true });
    if (options.signal?.aborted) terminate();
    proc.stdout.on("data", (data) => { op.touch(); stdout = appendBounded(stdout, data); emitIo(); });
    proc.stderr.on("data", (data) => { op.touch(); stderr = appendBounded(stderr, data); emitIo(); });
    proc.on("error", (error) => finalize({ code: 1, errorMessage: timedOut ? `process timed out after ${timeoutMs}ms: ${options.operationLabel || command}` : error.message }));
    proc.on("close", (code, signalName) => finalize({ code, signalName }));
  });
}

async function git(cwd, args, options = {}) {
  const result = await runProcess("git", args, { cwd, signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, operationLabel: `git ${args.join(" ")}`, phase: options.phase || "git" });
  if (!result.ok && options.reject !== false) throw new Error(result.error || result.stderr || result.stdout || `git ${args.join(" ")} exited ${result.code}`);
  return result;
}

function isGeneratedJunkPath(relPath) {
  const normalized = String(relPath || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.some((part) => ["__pycache__", ".pytest_cache", ".venv", "venv", "env", ".mypy_cache", ".ruff_cache", ".tox"].includes(part) || part.endsWith(".egg-info"))
    || /(^|\/)\.coverage$/.test(normalized)
    || /(^|\/)\w+\.py[cod]$/.test(normalized);
}

function removeGeneratedJunk(cwd) {
  const visit = (dir, rel = "") => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const abs = join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (isGeneratedJunkPath(childRel)) {
        rmSync(abs, { recursive: true, force: true });
        continue;
      }
      if (entry.isDirectory()) visit(abs, childRel);
    }
  };
  visit(cwd);
}

function parseStatusPaths(stdout) {
  const paths = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const value = line.slice(3).trim();
    if (!value) continue;
    const renamed = value.includes(" -> ") ? value.split(" -> ").pop() : value;
    paths.push(renamed);
  }
  return Array.from(new Set(paths));
}

async function ensureGeneratedJunkIgnored(cwd, signal) {
  const gitPath = await git(cwd, ["rev-parse", "--git-path", "info/exclude"], { signal, reject: false });
  if (!gitPath.ok) return undefined;
  const excludePath = resolve(cwd, gitPath.stdout.trim());
  mkdirSync(dirname(excludePath), { recursive: true });
  const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const missing = GENERATED_JUNK_PATTERNS.filter((pattern) => !current.split(/\r?\n/).includes(pattern));
  if (missing.length) writeFileSync(excludePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}\n# Pi mission-workflow generated junk protection\n${missing.join("\n")}\n`, "utf8");
  return excludePath;
}

async function restoreGeneratedJunkChanges(cwd, signal) {
  const status = await git(cwd, ["status", "--short"], { signal, reject: false });
  if (!status.ok) return [];
  const junk = parseStatusPaths(status.stdout).filter(isGeneratedJunkPath);
  if (junk.length) await git(cwd, ["restore", "--staged", "--worktree", "--", ...junk], { signal, reject: false });
  return junk;
}

function normalizeRelPath(relPath) {
  return String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function isTransientLockfilePath(relPath) {
  return TRANSIENT_LOCKFILE_PATHS.has(normalizeRelPath(relPath));
}

function isDependencyManifestPath(relPath) {
  const normalized = normalizeRelPath(relPath);
  const name = basename(normalized);
  return ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "uv.toml"].includes(name)
    || /^requirements(?:[-_.].*)?\.txt$/i.test(name);
}

async function autoCleanOmittedTransientArtifacts({ cwd, handoff, changedFiles, run, phase, featureId, signal }) {
  const declared = new Set(Array.isArray(handoff.changedFiles) ? handoff.changedFiles.map((file) => normalizeRelPath(file)).filter(Boolean) : []);
  const actual = Array.from(new Set((changedFiles || []).map((file) => normalizeRelPath(file)).filter(Boolean))).sort();
  const omittedTransient = actual.filter((file) => isTransientLockfilePath(file) && !declared.has(file));
  if (!omittedTransient.length) return changedFiles;
  const dependencyManifestChanged = actual.some((file) => !isTransientLockfilePath(file) && isDependencyManifestPath(file))
    || Array.from(declared).some((file) => !isTransientLockfilePath(file) && isDependencyManifestPath(file));
  if (dependencyManifestChanged) return changedFiles;
  const root = resolve(cwd);
  const cleaned = [];
  const skipped = [];
  for (const file of omittedTransient) {
    const tracked = await git(cwd, ["ls-files", "--error-unmatch", "--", file], { signal, reject: false });
    if (tracked.ok) {
      skipped.push({ file, reason: "tracked lockfile" });
      continue;
    }
    const abs = resolve(cwd, file);
    if (abs !== root && !abs.startsWith(`${root}/`)) {
      skipped.push({ file, reason: "path outside worktree" });
      continue;
    }
    rmSync(abs, { force: true });
    cleaned.push(file);
  }
  if (!cleaned.length) return changedFiles;
  const artifactPath = writeArtifact(run, `handoffs/${featureId}-auto-cleaned-transient-artifacts.json`, {
    featureId,
    cleaned,
    skipped,
    reason: "Removed omitted untracked transient lockfile(s) before strict handoff validation because no dependency manifest changed.",
    declaredChangedFiles: Array.from(declared).sort(),
    actualChangedFilesBeforeCleanup: actual,
  }, "json", `Auto-cleaned transient artifacts: ${featureId}`);
  phaseEvent(run, phase, { kind: "data", key: "autoCleanedTransientArtifacts", value: cleaned, artifactPath, message: `Auto-cleaned transient artifact(s): ${cleaned.join(", ")}` });
  return await getChangedFiles(cwd, signal);
}

async function getChangedFiles(cwd, signal) {
  const tracked = await git(cwd, ["diff", "--name-only", "HEAD"], { signal, reject: false });
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"], { signal, reject: false });
  return Array.from(new Set([
    ...(tracked.ok ? tracked.stdout.split(/\r?\n/).filter(Boolean) : []),
    ...(untracked.ok ? untracked.stdout.split(/\r?\n/).filter(Boolean) : []),
  ].filter((file) => !isGeneratedJunkPath(file)))).sort();
}

function parsePiJsonLines(stdout) {
  const state = createPiJsonLineParser();
  consumePiJsonChunk(state, stdout);
  return piParserResult(state);
}

function createPiJsonLineParser() {
  return { buffer: "", text: "", messages: [], usage: [], model: undefined, stopReason: undefined, stdoutPreview: "", lines: 0, droppedBytes: 0, parserError: undefined, droppingOversizeLine: false };
}

function consumePiJsonChunk(state, chunk) {
  let text = typeof chunk === "string" ? chunk : chunk.toString();
  state.stdoutPreview = appendBounded(state.stdoutPreview, text, MAX_TEXT_BYTES);
  if (state.droppingOversizeLine) {
    const newline = text.search(/\r?\n/);
    if (newline < 0) {
      state.droppedBytes += Buffer.byteLength(text, "utf8");
      return;
    }
    state.droppedBytes += Buffer.byteLength(text.slice(0, newline + 1), "utf8");
    text = text.slice(newline + 1);
    state.droppingOversizeLine = false;
  }
  state.buffer += text;
  if (Buffer.byteLength(state.buffer, "utf8") > MAX_JSON_LINE_BYTES) {
    state.parserError = state.parserError || `Pi JSONL record exceeded ${MAX_JSON_LINE_BYTES} bytes`;
    state.droppedBytes += Buffer.byteLength(state.buffer, "utf8");
    state.buffer = "";
    state.droppingOversizeLine = true;
    return;
  }
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() || "";
  for (const line of lines) consumePiJsonLine(state, line);
}

function consumePiJsonLine(state, line) {
  if (!line.trim()) return;
  state.lines += 1;
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type !== "message_end" || !event.message) return;
  state.messages.push(event.message);
  if (state.messages.length > 20) state.messages.shift();
  if (event.message.usage) {
    state.usage.push(event.message.usage);
    if (state.usage.length > MAX_USAGE_ENTRIES) state.usage.shift();
  }
  const msg = event.message;
  if (msg.role === "assistant") {
    state.model = msg.model || state.model;
    state.stopReason = msg.stopReason || state.stopReason;
    for (const part of msg.content || []) if (part.type === "text") state.text = part.text;
  }
}

function piParserResult(state) {
  if (!state.droppingOversizeLine && state.buffer.trim()) consumePiJsonLine(state, state.buffer);
  return { text: state.text, messages: state.messages, usage: state.usage, model: state.model, stopReason: state.stopReason, stdout: state.stdoutPreview, droppedBytes: state.droppedBytes, parsedLines: state.lines, parserError: state.parserError };
}

async function runPi({ cwd, prompt, tools, model, timeoutMs = DEFAULT_PI_TIMEOUT_MS, idleTimeoutMs = DEFAULT_PI_IDLE_TIMEOUT_MS, signal, operationLabel = "pi agent", phase }) {
  if (signal?.aborted) return { ok: false, aborted: true, error: String(signal.reason || "cancelled"), text: "" };
  const args = [
    "--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--tools", tools.join(","), "-p", prompt,
  ];
  if (model) args.unshift("--model", model);
  return await new Promise((resolve) => {
    const op = beginOperation({ kind: "pi", label: operationLabel, phase, cwd, command: `${DEFAULT_PI} --mode json ...`, timeoutMs, idleTimeoutMs });
    const proc = spawn(DEFAULT_PI, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env, detached: process.platform !== "win32" });
    activeChildren.add(proc);
    op.setChildPid(proc.pid);
    const parsed = createPiJsonLineParser();
    let rawStdout = "";
    let stderr = "";
    let lastIoEmit = 0;
    let inputPreviewEmitted = false;
    const emitIo = (status = "running", force = false) => {
      if (!activeRun) return;
      const now = Date.now();
      if (!force && now - lastIoEmit < ACTIVE_IO_INTERVAL_MS) return;
      lastIoEmit = now;
      const result = { text: parsed.text, stdout: parsed.stdoutPreview, droppedBytes: parsed.droppedBytes, stopReason: parsed.stopReason };
      const includeInput = !inputPreviewEmitted && String(process.env.PI_THREAD_PHASE_ACTIVE_IO_PROMPTS || "0") === "1";
      const includePreviews = String(process.env.PI_THREAD_PHASE_ACTIVE_IO_PREVIEWS || "0") === "1";
      inputPreviewEmitted = true;
      emitActiveIoEvent(activeRun, phase || currentHeartbeat.phase || "pi", {
        componentId: op.operation.id,
        component: operationLabel,
        role: "pi",
        status,
        pid: proc.pid,
        cwd,
        command: `${DEFAULT_PI} --mode json ...`,
        inputPreview: includeInput ? prompt : undefined,
        outputPreview: includePreviews ? result.text || result.stdout || rawStdout : undefined,
        stdoutPreview: includePreviews ? rawStdout : undefined,
        stderrPreview: includePreviews ? stderr : undefined,
        inputBytes: byteLength(prompt),
        stdoutBytes: byteLength(rawStdout),
        stderrBytes: byteLength(stderr),
        truncated: result.droppedBytes ? true : undefined,
        message: result.stopReason ? `stopReason: ${result.stopReason}` : undefined,
      });
    };
    emitIo("running", true);
    let aborted = false;
    let timedOut = false;
    let idleTimedOut = false;
    let settled = false;
    let forceTimer;
    let killTimer;
    const cleanup = () => {
      activeChildren.delete(proc);
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(killTimer);
      clearInterval(idleTimer);
      signal?.removeEventListener("abort", terminate);
    };
    const errorText = (result = {}) => timedOut ? `pi timed out after ${timeoutMs}ms: ${operationLabel}` : idleTimedOut ? `pi produced no output for ${idleTimeoutMs}ms: ${operationLabel}` : aborted ? String(signal?.reason || "cancelled") : result.parserError ? result.parserError : undefined;
    const finalize = ({ code = null, signalName, errorMessage, forced = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (forced) {
        try { proc.stdout?.destroy(); } catch { /* ignore */ }
        try { proc.stderr?.destroy(); } catch { /* ignore */ }
      }
      const result = piParserResult(parsed);
      const exitCode = syntheticExitCode({ timedOut: timedOut || idleTimedOut, aborted, code, signal: signalName });
      const error = errorMessage || errorText(result) || (signalName ? `pi terminated by ${signalName}: ${operationLabel}` : code === 0 ? undefined : stderr || `pi exited ${code}`);
      const ok = code === 0 && !result.parserError && !aborted && !signalName && !timedOut && !idleTimedOut;
      op.finish(ok ? "success" : "failed", { ...(error ? { error } : {}), ...(signalName ? { signal: signalName } : {}), ...(forced ? { forced: true } : {}), timedOut, idleTimedOut });
      emitIo(ok ? "success" : timedOut ? "timeout" : idleTimedOut ? "idle-timeout" : aborted ? "cancelled" : "failed", true);
      resolve({ ok, code: exitCode, signal: signalName || undefined, stderr, aborted, timedOut, idleTimedOut, forced, ...result, error });
    };
    const terminate = (reason = "aborted") => {
      aborted = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "idle-timeout") idleTimedOut = true;
      terminateChild(proc, "SIGTERM");
      killTimer ||= setTimeout(() => { if (!settled) terminateChild(proc, "SIGKILL"); }, TERMINATION_GRACE_MS);
      killTimer.unref?.();
      forceTimer ||= setTimeout(() => finalize({ signalName: "SIGKILL", forced: true }), TERMINATION_GRACE_MS + 1000);
      forceTimer.unref?.();
    };
    const timer = timeoutMs ? setTimeout(() => terminate("timeout"), timeoutMs) : undefined;
    timer?.unref?.();
    const idleTimer = idleTimeoutMs ? setInterval(() => {
      if (Date.now() - op.operation.lastActivityAtMs >= idleTimeoutMs) terminate("idle-timeout");
    }, Math.min(30_000, Math.max(1000, Math.floor(idleTimeoutMs / 4)))) : undefined;
    idleTimer?.unref?.();
    signal?.addEventListener("abort", terminate, { once: true });
    if (signal?.aborted) terminate();
    proc.stdout.on("data", (data) => { op.touch(); rawStdout = appendBounded(rawStdout, data); consumePiJsonChunk(parsed, data); emitIo(); });
    proc.stderr.on("data", (data) => { op.touch(); stderr = appendBounded(stderr, data); emitIo(); });
    proc.on("error", (error) => finalize({ code: 1, errorMessage: errorText() || error.message }));
    proc.on("close", (code, signalName) => finalize({ code, signalName }));
  });
}

function defaultPlan({ goal, cwd, args, repoRoot }) {
  const missionId = `mission-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const assertionId = "assertion-001";
  const featureId = "feature-001";
  return {
    schema: "pi-mission-workflow/v1",
    missionId,
    goal,
    cwd: repoRoot || cwd,
    baseRef: "HEAD",
    worktreeBaseDir: join(homedir(), ".pi", "agent", "mission-workflow", "worktrees", missionId),
    maxRepairIterations: Number(args["max-repair-iterations"] || DEFAULT_MAX_REPAIR_ITERATIONS),
    validationCommands: splitList(args["validation-command"]),
    userTestCommand: args["user-test-command"] ? String(args["user-test-command"]) : undefined,
    planner: String(args.planner || "pi"),
    modelPlan: args["model-plan"] ? String(args["model-plan"]) : undefined,
    modelWorker: args["model-worker"] ? String(args["model-worker"]) : undefined,
    modelValidator: args["model-validator"] ? String(args["model-validator"]) : undefined,
    milestones: [{
      id: "milestone-001",
      title: "Implement requested mission goal",
      features: [{ id: featureId, title: goal.slice(0, 120) || "Implement mission goal", description: goal, assertions: [assertionId] }],
    }],
    validationContract: {
      assertions: [{ id: assertionId, description: `The implementation satisfies the user goal: ${goal}`, coveredBy: [featureId], validationMethod: "both", priority: "must" }],
    },
  };
}

function canonicalAssertionId(value, contract) {
  const assertions = contract?.assertions || [];
  const byId = new Map(assertions.map((assertion) => [String(assertion.id), String(assertion.id)]));
  const byDescription = new Map(assertions.map((assertion) => [String(assertion.description), String(assertion.id)]));
  const candidates = [];
  if (typeof value === "object" && value) {
    if (value.id) candidates.push(String(value.id));
    if (value.description) candidates.push(String(value.description));
  } else candidates.push(String(value));
  const knownIdsByLength = Array.from(byId.keys()).sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (byId.has(candidate)) return byId.get(candidate);
    for (const id of knownIdsByLength) {
      if (trimmed === id || trimmed.startsWith(`${id}:`) || trimmed.startsWith(`${id} - `) || trimmed.startsWith(`${id} – `) || trimmed.startsWith(`${id} — `)) return byId.get(id);
    }
    const prefix = candidate.match(/^\s*(assertion-[A-Za-z0-9_.-]+)\s*:/i)?.[1]?.trim();
    if (prefix && byId.has(prefix)) return byId.get(prefix);
    const safe = safeName(candidate, "assertion");
    if (byId.has(safe)) return byId.get(safe);
    if (prefix) {
      const safePrefix = safeName(prefix, "assertion");
      if (byId.has(safePrefix)) return byId.get(safePrefix);
    }
    if (byDescription.has(candidate)) return byDescription.get(candidate);
  }
  return undefined;
}

function normalizeAssertionReferences(values, contract) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  return Array.from(new Set(list.map((value) => canonicalAssertionId(value, contract) || (typeof value === "object" && value ? String(value.id || value.description || "") : String(value))).filter(Boolean)));
}

function normalizeLocalAssertions(values) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  return Array.from(new Set(list.map((value) => typeof value === "object" && value ? String(value.id || value.description || "") : String(value)).filter(Boolean)));
}

function isPassedAssertionStatus(status) {
  return ["pass", "passed"].includes(String(status || "").trim().toLowerCase());
}

function isFailedAssertionStatus(status) {
  return ["fail", "failed"].includes(String(status || "").trim().toLowerCase());
}

function normalizePlan(plan, { goal, cwd, args, repoRoot }) {
  const fallback = defaultPlan({ goal, cwd, args, repoRoot });
  const missionId = safeName(plan.missionId || fallback.missionId, "mission");
  const normalized = {
    ...fallback,
    ...plan,
    schema: "pi-mission-workflow/v1",
    missionId,
    goal: plan.goal || goal,
    cwd: repoRoot || plan.cwd || cwd,
    baseRef: plan.baseRef || "HEAD",
    worktreeBaseDir: plan.worktreeBaseDir || join(homedir(), ".pi", "agent", "mission-workflow", "worktrees", missionId),
    maxRepairIterations: Number(plan.maxRepairIterations || args["max-repair-iterations"] || DEFAULT_MAX_REPAIR_ITERATIONS),
    validationCommands: Array.isArray(plan.validationCommands) ? plan.validationCommands : fallback.validationCommands,
    userTestCommand: plan.userTestCommand || fallback.userTestCommand,
    planner: String(args.planner || plan.planner || fallback.planner || "pi"),
    modelPlan: args["model-plan"] ? String(args["model-plan"]) : plan.modelPlan,
    modelWorker: args["model-worker"] ? String(args["model-worker"]) : plan.modelWorker,
    modelValidator: args["model-validator"] ? String(args["model-validator"]) : plan.modelValidator,
    validationContract: normalizeValidationContract(plan.validationContract || fallback.validationContract, goal),
  };
  if (!Array.isArray(normalized.milestones) || normalized.milestones.length === 0) normalized.milestones = fallback.milestones;
  const assertionIds = normalized.validationContract.assertions.map((assertion) => assertion.id);
  normalized.milestones = normalized.milestones.map((milestone, mIndex) => ({ 
    id: safeName(milestone.id || `milestone-${mIndex + 1}`, `milestone-${mIndex + 1}`),
    title: String(milestone.title || `Milestone ${mIndex + 1}`),
    features: (Array.isArray(milestone.features) && milestone.features.length ? milestone.features : fallback.milestones[0].features).map((feature, fIndex) => {
      const localAssertions = normalizeLocalAssertions(feature.localAssertions || []);
      const rawAssertions = feature.assertions ? (Array.isArray(feature.assertions) ? feature.assertions : [feature.assertions]) : [];
      return {
        id: safeName(feature.id || `feature-${mIndex + 1}-${fIndex + 1}`, `feature-${fIndex + 1}`),
        title: String(feature.title || feature.description || `Feature ${fIndex + 1}`),
        description: String(feature.description || feature.title || goal),
        assertions: rawAssertions.length ? normalizeAssertionReferences(rawAssertions, normalized.validationContract) : (feature.localOnly ? [] : assertionIds),
        localAssertions,
        localOnly: Boolean(feature.localOnly),
        repair: Boolean(feature.repair),
      };
    }),
  }));
  return normalized;
}

function normalizeValidationContract(contract, goal) {
  const rawAssertions = Array.isArray(contract) ? contract : Array.isArray(contract?.assertions) ? contract.assertions : [];
  const assertions = rawAssertions.length ? rawAssertions.map((assertion, index) => {
    if (typeof assertion === "string") return { id: `assertion-${String(index + 1).padStart(3, "0")}`, description: assertion, coveredBy: [], validationMethod: "both", priority: "must" };
    return {
      id: safeName(assertion.id || `assertion-${String(index + 1).padStart(3, "0")}`, `assertion-${index + 1}`),
      description: String(assertion.description || assertion.title || `Assertion ${index + 1}: ${goal}`),
      coveredBy: Array.isArray(assertion.coveredBy) ? assertion.coveredBy.map(String) : [],
      validationMethod: assertion.validationMethod || "both",
      priority: assertion.priority || "must",
    };
  }) : defaultPlan({ goal, cwd: process.cwd(), args: {}, repoRoot: process.cwd() }).validationContract.assertions;
  return { ...(contract && typeof contract === "object" && !Array.isArray(contract) ? contract : {}), assertions };
}

async function createPlan(args, cwd, run, ctx) {
  const goal = String(args.goal || "").trim();
  if (!goal) throw new Error("--goal is required for plan");
  const repo = await git(cwd, ["rev-parse", "--show-toplevel"], { signal: ctx.signal, reject: false });
  const repoRoot = repo.ok ? repo.stdout.trim() : cwd;
  let plan;
  if (String(args.planner || "pi") === "mock") {
    plan = defaultPlan({ goal, cwd, args, repoRoot });
  } else {
    const prompt = [
      "You are a mission orchestrator. Inspect the repository before planning, especially files named specs.md, SPEC.md, requirements.md, README.md, or docs/*.md.",
      "Create a JSON mission plan for a Droid/Missions-style software workflow. For large specs, decompose the whole spec into milestones and serial features rather than shrinking scope.",
      "Return ONLY JSON with: missionId, goal, sourceDocs?, maxRepairIterations, validationCommands, userTestCommand, milestones[], validationContract.assertions[].",
      "Each milestone has id,title,features[]. Each feature has id,title,description,assertions[]. assertions[] must reference validationContract assertion IDs/descriptions.",
      "Optional localAssertions[] are feature-local acceptance checks; they supplement validator context but do not satisfy global/final contract coverage. Use localOnly:true only for feature-local work with no global contract assertion.",
      "Validation assertions must be written before implementation and independently define correctness.",
      `Goal: ${goal}`,
      `Default maxRepairIterations: ${args["max-repair-iterations"] || DEFAULT_MAX_REPAIR_ITERATIONS}`,
      `Validation commands: ${splitList(args["validation-command"]).join("; ") || "none provided"}`,
      `User test command: ${args["user-test-command"] || "none provided"}`,
    ].join("\n");
    const result = await runPi({ cwd: repoRoot, prompt, tools: ["read", "grep", "find", "ls"], model: args["model-plan"], signal: ctx.signal, operationLabel: "planner agent", phase: "create-plan", timeoutMs: ctx.piTimeoutMs, idleTimeoutMs: ctx.piIdleTimeoutMs });
    if (result.usage?.length) phaseEvent(run, "create-plan", { kind: "usage", usage: result.usage, model: result.model });
    if (!result.ok) throw new Error(result.error || "planner failed");
    try { plan = parseJsonFromText(result.text); }
    catch (error) {
      writeArtifact(run, "planner-output.md", result.text, "markdown", "Planner output");
      throw error;
    }
  }
  plan = normalizePlan(plan, { goal, cwd: repoRoot, args, repoRoot });
  plan.baseRef = (await git(repoRoot, ["rev-parse", `${plan.baseRef || "HEAD"}^{commit}`], { signal: ctx.signal })).stdout.trim();
  const planPath = writeArtifact(run, "mission-plan.json", plan, "json", "Mission plan");
  const contractPath = writeArtifact(run, "validation-contract.json", plan.validationContract, "json", "Validation contract");
  const registry = persistRegistryPlan(plan, planPath);
  const approval = [
    "# Mission approval required",
    "",
    `Mission: ${plan.missionId}`,
    `Goal: ${plan.goal}`,
    "",
    "Review the mission plan and validation contract. To activate, call `mission_workflow` with:",
    "",
    "```json",
    JSON.stringify({ action: "activate", planPath, approved: true, background: true }, null, 2),
    "```",
  ].join("\n");
  const approvalPath = writeArtifact(run, "approval-instructions.md", approval, "markdown", "Approval instructions");
  return { plan, planPath, contractPath, approvalPath, registryPath: registry.statePath };
}

function validatePlanForActivation(plan) {
  if (!plan || typeof plan !== "object") throw new Error("plan must be a JSON object");
  if (!plan.missionId) throw new Error("plan.missionId is required");
  if (!Array.isArray(plan.milestones) || plan.milestones.length === 0) throw new Error("plan.milestones must be non-empty");
  if (!plan.validationContract?.assertions?.length) throw new Error("plan.validationContract.assertions must be non-empty");
  const normalized = normalizePlan(plan, { goal: plan.goal || plan.missionId, cwd: plan.cwd || process.cwd(), args: {}, repoRoot: plan.cwd || process.cwd() });
  const known = new Set((normalized.validationContract?.assertions || []).map((assertion) => String(assertion.id)));
  const unknown = [];
  const localCollisions = [];
  for (const milestone of normalized.milestones || []) for (const feature of milestone.features || []) {
    for (const assertionId of feature.assertions || []) {
      if (!known.has(String(assertionId))) unknown.push(`${milestone.id}/${feature.id}: ${assertionId}`);
    }
    for (const localAssertion of feature.localAssertions || []) {
      if (canonicalAssertionId(localAssertion, normalized.validationContract)) localCollisions.push(`${milestone.id}/${feature.id}: ${localAssertion}`);
    }
  }
  if (unknown.length) throw new Error(`Unknown feature assertion references: ${unknown.join(", ")}`);
  if (localCollisions.length) throw new Error(`Local assertions must not duplicate validation contract assertions: ${localCollisions.join(", ")}`);
  return normalized;
}

async function ensureMissionWorktrees(plan, ctx, run, options = {}) {
  const repoRoot = (await git(plan.cwd, ["rev-parse", "--show-toplevel"], { signal: ctx.signal })).stdout.trim();
  const registryState = readJsonFile(registryStatePath(plan.missionId), {});
  const missionBranch = `mission/${safeName(plan.missionId, "mission")}`;
  const rawBaseRef = String(plan.baseRef || "HEAD");
  let requestedBase = options.resume && registryState.trustedBaseHead ? String(registryState.trustedBaseHead) : rawBaseRef;
  if (options.resume && !registryState.trustedBaseHead && await branchExists(repoRoot, missionBranch, ctx.signal) && !/^[0-9a-f]{40}$/i.test(rawBaseRef)) {
    const mergeBase = await git(repoRoot, ["merge-base", missionBranch, rawBaseRef], { signal: ctx.signal, reject: false });
    if (mergeBase.ok && mergeBase.stdout.trim()) requestedBase = mergeBase.stdout.trim();
  }
  const baseHead = (await git(repoRoot, ["rev-parse", requestedBase], { signal: ctx.signal })).stdout.trim();
  const root = resolve(plan.worktreeBaseDir || join(homedir(), ".pi", "agent", "mission-workflow", "worktrees", plan.missionId));
  const integrationPath = join(root, "integration");
  mkdirSync(root, { recursive: true });
  if (existsSync(integrationPath)) {
    if (!options.resume) throw new Error(`integration worktree already exists: ${integrationPath}`);
    const integrationBranch = await git(integrationPath, ["symbolic-ref", "--short", "HEAD"], { signal: ctx.signal, reject: false });
    if (!integrationBranch.ok || integrationBranch.stdout.trim() !== missionBranch) throw new Error(`integration worktree ${integrationPath} is not checked out on ${missionBranch}`);
    await ensureGeneratedJunkIgnored(integrationPath, ctx.signal);
    phaseEvent(run, "prepare-mission", { kind: "data", key: "missionBranch", value: missionBranch, message: `Resuming ${missionBranch}` });
    return { repoRoot, baseHead, missionBranch, root, integrationPath, resumed: true };
  }
  if (options.resume && await branchExists(repoRoot, missionBranch, ctx.signal)) {
    await git(repoRoot, ["worktree", "add", integrationPath, missionBranch], { signal: ctx.signal });
    await ensureGeneratedJunkIgnored(integrationPath, ctx.signal);
    phaseEvent(run, "prepare-mission", { kind: "data", key: "missionBranch", value: missionBranch, message: `Attached existing ${missionBranch}` });
    return { repoRoot, baseHead, missionBranch, root, integrationPath, resumed: true };
  }
  if (!options.resume && await branchExists(repoRoot, missionBranch, ctx.signal)) throw new Error(`mission branch already exists: ${missionBranch}; use resume or delete/rename the old mission branch`);
  const startRef = options.resume && registryState.trustedHead ? String(registryState.trustedHead) : baseHead;
  await git(repoRoot, ["worktree", "add", "-B", missionBranch, integrationPath, startRef], { signal: ctx.signal });
  await ensureGeneratedJunkIgnored(integrationPath, ctx.signal);
  phaseEvent(run, "prepare-mission", { kind: "data", key: "missionBranch", value: missionBranch, message: `Created ${missionBranch}` });
  return { repoRoot, baseHead, missionBranch, root, integrationPath, resumed: Boolean(options.resume) };
}

async function branchExists(cwd, branch, signal) {
  const result = await git(cwd, ["rev-parse", "--verify", branch], { signal, reject: false });
  return result.ok;
}

async function branchMerged(cwd, branch, target, signal) {
  if (!(await branchExists(cwd, branch, signal))) return false;
  const result = await git(cwd, ["merge-base", "--is-ancestor", branch, target], { signal, reject: false });
  return result.ok;
}

async function gitRef(cwd, ref, signal) {
  const result = await git(cwd, ["rev-parse", ref], { signal, reject: false });
  return result.ok ? result.stdout.trim() : undefined;
}

async function gitSubject(cwd, ref, signal) {
  const result = await git(cwd, ["log", "-1", "--format=%s", ref], { signal, reject: false });
  return result.ok ? result.stdout.trim() : undefined;
}

function expectedFeatureCommitSubject(plan, feature, featureId) {
  const title = String(feature.title || featureId).replace(/\s+/g, " ").trim().slice(0, 160) || featureId;
  return `mission(${plan.missionId}): ${title}`;
}

function missionPlanFingerprint(plan, baseHead = "") {
  const normalizedAssertions = (plan?.validationContract?.assertions || []).map((assertion) => ({
    id: String(assertion.id || ""),
    description: String(assertion.description || "").replace(/\s+/g, " ").trim(),
    priority: String(assertion.priority || ""),
    validationMethod: String(assertion.validationMethod || ""),
    coveredBy: (assertion.coveredBy || []).map(String).sort(),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const milestones = (plan?.milestones || []).map((milestone) => ({
    id: String(milestone.id || ""),
    title: String(milestone.title || "").replace(/\s+/g, " ").trim(),
    features: (milestone.features || []).map((feature) => ({
      id: safeName(feature.id || feature.title, "feature"),
      title: String(feature.title || "").replace(/\s+/g, " ").trim(),
      description: feature.repair ? "" : String(feature.description || "").replace(/\s+/g, " ").trim(),
      repair: Boolean(feature.repair),
      assertions: (feature.assertions || []).map(String).sort(),
      localAssertions: (feature.localAssertions || []).map(String).sort(),
    })),
  }));
  return createHash("sha256").update(JSON.stringify({ schema: "pi-mission-plan-fingerprint/v1", missionId: String(plan?.missionId || ""), baseHead: String(baseHead || ""), validationContract: normalizedAssertions, milestones })).digest("hex").slice(0, 24);
}

function parseRepairSignatureFromId(featureId) {
  const match = String(featureId || "").match(/^repair-[^-]+-\d+-([0-9a-f]{10})(?:-|$)/i);
  return match ? match[1].toLowerCase() : undefined;
}

function repairSignatureFromFeature(feature, featureId) {
  if (!feature?.repair) return undefined;
  return String(feature.repairSignature || feature.repairHash || parseRepairSignatureFromId(featureId) || "").toLowerCase() || undefined;
}

function repairSignatureFromRecord(record) {
  return String(record?.repairSignature || record?.repairHash || parseRepairSignatureFromId(record?.featureId) || "").toLowerCase() || undefined;
}

function featureFingerprint(plan, milestone, feature, featureId) {
  const contract = new Map((plan?.validationContract?.assertions || []).map((assertion) => [String(assertion.id), assertion]));
  const assertionIds = (feature.assertions || []).map(String).sort();
  const contractAssertions = assertionIds.map((id) => {
    const assertion = contract.get(id) || { id };
    return {
      id,
      description: String(assertion.description || "").replace(/\s+/g, " ").trim(),
      priority: String(assertion.priority || ""),
      validationMethod: String(assertion.validationMethod || ""),
      coveredBy: (assertion.coveredBy || []).map(String).sort(),
    };
  });
  return createHash("sha256").update(JSON.stringify({
    schema: "pi-mission-feature-fingerprint/v2",
    milestoneId: String(milestone?.id || ""),
    featureId,
    title: String(feature.title || "").replace(/\s+/g, " ").trim(),
    description: feature.repair ? "" : String(feature.description || "").replace(/\s+/g, " ").trim(),
    repair: Boolean(feature.repair),
    assertions: assertionIds,
    contractAssertions,
    localAssertions: (feature.localAssertions || []).map(String).sort(),
  })).digest("hex").slice(0, 24);
}

async function gitCommitLooksCompleted(cwd, ref, baseHead, plan, milestone, feature, featureId, signal, options = {}) {
  const [commit, subject, body] = await Promise.all([
    gitRef(cwd, ref, signal),
    gitSubject(cwd, ref, signal),
    git(cwd, ["log", "-1", "--format=%B", ref], { signal, reject: false }),
  ]);
  if (!commit || commit === baseHead) return false;
  if (subject !== expectedFeatureCommitSubject(plan, feature, featureId)) return false;
  const escapedFeatureId = featureId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const featureIdMatches = body.ok && new RegExp(`^Mission-Feature-Id: ${escapedFeatureId}$`, "m").test(body.stdout);
  if (!featureIdMatches) return false;
  const fingerprintMatch = body.stdout.match(/^Mission-Feature-Fingerprint: (\S+)$/m);
  if (!fingerprintMatch) return !options.requireFingerprint;
  return fingerprintMatch[1] === featureFingerprint(plan, milestone, feature, featureId);
}

function planFeatureContexts(plan) {
  const rows = [];
  for (const milestone of plan.milestones || []) for (const feature of milestone.features || []) {
    const featureId = safeName(feature.id || feature.title, "feature");
    rows.push({ milestone, feature, featureId });
  }
  return rows;
}

async function commitLooksTrustedByPlan(cwd, commit, baseHead, plan, signal) {
  for (const { milestone, feature, featureId } of planFeatureContexts(plan)) {
    if (await gitCommitLooksCompleted(cwd, commit, baseHead, plan, milestone, feature, featureId, signal, { requireFingerprint: true })) return true;
  }
  return false;
}

async function trustedRegistryCommitSet(plan, baseHead, signal) {
  const state = readJsonFile(registryStatePath(plan.missionId), {});
  const trusted = new Set();
  const contexts = new Map(planFeatureContexts(plan).map((context) => [context.featureId, context]));
  for (const record of state.completedFeatures || []) {
    const context = contexts.get(String(record.featureId || ""));
    if (!context) continue;
    if (!recordMatchesCurrentFeature(record, plan, context.milestone, context.feature, context.featureId)) continue;
    if (await gitCommitLooksCompleted(plan.cwd, String(record.commit || ""), baseHead, plan, context.milestone, context.feature, context.featureId, signal, { requireFingerprint: true })) trusted.add(String(record.commit));
  }
  return trusted;
}

async function missionBranchCommits(cwd, baseHead, missionBranch, signal) {
  const result = await git(cwd, ["rev-list", "--reverse", `${baseHead}..${missionBranch}`], { signal, reject: false });
  return result.ok ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

async function backupAndResetMissionBranch(env, targetRef, reason, ctx, run) {
  const current = await gitRef(env.repoRoot, env.missionBranch, ctx.signal);
  if (current && current !== targetRef) {
    const backupBranch = `mission-backup/${safeName(env.missionBranch, "mission")}/${new Date().toISOString().replace(/[^0-9A-Za-z-]/g, "-")}`;
    await git(env.repoRoot, ["branch", backupBranch, current], { signal: ctx.signal });
    phaseEvent(run, "prepare-mission", { kind: "data", key: "missionBranchBackup", value: backupBranch, message: `Backed up ${env.missionBranch} before trusted reset` });
  }
  await git(env.integrationPath, ["reset", "--hard", targetRef], { signal: ctx.signal });
  await git(env.integrationPath, ["clean", "-fd", "--", "."], { signal: ctx.signal, reject: false });
  phaseEvent(run, "prepare-mission", { kind: "data", key: "trustedReset", value: targetRef, message: reason });
}

async function enforceTrustedMissionBranch(plan, env, ctx, run, options = {}) {
  const state = readJsonFile(registryStatePath(plan.missionId), {});
  const currentHead = (await git(env.integrationPath, ["rev-parse", "HEAD"], { signal: ctx.signal })).stdout.trim();
  const trustedHead = state.trustedHead ? String(state.trustedHead) : "";
  const completedRecords = (state.completedFeatures || []).filter((record) => record.commit || record.handoffArtifact || record.skipped);
  if (!options.resume) {
    updateRegistryState(plan, (existing) => ({ ...existing, trustedBaseHead: env.baseHead, trustedHead: currentHead, trustedPlanFingerprint: missionPlanFingerprint(plan, env.baseHead), trustedCommits: existing.trustedCommits || [] }));
    return;
  }
  if (trustedHead) {
    const expectedPlanFingerprint = missionPlanFingerprint(plan, env.baseHead);
    if (!state.trustedPlanFingerprint || String(state.trustedPlanFingerprint) !== expectedPlanFingerprint) {
      writeArtifact(run, "state/contaminated-mission-branch.json", { schema: "pi-mission-workflow/contaminated-branch/v1", missionId: plan.missionId, branch: env.missionBranch, baseHead: env.baseHead, trustedHead, trustedPlanFingerprint: state.trustedPlanFingerprint, expectedPlanFingerprint, message: "Trusted checkpoint was created for a different mission plan, validation contract, or base commit." }, "json", "Contaminated mission branch");
      throw new Error(`Trusted mission checkpoint for ${plan.missionId} does not match the current plan/contract/base; start a fresh mission or restore the matching plan.`);
    }
    const exists = await git(env.repoRoot, ["cat-file", "-e", `${trustedHead}^{commit}`], { signal: ctx.signal, reject: false });
    if (!exists.ok) throw new Error(`Trusted mission checkpoint ${trustedHead} is missing from git; cannot safely resume ${plan.missionId}`);
    await backupAndResetMissionBranch(env, trustedHead, currentHead === trustedHead ? `Cleaned ${env.missionBranch} at trusted checkpoint` : `Reset ${env.missionBranch} to trusted checkpoint`, ctx, run);
    const commits = await missionBranchCommits(env.repoRoot, env.baseHead, env.missionBranch, ctx.signal);
    const trustedCommits = [];
    for (const commit of commits) if (await commitLooksTrustedByPlan(env.repoRoot, commit, env.baseHead, plan, ctx.signal)) trustedCommits.push(commit);
    updateRegistryState(plan, (existing) => ({ ...existing, trustedBaseHead: existing.trustedBaseHead || env.baseHead, trustedHead, trustedPlanFingerprint: expectedPlanFingerprint, trustedCommits: Array.from(new Set([...(existing.trustedCommits || []), ...trustedCommits])) }));
    return;
  }
  const commits = await missionBranchCommits(env.repoRoot, env.baseHead, env.missionBranch, ctx.signal);
  if (!commits.length) {
    updateRegistryState(plan, (existing) => ({ ...existing, trustedBaseHead: env.baseHead, trustedHead: currentHead, trustedPlanFingerprint: missionPlanFingerprint(plan, env.baseHead), trustedCommits: [] }));
    return;
  }
  const registryTrusted = await trustedRegistryCommitSet(plan, env.baseHead, ctx.signal);
  const untrusted = [];
  for (const commit of commits) {
    if (registryTrusted.has(commit)) continue;
    if (await commitLooksTrustedByPlan(env.repoRoot, commit, env.baseHead, plan, ctx.signal)) continue;
    untrusted.push(commit);
  }
  if (untrusted.length && completedRecords.length) {
    writeArtifact(run, "state/contaminated-mission-branch.json", { schema: "pi-mission-workflow/contaminated-branch/v1", missionId: plan.missionId, branch: env.missionBranch, baseHead: env.baseHead, currentHead, untrustedCommits: untrusted, message: "Mission branch contains commits that are not backed by the trusted checkpoint, current registry fingerprints, or current plan feature fingerprints." }, "json", "Contaminated mission branch");
    throw new Error(`Mission branch ${env.missionBranch} is contaminated with ${untrusted.length} untrusted commit(s) and no trusted checkpoint exists. Start a fresh mission/registry or restore a known-good checkpoint before resuming.`);
  }
  if (untrusted.length) {
    await backupAndResetMissionBranch(env, env.baseHead, `Reset contaminated ${env.missionBranch} to base because no completed registry records were trusted`, ctx, run);
    updateRegistryState(plan, (existing) => ({ ...existing, trustedBaseHead: env.baseHead, trustedHead: env.baseHead, trustedPlanFingerprint: missionPlanFingerprint(plan, env.baseHead), trustedCommits: [] }));
    return;
  }
  await backupAndResetMissionBranch(env, currentHead, `Cleaned ${env.missionBranch} at verified trusted head`, ctx, run);
  updateRegistryState(plan, (existing) => ({ ...existing, trustedBaseHead: env.baseHead, trustedHead: currentHead, trustedPlanFingerprint: missionPlanFingerprint(plan, env.baseHead), trustedCommits: Array.from(new Set([...(existing.trustedCommits || []), ...commits])) }));
}

function handoffArtifactLooksCompleted(artifactPath, featureId, feature, plan) {
  if (!artifactPath || !existsSync(String(artifactPath))) return false;
  const handoff = readJsonFile(String(artifactPath), undefined);
  if (!handoff || handoff.completed !== true) return false;
  const validation = validateHandoff({ handoff, featureId, feature, plan, changedFiles: [] });
  return validation.ok;
}

function handoffChangedFiles(artifactPath) {
  const handoff = readJsonFile(String(artifactPath || ""), undefined);
  return Array.isArray(handoff?.changedFiles) ? handoff.changedFiles.map(String).filter(Boolean).sort() : undefined;
}

function handoffOnlyEvidenceIsNoChange(record) {
  const recordChanged = Array.isArray(record.changedFiles) ? record.changedFiles.map(String).filter(Boolean) : [];
  const handoffChanged = handoffChangedFiles(record.handoffArtifact) || [];
  return recordChanged.length === 0 && handoffChanged.length === 0;
}

function sameStringSet(left = [], right = []) {
  const a = new Set((Array.isArray(left) ? left : []).map(String));
  const b = new Set((Array.isArray(right) ? right : []).map(String));
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function recordMatchesCurrentFeature(record, plan, milestone, feature, featureId) {
  if (String(record.milestoneId || "") !== String(milestone.id)) return false;
  const currentRepairSignature = repairSignatureFromFeature(feature, featureId);
  const repairSignatureMatched = Boolean(currentRepairSignature && repairSignatureFromRecord(record) === currentRepairSignature);
  if (Array.isArray(record.assignedAssertions)) {
    if (!sameStringSet(record.assignedAssertions, feature.assertions || [])) return false;
  } else if (Array.isArray(record.assertions)) {
    if (!sameStringSet(record.assertions, feature.assertions || [])) return false;
  } else if (!record.featureFingerprint && (feature.assertions || []).length) return false;
  if (Array.isArray(record.assignedLocalAssertions)) {
    if (!sameStringSet(record.assignedLocalAssertions, feature.localAssertions || [])) return false;
  } else if (Array.isArray(record.localAssertions)) {
    if (!sameStringSet(record.localAssertions, feature.localAssertions || [])) return false;
  } else if ((feature.localAssertions || []).length) return false;
  if (record.featureFingerprint && String(record.featureFingerprint) !== featureFingerprint(plan, milestone, feature, featureId) && !repairSignatureMatched) return false;
  return true;
}

async function completedFeatureRecord(plan, milestone, feature, featureId, featureBranch, missionBranch, baseHead, signal) {
  const state = readJsonFile(registryStatePath(plan.missionId), {});
  const currentRepairSignature = repairSignatureFromFeature(feature, featureId);
  const candidates = (state.completedFeatures || [])
    .filter((item) => {
      const exactFeature = String(item.featureId) === featureId && (!item.branch || String(item.branch) === featureBranch);
      const repairAlias = currentRepairSignature && repairSignatureFromRecord(item) === currentRepairSignature;
      return exactFeature || repairAlias;
    })
    .sort((a, b) => {
      const milestoneDelta = (String(b.milestoneId || "") === String(milestone.id) ? 1 : 0) - (String(a.milestoneId || "") === String(milestone.id) ? 1 : 0);
      if (milestoneDelta) return milestoneDelta;
      return (String(b.featureId) === featureId ? 1 : 0) - (String(a.featureId) === featureId ? 1 : 0);
    });
  for (const record of candidates) {
    if (!recordMatchesCurrentFeature(record, plan, milestone, feature, featureId)) continue;
    const repairAlias = currentRepairSignature && repairSignatureFromRecord(record) === currentRepairSignature && String(record.featureId) !== featureId;
    if (record.commit && await branchMerged(plan.cwd, String(record.commit), missionBranch, signal)) {
      if (await gitCommitLooksCompleted(plan.cwd, String(record.commit), baseHead, plan, milestone, feature, featureId, signal, { requireFingerprint: true })) return record;
      if (repairAlias && (state.trustedCommits || []).map(String).includes(String(record.commit))) return { ...record, repairAliasOf: record.featureId };
      continue;
    }
    if (record.handoffArtifact && handoffArtifactLooksCompleted(record.handoffArtifact, featureId, feature, plan) && handoffOnlyEvidenceIsNoChange(record) && await branchMerged(plan.cwd, featureBranch, missionBranch, signal)) return record;
  }
  for (const commit of state.trustedCommits || []) {
    const ref = String(commit || "");
    if (!ref || !(await branchMerged(plan.cwd, ref, missionBranch, signal))) continue;
    if (await gitCommitLooksCompleted(plan.cwd, ref, baseHead, plan, milestone, feature, featureId, signal, { requireFingerprint: true })) {
      return { featureId, milestoneId: milestone.id, branch: featureBranch, commit: ref, changedFiles: [], assertions: feature.assertions || [], localAssertions: feature.localAssertions || [], assignedAssertions: feature.assertions || [], assignedLocalAssertions: feature.localAssertions || [], featureFingerprint: featureFingerprint(plan, milestone, feature, featureId), skipped: true, trustedCommit: true };
    }
  }
  return undefined;
}

async function featureBranchLooksCompleted(cwd, featureBranch, missionBranch, baseHead, plan, milestone, feature, featureId, signal) {
  if (!(await branchMerged(cwd, featureBranch, missionBranch, signal))) return false;
  return await gitCommitLooksCompleted(cwd, featureBranch, baseHead, plan, milestone, feature, featureId, signal, { requireFingerprint: true });
}

async function preserveFailedWorkerArtifacts(featurePath, featureId, run, signal) {
  if (!existsSync(featurePath)) return;
  const status = await git(featurePath, ["status", "--short"], { signal, reject: false });
  if (!status.ok || !status.stdout.trim()) return;
  writeArtifact(run, `failed-workers/${featureId}-status.txt`, status.stdout, "file", `Failed worker status: ${featureId}`);
  const untrackedBeforeIntent = await git(featurePath, ["ls-files", "--others", "--exclude-standard"], { signal, reject: false });
  await git(featurePath, ["add", "-N", "."], { signal, reject: false });
  const nameStatus = await git(featurePath, ["diff", "--name-status", "HEAD", "--"], { signal, reject: false });
  const stat = await git(featurePath, ["diff", "--stat", "HEAD", "--"], { signal, reject: false });
  const changedFiles = await getChangedFiles(featurePath, signal);
  writeArtifact(run, `failed-workers/${featureId}-diagnostics.json`, {
    featureId,
    statusShort: status.stdout,
    changedFiles,
    diffNameStatus: nameStatus.ok ? nameStatus.stdout : undefined,
    diffStat: stat.ok ? stat.stdout : undefined,
    untrackedBeforeIntentToAdd: untrackedBeforeIntent.ok ? untrackedBeforeIntent.stdout.split(/\r?\n/).filter(Boolean) : undefined,
  }, "json", `Failed worker diagnostics: ${featureId}`);
  const diff = await git(featurePath, ["diff", "--binary", "HEAD", "--"], { signal, reject: false });
  if (diff.ok && diff.stdout.trim()) writeArtifact(run, `failed-workers/${featureId}.diff`, compactText(diff.stdout, MAX_TEXT_BYTES), "file", `Failed worker diff: ${featureId}`);
}

function isSupplementalLocalAssertionId(id) {
  return String(id || "").trim().startsWith("local:");
}

function supplementalLocalAssertionId(id) {
  const raw = String(id || "").trim();
  if (!raw) return undefined;
  return raw.startsWith("local:") ? raw : `local:${safeName(raw, "evidence")}`;
}

function localAssertionPrefixMatches(text, assertion) {
  if (text === assertion) return true;
  if (!text.startsWith(assertion)) return false;
  return /^(\s|[:.]| - | – | — )/.test(text.slice(assertion.length));
}

function canonicalLocalAssertionId(value, allowedLocalAssertions = []) {
  const allowed = Array.from(new Set((allowedLocalAssertions || []).map(String).filter(Boolean))).sort((a, b) => b.length - a.length);
  const candidates = [];
  if (typeof value === "object" && value) {
    if (value.id) candidates.push(String(value.id));
    if (value.description) candidates.push(String(value.description));
    if (value.summary) candidates.push(String(value.summary));
  } else candidates.push(String(value));
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const withoutLabel = trimmed.replace(/^local\s+assertion\s*:\s*/i, "");
    for (const assertion of allowed) {
      const safe = safeName(assertion, "assertion");
      for (const text of [trimmed, withoutLabel, safeName(trimmed, "assertion"), safeName(withoutLabel, "assertion")]) {
        if (localAssertionPrefixMatches(text, assertion) || localAssertionPrefixMatches(text, safe)) return assertion;
      }
    }
  }
  return undefined;
}

function normalizeAssertionsAddressed(raw, plan, allowedLocalAssertions = []) {
  const allowedLocal = new Set((allowedLocalAssertions || []).map(String));
  const values = Array.isArray(raw) ? raw : [];
  const ids = [];
  const errors = [];
  for (const value of values) {
    const rawId = typeof value === "object" && value ? String(value.id || "") : String(value);
    const rawDescription = typeof value === "object" && value ? String(value.description || "") : String(value);
    const rawType = typeof value === "object" && value ? String(value.type || "").trim().toLowerCase() : "";
    const safeId = safeName(rawId, "assertion");
    const safeDescription = safeName(rawDescription, "assertion");
    const localAssertionId = canonicalLocalAssertionId(value, allowedLocalAssertions);
    const supplementalLocalId = supplementalLocalAssertionId(rawId || rawDescription || (typeof value === "object" && value ? String(value.summary || "") : ""));
    const assertionId = rawType === "local" ? undefined : canonicalAssertionId(value, plan.validationContract);
    if (rawType === "local" && localAssertionId) ids.push(localAssertionId);
    else if (rawType === "local" && supplementalLocalId) ids.push(supplementalLocalId);
    else if (assertionId) ids.push(assertionId);
    else if (localAssertionId) ids.push(localAssertionId);
    else if (isSupplementalLocalAssertionId(rawId)) ids.push(rawId.trim());
    else if (allowedLocal.has(rawId)) ids.push(rawId);
    else if (allowedLocal.has(safeId)) ids.push(safeId);
    else if (allowedLocal.has(rawDescription)) ids.push(rawDescription);
    else if (allowedLocal.has(safeDescription)) ids.push(safeDescription);
    else errors.push(`Unknown assertion addressed: ${compactText(JSON.stringify(value), 500)}`);
  }
  return { ids: Array.from(new Set(ids)), errors };
}

function summarizeHandoff(handoff, artifactPath) {
  return {
    artifact: artifactPath,
    featureId: handoff.featureId,
    completed: Boolean(handoff.completed),
    changedFiles: Array.isArray(handoff.changedFiles) ? handoff.changedFiles.map(String) : [],
    commandsRun: Array.isArray(handoff.commandsRun) ? handoff.commandsRun.map((cmd) => ({ command: String(cmd.command || ""), exitCode: Number(cmd.exitCode ?? 0) })) : [],
    assertionsAddressed: Array.isArray(handoff.assertionsAddressed) ? handoff.assertionsAddressed.map((value) => typeof value === "object" && value ? String(value.id || value.description || "") : String(value)) : [],
    issuesDiscoveredCount: Array.isArray(handoff.issuesDiscovered) ? handoff.issuesDiscovered.length : 0,
    leftUndoneCount: Array.isArray(handoff.leftUndone) ? handoff.leftUndone.length : 0,
    notesForValidator: compactText(String(handoff.notesForValidator || ""), 4000),
  };
}

function canonicalHandoffFeatureId(value, expectedFeatureId) {
  const raw = String(value || "").trim();
  if (raw === expectedFeatureId) return expectedFeatureId;
  return safeName(raw, "feature") === expectedFeatureId ? expectedFeatureId : raw;
}

function validateHandoff({ handoff, featureId, feature, plan, changedFiles }) {
  const errors = [];
  const required = ["featureId", "completed", "changedFiles", "commandsRun", "assertionsAddressed", "issuesDiscovered", "leftUndone", "notesForValidator"];
  for (const field of required) if (!(field in handoff)) errors.push(`Missing handoff field: ${field}`);
  if (canonicalHandoffFeatureId(handoff.featureId, featureId) !== featureId) errors.push(`handoff.featureId (${handoff.featureId}) does not match featureId (${featureId})`);
  if (typeof handoff.completed !== "boolean") errors.push("handoff.completed must be boolean");
  for (const field of ["changedFiles", "commandsRun", "assertionsAddressed", "issuesDiscovered", "leftUndone"]) if (!Array.isArray(handoff[field])) errors.push(`handoff.${field} must be an array`);
  const contractAssertions = Array.isArray(feature.assertions) ? feature.assertions.map(String) : [];
  const localAssertions = Array.isArray(feature.localAssertions) ? feature.localAssertions.map(String) : [];
  const featureAssertions = [...contractAssertions, ...localAssertions];
  const normalizedAssertions = normalizeAssertionsAddressed(handoff.assertionsAddressed, plan, localAssertions);
  errors.push(...normalizedAssertions.errors);
  for (const assertionId of normalizedAssertions.ids) if (featureAssertions.length && !featureAssertions.includes(assertionId) && !isSupplementalLocalAssertionId(assertionId)) errors.push(`Assertion ${assertionId} is not assigned to feature ${featureId}`);
  for (const assertionId of featureAssertions) if (!normalizedAssertions.ids.includes(assertionId)) errors.push(`handoff.assertionsAddressed omitted assigned assertion: ${assertionId}`);
  const declared = Array.isArray(handoff.changedFiles) ? Array.from(new Set(handoff.changedFiles.map(String).filter(Boolean))).sort() : [];
  const actual = Array.from(new Set(changedFiles || [])).sort();
  const missing = actual.filter((file) => !declared.includes(file));
  const extra = declared.filter((file) => !actual.includes(file));
  if (missing.length) errors.push(`handoff.changedFiles omitted changed files: ${missing.join(", ")}`);
  if (extra.length) errors.push(`handoff.changedFiles listed files not changed in git status/diff: ${extra.join(", ")}`);
  if (declared.some(isGeneratedJunkPath) || actual.some(isGeneratedJunkPath)) errors.push("Generated junk paths are not allowed in handoff.changedFiles or commits");
  return { ok: errors.length === 0, errors, assertionsAddressed: normalizedAssertions.ids };
}

async function runWorkerForFeature(env, milestone, feature, plan, ctx, run) {
  const featureId = safeName(feature.id || feature.title, "feature");
  const featureBranch = `mission-feature/${safeName(plan.missionId, "mission")}/${featureId}`;
  const featurePath = join(env.root, featureId);
  const registryCompletion = await completedFeatureRecord(plan, milestone, feature, featureId, featureBranch, env.missionBranch, env.baseHead, ctx.signal);
  const branchCompletion = !registryCompletion && await featureBranchLooksCompleted(env.repoRoot, featureBranch, env.missionBranch, env.baseHead, plan, milestone, feature, featureId, ctx.signal);
  if (registryCompletion || branchCompletion) {
    const commit = registryCompletion ? registryCompletion.commit : await gitRef(env.repoRoot, featureBranch, ctx.signal);
    phaseEvent(run, `worker-${featureId}`, { kind: "data", key: "resume", value: true, message: `Skipped completed ${featureId}` });
    return { featureId, featureBranch, featurePath, assertions: registryCompletion?.assertions || feature.assertions || [], localAssertions: registryCompletion?.localAssertions || feature.localAssertions || [], skipped: true, resumed: true, commit, handoffArtifact: registryCompletion?.handoffArtifact, changedFiles: registryCompletion?.changedFiles || [], featureFingerprint: registryCompletion ? registryCompletion.featureFingerprint : featureFingerprint(plan, milestone, feature, featureId) };
  }
  if (await branchMerged(env.repoRoot, featureBranch, env.missionBranch, ctx.signal)) {
    phaseEvent(run, `worker-${featureId}`, { kind: "data", key: "staleBranch", value: featureBranch, message: `Re-running stale unverified branch ${featureId}` });
  }
  if (existsSync(featurePath)) await git(env.repoRoot, ["worktree", "remove", "--force", featurePath], { signal: ctx.signal, reject: false });
  if (existsSync(featurePath)) rmSync(featurePath, { recursive: true, force: true });
  await git(env.repoRoot, ["worktree", "add", "-B", featureBranch, featurePath, env.missionBranch], { signal: ctx.signal });
  let completedSuccessfully = false;
  try {
    const handoffRel = join(".mission", "handoffs", `${featureId}.json`);
    const handoffPath = join(featurePath, handoffRel);
    mkdirSync(dirname(handoffPath), { recursive: true });
    writeFileSync(handoffPath, JSON.stringify({ featureId, completed: false, changedFiles: [], commandsRun: [], assertionsAddressed: [], issuesDiscovered: [], leftUndone: [], notesForValidator: "Fill this runner-provided handoff skeleton. Preserve featureId exactly." }, null, 2), "utf8");
    const prompt = [
      "You are a mission worker implementing exactly one feature in an isolated git worktree.",
      "Implement the requested feature. You may modify files. Do not ask for approval. Do not create commits; the runner commits after validating your handoff.",
      "Before finishing, update the runner-provided structured JSON handoff file at:",
      handoffRel,
      "The handoff JSON must include: featureId, completed, changedFiles, commandsRun[{command,exitCode}], assertionsAddressed, issuesDiscovered, leftUndone, notesForValidator.",
      "Preserve the provided featureId exactly; do not retype, shorten, extend, or add punctuation to it.",
      "assertionsAddressed must include every assigned contract assertion and every assigned local assertion for this feature. Supplemental worker-only evidence may be included as objects with type:'local' or ids prefixed local:, but supplemental local evidence does not count toward global contract coverage.",
      "changedFiles must list only files that are actually changed relative to git HEAD in this worktree. If the feature is already satisfied by the inherited codebase and you make no repository changes, write changedFiles: [] and explain the no-change completion in notesForValidator.",
      "Do not include the handoff file itself or generated junk (__pycache__, .pytest_cache, .venv, *.egg-info, etc.) in changedFiles.",
      "Lockfiles are not generic generated junk. If a validation command accidentally creates an untracked uv.lock without dependency manifest changes, remove it before writing the handoff. If dependency/reproducibility changes intentionally create or modify a lockfile, include that lockfile in changedFiles.",
      "Mission goal:", plan.goal,
      "Before implementing, inspect relevant repository source/spec documents, especially specs.md, SPEC.md, requirements.md, README.md, docs/*.md, and any plan sourceDocs.",
      "Plan sourceDocs:", JSON.stringify(plan.sourceDocs || [], null, 2),
      "Milestone:", `${milestone.id}: ${milestone.title}`,
      "Feature:", JSON.stringify(feature, null, 2),
      "Validation contract:", JSON.stringify(plan.validationContract, null, 2),
    ].join("\n");
    await ensureGeneratedJunkIgnored(featurePath, ctx.signal);
    const result = String(plan.planner || "pi") === "mock"
      ? { ok: true, text: "mock worker", usage: [] }
      : await runPi({ cwd: featurePath, prompt, tools: ["read", "grep", "find", "ls", "edit", "write", "bash"], model: ctx.modelWorker, signal: ctx.signal, operationLabel: `worker ${featureId}`, phase: `worker-${featureId}`, timeoutMs: ctx.piTimeoutMs, idleTimeoutMs: ctx.piIdleTimeoutMs });
    if (result.usage?.length) phaseEvent(run, `worker-${featureId}`, { kind: "usage", usage: result.usage, model: result.model });
    if (!result.ok) throw new Error(result.error || `worker failed for ${featureId}`);
    if (String(plan.planner || "pi") === "mock") {
      writeFileSync(handoffPath, JSON.stringify({ featureId, completed: true, changedFiles: [], commandsRun: [], assertionsAddressed: [...(feature.assertions || []), ...(feature.localAssertions || [])], issuesDiscovered: [], leftUndone: [], notesForValidator: "Mock worker completed with no repository changes." }, null, 2), "utf8");
    }
    if (!existsSync(handoffPath)) {
      const failure = { featureId, passed: false, errors: [`Worker did not write required handoff file: ${handoffRel}`] };
      writeArtifact(run, `handoffs/${featureId}-invalid.json`, failure, "json", `Invalid worker handoff: ${featureId}`);
      throw new Error(`Strict handoff validation failed for ${featureId}: missing ${handoffRel}`);
    }
    const handoff = parseJsonFromText(readFileSync(handoffPath, "utf8"));
    const canonicalFeatureId = canonicalHandoffFeatureId(handoff.featureId, featureId);
    if (canonicalFeatureId === featureId && String(handoff.featureId || "") !== featureId) {
      phaseEvent(run, `worker-${featureId}`, { kind: "data", key: "canonicalizedHandoffFeatureId", value: { from: handoff.featureId, to: featureId }, message: `Canonicalized handoff featureId to ${featureId}` });
      handoff.featureId = featureId;
    }
    const handoffArtifact = writeArtifact(run, `handoffs/${featureId}.json`, handoff, "json", `Worker handoff: ${featureId}`);
    rmSync(handoffPath, { force: true });
    await git(featurePath, ["reset", "-q"], { signal: ctx.signal, reject: false });
    await git(featurePath, ["restore", "--staged", "--worktree", "--", handoffRel], { signal: ctx.signal, reject: false });
    removeGeneratedJunk(featurePath);
    await restoreGeneratedJunkChanges(featurePath, ctx.signal);
    let changedFiles = await getChangedFiles(featurePath, ctx.signal);
    changedFiles = await autoCleanOmittedTransientArtifacts({ cwd: featurePath, handoff, changedFiles, run, phase: `worker-${featureId}`, featureId, signal: ctx.signal });
    const handoffValidation = validateHandoff({ handoff, featureId, feature, plan, changedFiles });
    if (!handoffValidation.ok) {
      const failure = { featureId, passed: false, errors: handoffValidation.errors, changedFiles, handoffArtifact };
      writeArtifact(run, `handoffs/${featureId}-invalid.json`, failure, "json", `Invalid worker handoff: ${featureId}`);
      throw new Error(`Strict handoff validation failed for ${featureId}: ${handoffValidation.errors.join("; ")}`);
    }
    handoff.assertionsAddressed = handoffValidation.assertionsAddressed;
    const handoffSummary = summarizeHandoff(handoff, handoffArtifact);
    if (!changedFiles.length) {
      phaseEvent(run, `worker-${featureId}`, { kind: "data", key: "changes", value: 0, message: "No file changes to commit" });
      const output = { featureId, featureBranch, featurePath, assertions: handoffValidation.assertionsAddressed.length ? handoffValidation.assertionsAddressed.filter((id) => knownContractAssertionIds(plan).has(String(id))) : (feature.assertions || []), localAssertions: handoffValidation.assertionsAddressed.filter((id) => !knownContractAssertionIds(plan).has(String(id))), handoffArtifact, handoff: handoffSummary, changedFiles, commit: undefined, featureFingerprint: featureFingerprint(plan, milestone, feature, featureId) };
      completedSuccessfully = true;
      return output;
    }
    await git(featurePath, ["add", "-A"], { signal: ctx.signal });
    const staged = await git(featurePath, ["diff", "--cached", "--name-only"], { signal: ctx.signal, reject: false });
    const junkStaged = (staged.ok ? staged.stdout.split(/\r?\n/).filter(Boolean) : []).filter(isGeneratedJunkPath);
    if (junkStaged.length) {
      await git(featurePath, ["restore", "--staged", "--", ...junkStaged], { signal: ctx.signal, reject: false });
      throw new Error(`Generated junk staged for commit in ${featureId}: ${junkStaged.join(", ")}`);
    }
    await git(featurePath, ["commit", "-m", expectedFeatureCommitSubject(plan, feature, featureId), "-m", [`Mission-Feature-Id: ${featureId}`, `Mission-Feature-Fingerprint: ${featureFingerprint(plan, milestone, feature, featureId)}`].join("\n")], { signal: ctx.signal });
    const commit = (await git(featurePath, ["rev-parse", "HEAD"], { signal: ctx.signal })).stdout.trim();
    await git(env.integrationPath, ["merge", "--ff-only", featureBranch], { signal: ctx.signal });
    phaseEvent(run, `worker-${featureId}`, { kind: "data", key: "commit", value: commit, message: `Committed ${featureId}` });
    const output = { featureId, featureBranch, featurePath, assertions: handoffValidation.assertionsAddressed.length ? handoffValidation.assertionsAddressed.filter((id) => knownContractAssertionIds(plan).has(String(id))) : (feature.assertions || []), localAssertions: handoffValidation.assertionsAddressed.filter((id) => !knownContractAssertionIds(plan).has(String(id))), handoffArtifact, handoff: handoffSummary, changedFiles, commit, featureFingerprint: featureFingerprint(plan, milestone, feature, featureId) };
    completedSuccessfully = true;
    return output;
  } finally {
    if (!completedSuccessfully) await preserveFailedWorkerArtifacts(featurePath, featureId, run, ctx.signal).catch(() => {});
    await git(env.repoRoot, ["worktree", "remove", "--force", featurePath], { signal: ctx.signal, reject: false });
  }
}

function contractAssertionMap(plan) {
  return new Map((plan.validationContract?.assertions || []).map((assertion) => [String(assertion.id), assertion]));
}

function knownContractAssertionIds(plan) {
  return new Set((plan.validationContract?.assertions || []).map((assertion) => String(assertion.id)));
}

function milestoneAssertionIds(plan, milestone) {
  const known = contractAssertionMap(plan);
  const ids = new Set();
  for (const feature of milestone.features || []) for (const id of feature.assertions || []) if (known.has(String(id))) ids.add(String(id));
  return ids;
}

function milestoneCoverageAssertions(plan, milestone, scope = "milestone") {
  if (scope === "final" || !milestone) return plan.validationContract?.assertions || [];
  const known = contractAssertionMap(plan);
  const ids = milestoneAssertionIds(plan, milestone);
  const rows = Array.from(ids).map((id) => known.get(id)).filter(Boolean);
  const seen = new Set(rows.map((assertion) => String(assertion.id)));
  for (const feature of milestone.features || []) for (const assertion of feature.localAssertions || []) {
    const id = String(assertion);
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, description: id, priority: "must", local: true });
  }
  return rows;
}

function buildCoverageReport({ plan, milestone, iterationState, commandReports, validatorReport, scope = "milestone" }) {
  const featureResults = iterationState?.features || [];
  const knownAssertions = contractAssertionMap(plan);
  const featuresByAssertion = new Map();
  const allPlanFeatures = (plan.milestones || []).flatMap((m) => m.features || []);
  const candidateFeatures = scope === "final" ? allPlanFeatures : (milestone?.features || []);
  for (const feature of candidateFeatures) for (const id of [...(feature.assertions || []), ...(scope === "final" ? [] : (feature.localAssertions || []))]) {
    const key = String(id);
    if (!featuresByAssertion.has(key)) featuresByAssertion.set(key, []);
    const result = featureResults.find((item) => item.featureId === safeName(feature.id || feature.title, "feature"));
    featuresByAssertion.get(key).push({ featureId: safeName(feature.id || feature.title, "feature"), title: feature.title, commit: result?.commit, handoff: result?.handoffArtifact || result?.handoff?.artifact, status: result ? (result.skipped ? "previously-completed" : "completed") : "planned" });
  }
  for (const result of featureResults) for (const id of result.assertions || []) {
    const key = String(id);
    if (scope === "final" && !knownAssertions.has(key)) continue;
    if (!featuresByAssertion.has(key)) featuresByAssertion.set(key, []);
    if (!featuresByAssertion.get(key).some((item) => item.featureId === result.featureId && item.commit === result.commit)) featuresByAssertion.get(key).push({ featureId: result.featureId, title: result.featureId, commit: result.commit, handoff: result.handoffArtifact || result.handoff?.artifact, status: result.skipped ? "previously-completed" : "completed" });
  }
  if (scope !== "final") for (const result of featureResults) for (const id of result.localAssertions || []) {
    const key = String(id);
    if (!featuresByAssertion.has(key)) featuresByAssertion.set(key, []);
    if (!featuresByAssertion.get(key).some((item) => item.featureId === result.featureId && item.commit === result.commit)) featuresByAssertion.get(key).push({ featureId: result.featureId, title: result.featureId, commit: result.commit, handoff: result.handoffArtifact || result.handoff?.artifact, status: result.skipped ? "previously-completed" : "completed" });
  }
  const validatorAssertions = new Map((validatorReport?.assertionResults || []).map((result) => [String(result.assertionId), result]));
  const commandPassed = commandReports.every((report) => report.passed);
  const rows = milestoneCoverageAssertions(plan, milestone, scope).map((assertion) => {
    const features = featuresByAssertion.get(String(assertion.id)) || [];
    const validator = validatorAssertions.get(String(assertion.id));
    const validators = [
      ...commandReports.map((report) => ({ validator: report.validator, command: report.command, passed: report.passed, artifact: report.artifact })),
      ...(validatorReport ? [{ validator: "adversarial-scrutiny", passed: validatorReport.passed && isPassedAssertionStatus(validator?.status), artifact: validatorReport.artifact, evidence: validator?.evidence }] : []),
    ];
    let status = "pass";
    const gaps = [];
    if (!features.length) { status = "gap"; gaps.push("No planned/executed feature maps to assertion."); }
    if (!commandPassed) { status = "fail"; gaps.push("One or more command validators failed."); }
    if (validatorReport && !isPassedAssertionStatus(validator?.status)) { status = "fail"; gaps.push(validator?.evidence || "Adversarial validator did not explicitly pass this assertion."); }
    if (validatorReport === null) { status = status === "pass" ? "unknown" : status; gaps.push("No adversarial validator report available."); }
    return { assertionId: assertion.id, description: assertion.description, priority: assertion.priority || "must", local: Boolean(assertion.local), features, commits: features.map((f) => f.commit).filter(Boolean), validators, status, gaps };
  });
  const gaps = rows.filter((row) => row.status !== "pass" && row.priority === "must").flatMap((row) => row.gaps.map((gap) => ({ assertionId: row.assertionId, level: "must", description: gap })));
  return { schema: "pi-mission-workflow/coverage/v1", scope, milestoneId: milestone?.id, generatedAt: new Date().toISOString(), assertions: rows, gaps };
}

function normalizeValidatorReport(raw, { plan, milestone, coverageGaps }) {
  const objections = Array.isArray(raw?.objections) ? raw.objections.map((objection) => ({
    level: ["must", "should", "nit"].includes(String(objection.level)) ? String(objection.level) : "must",
    assertionId: objection.assertionId ? (canonicalAssertionId(objection.assertionId, plan.validationContract) || String(objection.assertionId)) : undefined,
    description: String(objection.description || objection.summary || objection.message || "Validator objection"),
    evidence: String(objection.evidence || ""),
    repairHint: String(objection.repairHint || objection.repair || ""),
  })) : [];
  for (const gap of coverageGaps || []) objections.push({ level: "must", assertionId: gap.assertionId, description: `Coverage gap: ${gap.description}`, evidence: "Requirement/assertion coverage report", repairHint: "Add or repair a feature that directly satisfies this assertion." });
  const scopedAssertions = milestoneCoverageAssertions(plan, milestone, "milestone");
  const scopedIds = new Set(scopedAssertions.map((assertion) => String(assertion.id)));
  const assertionResults = Array.isArray(raw?.assertionResults) ? raw.assertionResults.map((result) => ({ assertionId: canonicalAssertionId(result.assertionId || result, plan.validationContract) || String(result.assertionId || ""), status: String(result.status || "unknown"), evidence: String(result.evidence || "") })) : scopedAssertions.map((assertion) => ({ assertionId: assertion.id, status: objections.some((o) => o.assertionId === assertion.id && o.level === "must") ? "fail" : "pass", evidence: "Adversarial scrutiny completed." }));
  for (const assertion of scopedAssertions) if (!assertionResults.some((result) => String(result.assertionId) === String(assertion.id))) assertionResults.push({ assertionId: assertion.id, status: "unknown", evidence: "Validator omitted scoped assertion result." });
  if (raw?.passed === false && !objections.some((objection) => objection.level === "must")) objections.push({ level: "must", assertionId: assertionResults.find((result) => scopedIds.has(String(result.assertionId)))?.assertionId, description: "Validator marked milestone as failed without a must-level objection.", evidence: String(raw?.summary || "validator passed=false"), repairHint: "Provide or repair the blocking validator objection." });
  const correctiveFeatures = Array.isArray(raw?.correctiveFeatures) ? raw.correctiveFeatures.map((feature) => ({ ...feature, assertions: normalizeAssertionReferences(feature.assertions || [], plan.validationContract) })) : objections.filter((o) => o.level === "must").map((objection) => ({ title: `Repair ${objection.assertionId || milestone.id}: ${objection.description}`.slice(0, 160), assertions: objection.assertionId ? [objection.assertionId] : scopedAssertions.map((assertion) => assertion.id), rationale: objection.evidence || objection.description }));
  return {
    schema: "pi-mission-workflow/adversarial-validation/v1",
    milestoneId: milestone.id,
    passed: !objections.some((objection) => objection.level === "must") && raw?.passed !== false,
    summary: String(raw?.summary || "Adversarial scrutiny completed."),
    objections,
    assertionResults,
    correctiveFeatures,
  };
}

async function runAdversarialValidator(env, plan, milestone, iterationState, commandReports, coverageDraft, ctx, run) {
  let raw;
  if (String(plan.planner || "pi") === "mock") {
    raw = { passed: true, summary: "Mock adversarial validator accepted the milestone.", objections: [], assertionResults: milestoneCoverageAssertions(plan, milestone, "milestone").map((assertion) => ({ assertionId: assertion.id, status: "pass", evidence: "Mock validation." })) };
  } else {
    const diffStat = await git(env.integrationPath, ["diff", "--stat", `${env.baseHead}..HEAD`], { signal: ctx.signal, reject: false });
    const diffFiles = await git(env.integrationPath, ["diff", "--name-only", `${env.baseHead}..HEAD`], { signal: ctx.signal, reject: false });
    const prompt = compactText([
      "You are a fresh read-only Pi validator agent. Do not edit files or write commits. You may only inspect with read/grep/find/ls.",
      "Adversarially validate the completed milestone. Be skeptical: must-level objections block the mission and should become targeted repair features.",
      "Scope rule: block only on this milestone's coverage assertions/feature acceptance checks and regressions introduced by this milestone. Do not require future milestones or full-system invariants unless they are explicitly assigned in the coverage draft.",
      "Review the original/source docs (README.md, specs.md, SPEC.md, requirements.md, docs/*.md, and plan.sourceDocs), scoped validation contract, milestone worker handoffs, git diff, and command validation outputs.",
      "Return ONLY JSON with schema, milestoneId, passed, summary, objections[{level,assertionId,description,evidence,repairHint}], assertionResults[{assertionId,status,evidence}], correctiveFeatures[{title,description,assertions,rationale}].",
      `Mission goal: ${plan.goal}`,
      `Plan sourceDocs: ${compactJson(plan.sourceDocs || [], 8000)}`,
      `Scoped coverage assertions: ${compactJson(coverageDraft.assertions || [], 30000)}`,
      `Milestone: ${compactJson({ id: milestone.id, title: milestone.title, features: milestone.features }, 30000)}`,
      `Worker handoffs and commits: ${compactJson(iterationState.features.map((feature) => ({ featureId: feature.featureId, commit: feature.commit, skipped: feature.skipped, handoffArtifact: feature.handoffArtifact, handoff: feature.handoff, changedFiles: feature.changedFiles })), 30000)}`,
      `Command validation reports: ${compactJson(commandReports, 30000)}`,
      `Coverage draft: ${compactJson(coverageDraft, 30000)}`,
      `Git diff stat ${env.baseHead}..HEAD:\n${compactText(diffStat.stdout || diffStat.stderr || "", 12000)}`,
      `Git diff files ${env.baseHead}..HEAD:\n${compactText(diffFiles.stdout || diffFiles.stderr || "", 12000)}`,
    ].join("\n\n"), MAX_PROMPT_CONTEXT_BYTES);
    const validatorPromptPath = writeArtifact(run, `validation/${safeName(milestone.id)}-validator-prompt.md`, prompt, "markdown", `Validator prompt: ${milestone.id}`);
    const result = await runPi({ cwd: env.integrationPath, prompt, tools: ["read", "grep", "find", "ls"], model: ctx.modelValidator, signal: ctx.signal, operationLabel: `validator ${milestone.id}`, phase: `validator-${milestone.id}`, timeoutMs: ctx.piTimeoutMs, idleTimeoutMs: ctx.piIdleTimeoutMs });
    if (result.usage?.length) phaseEvent(run, `validator-${milestone.id}`, { kind: "usage", usage: result.usage, model: result.model });
    if (!result.ok) raw = { passed: false, summary: "Validator agent failed.", objections: [{ level: "must", description: result.error || "validator failed", evidence: compactText(result.stderr || result.stdout || "", 4000), repairHint: "Rerun or repair validation environment." }], assertionResults: [] };
    else {
      try { raw = parseJsonFromText(result.text); }
      catch (error) {
        writeArtifact(run, `validation/${safeName(milestone.id)}-validator-output.md`, result.text, "markdown", `Validator raw output: ${milestone.id}`);
        raw = { passed: false, summary: "Validator returned malformed JSON.", objections: [{ level: "must", description: error.message, evidence: validatorPromptPath, repairHint: "Return strict JSON validation report." }], assertionResults: [] };
      }
    }
  }
  const normalized = normalizeValidatorReport(raw, { plan, milestone, coverageGaps: coverageDraft.gaps });
  const artifactPath = writeArtifact(run, `validation/${safeName(milestone.id)}-adversarial-report.json`, normalized, "json", `Adversarial validation report: ${milestone.id}`);
  return { ...normalized, artifact: artifactPath };
}

async function runValidation(env, plan, milestone, iterationState, ctx, run) {
  const reports = [];
  for (const command of plan.validationCommands || []) {
    const result = await runProcess(command, [], { cwd: env.integrationPath, shell: true, signal: ctx.signal, timeoutMs: ctx.commandTimeoutMs, operationLabel: `validation command: ${command}`, phase: `validation-${milestone.id}` });
    const file = writeArtifact(run, `validation/${safeName(milestone.id)}-${safeName(command)}.txt`, [`$ ${command}`, result.error ? `# ${result.error}` : "", result.stdout, result.stderr].join("\n"), "file", `Validation command: ${command}`);
    reports.push({ validator: "scrutiny-command", command, passed: result.ok, exitCode: result.code, timedOut: Boolean(result.timedOut), artifact: file, stdoutExcerpt: compactText(result.stdout || "", 4000), stderrExcerpt: compactText(result.stderr || result.error || "", 4000) });
  }
  if (plan.userTestCommand) {
    const command = plan.userTestCommand;
    const result = await runProcess(command, [], { cwd: env.integrationPath, shell: true, signal: ctx.signal, timeoutMs: ctx.commandTimeoutMs, operationLabel: `user test command: ${command}`, phase: `validation-${milestone.id}` });
    const file = writeArtifact(run, `validation/${safeName(milestone.id)}-user-test.txt`, [`$ ${command}`, result.error ? `# ${result.error}` : "", result.stdout, result.stderr].join("\n"), "file", `User testing command: ${command}`);
    reports.push({ validator: "user-testing-command", command, passed: result.ok, exitCode: result.code, timedOut: Boolean(result.timedOut), artifact: file, stdoutExcerpt: compactText(result.stdout || "", 4000), stderrExcerpt: compactText(result.stderr || result.error || "", 4000) });
  }
  if (reports.length === 0) reports.push({ validator: "scrutiny-command", command: "none", passed: true, note: "No validation commands configured." });
  const coverageDraft = buildCoverageReport({ plan, milestone, iterationState, commandReports: reports, validatorReport: undefined, scope: "milestone" });
  const validatorReport = await runAdversarialValidator(env, plan, milestone, iterationState, reports, coverageDraft, ctx, run);
  const coverage = buildCoverageReport({ plan, milestone, iterationState, commandReports: reports, validatorReport, scope: "milestone" });
  const coveragePath = writeArtifact(run, `coverage/${safeName(milestone.id)}-coverage.json`, coverage, "json", `Coverage: ${milestone.id}`);
  const commandPassed = reports.every((report) => report.passed);
  const mustObjections = validatorReport.objections.filter((objection) => objection.level === "must");
  const passed = commandPassed && validatorReport.passed !== false && mustObjections.length === 0 && coverage.gaps.length === 0;
  const assertionResults = coverage.assertions.map((row) => ({ assertionId: row.assertionId, status: row.status === "pass" ? "pass" : "fail", evidence: row.gaps.join("; ") || "Command and adversarial validators passed." }));
  const correctiveFeatures = passed ? [] : [
    ...validatorReport.correctiveFeatures,
    ...coverage.gaps.map((gap) => ({ title: `Close coverage gap for ${gap.assertionId}`, assertions: [gap.assertionId], rationale: gap.description })),
    ...(!commandPassed ? [{ title: `Repair validation command failures for ${milestone.title}`, assertions: assertionResults.map((r) => r.assertionId), rationale: "Validation command failed." }] : []),
  ];
  const report = { schema: "pi-mission-workflow/milestone-validation/v1", milestoneId: milestone.id, passed, reports, validatorReport, coveragePath, assertionResults, correctiveFeatures };
  const reportPath = writeArtifact(run, `validation/${safeName(milestone.id)}-report.json`, report, "json", `Validation report: ${milestone.id}`);
  return { ...report, artifact: reportPath };
}

function repairFeatureStableHash(report, iteration, feature, index, fallback) {
  const title = feature.title || fallback.title;
  const assertions = Array.isArray(feature.assertions) && feature.assertions.length ? feature.assertions.map(String).sort() : (fallback.assertions || []).map(String).sort();
  return createHash("sha256").update(JSON.stringify({
    schema: "pi-mission-repair-feature-id/v1",
    milestoneId: String(report.milestoneId || ""),
    iteration: Number(iteration),
    index: Number(index),
    title: String(title || "").replace(/\s+/g, " ").trim(),
    description: String(feature.description || "").replace(/\s+/g, " ").trim(),
    assertions,
    rationale: String(feature.rationale || "").replace(/\s+/g, " ").trim(),
  })).digest("hex").slice(0, 10);
}

function repairFeatureStableId(report, iteration, feature, index, fallback) {
  return `repair-${safeName(report.milestoneId)}-${iteration}-${repairFeatureStableHash(report, iteration, feature, index, fallback)}`;
}

function repairFeaturesFromReport(report, iteration) {
  const fallback = { title: `Repair ${report.milestoneId}`, assertions: report.assertionResults?.map((result) => result.assertionId).filter(Boolean) || [], rationale: "Milestone validation failed." };
  const corrective = report.correctiveFeatures?.length ? report.correctiveFeatures : [fallback];
  return corrective.map((feature, index) => ({
    id: repairFeatureStableId(report, iteration, feature, index, fallback),
    repairSignature: repairFeatureStableHash(report, iteration, feature, index, fallback),
    title: feature.title || fallback.title,
    description: compactText(feature.description || `Repair validation failures from report: ${JSON.stringify({ commandReports: report.reports || [], objections: report.validatorReport?.objections || [], coveragePath: report.coveragePath, rationale: feature.rationale }, null, 2)}`, 8000),
    assertions: Array.isArray(feature.assertions) && feature.assertions.length ? feature.assertions.map(String) : fallback.assertions,
    repair: true,
  }));
}

async function activateMission(args, cwd, run, ctx) {
  if (!isTruthyFlag(args.approved)) throw new Error("Activation requires --approved after the user reviews the mission plan.");
  if (!args["plan-path"]) throw new Error("--plan-path is required for activation");
  const planPathAbs = resolve(cwd, String(args["plan-path"]));
  const plan = validatePlanForActivation(JSON.parse(readFileSync(planPathAbs, "utf8")));
  ctx.modelWorker = args["model-worker"] || plan.modelWorker || ctx.modelWorker;
  ctx.modelValidator = args["model-validator"] || plan.modelValidator || ctx.modelValidator;
  const priorRegistry = readJsonFile(registryStatePath(plan.missionId), {});
  if (priorRegistry.status === "completed") throw new Error(`Mission ${plan.missionId} is already completed; review the final report or start a new mission.`);
  const env = await ensureMissionWorktrees(plan, ctx, run, { resume: isTruthyFlag(args.resume) });
  if (isTruthyFlag(args.resume) && priorRegistry.branch && priorRegistry.branch !== env.missionBranch) throw new Error(`Registry branch ${priorRegistry.branch} does not match expected mission branch ${env.missionBranch}`);
  await enforceTrustedMissionBranch(plan, env, ctx, run, { resume: isTruthyFlag(args.resume) });
  const registryPlan = persistRegistryPlan(plan, planPathAbs);
  phaseEvent(run, "prepare-mission", { kind: "data", key: "registry", value: registryStatePath(plan.missionId), message: "Using durable mission registry" });
  const registry = updateRegistryState(plan, (state) => ({ ...state, status: "running", planPath: planPathAbs, branch: env.missionBranch, repoRoot: env.repoRoot, worktree: env.integrationPath, worktreeBaseDir: env.root, roleModels: { plan: plan.modelPlan, worker: ctx.modelWorker, validator: ctx.modelValidator }, resumed: env.resumed, resumeCompletedFeatureCount: isTruthyFlag(args.resume) ? (priorRegistry.completedFeatures || []).length : undefined, timestamps: { ...(state.timestamps || {}), ...(registryPlan.state.timestamps || {}), startedAt: state.timestamps?.startedAt || new Date().toISOString() } }));
  const missionState = { missionId: plan.missionId, missionBranch: env.missionBranch, integrationPath: env.integrationPath, baseHead: env.baseHead, registryPath: registry.statePath, modelWorker: ctx.modelWorker, modelValidator: ctx.modelValidator, resumed: env.resumed, milestones: [], startedAt: new Date().toISOString() };
  for (const milestone of plan.milestones) {
    currentHeartbeat = { phase: "execute-mission", missionId: plan.missionId, milestoneId: milestone.id, milestoneTitle: milestone.title, branch: env.missionBranch, worktree: env.integrationPath };
    let iteration = 0;
    let queue = [...(milestone.features || [])];
    const milestoneState = { id: milestone.id, title: milestone.title, iterations: [] };
    while (iteration < Number(plan.maxRepairIterations || DEFAULT_MAX_REPAIR_ITERATIONS)) {
      if (ctx.signal.aborted) throw abortError(ctx.signal.reason || "cancelled");
      iteration++;
      const iterationState = { iteration, features: [], validation: undefined };
      updateRegistryState(plan, (state) => ({ ...state, current: { milestoneId: milestone.id, iteration }, status: "running" }));
      for (const feature of queue) {
        const featureId = safeName(feature.id || feature.title, "feature");
        currentHeartbeat = { phase: "execute-mission", missionId: plan.missionId, milestoneId: milestone.id, iteration, featureId, branch: env.missionBranch, worktree: env.integrationPath };
        updateRegistryState(plan, (state) => ({ ...state, current: { milestoneId: milestone.id, iteration, featureId }, status: "running" }));
        phaseEvent(run, "execute-mission", { kind: "heartbeat", ...currentHeartbeat, pid: process.pid, childPids: Array.from(activeChildren).map((child) => child.pid).filter(Boolean), message: `Worker ${featureId}` });
        phaseEvent(run, "execute-mission", { kind: "progress", current: iterationState.features.length, total: queue.length, message: `Worker ${featureId}` });
        const result = await runWorkerForFeature(env, milestone, feature, plan, ctx, run);
        iterationState.features.push(result);
        const trustedHead = (await git(env.integrationPath, ["rev-parse", "HEAD"], { signal: ctx.signal })).stdout.trim();
        updateRegistryState(plan, (state) => {
          const sameResultRecord = (item) => {
            if (!(item.featureId === result.featureId && item.milestoneId === milestone.id)) return false;
            const existingFingerprint = item.featureFingerprint ? String(item.featureFingerprint) : "";
            const resultFingerprint = result.featureFingerprint ? String(result.featureFingerprint) : "";
            return !existingFingerprint || !resultFingerprint || existingFingerprint === resultFingerprint;
          };
          return { ...state, trustedBaseHead: state.trustedBaseHead || env.baseHead, trustedHead, trustedPlanFingerprint: missionPlanFingerprint(plan, env.baseHead), trustedCommits: Array.from(new Set([...(state.trustedCommits || []), ...(result.commit ? [result.commit] : [])])), completedFeatures: [...(state.completedFeatures || []).filter((item) => !sameResultRecord(item)), { featureId: result.featureId, milestoneId: milestone.id, iteration, branch: result.featureBranch, commit: result.commit, handoffArtifact: result.handoffArtifact, changedFiles: result.changedFiles || [], assertions: result.assertions || [], localAssertions: result.localAssertions || [], assignedAssertions: feature.assertions || [], assignedLocalAssertions: feature.localAssertions || [], featureFingerprint: result.featureFingerprint, repairSignature: repairSignatureFromFeature(feature, result.featureId), skipped: Boolean(result.skipped), completedAt: new Date().toISOString() }] };
        });
      }
      queue = [];
      currentHeartbeat = { phase: "execute-mission", missionId: plan.missionId, milestoneId: milestone.id, iteration, validator: "adversarial-scrutiny", branch: env.missionBranch, worktree: env.integrationPath };
      const validation = await runValidation(env, plan, milestone, iterationState, ctx, run);
      iterationState.validation = { artifact: validation.artifact, passed: validation.passed, coveragePath: validation.coveragePath, objections: validation.validatorReport?.objections || [] };
      milestoneState.iterations.push(iterationState);
      const iterationPath = writeArtifact(run, `state/${safeName(milestone.id)}-iteration-${iteration}.json`, iterationState, "json", `Mission state: ${milestone.id} iteration ${iteration}`);
      updateRegistryState(plan, (state) => ({ ...state, validationReports: [...(state.validationReports || []), { milestoneId: milestone.id, iteration, artifact: validation.artifact, coveragePath: validation.coveragePath, passed: validation.passed, completedAt: new Date().toISOString() }], coverageReports: [...(state.coverageReports || []), { milestoneId: milestone.id, iteration, artifact: validation.coveragePath }], current: { milestoneId: milestone.id, iteration, validationReport: validation.artifact }, lastIterationState: iterationPath }));
      if (validation.passed) break;
      if (iteration >= Number(plan.maxRepairIterations || DEFAULT_MAX_REPAIR_ITERATIONS)) throw new Error(`Mission ${plan.missionId} reached max repair iterations (${iteration}) for ${milestone.id}`);
      queue = repairFeaturesFromReport(validation, iteration);
    }
    missionState.milestones.push(milestoneState);
  }
  const allFeatureResults = missionState.milestones.flatMap((m) => m.iterations || []).flatMap((iteration) => iteration.features || []);
  const lastValidationReports = missionState.milestones.flatMap((m) => (m.iterations || []).map((iteration) => iteration.validation).filter(Boolean));
  const finalCoverage = buildCoverageReport({ plan, milestone: undefined, iterationState: { features: allFeatureResults }, commandReports: [], validatorReport: undefined, scope: "final" });
  const finalCoveragePath = writeArtifact(run, "coverage/final-coverage.json", finalCoverage, "json", "Final requirement coverage");
  if (finalCoverage.gaps.length) {
    writeArtifact(run, "validation/final-coverage-objections.json", { schema: "pi-mission-workflow/final-coverage-objections/v1", passed: false, objections: finalCoverage.gaps.map((gap) => ({ level: "must", assertionId: gap.assertionId, description: `Final coverage gap: ${gap.description}`, evidence: finalCoveragePath, repairHint: "Add or repair features until this assertion has coverage and validator evidence." })) }, "json", "Final coverage objections");
    throw new Error(`Mission ${plan.missionId} has final requirement coverage gaps: ${finalCoverage.gaps.map((gap) => `${gap.assertionId}: ${gap.description}`).join("; ")}`);
  }
  missionState.completedAt = new Date().toISOString();
  missionState.finalCoveragePath = finalCoveragePath;
  const statePath = writeArtifact(run, "mission-state.json", missionState, "json", "Mission state");
  updateRegistryState(plan, (state) => ({ ...state, status: "completed", current: {}, finalCoveragePath, statePath, validationReports: state.validationReports || lastValidationReports, coverageReports: [...(state.coverageReports || []), { scope: "final", artifact: finalCoveragePath }], timestamps: { ...(state.timestamps || {}), completedAt: missionState.completedAt } }));
  const final = [
    "# Mission complete",
    "",
    `Mission: ${plan.missionId}`,
    `Branch: ${env.missionBranch}`,
    `Integration worktree: ${env.integrationPath}`,
    `Base HEAD: ${env.baseHead}`,
    `Registry state: ${registry.statePath}`,
    `Final coverage: ${finalCoveragePath}`,
    "",
    "Review and merge manually when ready:",
    "",
    "```bash",
    `cd ${env.repoRoot}`,
    `git log --oneline ${env.baseHead}..${env.missionBranch}`,
    `git diff ${env.baseHead}..${env.missionBranch}`,
    `git switch - # or your target branch`,
    `git merge ${env.missionBranch}`,
    "```",
  ].join("\n");
  const finalPath = writeArtifact(run, "final-report.md", final, "markdown", "Final mission report");
  return { plan: { missionId: plan.missionId }, env, registryPath: registry.statePath, statePath, finalPath, finalCoveragePath };
}

async function status(args, cwd) {
  const repo = await git(cwd, ["worktree", "list"], { reject: false });
  return { ok: repo.ok, cwd, worktrees: repo.stdout };
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const args = parseArgs(rawArgv);
  const action = String(args._[0] || args.action || "plan");
  if (["help", "--help", "-h"].includes(action)) {
    console.log("Usage: mission-workflow.mjs plan --goal GOAL --cwd REPO | activate|resume --plan-path mission-plan.json --approved --cwd REPO [--background]");
    return;
  }
  const cwd = resolve(String(args.cwd || process.cwd()));
  if (action === "resume") args.resume = true;
  if (["activate", "resume"].includes(action) && (!args["plan-path"] || !isTruthyFlag(args.approved))) throw new Error(`${action} requires --plan-path and --approved`);
  if (maybeBackground(rawArgv, args, cwd)) return;

  if (action === "status") {
    console.log(JSON.stringify(await status(args, cwd), null, 2));
    return;
  }

  const workflow = action === "plan" ? "mission-plan" : "mission-workflow";
  const run = createRun({
    workflow,
    cwd,
    trigger: { kind: process.env.PI_MISSION_WORKFLOW_BACKGROUND_CHILD === "1" ? "background" : "manual", mission: true, action },
    input: { action, ...args, _: undefined },
    metadata: { pid: process.pid, cancellable: true, mission: true, action, sessionId: args["session-id"], sessionFile: args["session-file"], autoContinue: action === "activate" },
    message: `${workflow} ${action} started`,
  });
  activeRun = run;
  const controller = new AbortController();
  activeAbortController = controller;
  const stopWatchingCancellation = watchCancellation(run, controller);
  const stopHeartbeat = startHeartbeat(run, { action });
  const ctx = {
    cache: new PipelineCache(),
    signal: controller.signal,
    modelWorker: args["model-worker"],
    modelValidator: args["model-validator"],
    piTimeoutMs: parseMillis(args["pi-timeout-ms"], DEFAULT_PI_TIMEOUT_MS),
    piIdleTimeoutMs: parseMillis(args["pi-idle-timeout-ms"], DEFAULT_PI_IDLE_TIMEOUT_MS),
    commandTimeoutMs: parseMillis(args["command-timeout-ms"], DEFAULT_COMMAND_TIMEOUT_MS),
  };

  try {
    let result;
    if (action === "plan") {
      const phases = [{ name: "create-plan", async *run() { result = await createPlan(args, cwd, run, ctx); yield { type: "data", kind: "data", key: "planPath", value: result.planPath, message: "Mission plan created" }; } }];
      for await (const _event of runPipeline(wrapPhases(phases, run), ctx, { signal: controller.signal })) {}
      completeRun(run, STATUSES.SUCCESS, { ok: true, planPath: result.planPath, contractPath: result.contractPath, registryPath: result.registryPath });
      finalizedRun = true;
      console.log(JSON.stringify({ ok: true, action, runId: run.runId, cwd, ...result }, null, 2));
    } else if (action === "activate" || action === "resume") {
      const phases = [
        { name: "prepare-mission", async *run() { yield { type: "data", kind: "data", key: "planPath", value: args["plan-path"], message: "Loading approved mission plan" }; } },
        { name: "execute-mission", async *run() { result = await activateMission(args, cwd, run, ctx); yield { type: "data", kind: "data", key: "branch", value: result.env.missionBranch, message: "Mission execution complete" }; } },
        { name: "final-report", async *run() { yield { type: "data", kind: "data", key: "report", value: result.finalPath, message: "Final report written" }; } },
      ];
      for await (const _event of runPipeline(wrapPhases(phases, run), ctx, { signal: controller.signal })) {}
      completeRun(run, STATUSES.SUCCESS, { ok: true, missionId: result.plan.missionId, branch: result.env.missionBranch, finalPath: result.finalPath, registryPath: result.registryPath, finalCoveragePath: result.finalCoveragePath });
      finalizedRun = true;
      console.log(JSON.stringify({ ok: true, action, runId: run.runId, cwd, missionId: result.plan.missionId, branch: result.env.missionBranch, finalPath: result.finalPath, registryPath: result.registryPath, finalCoveragePath: result.finalCoveragePath }, null, 2));
    } else {
      throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    if (cancellationRequested || isAbortError(error) || controller.signal.aborted) {
      try { markMissionRegistryTerminalFromArgs(args, cwd, "cancelled", error); } catch { /* registry terminal marking is best effort */ }
      if (activeRun === run) completeRun(run, STATUSES.CANCELLED, { cancelled: true, reason: controller.signal.reason || error?.message });
      finalizedRun = true;
      console.log(JSON.stringify({ ok: false, cancelled: true, action, runId: run.runId, cwd }, null, 2));
      process.exitCode = 130;
    } else {
      try { markMissionRegistryTerminalFromArgs(args, cwd, "failed", error); } catch { /* registry terminal marking is best effort */ }
      failRun(run, error);
      finalizedRun = true;
      console.log(JSON.stringify({ ok: false, action, runId: run.runId, cwd, error: error.message }, null, 2));
      process.exitCode = 1;
    }
  } finally {
    stopWatchingCancellation?.();
    stopHeartbeat?.();
    activeRun = undefined;
    activeAbortController = undefined;
  }
}

await main();
