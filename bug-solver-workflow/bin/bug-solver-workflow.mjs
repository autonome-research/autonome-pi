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
const MAX_COMMAND_OUTPUT_BYTES = 24_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
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
    postValidation: join(dir, "evidence", "post-change-validation.json"),
    allowlistDecisions: join(dir, "allowlist-decisions.jsonl"),
    implementationEvidence: join(dir, "evidence", "implementation-evidence.jsonl"),
    repairAttempts: join(dir, "repair-attempts.jsonl"),
    failureClassifications: join(dir, "failure-classifications.jsonl"),
    finalReport: join(dir, "evidence", "final-report.json"),
    worktreeMetadata: join(dir, "worktree-metadata.json"),
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
      validationMethod: "both",
      evidenceRequired: ["precheck.multiplicity", "transactionPlan.transaction.exactlyOneBug"],
      evidencePaths: [artifactPaths.precheck, artifactPaths.transactionPlan],
    },
    {
      id: "durable-external-artifacts",
      description: "All workflow state and evidence artifacts are durable, external to the target repository, and recoverable by transaction id.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["state.recoverableByTransactionId", "artifactRegistry.entries", "registry.transactions[transactionId]"],
      evidencePaths: [artifactPaths.state, artifactPaths.artifactRegistry],
    },
    {
      id: "preimplementation-contract-evidence-map",
      description: "Validation assertions are created before implementation and each assertion is mapped to durable evidence paths before solve can edit.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["validationContract.createdBeforeImplementation", "validationContract.workflowEvidenceMap", "artifactRegistry.materializationComplete"],
      evidencePaths: [artifactPaths.validationContract, artifactPaths.artifactRegistry, artifactPaths.precheckReport],
    },
    {
      id: "isolated-transaction-worktree",
      description: "Solve implementation must run in an isolated transaction worktree/branch rooted at the recorded base and not mutate the caller worktree directly.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["state.worktree.isolated", "state.worktree.rootedAtBaseCommit", "state.branch.plannedName", "transactionPlan.immutableTransactionIdentity", "worktreeMetadata.cleanup"],
      evidencePaths: [artifactPaths.state, artifactPaths.transactionPlan, artifactPaths.worktreeMetadata, artifactPaths.finalReport],
    },
    {
      id: "baseline-aware-validation",
      description: "Baseline command results are recorded before implementation and later compared so pre-existing failures are not reported as new regressions.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["baseline.status", "baseline.commandResults", "postValidation.comparison", "finalReport.failures.regressions"],
      evidencePaths: [artifactPaths.baseline, artifactPaths.postValidation, artifactPaths.finalReport],
    },
    {
      id: "bug-reproduction-before-broad-validation",
      description: "Targeted reproduction or user-provided test commands run before broad validation commands when available.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["validation.userTestCommand", "validation.executionOrder", "baseline.commands.executionOrder", "postValidation.commands.executionOrder", "implementationEvidence.commands"],
      evidencePaths: [artifactPaths.transactionPlan, artifactPaths.baseline, artifactPaths.postValidation, artifactPaths.implementationEvidence, artifactPaths.finalReport],
    },
    {
      id: "allowlisted-scope-control",
      description: "Implementation edits are restricted by an adaptive allowlist, and every expansion is justified durably before use.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["allowlist.current", "allowlist.decisions", "finalReport.decisions"],
      evidencePaths: [artifactPaths.allowlistDecisions, artifactPaths.state, artifactPaths.finalReport],
    },
    {
      id: "failure-classification-evidence",
      description: "Failures are classified into actionable categories and recorded with durable evidence.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["failureClassification.current", "failureClassifications.jsonl", "finalReport.failures.classifications"],
      evidencePaths: [artifactPaths.failureClassifications, artifactPaths.implementationEvidence, artifactPaths.finalReport],
    },
    {
      id: "capped-repair-loop",
      description: "Repair attempts are capped by maxRepairIterations and each attempt is durably recorded.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["repair.maxRepairIterations", "repair.attempts", "repairAttempts.jsonl", "finalReport.repairs"],
      evidencePaths: [artifactPaths.repairAttempts, artifactPaths.state, artifactPaths.finalReport],
    },
    {
      id: "outcome-based-final-verification",
      description: "Final verification is outcome-based and validates that the bug is fixed rather than merely checking command exit codes.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["state.validation.finalVerification.outcomeBased", "postValidation.outcomeComparison", "finalReport.finalVerification", "implementationEvidence.outcome"],
      evidencePaths: [artifactPaths.postValidation, artifactPaths.finalReport, artifactPaths.implementationEvidence, artifactPaths.state],
    },
    {
      id: "reviewable-transaction-output",
      description: "Successful solve produces a reviewable transaction branch or commit with metadata and does not silently merge into the caller branch.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["state.branch.plannedName", "finalReport.commits", "finalReport.outcome.manualReviewRequired"],
      evidencePaths: [artifactPaths.state, artifactPaths.finalReport, artifactPaths.implementationEvidence],
    },
    {
      id: "durable-reports",
      description: "Durable final and intermediate reports summarize decisions, commands, failures, repairs, commits, and evidence paths.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["precheckReport.summary", "finalReport.summary", "finalReport.evidencePaths"],
      evidencePaths: [artifactPaths.precheckReport, artifactPaths.finalReport],
    },
    {
      id: "robust-resumable-invocations",
      description: "Interrupted or repeated invocations recover without corrupting durable state.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["precheckMaterialization", "state.observations.prechecks", "artifactRegistry.registryWrittenLast"],
      evidencePaths: [artifactPaths.state, artifactPaths.artifactRegistry, artifactPaths.precheckReport],
    },
    {
      id: "api-cli-build-integration",
      description: "Extension API, CLI, and build/test integration remain functional.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["cli.precheck", "cli.status", "extension.tool", "package.scripts"],
      evidencePaths: [artifactPaths.precheckReport, artifactPaths.finalReport],
    },
    {
      id: "automated-safety-tests",
      description: "Automated tests cover the core bug-solver workflow safety and validation guarantees.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["testCommands", "smokeEvidence", "finalReport.commands"],
      evidencePaths: [artifactPaths.precheckReport, artifactPaths.finalReport, artifactPaths.implementationEvidence],
    },
    {
      id: "docs-and-examples",
      description: "Documentation and examples explain the workflow, safety gates, artifacts, validation, repair loop, and manual review outcome.",
      priority: "must",
      validationMethod: "both",
      evidenceRequired: ["README", "examples", "finalReport.evidencePaths"],
      evidencePaths: [artifactPaths.precheckReport, artifactPaths.finalReport],
    },
  ];
  return {
    schema: "pi-bug-solver-workflow/validation-contract/v1",
    transactionId,
    createdAt: new Date().toISOString(),
    createdBeforeImplementation: true,
    editingAllowedAtCreation: false,
    evidenceMappingCreatedBeforeImplementation: true,
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
      dirtyAtPrecheck: git.dirty || parseGitStatusSignals(git.statusShort),
      cleanAtPrecheck: !(git.dirty || parseGitStatusSignals(git.statusShort)).hasDirtyWorktree,
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
      postValidation: artifactPaths.postValidation,
      allowlistDecisions: artifactPaths.allowlistDecisions,
      implementation: artifactPaths.implementationEvidence,
      repairAttempts: artifactPaths.repairAttempts,
      failureClassifications: artifactPaths.failureClassifications,
      finalReport: artifactPaths.finalReport,
      worktreeMetadata: artifactPaths.worktreeMetadata,
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

function boundedAppend(current, chunk, maxBytes = MAX_COMMAND_OUTPUT_BYTES) {
  if (Buffer.byteLength(current, "utf8") >= maxBytes) return current;
  let next = current + chunk;
  while (Buffer.byteLength(next, "utf8") > maxBytes) next = next.slice(0, -1);
  return next;
}

function outputTruncationMetadata(text, totalBytes, maxBytes = MAX_COMMAND_OUTPUT_BYTES) {
  return {
    text,
    bytes: totalBytes,
    capturedBytes: Buffer.byteLength(text, "utf8"),
    truncated: totalBytes > Buffer.byteLength(text, "utf8") || totalBytes > maxBytes,
    maxBytes,
  };
}

function commandTimeoutMs() {
  const parsed = Number.parseInt(String(process.env.PI_BUG_SOLVER_COMMAND_TIMEOUT_MS || DEFAULT_COMMAND_TIMEOUT_MS), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COMMAND_TIMEOUT_MS;
}

function runShellCommand(command, cwd) {
  const startedAt = new Date().toISOString();
  const timeoutMs = commandTimeoutMs();
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.stdout.on("data", (d) => { const text = d.toString(); stdoutBytes += Buffer.byteLength(text, "utf8"); stdout = boundedAppend(stdout, text); });
    child.stderr.on("data", (d) => { const text = d.toString(); stderrBytes += Buffer.byteLength(text, "utf8"); stderr = boundedAppend(stderr, text); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ command, cwd, startedAt, completedAt: new Date().toISOString(), status: 1, signal: null, timedOut, durationMs: Date.now() - Date.parse(startedAt), stdout: outputTruncationMetadata(stdout, stdoutBytes), stderr: outputTruncationMetadata(error.message || stderr, stderrBytes + Buffer.byteLength(error.message || "", "utf8")), timeoutMs });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ command, cwd, startedAt, completedAt: new Date().toISOString(), status: timedOut ? 124 : (code ?? 0), signal, timedOut, durationMs: Date.now() - Date.parse(startedAt), stdout: outputTruncationMetadata(stdout, stdoutBytes), stderr: outputTruncationMetadata(stderr, stderrBytes), timeoutMs });
    });
  });
}

function appendJsonl(file, record) {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
}

function baselineCommandList(planArtifact) {
  const validation = planArtifact?.validation || {};
  const targeted = validation.userTestCommand || planArtifact?.userTestCommand;
  const broad = Array.isArray(validation.commands) ? validation.commands : (Array.isArray(planArtifact?.validationCommands) ? planArtifact.validationCommands : []);
  const commands = [];
  if (targeted && String(targeted).trim()) commands.push({ kind: "targeted_user_test", command: String(targeted).trim(), order: 0 });
  for (const command of broad.map(String).map((s) => s.trim()).filter(Boolean)) commands.push({ kind: "broad_validation", command, order: commands.length });
  return commands;
}

function classifyBaselineFailures(results) {
  return results.filter((result) => result.status !== 0).map((result) => ({
    type: "pre_existing_failure",
    phase: "baseline-validation",
    command: result.command,
    commandKind: result.kind,
    status: result.status,
    timedOut: result.timedOut,
    evidence: { stdout: result.stdout, stderr: result.stderr, completedAt: result.completedAt },
    rationale: "The command failed against the unmodified transaction-base worktree before implementation, so later matching failures are classified as pre-existing rather than regressions.",
  }));
}

function commandKey(result) {
  return `${result.kind || "unknown"}\u0000${result.command || ""}`;
}

function compareValidationResults({ baselineResults = [], postResults = [] }) {
  const baselineByCommand = new Map(baselineResults.map((result) => [commandKey(result), result]));
  const postByCommand = new Map(postResults.map((result) => [commandKey(result), result]));
  const fixed = [];
  const unchangedPreExisting = [];
  const newlyRegressed = [];
  const stillPassing = [];
  const notRerun = [];
  for (const baseline of baselineResults) {
    const post = postByCommand.get(commandKey(baseline));
    if (!post) {
      if (baseline.status !== 0) notRerun.push({ command: baseline.command, kind: baseline.kind, baselineStatus: baseline.status });
      continue;
    }
    if (baseline.status !== 0 && post.status === 0) fixed.push({ command: post.command, kind: post.kind, baselineStatus: baseline.status, postStatus: post.status });
    else if (baseline.status !== 0 && post.status !== 0) unchangedPreExisting.push({ command: post.command, kind: post.kind, baselineStatus: baseline.status, postStatus: post.status, timedOut: post.timedOut });
    else if (baseline.status === 0 && post.status !== 0) newlyRegressed.push({ command: post.command, kind: post.kind, baselineStatus: baseline.status, postStatus: post.status, timedOut: post.timedOut });
    else stillPassing.push({ command: post.command, kind: post.kind, status: post.status });
  }
  for (const post of postResults) {
    if (!baselineByCommand.has(commandKey(post)) && post.status !== 0) newlyRegressed.push({ command: post.command, kind: post.kind, baselineStatus: "not_run", postStatus: post.status, timedOut: post.timedOut });
  }
  return { fixed, unchangedPreExisting, newlyRegressed, stillPassing, notRerun };
}

function classifyPostValidationFailures(comparison, postResults, artifactPaths) {
  const failures = [];
  for (const item of comparison.unchangedPreExisting) failures.push({ type: "unchanged_pre_existing_failure", phase: "post-change-validation", ...item, evidencePath: artifactPaths.postValidation, rationale: "The same command failed in baseline before implementation and still fails after changes, so it is not a new regression." });
  for (const item of comparison.newlyRegressed) failures.push({ type: "new_regression", phase: "post-change-validation", ...item, evidencePath: artifactPaths.postValidation, rationale: "The command passed or was absent in baseline evidence but failed after changes." });
  return failures.map((failure) => ({ ...failure, postResult: postResults.find((result) => result.command === failure.command && result.kind === failure.kind) || null }));
}

async function runPostChangeValidation({ transactionId, planArtifact, artifactPaths, worktreePath, baseline }) {
  const startedAt = new Date().toISOString();
  const commands = baselineCommandList(planArtifact);
  const before = await gitInfo(worktreePath);
  const results = [];
  for (const entry of commands) {
    const result = await runShellCommand(entry.command, worktreePath);
    results.push({ ...entry, ...result });
  }
  const after = await gitInfo(worktreePath);
  const comparison = compareValidationResults({ baselineResults: baseline?.commandResults || [], postResults: results });
  const classifications = classifyPostValidationFailures(comparison, results, artifactPaths);
  const targetedFailures = results.filter((result) => result.kind === "targeted_user_test" && result.status !== 0);
  const status = commands.length === 0 ? "skipped_no_commands" : (comparison.newlyRegressed.length ? "completed_with_regressions" : (targetedFailures.length ? "completed_with_unfixed_targeted_failures" : "passed_without_new_regressions"));
  const finalVerification = {
    outcomeBased: true,
    status: targetedFailures.length || comparison.newlyRegressed.length ? "failed" : "passed",
    bugFixed: targetedFailures.length === 0,
    basis: commands.some((entry) => entry.kind === "targeted_user_test") ? "targeted reproduction/user test commands passed after implementation" : "no targeted command was provided; verified no newly-regressed validation outcomes against baseline evidence",
    targetedFailures: targetedFailures.map((result) => ({ command: result.command, status: result.status, timedOut: result.timedOut })),
    newlyRegressedCount: comparison.newlyRegressed.length,
  };
  const record = {
    schema: "pi-bug-solver-workflow/post-change-validation/v1",
    transactionId,
    createdAt: startedAt,
    completedAt: new Date().toISOString(),
    status,
    worktreePath,
    afterImplementation: true,
    baselineEvidencePath: artifactPaths.baseline,
    commandOrder: commands.map((entry) => ({ kind: entry.kind, command: entry.command })),
    targetedBeforeBroad: !commands.some((entry, index) => entry.kind === "broad_validation" && commands.slice(index + 1).some((later) => later.kind === "targeted_user_test")),
    commands: { targeted: commands.filter((entry) => entry.kind === "targeted_user_test").map((entry) => entry.command), broadValidation: commands.filter((entry) => entry.kind === "broad_validation").map((entry) => entry.command), executionOrder: commands.map((entry) => entry.kind), executed: results.map((result) => ({ kind: result.kind, command: result.command, status: result.status, timedOut: result.timedOut, durationMs: result.durationMs })) },
    commandResults: results,
    comparison,
    outcomeComparison: { fixed: comparison.fixed.length, unchangedPreExisting: comparison.unchangedPreExisting.length, newlyRegressed: comparison.newlyRegressed.length, stillPassing: comparison.stillPassing.length },
    finalVerification,
    failures: { classifications, fixed: comparison.fixed, unchangedPreExisting: comparison.unchangedPreExisting, regressions: comparison.newlyRegressed, status: classifications.length ? "classified" : "none" },
    git: { before, after, worktreeChangedByPostValidation: (before.statusShort || "") !== (after.statusShort || "") },
    boundedOutput: { maxStdoutBytes: MAX_COMMAND_OUTPUT_BYTES, maxStderrBytes: MAX_COMMAND_OUTPUT_BYTES },
    evidencePaths: { baseline: artifactPaths.baseline, postValidation: artifactPaths.postValidation, failureClassifications: artifactPaths.failureClassifications, finalReport: artifactPaths.finalReport, state: artifactPaths.state },
  };
  writeJson(artifactPaths.postValidation, record);
  for (const classification of classifications) appendJsonl(artifactPaths.failureClassifications, { ...classification, transactionId, createdAt: record.completedAt, postValidationEvidencePath: artifactPaths.postValidation });
  appendJsonl(artifactPaths.implementationEvidence, { type: "post_change_validation", transactionId, createdAt: record.completedAt, commands: record.commands, outcome: record.finalVerification, comparison: record.outcomeComparison, evidencePath: artifactPaths.postValidation });
  return record;
}

async function runBaselineValidation({ transactionId, planArtifact, artifactPaths, worktreePath, baseCommit, callerCwd }) {
  const startedAt = new Date().toISOString();
  const commands = baselineCommandList(planArtifact);
  const before = await gitInfo(worktreePath);
  const callerBefore = await gitInfo(callerCwd);
  const results = [];
  for (const entry of commands) {
    const result = await runShellCommand(entry.command, worktreePath);
    results.push({ ...entry, ...result });
  }
  const after = await gitInfo(worktreePath);
  const callerAfter = await gitInfo(callerCwd);
  const failureClassifications = classifyBaselineFailures(results);
  const status = commands.length === 0 ? "skipped_no_commands" : (results.some((result) => result.status !== 0) ? "completed_with_pre_existing_failures" : "passed");
  const record = {
    schema: "pi-bug-solver-workflow/baseline-validation/v1",
    transactionId,
    createdAt: startedAt,
    completedAt: new Date().toISOString(),
    status,
    baseCommit,
    worktreePath,
    unmodifiedTransactionBase: true,
    beforeImplementation: true,
    commandOrder: commands.map((entry) => ({ kind: entry.kind, command: entry.command })),
    targetedBeforeBroad: !commands.some((entry, index) => entry.kind === "broad_validation" && commands.slice(index + 1).some((later) => later.kind === "targeted_user_test")),
    commands: { targeted: commands.filter((entry) => entry.kind === "targeted_user_test").map((entry) => entry.command), broadValidation: commands.filter((entry) => entry.kind === "broad_validation").map((entry) => entry.command), executionOrder: commands.map((entry) => entry.kind), executed: results.map((result) => ({ kind: result.kind, command: result.command, status: result.status, timedOut: result.timedOut, durationMs: result.durationMs })) },
    commandResults: results,
    failures: { preExisting: failureClassifications, regressions: [], status: failureClassifications.length ? "pre_existing_failures_detected" : "none" },
    git: { before, after, callerBefore, callerAfter, worktreeChangedByBaseline: (before.statusShort || "") !== (after.statusShort || ""), callerWorktreeChangedByBaseline: (callerBefore.statusShort || "") !== (callerAfter.statusShort || "") || (callerBefore.head || null) !== (callerAfter.head || null) },
    boundedOutput: { maxStdoutBytes: MAX_COMMAND_OUTPUT_BYTES, maxStderrBytes: MAX_COMMAND_OUTPUT_BYTES },
    evidencePaths: { baseline: artifactPaths.baseline, failureClassifications: artifactPaths.failureClassifications, finalReport: artifactPaths.finalReport, state: artifactPaths.state },
  };
  writeJson(artifactPaths.baseline, record);
  for (const classification of failureClassifications) appendJsonl(artifactPaths.failureClassifications, { ...classification, transactionId, createdAt: record.completedAt, baselineEvidencePath: artifactPaths.baseline });
  return record;
}

function parseGitStatusSignals(statusShort) {
  const lines = String(statusShort || "").split(/\n/).filter(Boolean);
  const entries = lines.map((line) => {
    const x = line.slice(0, 1);
    const y = line.slice(1, 2);
    const path = line.slice(3).trim();
    return { raw: line, index: x, workingTree: y, path, untracked: x === "?" && y === "?", staged: x !== " " && x !== "?", unstaged: y !== " " && y !== "?" };
  });
  return {
    hasDirtyWorktree: entries.length > 0,
    statusShort: String(statusShort || ""),
    counts: {
      total: entries.length,
      staged: entries.filter((entry) => entry.staged).length,
      unstaged: entries.filter((entry) => entry.unstaged).length,
      untracked: entries.filter((entry) => entry.untracked).length,
    },
    entries,
  };
}

async function gitInfo(cwd) {
  const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const head = await runGit(cwd, ["rev-parse", "HEAD"]);
  const branch = await runGit(cwd, ["branch", "--show-current"]);
  const status = await runGit(cwd, ["status", "--short"]);
  const statusShort = status.status === 0 ? status.stdout.trimEnd() : undefined;
  const dirty = parseGitStatusSignals(statusShort);
  return {
    isGitRepo: root.status === 0,
    root: root.status === 0 ? root.stdout.trim() : undefined,
    head: head.status === 0 ? head.stdout.trim() : undefined,
    baseCommit: head.status === 0 ? head.stdout.trim() : undefined,
    branch: branch.status === 0 ? branch.stdout.trim() : undefined,
    baseRef: branch.status === 0 ? (branch.stdout.trim() || "HEAD") : undefined,
    statusShort,
    dirty,
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
    ["postChangeValidation", artifactPaths.postValidation, "post-implementation validation results compared against baseline evidence"],
    ["allowlistDecisions", artifactPaths.allowlistDecisions, "initial allowlist and justified expansions"],
    ["implementationEvidence", artifactPaths.implementationEvidence, "implementation and validation evidence log"],
    ["repairAttempts", artifactPaths.repairAttempts, "bounded repair attempt log"],
    ["failureClassifications", artifactPaths.failureClassifications, "classified failures and evidence"],
    ["precheckReport", artifactPaths.precheckReport, "intermediate report summarizing precheck decisions, commands, failures, repairs, commits, and evidence paths"],
    ["finalReport", artifactPaths.finalReport, "outcome-based final report"],
    ["worktreeMetadata", artifactPaths.worktreeMetadata, "isolated transaction worktree/branch creation, reuse, and cleanup metadata"],
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

function commonWorktreeEvidencePaths(artifactPaths) {
  return {
    state: artifactPaths.state,
    transactionPlan: artifactPaths.transactionPlan,
    activationGate: join(artifactPaths.root, "activation-gate.json"),
    worktreeMetadata: artifactPaths.worktreeMetadata,
    finalReport: artifactPaths.finalReport,
    artifactRegistry: artifactPaths.artifactRegistry,
  };
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
      postValidation: artifactPaths.postValidation,
      implementation: artifactPaths.implementationEvidence,
      allowlistDecisions: artifactPaths.allowlistDecisions,
      repairAttempts: artifactPaths.repairAttempts,
      failureClassifications: artifactPaths.failureClassifications,
      precheckReport: artifactPaths.precheckReport,
      finalReport: artifactPaths.finalReport,
      worktreeMetadata: artifactPaths.worktreeMetadata,
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
    postValidation: {
      schema: "pi-bug-solver-workflow/post-change-validation/v1",
      transactionId,
      createdAt,
      status: "pending",
      reason: "Post-change validation runs after implementation and compares targeted-to-broad command results against baseline evidence.",
      commands: commonSummary.commands,
      comparison: { fixed: [], unchangedPreExisting: [], newlyRegressed: [], stillPassing: [], notRerun: [] },
      finalVerification: { status: "pending", outcomeBased: true },
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
      finalVerification: {
        status: "pending",
        outcomeBased: true,
        requiredFinding: "Verify the reported bug behavior is fixed, not only that validation commands exited successfully.",
        evidencePath: artifactPaths.implementationEvidence,
      },
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
      baseCommit: git.baseCommit || git.head || null,
      branch: git.branch || "HEAD",
      baseRef: git.baseRef || git.branch || "HEAD",
      statusShort: git.statusShort || "",
      dirty: git.dirty || parseGitStatusSignals(git.statusShort),
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
    baseCommit: git.baseCommit || git.head || null,
    baseRef: git.baseRef || git.branch || "HEAD",
    statusAtPrecheck: git.statusShort || "",
    dirtyAtPrecheck: git.dirty || parseGitStatusSignals(git.statusShort),
    cleanAtPrecheck: !(git.dirty || parseGitStatusSignals(git.statusShort)).hasDirtyWorktree,
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
        worktreeMetadata: artifactPaths.worktreeMetadata,
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
        immutableBaseCommit: git.baseCommit || git.head,
        cleanWorktreeRequiredForSolve: true,
        dirtyWorktreeDetected: Boolean(git.dirty?.hasDirtyWorktree),
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
    const readOnlyAuditBefore = { head: git.head || null, statusShort: git.statusShort || "", dirty: git.dirty || parseGitStatusSignals(git.statusShort) };
    const recordForWrite = {
      ...record,
      readOnlyAudit: {
        operations: ["git rev-parse --show-toplevel", "git rev-parse HEAD", "git branch --show-current", "git status --short", "external artifact writes only"],
        targetRepositoryEdited: false,
        editingAllowed: false,
        before: readOnlyAuditBefore,
        after: null,
      },
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
        const latestGitBeforeWrite = await gitInfo(cwd);
        const finalRecordForWrite = {
          ...recordForWrite,
          readOnlyAudit: {
            ...recordForWrite.readOnlyAudit,
            after: { head: latestGitBeforeWrite.head || null, statusShort: latestGitBeforeWrite.statusShort || "", dirty: latestGitBeforeWrite.dirty || parseGitStatusSignals(latestGitBeforeWrite.statusShort) },
            unchangedDuringPrecheck: (readOnlyAuditBefore.head || null) === (latestGitBeforeWrite.head || null) && (readOnlyAuditBefore.statusShort || "") === (latestGitBeforeWrite.statusShort || ""),
          },
        };
        writeJson(file, finalRecordForWrite);
        writeJson(artifactPaths.transactionPlan, planForWrite);
        writeJson(artifactPaths.validationContract, contract);
        writeInitialJson(artifactPaths.baseline, pendingArtifacts.baseline);
        writeInitialJson(artifactPaths.postValidation, pendingArtifacts.postValidation);
        writeInitialJsonl(artifactPaths.allowlistDecisions, { type: "initial_allowlist", createdAt: record.createdAt, allowlist, justification: "Seeded during read-only precheck before implementation." });
        writeInitialJsonl(artifactPaths.implementationEvidence, pendingArtifacts.implementationEvidence);
        writeInitialJsonl(artifactPaths.repairAttempts, { type: "repair_counter_initialized", createdAt: record.createdAt, attempts: 0, maxRepairIterations, remaining: maxRepairIterations });
        writeInitialJsonl(artifactPaths.failureClassifications, { type: "failure_classification_initialized", createdAt: record.createdAt, status: "none", classification: null });
        writeJson(artifactPaths.precheckReport, pendingArtifacts.precheckReport);
        writeInitialJson(artifactPaths.finalReport, pendingArtifacts.finalReport);
        writeInitialJson(artifactPaths.worktreeMetadata, {
          schema: "pi-bug-solver-workflow/worktree-metadata/v1",
          transactionId,
          createdAt: record.createdAt,
          status: "pending_activation",
          branch: state.branch,
          worktree: state.worktree,
          cleanup: {
            automatic: false,
            reason: "No isolated transaction worktree is created during read-only precheck.",
            safeRemovalCommand: `git -C ${JSON.stringify(state.repo.root || cwd)} worktree remove ${JSON.stringify(state.worktree.path)}`,
          },
          evidencePaths: commonWorktreeEvidencePaths(artifactPaths),
        });
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
    emitArtifact(run, { kind: "file", title: "bug-solver pending post-change validation evidence", path: artifactPaths.postValidation });
    emitArtifact(run, { kind: "file", title: "bug-solver precheck intermediate report", path: artifactPaths.precheckReport });
    emitArtifact(run, { kind: "file", title: "bug-solver pending final report", path: artifactPaths.finalReport });
    emitArtifact(run, { kind: "file", title: "bug-solver worktree metadata", path: artifactPaths.worktreeMetadata });
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

async function revParse(cwd, ref) {
  const result = await runGit(cwd, ["rev-parse", "--verify", ref]);
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

async function createOrReuseTransactionWorktree({ cwd, transactionId, baseCommit, state, artifactPaths }) {
  const repoRoot = state?.repo?.root || cwd;
  const branchName = state?.branch?.plannedName || transactionBranchName(transactionId);
  const worktreePath = state?.worktree?.path || transactionWorktreePath(transactionId);
  const now = new Date().toISOString();
  const before = await gitInfo(cwd);
  const branchRef = `refs/heads/${branchName}`;
  let branchAction = "created";
  let worktreeAction = "created";
  let branchHead = await revParse(repoRoot, branchRef);
  if (branchHead) {
    branchAction = "reused";
    if (branchHead !== baseCommit) throw new Error(`Refusing to reuse transaction branch ${branchName}: head ${branchHead} is not the recorded base ${baseCommit}.`);
  } else {
    const branchResult = await runGit(repoRoot, ["branch", branchName, baseCommit]);
    if (branchResult.status !== 0) throw new Error(`Unable to create transaction branch ${branchName} at ${baseCommit}: ${(branchResult.stderr || branchResult.stdout).trim()}`);
    branchHead = await revParse(repoRoot, branchRef);
  }

  if (existsSync(worktreePath)) {
    const wtRoot = await runGit(worktreePath, ["rev-parse", "--show-toplevel"]);
    const wtHead = await runGit(worktreePath, ["rev-parse", "HEAD"]);
    const wtBranch = await runGit(worktreePath, ["branch", "--show-current"]);
    if (wtRoot.status !== 0 || resolve(wtRoot.stdout.trim()) !== resolve(worktreePath) || wtHead.stdout.trim() !== baseCommit || wtBranch.stdout.trim() !== branchName) {
      throw new Error(`Refusing to reuse non-matching transaction worktree at ${worktreePath}; expected branch ${branchName} at recorded base ${baseCommit}.`);
    }
    worktreeAction = "reused";
  } else {
    mkdirSync(dirname(worktreePath), { recursive: true });
    const addResult = await runGit(repoRoot, ["worktree", "add", worktreePath, branchName]);
    if (addResult.status !== 0) throw new Error(`Unable to create isolated transaction worktree ${worktreePath}: ${(addResult.stderr || addResult.stdout).trim()}`);
  }

  const worktreeGit = await gitInfo(worktreePath);
  const after = await gitInfo(cwd);
  const callerWorktreeUnchanged = (before.head || null) === (after.head || null) && (before.statusShort || "") === (after.statusShort || "");
  const record = {
    schema: "pi-bug-solver-workflow/worktree-metadata/v1",
    transactionId,
    updatedAt: now,
    status: "ready",
    isolated: true,
    branch: {
      name: branchName,
      ref: branchRef,
      action: branchAction,
      baseCommit,
      head: branchHead || baseCommit,
      rootedAtBaseCommit: true,
    },
    worktree: {
      path: worktreePath,
      action: worktreeAction,
      status: "ready",
      isolated: true,
      rootedAtBaseCommit: baseCommit,
      head: worktreeGit.head || null,
      branch: worktreeGit.branch || null,
      externalToCallerWorktree: !sameOrInsidePath(worktreePath, cwd),
    },
    callerWorktree: {
      path: cwd,
      headBefore: before.head || null,
      statusBefore: before.statusShort || "",
      headAfter: after.head || null,
      statusAfter: after.statusShort || "",
      directMutationDetected: !callerWorktreeUnchanged,
      unchangedByIsolationSetup: callerWorktreeUnchanged,
    },
    cleanup: {
      automatic: false,
      owner: WORKFLOW,
      durableReuse: true,
      reason: "The transaction worktree/branch are preserved for implementation, review, resume, or explicit cleanup.",
      safeRemovalCommand: `git -C ${JSON.stringify(repoRoot)} worktree remove ${JSON.stringify(worktreePath)}`,
      safeBranchDeletionCommand: `git -C ${JSON.stringify(repoRoot)} branch -D ${JSON.stringify(branchName)}`,
    },
    evidencePaths: commonWorktreeEvidencePaths(artifactPaths),
  };
  writeJson(artifactPaths.worktreeMetadata, record);
  if (!callerWorktreeUnchanged) throw new Error(`Isolated worktree setup unexpectedly changed caller worktree status: before=${before.statusShort || "<clean>"}; after=${after.statusShort || "<clean>"}`);
  return record;
}

async function solve(args, json) {
  const cwd = resolve(String(args.cwd || process.cwd()));
  const git = await gitInfo(cwd);
  validateArtifactRootExternal({ cwd, git });
  if (!args.approved) die("solve requires --approved after explicit precheck confirmation", 1, json);
  if (!args["plan-path"]) die("solve requires --plan-path from precheck", 1, json);
  const planPath = resolve(expandHomePath(String(args["plan-path"])));
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
    const precheckDirty = planDirtySignals(planArtifact);
    const currentDirty = git.dirty || parseGitStatusSignals(git.statusShort);
    if (precheckDirty.hasDirtyWorktree) throw new Error(`Refusing unsafe plan recorded against a dirty worktree before edit-capable phases: ${precheckDirty.statusShort}`);
    if (currentDirty.hasDirtyWorktree) throw new Error(`Refusing solve activation from a dirty caller worktree before edit-capable phases: ${currentDirty.statusShort}`);
    if (!gate.safeBeforeEditCapablePhase) throw new Error(`Transaction plan is unsafe before edit-capable phases: ${gate.reasons.join("; ")}`);
    const integrity = assertSolvePlanIntegrity({ planArtifact, planPath, plan, git, cwd });
    phaseEnd(run, "confirmation-gate", STATUSES.SUCCESS, { integrity: "passed", validationAssertions: integrity.contract.assertions.length, artifactCount: integrity.registry.entries.length });
    phaseStart(run, "gated-activation", { transactionId });
    const artifactPaths = integrity.artifactPaths;
    const worktreeRecord = await createOrReuseTransactionWorktree({ cwd, transactionId, baseCommit: integrity.baseCommit, state: integrity.state, artifactPaths });
    const activation = {
      schema: "pi-bug-solver-workflow/gated-activation/v1",
      transactionId,
      createdAt: new Date().toISOString(),
      status: "isolated_worktree_ready",
      editingAllowed: false,
      callerWorktreeEditingAllowed: false,
      implementationWorktreeEditingAllowed: true,
      editCapableResourcesCreated: true,
      planPath,
      validationContractPath: plan.validationContractPath,
      statePath: plan.artifacts?.state || plan.evidencePaths?.state,
      artifactRegistryPath: plan.artifactRegistryPath || plan.artifacts?.artifactRegistry || plan.evidencePaths?.artifactRegistry,
      worktreeMetadataPath: artifactPaths.worktreeMetadata,
      evidencePaths: { ...(plan.evidencePaths || {}), worktreeMetadata: artifactPaths.worktreeMetadata },
      integrityChecks: {
        approved: true,
        exactlyOneBug: true,
        immutableBaseMetadata: "verified",
        validationContract: "materialized_with_evidence_map",
        externalArtifacts: "verified",
        safePlanSchema: plan.sourceKind,
        callerWorktreeUnchanged: worktreeRecord.callerWorktree.unchangedByIsolationSetup,
      },
      branch: worktreeRecord.branch,
      worktree: worktreeRecord.worktree,
      cleanup: worktreeRecord.cleanup,
      message: "Solve confirmation gate passed and an isolated transaction worktree/branch rooted at the recorded base is ready. Implementation must run in that worktree; the caller worktree was not mutated directly.",
    };
    const file = join(transactionDir(transactionId), "activation-gate.json");
    writeJson(file, activation);
    const statePath = plan.artifacts?.state || join(transactionDir(transactionId), "state.json");
    let updatedStateForRegistry;
    if (existsSync(statePath)) {
      const state = readJson(statePath);
      const updatedState = {
        ...state,
        updatedAt: new Date().toISOString(),
        revision: Number.isInteger(state.revision) ? state.revision + 1 : 1,
        lifecycle: {
          ...(state.lifecycle || {}),
          status: "isolated_worktree_ready",
          phase: "gated-activation",
          editingAllowed: false,
          callerWorktreeEditingAllowed: false,
          implementationWorktreeEditingAllowed: true,
          editCapableResourcesCreated: true,
          terminal: false,
        },
        branch: { ...(state.branch || {}), ...worktreeRecord.branch, plannedName: worktreeRecord.branch.name, currentName: worktreeRecord.branch.name, status: "ready" },
        worktree: { ...(state.worktree || {}), ...worktreeRecord.worktree, status: "ready" },
        reports: { ...(state.reports || {}), activationGatePath: file, worktreeMetadataPath: artifactPaths.worktreeMetadata },
      };
      writeJson(statePath, updatedState);
      updatedStateForRegistry = updatedState;
      emitArtifact(run, { kind: "file", title: "bug-solver transaction state", path: statePath });
    }
    emitArtifact(run, { kind: "file", title: "bug-solver gated activation", path: file });
    emitArtifact(run, { kind: "file", title: "bug-solver worktree metadata", path: artifactPaths.worktreeMetadata });
    phaseEnd(run, "gated-activation", STATUSES.SUCCESS, { artifactPath: file, worktreePath: worktreeRecord.worktree.path, branch: worktreeRecord.branch.name });

    phaseStart(run, "baseline-validation", { transactionId, worktreePath: worktreeRecord.worktree.path, baselinePath: artifactPaths.baseline });
    const baseline = await runBaselineValidation({ transactionId, planArtifact, artifactPaths, worktreePath: worktreeRecord.worktree.path, baseCommit: integrity.baseCommit, callerCwd: cwd });
    if (existsSync(statePath)) {
      const state = readJson(statePath);
      const updatedState = {
        ...state,
        updatedAt: new Date().toISOString(),
        revision: Number.isInteger(state.revision) ? state.revision + 1 : 1,
        lifecycle: { ...(state.lifecycle || {}), status: "baseline_validation_recorded", phase: "baseline-validation", terminal: false },
        validation: { ...(state.validation || {}), baseline: { status: baseline.status, path: artifactPaths.baseline, completedAt: baseline.completedAt, preExistingFailureCount: baseline.failures.preExisting.length, targetedBeforeBroad: baseline.targetedBeforeBroad } },
        failureClassification: { ...(state.failureClassification || {}), current: baseline.failures.preExisting.at(-1) || null, status: baseline.failures.preExisting.length ? "pre_existing_failures" : "none", classificationsPath: artifactPaths.failureClassifications },
      };
      writeJson(statePath, updatedState);
      updatedStateForRegistry = updatedState;
    }
    if (existsSync(artifactPaths.finalReport)) {
      const finalReport = readJson(artifactPaths.finalReport);
      writeJson(artifactPaths.finalReport, {
        ...finalReport,
        updatedAt: baseline.completedAt,
        status: "baseline_validation_recorded",
        commands: baseline.commands,
        failures: { ...(finalReport.failures || {}), preExisting: baseline.failures.preExisting, regressions: [], status: baseline.failures.status },
        evidencePaths: { ...(finalReport.evidencePaths || {}), baseline: artifactPaths.baseline, failureClassifications: artifactPaths.failureClassifications },
      });
    }
    if (updatedStateForRegistry) updateGlobalRegistry(updatedStateForRegistry);
    emitArtifact(run, { kind: "file", title: "bug-solver baseline validation", path: artifactPaths.baseline });
    emitArtifact(run, { kind: "file", title: "bug-solver failure classifications", path: artifactPaths.failureClassifications });
    phaseEnd(run, "baseline-validation", baseline.status === "passed" || baseline.status === "skipped_no_commands" || baseline.status === "completed_with_pre_existing_failures" ? STATUSES.SUCCESS : STATUSES.FAILED, { status: baseline.status, commands: baseline.commandResults.length, preExistingFailures: baseline.failures.preExisting.length, targetedBeforeBroad: baseline.targetedBeforeBroad });

    phaseStart(run, "post-change-validation", { transactionId, worktreePath: worktreeRecord.worktree.path, baselinePath: artifactPaths.baseline, postValidationPath: artifactPaths.postValidation });
    const postValidation = await runPostChangeValidation({ transactionId, planArtifact, artifactPaths, worktreePath: worktreeRecord.worktree.path, baseline });
    if (existsSync(statePath)) {
      const state = readJson(statePath);
      const updatedState = {
        ...state,
        updatedAt: postValidation.completedAt,
        revision: Number.isInteger(state.revision) ? state.revision + 1 : 1,
        lifecycle: { ...(state.lifecycle || {}), status: "post_change_validation_recorded", phase: "post-change-validation", terminal: false },
        validation: {
          ...(state.validation || {}),
          postValidation: { status: postValidation.status, path: artifactPaths.postValidation, completedAt: postValidation.completedAt, targetedBeforeBroad: postValidation.targetedBeforeBroad, outcomeComparison: postValidation.outcomeComparison },
          finalVerification: { ...(state.validation?.finalVerification || {}), ...postValidation.finalVerification, path: artifactPaths.finalReport, evidencePath: artifactPaths.postValidation },
        },
        failureClassification: { ...(state.failureClassification || {}), current: postValidation.failures.classifications.at(-1) || baseline.failures.preExisting.at(-1) || null, status: postValidation.failures.classifications.length ? "post_validation_classified" : (baseline.failures.preExisting.length ? "pre_existing_failures" : "none"), classificationsPath: artifactPaths.failureClassifications },
      };
      writeJson(statePath, updatedState);
      updatedStateForRegistry = updatedState;
    }
    if (existsSync(artifactPaths.finalReport)) {
      const finalReport = readJson(artifactPaths.finalReport);
      writeJson(artifactPaths.finalReport, {
        ...finalReport,
        updatedAt: postValidation.completedAt,
        status: "post_change_validation_recorded",
        commands: postValidation.commands,
        failures: {
          ...(finalReport.failures || {}),
          preExisting: baseline.failures.preExisting,
          fixed: postValidation.failures.fixed,
          unchangedPreExisting: postValidation.failures.unchangedPreExisting,
          regressions: postValidation.failures.regressions,
          classifications: [...(baseline.failures.preExisting || []), ...(postValidation.failures.classifications || [])],
          status: postValidation.failures.status,
        },
        finalVerification: postValidation.finalVerification,
        evidencePaths: { ...(finalReport.evidencePaths || {}), baseline: artifactPaths.baseline, postValidation: artifactPaths.postValidation, failureClassifications: artifactPaths.failureClassifications },
      });
    }
    if (updatedStateForRegistry) updateGlobalRegistry(updatedStateForRegistry);
    emitArtifact(run, { kind: "file", title: "bug-solver post-change validation", path: artifactPaths.postValidation });
    emitArtifact(run, { kind: "file", title: "bug-solver implementation evidence", path: artifactPaths.implementationEvidence });
    phaseEnd(run, "post-change-validation", postValidation.failures.regressions.length === 0 && postValidation.finalVerification.status === "passed" ? STATUSES.SUCCESS : STATUSES.FAILED, { status: postValidation.status, commands: postValidation.commandResults.length, fixed: postValidation.comparison.fixed.length, unchangedPreExisting: postValidation.comparison.unchangedPreExisting.length, newlyRegressed: postValidation.comparison.newlyRegressed.length, targetedBeforeBroad: postValidation.targetedBeforeBroad, finalVerification: postValidation.finalVerification.status });

    completeRun(run, STATUSES.SUCCESS, { transactionId, activationPath: file, worktreeMetadataPath: artifactPaths.worktreeMetadata, baselinePath: artifactPaths.baseline, postValidationPath: artifactPaths.postValidation, baselineStatus: baseline.status, postValidationStatus: postValidation.status, worktreePath: worktreeRecord.worktree.path, branch: worktreeRecord.branch.name });
    const result = { ok: true, action: "solve", runId: run.runId, transactionId, activationPath: file, worktreeMetadataPath: artifactPaths.worktreeMetadata, baselinePath: artifactPaths.baseline, postValidationPath: artifactPaths.postValidation, baselineStatus: baseline.status, postValidationStatus: postValidation.status, preExistingFailureCount: baseline.failures.preExisting.length, newlyRegressedCount: postValidation.comparison.newlyRegressed.length, fixedCount: postValidation.comparison.fixed.length, unchangedPreExistingCount: postValidation.comparison.unchangedPreExisting.length, finalVerification: postValidation.finalVerification, status: "post_change_validation_recorded", editCapableResourcesCreated: true, worktreePath: worktreeRecord.worktree.path, branch: worktreeRecord.branch.name };
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`gated activation recorded: ${file}`);
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

function planDirtySignals(plan) {
  const repo = plan?.repo || plan?.immutableTransactionIdentity?.repo || plan?.git || {};
  const dirty = repo.dirtyAtPrecheck || repo.dirty || parseGitStatusSignals(repo.statusAtPrecheck || repo.statusShort || "");
  return dirty;
}

function collectStringPaths(value, paths = new Set()) {
  if (!value || typeof value !== "object") return paths;
  for (const entry of Object.values(value)) {
    if (typeof entry === "string" && (entry.startsWith("/") || entry.startsWith("~"))) paths.add(resolve(expandHomePath(entry)));
    else if (entry && typeof entry === "object") collectStringPaths(entry, paths);
  }
  return paths;
}

function assertPathExternalToTarget(file, label, { targetRoot, targetCwd }) {
  if (!file || typeof file !== "string") throw new Error(`Transaction plan is missing required artifact path: ${label}`);
  if (!isAbsolute(expandHomePath(file))) throw new Error(`Transaction artifact path for ${label} must be absolute and external: ${file}`);
  const absolute = resolve(expandHomePath(file));
  const physical = physicalPathForContainment(absolute);
  if (sameOrInsidePath(absolute, targetRoot) || sameOrInsidePath(absolute, targetCwd) || sameOrInsidePath(physical, physicalPathForContainment(targetRoot)) || sameOrInsidePath(physical, physicalPathForContainment(targetCwd))) {
    throw new Error(`Unsafe transaction artifact path for ${label}; must be external to target repository: ${absolute}`);
  }
  return absolute;
}

function assertExistingExternalFile(file, label, context) {
  const absolute = assertPathExternalToTarget(file, label, context);
  if (!existsSync(absolute)) throw new Error(`Required durable artifact for ${label} does not exist before solve activation: ${absolute}`);
  return absolute;
}

function canonicalArtifactPath(file) {
  return resolve(expandHomePath(file));
}

function assertSameArtifactPath(actual, expected, label) {
  if (!actual || !expected || canonicalArtifactPath(actual) !== canonicalArtifactPath(expected)) {
    throw new Error(`${label} mismatch: expected durable registered artifact ${expected || "<missing>"}, got ${actual || "<missing>"}`);
  }
  return canonicalArtifactPath(actual);
}

function registryEntryByKind(registry) {
  return new Map((registry?.entries || []).map((entry) => [entry.kind, entry]));
}

function assertImmutableBaseMetadata({ planArtifact, state, git }) {
  const repo = planArtifact?.repo || planArtifact?.immutableTransactionIdentity?.repo || planArtifact?.git || {};
  const baseCommit = repo.baseCommit || repo.head;
  if (!baseCommit || typeof baseCommit !== "string") throw new Error("Transaction plan is missing immutable base commit metadata.");
  if (git.head && baseCommit !== git.head) throw new Error(`Refusing solve activation because caller HEAD ${git.head} differs from recorded base ${baseCommit}; rerun precheck at the intended base.`);
  const mismatches = [];
  if (state?.repo?.baseCommit && state.repo.baseCommit !== baseCommit) mismatches.push(`state.repo.baseCommit=${state.repo.baseCommit}`);
  if (state?.branch?.baseCommit && state.branch.baseCommit !== baseCommit) mismatches.push(`state.branch.baseCommit=${state.branch.baseCommit}`);
  if (state?.worktree?.rootedAtBaseCommit && state.worktree.rootedAtBaseCommit !== baseCommit) mismatches.push(`state.worktree.rootedAtBaseCommit=${state.worktree.rootedAtBaseCommit}`);
  if (mismatches.length) throw new Error(`Transaction immutable base metadata is inconsistent with plan base ${baseCommit}: ${mismatches.join(", ")}`);
  return baseCommit;
}

function assertValidationContractIntegrity(contractPath, context) {
  const file = assertExistingExternalFile(contractPath, "validationContract", context);
  const contract = readJson(file);
  if (contract?.schema !== "pi-bug-solver-workflow/validation-contract/v1") throw new Error(`Validation contract has unsafe or unrecognized schema: ${contract?.schema || "missing"}`);
  if (contract.createdBeforeImplementation !== true || contract.evidenceMappingCreatedBeforeImplementation !== true) throw new Error("Validation contract must be created with evidence mappings before implementation.");
  if (!Array.isArray(contract.assertions) || contract.assertions.length === 0) throw new Error("Validation contract must contain explicit assertions before solve activation.");
  const evidenceMap = contract.workflowEvidenceMap || {};
  for (const assertion of contract.assertions) {
    const mapped = evidenceMap[assertion.id];
    if (!Array.isArray(mapped) || mapped.length === 0) throw new Error(`Validation assertion ${assertion.id || "<missing>"} is not mapped to durable evidence paths.`);
    for (const evidencePath of mapped) assertExistingExternalFile(evidencePath, `validationContract.workflowEvidenceMap.${assertion.id}`, context);
  }
  return contract;
}

function assertSolvePlanIntegrity({ planArtifact, planPath, plan, git, cwd }) {
  const targetRoot = resolve(git?.root || cwd);
  const targetCwd = resolve(cwd);
  const context = { targetRoot, targetCwd };
  if (plan.sourceKind !== "transaction-plan" && plan.sourceKind !== "precheck") throw new Error(`Refusing unsafe plan schema before edit-capable phases: ${planArtifact?.schema || "missing"}`);
  const submittedPlanPath = assertExistingExternalFile(planPath, "planPath", context);
  const statePath = planArtifact.statePath || plan.artifacts?.state || plan.evidencePaths?.state;
  const artifactRegistryPath = planArtifact.artifactRegistryPath || plan.artifacts?.artifactRegistry || plan.evidencePaths?.artifactRegistry;
  const stateFile = assertExistingExternalFile(statePath, "state", context);
  const state = readJson(stateFile);
  if (state?.schema !== "pi-bug-solver-workflow/state/v1") throw new Error(`Transaction state has unsafe or unrecognized schema: ${state?.schema || "missing"}`);
  if (state.transactionId !== plan.transactionId) throw new Error("Transaction state id does not match solve plan id.");
  const baseCommit = assertImmutableBaseMetadata({ planArtifact, state, git });
  const registryFile = assertExistingExternalFile(artifactRegistryPath, "artifactRegistry", context);
  const registry = readJson(registryFile);
  if (registry?.schema !== "pi-bug-solver-workflow/artifact-registry/v1" || registry.materializationComplete !== true || !Array.isArray(registry.entries) || registry.entries.length === 0) throw new Error("Artifact registry must be materialized before solve activation.");
  if (registry.transactionId !== plan.transactionId) throw new Error("Artifact registry transaction id does not match solve plan id.");
  if (registry.recoverableByTransactionId !== true) throw new Error("Artifact registry must be recoverable by transaction id before solve activation.");
  const entriesByKind = registryEntryByKind(registry);
  for (const requiredKind of ["precheck", "transactionPlan", "validationContract", "state", "artifactRegistry"]) {
    if (!entriesByKind.has(requiredKind)) throw new Error(`Artifact registry is missing required authoritative ${requiredKind} entry.`);
  }
  for (const entry of registry.entries) {
    assertExistingExternalFile(entry.path, `artifactRegistry.entries.${entry.kind || "artifact"}`, context);
    if (entry.externalToTargetRepo !== true || entry.durableAtPrecheck !== true || entry.lifecycleStatus !== "materialized_at_precheck") throw new Error(`Artifact registry entry is not a durable external precheck artifact: ${entry.kind || entry.path}`);
  }
  assertSameArtifactPath(stateFile, entriesByKind.get("state")?.path, "state path");
  assertSameArtifactPath(registryFile, entriesByKind.get("artifactRegistry")?.path, "artifact registry path");
  assertSameArtifactPath(plan.validationContractPath, entriesByKind.get("validationContract")?.path, "validation contract path");
  const authoritativeTransactionPlanPath = assertSameArtifactPath(planArtifact.transactionPlanPath || plan.artifacts?.transactionPlan || submittedPlanPath, entriesByKind.get("transactionPlan")?.path, "transaction plan path");
  if (plan.sourceKind === "transaction-plan") assertSameArtifactPath(submittedPlanPath, authoritativeTransactionPlanPath, "submitted transaction plan path");
  if (plan.sourceKind === "precheck") assertSameArtifactPath(submittedPlanPath, entriesByKind.get("precheck")?.path, "submitted precheck path");

  const expectedDir = canonicalArtifactPath(state.artifacts?.root || registry.transactionDir || dirname(registryFile));
  if (registry.transactionDir) assertSameArtifactPath(registry.transactionDir, expectedDir, "registry transaction directory");
  if (registry.artifactRoot) assertSameArtifactPath(registry.artifactRoot, ARTIFACT_ROOT, "artifact root");
  const expectedArtifactPaths = buildArtifactPaths(expectedDir);
  for (const [kind, expectedPath] of Object.entries({ precheck: expectedArtifactPaths.precheck, transactionPlan: expectedArtifactPaths.transactionPlan, validationContract: expectedArtifactPaths.validationContract, state: expectedArtifactPaths.state, artifactRegistry: expectedArtifactPaths.artifactRegistry })) {
    assertSameArtifactPath(entriesByKind.get(kind)?.path, expectedPath, `registered ${kind} path`);
  }

  const lifecycle = state.lifecycle || {};
  const allowedLifecycleStatuses = new Set(["awaiting_confirmation", "isolated_worktree_ready", "baseline_validation_recorded", "post_change_validation_recorded"]);
  if (!allowedLifecycleStatuses.has(String(lifecycle.status || "")) || lifecycle.terminal === true) throw new Error(`Transaction state lifecycle is not eligible for solve activation: ${lifecycle.status || "missing"}`);
  if (lifecycle.readOnlyPrecheckComplete !== true || lifecycle.materializationComplete !== true || lifecycle.editingAllowed !== false || lifecycle.confirmationRequired !== true) throw new Error("Transaction state lifecycle does not preserve the durable read-only precheck approval gate.");
  if (state.transaction?.exactlyOneBug !== true || state.transaction?.multiplicity?.likelyMultiple !== false) throw new Error("Transaction state does not authorize exactly one bug for solve activation.");
  if (state.transaction?.bugDescription !== plan.transaction?.bugDescription) throw new Error("Transaction state bug description does not match solve plan bug description.");
  if (plan.transaction?.multiplicity?.likelyMultiple !== false || plan.transaction?.splitRequired === true || plan.transaction?.exactlyOneBug !== true) throw new Error("Transaction plan multiplicity does not authorize exactly one bug for solve activation.");
  if (state.validation?.contractPath) assertSameArtifactPath(state.validation.contractPath, entriesByKind.get("validationContract")?.path, "state validation contract path");
  if (state.artifactRegistryPath) assertSameArtifactPath(state.artifactRegistryPath, registryFile, "state artifact registry path");

  const globalRegistry = existsSync(registryIndexPath()) ? readJson(registryIndexPath()) : undefined;
  const indexed = globalRegistry?.transactions?.[plan.transactionId];
  if (globalRegistry?.schema !== "pi-bug-solver-workflow/transaction-index/v1" || !indexed) throw new Error("Global transaction registry is missing this transaction id before solve activation.");
  assertSameArtifactPath(indexed.statePath, stateFile, "global registry state path");
  assertSameArtifactPath(indexed.artifactDir, expectedDir, "global registry artifact directory");
  assertSameArtifactPath(indexed.planPath, entriesByKind.get("transactionPlan")?.path, "global registry transaction plan path");
  if (indexed.baseCommit !== baseCommit) throw new Error(`Global transaction registry base commit ${indexed.baseCommit || "<missing>"} does not match plan base ${baseCommit}.`);

  const contract = assertValidationContractIntegrity(plan.validationContractPath, context);
  if (contract.transactionId !== plan.transactionId) throw new Error("Validation contract transaction id does not match solve plan id.");
  if (contract.repoPath && canonicalArtifactPath(contract.repoPath) !== targetCwd && canonicalArtifactPath(contract.repoPath) !== targetRoot) throw new Error("Validation contract repository path does not match solve target repository.");
  const transactionPlan = readJson(authoritativeTransactionPlanPath);
  if (transactionPlan?.schema !== "pi-bug-solver-workflow/transaction-plan/v1" || transactionPlan.transactionId !== plan.transactionId) throw new Error("Durable registered transaction plan does not match solve transaction id.");
  if (transactionPlan.status !== plan.status || transactionPlan.transaction?.bugDescription !== plan.transaction?.bugDescription) throw new Error("Submitted solve artifact does not match the durable registered transaction plan.");
  if (transactionPlan.validation?.contractPath) assertSameArtifactPath(transactionPlan.validation.contractPath, entriesByKind.get("validationContract")?.path, "registered transaction plan contract path");
  if (transactionPlan.statePath) assertSameArtifactPath(transactionPlan.statePath, stateFile, "registered transaction plan state path");
  if (transactionPlan.artifactRegistryPath) assertSameArtifactPath(transactionPlan.artifactRegistryPath, registryFile, "registered transaction plan artifact registry path");
  if (plan.sourceKind === "precheck") {
    const transactionPlanFile = assertExistingExternalFile(planArtifact.transactionPlanPath || plan.artifacts?.transactionPlan, "transactionPlan", context);
    assertSameArtifactPath(transactionPlanFile, authoritativeTransactionPlanPath, "precheck referenced transaction plan path");
  }
  for (const [index, artifactPath] of [...collectStringPaths(planArtifact.artifacts), ...collectStringPaths(planArtifact.evidencePaths)].entries()) {
    if ([".precheck-incomplete.json", ".precheck.lock"].some((suffix) => artifactPath.endsWith(suffix))) {
      assertPathExternalToTarget(artifactPath, `plan.artifactPath.${index}`, context);
      continue;
    }
    assertExistingExternalFile(artifactPath, `plan.artifactPath.${index}`, context);
  }
  return { state, registry, contract, baseCommit, artifactPaths: expectedArtifactPaths };
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
  const worktreeMetadata = tryReadJson(paths.worktreeMetadata);
  const activation = tryReadJson(join(dir, "activation-gate.json")) || tryReadJson(join(dir, "activation-scaffold.json"));
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
    worktree: { ...(state?.worktree || {}), ...(worktreeMetadata?.worktree || {}), path: worktreePath, exists: existsSync(worktreePath), metadataPath: paths.worktreeMetadata, metadata: worktreeMetadata },
    validation: state?.validation || plan?.validation,
    repair: { ...(state?.repair || {}), latestAttempt: latestRepairAttempt },
    failureClassification: { ...(state?.failureClassification || {}), latest: latestFailureClassification },
    reports: {
      finalReport: fileSummary(state?.reports?.finalReportPath || paths.finalReport),
      precheckReport: fileSummary(state?.reports?.precheckReportPath || paths.precheckReport),
      activationGate: fileSummary(join(dir, "activation-gate.json")),
      activationScaffold: fileSummary(join(dir, "activation-scaffold.json")),
      worktreeMetadata: fileSummary(paths.worktreeMetadata),
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
        postValidation: fileSummary(paths.postValidation),
        implementationEvidence: fileSummary(paths.implementationEvidence),
        allowlistDecisions: fileSummary(paths.allowlistDecisions),
        repairAttempts: fileSummary(paths.repairAttempts),
        failureClassifications: fileSummary(paths.failureClassifications),
        finalReport: fileSummary(paths.finalReport),
        worktreeMetadata: fileSummary(paths.worktreeMetadata),
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
