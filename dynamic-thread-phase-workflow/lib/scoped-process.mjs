// Private Linux identity-safe lifecycle for runBoundedProcess. No public registration.
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export const ANCHOR_PATH = fileURLToPath(new URL('./scoped-process-anchor.py', import.meta.url));
export const ANCHOR_BINARY = '/usr/bin/python3';
export const SCOPED_LIMITS = Object.freeze({ scopes: 128, commands: 128, bootstrapMs: 5500,
  shutdownMs: 11000, probeMs: 1000, pollMs: 20, graceMs: 500, maxGraceMs: 5000 });

// Signal zero only: ESRCH is positive inactivity. EPERM/negative/unobservable
// states NEVER imply safety. A reused PGID can delay/deny, never receive a kill.
export function probeGroup(pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(-pid, 0); return 'present'; }
  catch (error) { return error?.code === 'ESRCH' ? 'gone' : 'unknown'; }
}

export function createScopedProcess(argv, graceMs = SCOPED_LIMITS.graceMs, onDirect = () => {}, onLoss = () => {}, onCallbackFailure = () => {}, preserveWorkerFd = false) {
  if (process.platform !== 'linux') throw new Error('UNSUPPORTED_MODE: Linux subreaper/pidfd required');
  if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > SCOPED_LIMITS.maxGraceMs || typeof preserveWorkerFd !== 'boolean') throw new Error('INVALID_REQUEST: grace');
  const config = JSON.stringify({ type: 'dispatch', argv, graceMs, ...(preserveWorkerFd ? { preserveWorkerFd: true } : {}) }) + '\n';
  if (Buffer.byteLength(config) > 64000) throw new Error('INVALID_REQUEST: command bound');
  let child, ready = false, dispatch = false, sent = false, stopped = false, unknown = false;
  let requested = false, termSent = false, direct = null, residual = false, empty = false, buffer = '', frames = 0;
  let bootstrapTimer, shutdownTimer, abandon;
  function send(value) {
    if (!child || stopped || !ready) return;
    try { child.stdio[3].write(value, error => { if (error && !stopped) lose(); }); }
    catch { lose(); }
  }
  function lose() {
    if (unknown) return;
    unknown = true; stopped = true;
    clearTimeout(bootstrapTimer); clearTimeout(shutdownTimer);
    // Veto synchronously BEFORE reader-close listeners/abandonment. Reentrant
    // executor revoke cannot send anything on this already-lost channel.
    for (const action of [onLoss, () => child?.stdio[3]?.destroy(), () => child?.stdio[4]?.destroy(), () => child?.stdout.destroy(),
      () => child?.stderr.destroy(), () => child?.unref(), () => abandon?.()]) {
      try { action(); } catch { /* keep unknown; one failing listener cannot skip cleanup */ }
    }
  }
  function shutdownBound() {
    if (!stopped) shutdownTimer ??= setTimeout(lose, SCOPED_LIMITS.shutdownMs);
  }
  function flush() {
    if (!ready || stopped) return;
    if (dispatch && !sent && !requested) { sent = true; send(config); }
    if (requested && !termSent) { termSent = true; send('{"type":"term"}\n'); shutdownBound(); }
  }
  return Object.freeze({
    attach(value, onAbandon) {
      child = value; abandon = onAbandon;
      bootstrapTimer = setTimeout(lose, SCOPED_LIMITS.bootstrapMs);
      child.stdio[3].setEncoding('utf8');
      child.stdio[3].on('error', () => { if (!stopped) lose(); });
      child.stdio[3].on('close', () => { if (!stopped && !empty) lose(); });
      child.stdio[3].on('data', chunk => {
        if (stopped) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 4096) { lose(); return; }
        while (buffer.includes('\n') && !stopped) {
          const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          try {
            const event = JSON.parse(line);
            if (++frames > 5) throw new Error('frame bound');
            if (event.type === 'ready' && !ready && event.pid === child.pid) {
              ready = true; clearTimeout(bootstrapTimer); flush();
            } else if (event.type === 'direct' && ready && !direct &&
                (event.code === null || Number.isInteger(event.code) && event.code >= 0 && event.code <= 255) &&
                (event.signal === null || typeof event.signal === 'string' && event.signal.length <= 32) && typeof event.spawnError === 'boolean') {
              direct = Object.freeze({ code: event.code, signal: event.signal, spawnError: event.spawnError });
              onDirect();
            } else if (event.type === 'residual' && direct && !residual) {
              residual = true; shutdownBound();
            } else if (event.type === 'empty' && ready && !empty) empty = true;
            else throw new Error('protocol/identity unavailable');
          } catch { lose(); }
        }
      });
      child.on('exit', code => {
        // Unknown anchor exit may leave inherited output pipes open. Closing
        // local readers is diagnostic abandonment, NEVER group-drain proof.
        if (code !== 0) lose();
      });
    },
    callbackFailed() { if (!stopped) onCallbackFailure(); },
    dispatch() { dispatch = true; flush(); },
    terminate() { if (!stopped && !empty) { requested = true; flush(); } },
    revoke() { if (!stopped) { send('{"type":"revoke"}\n'); lose(); } },
    async settle(exit) {
      clearTimeout(bootstrapTimer); clearTimeout(shutdownTimer);
      const until = performance.now() + SCOPED_LIMITS.probeMs;
      let group = child ? probeGroup(child.pid) : 'unknown';
      while (group === 'present' && !unknown && performance.now() < until) {
        await new Promise(resolve => setTimeout(resolve, SCOPED_LIMITS.pollMs));
        group = probeGroup(child.pid);
      }
      const drained = !unknown && ready && empty && exit.code === 0 && group === 'gone';
      // An unattached lifecycle never owned a child/channel. The subprocess's
      // separate exact no-child callback (e.g. ENOENT) decides that disposition.
      if (!drained && child) lose();
      stopped = true;
      try { child?.stdio[3]?.destroy(); } catch { lose(); }
      return Object.freeze({ disposition: drained && !unknown ? 'drained' : 'unknown',
        direct, residual, group, anchorPid: child?.pid ?? null });
    },
  });
}
