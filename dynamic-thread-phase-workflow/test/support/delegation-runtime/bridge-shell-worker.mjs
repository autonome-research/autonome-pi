// FIXTURE ONLY worker for the bash result-contract regression: finite local
// process, NOT Pi/SDK/authentication. It consumes the real FD4 bootstrap,
// speaks the real bridge frame protocol and drives the REAL
// runnerBashOperations primitive; only the model/SDK is replaced.
import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import { connect } from 'node:net';
import { runnerBashOperations } from '../../../worker/adapter-primitives.mjs';

const [gate] = process.argv.slice(2);
const emit = e => process.stdout.write(JSON.stringify(e) + '\n');
// Same bounded usage source shape as the delegation-runtime fixture worker.
emit({ type: 'turn_start' });
emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: {
  input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} } });

let text = '';
for await (const chunk of createReadStream('', { fd: 4, autoClose: true })) text += chunk;
const boot = JSON.parse(text);
const socket = connect(boot.socketPath);
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
let buffer = Buffer.alloc(0);
const pending = new Map();
socket.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  let at;
  while ((at = buffer.indexOf(10)) >= 0) {
    const line = buffer.subarray(0, at); buffer = buffer.subarray(at + 1);
    const response = JSON.parse(line.toString());
    const resolve = pending.get(response.requestId);
    if (resolve) { pending.delete(response.requestId); resolve(response); }
  }
});
const request = payload => new Promise(resolve => {
  pending.set(payload.requestId, resolve);
  const frame = { schema: 'pi-workflow-delegation-request/v1', capability: boot.capability, type: payload.type, requestId: payload.requestId };
  if (payload.type !== 'hello') frame.args = { command: payload.command, ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }) };
  socket.write(`${JSON.stringify(frame)}\n`);
});
const hello = await request({ type: 'hello', requestId: 'hello:1' });
if (hello.status !== 'ready') throw new Error('bridge not ready');

async function scenario(name, requestId, command, options = {}) {
  try {
    const chunks = [];
    const ops = runnerBashOperations(requestId, request);
    const result = await ops.exec(command, process.cwd(), { onData: c => chunks.push(c), ...options });
    emit({ type: 'session', id: 'shell-result', name, exitCode: result.exitCode, data: Buffer.concat(chunks).toString() });
  } catch (error) {
    emit({ type: 'session', id: 'shell-result', name, error: String(error?.message ?? error) });
  }
}

await scenario('zero', 'shell:zero', 'printf zero-ok');
await scenario('nonzero', 'shell:nonzero', 'printf err-line >&2; printf out-line; exit 3');
await scenario('timeout', 'shell:timeout', 'sleep 5', { timeout: 1 });
const aborted = new AbortController();
aborted.abort(new Error('cancelled before dispatch'));
await scenario('aborted', 'shell:aborted', 'printf never-runs', { signal: aborted.signal });
emit({ type: 'session', id: 'ready' });

// Gate-owned exit, same discipline as the delegation-runtime fixture worker.
// Like the real SDK worker's session_shutdown hook, a graceful shutdown frame
// MUST be flushed before exit: bare EOF is authoritative channel loss.
const fallback = setTimeout(() => process.exit(74), 20000);
const timer = setInterval(() => {
  if (!fs.existsSync(gate)) return;
  clearInterval(timer); clearTimeout(fallback);
  socket.end(`${JSON.stringify({ schema: 'pi-workflow-delegation-request/v1', capability: boot.capability, type: 'shutdown', requestId: 'shutdown:1' })}\n`,
    () => process.exit(0));
}, 10);
