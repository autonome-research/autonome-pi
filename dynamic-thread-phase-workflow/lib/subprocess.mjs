import { spawn } from "node:child_process";
import { BoundedTextBuffer } from "./bounded-buffer.mjs";

export const DEFAULT_CAPTURE_BYTES = 1_000_000;
export const DEFAULT_KILL_GRACE_MS = 5_000;
export const MAX_TIMEOUT_MS = 2_147_483_647;

export function normalizeTimeoutMs(value, label = "timeoutMs") {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`${label} must be an integer between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return timeout;
}

/** Terminate the whole subprocess group where supported. */
export function terminateChild(child, signal = "SIGTERM") {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

/**
 * Spawn a command with bounded output and cooperative cancellation.
 *
 * A local AbortController owns the per-process timeout and is composed with
 * the workflow's AbortSignal. Timeout and user cancellation remain distinct in
 * the result so callers can report an actionable failure instead of exit 143.
 */
export function runBoundedProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs, "process timeoutMs");
    const killGraceMs = normalizeTimeoutMs(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, "process killGraceMs");
    const startedAt = Date.now();
    const stdoutBuffer = new BoundedTextBuffer(options.maxStdoutBytes ?? DEFAULT_CAPTURE_BYTES, { keep: options.stdoutKeep ?? "head" });
    const stderrBuffer = new BoundedTextBuffer(options.maxStderrBytes ?? DEFAULT_CAPTURE_BYTES, { keep: options.stderrKeep ?? "tail" });
    if (options.signal?.aborted) {
      resolve({
        ok: false,
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: true,
        durationMs: 0,
        termination: { kind: "cancelled", reason: String(options.signal.reason || "cancelled") },
        error: String(options.signal.reason || "cancelled"),
      });
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env || process.env,
      shell: Boolean(options.shell),
      detached: process.platform !== "win32",
    });
    options.onChildStart?.(child);

    const timeoutController = new AbortController();
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let requestedSignal;
    let killTimer;
    let streamCallbackError;

    const terminate = (signal = "SIGTERM") => {
      requestedSignal ||= signal;
      terminateChild(child, signal);
      if (!killTimer) {
        killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), killGraceMs);
        killTimer.unref?.();
      }
    };
    // Manually compose the workflow and local timeout signals. This preserves
    // Node 20.0 compatibility while giving both sources the same termination
    // path and keeping their result classifications distinct.
    const onWorkflowAbort = () => {
      if (timedOut) return;
      aborted = true;
      terminate("SIGTERM");
    };
    const onTimeoutAbort = () => {
      if (aborted) return;
      timedOut = true;
      terminate("SIGTERM");
    };
    options.signal?.addEventListener("abort", onWorkflowAbort, { once: true });
    timeoutController.signal.addEventListener("abort", onTimeoutAbort, { once: true });
    if (options.signal?.aborted) onWorkflowAbort();
    const timeoutTimer = setTimeout(() => {
      timeoutController.abort(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timeoutTimer.unref?.();

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onWorkflowAbort);
      timeoutController.signal.removeEventListener("abort", onTimeoutAbort);
      options.onChildEnd?.(child);
    };
    const finish = ({ code, signal, spawnError }) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdout = stdoutBuffer.value();
      const stderr = stderrBuffer.value();
      const durationMs = Date.now() - startedAt;
      const termination = timedOut
        ? { kind: "timeout", timeoutMs, requestedSignal, observedSignal: signal }
        : aborted
          ? { kind: "cancelled", reason: String(options.signal?.reason || "cancelled"), requestedSignal, observedSignal: signal }
          : signal
            ? { kind: "signal", observedSignal: signal }
            : undefined;
      const error = spawnError?.message
        || streamCallbackError?.message
        || (timedOut ? `${command} timed out after ${timeoutMs} ms; terminated with ${signal || requestedSignal || "SIGTERM"}` : undefined)
        || (aborted ? String(options.signal?.reason || "cancelled") : undefined)
        || (code === 0 ? undefined : stderr || (signal ? `${command} terminated with ${signal}` : `${command} exited ${code}`));
      resolve({
        ok: code === 0 && !timedOut && !aborted && !streamCallbackError,
        code,
        signal,
        stdout,
        stderr,
        stdoutTruncated: stdoutBuffer.truncated,
        stderrTruncated: stderrBuffer.truncated,
        timedOut,
        aborted,
        durationMs,
        termination,
        error,
      });
    };

    // Stream decoders carry incomplete UTF-8 sequences across Buffer chunks;
    // calling Buffer#toString independently would corrupt split code points.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const observeChunk = (callback, chunk) => {
      if (!callback || streamCallbackError) return;
      try {
        callback(chunk);
      } catch (error) {
        streamCallbackError = error instanceof Error ? error : new Error(String(error));
        // Do not settle until the child exits: the normal escalation timer must
        // remain armed in case the child ignores SIGTERM.
        terminate("SIGTERM");
      }
    };
    child.stdout.on("data", (chunk) => {
      observeChunk(options.onStdout, chunk);
      if (options.captureStdout !== false) stdoutBuffer.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      observeChunk(options.onStderr, chunk);
      if (options.captureStderr !== false) stderrBuffer.append(chunk);
    });
    child.on("error", (error) => finish({ code: 1, signal: null, spawnError: error }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}
