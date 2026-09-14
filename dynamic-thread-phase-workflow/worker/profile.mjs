// Private profile primitives, disconnected from host/manifest. Not launch authorization.
// No provider/auth discovery or staging is implemented here.
import { dirname, isAbsolute, join } from 'node:path';

export function workerEnvironment({ home, agentDir, storeDir, sessionDir, tmpDir, nodePath }) {
  for (const path of [home, agentDir, storeDir, sessionDir, tmpDir, nodePath]) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('PROFILE_UNAVAILABLE');
  }
  // Deliberately do not accept/spread process.env. PATH excludes user launch wrappers.
  return {
    PATH: `${dirname(nodePath)}:/usr/bin:/bin`, HOME: home, TMPDIR: tmpDir,
    PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_THREAD_PHASE_STORE_DIR: storeDir,
    PI_DYNAMIC_WORKFLOW_BACKGROUND: '', PI_DYNAMIC_THREAD_PHASE_BACKGROUND: '',
    PI_THREAD_PHASE_STATUS_BRIDGE: '0', PI_THREAD_PHASE_TERMINAL_TITLE: '0',
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
  };
}

export function isolatedResourceOptions() {
  return { noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true };
}

export function assertToolProfile(active, configured, expected) {
  const names = Object.keys(expected).sort();
  if (JSON.stringify([...active].sort()) !== JSON.stringify(names) ||
      JSON.stringify(configured.map(t => t.name).sort()) !== JSON.stringify(names)) throw new Error('PROFILE_UNAVAILABLE: tool names');
  for (const tool of configured) {
    const source = tool.sourceInfo;
    const wanted = expected[tool.name];
    if (!source || ['path', 'source', 'scope', 'origin', 'baseDir'].some(k => source[k] !== wanted[k])) throw new Error(`PROFILE_UNAVAILABLE: provenance ${tool.name}`);
  }
}

export function profileDirectories(root) {
  return { home: join(root, 'home'), agentDir: join(root, 'agent'), storeDir: join(root, 'store'),
    sessionDir: join(root, 'sessions'), tmpDir: join(root, 'tmp') };
}
