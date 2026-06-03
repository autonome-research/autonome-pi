#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import {
  ARTIFACTS_DIR,
  STATUSES,
  artifact,
  completeRun,
  createRun,
  failRun,
  readCancellation,
  wrapPhases,
} from "../../thread-phase-visualizer/lib/store.mjs";

const DEFAULT_PI = existsSync(join(homedir(), ".npm-global", "bin", "pi"))
  ? join(homedir(), ".npm-global", "bin", "pi")
  : "pi";

const DEFAULT_DIR_CANDIDATES = [
  "src", "app", "lib", "packages", "tests", "test", "docs", "scripts", "bin",
  "server", "client", "components", "api",
];

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

const { PipelineCache, requireCtx, runPipeline } = await loadThreadPhaseCore();

const activeChildren = new Set();
let activeVisualizerRun;
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

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason || "cancelled"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal.reason || "cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

async function runPiExplorer({ cwd, dir, model, timeoutMs, signal }) {
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
    "--mode", "json", "--no-session", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--tools", "read,grep,find,ls", "-p", prompt,
  ];
  if (model) args.unshift("--model", model);

  return await new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, text: "", aborted: true, error: String(signal.reason || "cancelled"), stdout: "", stderr: "" });
      return;
    }
    const proc = spawn(process.env.PI_CODEBASE_EXPLORATION_PI_BIN || DEFAULT_PI, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32",
    });
    activeChildren.add(proc);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const terminate = () => {
      terminateChild(proc, "SIGTERM");
      setTimeout(() => terminateChild(proc, "SIGKILL"), 5000).unref();
    };
    const onAbort = () => { aborted = true; terminate(); };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    proc.stdout.on("data", (data) => stdout += data.toString());
    proc.stderr.on("data", (data) => stderr += data.toString());
    proc.on("error", (error) => {
      activeChildren.delete(proc);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, text: "", error: error.message, stdout, stderr, timedOut, aborted });
    });
    proc.on("close", (code) => {
      activeChildren.delete(proc);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const parsed = parsePiJsonLines(stdout);
      resolve({ ok: code === 0 && Boolean(parsed.text) && !aborted, code, stdout, stderr, timedOut, aborted, ...parsed, error: aborted ? String(signal?.reason || "cancelled") : code === 0 ? undefined : stderr || `pi exited ${code}` });
    });
  });
}

async function exploreMock({ cwd, dir, delayMs, signal }) {
  await sleep(delayMs, signal);
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

const discoverSubdirectories = {
  name: "discover-subdirectories",
  async *run(ctx) {
    const explicitDirs = splitList(ctx.args.dirs);
    const dirs = (explicitDirs.length ? explicitDirs : listDefaultDirs(ctx.cwd, ctx.maxDirs))
      .filter((dir) => existsSync(join(ctx.cwd, dir)) && statSync(join(ctx.cwd, dir)).isDirectory())
      .slice(0, ctx.maxDirs);
    ctx.dirs = dirs;
    yield { type: "data", kind: "data", key: "dirs", value: dirs, message: `Selected ${dirs.length} subdirectories` };
    if (dirs.length === 0) throw new Error(`No matching subdirectories found in ${ctx.cwd}`);
  },
};

const exploreSubdirectories = {
  name: "explore-subdirectories",
  async *run(ctx) {
    const dirs = requireCtx(ctx, "dirs", "explore-subdirectories");
    mkdirSync(ctx.artifactsDir, { recursive: true });
    yield { type: "fanout", kind: "fanout_start", total: dirs.length, label: "subdirectories" };

    let completed = 0;
    let failed = 0;
    const queue = [];
    const push = (event) => queue.push(event);

    const worker = mapWithConcurrency(dirs, ctx.concurrency, async (dir, index) => {
      const itemId = dir;
      push({ type: "fanout", kind: "fanout_item_start", itemId, label: dir, index, total: dirs.length, message: `Exploring ${dir}` });
      const startedAt = Date.now();
      if (ctx.signal?.aborted) throw abortError(ctx.signal.reason || "cancelled");
      const result = ctx.agent === "pi"
        ? await runPiExplorer({ cwd: ctx.cwd, dir, model: ctx.model, timeoutMs: ctx.timeoutMs, signal: ctx.signal })
        : await exploreMock({ cwd: ctx.cwd, dir, delayMs: ctx.delayMs, signal: ctx.signal });
      if (result.aborted) throw abortError(result.error || "cancelled");
      const durationMs = Date.now() - startedAt;
      const reportPath = join(ctx.artifactsDir, `${safeName(dir)}.md`);
      const report = result.ok
        ? result.text
        : `# ${dir} exploration failed\n\n${result.error || "Unknown error"}\n\n## stderr\n\n\`\`\`\n${result.stderr || ""}\n\`\`\``;
      writeFileSync(reportPath, report, "utf8");
      artifact(ctx.visualizerRun, { kind: "markdown", title: `Exploration: ${dir}`, path: reportPath, metadata: { dir, agent: result.model || ctx.agent } });
      if (result.ok) completed++; else failed++;
      push({
        type: "fanout",
        kind: "fanout_item_end",
        itemId,
        label: dir,
        index,
        status: result.ok ? STATUSES.SUCCESS : STATUSES.FAILED,
        message: result.ok ? `Explored ${dir}` : `Failed ${dir}`,
        error: result.ok ? undefined : result.error,
        durationMs,
      });
      push({ type: "progress", kind: "progress", completed, total: dirs.length, message: `${completed}/${dirs.length} explored` });
      return { dir, ok: result.ok, reportPath, text: report, model: result.model, durationMs, error: result.error };
    });

    while (true) {
      while (queue.length) yield queue.shift();
      const done = await Promise.race([worker.then(() => true), sleep(100).then(() => false)]);
      if (done) break;
    }
    ctx.results = await worker;
    ctx.completed = completed;
    ctx.failed = failed;
    while (queue.length) yield queue.shift();
    if (failed > 0) throw new Error(`${failed}/${dirs.length} subdirectory explorations failed`);
  },
};

const synthesizeMap = {
  name: "synthesize-map",
  async *run(ctx) {
    const dirs = requireCtx(ctx, "dirs", "synthesize-map");
    const results = requireCtx(ctx, "results", "synthesize-map");
    const summaryPath = join(ctx.artifactsDir, "codebase-exploration-summary.md");
    const summary = [
      "# Codebase exploration summary",
      "",
      `Repository: \`${ctx.cwd}\``,
      `Agent: \`${ctx.agent}\``,
      `Subdirectories: ${dirs.map((dir) => `\`${dir}\``).join(", ")}`,
      "",
      "## Subdirectory reports",
      ...results.map((result) => [`### ${result.ok ? "✓" : "✗"} ${result.dir}`, "", `Report: \`${relative(ctx.cwd, result.reportPath)}\``, "", result.text.split(/\r?\n/).slice(0, 20).join("\n")].join("\n")),
    ].join("\n\n");
    writeFileSync(summaryPath, summary, "utf8");
    ctx.summaryPath = summaryPath;
    artifact(ctx.visualizerRun, { kind: "markdown", title: "Codebase exploration summary", path: summaryPath, metadata: { dirs, agent: ctx.agent } });
    yield { type: "data", kind: "data", key: "summaryPath", value: summaryPath, message: "Wrote codebase exploration summary" };
  },
};

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
  if (process.env.PI_CODEBASE_EXPLORATION_BACKGROUND) return false;
  if (!isTruthyFlag(opts.background)) return false;
  const nextArgs = stripBackgroundArgs(rawArgv);
  const child = spawn(process.execPath, [process.argv[1], ...nextArgs], {
    cwd: opts.cwd ? resolve(String(opts.cwd)) : process.cwd(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PI_CODEBASE_EXPLORATION_BACKGROUND: "1" },
  });
  child.unref();
  console.log(JSON.stringify({ ok: true, background: true, pid: child.pid }, null, 2));
  return true;
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const args = parseArgs(rawArgv);
  if (maybeBackground(rawArgv, args)) return;
  if (args.help || args.h) {
    console.log(`Usage: codebase-exploration-workflow.mjs --cwd REPO [--dirs src,tests,docs] [--agent mock|pi] [--concurrency 3] [--model MODEL]\n\nDefault agent is pi (real read-only Pi subagents). Use --agent mock only for UI testing.`);
    return;
  }

  const cwd = resolve(String(args.cwd || process.cwd()));
  const agent = String(args.agent || "pi");
  const concurrency = Number.parseInt(String(args.concurrency || "3"), 10);
  const maxDirs = Number.parseInt(String(args.maxDirs || "8"), 10);
  const delayMs = Number.parseInt(String(args.delay || "750"), 10);
  const timeoutMs = Number.parseInt(String(args.timeout || `${10 * 60 * 1000}`), 10);

  const visualizerRun = createRun({
    workflow: "codebase-exploration",
    cwd,
    trigger: { kind: process.env.PI_CODEBASE_EXPLORATION_BACKGROUND ? "background" : "manual", agent, concurrency },
    input: { dirs: splitList(args.dirs), agent, concurrency },
    metadata: { pid: process.pid, cancellable: true, cancelSignal: "SIGTERM", sessionId: args["session-id"], sessionFile: args["session-file"] },
    message: "codebase-exploration started",
  });
  activeVisualizerRun = visualizerRun;
  const controller = new AbortController();
  activeAbortController = controller;
  const stopWatchingCancellation = watchCancellation(visualizerRun, controller);

  const ctx = {
    cache: new PipelineCache(),
    visualizerRun,
    cwd,
    args,
    agent,
    concurrency,
    maxDirs,
    delayMs,
    timeoutMs,
    model: args.model ? String(args.model) : undefined,
    artifactsDir: join(ARTIFACTS_DIR, visualizerRun.runId),
    signal: controller.signal,
  };

  try {
    const phases = wrapPhases([discoverSubdirectories, exploreSubdirectories, synthesizeMap], visualizerRun);
    for await (const _event of runPipeline(phases, ctx, { signal: controller.signal })) {
      // Events are mirrored to the visualizer by wrapPhases.
    }
    completeRun(visualizerRun, STATUSES.SUCCESS, {
      ok: true,
      completed: ctx.completed ?? ctx.dirs?.length ?? 0,
      failed: ctx.failed ?? 0,
      total: ctx.dirs?.length ?? 0,
      summaryPath: ctx.summaryPath,
    });
    activeVisualizerRun = undefined;
    console.log(JSON.stringify({ ok: true, runId: visualizerRun.runId, workflow: visualizerRun.workflow, cwd, dirs: ctx.dirs, agent, summaryPath: ctx.summaryPath }, null, 2));
  } catch (error) {
    if (cancellationRequested || isAbortError(error) || controller.signal.aborted) {
      if (activeVisualizerRun === visualizerRun) completeRun(visualizerRun, STATUSES.CANCELLED, { cancelled: true, reason: controller.signal.reason || error?.message, completed: ctx.completed, failed: ctx.failed, total: ctx.dirs?.length, summaryPath: ctx.summaryPath });
      console.log(JSON.stringify({ ok: false, cancelled: true, runId: visualizerRun.runId, workflow: visualizerRun.workflow, cwd }, null, 2));
      process.exitCode = 130;
    } else {
      failRun(visualizerRun, error, { completed: ctx.completed, failed: ctx.failed, total: ctx.dirs?.length, summaryPath: ctx.summaryPath });
      console.log(JSON.stringify({ ok: false, runId: visualizerRun.runId, workflow: visualizerRun.workflow, cwd, error: error.message }, null, 2));
      process.exitCode = 1;
    }
    activeVisualizerRun = undefined;
  } finally {
    stopWatchingCancellation();
    if (activeAbortController === controller) activeAbortController = undefined;
  }
}

await main();
