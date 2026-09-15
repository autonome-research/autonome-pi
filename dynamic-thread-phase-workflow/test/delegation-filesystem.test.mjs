import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { createScopedFilesystem } from '../lib/delegation-filesystem.mjs';
import { boundedRead, canonicalDirectory, canonicalJSON, decodeCanonical, storageIO, publishStoredArtifact, readStoredArtifact } from '../lib/delegation-storage.mjs';
import { leasesConflict } from '../lib/delegation-scope.mjs';

function fixture(t, changes = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'delegation-fs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['workspace', 'workspace/src', 'workspace/src-other', 'workspace/.git', 'workspace/.pi', 'workspace/control', 'profile', 'artifacts', 'artifacts/nodes']) fs.mkdirSync(join(root, d), { mode: 0o700 });
  const options = { workspace: join(root, 'workspace'), permissions: 'rw', directoryScope: { read: ['src'], write: ['src'] },
    protectedDirectories: [join(root, 'profile'), join(root, 'artifacts'), join(root, 'workspace/control')], ...changes };
  return { root, options, scoped: createScopedFilesystem(options) };
}

test('real scoped read/write/edit: copies, byte bounds, unique exact UTF-8 edit, no mkdir', t => {
  const { root, scoped } = fixture(t);
  const bytes = Buffer.from('A😀B');
  const written = scoped.writeFile('src/file', bytes); bytes.fill(0);
  assert.equal(written.bytes, 6); assert.equal(scoped.readFile('src/file').toString(), 'A😀B');
  scoped.editFile('src/file', '😀', 'é'); assert.equal(scoped.readFile('src/file').toString(), 'AéB');
  assert.throws(() => scoped.editFile('src/file', 'absent', 'x'), /exact/);
  scoped.writeFile('src/file', 'xx'); assert.throws(() => scoped.editFile('src/file', 'x', 'y'), /exact/);
  assert.throws(() => scoped.writeFile('src/new-parent/file', 'x'), /ENOENT/);
  assert.throws(() => scoped.writeFile('src/file', Buffer.alloc(256 * 1024 + 1)), /size/);
  assert.throws(() => scoped.readFile('src/file', 1), /oversized/);
  scoped.writeFile('src/binary', Buffer.from([255])); assert.throws(() => scoped.editFile('src/binary', 'x', 'y'), /UTF-8/);
  assert.deepEqual(fs.readdirSync(join(root, 'workspace/src')).sort(), ['binary', 'file']);
});

test('component prefixes, traversal, symlink roots/ancestors/leaves, nonregular and new-file ancestors reject', t => {
  const { root, options, scoped } = fixture(t);
  fs.writeFileSync(join(root, 'workspace/src-other/secret'), 'secret');
  fs.symlinkSync('../src-other', join(root, 'workspace/src/link'));
  fs.symlinkSync('../src-other/secret', join(root, 'workspace/src/leaf'));
  fs.symlinkSync('src', join(root, 'workspace/scope-link'));
  for (const path of ['src-other/secret', '../profile/auth', '/etc/passwd', 'src/../src-other/secret', 'src//file', './src/file', 'src/link/secret', 'src/link/new', 'src/leaf', 'src']) {
    assert.throws(() => scoped.readFile(path)); assert.throws(() => scoped.writeFile(path, 'overwrite'));
  }
  assert.throws(() => createScopedFilesystem({ ...options, directoryScope: { read: ['scope-link'], write: [] } }));
  fs.symlinkSync('workspace', join(root, 'workspace-link'));
  assert.throws(() => createScopedFilesystem({ ...options, workspace: join(root, 'workspace-link') }), /noncanonical/);
  assert.equal(fs.readFileSync(join(root, 'workspace/src-other/secret'), 'utf8'), 'secret');
});

test('workspace-wide scope cannot grant control, profile, artifact, .git, .pi or temporary paths', t => {
  const { root, options } = fixture(t);
  fs.mkdirSync(join(root, 'workspace/profile'));
  const scoped = createScopedFilesystem({ ...options, directoryScope: { read: ['.'], write: ['.'] }, protectedDirectories: [...options.protectedDirectories, join(root, 'workspace/profile')] });
  for (const path of ['.git/config', '.pi/auth.json', 'control/manifest.json', 'profile/auth', 'src/.delegation-write-forged']) assert.throws(() => scoped.writeFile(path, 'x'), /SCOPE_DENIED/);
  assert.throws(() => createScopedFilesystem({ ...options, protectedDirectories: [] }));
  assert.throws(() => createScopedFilesystem({ ...options, leaseHeld: true }), /INVALID_REQUEST/);
  assert.throws(() => createScopedFilesystem({ ...options, protectedDirectories: ['../control'] }));
});

test('writable hardlinks reject without changing aliases; read-only hardlinks are not a sandbox', t => {
  const { root, scoped } = fixture(t);
  fs.writeFileSync(join(root, 'workspace/src/a'), 'original');
  fs.linkSync(join(root, 'workspace/src/a'), join(root, 'workspace/src/b'));
  assert.equal(scoped.readFile('src/a').toString(), 'original');
  assert.throws(() => scoped.writeFile('src/a', 'bad'), /link alias/);
  assert.throws(() => scoped.editFile('src/b', 'original', 'bad'), /link alias/);
  assert.equal(fs.readFileSync(join(root, 'workspace/src/b'), 'utf8'), 'original');
});

test('scope/permission objects copied; existing lease algebra remains separate and rwx exclusive', t => {
  const { root, options, scoped } = fixture(t);
  options.directoryScope.read.push('src-other'); options.directoryScope.write.push('src-other'); options.protectedDirectories.length = 0;
  fs.writeFileSync(join(root, 'workspace/src-other/a'), 'outside');
  assert.throws(() => scoped.readFile('src-other/a'), /assignment/);
  assert.throws(() => scoped.writeFile('src-other/a', 'x'), /assignment/);
  const writeOnly = createScopedFilesystem({ ...options, permissions: 'w', protectedDirectories: [join(root, 'profile')], directoryScope: { read: [], write: ['src'] } });
  writeOnly.writeFile('src/w', 'allowed'); writeOnly.editFile('src/w', 'allowed', 'edited');
  assert.throws(() => writeOnly.readFile('src/w'), /assignment/);
  const a = { permissions: 'rwx', directoryScope: { read: ['src'], write: ['src'] } };
  assert.equal(leasesConflict(a, { permissions: 'r', directoryScope: { read: ['elsewhere'], write: [] } }), true);
});

test('evidence snapshots use read OR write scope, bounded before allocation, copied and aggregate-limited', t => {
  const { root, scoped } = fixture(t);
  scoped.writeFile('src/e', 'before');
  const entries = [{ label: 'report', path: 'src/e', description: 'quoted evidence' }];
  const [snapshot] = scoped.snapshotEvidence(entries); scoped.writeFile('src/e', 'after');
  assert.equal(snapshot.bytes.toString(), 'before');
  assert.throws(() => scoped.snapshotEvidence([...entries, ...entries]), /duplicates/);
  for (let i = 0; i < 5; i++) scoped.writeFile(`src/e${i}`, Buffer.alloc(256 * 1024));
  const large = Array.from({ length: 5 }, (_, i) => ({ label: `e${i}`, path: `src/e${i}`, description: 'x' }));
  assert.throws(() => scoped.snapshotEvidence(large), /node evidence bytes/);
  fs.writeFileSync(join(root, 'workspace/src/huge'), Buffer.alloc(256 * 1024 + 1));
  assert.throws(() => scoped.snapshotEvidence([{ ...entries[0], path: 'src/huge' }]), /oversized/);
  assert.throws(() => scoped.snapshotEvidence(Array.from({ length: 9 }, (_, i) => ({ ...entries[0], label: `e${i}` }))));
});

test('private immutable publication and strict bounded loads reject replacement, links and corruption', t => {
  const { root } = fixture(t); const directory = join(root, 'artifacts'), io = storageIO();
  const ref = publishStoredArtifact(directory, Buffer.from('immutable'), io);
  const path = join(directory, 'nodes', `${ref.artifactId.slice(9)}.blob`);
  assert.equal(fs.statSync(path).mode & 0o777, 0o400);
  assert.equal(readStoredArtifact(directory, ref).toString(), 'immutable');
  assert.throws(() => readStoredArtifact(directory, { ...ref, artifactId: 'artifact:../../etc/passwd' }));
  assert.throws(() => readStoredArtifact(directory, { ...ref, sha256: '0'.repeat(64) }), /integrity/);
  assert.throws(() => io.publish(join(directory, 'nodes'), path.split('/').at(-1), Buffer.from('replace')), /EEXIST/);
  assert.equal(readStoredArtifact(directory, ref).toString(), 'immutable');
  fs.linkSync(path, join(root, 'alias')); assert.throws(() => readStoredArtifact(directory, ref), /unsafe/);
  fs.unlinkSync(join(root, 'alias')); fs.chmodSync(path, 0o644); assert.throws(() => readStoredArtifact(directory, ref), /unsafe/);
});

test('bounded descriptor reads reject oversized and nonregular files before body allocation', t => {
  const { root, scoped } = fixture(t); scoped.writeFile('src/a', 'abcd');
  const path = join(root, 'workspace/src/a');
  assert.equal(boundedRead(path, 4).toString(), 'abcd');
  assert.throws(() => boundedRead(path, 3), /oversized/);
  assert.throws(() => boundedRead(join(root, 'workspace/src'), 4), /unsafe/);
  assert.equal(canonicalDirectory(join(root, 'workspace')), join(root, 'workspace'));
});

test('canonical authority JSON rejects non-JSON, sparse, duplicate-key and alternate encodings', () => {
  assert.equal(canonicalJSON({ b: 1, a: 'é' }), '{"a":"é","b":1}');
  for (const bad of [undefined, { x: undefined }, NaN, -0, new Array(2), new Date(), '\ud800']) assert.throws(() => canonicalJSON(bad));
  const cycle = {}; cycle.x = cycle; assert.throws(() => canonicalJSON(cycle));
  for (const bytes of ['{"x":1,"x":2}', '{ "x":1}', '1e0', '"\\u0061"']) assert.throws(() => decodeCanonical(Buffer.from(bytes)));
  assert.throws(() => decodeCanonical(Buffer.from([34, 255, 34])), /invalid UTF-8/);
  assert.equal(decodeCanonical(Buffer.from('"�"')), '�');
});

test('short writes are completed, zero writes fail, same-size replacement and growth during read reject', t => {
  const { root } = fixture(t); const directory = join(root, 'artifacts');
  const originalWrite = fs.writeSync;
  const mockedWrite = t.mock.method(fs, 'writeSync', (fd, bytes, offset, length) => originalWrite(fd, bytes, offset, Math.min(length, 3)));
  const ref = publishStoredArtifact(directory, Buffer.from('multiple short writes'), storageIO());
  assert.ok(mockedWrite.mock.callCount() > 1); assert.equal(readStoredArtifact(directory, ref).toString(), 'multiple short writes');
  mockedWrite.mock.mockImplementation(() => 0);
  assert.throws(() => publishStoredArtifact(directory, Buffer.from('cannot write'), storageIO()), /short write/);
  mockedWrite.mock.restore();
  const path = join(root, 'workspace/src/read'); fs.writeFileSync(path, 'abcd');
  const originalRead = fs.readSync; let changed = false;
  const mockedRead = t.mock.method(fs, 'readSync', (...args) => {
    const result = originalRead(...args);
    if (!changed) { changed = true; fs.writeFileSync(path, 'growing'); }
    return result;
  });
  assert.throws(() => boundedRead(path, 10), /changed during read/);
  mockedRead.mock.restore(); fs.writeFileSync(path, 'abcd'); changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const result = originalRead(...args);
    if (!changed) { changed = true; fs.writeFileSync(`${path}.new`, 'abcd'); fs.renameSync(`${path}.new`, path); }
    return result;
  });
  assert.throws(() => boundedRead(path, 4), /changed during read/);
});

test('bound file operations deny preparation loss and partial-read siblings without stale delivery', t => {
  for (const kind of ['write', 'edit', 'read', 'evidence']) for (const cut of ['path', 'read']) {
    if (kind === 'write' && cut === 'read') continue;
    const { root, options } = fixture(t);
    fs.writeFileSync(join(root, 'workspace/src/file'), 'original');
    let live = true, fired = false, reads = 0, ambiguous = 0;
    const scoped = createScopedFilesystem(options, { guard() { assert.ok(live, 'original authority lost'); }, onMutationError() { ambiguous++; } });
    const method = cut === 'path' ? 'realpathSync' : 'readSync', original = fs[method];
    const mock = t.mock.method(fs, method, (...args) => {
      const value = cut === 'read' ? original(args[0], args[1], args[2], 1, args[4]) : original(...args);
      if (cut === 'read') reads++;
      if (!fired) { fired = true; live = false; }
      return value;
    });
    try {
      assert.throws(() => kind === 'write' ? scoped.writeFile('src/file', 'changed') : kind === 'edit' ? scoped.editFile('src/file', 'original', 'changed') :
        kind === 'read' ? scoped.readFile('src/file') : scoped.snapshotEvidence([{ label: 'e', path: 'src/file', description: 'e' }]), /original authority lost/);
    } finally { mock.mock.restore(); }
    assert.equal(fired, true); assert.equal(ambiguous, 0); assert.equal(reads, cut === 'read' ? 1 : 0);
    assert.equal(fs.readFileSync(join(root, 'workspace/src/file'), 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(join(root, 'workspace/src')), ['file']);
  }
});

test('bound write/edit actions retain ambiguity and exact temporaries after partial write or acknowledgement loss', t => {
  for (const kind of ['write', 'edit']) for (const cut of ['writeSync', 'fchmodSync', 'renameSync', 'closeSync']) {
    const { root, options } = fixture(t);
    fs.writeFileSync(join(root, 'workspace/src/file'), 'original');
    let live = true, fired = false, ambiguous = 0, writes = 0;
    const scoped = createScopedFilesystem(options, { guard() { assert.ok(live, 'original authority lost'); }, onMutationError() { ambiguous++; } });
    const original = fs[cut], write = fs.writeSync;
    const mock = t.mock.method(fs, cut, (...args) => {
      const directoryClose = cut === 'closeSync' && fs.fstatSync(args[0]).isDirectory();
      const value = cut === 'writeSync' ? original(args[0], args[1], args[2], 1) : original(...args);
      if (cut === 'writeSync') writes++;
      if (!fired && (cut !== 'closeSync' || directoryClose)) { fired = true; live = false; }
      return value;
    });
    syncBuiltinESMExports();
    try { assert.throws(() => kind === 'write' ? scoped.writeFile('src/file', 'changed') : scoped.editFile('src/file', 'original', 'changed'), /original authority lost/); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(fired, true); assert.equal(ambiguous, 1);
    const published = ['renameSync', 'closeSync'].includes(cut);
    assert.equal(fs.readFileSync(join(root, 'workspace/src/file'), 'utf8'), published ? 'changed' : 'original');
    const temps = fs.readdirSync(join(root, 'workspace/src')).filter(p => p.startsWith('.delegation-write-'));
    assert.equal(temps.length, published ? 0 : 1);
    if (cut === 'writeSync') { assert.equal(writes, 1); assert.equal(fs.statSync(join(root, 'workspace/src', temps[0])).size, 1); }
    assert.equal(fs.writeSync, write);
  }
});

test('temporary cleanup never deletes a replacement or an unowned failed-open pathname; nested calls denied', t => {
  for (const cut of ['openSync', 'fchmodSync']) {
    const { root, options } = fixture(t); let replacement, nested = false;
    const scoped = createScopedFilesystem(options);
    const original = fs[cut];
    const mock = t.mock.method(fs, cut, (...args) => {
      if (cut === 'openSync' && typeof args[0] === 'string' && args[0].includes('.delegation-write-')) {
        replacement = args[0];
        const foreign = original(replacement, 'wx');
        try { fs.writeSync(foreign, 'foreign'); } finally { fs.closeSync(foreign); }
        return original(...args); // EEXIST, no owned descriptor
      }
      const value = original(...args);
      if (cut === 'fchmodSync') {
        assert.throws(() => scoped.writeFile('src/nested', 'bad'), /nested file operation/); nested = true;
        replacement = join(root, 'workspace/src', fs.readdirSync(join(root, 'workspace/src')).find(p => p.startsWith('.delegation-write-')));
        fs.unlinkSync(replacement); fs.writeFileSync(replacement, 'foreign');
        throw Error('RESULT_INVALID: mutation error must not become a safe denial');
      }
      return value;
    });
    syncBuiltinESMExports();
    try { assert.throws(() => scoped.writeFile('src/file', 'changed')); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(fs.readFileSync(replacement, 'utf8'), 'foreign'); assert.equal(fs.existsSync(join(root, 'workspace/src/file')), false);
    assert.equal(nested, cut === 'fchmodSync');
  }
});

test('scoped ls/find/grep are bounded, text-valued, and no-follow', t => {
  const { root, scoped } = fixture(t);
  fs.mkdirSync(join(root, 'workspace/src/nested'));
  fs.writeFileSync(join(root, 'workspace/src/a.txt'), 'NEEDLE allowed\n');
  fs.writeFileSync(join(root, 'workspace/src/nested/b.txt'), 'other\n');
  assert.deepEqual(scoped.ls('src'), ['a.txt', 'nested']);
  assert.equal(scoped.find('src'), 'src/a.txt\nsrc/nested/b.txt');
  assert.equal(scoped.grep('src', 'NEEDLE'), 'src/a.txt:1: NEEDLE allowed');
  fs.symlinkSync('../src-other', join(root, 'workspace/src/link'));
  assert.throws(() => scoped.ls('src/link'), /nonregular\/link alias/);
  assert.doesNotMatch(scoped.find('src'), /src\/link/);
  for (let i = 0; i < 128; i++) fs.writeFileSync(join(root, 'workspace/src', `bounded-${i}`), 'x');
  assert.throws(() => scoped.ls('src'), /directory entries/);
});
