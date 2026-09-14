import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScopePath, containsPath, validateDirectoryScope, narrowScope, intersectTools, narrowAuthority,
  leasesConflict, validateScopedPathFacts } from '../lib/delegation-scope.mjs';
const scope = { read: ['src', 'test'], write: ['src'] };
const parent = { permissions: 'rwx', directoryScope: scope, grantedTools: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'], deadlineAt: 2000 };

test('component containment and canonical POSIX declarations reject adversarial paths', () => {
  for (const path of ['', ' ', '/etc', '../src', 'src/../etc', 'src/./x', 'src//x', 'src/', './src', 'C:/tmp', 'src\\x', 'src\0x', 'src\nx', '*', 'src/[a]', '${HOME}', '{{x}}', '`cmd`', 'x'.repeat(257), '\ud800']) assert.throws(() => normalizeScopePath(path), /SCOPE/);
  assert.equal(normalizeScopePath('.'), '.'); assert.equal(normalizeScopePath('src/日本語'), 'src/日本語');
  assert.equal(containsPath('src', 'src/a'), true); assert.equal(containsPath('src', 'src-other'), false);
  assert.equal(containsPath('src/a', 'src/ab'), false); assert.equal(containsPath('.', 'src'), true);
  assert.equal(containsPath('src', '.'), false);
  validateDirectoryScope({ read: Array.from({ length: 8 }, (_, i) => `${i}${'x'.repeat(255)}`), write: [] }, 'r');
  for (const s of [{ read: [], write: [] }, { read: ['src', 'src'], write: [] }, { read: Array(9).fill('src'), write: [] }, { read: new Array(1), write: [] }, { read: ['src'], write: [], cwd: '.' }]) assert.throws(() => validateDirectoryScope(s, 'r'));
});

test('permission/tool/scope/deadline narrowing is monotonic, no authority from summary text', () => {
  const child = { permissions: 'rw', directoryScope: { read: ['src/parser'], write: ['src/parser'] }, timeoutMs: 500 };
  const result = narrowAuthority(parent, child, 1000);
  assert.equal(result.deadlineAt, 1500); assert.ok(!result.grantedTools.includes('bash'));
  assert.deepEqual(intersectTools('r', ['read', 'bash', 'unknown']), ['read']);
  assert.throws(() => narrowAuthority({ ...parent, permissions: 'r' }, child, 1000));
  assert.throws(() => narrowScope(scope, { read: ['src-other'], write: [] }));
  assert.throws(() => narrowScope(scope, { read: ['src'], write: ['test'] }));
  assert.equal(narrowAuthority(parent, { ...child, timeoutMs: 3000 }, 1000).deadlineAt, 2000);
  const noDeadline = { ...parent, deadlineAt: null }; const inherited = { permissions: 'r', directoryScope: { read: ['src'], write: [] } };
  assert.equal(narrowAuthority(noDeadline, inherited, 1000).deadlineAt, null);
  assert.equal(narrowAuthority(noDeadline, { ...inherited, timeoutMs: 1 }, 1000).deadlineAt, 1001);
  assert.equal(narrowAuthority(parent, inherited, 1000).deadlineAt, 2000);
  for (const now of [2000, 2001, -1, '1000']) assert.throws(() => narrowAuthority(parent, inherited, now));
  assert.throws(() => narrowAuthority(noDeadline, { ...inherited, timeoutMs: 1 }, Number.MAX_SAFE_INTEGER));
  assert.throws(() => narrowAuthority({ ...parent, deadlineAt: undefined }, inherited, 1000));
  const grandchild = narrowAuthority({ ...result, grantedTools: result.grantedTools }, { permissions: 'r', directoryScope: { read: ['src/parser/tokens'], write: [] }, timeoutMs: 1000 }, 1100);
  assert.equal(grandchild.deadlineAt, 1500);
});

test('lease conflicts are symmetric: overlapping reads share, write/read and shell serialize', () => {
  const read = path => ({ permissions: 'r', directoryScope: { read: [path], write: [] } });
  const write = path => ({ permissions: 'w', directoryScope: { read: [], write: [path] } });
  for (const [a, b, expected] of [[read('src'), read('src/a'), false], [write('src'), read('src/a'), true], [read('src'), write('src/a'), true],
    [write('src'), write('src-other'), false], [write('src'), write('src/a'), true], [parent, read('outside'), true]]) {
    assert.equal(leasesConflict(a, b), expected); assert.equal(leasesConflict(b, a), expected);
  }
});

test('filesystem facts fail closed; supplied facts do not constitute filesystem verification or shell confinement', () => {
  const facts = { path: 'src/file', operation: 'write', permissions: 'rw', directoryScope: scope,
    protectedPaths: ['src/control', 'delegation'], canonical: true, symlink: false, regularFile: true, linkCount: 1 };
  assert.equal(validateScopedPathFacts(facts), 'src/file');
  for (const change of [{ canonical: false }, { symlink: true }, { regularFile: false }, { linkCount: 2 }, { linkCount: undefined },
    { path: 'src/control/auth' }, { path: 'src-other/file' }, { permissions: 'r' }, { protectedPaths: undefined }, { operation: 'bash' }]) assert.throws(() => validateScopedPathFacts({ ...facts, ...change }));
  assert.equal(validateScopedPathFacts({ ...facts, operation: 'read', linkCount: 2 }), 'src/file');
});
