// Internal POSIX storage primitives. No launch/resume authority. Same-user code is not contained.
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, join, dirname, parse } from 'node:path';
import { fail, integer, object, hash } from './delegation-contract.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonicalJSON(value) {
  const seen = new Set();
  function encode(v, depth) {
    if (depth > 32) fail('INVALID_REQUEST', 'JSON depth');
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number') { if (!Number.isFinite(v) || Object.is(v, -0)) fail('INVALID_REQUEST'); return JSON.stringify(v); }
    if (typeof v === 'string') { if (Buffer.from(v).toString('utf8') !== v || v.includes('\0')) fail('INVALID_REQUEST'); return JSON.stringify(v); }
    if (!v || typeof v !== 'object' || seen.has(v)) fail('INVALID_REQUEST', 'JSON value');
    seen.add(v);
    let result;
    if (Array.isArray(v)) {
      if (Reflect.ownKeys(v).length !== v.length + 1 || Array.from({ length: v.length }, (_, i) => i).some(i => !Object.hasOwn(v, i))) fail('INVALID_REQUEST');
      result = `[${v.map(x => encode(x, depth + 1)).join(',')}]`;
    } else {
      object(v, Object.keys(v));
      result = `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${encode(v[k], depth + 1)}`).join(',')}}`;
    }
    seen.delete(v); return result;
  }
  return encode(value, 0);
}
export function decodeCanonical(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) fail('OWNERSHIP_UNKNOWN', 'invalid UTF-8');
  const value = JSON.parse(text);
  if (canonicalJSON(value) !== text) fail('OWNERSHIP_UNKNOWN', 'noncanonical JSON');
  return value;
}
export function canonicalDirectory(path, privateDirectory = false) {
  if (process.platform === 'win32' || !fs.constants.O_NOFOLLOW) fail('UNSUPPORTED_MODE', 'POSIX nofollow required');
  if (typeof path !== 'string' || resolve(path) !== path || fs.realpathSync(path) !== path) fail('SCOPE_DENIED', 'noncanonical directory');
  let at = parse(path).root;
  for (const part of path.slice(at.length).split('/').filter(Boolean)) {
    at = join(at, part);
    const stat = fs.lstatSync(at);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SCOPE_DENIED', 'directory link');
  }
  const stat = fs.lstatSync(path);
  if (privateDirectory && (stat.uid !== process.getuid() || (stat.mode & 0o077))) fail('OWNERSHIP_UNKNOWN', 'private directory ownership');
  return path;
}
export function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}
export function boundedRead(path, maxBytes, { privateFile = false, guard = () => {} } = {}) {
  integer(maxBytes, 0, 16 * 1024 * 1024);
  if (typeof guard !== 'function') fail('INVALID_REQUEST');
  guard(); canonicalDirectory(dirname(path), privateFile); guard();
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes) || privateFile &&
        (before.nlink !== 1n || before.uid !== BigInt(process.getuid()) || (before.mode & 0o077n))) fail('OWNERSHIP_UNKNOWN', 'unsafe or oversized file');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      guard();
      const n = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (size !== Number(before.size) || !sameFile(before, after) || !sameFile(after, fs.lstatSync(path, { bigint: true }))) fail('OWNERSHIP_UNKNOWN', 'file changed during read');
    guard(); return buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
}
// Fault hook is trusted test instrumentation, never persisted and never a worker parameter.
export function storageIO(fault = () => {}) {
  const step = (name, action) => { fault(`before:${name}`); const value = action(); fault(`after:${name}`); return value; };
  const syncDirectory = path => {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { step('directory-fsync', () => fs.fsyncSync(fd)); } finally { fs.closeSync(fd); }
  };
  const writeAll = (fd, bytes) => {
    let offset = 0;
    while (offset < bytes.length) {
      const n = step('write', () => fs.writeSync(fd, bytes, offset, bytes.length - offset));
      if (!Number.isSafeInteger(n) || n <= 0) fail('PERSISTENCE_FAILED', 'short write');
      offset += n;
    }
  };
  function publish(directory, name, bytes, immutable = true) {
    canonicalDirectory(directory, true);
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(name)) fail('INVALID_REQUEST', 'storage name');
    const temporary = join(directory, `${randomUUID()}.tmp`);
    let fd;
    // On failure retain all ambiguous files; never overwrite/retry/reclaim an immutable target.
    try {
      step('temporary-open', () => { fd = fs.openSync(temporary, 'wx', 0o600); });
      writeAll(fd, bytes);
      if (immutable) step('file-chmod', () => fs.fchmodSync(fd, 0o400));
      step('file-fsync', () => fs.fsyncSync(fd));
      step('file-close', () => { fs.closeSync(fd); fd = undefined; });
      if (immutable) {
        step('publish-link', () => fs.linkSync(temporary, join(directory, name)));
        step('temporary-unlink', () => fs.unlinkSync(temporary));
      } else step('projection-rename', () => fs.renameSync(temporary, join(directory, name)));
      syncDirectory(directory);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return { step, syncDirectory, writeAll, publish };
}
export function validateStoredReference(ref) {
  object(ref, ['artifactId', 'bytes', 'sha256']);
  if (!/^artifact:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ref.artifactId)) fail('INVALID_REQUEST', 'generated artifact ID');
  integer(ref.bytes, 0, 1024 * 1024); hash(ref.sha256); return ref;
}
export function readStoredArtifact(directory, reference) {
  validateStoredReference(reference);
  const bytes = boundedRead(join(directory, 'nodes', `${reference.artifactId.slice(9)}.blob`), 1024 * 1024, { privateFile: true });
  if (bytes.length !== reference.bytes || sha256(bytes) !== reference.sha256) fail('RESULT_INVALID', 'artifact integrity');
  return bytes;
}
export function publishStoredArtifact(directory, bytes, io) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024) fail('RESULT_INVALID', 'artifact bytes');
  const uuid = randomUUID();
  io.publish(join(directory, 'nodes'), `${uuid}.blob`, bytes);
  return { artifactId: `artifact:${uuid}`, bytes: bytes.length, sha256: sha256(bytes) };
}
