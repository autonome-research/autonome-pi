#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import {
  INDEX_FILE as THREAD_PHASE_INDEX_FILE,
  STATUSES,
  artifact as emitArtifact,
  completeRun,
  createRun,
  failRun,
  phaseEnd,
  phaseEvent,
  phaseStart,
} from "../../thread-phase-visualizer/lib/store.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_DIFF_LIMIT = Number.parseInt(process.env.PI_CODE_REVIEW_DIFF_LIMIT || "180000", 10);
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.PI_CODE_REVIEW_TIMEOUT_MS || `${10 * 60 * 1000}`, 10);
const DEFAULT_PI = existsSync(join(homedir(), ".npm-global", "bin", "pi"))
  ? join(homedir(), ".npm-global", "bin", "pi")
  : "pi";
const REVIEW_MARKER_START = "# >>> pi-code-review-workflow >>>";
const REVIEW_MARKER_END = "# <<< pi-code-review-workflow <<<";

const activeChildren = new Set();
let activeTpRun;

function requestCancel(signalName = "SIGTERM") {
  for (const child of activeChildren) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  if (activeTpRun) {
    completeRun(activeTpRun, STATUSES.CANCELLED, { cancelled: true, signal: signalName });
    activeTpRun = undefined;
  }
  setTimeout(() => process.exit(130), 50).unref();
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

function die(message, code = 1, json = false) {
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(message);
  process.exit(code);
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    maxBuffer: opts.maxBuffer ?? 50 * 1024 * 1024,
    env: opts.env || process.env,
  });
  if (result.error) throw result.error;
  if (opts.allowFailure) return result;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trimEnd();
}

function git(cwd, args, opts = {}) {
  return run("git", args, { cwd, ...opts });
}

function gitRoot(cwd) {
  return realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
}

function gitDir(root) {
  const dir = git(root, ["rev-parse", "--git-dir"]);
  return isAbsolute(dir) ? dir : resolve(root, dir);
}

function shortHash(root, ref = "HEAD") {
  return git(root, ["rev-parse", "--short", ref]);
}

function fullHash(root, ref = "HEAD") {
  return git(root, ["rev-parse", ref]);
}

function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false, bytes };
  let out = text.slice(0, maxBytes);
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return {
    text: `${out}\n\n[DIFF TRUNCATED: included ${Buffer.byteLength(out, "utf8")} of ${bytes} bytes. Use read/grep/find tools for omitted context.]`,
    truncated: true,
    bytes,
  };
}

function collectReviewInput(root, mode, ref, diffLimit) {
  const base = { root, mode, ref };
  if (mode === "staged") {
    const stat = git(root, ["diff", "--cached", "--stat", "--find-renames", "--find-copies"], { allowFailure: true }).stdout.trimEnd();
    const names = git(root, ["diff", "--cached", "--name-status", "--find-renames", "--find-copies"], { allowFailure: true }).stdout.trimEnd();
    const diffRaw = git(root, ["diff", "--cached", "--find-renames", "--find-copies", "--unified=80", "--no-ext-diff"], { allowFailure: true }).stdout;
    const diff = truncateUtf8(diffRaw, diffLimit);
    return { ...base, title: "staged changes", stat, names, diff };
  }

  if (mode === "working_tree") {
    const stat = git(root, ["diff", "--stat", "--find-renames", "--find-copies"], { allowFailure: true }).stdout.trimEnd();
    const names = git(root, ["diff", "--name-status", "--find-renames", "--find-copies"], { allowFailure: true }).stdout.trimEnd();
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard"], { allowFailure: true }).stdout.trimEnd();
    const diffRaw = git(root, ["diff", "--find-renames", "--find-copies", "--unified=80", "--no-ext-diff"], { allowFailure: true }).stdout;
    const diff = truncateUtf8(diffRaw, diffLimit);
    return { ...base, title: "working tree changes", stat, names: [names, untracked ? `Untracked:\n${untracked}` : ""].filter(Boolean).join("\n"), diff };
  }

  if (mode === "range") {
    const range = ref || "HEAD~1..HEAD";
    const stat = git(root, ["diff", "--stat", "--find-renames", "--find-copies", range], { allowFailure: true }).stdout.trimEnd();
    const names = git(root, ["diff", "--name-status", "--find-renames", "--find-copies", range], { allowFailure: true }).stdout.trimEnd();
    const log = git(root, ["log", "--oneline", "--decorate", "--max-count=50", range], { allowFailure: true }).stdout.trimEnd();
    const diffRaw = git(root, ["diff", "--find-renames", "--find-copies", "--unified=80", "--no-ext-diff", range], { allowFailure: true }).stdout;
    const diff = truncateUtf8(diffRaw, diffLimit);
    return { ...base, title: `range ${range}`, range, log, stat, names, diff };
  }

  const commitRef = ref || "HEAD";
  const commit = fullHash(root, commitRef);
  const meta = git(root, ["show", "-s", "--format=%H%n%an <%ae>%n%ad%n%n%B", commitRef], { allowFailure: true }).stdout.trimEnd();
  const stat = git(root, ["show", "--format=", "--stat", "--find-renames", "--find-copies", commitRef], { allowFailure: true }).stdout.trimEnd();
  const names = git(root, ["show", "--format=", "--name-status", "--find-renames", "--find-copies", commitRef], { allowFailure: true }).stdout.trimEnd();
  const diffRaw = git(root, ["show", "--format=", "--find-renames", "--find-copies", "--unified=80", "--no-ext-diff", commitRef], { allowFailure: true }).stdout;
  const diff = truncateUtf8(diffRaw, diffLimit);
  return { ...base, title: `commit ${shortHash(root, commitRef)}`, commit, meta, stat, names, diff };
}

function reviewSystemPrompt() {
  return [
    "You are a senior code reviewer focused on bug-finding and practical best practices.",
    "Review the supplied git diff. Be specific and actionable.",
    "Prioritize correctness bugs, edge cases, security issues, data loss, concurrency, resource leaks, API misuse, tests, and maintainability.",
    "Use read/grep/find/ls only when the diff references code whose surrounding context is needed. Do not modify files.",
    "Do not invent findings: if the diff is insufficient, say what context you checked or what remains uncertain.",
    "Output Markdown with these sections:",
    "1. Verdict: one of ✅ low risk / ⚠️ needs attention / ❌ likely bug.",
    "2. Critical findings: bullet list with file/path and why it matters, or 'None found'.",
    "3. Best-practice improvements: concise bullets, or 'None'.",
    "4. Suggested tests: concise bullets.",
    "5. Follow-up patch plan: numbered minimal steps if issues exist.",
  ].join("\n");
}

function buildReviewRequest(input) {
  return `# Code review request\n\nRepository: ${input.root}\nTarget: ${input.title}\nMode: ${input.mode}\n\n${input.meta ? `## Commit metadata\n\n\`\`\`\n${input.meta}\n\`\`\`\n\n` : ""}${input.log ? `## Commit log\n\n\`\`\`\n${input.log}\n\`\`\`\n\n` : ""}## Changed files\n\n\`\`\`\n${input.names || "(none)"}\n\`\`\`\n\n## Diff stat\n\n\`\`\`\n${input.stat || "(none)"}\n\`\`\`\n\n## Diff\n\n\`\`\`diff\n${input.diff.text || "(empty diff)"}\n\`\`\`\n\n${input.diff.truncated ? "> The diff was truncated. Use read/grep/find tools to inspect omitted files before making high-confidence claims.\n" : ""}`;
}

function parsePiJsonLines(stdout) {
  const messages = [];
  const toolResults = [];
  let stderrEvent = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "message_end" && event.message) messages.push(event.message);
    if (event.type === "tool_result_end" && event.message) toolResults.push(event.message);
    if (event.type === "error" && event.error) stderrEvent += `${JSON.stringify(event.error)}\n`;
  }
  let text = "";
  let model;
  let stopReason;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    model = msg.model || model;
    stopReason = msg.stopReason || stopReason;
    for (const part of msg.content || []) {
      if (part.type === "text") {
        text = part.text;
        break;
      }
    }
    if (text) break;
  }
  return { text, messages, toolResults, model, stopReason, stderrEvent };
}

async function runPiReview(root, request, options) {
  const workDir = join(tmpdir(), `pi-code-review-${process.pid}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const systemPath = join(workDir, "system.md");
  const requestPath = join(workDir, "request.md");
  writeFileSync(systemPath, reviewSystemPrompt(), "utf8");
  writeFileSync(requestPath, request, "utf8");

  const piBin = options.piBin || process.env.PI_CODE_REVIEW_PI_BIN || DEFAULT_PI;
  const args = [
    "--mode", "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--tools", "read,grep,find,ls",
    "--append-system-prompt", systemPath,
    "-p",
    `@${requestPath}`,
  ];
  if (options.model) args.unshift("--model", options.model);

  return await new Promise((resolve) => {
    const proc = spawn(piBin, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    activeChildren.add(proc);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    proc.stdout.on("data", (d) => stdout += d.toString());
    proc.stderr.on("data", (d) => stderr += d.toString());
    proc.on("error", (error) => {
      activeChildren.delete(proc);
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, stdout, stderr, timedOut });
    });
    proc.on("close", (code) => {
      activeChildren.delete(proc);
      clearTimeout(timer);
      const parsed = parsePiJsonLines(stdout);
      if (timedOut) resolve({ ok: false, error: "review timed out", code, stdout, stderr, ...parsed, timedOut });
      else if (code !== 0) resolve({ ok: false, error: stderr || parsed.stderrEvent || `pi exited ${code}`, code, stdout, stderr, ...parsed });
      else resolve({ ok: true, code, stdout, stderr, ...parsed });
    });
  });
}

function reportPathFor(root, mode, ref) {
  const dir = join(gitDir(root), "pi-code-reviews");
  mkdirSync(dir, { recursive: true });
  let name;
  if (mode === "last_commit") {
    const commit = fullHash(root, ref || "HEAD");
    name = `${commit.slice(0, 12)}.md`;
  } else {
    const safeRef = (ref || mode).replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 60);
    name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeRef}.md`;
  }
  return join(dir, name);
}

function summarize(report) {
  const lines = report.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const verdict = lines.find((l) => /^#{1,3}\s*Verdict/i.test(l) || /^Verdict\s*:/i.test(l)) || lines[0] || "Review complete";
  const finding = lines.find((l) => /^[-*]\s+/.test(l) && !/none found|none\.?$/i.test(l));
  return finding ? `${verdict}\n${finding}` : verdict;
}

async function reviewCommand(opts) {
  const root = gitRoot(resolve(String(opts.cwd || process.cwd())));
  const mode = String(opts.mode || "last_commit");
  const ref = opts.ref ? String(opts.ref) : undefined;
  const commit = mode === "last_commit" ? fullHash(root, ref || "HEAD") : undefined;
  const tpRun = createRun({
    workflow: "code-review",
    cwd: root,
    trigger: { kind: process.env.PI_CODE_REVIEW_BACKGROUND ? "post-commit" : "manual", mode, ref: ref || "HEAD" },
    input: { mode, ref: ref || "HEAD", commit },
    metadata: { commit, pid: process.pid, cancellable: true, cancelSignal: "SIGTERM" },
  });
  activeTpRun = tpRun;

  try {
    const diffLimit = opts.diffLimit ? Number.parseInt(String(opts.diffLimit), 10) : DEFAULT_DIFF_LIMIT;
    phaseStart(tpRun, "collect-diff", { mode, ref: ref || "HEAD" });
    const input = collectReviewInput(root, mode, ref, diffLimit);
    phaseEnd(tpRun, "collect-diff", STATUSES.SUCCESS, {
      title: input.title,
      changedFiles: input.names,
      diffBytes: input.diff.bytes,
      diffTruncated: input.diff.truncated,
    });

    const request = buildReviewRequest(input);
    phaseStart(tpRun, "review", { model: opts.model ? String(opts.model) : undefined });
    const result = await runPiReview(root, request, {
      model: opts.model ? String(opts.model) : undefined,
      timeoutMs: opts.timeout ? Number.parseInt(String(opts.timeout), 10) : DEFAULT_TIMEOUT_MS,
      piBin: opts.piBin ? String(opts.piBin) : undefined,
    });
    phaseEvent(tpRun, "review", { model: result.model, stopReason: result.stopReason, ok: result.ok });
    phaseEnd(tpRun, "review", result.ok && result.text ? STATUSES.SUCCESS : STATUSES.FAILED, {
      model: result.model,
      stopReason: result.stopReason,
      error: result.ok ? undefined : result.error,
    });

    const report = result.ok && result.text
      ? result.text
      : `# Code review failed\n\n${result.error || "No response text from pi."}\n\n## stderr\n\n\`\`\`\n${result.stderr || ""}\n\`\`\``;
    phaseStart(tpRun, "write-report");
    const reportPath = reportPathFor(root, mode, ref);
    writeFileSync(reportPath, report, "utf8");
    emitArtifact(tpRun, { kind: "markdown", title: "Code review report", path: reportPath });
    phaseEnd(tpRun, "write-report", STATUSES.SUCCESS, { reportPath });

    const event = {
      ok: Boolean(result.ok && result.text),
      repo: root,
      mode,
      ref: ref || "HEAD",
      commit,
      reportPath,
      summary: summarize(report),
      model: result.model,
      stopReason: result.stopReason,
      error: result.ok ? undefined : result.error,
      runId: tpRun.runId,
      threadPhaseIndexFile: THREAD_PHASE_INDEX_FILE,
    };
    completeRun(tpRun, event.ok ? STATUSES.SUCCESS : STATUSES.FAILED, event);
    activeTpRun = undefined;
    if (opts.json) console.log(JSON.stringify(event, null, 2));
    else console.log(`Code review ${event.ok ? "complete" : "failed"}: ${reportPath}\n\n${report}`);
    return event.ok ? 0 : 2;
  } catch (error) {
    if (activeTpRun === tpRun) {
      failRun(tpRun, error);
      activeTpRun = undefined;
    }
    throw error;
  }
}

function installHookCommand(opts) {
  const root = gitRoot(resolve(String(opts.cwd || process.cwd())));
  const hooksDir = join(gitDir(root), "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "post-commit");
  const nodePath = process.execPath;
  const block = `${REVIEW_MARKER_START}\n# Run an asynchronous pi code review after every commit.\nif [ -z "\${PI_CODE_REVIEW_DISABLE:-}" ]; then\n  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"\n  "${nodePath}" "${SCRIPT_PATH}" review --cwd "$REPO_ROOT" --mode last_commit --ref HEAD --background >/dev/null 2>&1 || true\nfi\n${REVIEW_MARKER_END}\n`;
  let current = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : "#!/bin/sh\n";
  if (!current.startsWith("#!")) current = `#!/bin/sh\n${current}`;
  const alreadyInstalled = current.includes(REVIEW_MARKER_START);
  if (!alreadyInstalled) {
    writeFileSync(hookPath, `${current.trimEnd()}\n\n${block}`, "utf8");
    chmodSync(hookPath, (existsSync(hookPath) ? statSync(hookPath).mode : 0o755) | 0o755);
  }
  const result = { ok: true, repo: root, hookPath, alreadyInstalled, threadPhaseIndexFile: THREAD_PHASE_INDEX_FILE };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${alreadyInstalled ? "Already installed" : "Installed"} post-commit code review hook: ${hookPath}`);
  return 0;
}

function statusCommand(opts) {
  const root = gitRoot(resolve(String(opts.cwd || process.cwd())));
  const hookPath = join(gitDir(root), "hooks", "post-commit");
  const installed = existsSync(hookPath) && readFileSync(hookPath, "utf8").includes(REVIEW_MARKER_START);
  const reviewsDir = join(gitDir(root), "pi-code-reviews");
  const result = { ok: true, repo: root, hookPath, installed, reviewsDir, threadPhaseIndexFile: THREAD_PHASE_INDEX_FILE };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result, null, 2));
  return 0;
}

function maybeBackground(argv, opts) {
  if (!opts.background) return false;
  const nextArgs = argv.filter((arg) => arg !== "--background");
  const child = spawn(process.execPath, [SCRIPT_PATH, ...nextArgs], {
    cwd: opts.cwd ? resolve(String(opts.cwd)) : process.cwd(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PI_CODE_REVIEW_BACKGROUND: "1" },
  });
  child.unref();
  if (opts.json) console.log(JSON.stringify({ ok: true, background: true, pid: child.pid }));
  return true;
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const opts = parseArgs(rawArgv);
  const cmd = opts._[0] || "review";
  if (["-h", "--help", "help"].includes(cmd)) {
    console.log(`Usage:\n  code-review-workflow.mjs review [--cwd REPO] [--mode last_commit|staged|working_tree|range] [--ref REF_OR_RANGE] [--json] [--background]\n  code-review-workflow.mjs install-hook [--cwd REPO] [--json]\n  code-review-workflow.mjs status [--cwd REPO] [--json]\n\nEnvironment:\n  PI_CODE_REVIEW_PI_BIN     Path to pi binary\n  PI_CODE_REVIEW_DIFF_LIMIT Max diff bytes to place in prompt (default ${DEFAULT_DIFF_LIMIT})\n  PI_CODE_REVIEW_DISABLE=1  Disable installed git hook`);
    return;
  }
  try {
    if (cmd === "review" && maybeBackground(rawArgv, opts)) return;
    let code = 0;
    if (cmd === "review") code = await reviewCommand(opts);
    else if (cmd === "install-hook") code = installHookCommand(opts);
    else if (cmd === "status") code = statusCommand(opts);
    else die(`Unknown command: ${cmd}`, 1, Boolean(opts.json));
    process.exitCode = code;
  } catch (error) {
    die(error?.stack || error?.message || String(error), 1, Boolean(opts.json));
  }
}

await main();
