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
    const response = await exchange(socket, { ...header, requestId: 'context:1', type: 'context', args: { view: 'directory' } });
    assert.equal(response.status, 'context'); assert.equal(response.directoryRevision, 7); assert.equal(contexts, 1);
    const repeat = await exchange(socket, { ...header, requestId: 'context:1', type: 'context', args: { view: 'directory' } });
    assert.deepEqual(repeat, response); assert.equal(contexts, 1);
    const forged = await exchange(socket, { ...header, capability: 'f'.repeat(64), requestId: 'forged', type: 'context', args: { view: 'directory' } });
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
  const malformed = await exchange(socket, { schema: BRIDGE_REQUEST, capability, requestId: 'bad', type: 'context', args: { view: 'directory' }, extra: true });
  assert.equal(malformed.code, 'INVALID_REQUEST'); socket.destroy();
  assert.equal(calls, 0);
  const flood = await connected(bridge.socketPath);
  flood.write('x'.repeat(64 * 1024 + 1));
  await new Promise(resolve => setImmediate(resolve)); flood.destroy();
  await bridge.close();
});

test('bridge enforces strict context/artifact view variants at ingress', async () => {
  const bridge = await createDelegationBridge();
  try {
    const cases = [
      ['context', {}],
      ['context', { view: 'bogus' }],
      ['artifact', { view: 'artifact' }],
      ['artifact', { view: 'artifact', artifactId: 'artifact:x', limitBytes: 8193 }],
    ];
    for (let index = 0; index < cases.length; index++) {
      const [type, args] = cases[index];
      const prepared = bridge.prepare(`node${index}`, ['read']);
      const capability = JSON.parse(prepared.bootstrap.toString()).capability;
      let dispatched = 0;
      bridge.bind(`node${index}`, { directoryRevision: () => 0,
        context: async () => { dispatched++; return {}; }, artifact: async () => { dispatched++; return {}; }, disconnect() {} },
        '12345678-1234-4123-8123-123456789abc');
      const socket = await connected(bridge.socketPath);
      const header = { schema: BRIDGE_REQUEST, capability };
      assert.equal((await exchange(socket, { ...header, requestId: `hello:${index}`, type: 'hello' })).status, 'ready');
      const denied = await exchange(socket, { ...header, requestId: `bad:${index}`, type, args });
      assert.equal(denied.status, 'denied'); assert.equal(denied.code, 'INVALID_REQUEST');
      assert.equal(dispatched, 0);
      socket.destroy(); // INVALID_REQUEST is fail-stop; the record/connection die here.
    }
  } finally { await bridge.close(); }
});

test('delegate responses carry verified summaries, clip at 2048 with summaryTruncated, missing summary fails closed', async () => {
  const bridge = await createDelegationBridge();
  const prepared = bridge.prepare('node', ['workflow_delegate']);
  const capability = JSON.parse(prepared.bootstrap.toString()).capability;
  const result = { status: 'success', sha256: '0'.repeat(64), artifactId: 'artifact:x' };
  let entries = [];
  bridge.bind('node', { directoryRevision: () => 0, delegate: async () => entries, disconnect() {} },
    '12345678-1234-4123-8123-123456789abc');
  const socket = await connected(bridge.socketPath);
  try {
    const header = { schema: BRIDGE_REQUEST, capability };
    assert.equal((await exchange(socket, { ...header, requestId: 'hello', type: 'hello' })).status, 'ready');
    const args = { directoryRevision: 0, children: [{ label: 'child' }] };
    entries = [{ nodeId: 'c1', summary: 'verified child summary', result }];
    const joined = await exchange(socket, { ...header, requestId: 'delegate:1', type: 'delegate', args });
    assert.equal(joined.status, 'joined');
    assert.equal(joined.results[0].summary, 'verified child summary');
    assert.equal(joined.results[0].summaryTruncated, false);
    entries = [{ nodeId: 'c1', summary: 'x'.repeat(3000), result }];
    const clipped = await exchange(socket, { ...header, requestId: 'delegate:2', type: 'delegate', args });
    assert.equal(clipped.status, 'joined');
    assert.equal(Buffer.byteLength(clipped.results[0].summary), 2048);
    assert.equal(clipped.results[0].summaryTruncated, true);
    entries = [{ nodeId: 'c1', result }];
    const invalid = await exchange(socket, { ...header, requestId: 'delegate:3', type: 'delegate', args });
    assert.equal(invalid.status, 'denied'); assert.equal(invalid.code, 'RESULT_INVALID');
  } finally { socket.destroy(); await bridge.close(); }
});

// Large responses can arrive fragmented; accumulate to the LF delimiter.
function exchangeBuffered(socket, value) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = data => {
      buffer = Buffer.concat([buffer, data]);
      const at = buffer.indexOf(10);
      if (at < 0) return;
      socket.off('data', onData); resolve(JSON.parse(buffer.subarray(0, at)));
    };
    socket.on('data', onData); socket.once('error', reject); socket.write(`${JSON.stringify(value)}\n`);
  });
}
test('file_result frame boundary: 48942 raw bytes fit the 64KiB frame, 48943 fail closed', async () => {
  const bridge = await createDelegationBridge();
  const prepared = bridge.prepare('node', ['read']);
  const capability = JSON.parse(prepared.bootstrap.toString()).capability;
  let bytes = Buffer.alloc(0);
  // 15-digit directoryRevision: fixed response overhead is exactly 279 bytes with a
  // 128-char requestId, so the base64 budget is 65256 -> 48942 raw bytes fit, 48943 not.
  bridge.bind('node', { directoryRevision: () => 100000000000000, fileRead: async () => bytes, disconnect() {} },
    '12345678-1234-4123-8123-123456789abc');
  const socket = await connected(bridge.socketPath);
  try {
    const header = { schema: BRIDGE_REQUEST, capability };
    assert.equal((await exchange(socket, { ...header, requestId: 'hello', type: 'hello' })).status, 'ready');
    bytes = Buffer.alloc(48942, 65);
    const ok = await exchangeBuffered(socket, { ...header, requestId: 'r'.repeat(128), type: 'file_read', args: { path: 'f', maxBytes: 48942 } });
    assert.equal(ok.status, 'file_result');
    assert.equal(Buffer.from(ok.data, 'base64').length, 48942);
    bytes = Buffer.alloc(48943, 65);
    const over = await exchangeBuffered(socket, { ...header, requestId: 's'.repeat(128), type: 'file_read', args: { path: 'f', maxBytes: 48943 } });
    assert.equal(over.status, 'error'); assert.equal(over.code, 'OWNERSHIP_UNKNOWN'); // FRAME_LIMIT is not a worker-safe denial
  } finally { socket.destroy(); await bridge.close(); }
});
