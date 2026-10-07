#!/usr/bin/env node
// Removal/package-surface check for the mission-workflow removal.
// Verifies: six valid manifest extension entries, no mission imports/links in
// active source, no mission tool/command registration when the six extensions
// are loaded, dependency surface free of fleet-router, fast-uri floor patched,
// and an isolated real Pi load of the package. Exits 1 on any failure.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
let failures = 0;
function log(ok, name, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// 1. Manifest: exactly six extension entries, all present, none mission.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entries = pkg.pi?.extensions || [];
log(entries.length === 6, 'manifest lists exactly six extensions', JSON.stringify(entries));
log(entries.every((entry) => !/mission/i.test(entry)), 'no manifest entry references missions');
log(entries.every((entry) => existsSync(join(root, entry))), 'every manifest extension entry exists on disk');

// 2. Deleted mission implementation/docs/skill paths are gone.
const deletedPaths = [
  'mission-workflow',
  'skills/mission-workflow',
  'docs/mission-kernel-design.md',
  'docs/mission-workflow-completeness-roadmap.md',
  'docs/mission-workflow-continuation.md',
  'docs/mission-workflow-refactor-roadmap.md',
];
log(deletedPaths.every((p) => !existsSync(join(root, p))), 'deleted mission implementation/skill/doc paths are absent');

// 3. No active tracked source imports/links deleted mission files.
// Historical release notes and this check itself are exempt by design.
const exempt = (f) => f.startsWith('docs/releases/') || f === 'scripts/check-removal.mjs';
let tracked;
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
} catch {
  // Snapshot without .git: walk the tree instead.
  tracked = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else tracked.push(full.slice(root.length + 1));
    }
  };
  walk(root);
}
const offenders = [];
for (const file of tracked) {
  if (exempt(file)) continue;
  let text;
  try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
  if (/mission-workflow\//.test(text) || /fleet-router/.test(text)) offenders.push(file);
}
log(offenders.length === 0, 'no active tracked file imports or links deleted mission paths', offenders.join(', '));

// 4. Dependency surface: no fleet-router, fast-uri override floor patched, lock consistent.
log(!pkg.dependencies?.['@autonome-research/fleet-router'], 'fleet-router dependency removed from package.json');
log(pkg.overrides?.['fast-uri'] === '>=3.1.8 <4.0.0', 'fast-uri override floor raised above vulnerable range', pkg.overrides?.['fast-uri']);
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const lockFastUri = Object.entries(lock.packages || {}).filter(([k]) => /(^|\/)fast-uri$/.test(k));
log(lockFastUri.length > 0 && lockFastUri.every(([, v]) => v.version === '3.1.8'), 'every locked fast-uri occurrence is 3.1.8', JSON.stringify(lockFastUri.map(([k, v]) => [k, v.version])));
log(!Object.keys(lock.packages || {}).some((k) => k.includes('fleet-router')), 'lockfile has no fleet-router entries');

// 5. Load all six extensions with a recording ExtensionAPI stub; no mission tool/command.
const record = { tools: [], commands: [] };
const stubPi = new Proxy({
  registerTool: (tool) => { record.tools.push(tool?.name); },
  registerCommand: (name) => { record.commands.push(name); },
}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    return () => undefined;
  },
});
let loadError;
for (const entry of entries) {
  try {
    const mod = await import(pathToFileURL(join(root, entry)).href);
    if (typeof mod.default !== 'function') throw new Error('no default extension export');
    mod.default(stubPi);
  } catch (error) {
    loadError = `${entry}: ${error?.message || error}`;
  }
}
log(!loadError, 'all six extension entry points load and register without error', loadError || '');
log(record.tools.length > 0 && record.tools.every(Boolean), 'extension tools registered', JSON.stringify(record.tools));
log(![...record.tools, ...record.commands].some((name) => /mission/i.test(String(name))), 'no mission tool or command registered');

// 6. Real Pi loads the package offline with isolated HOME/agent dir.
const tmp = mkdtempSync(join(tmpdir(), 'autonome-removal-check-'));
// Prefer the actual installed Pi on PATH (1.0.x); fall back to the devDependency copy.
const pathPi = spawnSync('pi', ['--version'], { encoding: 'utf8' });
const piBin = pathPi.status === 0 ? 'pi' : join(root, 'node_modules', '.bin', 'pi');
const piResult = spawnSync(piBin, ['--no-extensions', '-e', root, '--list-models'], {
  cwd: root,
  env: { PATH: process.env.PATH, HOME: join(tmp, 'home'), PI_CODING_AGENT_DIR: join(tmp, 'agent'), TMPDIR: tmp, PI_OFFLINE: '1' },
  encoding: 'utf8',
  timeout: 60_000,
});
log(piResult.status === 0, 'isolated Pi load of the package exits 0', (piResult.stderr || '').slice(0, 300));
rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} removal check(s) failed.`);
  process.exit(1);
}
console.log('\nAll removal/package-surface checks passed.');
