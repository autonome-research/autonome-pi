import assert from "node:assert/strict";
import test from "node:test";
import { BoundedTextBuffer } from "../lib/bounded-buffer.mjs";
import { normalizeTimeoutMs, runBoundedProcess } from "../lib/subprocess.mjs";

test("BoundedTextBuffer retains a byte-safe head", () => {
  const buffer = new BoundedTextBuffer(7, { keep: "head" });
  buffer.append("😀😀tail");
  const value = buffer.value();
  assert.match(value, /^😀/u);
  assert.doesNotMatch(value, /\uFFFD/u);
  assert.equal(buffer.truncated, true);
  assert.equal(buffer.observedBytes, 12);
});

test("BoundedTextBuffer retains a byte-safe tail", () => {
  const buffer = new BoundedTextBuffer(8, { keep: "tail" });
  buffer.append("prefix-😀ok");
  const value = buffer.value();
  assert.match(value, /😀ok$/u);
  assert.doesNotMatch(value, /\uFFFD/u);
});

test("runBoundedProcess caps stdout and stderr during ingestion", async () => {
  const script = [
    "process.stdout.write('o'.repeat(200_000));",
    "process.stderr.write('e'.repeat(200_000));",
  ].join("");
  const result = await runBoundedProcess(process.execPath, ["-e", script], {
    timeoutMs: 5_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 2_048,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") < 1_200);
  assert.ok(Buffer.byteLength(result.stderr, "utf8") < 2_300);
});

test("runBoundedProcess can stream stdout without retaining a raw copy", async () => {
  let observed = 0;
  const result = await runBoundedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(50000))"], {
    timeoutMs: 5_000,
    captureStdout: false,
    onStdout: (chunk) => { observed += Buffer.byteLength(chunk, "utf8"); },
  });

  assert.equal(result.ok, true);
  assert.equal(observed, 50_000);
  assert.equal(result.stdout, "");
});

test("runBoundedProcess reports timeout separately from process exit", async () => {
  const result = await runBoundedProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    timeoutMs: 40,
    killGraceMs: 100,
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.equal(result.termination.kind, "timeout");
  assert.equal(result.termination.timeoutMs, 40);
  assert.match(result.error, /timed out after 40 ms; terminated with SIGTERM/);
  assert.ok(result.durationMs >= 30);
});

test("runBoundedProcess preserves workflow cancellation separately from timeout", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort("operator cancelled"), 30);
  const result = await runBoundedProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    timeoutMs: 5_000,
    killGraceMs: 100,
    signal: controller.signal,
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, true);
  assert.equal(result.termination.kind, "cancelled");
  assert.equal(result.error, "operator cancelled");
});

test("timeout validation rejects values that Node timers cannot represent", () => {
  assert.equal(normalizeTimeoutMs(1), 1);
  assert.throws(() => normalizeTimeoutMs(0), /must be an integer/);
  assert.throws(() => normalizeTimeoutMs(Number.NaN), /must be an integer/);
  assert.throws(() => normalizeTimeoutMs(2_147_483_648), /must be an integer/);
});
