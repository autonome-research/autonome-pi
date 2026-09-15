// Scoped synchronous file primitives, NOT Pi adapters, a lease grant, or a shell sandbox.
// Runtime must gate every invocation on active lane/leases (delegation-scope.leasesConflict),
// including exclusive workspace ownership for rwx. No mutable caller 'lease held' flag.
import * as fs from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeScopePath, containsPath, validateDirectoryScope } from './delegation-scope.mjs';
import { integer, object, list, text, unique, fail } from './delegation-contract.mjs';
import { canonicalDirectory, boundedRead, sameFile, sha256, storageIO } from './delegation-storage.mjs';

const MAX_FILE = 256 * 1024;
const TEMP_PREFIX = '.delegation-write-';
const within = (root, path) => path === root || path.startsWith(`${root}/`);

// The optional binding is trusted runner code, never worker options or a lease attestation.
export function createScopedFilesystem(options, { guard = () => {}, onMutationError = () => {} } = {}) {
  object(options, ['workspace', 'permissions', 'directoryScope', 'protectedDirectories']);
  if (typeof guard !== 'function' || typeof onMutationError !== 'function') fail('INVALID_REQUEST');
  let busy = false, mutated = false;
  function operation(action) {
    if (busy) fail('SCOPE_DENIED', 'nested file operation');
    busy = true; mutated = false;
    try { guard(); const value = action(); guard(); return value; }
    catch (error) { if (mutated) onMutationError(); throw error; }
    finally { busy = false; }
  }
  const mutate = action => { guard(); mutated = true; return action(); };
  const { permissions } = options;
  const workspace = canonicalDirectory(options.workspace);
  const directoryScope = validateDirectoryScope(options.directoryScope, permissions);
  list(options.protectedDirectories, 32, 1).forEach(path => {
    if (typeof path !== 'string' || !isAbsolute(path)) fail('SCOPE_DENIED', 'absolute protected directory required');
    canonicalDirectory(path);
  });
  // These lists are copies, not mutable model/runtime boolean attestations. Include the
  // actual artifact/control/profile roots even when they are outside the workspace.
  const protectedDirectories = [...options.protectedDirectories, join(workspace, '.git'), join(workspace, '.pi')];
  for (const scope of [...directoryScope.read, ...directoryScope.write]) {
    canonicalDirectory(join(workspace, scope)); // scope roots must already be real directories
    if (protectedDirectories.some(root => within(root, join(workspace, scope)))) fail('SCOPE_DENIED', 'protected scope root');
  }
  function check(path, operation, allowNew = false, allowAny = false, directory = false) {
    guard(); normalizeScopePath(path);
    if ((!directory && path === '.') || path.split('/').some(p => p.startsWith(TEMP_PREFIX))) fail('SCOPE_DENIED', 'file path');
    const absolute = join(workspace, path);
    if (!within(workspace, absolute) || protectedDirectories.some(root => within(root, absolute))) fail('SCOPE_DENIED', 'protected/outside path');
    const modes = operation === 'evidence' ? ['read', 'write'] : [operation];
    if (!modes.some(mode => permissions.includes(mode === 'read' ? 'r' : 'w') && directoryScope[mode].some(root => containsPath(root, path)))) fail('SCOPE_DENIED', 'assignment');
    canonicalDirectory(workspace);
    // No implicit mkdir: a new file needs an existing, non-symlink canonical parent.
    canonicalDirectory(dirname(absolute));
    let stat;
    try { stat = fs.lstatSync(absolute, { bigint: true }); }
    catch (error) { if (!allowNew || error.code !== 'ENOENT') throw error; }
    if (stat && ((!allowAny && !stat.isFile()) || stat.isSymbolicLink() || operation === 'write' && stat.nlink !== 1n)) fail('SCOPE_DENIED', 'nonregular/link alias');
    guard(); return { absolute, stat };
  }
  function read(path, maxBytes = MAX_FILE, operation = 'read') {
    integer(maxBytes, 0, MAX_FILE);
    const { absolute } = check(path, operation);
    return boundedRead(absolute, maxBytes, { guard });
  }
  function write(path, bytes, expected) {
    if (typeof bytes === 'string') bytes = Buffer.from(text(bytes, MAX_FILE, true));
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE) fail('SCOPE_DENIED', 'write size');
    bytes = Buffer.from(bytes);
    const target = check(path, 'write', true);
    if (expected !== undefined && (!target.stat || sha256(read(path, MAX_FILE, 'write')) !== expected)) fail('RESULT_INVALID', 'edit conflict');
    const parent = dirname(target.absolute);
    const parentStat = fs.lstatSync(parent, { bigint: true });
    const temporary = join(parent, `${TEMP_PREFIX}${randomUUID()}`);
    const io = storageIO(point => { if (point.startsWith('before:')) guard(); }); let fd;
    function ownsTemporary() {
      canonicalDirectory(parent);
      const currentParent = fs.lstatSync(parent, { bigint: true });
      let named;
      try { named = fs.lstatSync(temporary, { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      const opened = fs.fstatSync(fd, { bigint: true });
      return currentParent.dev === parentStat.dev && currentParent.ino === parentStat.ino &&
        named.dev === opened.dev && named.ino === opened.ino;
    }
    try {
      mutate(() => { fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); });
      io.writeAll(fd, bytes);
      // Preserve ordinary mode bits, never setuid/setgid/sticky bits.
      mutate(() => fs.fchmodSync(fd, target.stat ? Number(target.stat.mode & 0o777n) : 0o600));
      mutate(() => fs.fsyncSync(fd));
      const current = check(path, 'write', true);
      const currentParent = fs.lstatSync(parent, { bigint: true });
      if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino ||
          Boolean(current.stat) !== Boolean(target.stat) || target.stat && !sameFile(target.stat, current.stat)) fail('RESULT_INVALID', 'write race');
      if (!ownsTemporary()) fail('RESULT_INVALID', 'temporary replaced');
      if (target.stat) mutate(() => fs.renameSync(temporary, target.absolute));
      else {
        mutate(() => fs.linkSync(temporary, target.absolute)); // exclusive new file, no clobber
        guard();
        if (!ownsTemporary()) fail('RESULT_INVALID', 'temporary replaced');
        mutate(() => fs.unlinkSync(temporary));
      }
      guard(); io.syncDirectory(parent);
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    } finally {
      if (fd !== undefined) {
        try {
          // No pathname cleanup on lost/lent authority. Keep the descriptor pinned
          // through identity checks; never delete a replacement at our former name.
          let live = false;
          try { guard(); live = true; } catch { /* retain the ambiguous temporary */ }
          if (live && ownsTemporary()) mutate(() => fs.unlinkSync(temporary));
        } finally { fs.closeSync(fd); }
      }
    }
  }
  function directory(path) {
    const checked = check(path, 'read', false, true, true);
    if (!fs.lstatSync(checked.absolute).isDirectory()) fail('SCOPE_DENIED', 'directory required');
    return checked;
  }
  function entries(path) {
    const values = [], checked = directory(path);
    const handle = fs.opendirSync(checked.absolute);
    try {
      for (let entry; (entry = handle.readSync()) !== null;) {
        if (values.length >= 128) fail('CONTEXT_LIMIT', 'directory entries');
        if (entry.isSymbolicLink()) continue;
        values.push(entry.name);
      }
    } finally { handle.closeSync(); }
    return values.sort((a, b) => a.localeCompare(b));
  }
  function search(path, pattern, filesOnly = false) {
    text(path, 4096); text(pattern, 256, true);
    if (!pattern && !filesOnly) fail('INVALID_REQUEST', 'empty search pattern');
    const matches = [], seen = { count: 0 };
    function walk(relativePath) {
      for (const name of entries(relativePath)) {
        if (++seen.count > 128) fail('CONTEXT_LIMIT', 'search entries');
        const child = relativePath === '.' ? name : `${relativePath}/${name}`;
        const stat = fs.lstatSync(check(child, 'read', false, true).absolute);
        if (stat.isDirectory()) walk(child);
        else if (stat.isFile()) {
          if (filesOnly) matches.push(child);
          else for (const [line, value] of read(child).toString('utf8').split('\n').entries()) if (value.includes(pattern)) {
            matches.push(`${child}:${line + 1}: ${value}`);
            if (matches.length >= 100 || Buffer.byteLength(matches.join('\n')) > 8192) fail('CONTEXT_LIMIT', 'matches');
          }
        }
      }
    }
    const checked = check(path, 'read', false, true, true), root = checked.absolute, stat = fs.lstatSync(root);
    if (stat.isDirectory()) walk(path);
    else if (stat.isFile() && !filesOnly) for (const [line, value] of read(path).toString('utf8').split('\n').entries()) if (value.includes(pattern)) {
      matches.push(`${path}:${line + 1}: ${value}`);
      if (matches.length >= 100 || Buffer.byteLength(matches.join('\n')) > 8192) fail('CONTEXT_LIMIT', 'matches');
    }
    return matches.join('\n');
  }
  return Object.freeze({
    readFile: (path, maxBytes) => operation(() => read(path, maxBytes)),
    ls: path => operation(() => entries(path)),
    find: path => operation(() => search(path, '', true)),
    grep: (path, pattern) => operation(() => search(path, pattern)),
    writeFile: (path, bytes) => operation(() => write(path, bytes)),
    editFile: (path, oldText, newText) => operation(() => {
      text(oldText, MAX_FILE); text(newText, MAX_FILE, true);
      const bytes = read(path, MAX_FILE, 'write');
      const content = bytes.toString('utf8');
      if (Buffer.from(content).compare(bytes) || content.indexOf(oldText) < 0 || content.indexOf(oldText) !== content.lastIndexOf(oldText)) fail('RESULT_INVALID', 'edit requires one exact UTF-8 match');
      return write(path, content.replace(oldText, () => newText), sha256(bytes));
    }),
    snapshotEvidence: entries => operation(() => {
      list(entries, 8); unique(entries.map(e => e.label));
      let total = 0;
      const sizes = entries.map(entry => {
        object(entry, ['label', 'path', 'description']); text(entry.label, 80); text(entry.description, 512);
        if (!/^[A-Za-z0-9_-]+$/.test(entry.label)) fail('INVALID_REQUEST');
        const { stat } = check(entry.path, 'evidence');
        if (stat.size > BigInt(MAX_FILE)) fail('RESULT_INVALID', 'oversized evidence');
        total += Number(stat.size);
        if (total > 1024 * 1024) fail('RESULT_INVALID', 'node evidence bytes');
        return Number(stat.size);
      });
      return entries.map((entry, i) => {
        const bytes = read(entry.path, sizes[i], 'evidence');
        if (bytes.length !== sizes[i]) fail('RESULT_INVALID', 'evidence changed size');
        return { label: entry.label, path: relative(workspace, join(workspace, entry.path)), description: entry.description, bytes };
      });
    }),
  });
}
