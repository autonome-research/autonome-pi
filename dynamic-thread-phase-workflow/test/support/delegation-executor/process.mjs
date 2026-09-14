// Fixed finite fixtures only. No network, Pi, shell-auth/config or operational PIDs.
import { spawn } from 'node:child_process';
const mode = process.argv[2];
if (mode === 'survivor') {
  process.on('SIGTERM', () => {});
  setTimeout(() => process.exit(0), 3000);
  process.send('ready');
} else if (mode === 'normal-survivor' || mode === 'cancel-survivor') {
  if (mode === 'cancel-survivor') process.on('SIGTERM', () => process.exit(0));
  const child = spawn(process.execPath, [import.meta.filename, 'survivor'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.once('message', () => {
    child.disconnect(); child.unref();
    process.stdout.write('ready\n', () => { if (mode === 'normal-survivor') process.exit(0); });
  });
  setTimeout(() => process.exit(0), 4000);
} else if (mode === 'waiting') {
  process.stdout.write('ready\n');
  setTimeout(() => process.exit(0), 6000);
} else if (mode === 'nonzero') process.exit(23);
else if (mode === 'signal') process.kill(process.pid, 'SIGTERM');
else if (mode === 'utf8') {
  const bytes = Buffer.from('A😀B'); process.stdout.write(bytes.subarray(0, 3));
  setTimeout(() => process.stdout.end(bytes.subarray(3)), 20);
} else throw new Error('unknown fixed fixture');
