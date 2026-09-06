import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

const SCHEMA = "pi-dynamic-workflow-processes/v1";
const FILE_NAME = "workflow-processes.json";
const MAX_GROUPS = 1024;
const MAX_BYTES = 1_000_000;
const LAUNCH_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validLaunchToken(token) {
  return typeof token === "string" && LAUNCH_TOKEN.test(token);
}

// Never signal a possibly reused PID during recovery. ESRCH is the only positive
// proof that a POSIX process group has disappeared; EPERM and other errors fail closed.
function groupIsGone(pid) {
  if (process.platform === "win32") return false;
  try { process.kill(-pid, 0); return false; }
  catch (error) { return error?.code === "ESRCH"; }
}

function persist(file, journal) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(journal));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    if (process.platform !== "win32") {
      fd = openSync(dirname(file), "r");
      fsyncSync(fd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

/** Record launch intent BEFORE spawning, then the detached child's process group.
 * A crash between those writes leaves an unresolved intent, never an unsafe empty list.
 * Keep groups after child exit: grandchildren with redirected stdio may outlive it.
 */
export function createProcessJournal(directory, runId) {
  const file = join(directory, FILE_NAME);
  const journal = { schema: SCHEMA, runId, runnerPid: process.pid, hostname: hostname(), hasSubprocesses: false, groups: [] };
  const durablyStarted = new Set();
  persist(file, journal);
  return {
    reserve() {
      journal.groups = journal.groups.filter((entry) => !entry.pid || !groupIsGone(entry.pid));
      if (journal.groups.length >= MAX_GROUPS) throw new Error("Workflow process journal reached its unresolved group limit");
      const existing = new Set(journal.groups.map((entry) => entry.token));
      let token;
      do { token = randomUUID(); } while (existing.has(token));
      journal.groups.push({ token });
      persist(file, journal);
      return token;
    },
    noChild(token) {
      if (!validLaunchToken(token)) throw new Error("Workflow subprocess launch token is invalid");
      const entry = journal.groups.find((candidate) => candidate.token === token);
      // Clearing is permitted only for an explicit no-child outcome. Once a PID
      // was observed, even a failed started() persistence must remain fail-closed.
      if (!entry || entry.pid !== undefined) throw new Error("Workflow subprocess launch may have created a child");
      journal.groups = journal.groups.filter((candidate) => candidate !== entry);
      persist(file, journal);
    },
    started(token, pid) {
      if (!validLaunchToken(token)) throw new Error("Workflow subprocess launch token is invalid");
      const entry = journal.groups.find((candidate) => candidate.token === token);
      if (!entry || entry.pid !== undefined || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Workflow subprocess ownership could not be recorded");
      // Mutate before persistence deliberately: if persistence fails after the
      // child exists, noChild()/ended() must not later erase the crash intent.
      entry.pid = pid;
      journal.hasSubprocesses = true;
      persist(file, journal);
      if (process.platform === "win32") durablyStarted.add(token);
    },
    ended(token) {
      // POSIX groups stay recorded because redirected-stdio grandchildren may
      // outlive the direct child. Windows cannot inspect process groups, so it
      // may compact only starts whose PID transition was durably persisted.
      if (process.platform !== "win32" || !durablyStarted.has(token)) return;
      journal.groups = journal.groups.filter((entry) => entry.token !== token);
      persist(file, journal);
      durablyStarted.delete(token);
    },
  };
}

/** Crash recovery requires a complete, same-host journal and no surviving groups.
 * Legacy running sources without this evidence must not be resumed automatically.
 */
export function assertProcessGroupsStopped(directory, runId, runnerPid) {
  let journal;
  try {
    const file = join(directory, FILE_NAME);
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error("invalid process journal file");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const bytes = readSync(fd, buffer, length, buffer.length - length, null);
        if (!bytes) break;
        length += bytes;
      }
      if (length > MAX_BYTES) throw new Error("process journal grew beyond its limit");
      journal = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error(`Cannot resume workflow ${runId}: subprocess ownership is unknown (missing or invalid process journal)`);
  }
  if (journal?.schema !== SCHEMA || journal.runId !== runId || journal.runnerPid !== runnerPid
      || journal.hostname !== hostname() || typeof journal.hasSubprocesses !== "boolean"
      || !Array.isArray(journal.groups) || journal.groups.length > MAX_GROUPS) {
    throw new Error(`Cannot resume workflow ${runId}: subprocess ownership does not match this host and source runner`);
  }
  const tokens = new Set();
  for (const entry of journal.groups) {
    const keys = entry && typeof entry === "object" && !Array.isArray(entry) ? Object.keys(entry).sort() : [];
    const shapeIsValid = keys.length === 1 && keys[0] === "token"
      || keys.length === 2 && keys[0] === "pid" && keys[1] === "token";
    if (!shapeIsValid || !validLaunchToken(entry.token) || tokens.has(entry.token)) {
      throw new Error(`Cannot resume workflow ${runId}: subprocess launch tokens are invalid or inconsistent`);
    }
    tokens.add(entry.token);
    if (entry.pid === undefined) {
      throw new Error(`Cannot resume workflow ${runId}: an unresolved subprocess launch may still be active`);
    }
    if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0 || journal.hasSubprocesses !== true) {
      throw new Error(`Cannot resume workflow ${runId}: subprocess ownership does not match this host and source runner`);
    }
  }
  if (process.platform === "win32" && journal.hasSubprocesses) {
    throw new Error(`Cannot resume workflow ${runId}: subprocess group recovery is unsupported on Windows`);
  }
  for (const entry of journal.groups) {
    if (!groupIsGone(entry.pid)) {
      throw new Error(`Cannot resume workflow ${runId}: subprocess group ${entry.pid} is still running or its state is unknown`);
    }
  }
}
