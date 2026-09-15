import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDelegationBridge, BRIDGE_REQUEST } from '../lib/delegation-bridge.mjs';

function exchange(socket, value) {
  return new Promise((resolve, reject) => {
    const line = `${JSON.stringify(value)}\n`;
    const onData = data => {
      const at = data.indexOf(10);
      if (at < 0) return;
      socket.off('data', onData); resolve(JSON.parse(data.subarray(0, at)));
    };
    socket.on('data', onData); socket.once('error', reject); socket.write(line);
  });
}
async function connected(path) { const socket = connect(path); await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }); return socket; }

test('bridge keeps its pathname within Linux Unix-domain bounds and its directory private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-path-'));
  await mkdir(join(root, 'tmp'));
  const bridge = await createDelegationBridge({ tmpDir: join(root, 'tmp') });
  try {
    assert.ok(Buffer.byteLength(bridge.socketPath) <= 107);
    assert.equal((await stat(join(root, 'tmp'))).mode & 0o777, 0o700);
    assert.equal((await stat(bridge.socketPath)).mode & 0o777, 0o600);
  } finally { await bridge.close(); await rm(root, { recursive: true, force: true }); }
});

test('private bridge binds capability and routes only the original handle', async () => {
  const bridge = await createDelegationBridge();
  const prepared = bridge.prepare('node', ['read']);
  const bootstrap = JSON.parse(prepared.bootstrap.toString());
  let contexts = 0, disconnected = 0;
  const handle = { directoryRevision: () => 7, context: async () => { contexts++; return { schema: 'pi-workflow-delegation-context/v1', ownChildJoinIndex: { artifactId: 'artifact:index', revision: 7, bytes: 0, sha256: '0'.repeat(64), childCount: 0 } }; }, disconnect: () => { disconnected++; } };
  bridge.bind('node', handle, '12345678-1234-4123-8123-123456789abc');
  const socket = await connected(bridge.socketPath);
  try {
    const header = { schema: BRIDGE_REQUEST, capability: bootstrap.capability };
    assert.equal((await exchange(socket, { ...header, requestId: 'hello', type: 'hello' })).status, 'ready');
    const response = await exchange(socket, { ...header, requestId: 'context:1', type: 'context', args: {} });
    assert.equal(response.status, 'context'); assert.equal(response.directoryRevision, 7); assert.equal(contexts, 1);
    const repeat = await exchange(socket, { ...header, requestId: 'context:1', type: 'context', args: {} });
    assert.deepEqual(repeat, response); assert.equal(contexts, 1);
    const forged = await exchange(socket, { ...header, capability: 'f'.repeat(64), requestId: 'forged', type: 'context', args: {} });
    assert.equal(forged.status, 'error'); assert.equal(forged.code, 'OWNERSHIP_UNKNOWN');
  } finally { socket.destroy(); await bridge.close(); }
  assert.equal(disconnected, 1);
});

test('bridge rejects unknown fields and bounded malformed frames without dispatch', async () => {
  const bridge = await createDelegationBridge({ maxConnections: 4, maxActive: 2 });
  const prepared = bridge.prepare('node', ['read']); const capability = JSON.parse(prepared.bootstrap.toString()).capability;
  let calls = 0;
  bridge.bind('node', { directoryRevision: () => 0, context: async () => { calls++; return {}; }, disconnect() {} }, '12345678-1234-4123-8123-123456789abc');
  const socket = await connected(bridge.socketPath);
  const malformed = await exchange(socket, { schema: BRIDGE_REQUEST, capability, requestId: 'bad', type: 'context', args: {}, extra: true });
  assert.equal(malformed.code, 'INVALID_REQUEST'); socket.destroy();
  assert.equal(calls, 0);
  const flood = await connected(bridge.socketPath);
  flood.write('x'.repeat(64 * 1024 + 1));
  await new Promise(resolve => setImmediate(resolve)); flood.destroy();
  await bridge.close();
});
