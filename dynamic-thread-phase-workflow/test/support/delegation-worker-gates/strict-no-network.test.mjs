import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { chmod, lstat, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = await mkdtemp(join(tmpdir(), 'strict-owned-'));
const ownedPath = join(root, 'bridge.sock');
process.env.PI_DELEGATION_BRIDGE_SOCKET = ownedPath;
await import('./strict-no-network.mjs');

async function listening(server, path) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
}
function connected(path) {
  return new Promise((resolve, reject) => {
    const socket = connect(path, () => { socket.end(); resolve(); });
    socket.once('error', reject);
  });
}

test('strict fixture overlay allows only the owned endpoint and denies socket escapes', async t => {
  assert.throws(() => fetch('http://127.0.0.1/'), /FIXTURE_NETWORK_FORBIDDEN/);
  assert.throws(() => connect({ host: '127.0.0.1', port: 1 }), /FIXTURE_NETWORK_FORBIDDEN/);
  const outsideRoot = await mkdtemp('/tmp/strict-outside-');
  const outsidePath = join(outsideRoot, 'bridge.sock');
  const server = createServer(socket => socket.end('ok'));
  const outside = createServer(socket => socket.end('escape'));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => outside.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });
  await listening(server, ownedPath);
  process.env.PI_DELEGATION_BRIDGE_SOCKET = ownedPath;
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.equal((await lstat(ownedPath)).mode & 0o777, 0o600);
  await connected(ownedPath);

  await listening(outside, outsidePath);
  const finalAlias = join(root, 'final.sock');
  const parentAlias = join(root, 'parent');
  await symlink(outsidePath, finalAlias);
  await symlink(outsideRoot, parentAlias);
  process.env.PI_DELEGATION_BRIDGE_SOCKET = finalAlias;
  await assert.rejects(() => connected(finalAlias), /FIXTURE_NETWORK_FORBIDDEN/);
  process.env.PI_DELEGATION_BRIDGE_SOCKET = join(parentAlias, 'bridge.sock');
  await assert.rejects(() => connected(process.env.PI_DELEGATION_BRIDGE_SOCKET), /FIXTURE_NETWORK_FORBIDDEN/);
  assert.throws(() => connect({ path: ownedPath, port: 1 }), /FIXTURE_NETWORK_FORBIDDEN/);
  assert.throws(() => connect(`${ownedPath}.suffix`), /FIXTURE_NETWORK_FORBIDDEN/);
});
