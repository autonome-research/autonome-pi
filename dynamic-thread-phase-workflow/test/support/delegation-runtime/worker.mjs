// Finite local worker, NOT Pi/SDK/authentication. Parent stays a real live process.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const [gate, mode = 'clean'] = process.argv.slice(2);
if (mode === 'survivor') {
  process.on('SIGTERM', () => {});
  setTimeout(() => process.exit(0), 1200);
  process.send('ready');
} else {
  const emit = e => process.stdout.write(JSON.stringify(e) + '\n');
  const turn = () => {
    emit({ type: 'turn_start' });
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: {
      input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } } });
  };
  turn();
  let triggered = false, ending = false;
  if (mode.startsWith('tail')) process.on('SIGTERM', () => {
    if (ending) return; ending = true;
    turn(); process.stdout.write(JSON.stringify({ type: 'session', id: 'tail', text: '😀' }) + '\n', () => process.exit(0));
  });
  emit({ type: 'session', id: 'ready', pid: process.pid, anchorPid: process.ppid });
  const fallback = setTimeout(() => process.exit(74), 4500);
  const timer = setInterval(() => {
    if (mode.startsWith('tail') && !triggered && fs.existsSync(gate + '.trigger')) {
      triggered = true;
      if (mode === 'tail-source') emit({ type: 'message_end', message: null });
      emit({ type: 'session', id: 'display-trigger' });
    }
    if (!fs.existsSync(gate)) return;
    clearInterval(timer); clearTimeout(fallback);
    if (mode === 'residual') {
      const child = spawn(process.execPath, [import.meta.filename, gate, 'survivor'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', () => { child.disconnect(); child.unref(); process.exit(0); });
    } else process.exit(['nonzero', 'tail-nonzero'].includes(mode) ? 23 : 0);
  }, 10);
}
