import { basename } from "node:path";
import {
  createStatusBridgeReader,
  statusBridgeRootFromEnv,
} from "../../thread-phase-visualizer/lib/status-bridge.mjs";

export const ACTIVE_SYMBOL = "\u2699\uFE0E";
export const ATTENTION_SYMBOL = "\u238A";
export const COMPLETED_SYMBOL = "\u2318";
export const TERMINAL_TITLE_POLL_MS = 5_000;
export const TERMINAL_TITLE_HANDOFF_MS = 100;
export const TERMINAL_TITLE_COMPONENT_MAX_BYTES = 96;
export const TERMINAL_TITLE_MAX_BYTES = 240;

const COUNT_KEYS = [
  "running",
  "unknownActive",
  "successRecent",
  "failureRecent",
  "cancelledRecent",
  "unknownTerminalRecent",
];
const ISSUE_KEYS = ["unknownActive", "failureRecent", "cancelledRecent", "unknownTerminalRecent"];
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncateGraphemesToBytes(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const ellipsis = "…";
  const contentLimit = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, "utf8"));
  let output = "";
  let bytes = 0;
  for (const { segment } of segmenter.segment(value)) {
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (bytes + segmentBytes > contentLimit) break;
    output += segment;
    bytes += segmentBytes;
  }
  return `${output}${ellipsis}`;
}

/** Remove terminal controls and bound one untrusted stock-title component. */
export function sanitizeTitleComponent(value, maxBytes = TERMINAL_TITLE_COMPONENT_MAX_BYTES) {
  const safe = String(value ?? "").replace(CONTROL_CHARACTERS, " ");
  return truncateGraphemesToBytes(safe, maxBytes);
}

function validCounts(counts) {
  return Boolean(counts && typeof counts === "object" && !Array.isArray(counts)
    && COUNT_KEYS.every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0));
}

/** Project only validated aggregate bridge counters into the four title states. */
export function projectTerminalTitleState(result) {
  if (!result || result.state !== "current" || !validCounts(result.snapshot?.counts)) return "attention";
  const counts = result.snapshot.counts;
  if (ISSUE_KEYS.some((key) => counts[key] > 0)) return "attention";
  if (counts.running > 0) return "active";
  if (counts.successRecent > 0) return "completed";
  return "idle";
}

export function terminalTitlePrefix(state) {
  if (state === "attention") return `${ATTENTION_SYMBOL} `;
  if (state === "active") return `${ACTIVE_SYMBOL} `;
  if (state === "completed") return `${COMPLETED_SYMBOL} `;
  return "";
}

/** Reconstruct Pi's stock v0.85.1 title shape, with an optional fixed state prefix. */
export function buildTerminalTitle({ state, sessionName, cwd }) {
  const safeSession = sessionName === undefined || sessionName === null || sessionName === ""
    ? ""
    : sanitizeTitleComponent(sessionName);
  const cwdName = basename(String(cwd ?? ""));
  const safeCwd = sanitizeTitleComponent(cwdName);
  const prefix = terminalTitlePrefix(state);
  const title = `${prefix}π - ${safeSession ? `${safeSession} - ` : ""}${safeCwd}`;
  // Independent 96-byte component limits keep the ordinary form below 240 bytes.
  // Retain this assertion as a final fail-closed guard if the fixed form changes.
  if (Buffer.byteLength(title, "utf8") > TERMINAL_TITLE_MAX_BYTES) {
    throw new Error("Terminal title exceeds its fixed byte bound");
  }
  return title;
}

function sessionIdentity(ctx) {
  try { return ctx.sessionManager.getSessionId(); } catch { return undefined; }
}

function stockTitleInputs(pi, ctx) {
  const manager = ctx.sessionManager;
  const cwd = manager.getCwd();
  let sessionName;
  if (typeof manager.getSessionName === "function") sessionName = manager.getSessionName();
  else if (typeof pi.getSessionName === "function") sessionName = pi.getSessionName();
  return { cwd, sessionName };
}

/**
 * Register the read-only title consumer. Dependency overrides exist only for
 * deterministic tests; production uses the status bridge and host timers.
 */
export function registerThreadPhaseTerminalTitle(pi, {
  env = process.env,
  createReader = createStatusBridgeReader,
  rootFromEnv = statusBridgeRootFromEnv,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let currentRuntime;
  let warnedTitleOnly = false;

  const cancelRuntime = (runtime) => {
    if (!runtime) return;
    if (runtime.handoffTimer !== undefined) clearTimeoutFn(runtime.handoffTimer);
    if (runtime.pollTimer !== undefined) clearIntervalFn(runtime.pollTimer);
    runtime.handoffTimer = undefined;
    runtime.pollTimer = undefined;
    runtime.active = false;
    if (currentRuntime === runtime) currentRuntime = undefined;
  };

  const isCurrent = (runtime) => runtime.active && currentRuntime === runtime;

  const reconcile = (runtime, { force = false } = {}) => {
    if (!isCurrent(runtime)) return;
    let result;
    try { result = runtime.reader.read(); }
    catch { result = { state: "unknown", reason: "reader-error" }; }
    if (!isCurrent(runtime)) return;
    let title;
    let state;
    try {
      state = projectTerminalTitleState(result);
      title = buildTerminalTitle({ state, ...stockTitleInputs(pi, runtime.ctx) });
    } catch {
      return;
    }
    if (!isCurrent(runtime) || (!force && title === runtime.lastTitle)) return;
    try {
      runtime.ctx.ui.setTitle(title);
      if (!isCurrent(runtime)) return;
      runtime.lastTitle = title;
      runtime.ownsNonIdleTitle = state !== "idle";
    } catch {
      // Optional title ownership must not affect the host or workflow runtime.
    }
  };

  pi.on("session_start", (_event, ctx) => {
    // A repeated start invalidates old callbacks without writing through old UI.
    cancelRuntime(currentRuntime);
    if (ctx.mode !== "tui") return;
    const bridgeEnabled = env.PI_THREAD_PHASE_STATUS_BRIDGE === "1";
    const titleEnabled = env.PI_THREAD_PHASE_TERMINAL_TITLE === "1";
    if (!bridgeEnabled || !titleEnabled) {
      if (titleEnabled && !bridgeEnabled && !warnedTitleOnly) {
        warnedTitleOnly = true;
        try { ctx.ui.notify("Terminal workflow titles require PI_THREAD_PHASE_STATUS_BRIDGE=1 as well as PI_THREAD_PHASE_TERMINAL_TITLE=1.", "warning"); }
        catch { /* warning is best-effort */ }
      }
      return;
    }

    const root = rootFromEnv(env);
    const sessionId = sessionIdentity(ctx);
    if (!root || !sessionId) return;
    let reader;
    try { reader = createReader({ root, sessionId }); }
    catch { return; }

    const runtime = {
      active: true,
      ctx,
      reader,
      sessionId,
      handoffTimer: undefined,
      pollTimer: undefined,
      lastTitle: undefined,
      ownsNonIdleTitle: false,
    };
    currentRuntime = runtime;
    runtime.handoffTimer = setTimeoutFn(() => {
      if (!isCurrent(runtime)) return;
      runtime.handoffTimer = undefined;
      reconcile(runtime);
      if (!isCurrent(runtime)) return;
      runtime.pollTimer = setIntervalFn(() => reconcile(runtime), TERMINAL_TITLE_POLL_MS);
      runtime.pollTimer?.unref?.();
    }, TERMINAL_TITLE_HANDOFF_MS);
    runtime.handoffTimer?.unref?.();
  });

  pi.on("session_info_changed", (_event, ctx) => {
    const runtime = currentRuntime;
    if (!runtime || sessionIdentity(ctx) !== runtime.sessionId) return;
    // The host has just written its stock title. This lifecycle hook is a
    // justified handoff write even if sanitization maps the rename to the same text.
    runtime.ctx = ctx;
    reconcile(runtime, { force: true });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const runtime = currentRuntime;
    if (!runtime || sessionIdentity(ctx) !== runtime.sessionId) return;
    const shouldRestore = runtime.ownsNonIdleTitle;
    // Required ordering: cancel timers, invalidate callbacks, then restore.
    cancelRuntime(runtime);
    if (!shouldRestore) return;
    try {
      ctx.ui.setTitle(buildTerminalTitle({ state: "idle", ...stockTitleInputs(pi, ctx) }));
    } catch {
      // No prior-title getter exists; stock-compatible restoration is best-effort.
    }
  });
}
