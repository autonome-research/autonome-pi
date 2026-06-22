#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative as importPathRelative, resolve } from "node:path";
import {
  STATUSES,
  artifact as emitArtifact,
  completeRun,
  createRun,
  failRun,
  phaseEnd,
  phaseEvent,
  phaseStart,
} from "../../thread-phase-visualizer/lib/store.mjs";
import { assessPreImplementationGate, normalizeSolvePlanArtifact } from "../lib/m0-compat.mjs";

const WORKFLOW = "bug-solver-workflow";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const DEFAULT_ARTIFACT_ROOT = join(AGENT_DIR, "bug-solver-workflow");
let ARTIFACT_ROOT = resolveArtifactRoot();

function parseArgs(argv) {
  const out = { _: [] };
  const setArg = (key, value) => {
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
      if (eq !== -1) setArg(key, arg.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) setArg(key, argv[++i]);
      else setArg(key, true);
    } else out._.push(arg);
  }
  return out;
}

function usage() {
  return `Usage:\n  bug-solver-workflow precheck --bug <single bug> [--cwd <repo>] [--validation-command <cmd>] [--user-test-command <cmd>] [--max-repairs <n>] [--allowlist <path>] [--json]\n  bug-solver-workflow solve --plan-path <transaction-plan.json|precheck.json> --approved [--cwd <repo>] [--json]\n  bug-solver-workflow status [--transaction-id <id>|--transaction-dir <dir>] [--json]\n\nThe solve action is intentionally approval-gated. Runtime artifacts are written outside the target repo under ${ARTIFACT_ROOT}.`;
}

function die(message, code = 1, json = false) {
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(message);
  process.exit(code);
}

function safeId(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "bug";
}

function hashText(text, len = 10) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, len);
}

function splitValues(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => String(item).split(/[;,]/)).map((s) => s.trim()).filter(Boolean);
}

function expandHomePath(input) {
  const value = String(input || "");
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function resolveArtifactRoot() {
  return resolve(expandHomePath(process.env.PI_BUG_SOLVER_ARTIFACT_DIR || DEFAULT_ARTIFACT_ROOT));
}

function sameOrInsidePath(candidate, parent) {
  const child = resolve(candidate);
  const base = resolve(parent);
  const relative = pathRelative(base, child);
  return relative === "" || (!relative.startsWith("..") && !isAbsolute(relative));
}

function physicalPathForContainment(input) {
  const absolute = resolve(input);
  let current = absolute;
  const missingTail = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    missingTail.unshift(basename(current));
    current = parent;
  }
  try {
    return resolve(realpathSync(current), ...missingTail);
  } catch (error) {
    throw new Error(`Unable to verify physical realpath for artifact-root safety: ${current}: ${error.message}`);
  }
}

function pathRelative(from, to) {
  // Keep path.relative out of the import list churn above and normalize Windows separators for tests.
  return importPathRelative(from, to).replace(/\\/g, "/");
}

function splitValidationCommands(args) {
  return splitValues(args["validation-command"] || args.validationCommands);
}

function parseMaxRepairs(value) {
  if (value === undefined || value === true || value === "") return 8;
  const parsed = Number.parseInt(String(Array.isArray(value) ? value.at(-1) : value), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 50) throw new Error("--max-repairs must be an integer from 0 to 50");
  return parsed;
}

const BUG_ACTION_PATTERN = /\b(fix|repair|resolve|correct|prevent|stop|address|debug|handle|ensure|make)\b/i;
const BUG_FAILURE_PATTERN = /\b(bug|defect|error|fail(?:s|ed|ing|ure)?|crash(?:es|ed|ing)?|exception|regression|timeout|incorrect|wrong|broken|hang(?:s|ing)?|leak(?:s|ing)?|corrupt(?:s|ed|ing)?|500|404)\b/i;

function normalizeBugClause(value) {
  return String(value || "").trim().replace(/^[-*]\s+/, "").replace(/^(?:\d+\.|\([a-z0-9]+\))\s+/i, "");
}

function isIndependentBugClause(value) {
  const clause = normalizeBugClause(value);
  if (clause.length < 4) return false;
  return BUG_ACTION_PATTERN.test(clause) || BUG_FAILURE_PATTERN.test(clause);
}

function isCommaSeparatedIndependentBugClause(value) {
  const clause = normalizeBugClause(value);
  if (clause.length < 4) return false;
  // Commas are common inside one bug description ("Fix crash when loading, saving, and closing").
  // Treat a comma segment as an independent transaction only when it looks like a standalone
  // bug/action clause: it starts with another repair verb or contains an explicit bug/failure noun.
  return BUG_ACTION_PATTERN.test(clause) || /\b(bug|defect|regression|crash(?:es|ed|ing)?|exception|timeout|error|failure|broken)\b/i.test(clause);
}

function countIndependentClauses(parts, predicate = isIndependentBugClause) {
  return parts.map((part) => part.trim()).filter(predicate).length;
}

function numberedClauses(text) {
  const matches = [...String(text || "").matchAll(/(?:^|\s)(?:\d+\.|\([a-z0-9]+\))\s+/gi)];
  return matches.map((match, index) => {
    const start = (match.index || 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return text.slice(start, end);
  });
}

function classifyBugCount(bug) {
  const text = String(bug || "");
  const signals = {
    conjunctions: [],
    semicolonClauses: 0,
    commaClauses: 0,
    bulletClauses: 0,
    numberedClauses: 0,
  };

  for (const match of text.matchAll(/\b(?:and(?:\s+also)?|also|plus)\b/gi)) {
    const before = text.slice(0, match.index);
    const after = text.slice((match.index || 0) + match[0].length);
    const left = before.split(/[;\n]/).at(-1) || before;
    const right = after.split(/[;\n]/)[0] || after;
    if (isIndependentBugClause(left) && isIndependentBugClause(right)) {
      signals.conjunctions.push({ token: match[0].toLowerCase(), left: left.trim().slice(0, 120), right: right.trim().slice(0, 120) });
    }
  }

  signals.semicolonClauses = countIndependentClauses(text.split(/;+/));
  signals.commaClauses = countIndependentClauses(text.split(/,+/), isCommaSeparatedIndependentBugClause);
  signals.bulletClauses = countIndependentClauses(text.split(/\n/).filter((line) => /^\s*[-*]\s+/.test(line)));
  signals.numberedClauses = countIndependentClauses(numberedClauses(text));

  const likelyMultiple = signals.conjunctions.length > 0 || signals.semicolonClauses >= 2 || signals.commaClauses >= 2 || signals.bulletClauses >= 2 || signals.numberedClauses >= 2;
  const splitRecommendation = likelyMultiple
    ? "Reject this activation and create one transaction per independent bug before any edit-capable phase."
    : undefined;
  return { likelyMultiple, signals, splitRecommendation };
}

function buildArtifactPaths(dir) {
  return {
    root: dir,
    precheck: join(dir, "precheck.json"),
    transactionPlan: join(dir, "transaction-plan.json"),
    validationContract: join(dir, "validation-contract.json"),
    artifactRegistry: join(dir, "artifact-registry.json"),
    baseline: join(dir, "evidence", "baseline-validation.json"),
    allowlistDecisions: join(dir, "allowlist-decisions.jsonl"),
    implementationEvidence: join(dir, "evidence", "implementation-evidence.jsonl"),
    repairAttempts: join(dir, "repair-attempts.jsonl"),
    failureClassifications: join(dir, "failure-classifications.jsonl"),
    finalReport: join(dir, "evidence", "final-report.json"),
    intermediateReportsDir: join(dir, "reports"),
    precheckReport: join(dir, "reports", "precheck-report.json"),
    state: join(dir, "state.json"),
    precheckIncomplete: join(dir, ".precheck-incomplete.json"),
    precheckLock: join(dir, ".precheck.lock"),
  };
}

function buildValidationContract({ transactionId, bug, cwd, validationCommands, userTestCommand, artifactPaths }) {
  const assertions = [
    {
      id: "single-bug-scope",
      description: "The transaction addresses exactly one bug and rejects or splits multi-bug requests before any edit-capable phase.",
      priority: "must",
      evidenceRequired: ["precheck.multiplicity", "transactionPlan.transaction.exactlyOneBug"],
      evidencePaths: [artifactPaths.precheck, artifactPaths.transactionPlan],
    },
    {
      id: "bug-reproduction-before-broad-validation",
      description: "Targeted bug reproduction or user-provided test evidence is identified and run before broad validation commands.",
      priority: "must",
      evidenceRequired: ["validation.userTestCommand", "validation.commands", "evidence.baseline", "evidence.implementation"],
      evidencePaths: [artifactPaths.baseline, artifactPaths.implementationEvidence],
    },
    {
      id: "durable-transaction-state",
      description: "Workflow state and evidence artifacts are external to the target repository and recoverable by transaction id.",
      priority: "must",
      evidenceRequired: ["state.lifecycle", "state.repo.baseCommit", "state.worktree", "artifactRegistry.entries"],
      evidencePaths: [artifactPaths.state, artifactPaths.artifactRegistry],
    },
    {
      id: "baseline-aware-validation",
      description: "Baseline command results are recorded before implementation and later compared so pre-existing failures are not reported as new regressions.",
      priority: "must",
      evidenceRequired: ["baseline.status", "baseline.commandResults"],
      evidencePaths: [artifactPaths.baseline, artifactPaths.finalReport],
    },
    {
      id: "allowlisted-scope-control",
      description: "Implementation edits are restricted to the current allowlist unless an expansion is justified and durably recorded first.",
      priority: "must",
      evidenceRequired: ["allowlist.current", "allowlist.decisions"],
      evidencePaths: [artifactPaths.allowlistDecisions, artifactPaths.finalReport],
    },
  ];
  return {
    schema: "pi-bug-solver-workflow/validation-contract/v1",
    transactionId,
    createdAt: new Date().toISOString(),
    createdBeforeImplementation: true,
    repoPath: cwd,
    bugDescription: bug,
    validationCommands,
    userTestCommand: userTestCommand || null,
    assertions,
    workflowEvidenceMap: Object.fromEntries(assertions.map((assertion) => [assertion.id, assertion.evidencePaths])),
  };
}

function buildTransactionPlan({ transactionId, cwd, bug, git, validationCommands, userTestCommand, maxRepairIterations, allowlist, multiplicity, artifactPaths, contractPath }) {
  return {
    schema: "pi-bug-solver-workflow/transaction-plan/v1",
    transactionId,
    createdAt: new Date().toISOString(),
    status: multiplicity.likelyMultiple ? "rejected_multi_bug" : "awaiting_confirmation",
    editingAllowed: false,
    confirmationRequired: true,
    transaction: {
      exactlyOneBug: !multiplicity.likelyMultiple,
      bugDescription: bug,
      multiplicity,
      splitRequired: Boolean(multiplicity.likelyMultiple),
    },
    repo: {
      cwd,
      root: git.root || cwd,
      baseCommit: git.head || null,
      baseRef: git.branch || "HEAD",
      statusAtPrecheck: git.statusShort || "",
      isGitRepo: git.isGitRepo,
    },
    validation: {
      commands: validationCommands,
      userTestCommand: userTestCommand || null,
      executionOrder: ["targeted_bug_reproduction", "broad_validation_commands"],
      baseline: { required: true, status: "pending", evidencePath: artifactPaths.baseline },
      contractPath,
    },
    repairPolicy: { maxRepairIterations, defaultMaxRepairIterations: 8, failureClassificationRequired: true },
    allowlist: {
      current: allowlist,
      expansionPolicy: "Edits outside current allowlist are blocked until a justification is appended to allowlist-decisions.jsonl.",
      decisionsPath: artifactPaths.allowlistDecisions,
    },
    artifacts: artifactPaths,
    artifactRegistryPath: artifactPaths.artifactRegistry,
    statePath: artifactPaths.state,
    evidencePaths: {
      precheck: artifactPaths.precheck,
      validationContract: artifactPaths.validationContract,
      state: artifactPaths.state,
      artifactRegistry: artifactPaths.artifactRegistry,
      baseline: artifactPaths.baseline,
      allowlistDecisions: artifactPaths.allowlistDecisions,
      implementation: artifactPaths.implementationEvidence,
      repairAttempts: artifactPaths.repairAttempts,
      failureClassifications: artifactPaths.failureClassifications,
      finalReport: artifactPaths.finalReport,
    },
  };
}

function writeInitialJsonl(file, record) {
  mkdirSync(resolve(file, ".."), { recursive: true });
  if (existsSync(file)) return;
  writeFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => stdout += d.toString());
    child.stderr.on("data", (d) => stderr += d.toString());
    child.on("error", (error) => resolve({ status: 1, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ status: code ?? 0, stdout, stderr }));
  });
}

async function gitInfo(cwd) {
  const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const head = await runGit(cwd, ["rev-parse", "HEAD"]);
  const branch = await runGit(cwd, ["branch", "--show-current"]);
  const status = await runGit(cwd, ["status", "--short"]);
  return {
    isGitRepo: root.status === 0,
    root: root.status === 0 ? root.stdout.trim() : undefined,
    head: head.status === 0 ? head.stdout.trim() : undefined,
    branch: branch.status === 0 ? branch.stdout.trim() : undefined,
    statusShort: status.status === 0 ? status.stdout.trimEnd() : undefined,
    errors: [root, head, status].filter((r) => r.status !== 0).map((r) => (r.stderr || r.stdout || "git failed").trim()),
  };
}

function validateArtifactRootExternal({ cwd, git }) {
  const artifactRoot = resolveArtifactRoot();
  const targetRoot = resolve(git?.root || cwd);
  const targetCwd = resolve(cwd);
  const physicalArtifactRoot = physicalPathForContainment(artifactRoot);
  const physicalTargetRoot = physicalPathForContainment(targetRoot);
  const physicalTargetCwd = physicalPathForContainment(targetCwd);
  const inTargetRoot = sameOrInsidePath(artifactRoot, targetRoot) || sameOrInsidePath(physicalArtifactRoot, physicalTargetRoot);
  const inTargetCwd = sameOrInsidePath(artifactRoot, targetCwd) || sameOrInsidePath(physicalArtifactRoot, physicalTargetCwd);
  if (inTargetRoot || inTargetCwd) {
    throw new Error(`Refusing PI_BUG_SOLVER_ARTIFACT_DIR inside the target repository/cwd. artifactRoot=${artifactRoot}; physicalArtifactRoot=${physicalArtifactRoot}; targetRoot=${targetRoot}; physicalTargetRoot=${physicalTargetRoot}; cwd=${targetCwd}; physicalCwd=${physicalTargetCwd}. Choose an external durable directory outside the repository.`);
  }
  ARTIFACT_ROOT = artifactRoot;
  return { artifactRoot, physicalArtifactRoot, targetRoot, physicalTargetRoot, targetCwd, physicalTargetCwd, externalToTargetRepo: true };
}

function atomicWriteJson(file, value) {
  mkdirSync(resolve(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  rmSync(tmp, { force: true });
}

function writeJson(file, value) {
  atomicWriteJson(file, value);
}

function writeInitialJson(file, value) {
  if (existsSync(file)) return;
  atomicWriteJson(file, value);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function inspectPrecheckLock(lock) {
  if (!lock || !existsSync(lock)) return { exists: false, recoverable: false, status: "absent" };
  let stat;
  let raw = "";
  try { stat = statSync(lock); } catch (error) { return { exists: false, recoverable: true, status: "stat_failed", reason: error.message || String(error) }; }
  try { raw = readFileSync(lock, "utf8"); } catch (error) { return { exists: true, recoverable: false, status: "unreadable", reason: error.message || String(error), size: stat.size, mtime: stat.mtime.toISOString() }; }
  const base = { exists: true, size: stat.size, mtime: stat.mtime.toISOString(), ageMs: Math.max(0, Date.now() - stat.mtimeMs) };
  if (!raw.trim()) return { ...base, recoverable: true, status: "empty_stale", reason: "Lock file is empty; this can only be left by an interrupted non-atomic legacy lock writer." };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) { return { ...base, recoverable: true, status: "malformed_stale", reason: error.message || String(error) }; }
  if (parsed?.schema !== "pi-bug-solver-workflow/precheck-lock/v1" || !Number.isInteger(parsed?.pid)) {
    return { ...base, recoverable: true, status: "malformed_stale", lock: parsed, reason: "Lock JSON is missing the expected schema or integer pid." };
  }
  const alive = isProcessAlive(parsed.pid);
  return { ...base, recoverable: !alive, status: alive ? "active" : "stale_dead_pid", lock: parsed, pidAlive: alive };
}

function writePrecheckLockAtomic(lock, body) {
  mkdirSync(resolve(lock, ".."), { recursive: true });
  const tmp = `${lock}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`, "utf8");
  try {
    linkSync(tmp, lock);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function acquirePrecheckLock(lock, body) {
  try {
    writePrecheckLockAtomic(lock, body);
    return undefined;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const inspection = inspectPrecheckLock(lock);
    if (!inspection.recoverable) throw new Error(`precheck materialization is already in progress for ${body.transactionId}; lock=${lock}; status=${inspection.status}`);
    rmSync(lock, { force: true });
    writePrecheckLockAtomic(lock, { ...body, recoveredStaleLock: inspection });
    return inspection;
  }
}

function withPrecheckLock(paths, transactionId, fn) {
  mkdirSync(paths.root, { recursive: true });
  const lock = paths.precheckLock;
  const now = new Date().toISOString();
  const recoveredLock = acquirePrecheckLock(lock, { schema: "pi-bug-solver-workflow/precheck-lock/v1", transactionId, pid: process.pid, createdAt: now });
  return Promise.resolve().then(() => fn(recoveredLock)).finally(() => rmSync(lock, { force: true }));
}

function transactionDir(transactionId) {
  return join(ARTIFACT_ROOT, "transactions", safeId(transactionId));
}

function registryIndexPath() {
  return join(ARTIFACT_ROOT, "registry", "transactions.json");
}

function transactionBranchName(transactionId) {
  return `bug-solver/${safeId(transactionId).slice(0, 60)}`;
}

function transactionWorktreePath(transactionId) {
  return join(ARTIFACT_ROOT, "worktrees", safeId(transactionId));
}

function artifactRegistry({ transactionId, artifactPaths }) {
  const existing = existsSync(artifactPaths.artifactRegistry) ? readJson(artifactPaths.artifactRegistry) : {};
  const entries = [
    ["precheck", artifactPaths.precheck, "read-only precheck result and approval instructions"],
    ["transactionPlan", artifactPaths.transactionPlan, "approval-gated transaction plan"],
    ["validationContract", artifactPaths.validationContract, "pre-implementation validation assertions and evidence map"],
    ["state", artifactPaths.state, "durable transaction lifecycle state"],
    ["artifactRegistry", artifactPaths.artifactRegistry, "recoverable list of transaction artifacts"],
    ["baselineValidation", artifactPaths.baseline, "baseline validation command evidence"],
    ["allowlistDecisions", artifactPaths.allowlistDecisions, "initial allowlist and justified expansions"],
    ["implementationEvidence", artifactPaths.implementationEvidence, "implementation and validation evidence log"],
    ["repairAttempts", artifactPaths.repairAttempts, "bounded repair attempt log"],
    ["failureClassifications", artifactPaths.failureClassifications, "classified failures and evidence"],
    ["precheckReport", artifactPaths.precheckReport, "intermediate report summarizing precheck decisions, commands, failures, repairs, commits, and evidence paths"],
    ["finalReport", artifactPaths.finalReport, "outcome-based final report"],
  ].map(([kind, path, description]) => ({
    kind,
    path,
    description,
    externalToTargetRepo: true,
    lifecycleStatus: "materialized_at_precheck",
    durableAtPrecheck: true,
  }));
  return {
    schema: "pi-bug-solver-workflow/artifact-registry/v1",
    transactionId,
    artifactRoot: ARTIFACT_ROOT,
    transactionDir: artifactPaths.root,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    recoverableByTransactionId: true,
    materializationComplete: true,
    entries,
  };
}

function expectedRegistryEntries({ artifactPaths }) {
  return artifactRegistry({ transactionId: "pending", artifactPaths }).entries;
}

function verifyRegisteredArtifactsExist(registry, { includeRegistry = true } = {}) {
  const missing = (registry.entries || []).filter((entry) => (includeRegistry || entry.kind !== "artifactRegistry") && !existsSync(entry.path));
  if (missing.length) throw new Error(`precheck artifact materialization incomplete; missing registered file(s): ${missing.map((entry) => `${entry.kind}:${entry.path}`).join(", ")}`);
  return true;
}

function writePrecheckIncompleteMarker({ artifactPaths, transactionId, state, stage, error }) {
  const marker = {
    schema: "pi-bug-solver-workflow/precheck-materialization/v1",
    transactionId,
    status: "incomplete",
    stage,
    updatedAt: new Date().toISOString(),
    transactionDir: artifactPaths.root,
    immutableIdentity: state ? { repo: state.repo, branch: state.branch, worktree: state.worktree, transaction: state.transaction, createdAt: state.createdAt } : undefined,
    artifactRegistryPath: artifactPaths.artifactRegistry,
    expectedArtifacts: expectedRegistryEntries({ artifactPaths }).map((entry) => ({ kind: entry.kind, path: entry.path, exists: existsSync(entry.path) })),
    error: error ? (error.message || String(error)) : undefined,
  };
  writeJson(artifactPaths.precheckIncomplete, marker);
  return marker;
}

function clearPrecheckIncompleteMarker(artifactPaths) {
  rmSync(artifactPaths.precheckIncomplete, { force: true });
}

function initialPendingArtifacts({ transactionId, cwd, bug, validationCommands, userTestCommand, maxRepairIterations, allowlist, multiplicity, artifactPaths, createdAt }) {
  const commonSummary = {
    transactionId,
    bugDescription: bug,
    repoPath: cwd,
    status: multiplicity.likelyMultiple ? "rejected_multi_bug" : "awaiting_confirmation",
    createdAt,
    phase: "precheck",
    commands: {
      targeted: userTestCommand ? [userTestCommand] : [],
      broadValidation: validationCommands,
      executionOrder: ["targeted_bug_reproduction", "broad_validation_commands"],
      executed: [],
      pendingReason: "Commands are not executed during read-only precheck; baseline validation is pending solve activation.",
    },
    failures: { classifications: [], status: "none_recorded" },
    repairs: { attempts: 0, maxRepairIterations, records: [] },
    commits: { transactionBranch: null, commits: [], status: "not_created" },
    evidencePaths: {
      baseline: artifactPaths.baseline,
      implementation: artifactPaths.implementationEvidence,
      allowlistDecisions: artifactPaths.allowlistDecisions,
      repairAttempts: artifactPaths.repairAttempts,
      failureClassifications: artifactPaths.failureClassifications,
      precheckReport: artifactPaths.precheckReport,
      finalReport: artifactPaths.finalReport,
      artifactRegistry: artifactPaths.artifactRegistry,
      state: artifactPaths.state,
    },
  };
  return {
    baseline: {
      schema: "pi-bug-solver-workflow/baseline-validation/v1",
      transactionId,
      createdAt,
      status: "pending",
      reason: "Baseline validation is recorded as required at precheck and must be executed before implementation in solve.",
      commands: commonSummary.commands,
      evidencePaths: commonSummary.evidencePaths,
    },
    implementationEvidence: { type: "implementation_evidence_initialized", createdAt, transactionId, status: "pending", decisions: [], commands: [], evidencePaths: commonSummary.evidencePaths },
    precheckReport: {
      schema: "pi-bug-solver-workflow/intermediate-report/v1",
      reportKind: "precheck",
      summary: commonSummary,
      decisions: [
        { decision: "read_only_precheck_complete", justification: "Precheck materialized durable transaction state and evidence placeholders outside the target repository." },
        { decision: multiplicity.likelyMultiple ? "reject_multi_bug" : "await_confirmation", justification: multiplicity.likelyMultiple ? "Multiplicity signals require split transactions." : "Exactly-one-bug activation requires explicit approval before edits." },
      ],
      evidencePaths: commonSummary.evidencePaths,
    },
    finalReport: {
      schema: "pi-bug-solver-workflow/final-report/v1",
      transactionId,
      createdAt,
      status: "pending",
      terminal: false,
      outcome: null,
      summary: commonSummary,
      decisions: [],
      commands: commonSummary.commands,
      failures: commonSummary.failures,
      repairs: commonSummary.repairs,
      commits: commonSummary.commits,
      evidencePaths: commonSummary.evidencePaths,
    },
  };
}

function assertExistingTransactionCompatible({ transactionId, cwd, bug, git, artifactPaths }) {
  const marker = existsSync(artifactPaths.precheckIncomplete) ? tryReadJson(artifactPaths.precheckIncomplete) : undefined;
  const existing = existsSync(artifactPaths.state) ? readJson(artifactPaths.state) : (marker ? { ...(marker.immutableIdentity || {}), transactionId: marker.transactionId, repo: marker.immutableIdentity?.repo, transaction: marker.immutableIdentity?.transaction } : undefined);
  if (!existing) return;
  const existingBug = existing.transaction?.bugDescription;
  const existingCwd = existing.repo?.cwd;
  const existingRoot = existing.repo?.root;
  const currentRoot = git?.root || cwd;
  const existingWorktreePath = existing.worktree?.path;
  const expectedWorktreePath = transactionWorktreePath(transactionId);
  const existingBranchName = existing.branch?.plannedName;
  const expectedBranchName = transactionBranchName(transactionId);
  const incompatible = [];
  if (existing.transactionId && existing.transactionId !== transactionId) incompatible.push("state transactionId differs from requested transaction id");
  if (existingBug && existingBug !== bug) incompatible.push("bug description differs from existing transaction");
  if (existingCwd && existingCwd !== cwd) incompatible.push("repository cwd differs from existing transaction");
  if (existingRoot && currentRoot && existingRoot !== currentRoot) incompatible.push("repository root differs from existing transaction");
  if (existingWorktreePath && existingWorktreePath !== expectedWorktreePath) incompatible.push("isolated worktree path differs from transaction identity");
  if (existingBranchName && existingBranchName !== expectedBranchName) incompatible.push("planned branch name differs from transaction identity");
  if (incompatible.length) {
    throw new Error(`transaction id ${transactionId} already exists for an incompatible transaction (${incompatible.join("; ")}); choose a new --transaction-id`);
  }
}

function buildTransactionState({ transactionId, cwd, bug, git, validationCommands, userTestCommand, maxRepairIterations, allowlist, multiplicity, artifactPaths, status }) {
  const now = new Date().toISOString();
  const incomplete = !existsSync(artifactPaths.state) && existsSync(artifactPaths.precheckIncomplete) ? (tryReadJson(artifactPaths.precheckIncomplete)?.immutableIdentity || {}) : {};
  const existing = existsSync(artifactPaths.state) ? readJson(artifactPaths.state) : { createdAt: incomplete.createdAt, repo: incomplete.repo, branch: incomplete.branch, worktree: incomplete.worktree };
  const createdAt = existing.createdAt || now;
  const revision = Number.isInteger(existing.revision) ? existing.revision + 1 : 1;
  const lifecycleStatus = status || (multiplicity.likelyMultiple ? "rejected_multi_bug" : "awaiting_confirmation");
  const observation = {
    observedAt: now,
    cwd,
    repo: {
      root: git.root || cwd,
      isGitRepo: git.isGitRepo,
      head: git.head || null,
      branch: git.branch || "HEAD",
      statusShort: git.statusShort || "",
    },
    validationCommands,
    userTestCommand: userTestCommand || null,
    maxRepairIterations,
    allowlist,
    multiplicity,
    status: lifecycleStatus,
  };
  const previousObservations = Array.isArray(existing.observations?.prechecks) ? existing.observations.prechecks : [];
  const repoIdentity = existing.repo || {
    cwd,
    root: git.root || cwd,
    isGitRepo: git.isGitRepo,
    baseCommit: git.head || null,
    baseRef: git.branch || "HEAD",
    statusAtPrecheck: git.statusShort || "",
  };
  const branchIdentity = existing.branch || {
    baseCommit: repoIdentity.baseCommit,
    plannedName: transactionBranchName(transactionId),
    currentName: null,
    status: "not_created",
  };
  const worktreeIdentity = existing.worktree || {
    path: transactionWorktreePath(transactionId),
    status: "not_created",
    isolated: true,
    rootedAtBaseCommit: repoIdentity.baseCommit,
  };
  return {
    schema: "pi-bug-solver-workflow/state/v1",
    transactionId,
    createdAt,
    updatedAt: now,
    revision,
    lifecycle: {
      status: lifecycleStatus,
      phase: "precheck",
      terminal: lifecycleStatus === "rejected_multi_bug",
      editingAllowed: false,
      confirmationRequired: true,
      readOnlyPrecheckComplete: true,
      materializationComplete: false,
    },
    transaction: {
      exactlyOneBug: !multiplicity.likelyMultiple,
      bugDescription: bug,
      multiplicity,
    },
    repo: repoIdentity,
    branch: branchIdentity,
    worktree: worktreeIdentity,
    validation: {
      commands: validationCommands,
      userTestCommand: userTestCommand || null,
      executionOrder: ["targeted_bug_reproduction", "broad_validation_commands"],
      contractPath: artifactPaths.validationContract,
      evidencePaths: {
        baseline: artifactPaths.baseline,
        implementation: artifactPaths.implementationEvidence,
        finalReport: artifactPaths.finalReport,
      },
      baseline: { status: "pending", path: artifactPaths.baseline },
      finalVerification: { status: "pending", outcomeBased: true, path: artifactPaths.finalReport },
    },
    allowlist: {
      current: allowlist,
      decisionsPath: artifactPaths.allowlistDecisions,
    },
    repair: {
      maxRepairIterations,
      attempts: 0,
      remaining: maxRepairIterations,
      attemptsPath: artifactPaths.repairAttempts,
    },
    failureClassification: {
      current: null,
      status: "none",
      classificationsPath: artifactPaths.failureClassifications,
    },
    reports: {
      finalReportPath: artifactPaths.finalReport,
      intermediateReportsDir: artifactPaths.intermediateReportsDir,
      precheckReportPath: artifactPaths.precheckReport,
    },
    artifacts: existing.artifacts || artifactPaths,
    artifactRegistryPath: existing.artifactRegistryPath || artifactPaths.artifactRegistry,
    observations: {
      ...(existing.observations || {}),
      prechecks: [...previousObservations, observation].slice(-25),
      latestPrecheck: observation,
    },
    immutableIdentityPreserved: Boolean(existing.createdAt),
    recoverableByTransactionId: true,
  };
}

function updateGlobalRegistry(state) {
  const file = registryIndexPath();
  const existing = existsSync(file) ? readJson(file) : { schema: "pi-bug-solver-workflow/transaction-index/v1", artifactRoot: ARTIFACT_ROOT, transactions: {} };
  const previous = existing.transactions?.[state.transactionId] || {};
  const next = {
    ...existing,
    schema: "pi-bug-solver-workflow/transaction-index/v1",
    artifactRoot: ARTIFACT_ROOT,
    updatedAt: new Date().toISOString(),
    transactions: {
      ...(existing.transactions || {}),
      [state.transactionId]: {
        transactionId: state.transactionId,
        status: state.lifecycle.status,
        statePath: state.artifacts.state,
        artifactDir: state.artifacts.root,
        planPath: state.artifacts.transactionPlan,
        baseCommit: state.repo.baseCommit,
        updatedAt: state.updatedAt,
        createdAt: previous.createdAt || state.createdAt,
      },
    },
  };
  writeJson(file, next);
  return file;
}

async function precheck(args, json) {
  const cwd = resolve(String(args.cwd || process.cwd()));
  const bug = String(args.bug || args._.join(" ")).trim();
  if (!bug) die("precheck requires --bug describing exactly one bug", 1, json);

  const git = await gitInfo(cwd);
  const artifactRootSafety = validateArtifactRootExternal({ cwd, git });
  const transactionId = args["transaction-id"] || `${safeId(bug).slice(0, 40)}-${hashText(`${cwd}\n${bug}\n${Date.now()}\n${randomUUID()}`)}`;
  const run = createRun({ workflow: WORKFLOW, cwd, input: { action: "precheck", transactionId }, metadata: { transactionId, mode: "precheck", artifactRoot: artifactRootSafety.artifactRoot } });
  const dir = transactionDir(transactionId);
  mkdirSync(dir, { recursive: true });

  try {
    phaseStart(run, "precheck", { transactionId, cwd, artifactRoot: artifactRootSafety.artifactRoot });
    const multiplicity = classifyBugCount(bug);
    const validationCommands = splitValidationCommands(args);
    const userTestCommand = args["user-test-command"] ? String(Array.isArray(args["user-test-command"]) ? args["user-test-command"].at(-1) : args["user-test-command"]).trim() : null;
    const maxRepairIterations = parseMaxRepairs(args["max-repairs"] ?? args.maxRepairIterations);
    const artifactPaths = buildArtifactPaths(dir);
    assertExistingTransactionCompatible({ transactionId, cwd, bug, git, artifactPaths });
    const allowlist = splitValues(args.allowlist || args["allow-list"]);
    const contract = buildValidationContract({ transactionId, bug, cwd, validationCommands, userTestCommand, artifactPaths });
    const plan = buildTransactionPlan({ transactionId, cwd, bug, git, validationCommands, userTestCommand, maxRepairIterations, allowlist, multiplicity, artifactPaths, contractPath: artifactPaths.validationContract });
    const record = {
      schema: "pi-bug-solver-workflow/precheck/v1",
      transactionId,
      createdAt: new Date().toISOString(),
      cwd,
      bug,
      status: multiplicity.likelyMultiple ? "rejected_multi_bug" : "awaiting_confirmation",
      readOnly: true,
      editingAllowed: false,
      confirmationRequired: true,
      approvalInstruction: "Review precheck.json, transaction-plan.json, and validation-contract.json. Then call solve with --approved and --plan-path only if this is exactly one bug transaction.",
      git,
      validationCommands,
      userTestCommand,
      maxRepairIterations,
      allowlist,
      multiplicity,
      transactionPlanPath: artifactPaths.transactionPlan,
      validationContractPath: artifactPaths.validationContract,
      evidencePaths: plan.evidencePaths,
      plannedSafety: {
        worktreeIsolation: true,
        immutableBaseCommit: git.head,
        externalArtifactsDir: dir,
        artifactRoot: artifactRootSafety.artifactRoot,
        targetRoot: artifactRootSafety.targetRoot,
        externalToTargetRepo: artifactRootSafety.externalToTargetRepo,
        threadPhaseWorkflow: WORKFLOW,
        validationAssertionsMappedBeforeImplementation: true,
      },
    };
    const file = artifactPaths.precheck;
    const state = buildTransactionState({ transactionId, cwd, bug, git, validationCommands, userTestCommand, maxRepairIterations, allowlist, multiplicity, artifactPaths, status: record.status });
    const registry = artifactRegistry({ transactionId, artifactPaths });
    const pendingArtifacts = initialPendingArtifacts({ transactionId, cwd, bug, validationCommands, userTestCommand, maxRepairIterations, allowlist, multiplicity, artifactPaths, createdAt: record.createdAt });
    const recordForWrite = {
      ...record,
      plannedSafety: { ...record.plannedSafety, immutableBaseCommit: state.repo.baseCommit, immutableBaseRef: state.repo.baseRef },
      immutableTransactionIdentity: {
        repo: state.repo,
        branch: state.branch,
        worktree: state.worktree,
        artifactRegistryPath: state.artifactRegistryPath,
      },
      currentObservation: state.observations?.latestPrecheck,
    };
    const planForWrite = {
      ...plan,
      repo: state.repo,
      immutableTransactionIdentity: {
        repo: state.repo,
        branch: state.branch,
        worktree: state.worktree,
        artifactRegistryPath: state.artifactRegistryPath,
      },
      latestObservation: state.observations?.latestPrecheck,
      statePath: artifactPaths.state,
      artifactRegistryPath: artifactPaths.artifactRegistry,
    };
    let registryIndex;
    await withPrecheckLock(artifactPaths, transactionId, async () => {
      try {
        writePrecheckIncompleteMarker({ artifactPaths, transactionId, state, stage: "starting_materialization" });
        writeJson(file, recordForWrite);
        writeJson(artifactPaths.transactionPlan, planForWrite);
        writeJson(artifactPaths.validationContract, contract);
        writeInitialJson(artifactPaths.baseline, pendingArtifacts.baseline);
        writeInitialJsonl(artifactPaths.allowlistDecisions, { type: "initial_allowlist", createdAt: record.createdAt, allowlist, justification: "Seeded during read-only precheck before implementation." });
        writeInitialJsonl(artifactPaths.implementationEvidence, pendingArtifacts.implementationEvidence);
        writeInitialJsonl(artifactPaths.repairAttempts, { type: "repair_counter_initialized", createdAt: record.createdAt, attempts: 0, maxRepairIterations, remaining: maxRepairIterations });
        writeInitialJsonl(artifactPaths.failureClassifications, { type: "failure_classification_initialized", createdAt: record.createdAt, status: "none", classification: null });
        writeJson(artifactPaths.precheckReport, pendingArtifacts.precheckReport);
        writeInitialJson(artifactPaths.finalReport, pendingArtifacts.finalReport);
        state.lifecycle.materializationComplete = true;
        state.lifecycle.materializationStatus = "complete";
        writeJson(artifactPaths.state, state);
        verifyRegisteredArtifactsExist(registry, { includeRegistry: false });
        if (process.env.PI_BUG_SOLVER_INTERRUPT_PRECHECK_AFTER === "files") throw new Error("Injected interruption after precheck files materialized before artifact registry write");
        writeJson(artifactPaths.artifactRegistry, registry);
        verifyRegisteredArtifactsExist(registry, { includeRegistry: true });
        clearPrecheckIncompleteMarker(artifactPaths);
        registryIndex = updateGlobalRegistry(state);
      } catch (error) {
        writePrecheckIncompleteMarker({ artifactPaths, transactionId, state, stage: "materialization_interrupted", error });
        throw error;
      }
    });
    phaseEvent(run, "precheck", { message: "Recorded read-only bug transaction precheck and durable state schema", transactionId, status: record.status, artifactPath: file, statePath: artifactPaths.state, artifactRegistryPath: artifactPaths.artifactRegistry });
    emitArtifact(run, { kind: "file", title: "bug-solver precheck", path: file });
    emitArtifact(run, { kind: "file", title: "bug-solver transaction plan", path: artifactPaths.transactionPlan });
    emitArtifact(run, { kind: "file", title: "bug-solver validation contract", path: artifactPaths.validationContract });
    emitArtifact(run, { kind: "file", title: "bug-solver transaction state", path: artifactPaths.state });
    emitArtifact(run, { kind: "file", title: "bug-solver artifact registry", path: artifactPaths.artifactRegistry });
    emitArtifact(run, { kind: "file", title: "bug-solver pending baseline evidence", path: artifactPaths.baseline });
    emitArtifact(run, { kind: "file", title: "bug-solver precheck intermediate report", path: artifactPaths.precheckReport });
    emitArtifact(run, { kind: "file", title: "bug-solver pending final report", path: artifactPaths.finalReport });
    phaseEnd(run, "precheck", multiplicity.likelyMultiple ? STATUSES.FAILED : STATUSES.SUCCESS, { status: record.status, planPath: artifactPaths.transactionPlan, validationContractPath: artifactPaths.validationContract, statePath: artifactPaths.state, artifactRegistryPath: artifactPaths.artifactRegistry });
    completeRun(run, multiplicity.likelyMultiple ? STATUSES.FAILED : STATUSES.SUCCESS, { transactionId, precheckPath: file, planPath: artifactPaths.transactionPlan, validationContractPath: artifactPaths.validationContract, statePath: artifactPaths.state, artifactRegistryPath: artifactPaths.artifactRegistry });
    const result = { ok: !multiplicity.likelyMultiple, action: "precheck", runId: run.runId, transactionId, precheckPath: file, planPath: artifactPaths.transactionPlan, validationContractPath: artifactPaths.validationContract, statePath: artifactPaths.state, artifactRegistryPath: artifactPaths.artifactRegistry, registryIndexPath: registryIndex, artifactDir: dir, status: record.status, confirmationRequired: true };
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`${record.status}: ${file}`);
    process.exit(multiplicity.likelyMultiple ? 1 : 0);
  } catch (error) {
    failRun(run, error, { transactionId });
    throw error;
  }
}

async function solve(args, json) {
  const cwd = resolve(String(args.cwd || process.cwd()));
  const git = await gitInfo(cwd);
  validateArtifactRootExternal({ cwd, git });
  if (!args.approved) die("solve requires --approved after explicit precheck confirmation", 1, json);
  if (!args["plan-path"]) die("solve requires --plan-path from precheck", 1, json);
  const planPath = resolve(String(args["plan-path"]));
  if (!existsSync(planPath)) die(`precheck plan not found: ${planPath}`, 1, json);
  const planArtifact = readJson(planPath);
  const plan = normalizeSolvePlanArtifact(planArtifact);
  const transactionId = plan.transactionId;
  const planBugDescription = plan.transaction?.bugDescription || "";
  const currentMultiplicity = classifyBugCount(planBugDescription);
  const storedMultiplicity = plan.transaction?.multiplicity || {};
  const multiplicity = currentMultiplicity.likelyMultiple ? currentMultiplicity : storedMultiplicity;
  const gate = assessPreImplementationGate(planArtifact, multiplicity);
  const run = createRun({ workflow: WORKFLOW, cwd, input: { action: "solve", transactionId }, metadata: { transactionId, mode: "solve" } });
  try {
    phaseStart(run, "confirmation-gate", { planPath, approved: true });
    if (plan.status === "rejected_multi_bug" || multiplicity?.likelyMultiple || gate.exactlyOneBug === false || gate.splitRequired) throw new Error("Precheck classified this request as multiple bugs; split it before solving.");
    if (plan.editingAllowed === true) throw new Error("Refusing a plan that was not preserved as pre-implementation/editingAllowed=false.");
    if (!plan.validationContractPath) throw new Error("Transaction plan is missing a durable validation contract path.");
    if (!gate.safeBeforeEditCapablePhase) throw new Error(`Transaction plan is unsafe before edit-capable phases: ${gate.reasons.join("; ")}`);
    phaseEnd(run, "confirmation-gate", STATUSES.SUCCESS);
    phaseStart(run, "activation-scaffold", { transactionId });
    const activation = {
      schema: "pi-bug-solver-workflow/activation-scaffold/v1",
      transactionId,
      createdAt: new Date().toISOString(),
      status: "not_implemented_in_scaffold",
      planPath,
      validationContractPath: plan.validationContractPath,
      evidencePaths: plan.evidencePaths || {},
      message: "Persistent extension entrypoint is registered. Later milestones implement isolated worktree solving and bounded repairs.",
    };
    const file = join(transactionDir(transactionId), "activation-scaffold.json");
    writeJson(file, activation);
    const statePath = plan.artifacts?.state || join(transactionDir(transactionId), "state.json");
    if (existsSync(statePath)) {
      const state = readJson(statePath);
      const updatedState = {
        ...state,
        updatedAt: new Date().toISOString(),
        revision: Number.isInteger(state.revision) ? state.revision + 1 : 1,
        lifecycle: { ...(state.lifecycle || {}), status: "activation_scaffold_recorded", phase: "activation-scaffold", editingAllowed: false, terminal: false },
        reports: { ...(state.reports || {}), activationScaffoldPath: file },
      };
      writeJson(statePath, updatedState);
      updateGlobalRegistry(updatedState);
      emitArtifact(run, { kind: "file", title: "bug-solver transaction state", path: statePath });
    }
    emitArtifact(run, { kind: "file", title: "bug-solver activation scaffold", path: file });
    phaseEnd(run, "activation-scaffold", STATUSES.SUCCESS, { artifactPath: file });
    completeRun(run, STATUSES.SUCCESS, { transactionId, activationPath: file });
    const result = { ok: true, action: "solve", runId: run.runId, transactionId, activationPath: file };
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`activation scaffold recorded: ${file}`);
  } catch (error) {
    failRun(run, error, { transactionId: plan.transactionId });
    die(error.message || String(error), 1, json);
  }
}

function tryReadJson(file) {
  if (!file || !existsSync(file)) return undefined;
  try { return readJson(file); } catch (error) { return { unreadable: true, error: error.message || String(error), path: file }; }
}

function fileSummary(file) {
  if (!file || !existsSync(file)) return { path: file, exists: false };
  try {
    const stat = statSync(file);
    return { path: file, exists: true, size: stat.size, mtime: stat.mtime.toISOString(), isDirectory: stat.isDirectory() };
  } catch (error) {
    return { path: file, exists: false, error: error.message || String(error) };
  }
}

function listJsonReports(dir) {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((file) => {
        try { return statSync(file).isFile() && /\.(json|jsonl|md|txt)$/i.test(file); } catch { return false; }
      })
      .map((file) => fileSummary(file))
      .sort((a, b) => String(b.mtime || "").localeCompare(String(a.mtime || "")));
  } catch {
    return [];
  }
}

function lastJsonlRecord(file) {
  if (!file || !existsSync(file)) return undefined;
  try {
    const lines = readFileSync(file, "utf8").trim().split(/\n+/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch { /* keep scanning */ }
    }
  } catch { /* ignored: status is best-effort and read-only */ }
  return undefined;
}

function deriveTerminalOutcome({ state, finalReport, activation }) {
  const lifecycle = state?.lifecycle || {};
  const status = lifecycle.status || state?.status || finalReport?.status || activation?.status;
  const terminalByStatus = new Set(["completed", "succeeded", "success", "failed", "cancelled", "rejected_multi_bug"]);
  const terminal = Boolean(lifecycle.terminal || terminalByStatus.has(String(status || "")) || finalReport?.terminal === true);
  return {
    terminal,
    status: status || null,
    outcome: finalReport?.outcome || finalReport?.finalOutcome || (terminal ? status : null) || null,
    reason: finalReport?.reason || finalReport?.summary || activation?.message || null,
  };
}

function loadTransactionInspection(dir, transactionIdHint) {
  const paths = buildArtifactPaths(dir);
  const state = tryReadJson(paths.state);
  const plan = tryReadJson(paths.transactionPlan);
  const precheck = tryReadJson(paths.precheck);
  const artifactRegistryDoc = tryReadJson(paths.artifactRegistry);
  const incompleteMarker = tryReadJson(paths.precheckIncomplete);
  const lock = tryReadJson(paths.precheckLock);
  const lockInspection = inspectPrecheckLock(paths.precheckLock);
  const finalReport = tryReadJson(paths.finalReport);
  const activation = tryReadJson(join(dir, "activation-scaffold.json"));
  const transactionId = state?.transactionId || plan?.transactionId || precheck?.transactionId || transactionIdHint;
  const reportsDir = state?.reports?.intermediateReportsDir || paths.intermediateReportsDir;
  const registryEntries = artifactRegistryDoc?.entries || expectedRegistryEntries({ artifactPaths: paths }).map((entry) => ({ ...entry, lifecycleStatus: "expected_not_registered_until_materialized", durableAtPrecheck: false }));
  const artifactEntries = registryEntries.map((entry) => ({ ...entry, exists: existsSync(entry.path) }));
  const missingRegisteredArtifacts = artifactEntries.filter((entry) => !entry.exists).map((entry) => ({ kind: entry.kind, path: entry.path }));
  const materializationStatus = artifactRegistryDoc?.materializationComplete === true && missingRegisteredArtifacts.length === 0
    ? "complete"
    : lockInspection.exists && lockInspection.recoverable
      ? "recoverable_stale_lock"
      : incompleteMarker?.status === "incomplete" || lockInspection.status === "active"
        ? "incomplete"
        : artifactRegistryDoc ? "corrupt_missing_registered_artifacts" : "not_materialized";
  const worktreePath = state?.worktree?.path || plan?.worktree?.path || transactionWorktreePath(transactionId || transactionIdHint || "unknown");
  const latestFailureClassification = lastJsonlRecord(state?.failureClassification?.classificationsPath || paths.failureClassifications);
  const latestRepairAttempt = lastJsonlRecord(state?.repair?.attemptsPath || paths.repairAttempts);
  return {
    transactionId,
    transactionDir: dir,
    exists: existsSync(dir),
    recoverable: Boolean((state || incompleteMarker || artifactRegistryDoc || lockInspection.recoverable) && existsSync(dir)),
    statePath: paths.state,
    planPath: paths.transactionPlan,
    precheckPath: paths.precheck,
    artifactRegistryPath: paths.artifactRegistry,
    latestPhase: state?.lifecycle?.phase || (incompleteMarker || lockInspection.exists ? "precheck-materialization" : null),
    status: state?.lifecycle?.status || state?.status || plan?.status || precheck?.status || (incompleteMarker ? "precheck_incomplete" : lockInspection.recoverable ? "precheck_lock_recoverable" : null),
    terminalOutcome: deriveTerminalOutcome({ state, finalReport, activation }),
    precheckMaterialization: {
      status: materializationStatus,
      complete: materializationStatus === "complete",
      incompleteMarkerPath: paths.precheckIncomplete,
      incompleteMarker: incompleteMarker || null,
      lockPath: paths.precheckLock,
      lock: lock || null,
      lockInspection,
      lockRecoverable: Boolean(lockInspection.recoverable),
      missingRegisteredArtifacts,
      registryWrittenLast: Boolean(artifactRegistryDoc && materializationStatus === "complete"),
    },
    repo: state?.repo || plan?.repo || (precheck ? { cwd: precheck.cwd, ...(precheck.git || {}) } : undefined),
    branch: state?.branch || { plannedName: transactionId ? transactionBranchName(transactionId) : undefined, status: "unknown" },
    worktree: { ...(state?.worktree || {}), path: worktreePath, exists: existsSync(worktreePath) },
    validation: state?.validation || plan?.validation,
    repair: { ...(state?.repair || {}), latestAttempt: latestRepairAttempt },
    failureClassification: { ...(state?.failureClassification || {}), latest: latestFailureClassification },
    reports: {
      finalReport: fileSummary(state?.reports?.finalReportPath || paths.finalReport),
      precheckReport: fileSummary(state?.reports?.precheckReportPath || paths.precheckReport),
      activationScaffold: fileSummary(join(dir, "activation-scaffold.json")),
      intermediateReportsDir: reportsDir,
      intermediateReports: listJsonReports(reportsDir),
    },
    artifacts: {
      entries: artifactEntries,
      registry: artifactRegistryDoc,
      files: {
        precheck: fileSummary(paths.precheck),
        transactionPlan: fileSummary(paths.transactionPlan),
        validationContract: fileSummary(paths.validationContract),
        state: fileSummary(paths.state),
        artifactRegistry: fileSummary(paths.artifactRegistry),
        baseline: fileSummary(paths.baseline),
        implementationEvidence: fileSummary(paths.implementationEvidence),
        allowlistDecisions: fileSummary(paths.allowlistDecisions),
        repairAttempts: fileSummary(paths.repairAttempts),
        failureClassifications: fileSummary(paths.failureClassifications),
        finalReport: fileSummary(paths.finalReport),
      },
    },
    state,
  };
}

function listTransactionDirs() {
  const root = join(ARTIFACT_ROOT, "transactions");
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .map((name) => join(root, name))
      .filter((dir) => {
        try { return statSync(dir).isDirectory(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

async function status(args, json) {
  const cwd = resolve(String(args.cwd || process.cwd()));
  const git = await gitInfo(cwd);
  validateArtifactRootExternal({ cwd, git });
  const transactionId = args["transaction-id"];
  const transactionDirArg = args["transaction-dir"];
  const indexPath = registryIndexPath();
  const registry = tryReadJson(indexPath);
  const dir = transactionDirArg ? resolve(String(transactionDirArg)) : transactionId ? (registry?.transactions?.[transactionId]?.artifactDir || transactionDir(transactionId)) : join(ARTIFACT_ROOT, "transactions");
  const inspection = transactionId || transactionDirArg ? loadTransactionInspection(dir, transactionId) : undefined;
  const transactions = inspection ? undefined : listTransactionDirs().map((candidate) => {
    const summary = loadTransactionInspection(candidate);
    return {
      transactionId: summary.transactionId,
      transactionDir: summary.transactionDir,
      status: summary.status,
      latestPhase: summary.latestPhase,
      terminalOutcome: summary.terminalOutcome,
      statePath: summary.statePath,
      worktree: summary.worktree,
      reports: summary.reports,
      recoverable: summary.recoverable,
    };
  });
  const result = {
    ok: true,
    action: "status",
    readOnly: true,
    targetRepositoryEdited: false,
    artifactRoot: ARTIFACT_ROOT,
    path: dir,
    exists: existsSync(dir),
    transactionId: transactionId || inspection?.transactionId || undefined,
    registryIndexPath: indexPath,
    registry,
    ...(inspection || { transactions }),
  };
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (inspection) console.log(`${inspection.transactionId || dir}: ${inspection.status || "unknown"} (${inspection.latestPhase || "no phase"})`);
  else console.log(`${dir}${result.exists ? "" : " (missing)"} — ${transactions.length} transaction(s)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = String(args._.shift() || args.action || "help");
  const json = Boolean(args.json);
  if (["help", "-h", "--help"].includes(action)) {
    if (json) console.log(JSON.stringify({ ok: true, usage: usage() }, null, 2));
    else console.log(usage());
    return;
  }
  if (action === "precheck") return precheck(args, json);
  if (action === "solve") return solve(args, json);
  if (action === "status") return status(args, json);
  die(`Unknown action: ${action}\n\n${usage()}`, 1, json);
}

main().catch((error) => die(error?.stack || error?.message || String(error), 1, process.argv.includes("--json")));
