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

// Private opted observer policy; matches the scoped post-drain probe budget.
export const CALLBACK_LIMITS = Object.freeze({ pending: 128, settleMs: 1000 });
// Promise reactions retain ONLY this detachable cell, not a runner/child closure.
function watchCallback(value, cell) {
  Promise.resolve(value).then(() => cell.finish?.(), error => cell.finish?.(error, true));
}
export function createCallbackLifetime() {
  const pending = new Set();
  let accepting = true, sealed = false, timer, waiting, resolveWait;
  function done() {
    if (pending.size) return;
    clearTimeout(timer); timer = undefined;
    const resolve = resolveWait; resolveWait = undefined; waiting = undefined; resolve?.();
  }
  function close() {
    accepting = false; sealed = true;
    for (const cell of pending) cell.finish = null;
    pending.clear(); done();
  }
  function drain() {
    if (!pending.size) return Promise.resolve();
    if (!waiting) {
      waiting = new Promise(resolve => { resolveWait = resolve; });
      timer = setTimeout(() => {
        accepting = false;
        for (const cell of [...pending]) cell.finish?.(new Error('CALLBACK_TIMEOUT: observer settlement expired'), true);
      }, CALLBACK_LIMITS.settleMs);
    }
    return waiting;
  }
  return Object.freeze({
    call(callback, args, failed) {
      if (!callback || !accepting) return;
      if (pending.size >= CALLBACK_LIMITS.pending) {
        accepting = false; failed(new Error('CALLBACK_LIMIT: pending observers')); return;
      }
      const cell = { finish: null };
      cell.finish = (error, rejected = false) => {
        if (!cell.finish) return;
        cell.finish = null; pending.delete(cell);
        try { if (rejected) failed(error); } catch { /* failure observers never create an unhandled rejection */ }
        finally { done(); }
      };
      pending.add(cell); // Reserve before a reentrant callback, even a synchronous one.
      try {
        const value = callback(...args);
        if (value?.then) watchCallback(value, cell);
        else cell.finish?.();
      } catch (error) { cell.finish?.(error, true); }
    },
    drain,
    async seal() { accepting = false; await drain(); sealed = true; },
    close,
    inspect() { return Object.freeze({ pending: pending.size, accepting, sealed, timer: timer !== undefined }); },
  });
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
  return new Promise((resolve, reject) => {
    let noChildProofReported = false;
    const reportNoChild = () => {
      if (noChildProofReported) return;
      noChildProofReported = true;
      options.onNoChild?.();
    };

    let timeoutMs;
    let noDeadline;
    let killGraceMs;
    let stdoutBuffer;
    let stderrBuffer;
    let workerBootstrap;
    try {
      if (options.noDeadline !== undefined && typeof options.noDeadline !== "boolean") {
        throw new Error("process noDeadline must be a boolean");
      }
      noDeadline = options.noDeadline === true;
      if (noDeadline && options.timeoutMs !== undefined) {
        throw new Error("process timeoutMs and noDeadline are mutually exclusive");
      }
      timeoutMs = noDeadline ? undefined : normalizeTimeoutMs(options.timeoutMs, "process timeoutMs");
      killGraceMs = normalizeTimeoutMs(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, "process killGraceMs");
      stdoutBuffer = new BoundedTextBuffer(options.maxStdoutBytes ?? DEFAULT_CAPTURE_BYTES, { keep: options.stdoutKeep ?? "head" });
      stderrBuffer = new BoundedTextBuffer(options.maxStderrBytes ?? DEFAULT_CAPTURE_BYTES, { keep: options.stderrKeep ?? "tail" });
      if (options.workerBootstrap !== undefined) {
        if (!Buffer.isBuffer(options.workerBootstrap) || options.workerBootstrap.length > 4096) throw new Error('INVALID_REQUEST: worker bootstrap');
        workerBootstrap = Buffer.from(options.workerBootstrap);
      }
    } catch (error) {
      try { reportNoChild(); } catch (proofError) { reject(proofError); return; }
      reject(error);
      return;
    }

    const startedAt = Date.now();
    if (options.signal?.aborted) {
      try { reportNoChild(); } catch (error) { reject(error); return; }
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

    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        stdio: workerBootstrap ? ["ignore", "pipe", "pipe", "pipe", "pipe"] :
          options.lifecycle ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        env: options.env || process.env,
        shell: Boolean(options.shell),
        detached: process.platform !== "win32",
      });
    } catch (error) {
      try { reportNoChild(); } catch (proofError) { reject(proofError); return; }
      resolve({
        ok: false,
        code: 1,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // noDeadline is an explicit runner-internal policy. Ordinary callers must
    // continue to provide a valid numeric timeout; a missing or malformed value
    // never turns into permission to run forever.
    const timeoutController = noDeadline ? undefined : new AbortController();
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let requestedSignal;
    let killTimer;
    let streamCallbackError;
    let sourceClosed;
    let sourceFailed = false;
    let published = false;
    const callbacks = options.lifecycle ? options.callbackLifetime ?? createCallbackLifetime() : null;
    const observe = (kind, callback, args) => {
      if (callbacks) callbacks.call(callback, args, error => {
        try { options.onCallbackFailure?.(kind); }
        finally { callbackFailed(error); }
      });
      else callback?.(...args);
    };

    const terminate = (signal = "SIGTERM") => {
      requestedSignal ||= signal;
      if (options.lifecycle) {
        // An opted live owner supplies identity-safe signaling. NEVER fall back
        // to a PID/PGID signal when its authority is lost or unsupported.
        options.lifecycle.terminate(signal);
        return;
      }
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
    timeoutController?.signal.addEventListener("abort", onTimeoutAbort, { once: true });
    if (options.signal?.aborted) onWorkflowAbort();
    const timeoutTimer = timeoutController ? setTimeout(() => {
      timeoutController.abort(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs) : undefined;
    timeoutTimer?.unref?.();

    const childHasPid = Number.isSafeInteger(child.pid) && child.pid > 0;
    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onWorkflowAbort);
      timeoutController?.signal.removeEventListener("abort", onTimeoutAbort);
      if (workerBootstrap) { try { child.stdio[4]?.destroy(); } catch {} }
      if (childHasPid && !callbacks) {
        try { options.onChildEnd?.(child); } catch { /* legacy cleanup must not mask the process result */ }
      }
    };
    const finish = async ({ code, signal, spawnError }) => {
      if (settled) return;
      settled = true;
      // Only the trusted source opt-in waits here. Abandonment destroys the
      // reader but must still observe its actual close before publishing usage.
      if (sourceClosed) await sourceClosed;
      let scopeSettlement;
      if (options.lifecycle) {
        try { scopeSettlement = await options.lifecycle.settle({ code, signal, spawnError }); }
        catch { scopeSettlement = { disposition: "unknown" }; }
      }
      // Opted settlement deliberately keeps timeout/abort ownership through
      // direct exit, stream close and drain; legacy cleanup timing is unchanged.
      if (callbacks) {
        if (childHasPid) observe('end', options.onChildEnd, [child]);
        // Executor-owned observers live beyond the immutable physical command.
        // Standalone opted subprocesses own their seal here, with the same bound.
        if (!options.callbackLifetime) await callbacks.seal();
        else await Promise.resolve(); // Observe already-rejected end hooks, never await arbitrary work.
      }
      cleanup();
      published = true;
      const stdout = stdoutBuffer.value();
      const stderr = stderrBuffer.value();
      const durationMs = Date.now() - startedAt;
      const termination = timedOut
        ? { kind: "timeout", timeoutMs, requestedSignal, observedSignal: signal }
        : aborted
          ? { kind: "cancelled", reason: String(options.signal?.reason || "cancelled"), requestedSignal, observedSignal: signal }
          : streamCallbackError
            ? { kind: "callback_error", reason: streamCallbackError.message, requestedSignal, observedSignal: signal }
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
        ...(options.lifecycle ? { scopeSettlement } : {}),
      });
    };

    // Stream decoders carry incomplete UTF-8 sequences across Buffer chunks;
    // calling Buffer#toString independently would corrupt split code points.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const callbackFailed = (error) => {
      if (published) return; // Scope evidence is handled above; never rewrite a command or signal after acknowledgement.
      streamCallbackError ||= error instanceof Error ? error : new Error(String(error));
      // Synchronous veto before callback-queued operations; NOT owner revoke.
      // Source observation still runs through actual stdout close independently.
      try { options.lifecycle?.callbackFailed?.(); }
      catch { /* the owned lifecycle retains failure/unknown; never skip termination */ }
      terminate("SIGTERM");
    };
    if (workerBootstrap) {
      // The anchor intentionally closes this handoff after passing it to the
      // payload; ECONNRESET on the parent pipe is not a worker lifecycle failure.
      child.stdio[4].on('error', () => {});
      try { child.stdio[4].end(workerBootstrap); }
      catch (error) { callbackFailed(error); }
    }
    const observeChunk = (kind, callback, chunk) => {
      if (!callback || streamCallbackError || published) return;
      try {
        observe(kind, callback, [chunk]);
      } catch (error) { callbackFailed(error); }
    };
    if (options.stdoutSource) {
      sourceClosed = new Promise(done => {
        child.stdout.once("close", () => {
          const complete = child.stdout.readableEnded && !sourceFailed;
          if (!complete) callbackFailed(new Error("SOURCE_PROTOCOL: stdout observation incomplete"));
          try { options.stdoutSource.close(complete); }
          catch (error) { callbackFailed(error); }
          finally { done(); }
        });
      });
      child.stdout.on("error", error => { sourceFailed = true; callbackFailed(error); });
    }
    child.stdout.on("data", (chunk) => {
      // Authoritative input is independent of BOTH optional display callbacks,
      // capture settings and retention bounds. Only its own failure stops it.
      if (options.stdoutSource && !sourceFailed) {
        try { options.stdoutSource.push(chunk); }
        catch (error) { sourceFailed = true; callbackFailed(error); }
      }
      observeChunk('stdout', options.onStdout, chunk);
      if (options.captureStdout !== false) stdoutBuffer.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      observeChunk('stderr', options.onStderr, chunk);
      if (options.captureStderr !== false) stderrBuffer.append(chunk);
    });
    child.on("error", (error) => {
      if (!childHasPid) {
        try { reportNoChild(); }
        catch (proofError) { finish({ code: 1, signal: null, spawnError: proofError instanceof Error ? proofError : new Error(String(proofError)) }); return; }
      }
      finish({ code: 1, signal: null, spawnError: error });
    });
    child.on("close", (code, signal) => finish({ code, signal }));
    if (childHasPid) {
      try {
        options.lifecycle?.attach(child, () => finish({ code: null, signal: null }));
        observe('start', options.onChildStart, [child]);
        options.lifecycle?.dispatch();
      } catch (error) {
        callbackFailed(error);
      }
    }
  });
}
