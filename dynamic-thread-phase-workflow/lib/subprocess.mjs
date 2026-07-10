import { spawn } from "node:child_process";
import { BoundedTextBuffer } from "./bounded-buffer.mjs";

export const DEFAULT_CAPTURE_BYTES = 1_000_000;
export const DEFAULT_KILL_GRACE_MS = 5_000;

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
 * Spawn a command while bounding captured output as bytes arrive.
 *
 * onStdout/onStderr allow protocol consumers to parse streams incrementally;
 * captureStdout/captureStderr can be disabled when those consumers do not need
 * a raw copy. This helper intentionally preserves the runner's existing
 * timeout/error semantics; timeout classification is handled separately.
 */
export function runBoundedProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const stdoutBuffer = new BoundedTextBuffer(options.maxStdoutBytes ?? DEFAULT_CAPTURE_BYTES, { keep: options.stdoutKeep ?? "head" });
    const stderrBuffer = new BoundedTextBuffer(options.maxStderrBytes ?? DEFAULT_CAPTURE_BYTES, { keep: options.stderrKeep ?? "tail" });
    if (options.signal?.aborted) {
      resolve({ ok: false, code: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: true, error: String(options.signal.reason || "cancelled") });
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

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer;
    const terminate = (signal = "SIGTERM") => {
      terminateChild(child, signal);
      if (!killTimer) {
        killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };
    const onAbort = () => {
      aborted = true;
      terminate("SIGTERM");
    };
    const timeoutMs = options.timeoutMs;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
    }, timeoutMs);
    timeoutTimer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      options.onChildEnd?.(child);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      options.onStdout?.(chunk);
      if (options.captureStdout !== false) stdoutBuffer.append(chunk);
    });
    child.stderr.on("data", (data) => {
      const chunk = data.toString();
      options.onStderr?.(chunk);
      if (options.captureStderr !== false) stderrBuffer.append(chunk);
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        code: 1,
        signal: null,
        stdout: stdoutBuffer.value(),
        stderr: stderrBuffer.value(),
        stdoutTruncated: stdoutBuffer.truncated,
        stderrTruncated: stderrBuffer.truncated,
        timedOut,
        aborted,
        error: error.message,
      });
    });
    child.on("close", (code, signal) => {
      const stdout = stdoutBuffer.value();
      const stderr = stderrBuffer.value();
      finish({
        ok: code === 0 && !aborted,
        code,
        signal,
        stdout,
        stderr,
        stdoutTruncated: stdoutBuffer.truncated,
        stderrTruncated: stderrBuffer.truncated,
        timedOut,
        aborted,
        error: aborted ? String(options.signal?.reason || "cancelled") : code === 0 ? undefined : stderr || `${command} exited ${code}`,
      });
    });
  });
}
