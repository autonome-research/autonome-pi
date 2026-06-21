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
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = arg.slice(2, eq === -1 ? undefined : eq);
      if (eq !== -1) out[key] = arg.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
      else out[key] = true;
    } else out._.push(arg);
  }
  return out;
}

function usage() {
  return `Usage:\n  bug-solver-workflow precheck --bug <single bug> [--cwd <repo>] [--validation-command <cmd>] [--json]\n  bug-solver-workflow solve --plan-path <precheck.json> --approved [--cwd <repo>] [--json]\n  bug-solver-workflow status [--transaction-id <id>] [--json]\n\nThe solve action is intentionally approval-gated. Runtime artifacts are written outside the target repo under ${ARTIFACT_ROOT}.`;
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

function splitValidationCommands(args) {
  const value = args["validation-command"] || args.validationCommands;
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => String(item).split(/[;,]/)).map((s) => s.trim()).filter(Boolean);
}

function classifyBugCount(bug) {
  const text = String(bug || "");
  const separators = (text.match(/\b(and|also|plus)\b|;|\n\s*[-*]\s+/gi) || []).length;
  const enumerated = (text.match(/(?:^|\s)(?:\d+\.|\([a-z0-9]+\))/gi) || []).length;
  const likelyMultiple = separators >= 2 || enumerated >= 2;
  return { likelyMultiple, signals: { separators, enumerated } };
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
    const record = {
      schema: "pi-bug-solver-workflow/precheck/v1",
      transactionId,
      createdAt: new Date().toISOString(),
      cwd,
      bug,
      status: multiplicity.likelyMultiple ? "rejected_multi_bug" : "awaiting_confirmation",
      readOnly: true,
      confirmationRequired: true,
      approvalInstruction: "Review this precheck artifact. Then call solve with --approved and --plan-path only if it represents exactly one bug transaction.",
      git,
      validationCommands: splitValidationCommands(args),
      multiplicity,
      plannedSafety: {
        worktreeIsolation: true,
        immutableBaseCommit: git.head,
        externalArtifactsDir: dir,
        threadPhaseWorkflow: WORKFLOW,
      },
    };
    const file = join(dir, "precheck.json");
    writeJson(file, record);
    phaseEvent(run, "precheck", { message: "Recorded read-only bug transaction precheck", transactionId, status: record.status, artifactPath: file });
    emitArtifact(run, { kind: "file", title: "bug-solver precheck", path: file });
    phaseEnd(run, "precheck", multiplicity.likelyMultiple ? STATUSES.FAILED : STATUSES.SUCCESS, { status: record.status });
    completeRun(run, multiplicity.likelyMultiple ? STATUSES.FAILED : STATUSES.SUCCESS, { transactionId, precheckPath: file });
    const result = { ok: !multiplicity.likelyMultiple, action: "precheck", runId: run.runId, transactionId, precheckPath: file, artifactDir: dir, status: record.status, confirmationRequired: true };
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
  const run = createRun({ workflow: WORKFLOW, cwd, input: { action: "solve", transactionId: plan.transactionId }, metadata: { transactionId: plan.transactionId, mode: "solve" } });
  try {
    phaseStart(run, "confirmation-gate", { planPath, approved: true });
    if (plan.status === "rejected_multi_bug" || plan.multiplicity?.likelyMultiple) throw new Error("Precheck classified this request as multiple bugs; split it before solving.");
    phaseEnd(run, "confirmation-gate", STATUSES.SUCCESS);
    phaseStart(run, "activation-scaffold", { transactionId: plan.transactionId });
    const activation = {
      schema: "pi-bug-solver-workflow/activation-scaffold/v1",
      transactionId: plan.transactionId,
      createdAt: new Date().toISOString(),
      status: "not_implemented_in_scaffold",
      message: "Persistent extension entrypoint is registered. Later milestones implement isolated worktree solving and bounded repairs.",
    };
    const file = join(transactionDir(plan.transactionId), "activation-scaffold.json");
    writeJson(file, activation);
    emitArtifact(run, { kind: "file", title: "bug-solver activation scaffold", path: file });
    phaseEnd(run, "activation-scaffold", STATUSES.SUCCESS, { artifactPath: file });
    completeRun(run, STATUSES.SUCCESS, { transactionId: plan.transactionId, activationPath: file });
    const result = { ok: true, action: "solve", runId: run.runId, transactionId: plan.transactionId, activationPath: file };
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
