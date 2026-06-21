#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

const WORKFLOW = "bug-solver-workflow";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const ARTIFACT_ROOT = process.env.PI_BUG_SOLVER_ARTIFACT_DIR || join(AGENT_DIR, "bug-solver-workflow");

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
  return `Usage:\n  bug-solver-workflow precheck --bug <single bug> [--cwd <repo>] [--validation-command <cmd>] [--user-test-command <cmd>] [--max-repairs <n>] [--allowlist <path>] [--json]\n  bug-solver-workflow solve --plan-path <transaction-plan.json|precheck.json> --approved [--cwd <repo>] [--json]\n  bug-solver-workflow status [--transaction-id <id>] [--json]\n\nThe solve action is intentionally approval-gated. Runtime artifacts are written outside the target repo under ${ARTIFACT_ROOT}.`;
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
    baseline: join(dir, "evidence", "baseline-validation.json"),
    allowlistDecisions: join(dir, "allowlist-decisions.jsonl"),
    implementationEvidence: join(dir, "evidence", "implementation-evidence.jsonl"),
    finalReport: join(dir, "evidence", "final-report.json"),
    state: join(dir, "state.json"),
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
    evidencePaths: {
      precheck: artifactPaths.precheck,
      validationContract: artifactPaths.validationContract,
      baseline: artifactPaths.baseline,
      allowlistDecisions: artifactPaths.allowlistDecisions,
      implementation: artifactPaths.implementationEvidence,
      finalReport: artifactPaths.finalReport,
    },
  };
}

function writeInitialJsonl(file, record) {
  mkdirSync(resolve(file, ".."), { recursive: true });
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

function writeJson(file, value) {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function transactionDir(transactionId) {
  return join(ARTIFACT_ROOT, "transactions", safeId(transactionId));
}

async function precheck(args, json) {
  const cwd = resolve(String(args.cwd || process.cwd()));
  const bug = String(args.bug || args._.join(" ")).trim();
  if (!bug) die("precheck requires --bug describing exactly one bug", 1, json);

  const transactionId = args["transaction-id"] || `${safeId(bug).slice(0, 40)}-${hashText(`${cwd}\n${bug}\n${Date.now()}\n${randomUUID()}`)}`;
  const run = createRun({ workflow: WORKFLOW, cwd, input: { action: "precheck", transactionId }, metadata: { transactionId, mode: "precheck" } });
  const dir = transactionDir(transactionId);
  mkdirSync(dir, { recursive: true });

  try {
    phaseStart(run, "precheck", { transactionId, cwd });
    const multiplicity = classifyBugCount(bug);
    const git = await gitInfo(cwd);
    const validationCommands = splitValidationCommands(args);
    const userTestCommand = args["user-test-command"] ? String(Array.isArray(args["user-test-command"]) ? args["user-test-command"].at(-1) : args["user-test-command"]).trim() : null;
    const maxRepairIterations = parseMaxRepairs(args["max-repairs"] ?? args.maxRepairIterations);
    const artifactPaths = buildArtifactPaths(dir);
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
        threadPhaseWorkflow: WORKFLOW,
        validationAssertionsMappedBeforeImplementation: true,
      },
    };
    const file = artifactPaths.precheck;
    writeJson(file, record);
    writeJson(artifactPaths.transactionPlan, plan);
    writeJson(artifactPaths.validationContract, contract);
    writeInitialJsonl(artifactPaths.allowlistDecisions, { type: "initial_allowlist", createdAt: record.createdAt, allowlist, justification: "Seeded during read-only precheck before implementation." });
    writeJson(artifactPaths.state, { schema: "pi-bug-solver-workflow/state/v1", transactionId, status: record.status, phase: "precheck", planPath: artifactPaths.transactionPlan, validationContractPath: artifactPaths.validationContract });
    phaseEvent(run, "precheck", { message: "Recorded read-only bug transaction precheck", transactionId, status: record.status, artifactPath: file });
    emitArtifact(run, { kind: "file", title: "bug-solver precheck", path: file });
    emitArtifact(run, { kind: "file", title: "bug-solver transaction plan", path: artifactPaths.transactionPlan });
    emitArtifact(run, { kind: "file", title: "bug-solver validation contract", path: artifactPaths.validationContract });
    phaseEnd(run, "precheck", multiplicity.likelyMultiple ? STATUSES.FAILED : STATUSES.SUCCESS, { status: record.status, planPath: artifactPaths.transactionPlan, validationContractPath: artifactPaths.validationContract });
    completeRun(run, multiplicity.likelyMultiple ? STATUSES.FAILED : STATUSES.SUCCESS, { transactionId, precheckPath: file, planPath: artifactPaths.transactionPlan, validationContractPath: artifactPaths.validationContract });
    const result = { ok: !multiplicity.likelyMultiple, action: "precheck", runId: run.runId, transactionId, precheckPath: file, planPath: artifactPaths.transactionPlan, validationContractPath: artifactPaths.validationContract, artifactDir: dir, status: record.status, confirmationRequired: true };
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
  if (!args.approved) die("solve requires --approved after explicit precheck confirmation", 1, json);
  if (!args["plan-path"]) die("solve requires --plan-path from precheck", 1, json);
  const planPath = resolve(String(args["plan-path"]));
  if (!existsSync(planPath)) die(`precheck plan not found: ${planPath}`, 1, json);
  const plan = readJson(planPath);
  const transactionId = plan.transactionId;
  const planBugDescription = plan.transaction?.bugDescription || plan.bugDescription || plan.bug || "";
  const currentMultiplicity = classifyBugCount(planBugDescription);
  const storedMultiplicity = plan.transaction?.multiplicity || plan.multiplicity || {};
  const multiplicity = currentMultiplicity.likelyMultiple ? currentMultiplicity : storedMultiplicity;
  const exactlyOneBug = currentMultiplicity.likelyMultiple ? false : (plan.transaction?.exactlyOneBug ?? !storedMultiplicity.likelyMultiple);
  const run = createRun({ workflow: WORKFLOW, cwd, input: { action: "solve", transactionId }, metadata: { transactionId, mode: "solve" } });
  try {
    phaseStart(run, "confirmation-gate", { planPath, approved: true });
    if (plan.status === "rejected_multi_bug" || multiplicity?.likelyMultiple || exactlyOneBug === false) throw new Error("Precheck classified this request as multiple bugs; split it before solving.");
    if (plan.editingAllowed === true) throw new Error("Refusing a plan that was not preserved as pre-implementation/editingAllowed=false.");
    if (!plan.validationContractPath && !plan.validation?.contractPath) throw new Error("Transaction plan is missing a durable validation contract path.");
    phaseEnd(run, "confirmation-gate", STATUSES.SUCCESS);
    phaseStart(run, "activation-scaffold", { transactionId });
    const activation = {
      schema: "pi-bug-solver-workflow/activation-scaffold/v1",
      transactionId,
      createdAt: new Date().toISOString(),
      status: "not_implemented_in_scaffold",
      planPath,
      validationContractPath: plan.validationContractPath || plan.validation?.contractPath,
      evidencePaths: plan.evidencePaths || {},
      message: "Persistent extension entrypoint is registered. Later milestones implement isolated worktree solving and bounded repairs.",
    };
    const file = join(transactionDir(transactionId), "activation-scaffold.json");
    writeJson(file, activation);
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

function status(args, json) {
  const transactionId = args["transaction-id"];
  const dir = transactionId ? transactionDir(transactionId) : join(ARTIFACT_ROOT, "transactions");
  const result = { ok: true, action: "status", artifactRoot: ARTIFACT_ROOT, path: dir, exists: existsSync(dir) };
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${dir}${result.exists ? "" : " (missing)"}`);
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
