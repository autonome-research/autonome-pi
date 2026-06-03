#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
const MAX_OUTPUT_BYTES = 250_000;
const DEFAULT_PERMISSIONS = normalizePermissions(process.env.PI_DYNAMIC_WORKFLOW_DEFAULT_PERMISSIONS || process.env.PI_DYNAMIC_THREAD_PHASE_DEFAULT_PERMISSIONS || "r", "PI_DYNAMIC_WORKFLOW_DEFAULT_PERMISSIONS");
const MAX_PERMISSIONS = normalizePermissions(process.env.PI_DYNAMIC_WORKFLOW_MAX_PERMISSIONS || process.env.PI_DYNAMIC_THREAD_PHASE_MAX_PERMISSIONS || "rwx", "PI_DYNAMIC_WORKFLOW_MAX_PERMISSIONS");

async function loadThreadPhaseCore() {
  try {
    return await import("@autonome-research/thread-phase");
  } catch {
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

function validateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("spec must be an object");
  if (spec.name !== undefined) validateName(spec.name, "spec");
  if (!Array.isArray(spec.phases) || spec.phases.length === 0) throw new Error("spec.phases must be a non-empty array");
  if (spec.phases.length > 30) throw new Error("spec.phases is capped at 30 phases");
  const seen = new Set();
  for (let i = 0; i < spec.phases.length; i++) {
    const phase = spec.phases[i];
    if (!phase || typeof phase !== "object" || Array.isArray(phase)) throw new Error(`phase ${i} must be an object`);
    validateName(phase.name, `phase ${i}`);
    if (seen.has(phase.name)) throw new Error(`duplicate phase name: ${phase.name}`);
    seen.add(phase.name);
    if (!["shell", "pi", "fanout_pi", "artifact"].includes(phase.type)) throw new Error(`unsupported phase type for ${phase.name}: ${phase.type}`);
    if (phase.type === "shell" && typeof phase.command !== "string") throw new Error(`${phase.name}.command must be a string`);
    if (phase.type === "pi" && typeof phase.prompt !== "string") throw new Error(`${phase.name}.prompt must be a string`);
    if (phase.type === "fanout_pi") {
      if (typeof phase.promptTemplate !== "string") throw new Error(`${phase.name}.promptTemplate must be a string`);
      if (!Array.isArray(phase.items) && typeof phase.itemsFrom !== "string") throw new Error(`${phase.name} must provide items array or itemsFrom phase name`);
    }
    if (phase.type === "artifact" && typeof phase.content !== "string" && typeof phase.from !== "string") throw new Error(`${phase.name} must provide content or from`);
    if (phase.permissions !== undefined) normalizePermissions(phase.permissions, `${phase.name}.permissions`);
  }
  if (spec.permissions !== undefined) normalizePermissions(spec.permissions, "spec.permissions");
  if (spec.permissionMode !== undefined) throw new Error("permissionMode is not part of the dynamic workflow spec; declare rwx capabilities with permissions instead");
  return spec;
}

function loadSpec(args) {
  if (args["spec-file"]) return JSON.parse(readFileSync(String(args["spec-file"]), "utf8"));
  if (args.spec) return JSON.parse(String(args.spec));
  throw new Error("Provide --spec-file PATH or --spec JSON, or --harness-file PATH");
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

function maybeBackground(rawArgv, opts) {
  if (process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND || process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND) return false;
  if (!isTruthyFlag(opts.background)) return false;
  const nextArgs = stripBackgroundArgs(rawArgv);
  const child = spawn(process.execPath, [process.argv[1], ...nextArgs], {
    cwd: opts.cwd ? resolve(String(opts.cwd)) : process.cwd(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PI_DYNAMIC_WORKFLOW_BACKGROUND: "1", PI_DYNAMIC_THREAD_PHASE_BACKGROUND: "1" },
  });
  child.unref();
  console.log(JSON.stringify({ ok: true, background: true, pid: child.pid }, null, 2));
  return true;
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

function parsePiJsonLines(stdout) {
  const messages = [];
  const usage = [];
  let text = "";
  let model;
  let stopReason;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "message_end" || !event.message) continue;
    messages.push(event.message);
    if (event.message.usage) usage.push(event.message.usage);
    const msg = event.message;
    if (msg.role === "assistant") {
      model = msg.model || model;
      stopReason = msg.stopReason || stopReason;
      for (const part of msg.content || []) if (part.type === "text") text = part.text;
    }
  }
  return { text, messages, usage, model, stopReason };
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
  const allowed = new Set(toolsForPermissions(permissions));
  const requested = asArray(tools).length ? asArray(tools).map(String) : [...allowed];
  const unknown = requested.filter((tool) => !PI_TOOL_REQUIREMENTS[tool]);
  if (unknown.length) throw new Error(`${label} requested unsupported Pi tools: ${unknown.join(", ")}`);
  const rejected = requested.filter((tool) => !allowed.has(tool));
  if (rejected.length) throw new Error(`${label} requested tools not allowed by permissions=${permissions || "none"}: ${rejected.join(", ")}`);
  if (!requested.length) throw new Error(`${label} has no Pi tools available; set permissions to include r, w, or x`);
  return requested;
}

async function runProcess(command, args, options) {
  return await new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ ok: false, code: null, stdout: "", stderr: "", aborted: true, error: String(options.signal.reason || "cancelled") });
      return;
    }
    const proc = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env || process.env,
      shell: Boolean(options.shell),
      detached: process.platform !== "win32",
    });
    activeChildren.add(proc);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const terminate = (signal = "SIGTERM") => {
      terminateChild(proc, signal);
      setTimeout(() => terminateChild(proc, "SIGKILL"), 5000).unref();
    };
    const onAbort = () => {
      aborted = true;
      terminate("SIGTERM");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    proc.stdout.on("data", (data) => stdout += data.toString());
    proc.stderr.on("data", (data) => stderr += data.toString());
    proc.on("error", (error) => {
      activeChildren.delete(proc);
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, code: 1, stdout, stderr, timedOut, aborted, error: error.message });
    });
    proc.on("close", (code) => {
      activeChildren.delete(proc);
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ ok: code === 0 && !aborted, code, stdout, stderr, timedOut, aborted, error: aborted ? String(options.signal?.reason || "cancelled") : code === 0 ? undefined : stderr || `${command} exited ${code}` });
    });
  });
}

async function runPi({ cwd, prompt, model, tools, timeoutMs, signal }) {
  const args = [
    "--mode", "json", "--no-session", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--tools", tools.join(","), "-p", prompt,
  ];
  if (model) args.unshift("--model", model);
  const result = await runProcess(DEFAULT_PI, args, { cwd, timeoutMs, signal });
  const parsed = parsePiJsonLines(result.stdout || "");
  return { ...result, ...parsed, ok: result.ok && Boolean(parsed.text), error: result.ok && parsed.text ? undefined : result.error || "pi produced no assistant text" };
}

function makeArtifactPath(ctx, phaseName, fileName) {
  const dir = join(ARTIFACTS_DIR, ctx.visualizerRun.runId);
  mkdirSync(dir, { recursive: true });
  return join(dir, safeName(fileName || `${phaseName}.md`));
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

async function mapWithConcurrency(items, concurrency, fn) {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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
  const result = await runProcess(command, [], { cwd: ctx.cwd, shell: true, timeoutMs: phase.timeoutMs || ctx.timeoutMs, signal: ctx.signal });
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
  const result = await runPi({ cwd: ctx.cwd, prompt, model: phase.model || ctx.model, tools, timeoutMs: phase.timeoutMs || ctx.timeoutMs, signal: ctx.signal });
  if (result.aborted) throw abortError(result.error || "cancelled");
  ctx.outputs[phase.name] = compactText(result.text || "");
  ctx.results[phase.name] = { ok: result.ok, model: result.model, stopReason: result.stopReason, code: result.code, error: result.error };
  if (result.usage?.length) phaseEvent(ctx.visualizerRun, phase.name, { kind: "usage", usage: result.usage, model: result.model });
  emitTextArtifact(ctx, phase, ctx.outputs[phase.name], { title: `Pi output: ${phase.name}`, fileName: `${phase.name}.md` });
  yield { type: "data", kind: "data", key: "model", value: result.model, message: result.ok ? "Pi agent complete" : "Pi agent failed" };
  if (!result.ok) throw new Error(result.error || "pi phase failed");
}

async function* runFanoutPiPhase(ctx, phase) {
  const items = phase.items ? asArray(phase.items).map(String) : outputToItems(ctx.outputs[phase.itemsFrom]);
  if (!items.length) throw new Error(`${phase.name} has no fanout items`);
  const permissions = permissionsForPhase(ctx, phase);
  const tools = normalizePiTools(phase.tools, permissions, phase.name);
  const concurrency = Number(phase.concurrency || ctx.spec.concurrency || DEFAULT_FANOUT_CONCURRENCY);
  yield { type: "data", kind: "data", key: "permissions", value: permissions, message: `Running fanout with ${permissions} permissions` };
  yield { type: "fanout", kind: "fanout_start", total: items.length, label: phase.label || "items" };
  let completed = 0;
  let failed = 0;
  const queue = [];
  const push = (event) => queue.push(event);
  const worker = mapWithConcurrency(items, concurrency, async (item, index) => {
    push({ type: "fanout", kind: "fanout_item_start", itemId: item, label: item, index, total: items.length, message: `Running ${item}` });
    if (ctx.signal?.aborted) throw abortError(ctx.signal.reason || "cancelled");
    const prompt = renderTemplate(phase.promptTemplate, ctx, { item, index });
    const result = await runPi({ cwd: ctx.cwd, prompt, model: phase.model || ctx.model, tools, timeoutMs: phase.timeoutMs || ctx.timeoutMs, signal: ctx.signal });
    if (result.aborted) throw abortError(result.error || "cancelled");
    const text = compactText(result.text || "");
    const fileNameTemplate = phase.artifact && typeof phase.artifact === "object" ? phase.artifact.fileNameTemplate : undefined;
    const titleTemplate = phase.artifact && typeof phase.artifact === "object" ? phase.artifact.titleTemplate : undefined;
    const artifactPhase = {
      ...phase,
      name: `${phase.name}-${safeName(item)}`,
      artifact: phase.artifact === false ? false : {
        ...(typeof phase.artifact === "object" ? phase.artifact : {}),
        title: titleTemplate ? renderTemplate(titleTemplate, ctx, { item, index }) : `${phase.name}: ${item}`,
        fileName: fileNameTemplate ? renderTemplate(fileNameTemplate, ctx, { item, index }) : `${phase.name}-${safeName(item)}.md`,
      },
    };
    emitTextArtifact(ctx, artifactPhase, text, { title: `${phase.name}: ${item}` });
    if (result.usage?.length) phaseEvent(ctx.visualizerRun, phase.name, { kind: "usage", item, index, usage: result.usage, model: result.model });
    if (result.ok) completed++; else failed++;
    push({ type: "fanout", kind: "fanout_item_end", itemId: item, label: item, index, status: result.ok ? STATUSES.SUCCESS : STATUSES.FAILED, message: result.ok ? `Complete ${item}` : `Failed ${item}`, error: result.error });
    push({ type: "progress", kind: "progress", completed, total: items.length, message: `${completed}/${items.length} complete` });
    return { item, index, ok: result.ok, text, model: result.model, stopReason: result.stopReason, error: result.error };
  });
  while (true) {
    while (queue.length) yield queue.shift();
    const done = await Promise.race([worker.then(() => true), sleep(100).then(() => false)]);
    if (done) break;
  }
  const results = await worker;
  ctx.outputs[phase.name] = results.map((result) => result.text).join("\n\n---\n\n");
  ctx.results[phase.name] = results;
  while (queue.length) yield queue.shift();
  if (failed > 0 && phase.failOnItemFailure !== false) throw new Error(`${failed}/${items.length} fanout items failed`);
}

async function* runArtifactPhase(ctx, phase) {
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
        ctx.outputs[name] = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2);
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
        const result = await runProcess(command, [], { cwd: options.cwd || ctx.cwd, shell: true, timeoutMs: options.timeoutMs || ctx.timeoutMs, signal: ctx.signal });
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
        const result = await runPi({ cwd: options.cwd || ctx.cwd, prompt, model: options.model || ctx.model, tools, timeoutMs: options.timeoutMs || ctx.timeoutMs, signal: ctx.signal });
        if (result.aborted) throw abortError(result.error || "cancelled");
        if (result.usage?.length) phaseEvent(ctx.visualizerRun, phase.name, { kind: "usage", usage: result.usage, model: result.model });
        if (!result.ok && options.reject !== false) throw new Error(result.error || "pi helper failed");
        return compactText(result.text || "");
      });
    },
    async fanout(items, options = {}) {
      const name = options.name || `fanout-${++autoPhase}`;
      return await harnessCtx.phase(name, async () => {
        const values = asArray(items);
        phaseEvent(ctx.visualizerRun, name, { kind: "fanout_start", total: values.length, label: options.label || "items" });
        let completed = 0;
        const results = await mapWithConcurrency(values, Number(options.concurrency || DEFAULT_FANOUT_CONCURRENCY), async (item, index) => {
          phaseEvent(ctx.visualizerRun, name, { kind: "fanout_item_start", itemId: String(item), label: String(item), index, total: values.length });
          const result = options.run ? await options.run(item, index, harnessCtx) : await harnessCtx.pi(String(options.promptTemplate || options.prompt || "").replace(/\{\{\s*item\s*\}\}/g, String(item)), { ...(options.pi || {}), name: `${name}-${safeName(item)}` });
          completed++;
          phaseEvent(ctx.visualizerRun, name, { kind: "fanout_item_end", itemId: String(item), label: String(item), index, status: STATUSES.SUCCESS });
          phaseEvent(ctx.visualizerRun, name, { kind: "progress", completed, total: values.length });
          return result;
        });
        return results;
      });
    },
    async artifact(title, content, options = {}) {
      const phaseName = options.name || safeName(title || "artifact");
      const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
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
  const rawArgv = process.argv.slice(2);
  const args = parseArgs(rawArgv);
  if (args.help || args.h) {
    console.log("Usage: dynamic-thread-phase-workflow.mjs --spec-file spec.json | --js-file workflow.mjs [--cwd REPO] [--background] [--model MODEL]");
    return;
  }
  if (maybeBackground(rawArgv, args)) return;

  const harnessFile = args["js-file"] || args["harness-file"] ? resolve(String(args["js-file"] || args["harness-file"])) : undefined;
  const spec = harnessFile
    ? { name: args.name ? String(args.name) : safeName(basename(harnessFile).replace(/\.[cm]?js$/, "")), mode: "harness", permissions: normalizePermissions(args.permissions || "rwx", "harness permissions"), harnessFile }
    : validateSpec(loadSpec(args));
  const cwd = resolve(String(args.cwd || spec.cwd || process.cwd()));
  const workflow = spec.name || "dynamic-workflow";
  const visualizerRun = createRun({
    workflow,
    cwd,
    trigger: { kind: process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND || process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND ? "background" : "manual", dynamic: true },
    input: spec,
    metadata: { pid: process.pid, cancellable: true, cancelSignal: "SIGTERM", dynamic: true, mode: harnessFile ? "javascript" : "spec", permissions: spec.permissions || DEFAULT_PERMISSIONS, maxPermissions: MAX_PERMISSIONS, sessionId: args["session-id"], sessionFile: args["session-file"] },
    message: `${workflow} started`,
  });
  activeRun = visualizerRun;
  const controller = new AbortController();
  activeAbortController = controller;
  const stopWatchingCancellation = watchCancellation(visualizerRun, controller);

  const artifactsDir = join(ARTIFACTS_DIR, visualizerRun.runId);
  mkdirSync(artifactsDir, { recursive: true });
  const specPath = join(artifactsDir, harnessFile ? "workflow-harness-manifest.json" : "workflow-spec.json");
  writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf8");
  artifact(visualizerRun, { kind: "json", title: harnessFile ? "Workflow harness manifest" : "Compiled workflow spec", path: specPath });
  if (harnessFile) artifact(visualizerRun, { kind: "file", title: "Workflow harness source", path: harnessFile });

  const ctx = {
    cache: new PipelineCache(),
    visualizerRun,
    spec,
    cwd,
    model: args.model ? String(args.model) : spec.model,
    timeoutMs: args.timeout ? Number(args.timeout) : spec.timeoutMs || DEFAULT_TIMEOUT_MS,
    outputs: {},
    results: {},
    signal: controller.signal,
  };

  try {
    if (harnessFile) {
      const phases = [{ name: "run-harness", async *run(runCtx) { await runHarness(runCtx, harnessFile); yield { type: "data", kind: "data", key: "mode", value: "harness", message: "Harness complete" }; } }];
      for await (const _event of runPipeline(wrapPhases(phases, visualizerRun), ctx, { signal: controller.signal })) {
        // wrapPhases mirrors phase lifecycle and yielded events to the visualizer.
      }
    } else {
      const phases = wrapPhases(spec.phases.map(dynamicPhase), visualizerRun);
      for await (const _event of runPipeline(phases, ctx, { signal: controller.signal })) {
        // wrapPhases mirrors phase lifecycle and yielded events to the visualizer.
      }
    }
    const resultPath = join(artifactsDir, "workflow-result.json");
    writeFileSync(resultPath, JSON.stringify({ outputs: ctx.outputs, results: ctx.results }, null, 2), "utf8");
    artifact(visualizerRun, { kind: "json", title: "Workflow result", path: resultPath });
    completeRun(visualizerRun, STATUSES.SUCCESS, { ok: true, phases: spec.phases?.length ?? 1, mode: harnessFile ? "harness" : "spec", resultPath });
    activeRun = undefined;
    console.log(JSON.stringify({ ok: true, runId: visualizerRun.runId, workflow, cwd, resultPath }, null, 2));
  } catch (error) {
    if (cancellationRequested || isAbortError(error) || controller.signal.aborted) {
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
    if (activeAbortController === controller) activeAbortController = undefined;
  }
}

await main();
