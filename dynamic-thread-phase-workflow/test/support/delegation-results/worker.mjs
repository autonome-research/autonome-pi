// Fixed finite local process only. NOT Pi, inference, a worker bridge or scheduler.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const [mode, gate] = process.argv.slice(2);
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const usage = { input: 11, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 17,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
if (mode === 'survivor') {
  process.on('SIGTERM', () => {});
  setTimeout(() => process.exit(0), 1800);
  process.send('ready');
} else if (mode.startsWith('repair-')) {
  const seven = { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const source = (value = seven) => [{ type: 'turn_start' },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: value } }];
  const [kind, variant, position] = mode.slice(7).split('-');
  let events = [], trigger;
  if (kind === 'envelope') {
    const bad = [{ type: 'message_end', message: null }, { type: 'message_end' },
      { type: 'message_end', message: [] }, { type: 'message_end', message: {} },
      ...[null, [], {}, 'future-assistant'].map(role => ({ type: 'message_end', message: { role, usage: seven } })),
      null, [], { type: 'unknown-source', usage: seven }][Number(variant)];
    events = position === 'after' ? [...source(), bad] : position === 'before' ? [bad, ...source()] : [bad];
  } else if (kind === 'roles') {
    events = [...source(), ...[
      { role: 'user', content: 'hello', timestamp: 1 },
      { role: 'toolResult', toolCallId: 't', toolName: 'delegate', content: [], isError: false, timestamp: 1 },
      { role: 'bashExecution', command: 'display only', output: '', exitCode: 0, cancelled: false, truncated: false, timestamp: 1 },
      { role: 'custom', customType: 'fixture', content: [], display: false, timestamp: 1 },
      { role: 'branchSummary', summary: 'display', fromId: 'old', timestamp: 1 },
      { role: 'compactionSummary', summary: 'display', tokensBefore: 123, timestamp: 1 },
    ].map(message => ({ type: 'message_end', message: { ...message, usage: { ...seven, totalTokens: 999999 } } })),
    { type: 'message_update', usage: seven }, { type: 'agent_end', messages: source().slice(1).map(e => e.message) }];
  } else if (kind === 'diagnostic' || kind === 'overflow') {
    const errors = { large: 'x'.repeat(5000), utf8: '😀'.repeat(1250), space: '   ', nul: '\0', surrogate: '\ud800' };
    let first = seven, second = seven;
    if (kind === 'overflow') {
      if (variant === 'tokens') first = { ...seven, totalTokens: Number.MAX_SAFE_INTEGER };
      else first = second = { ...seven, cost: { ...seven.cost, total: Number.MAX_VALUE } };
    }
    if (position === 'prior' || kind === 'overflow') events.push(...source(first));
    const end = { type: 'compaction_end', reason: 'manual', result: { usage: position === 'missing' ? { input: 5 } : second }, aborted: false, willRetry: false,
      errorMessage: errors[variant] ?? 'bounded failure' };
    events.push({ type: 'compaction_start', reason: 'manual' }, end, end); // rejected diagnostic still deduplicates its source
    if (position === 'later') events.push(...source());
  } else {
    events = source();
    trigger = variant;
    // Installed before first output. TERM reports a distinct source, not a replay.
    process.on('SIGTERM', () => {
      clearInterval(timer); clearTimeout(fallback);
      const bytes = Buffer.from(source().map(e => JSON.stringify(e) + '\n').join('') +
        JSON.stringify({ type: 'session', id: 'split-😀-tail' }) + '\n');
      const at = bytes.indexOf(Buffer.from('😀')) + 2;
      process.stdout.write(bytes.subarray(0, at));
      setTimeout(() => process.stdout.write(bytes.subarray(at), () => process.exit(0)), 10);
    });
  }
  const fallback = setTimeout(() => process.exit(73), 4500);
  const timer = setInterval(() => {
    if (fs.existsSync(gate)) { clearInterval(timer); clearTimeout(fallback); process.exit(0); }
  }, 10);
  events.push({ type: 'session', id: 'fixture-ready' });
  process.stdout.write(events.map(e => JSON.stringify(e) + '\n').join(''));
  if (trigger) setTimeout(() => {
    if (trigger === 'stderr') process.stderr.write('display-trigger');
    else emit({ type: 'session', id: trigger === 'tap' ? 'tap-failure' : 'display-trigger' });
  }, 80);
} else {
  emit({ type: 'turn_start' });
  const message = { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [],
    ...(mode === 'missing-usage' ? {} : { usage }) } };
  if (mode !== 'unfinished') { emit(message); emit(message); }
  emit({ type: 'message_end', message: { role: 'toolResult', usage: { ...usage, totalTokens: 999999 } } });
  emit({ type: 'agent_end', messages: [message.message] });
  if (mode === 'conflict') emit({ ...message, message: { ...message.message, usage: { ...usage, output: 99 } } });
  if (mode === 'malformed') process.stdout.write('bad JSON\n');
  if (mode === 'oversized') process.stdout.write('x'.repeat(65537) + '\n');
  if (mode === 'm1') {
    emit({ type: 'compaction_start', reason: 'overflow' });
    const summary = { type: 'compaction_end', reason: 'overflow', result: { usage }, aborted: false, willRetry: true };
    const terminal = { type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: false, errorMessage: 'finite overflow recovery failure' };
    emit(summary); emit(terminal); emit(summary); emit(terminal);
  }
  emit({ type: 'session', id: 'fixture-ready' });
  const fallback = setTimeout(() => process.exit(72), 10000);
  const timer = setInterval(() => {
    if (!fs.existsSync(gate)) return;
    clearInterval(timer); clearTimeout(fallback);
    if (mode === 'nonzero') process.exit(23);
    else if (mode === 'signal') process.kill(process.pid, 'SIGTERM');
    else if (mode === 'residual') {
      const child = spawn(process.execPath, [import.meta.filename, 'survivor'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', () => { child.disconnect(); child.unref(); process.exit(0); });
    } else process.exit(0);
  }, 10);
}
