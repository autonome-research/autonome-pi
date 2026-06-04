#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  ARTIFACTS_DIR,
  STATUSES,
  artifact,
  completeRun,
  createRun,
  failRun,
  phaseEvent,
  readCancellation,
  wrapPhases,
} from "../../thread-phase-visualizer/lib/store.mjs";

const DEFAULT_PI = process.env.PI_MISSION_WORKFLOW_PI_BIN || (existsSync(join(homedir(), ".npm-global", "bin", "pi")) ? join(homedir(), ".npm-global", "bin", "pi") : "pi");
const DEFAULT_MAX_REPAIR_ITERATIONS = 10;
const MAX_TEXT_BYTES = 250_000;

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
    phaseEvent(run, currentHeartbeat.phase || "heartbeat", {
      kind: "heartbeat",
      pid: process.pid,
      childPids: Array.from(activeChildren).map((child) => child.pid).filter(Boolean),
      ...details,
      ...currentHeartbeat,
      timestamp: new Date().toISOString(),
    });
  }, 30_000);
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
    const proc = spawn(command, args, {
      cwd: options.cwd,
      shell: Boolean(options.shell),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env || {}) },
      detached: process.platform !== "win32",
    });
    activeChildren.add(proc);
    let stdout = "";
    let stderr = "";
    let aborted = false;
    const terminate = () => {
      aborted = true;
      terminateChild(proc, "SIGTERM");
      setTimeout(() => terminateChild(proc, "SIGKILL"), 5000).unref();
    };
    options.signal?.addEventListener("abort", terminate, { once: true });
    if (options.signal?.aborted) terminate();
    proc.stdout.on("data", (data) => stdout += data.toString());
    proc.stderr.on("data", (data) => stderr += data.toString());
    proc.on("error", (error) => {
      activeChildren.delete(proc);
      options.signal?.removeEventListener("abort", terminate);
      resolve({ ok: false, code: 1, stdout: compactText(stdout), stderr: compactText(error.message || stderr), error: error.message, aborted });
    });
    proc.on("close", (code) => {
      activeChildren.delete(proc);
      options.signal?.removeEventListener("abort", terminate);
      resolve({ ok: code === 0 && !aborted, code: code ?? 0, stdout: compactText(stdout), stderr: compactText(stderr), aborted, error: aborted ? String(options.signal?.reason || "cancelled") : undefined });
    });
  });
}

async function git(cwd, args, options = {}) {
  const result = await runProcess("git", args, { cwd, signal: options.signal });
  if (!result.ok && options.reject !== false) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} exited ${result.code}`);
  return result;
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

async function runPi({ cwd, prompt, tools, model, timeoutMs = 30 * 60 * 1000, signal }) {
  if (signal?.aborted) return { ok: false, aborted: true, error: String(signal.reason || "cancelled"), text: "" };
  const args = [
    "--mode", "json", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--tools", tools.join(","), "-p", prompt,
  ];
  if (model) args.unshift("--model", model);
  return await new Promise((resolve) => {
    const proc = spawn(DEFAULT_PI, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env, detached: process.platform !== "win32" });
    activeChildren.add(proc);
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let timedOut = false;
    const terminate = () => {
      aborted = true;
      terminateChild(proc, "SIGTERM");
      setTimeout(() => terminateChild(proc, "SIGKILL"), 5000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    signal?.addEventListener("abort", terminate, { once: true });
    proc.stdout.on("data", (data) => stdout += data.toString());
    proc.stderr.on("data", (data) => stderr += data.toString());
    proc.on("error", (error) => {
      activeChildren.delete(proc);
      clearTimeout(timer);
      signal?.removeEventListener("abort", terminate);
      resolve({ ok: false, text: "", error: error.message, stdout, stderr, aborted, timedOut });
    });
    proc.on("close", (code) => {
      activeChildren.delete(proc);
      clearTimeout(timer);
      signal?.removeEventListener("abort", terminate);
      const parsed = parsePiJsonLines(stdout);
      resolve({ ok: code === 0 && Boolean(parsed.text) && !aborted, code, stdout, stderr, aborted, timedOut, ...parsed, error: aborted ? String(signal?.reason || "cancelled") : code === 0 ? undefined : stderr || `pi exited ${code}` });
    });
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
    features: (Array.isArray(milestone.features) && milestone.features.length ? milestone.features : fallback.milestones[0].features).map((feature, fIndex) => ({
      id: safeName(feature.id || `feature-${mIndex + 1}-${fIndex + 1}`, `feature-${fIndex + 1}`),
      title: String(feature.title || feature.description || `Feature ${fIndex + 1}`),
      description: String(feature.description || feature.title || goal),
      assertions: Array.isArray(feature.assertions) && feature.assertions.length ? feature.assertions.map(String) : assertionIds,
      repair: Boolean(feature.repair),
    })),
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
      "Each milestone has id,title,features[]. Each feature has id,title,description,assertions[].",
      "Validation assertions must be written before implementation and independently define correctness.",
      `Goal: ${goal}`,
      `Default maxRepairIterations: ${args["max-repair-iterations"] || DEFAULT_MAX_REPAIR_ITERATIONS}`,
      `Validation commands: ${splitList(args["validation-command"]).join("; ") || "none provided"}`,
      `User test command: ${args["user-test-command"] || "none provided"}`,
    ].join("\n");
    const result = await runPi({ cwd: repoRoot, prompt, tools: ["read", "grep", "find", "ls"], model: args["model-plan"], signal: ctx.signal });
    if (result.usage?.length) phaseEvent(run, "create-plan", { kind: "usage", usage: result.usage, model: result.model });
    if (!result.ok) throw new Error(result.error || "planner failed");
    try { plan = parseJsonFromText(result.text); }
    catch (error) {
      writeArtifact(run, "planner-output.md", result.text, "markdown", "Planner output");
      throw error;
    }
  }
  plan = normalizePlan(plan, { goal, cwd: repoRoot, args, repoRoot });
  const planPath = writeArtifact(run, "mission-plan.json", plan, "json", "Mission plan");
  const contractPath = writeArtifact(run, "validation-contract.json", plan.validationContract, "json", "Validation contract");
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
  return { plan, planPath, contractPath, approvalPath };
}

function validatePlanForActivation(plan) {
  if (!plan || typeof plan !== "object") throw new Error("plan must be a JSON object");
  if (!plan.missionId) throw new Error("plan.missionId is required");
  if (!Array.isArray(plan.milestones) || plan.milestones.length === 0) throw new Error("plan.milestones must be non-empty");
  if (!plan.validationContract?.assertions?.length) throw new Error("plan.validationContract.assertions must be non-empty");
  return plan;
}

async function ensureMissionWorktrees(plan, ctx, run, options = {}) {
  const repoRoot = (await git(plan.cwd, ["rev-parse", "--show-toplevel"], { signal: ctx.signal })).stdout.trim();
  const baseHead = (await git(repoRoot, ["rev-parse", plan.baseRef || "HEAD"], { signal: ctx.signal })).stdout.trim();
  const missionBranch = `mission/${safeName(plan.missionId, "mission")}`;
  const root = resolve(plan.worktreeBaseDir || join(homedir(), ".pi", "agent", "mission-workflow", "worktrees", plan.missionId));
  const integrationPath = join(root, "integration");
  mkdirSync(root, { recursive: true });
  if (existsSync(integrationPath)) {
    if (!options.resume) throw new Error(`integration worktree already exists: ${integrationPath}`);
    phaseEvent(run, "prepare-mission", { kind: "data", key: "missionBranch", value: missionBranch, message: `Resuming ${missionBranch}` });
    return { repoRoot, baseHead, missionBranch, root, integrationPath, resumed: true };
  }
  await git(repoRoot, ["worktree", "add", "-B", missionBranch, integrationPath, baseHead], { signal: ctx.signal });
  phaseEvent(run, "prepare-mission", { kind: "data", key: "missionBranch", value: missionBranch, message: `Created ${missionBranch}` });
  return { repoRoot, baseHead, missionBranch, root, integrationPath, resumed: false };
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

async function runWorkerForFeature(env, milestone, feature, plan, ctx, run) {
  const featureId = safeName(feature.id || feature.title, "feature");
  const featureBranch = `mission-feature/${safeName(plan.missionId, "mission")}/${featureId}`;
  const featurePath = join(env.root, featureId);
  if (await branchMerged(env.repoRoot, featureBranch, env.missionBranch, ctx.signal)) {
    phaseEvent(run, `worker-${featureId}`, { kind: "data", key: "resume", value: true, message: `Skipped already-merged ${featureId}` });
    return { featureId, featureBranch, featurePath, skipped: true, resumed: true };
  }
  if (existsSync(featurePath)) await git(env.repoRoot, ["worktree", "remove", "--force", featurePath], { signal: ctx.signal, reject: false });
  if (existsSync(featurePath)) rmSync(featurePath, { recursive: true, force: true });
  await git(env.repoRoot, ["worktree", "add", "-B", featureBranch, featurePath, env.missionBranch], { signal: ctx.signal });
  try {
    const handoffRel = join(".mission", "handoffs", `${featureId}.json`);
    const prompt = [
      "You are a mission worker implementing exactly one feature in an isolated git worktree.",
      "Implement the requested feature. You may modify files. Do not ask for approval. Do not create commits; the runner commits after validating your handoff.",
      "Before finishing, write a structured JSON handoff file at:",
      handoffRel,
      "The handoff JSON must include: featureId, completed, changedFiles, commandsRun[{command,exitCode}], assertionsAddressed, issuesDiscovered, leftUndone, notesForValidator.",
      "Mission goal:", plan.goal,
      "Before implementing, inspect relevant repository source/spec documents, especially specs.md, SPEC.md, requirements.md, README.md, docs/*.md, and any plan sourceDocs.",
      "Plan sourceDocs:", JSON.stringify(plan.sourceDocs || [], null, 2),
      "Milestone:", `${milestone.id}: ${milestone.title}`,
      "Feature:", JSON.stringify(feature, null, 2),
      "Validation contract:", JSON.stringify(plan.validationContract, null, 2),
    ].join("\n");
    const result = String(plan.planner || "pi") === "mock"
      ? { ok: true, text: "mock worker", usage: [] }
      : await runPi({ cwd: featurePath, prompt, tools: ["read", "grep", "find", "ls", "edit", "write", "bash"], model: ctx.modelWorker, signal: ctx.signal });
    if (result.usage?.length) phaseEvent(run, `worker-${featureId}`, { kind: "usage", usage: result.usage, model: result.model });
    if (!result.ok) throw new Error(result.error || `worker failed for ${featureId}`);
    const handoffPath = join(featurePath, handoffRel);
    let handoff;
    if (existsSync(handoffPath)) {
      handoff = parseJsonFromText(readFileSync(handoffPath, "utf8"));
    } else {
      const status = await git(featurePath, ["status", "--short"], { signal: ctx.signal, reject: false });
      handoff = { featureId, completed: true, changedFiles: status.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)), commandsRun: [], assertionsAddressed: feature.assertions || [], issuesDiscovered: ["Worker did not write handoff file; runner synthesized a minimal handoff."], leftUndone: [], notesForValidator: result.text || "" };
    }
    writeArtifact(run, `handoffs/${featureId}.json`, handoff, "json", `Worker handoff: ${featureId}`);
    const status = await git(featurePath, ["status", "--short"], { signal: ctx.signal, reject: false });
    if (!status.stdout.trim()) {
      phaseEvent(run, `worker-${featureId}`, { kind: "data", key: "changes", value: 0, message: "No file changes to commit" });
      return { featureId, featureBranch, featurePath, handoff, commit: undefined };
    }
    await git(featurePath, ["add", "-A"], { signal: ctx.signal });
    await git(featurePath, ["commit", "-m", `mission(${plan.missionId}): ${feature.title || featureId}`], { signal: ctx.signal });
    const commit = (await git(featurePath, ["rev-parse", "HEAD"], { signal: ctx.signal })).stdout.trim();
    await git(env.integrationPath, ["merge", "--ff-only", featureBranch], { signal: ctx.signal });
    phaseEvent(run, `worker-${featureId}`, { kind: "data", key: "commit", value: commit, message: `Committed ${featureId}` });
    return { featureId, featureBranch, featurePath, handoff: { ...handoff, commit }, commit };
  } finally {
    await git(env.repoRoot, ["worktree", "remove", "--force", featurePath], { signal: ctx.signal, reject: false });
  }
}

async function runValidation(env, plan, milestone, ctx, run) {
  const reports = [];
  for (const command of plan.validationCommands || []) {
    const result = await runProcess(command, [], { cwd: env.integrationPath, shell: true, signal: ctx.signal });
    const file = writeArtifact(run, `validation/${safeName(milestone.id)}-${safeName(command)}.txt`, [`$ ${command}`, "", result.stdout, result.stderr].join("\n"), "file", `Validation command: ${command}`);
    reports.push({ validator: "scrutiny", command, passed: result.ok, exitCode: result.code, artifact: file });
  }
  if (plan.userTestCommand) {
    const command = plan.userTestCommand;
    const result = await runProcess(command, [], { cwd: env.integrationPath, shell: true, signal: ctx.signal });
    const file = writeArtifact(run, `validation/${safeName(milestone.id)}-user-test.txt`, [`$ ${command}`, "", result.stdout, result.stderr].join("\n"), "file", `User testing command: ${command}`);
    reports.push({ validator: "user-testing", command, passed: result.ok, exitCode: result.code, artifact: file });
  }
  if (reports.length === 0) reports.push({ validator: "scrutiny", command: "none", passed: true, note: "No validation commands configured." });
  const passed = reports.every((report) => report.passed);
  const assertionResults = (plan.validationContract?.assertions || []).map((assertion) => ({ assertionId: assertion.id, status: passed ? "pass" : "unknown", evidence: passed ? "Configured validation passed." : "One or more validation commands failed." }));
  const report = { milestoneId: milestone.id, passed, reports, assertionResults, correctiveFeatures: passed ? [] : [{ title: `Repair validation failures for ${milestone.title}`, assertions: assertionResults.map((r) => r.assertionId), rationale: "Validation command failed." }] };
  writeArtifact(run, `validation/${safeName(milestone.id)}-report.json`, report, "json", `Validation report: ${milestone.id}`);
  return report;
}

function repairFeatureFromReport(report, iteration) {
  return {
    id: `repair-${safeName(report.milestoneId)}-${iteration}`,
    title: report.correctiveFeatures?.[0]?.title || `Repair ${report.milestoneId}`,
    description: `Repair validation failures from report: ${JSON.stringify(report.reports || [], null, 2)}`,
    assertions: report.assertionResults?.map((result) => result.assertionId).filter(Boolean) || [],
    repair: true,
  };
}

async function activateMission(args, cwd, run, ctx) {
  if (!isTruthyFlag(args.approved)) throw new Error("Activation requires --approved after the user reviews the mission plan.");
  if (!args["plan-path"]) throw new Error("--plan-path is required for activation");
  const plan = validatePlanForActivation(JSON.parse(readFileSync(resolve(cwd, String(args["plan-path"])), "utf8")));
  ctx.modelWorker = args["model-worker"] || plan.modelWorker || ctx.modelWorker;
  ctx.modelValidator = args["model-validator"] || plan.modelValidator || ctx.modelValidator;
  const env = await ensureMissionWorktrees(plan, ctx, run, { resume: isTruthyFlag(args.resume) });
  const missionState = { missionId: plan.missionId, missionBranch: env.missionBranch, integrationPath: env.integrationPath, baseHead: env.baseHead, modelWorker: ctx.modelWorker, modelValidator: ctx.modelValidator, resumed: env.resumed, milestones: [], startedAt: new Date().toISOString() };
  for (const milestone of plan.milestones) {
    currentHeartbeat = { phase: "execute-mission", missionId: plan.missionId, milestoneId: milestone.id, milestoneTitle: milestone.title, branch: env.missionBranch, worktree: env.integrationPath };
    let iteration = 0;
    let queue = [...(milestone.features || [])];
    const milestoneState = { id: milestone.id, title: milestone.title, iterations: [] };
    while (iteration < Number(plan.maxRepairIterations || DEFAULT_MAX_REPAIR_ITERATIONS)) {
      if (ctx.signal.aborted) throw abortError(ctx.signal.reason || "cancelled");
      iteration++;
      const iterationState = { iteration, features: [], validation: undefined };
      for (const feature of queue) {
        const featureId = safeName(feature.id || feature.title, "feature");
        currentHeartbeat = { phase: "execute-mission", missionId: plan.missionId, milestoneId: milestone.id, iteration, featureId, branch: env.missionBranch, worktree: env.integrationPath };
        phaseEvent(run, "execute-mission", { kind: "heartbeat", ...currentHeartbeat, pid: process.pid, childPids: Array.from(activeChildren).map((child) => child.pid).filter(Boolean), message: `Worker ${featureId}` });
        phaseEvent(run, "execute-mission", { kind: "progress", current: iterationState.features.length, total: queue.length, message: `Worker ${featureId}` });
        const result = await runWorkerForFeature(env, milestone, feature, plan, ctx, run);
        iterationState.features.push(result);
      }
      queue = [];
      currentHeartbeat = { phase: "execute-mission", missionId: plan.missionId, milestoneId: milestone.id, iteration, validator: "commands", branch: env.missionBranch, worktree: env.integrationPath };
      const validation = await runValidation(env, plan, milestone, ctx, run);
      iterationState.validation = validation;
      milestoneState.iterations.push(iterationState);
      writeArtifact(run, `state/${safeName(milestone.id)}-iteration-${iteration}.json`, iterationState, "json", `Mission state: ${milestone.id} iteration ${iteration}`);
      if (validation.passed) break;
      if (iteration >= Number(plan.maxRepairIterations || DEFAULT_MAX_REPAIR_ITERATIONS)) throw new Error(`Mission ${plan.missionId} reached max repair iterations (${iteration}) for ${milestone.id}`);
      queue = [repairFeatureFromReport(validation, iteration)];
    }
    missionState.milestones.push(milestoneState);
  }
  missionState.completedAt = new Date().toISOString();
  const statePath = writeArtifact(run, "mission-state.json", missionState, "json", "Mission state");
  const final = [
    "# Mission complete",
    "",
    `Mission: ${plan.missionId}`,
    `Branch: ${env.missionBranch}`,
    `Integration worktree: ${env.integrationPath}`,
    `Base HEAD: ${env.baseHead}`,
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
  return { plan, env, missionState, statePath, finalPath };
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
  const ctx = { cache: new PipelineCache(), signal: controller.signal, modelWorker: args["model-worker"], modelValidator: args["model-validator"] };

  try {
    let result;
    if (action === "plan") {
      const phases = [{ name: "create-plan", async *run(phaseCtx) { result = await createPlan(args, cwd, run, phaseCtx); yield { type: "data", kind: "data", key: "planPath", value: result.planPath, message: "Mission plan created" }; } }];
      for await (const _event of runPipeline(wrapPhases(phases, run), ctx, { signal: controller.signal })) {}
      completeRun(run, STATUSES.SUCCESS, { ok: true, planPath: result.planPath, contractPath: result.contractPath });
      finalizedRun = true;
      console.log(JSON.stringify({ ok: true, action, runId: run.runId, cwd, ...result }, null, 2));
    } else if (action === "activate" || action === "resume") {
      const phases = [
        { name: "prepare-mission", async *run() { yield { type: "data", kind: "data", key: "planPath", value: args["plan-path"], message: "Loading approved mission plan" }; } },
        { name: "execute-mission", async *run(phaseCtx) { result = await activateMission(args, cwd, run, phaseCtx); yield { type: "data", kind: "data", key: "branch", value: result.env.missionBranch, message: "Mission execution complete" }; } },
        { name: "final-report", async *run() { yield { type: "data", kind: "data", key: "report", value: result.finalPath, message: "Final report written" }; } },
      ];
      for await (const _event of runPipeline(wrapPhases(phases, run), ctx, { signal: controller.signal })) {}
      completeRun(run, STATUSES.SUCCESS, { ok: true, missionId: result.plan.missionId, branch: result.env.missionBranch, finalPath: result.finalPath });
      finalizedRun = true;
      console.log(JSON.stringify({ ok: true, action, runId: run.runId, cwd, missionId: result.plan.missionId, branch: result.env.missionBranch, finalPath: result.finalPath }, null, 2));
    } else {
      throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    if (cancellationRequested || isAbortError(error) || controller.signal.aborted) {
      if (activeRun === run) completeRun(run, STATUSES.CANCELLED, { cancelled: true, reason: controller.signal.reason || error?.message });
      finalizedRun = true;
      console.log(JSON.stringify({ ok: false, cancelled: true, action, runId: run.runId, cwd }, null, 2));
      process.exitCode = 130;
    } else {
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
