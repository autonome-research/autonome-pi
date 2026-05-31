#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
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
} from "../lib/store.mjs";

const DEFAULT_PI = existsSync(join(homedir(), ".npm-global", "bin", "pi"))
  ? join(homedir(), ".npm-global", "bin", "pi")
  : "pi";

const DEFAULT_DIR_CANDIDATES = [
  "src",
  "app",
  "lib",
  "packages",
  "tests",
  "test",
  "docs",
  "scripts",
  "bin",
  "server",
  "client",
  "components",
  "api",
];

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

function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitList);
  return String(value).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

function listDefaultDirs(cwd, maxDirs) {
  const chosen = DEFAULT_DIR_CANDIDATES.filter((dir) => existsSync(join(cwd, dir)) && statSync(join(cwd, dir)).isDirectory());
  if (chosen.length > 0) return chosen.slice(0, maxDirs);
  return readdirSync(cwd)
    .filter((name) => !name.startsWith(".") && !["node_modules", "dist", "build", "target", "vendor"].includes(name))
    .filter((name) => {
      try { return statSync(join(cwd, name)).isDirectory(); }
      catch { return false; }
    })
    .slice(0, maxDirs);
}

function safeName(dir) {
  return dir.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "root";
}

function countFiles(dir) {
  let files = 0;
  let dirs = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "target", "vendor"].includes(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        dirs++;
        if (dirs < 250) stack.push(full);
      } else if (entry.isFile()) {
        files++;
      }
      if (files > 2000) return { files, dirs, capped: true };
    }
  }
  return { files, dirs, capped: false };
}

function parsePiJsonLines(stdout) {
  const messages = [];
  let text = "";
  let model;
  let stopReason;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "message_end" || !event.message) continue;
    messages.push(event.message);
    const msg = event.message;
    if (msg.role === "assistant") {
      model = msg.model || model;
      stopReason = msg.stopReason || stopReason;
      for (const part of msg.content || []) if (part.type === "text") text = part.text;
    }
  }
  return { text, messages, model, stopReason };
}

async function runPiExplorer({ cwd, dir, model, timeoutMs }) {
  const prompt = [
    `Explore the subdirectory \`${dir}\` in this repository.`,
    "Use read/grep/find/ls as needed, but do not modify files.",
    "Produce a concise markdown report with:",
    "1. Purpose and responsibilities of this area.",
    "2. Key files/modules.",
    "3. Important dependencies or entrypoints.",
    "4. Risks, confusing spots, or likely follow-up questions.",
    "5. Suggested next exploration targets.",
  ].join("\n");
  const args = [
    "--mode", "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--tools", "read,grep,find,ls",
    "-p",
    prompt,
  ];
  if (model) args.unshift("--model", model);

  return await new Promise((resolve) => {
    const proc = spawn(process.env.PI_CODEBASE_EXPLORATION_PI_BIN || DEFAULT_PI, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    proc.stdout.on("data", (data) => stdout += data.toString());
    proc.stderr.on("data", (data) => stderr += data.toString());
    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, text: "", error: error.message, stdout, stderr, timedOut });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const parsed = parsePiJsonLines(stdout);
      resolve({ ok: code === 0 && Boolean(parsed.text), code, stdout, stderr, timedOut, ...parsed, error: code === 0 ? undefined : stderr || `pi exited ${code}` });
    });
  });
}

async function exploreMock({ cwd, dir, delayMs }) {
  await sleep(delayMs);
  const absolute = join(cwd, dir);
  const counts = countFiles(absolute);
  const entries = readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .slice(0, 12)
    .map((entry) => `${entry.isDirectory() ? "dir" : "file"}: ${entry.name}`);
  return {
    ok: true,
    text: [
      `# ${dir} exploration`,
      "",
      `Mock exploration of \`${dir}\` for UI testing.`,
      "",
      `- Files counted: ${counts.files}${counts.capped ? "+" : ""}`,
      `- Directories counted: ${counts.dirs}`,
      "",
      "## Sample entries",
      ...entries.map((entry) => `- ${entry}`),
      "",
      "## Risks / follow-up",
      "- This is mock output; use `--agent pi` for real analysis.",
    ].join("\n"),
    model: "mock",
  };
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(`Usage: codebase-exploration-workflow.mjs --cwd REPO [--dirs src,tests,docs] [--agent mock|pi] [--concurrency 3] [--model MODEL]\n\nDefault agent is mock. Use --agent pi for real read-only Pi subagents.`);
    return;
  }

  const cwd = resolve(String(args.cwd || process.cwd()));
  const agent = String(args.agent || "mock");
  const concurrency = Number.parseInt(String(args.concurrency || "3"), 10);
  const maxDirs = Number.parseInt(String(args.maxDirs || "8"), 10);
  const delayMs = Number.parseInt(String(args.delay || "750"), 10);
  const timeoutMs = Number.parseInt(String(args.timeout || `${10 * 60 * 1000}`), 10);
  const explicitDirs = splitList(args.dirs);
  const dirs = (explicitDirs.length ? explicitDirs : listDefaultDirs(cwd, maxDirs))
    .filter((dir) => existsSync(join(cwd, dir)) && statSync(join(cwd, dir)).isDirectory())
    .slice(0, maxDirs);

  const run = createRun({
    workflow: "codebase-exploration",
    cwd,
    trigger: { kind: "manual", agent, concurrency },
    input: { dirs, agent, concurrency },
    message: "codebase-exploration started",
  });

  try {
    phaseStart(run, "discover-subdirectories", { explicitDirs, maxDirs });
    phaseEvent(run, "discover-subdirectories", { kind: "data", key: "dirs", value: dirs, message: `Selected ${dirs.length} subdirectories` });
    phaseEnd(run, "discover-subdirectories", STATUSES.SUCCESS, { dirs });

    if (dirs.length === 0) throw new Error(`No matching subdirectories found in ${cwd}`);

    const artifactsDir = join(ARTIFACTS_DIR, run.runId);
    mkdirSync(artifactsDir, { recursive: true });

    phaseStart(run, "explore-subdirectories", { dirs, agent, concurrency });
    phaseEvent(run, "explore-subdirectories", { kind: "fanout_start", total: dirs.length, label: "subdirectories" });
    let completed = 0;
    let failed = 0;

    const results = await mapWithConcurrency(dirs, concurrency, async (dir, index) => {
      const itemId = dir;
      phaseEvent(run, "explore-subdirectories", { kind: "fanout_item_start", itemId, label: dir, index, total: dirs.length, message: `Exploring ${dir}` });
      const startedAt = Date.now();
      const result = agent === "pi"
        ? await runPiExplorer({ cwd, dir, model: args.model ? String(args.model) : undefined, timeoutMs })
        : await exploreMock({ cwd, dir, delayMs });
      const durationMs = Date.now() - startedAt;
      const reportPath = join(artifactsDir, `${safeName(dir)}.md`);
      const report = result.ok
        ? result.text
        : `# ${dir} exploration failed\n\n${result.error || "Unknown error"}\n\n## stderr\n\n\`\`\`\n${result.stderr || ""}\n\`\`\``;
      writeFileSync(reportPath, report, "utf8");
      artifact(run, { kind: "markdown", title: `Exploration: ${dir}`, path: reportPath, metadata: { dir, agent: result.model || agent } });
      if (result.ok) completed++; else failed++;
      phaseEvent(run, "explore-subdirectories", {
        kind: "fanout_item_end",
        itemId,
        label: dir,
        index,
        status: result.ok ? STATUSES.SUCCESS : STATUSES.FAILED,
        message: result.ok ? `Explored ${dir}` : `Failed ${dir}`,
        error: result.ok ? undefined : result.error,
        durationMs,
      });
      phaseEvent(run, "explore-subdirectories", { kind: "progress", completed, total: dirs.length, message: `${completed}/${dirs.length} explored` });
      return { dir, ok: result.ok, reportPath, text: report, model: result.model, durationMs, error: result.error };
    });

    phaseEnd(run, "explore-subdirectories", failed > 0 ? STATUSES.FAILED : STATUSES.SUCCESS, { completed, failed, total: dirs.length });

    phaseStart(run, "synthesize-map");
    const summaryPath = join(artifactsDir, "codebase-exploration-summary.md");
    const summary = [
      "# Codebase exploration summary",
      "",
      `Repository: \`${cwd}\``,
      `Agent: \`${agent}\``,
      `Subdirectories: ${dirs.map((dir) => `\`${dir}\``).join(", ")}`,
      "",
      "## Subdirectory reports",
      ...results.map((result) => [`### ${result.ok ? "✓" : "✗"} ${result.dir}`, "", `Report: \`${relative(cwd, result.reportPath)}\``, "", result.text.split(/\r?\n/).slice(0, 20).join("\n")].join("\n")),
    ].join("\n\n");
    writeFileSync(summaryPath, summary, "utf8");
    artifact(run, { kind: "markdown", title: "Codebase exploration summary", path: summaryPath, metadata: { dirs, agent } });
    phaseEnd(run, "synthesize-map", STATUSES.SUCCESS, { summaryPath });

    const status = failed > 0 ? STATUSES.FAILED : STATUSES.SUCCESS;
    completeRun(run, status, { ok: failed === 0, completed, failed, total: dirs.length, summaryPath });
    console.log(JSON.stringify({ ok: failed === 0, runId: run.runId, workflow: run.workflow, cwd, dirs, agent, summaryPath }, null, 2));
    process.exitCode = failed > 0 ? 2 : 0;
  } catch (error) {
    failRun(run, error);
    console.log(JSON.stringify({ ok: false, runId: run.runId, workflow: run.workflow, cwd, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}

await main();
