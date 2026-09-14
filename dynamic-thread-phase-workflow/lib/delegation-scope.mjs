// Pure lexical policy only. Callers must supply verified canonical filesystem facts.
// No realpath, link-race protection, process ownership or shell sandbox is provided.
const permissionTools = Object.freeze({
  r: ['read', 'grep', 'find', 'ls'], w: ['edit', 'write'],
  rw: ['read', 'grep', 'find', 'ls', 'edit', 'write'],
  rwx: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'],
});
function deny(message) { throw new Error(`SCOPE_DENIED: ${message}`); }
export function normalizeScopePath(path) {
  if (typeof path !== 'string' || !path || !path.trim() || Buffer.from(path).toString('utf8') !== path || Buffer.byteLength(path) > 256 ||
      /[\\\x00-\x1f\x7f*?\[\]{}$`]/u.test(path) || path.startsWith('/') || /^[A-Za-z]:/u.test(path)) deny('invalid path');
  if (path === '.') return path;
  if (path.split('/').some(part => !part || part === '.' || part === '..')) deny('noncanonical path');
  return path;
}
export function containsPath(parent, child) {
  parent = normalizeScopePath(parent); child = normalizeScopePath(child);
  return parent === '.' || parent === child || child.startsWith(`${parent}/`);
}
export function validatePermissions(value) {
  if (!Object.hasOwn(permissionTools, value) || typeof value !== 'string') deny('invalid permissions');
  return value;
}
export function validateDirectoryScope(scope, permissions) {
  if (!scope || Object.getPrototypeOf(scope) !== Object.prototype ||
      Reflect.ownKeys(scope).length !== 2 || !Object.hasOwn(scope, 'read') || !Object.hasOwn(scope, 'write')) deny('invalid scope');
  for (const key of ['read', 'write']) {
    if (!Array.isArray(scope[key]) || scope[key].length > 8 || Reflect.ownKeys(scope[key]).length !== scope[key].length + 1 || Array.from({ length: scope[key].length }, (_, i) => i).some(i => !Object.hasOwn(scope[key], i))) deny('path count');
    scope[key].forEach(normalizeScopePath);
    if (new Set(scope[key]).size !== scope[key].length) deny('duplicate path');
  }
  if (permissions !== undefined) {
    validatePermissions(permissions);
    if (permissions.includes('r') && !scope.read.length || permissions.includes('w') && !scope.write.length) deny('missing capability scope');
  }
  return structuredClone(scope);
}
export function narrowScope(parent, child) {
  validateDirectoryScope(parent); validateDirectoryScope(child);
  for (const key of ['read', 'write']) {
    if (!child[key].every(path => parent[key].some(root => containsPath(root, path)))) deny('scope expansion');
  }
  return structuredClone(child);
}
export function intersectTools(permissions, inheritedTools) {
  validatePermissions(permissions);
  if (!Array.isArray(inheritedTools) || inheritedTools.some(t => typeof t !== 'string') || new Set(inheritedTools).size !== inheritedTools.length) deny('invalid tools');
  return permissionTools[permissions].filter(tool => inheritedTools.includes(tool));
}
export function narrowAuthority(parent, child, acceptedAt) {
  validatePermissions(parent.permissions); validatePermissions(child.permissions);
  if (![...child.permissions].every(p => parent.permissions.includes(p))) deny('permission expansion');
  validateDirectoryScope(parent.directoryScope, parent.permissions);
  validateDirectoryScope(child.directoryScope, child.permissions);
  narrowScope(parent.directoryScope, child.directoryScope);
  if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0 ||
      parent.deadlineAt !== null && (!Number.isSafeInteger(parent.deadlineAt) || parent.deadlineAt < 0)) deny('invalid time');
  let deadlineAt = parent.deadlineAt;
  if (child.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(child.timeoutMs) || child.timeoutMs < 1 || child.timeoutMs > 3_600_000 || !Number.isSafeInteger(acceptedAt + child.timeoutMs)) deny('invalid timeout');
    deadlineAt = Math.min(deadlineAt ?? Infinity, acceptedAt + child.timeoutMs);
  }
  if (deadlineAt !== null && deadlineAt <= acceptedAt) deny('expired deadline');
  return { permissions: child.permissions, directoryScope: structuredClone(child.directoryScope),
    grantedTools: intersectTools(child.permissions, parent.grantedTools), deadlineAt };
}
export function leasesConflict(a, b) {
  validatePermissions(a.permissions); validatePermissions(b.permissions);
  validateDirectoryScope(a.directoryScope, a.permissions); validateDirectoryScope(b.directoryScope, b.permissions);
  if (a.permissions.includes('x') || b.permissions.includes('x')) return true;
  const reads = x => x.permissions.includes('r') ? x.directoryScope.read : [];
  const writes = x => x.permissions.includes('w') ? x.directoryScope.write : [];
  const overlaps = (xs, ys) => xs.some(x => ys.some(y => containsPath(x, y) || containsPath(y, x)));
  return overlaps(writes(a), [...reads(b), ...writes(b)]) || overlaps(writes(b), reads(a));
}
export function validateScopedPathFacts({ path, operation, permissions, directoryScope, protectedPaths,
  canonical, symlink, regularFile, linkCount }) {
  normalizeScopePath(path); validateDirectoryScope(directoryScope, permissions);
  if (!['read', 'write'].includes(operation) || !permissions.includes(operation === 'read' ? 'r' : 'w')) deny('operation');
  if (canonical !== true || symlink !== false || regularFile !== true || !Number.isSafeInteger(linkCount) || linkCount < 1 || operation === 'write' && linkCount !== 1) deny('unsafe file facts');
  if (!Array.isArray(protectedPaths) || protectedPaths.some(root => containsPath(root, path))) deny('protected path');
  if (!directoryScope[operation].some(root => containsPath(root, path))) deny('outside scope');
  return path;
}
