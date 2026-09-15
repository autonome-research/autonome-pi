import assert from "node:assert/strict";
import test from "node:test";
import { BoundedTextBuffer } from "../lib/bounded-buffer.mjs";
import { getEventListeners } from 'node:events';
import { createCallbackLifetime, CALLBACK_LIMITS, normalizeTimeoutMs, runBoundedProcess } from "../lib/subprocess.mjs";
import { createScopedProcess, ANCHOR_BINARY, ANCHOR_PATH, probeGroup } from '../lib/scoped-process.mjs';

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

test("bounded truncation preserves a legitimate replacement character at boundaries", () => {
  const head = new BoundedTextBuffer(4, { keep: "head" });
  const tail = new BoundedTextBuffer(4, { keep: "tail" });
  head.append("a�b");
  tail.append("a�b");
  assert.match(head.value(), /^a�\n/u);
  assert.match(tail.value(), /�b$/u);
});

test("BoundedTextBuffer trims a single giant chunk before retention", () => {
  for (const keep of ["head", "tail"]) {
    const buffer = new BoundedTextBuffer(1_024, { keep });
    buffer.append(`prefix-${"x".repeat(1_000_000)}-suffix`);
    assert.equal(buffer.truncated, true);
    assert.ok(Buffer.byteLength(buffer.text, "utf8") <= 1_024);
    assert.ok(buffer.observedBytes > 1_000_000);
  }
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

test("runBoundedProcess decodes UTF-8 split across native stream chunks", async () => {
  const script = [
    "const value=Buffer.from('A😀B');",
    "process.stdout.write(value.subarray(0,3));",
    "setTimeout(()=>process.stdout.end(value.subarray(3)),10);",
  ].join("");
  const result = await runBoundedProcess(process.execPath, ["-e", script], { timeoutMs: 5_000 });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "A😀B");
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

test("runBoundedProcess requires an explicit deadline policy", async () => {
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", "process.exit(0)"], {}),
    /process timeoutMs must be an integer/,
  );
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", "process.exit(0)"], { noDeadline: "yes" }),
    /process noDeadline must be a boolean/,
  );
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", "process.exit(0)"], { noDeadline: true, timeoutMs: 100 }),
    /mutually exclusive/,
  );
});

test("explicit no-deadline mode runs without a wall-clock timer and remains cancellable", async () => {
  const completed = await runBoundedProcess(process.execPath, ["-e", "setTimeout(() => process.stdout.write('done'), 120)"], {
    noDeadline: true,
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.stdout, "done");
  assert.equal(completed.timedOut, false);

  const controller = new AbortController();
  setTimeout(() => controller.abort("operator cancelled no-deadline process"), 80);
  const cancelled = await runBoundedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    noDeadline: true,
    killGraceMs: 100,
    signal: controller.signal,
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.timedOut, false);
  assert.equal(cancelled.aborted, true);
  assert.equal(cancelled.termination.kind, "cancelled");
  assert.equal(cancelled.error, "operator cancelled no-deadline process");
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

test("runBoundedProcess escalates an ignored SIGTERM and records SIGKILL", { skip: process.platform === "win32" && "POSIX signal assertion" }, async () => {
  const script = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";
  const result = await runBoundedProcess(process.execPath, ["-e", script], {
    timeoutMs: 500,
    killGraceMs: 50,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.termination.observedSignal, "SIGKILL");
  assert.match(result.error, /terminated with SIGKILL/);
});

test("runBoundedProcess terminates the child when a stream observer throws", async () => {
  const result = await runBoundedProcess(process.execPath, ["-e", "process.stdout.write('trigger'); setInterval(()=>{},1000)"], {
    timeoutMs: 5_000,
    killGraceMs: 100,
    onStdout: () => { throw new Error("collector failed"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "collector failed");
  assert.equal(result.termination.kind, "callback_error");
  assert.ok(result.signal === "SIGTERM" || result.signal === "SIGKILL");
});

test("runBoundedProcess reaps the child when onChildStart throws without reporting no-child proof", async () => {
  let noChildProofs = 0;
  const result = await runBoundedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    timeoutMs: 5_000,
    killGraceMs: 100,
    onNoChild: () => { noChildProofs++; },
    onChildStart: () => { throw new Error("start hook failed"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "start hook failed");
  assert.equal(result.termination.kind, "callback_error");
  assert.ok(result.signal === "SIGTERM" || result.signal === "SIGKILL");
  assert.equal(noChildProofs, 0);
});

test("runBoundedProcess reports positive no-child proof for a pre-aborted workflow", async () => {
  const controller = new AbortController();
  let noChildProofs = 0;
  controller.abort("already cancelled");
  const result = await runBoundedProcess(process.execPath, ["-e", "process.exit(99)"], {
    timeoutMs: 5_000,
    signal: controller.signal,
    onNoChild: () => { noChildProofs++; },
  });
  assert.equal(result.aborted, true);
  assert.equal(result.code, null);
  assert.equal(result.error, "already cancelled");
  assert.equal(noChildProofs, 1);
});

test("runBoundedProcess reports positive no-child proof for pre-spawn validation failure", async () => {
  let noChildProofs = 0;
  await assert.rejects(
    runBoundedProcess(process.execPath, [], { timeoutMs: 0, onNoChild: () => { noChildProofs++; } }),
    /process timeoutMs must be an integer/,
  );
  assert.equal(noChildProofs, 1);
});

test("runBoundedProcess reports positive no-child proof for emitted ENOENT without a PID", async () => {
  let noChildProofs = 0;
  const result = await runBoundedProcess("definitely-not-a-real-dynamic-workflow-command", [], {
    timeoutMs: 5_000,
    onNoChild: () => { noChildProofs++; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.match(result.error, /ENOENT/);
  assert.equal(noChildProofs, 1);
});

test("runBoundedProcess reports positive no-child proof for synchronous spawn setup failure", async () => {
  let noChildProofs = 0;
  const result = await runBoundedProcess(null, [], {
    timeoutMs: 5_000,
    onNoChild: () => { noChildProofs++; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.match(result.error, /(?:command|file).*type string|invalid.*type/i);
  assert.equal(noChildProofs, 1);
});

test("runBoundedProcess resolves emitted spawn setup failures consistently", async () => {
  let noChildProofs = 0;
  const result = await runBoundedProcess(process.execPath, ["-e", "process.exit(0)"], {
    cwd: "/definitely/not/a/real/dynamic-workflow-directory",
    timeoutMs: 5_000,
    onNoChild: () => { noChildProofs++; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.match(result.error, /ENOENT/);
  assert.equal(noChildProofs, 1);
});

test("runBoundedProcess preserves workflow cancellation separately from timeout", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort("operator cancelled"), 100);
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

test('repair: opted callback rejection veto precedes queued observation, source closes independently before result', async t => {
  for (const kind of ['stdout', 'async-stdout', 'source', 'source-close']) {
    const order = []; let vetoed = false, pid, delivered = '', calls = 0;
    const script = "process.on('SIGTERM',()=>process.stdout.write('tail',()=>process.exit(0)));process.stdout.write('first');setTimeout(()=>process.exit(0),1000)";
    const lifecycle = createScopedProcess([process.execPath, '-e', script], 100, () => {}, () => {}, () => { vetoed = true; order.push('veto'); });
    const result = await runBoundedProcess(ANCHOR_BINARY, ['-I', '-S', '-B', ANCHOR_PATH], {
      timeoutMs: 2000, lifecycle, onChildStart(c) { pid = c.pid; },
      stdoutSource: { push(chunk) {
        delivered += chunk;
        if (kind === 'source') { queueMicrotask(() => assert.equal(vetoed, true)); throw Error('source failed'); }
      }, close() { order.push('source-close'); if (kind === 'source-close') throw Error('source close failed'); } },
      onStdout() {
        calls++;
        if (kind === 'stdout') { queueMicrotask(() => assert.equal(vetoed, true)); throw Error('display failed'); }
        if (kind === 'async-stdout') { setImmediate(() => assert.equal(vetoed, true)); return Promise.reject(Error('display rejected')); }
      }, onChildEnd() { order.push('end'); },
    });
    order.push('result');
    assert.equal(result.scopeSettlement.disposition, 'drained'); assert.equal(probeGroup(pid), 'gone');
    assert.equal(result.termination.kind, 'callback_error'); assert.equal(vetoed, true);
    assert.ok(order.indexOf('source-close') < order.indexOf('end')); assert.ok(order.indexOf('end') < order.indexOf('result'));
    if (kind.includes('stdout')) { assert.equal(calls, 1); assert.equal(delivered, 'firsttail'); }
    t.diagnostic(JSON.stringify({ kind, pid, group: 'ESRCH', order, signals: 'owned lifecycle only; no teardown signals' }));
  }
});

test('callback lifetime: repeated cap/expiry seals detach all reactions and own exactly one finite timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let repeat = 0; repeat < 4; repeat++) {
    const callbacks = createCallbackLifetime(), rejects = []; let failures = 0, overflowCalled = false;
    for (let i = 0; i < CALLBACK_LIMITS.pending; i++) {
      callbacks.call(() => new Promise((_, reject) => rejects.push(reject)), [], () => failures++);
    }
    callbacks.call(() => { overflowCalled = true; }, [], () => failures++);
    assert.equal(overflowCalled, false); assert.equal(failures, 1);
    assert.equal(callbacks.inspect().pending, 128);
    const one = callbacks.seal(), two = callbacks.seal();
    assert.equal(callbacks.inspect().timer, true);
    t.mock.timers.tick(CALLBACK_LIMITS.settleMs); await Promise.all([one, two]);
    assert.deepEqual(callbacks.inspect(), { pending: 0, accepting: false, sealed: true, timer: false });
    assert.equal(failures, 129);
    rejects.forEach(reject => { reject(Error('late')); reject(Error('repeated')); });
    await Promise.resolve(); await Promise.resolve();
    callbacks.call(() => { overflowCalled = true; }, [], () => failures++);
    callbacks.close(); t.mock.timers.tick(10000);
    assert.equal(overflowCalled, false); assert.equal(failures, 129);
  }
});

test('callback lifetime: reentrant admission reserves first, close cancels pending timer, fulfillment leaves no reaction ownership', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const callbacks = createCallbackLifetime(); let reject, failures = 0, invoked = 0;
  const reenter = () => { invoked++; callbacks.call(reenter, [], () => failures++); };
  callbacks.call(reenter, [], () => failures++);
  assert.equal(invoked, 128); assert.equal(failures, 1); assert.equal(callbacks.inspect().pending, 0);
  const pending = createCallbackLifetime();
  pending.call(() => new Promise((_, r) => { reject = r; }), [], () => failures++);
  const seal = pending.seal(); pending.close(); await seal;
  assert.equal(pending.inspect().timer, false); reject(Error('after loss')); await Promise.resolve();
  t.mock.timers.tick(5000); assert.equal(failures, 1);
  const success = createCallbackLifetime();
  success.call(() => Promise.resolve(), [], () => failures++);
  await success.seal(); assert.equal(success.inspect().pending, 0); assert.equal(success.inspect().timer, false);
});

for (const boundary of ['late-stdout', 'never-end', 'cancel', 'deadline'])
  test(`callback lifetime: standalone opted subprocess ${boundary} is finite without truncating source or late signaling`, async t => {
    let reject, pid, writes = 0, afterDrain = false, delivered = '';
    const deferred = new Promise((_, r) => { reject = r; }), abort = new AbortController();
    const lifecycle = createScopedProcess([process.execPath, '-e', "process.stdout.write('complete-source')"], 100);
    const before = Date.now();
    const result = await runBoundedProcess(ANCHOR_BINARY, ['-I', '-S', '-B', ANCHOR_PATH], {
      lifecycle, signal: abort.signal, timeoutMs: boundary === 'deadline' ? 600 : 2500,
      stdoutSource: { push(chunk) { delivered += chunk; }, close(complete) { assert.equal(complete, true); } },
      onChildStart(p) {
        pid = p.pid; const write = p.stdio[3].write;
        p.stdio[3].write = function(...args) { if (afterDrain) writes++; return write.apply(this, args); };
      },
      ...(boundary === 'late-stdout' ? { onStdout() { return deferred; } } : {}),
      onChildEnd() {
        assert.equal(probeGroup(pid), 'gone'); afterDrain = true;
        if (boundary === 'late-stdout') { setTimeout(() => reject(Error('observed while sealing')), 20); return; }
        if (boundary === 'cancel') setTimeout(() => abort.abort('operator during observer settlement'), 20);
        return deferred;
      },
    });
    assert.equal(result.ok, false); assert.equal(result.stdout, delivered); assert.equal(delivered, 'complete-source');
    assert.equal(result.termination.kind, boundary === 'cancel' ? 'cancelled' : boundary === 'deadline' ? 'timeout' : 'callback_error');
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0); assert.equal(writes, 0);
    assert.ok(Date.now() - before < 2500); assert.equal(probeGroup(pid), 'gone');
    const original = JSON.stringify(result); reject(Error('post-seal')); await Promise.resolve(); await Promise.resolve();
    assert.equal(JSON.stringify(result), original); assert.equal(writes, 0);
    t.diagnostic(JSON.stringify({ boundary, pid, group: 'ESRCH', elapsed: Date.now() - before, teardownSignals: 0 }));
  });

test("timeout validation rejects values that Node timers cannot represent", () => {
  assert.equal(normalizeTimeoutMs(1), 1);
  assert.throws(() => normalizeTimeoutMs(0), /must be an integer/);
  assert.throws(() => normalizeTimeoutMs(Number.NaN), /must be an integer/);
  assert.throws(() => normalizeTimeoutMs(2_147_483_648), /must be an integer/);
});
