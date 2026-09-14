// FIXTURE ONLY, deliberately narrow: text read + literal recursive grep, no spawned search.
// Not the future production filesystem adapter. No cross-process leases or hostile-race claim.
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeScopePath, containsPath } from '../../../lib/delegation-scope.mjs';
export function scopedFiles(cwd) {
  async function check(path) {
    normalizeScopePath(path);
    if (!containsPath('allowed', path)) throw new Error('SCOPE_DENIED');
    let current = cwd;
    for (const part of path.split('/')) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('SCOPE_DENIED: symlink');
    }
    return current;
  }
  async function read(path) {
    const absolute = await check(path);
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 262144) throw new Error('SCOPE_DENIED: file');
      const buffer = Buffer.alloc(262145);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 262144) throw new Error('SCOPE_DENIED: size');
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
  }
  async function grep({ path, pattern, literal }) {
    if (literal !== true || typeof pattern !== 'string' || !pattern || Buffer.byteLength(pattern) > 256) throw new Error('UNSUPPORTED_MODE: fixture literal grep only');
    const matches = []; let visited = 0;
    async function walk(relative) {
      if (++visited > 128) throw new Error('CONTEXT_LIMIT: search entries');
      const absolute = await check(relative); const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        // Limit entry allocation as well as recursion (unlike readdir + post-size check).
        const entries = []; const dir = await opendir(absolute);
        for await (const entry of dir) { if (entries.length >= 128) throw new Error('CONTEXT_LIMIT'); entries.push(entry); }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.isSymbolicLink()) continue; // no link traversal, no match content exposure
          await walk(`${relative}/${entry.name}`);
        }
      } else {
        const lines = (await read(relative)).split('\n');
        for (let i = 0; i < lines.length; i++) if (lines[i].includes(pattern)) {
          matches.push(`${relative}:${i + 1}: ${lines[i]}`);
          if (matches.length > 100 || Buffer.byteLength(matches.join('\n')) > 8192) throw new Error('CONTEXT_LIMIT: matches');
        }
      }
    }
    await walk(path); return matches.join('\n');
  }
  return { read, grep };
}
