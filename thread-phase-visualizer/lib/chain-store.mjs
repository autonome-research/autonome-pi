import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import { readLocalLinuxProcessIdentity } from "./successor-v2-process-identity.mjs";

const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const MAX_SUCCESSOR_RECORD_BYTES = 16 * 1024;
const V1_SCHEMA = "pi-dynamic-workflow-successor/v1";
const V2_SCHEMA = "pi-dynamic-workflow-successor/v2";

// This literal identifies the synchronous reserve -> durable intent -> createRun
// -> durable commit lifecycle. Callers must opt in explicitly; v1 is never
// upgraded merely because the v2 implementation is available.
export const SUCCESSOR_V2_LAUNCH_PROTOCOL = "pi-dynamic-workflow-successor-launch/v2";

const v2Handles = new WeakMap();

function chainDirectory() {
  const store = process.env.PI_THREAD_PHASE_STORE_DIR || join(homedir(), ".pi", "agent", "thread-phase");
  return join(store, "chains", "successors");
}

function validateRunId(value, label) {
  if (typeof value !== "string" || !RUN_ID.test(value)) throw new Error(`${label} must be a safe workflow run identifier`);
  return value;
}

function successorFile(parentRunId) {
  return join(chainDirectory(), `${validateRunId(parentRunId, "parent run id")}.json`);
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const information = fs.fstatSync(descriptor);
    if (!information.isDirectory()) throw new Error("successor directory must be a directory");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function descriptorIdentity(descriptor) {
  const information = fs.fstatSync(descriptor, { bigint: true });
  return Object.freeze({ dev: String(information.dev), ino: String(information.ino) });
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validCommonRecord(value, expectedParentRunId) {
  return typeof value.parentRunId === "string"
    && RUN_ID.test(value.parentRunId)
    && typeof value.childRunId === "string"
    && RUN_ID.test(value.childRunId)
    && (!expectedParentRunId || value.parentRunId === expectedParentRunId)
    && typeof value.chainId === "string"
    && UUID.test(value.chainId)
    && typeof value.token === "string"
    && UUID.test(value.token)
    && validTimestamp(value.createdAt)
    && validTimestamp(value.updatedAt);
}

function validV1Record(value, expectedParentRunId) {
  return value?.schema === V1_SCHEMA
    && exactKeys(value, ["schema", "state", "parentRunId", "childRunId", "chainId", "token", "pid", "createdAt", "updatedAt"])
    && ["reserved", "committed"].includes(value.state)
    && validCommonRecord(value, expectedParentRunId)
    && Number.isInteger(value.pid)
    && value.pid > 0;
}

function validV2Owner(owner) {
  return exactKeys(owner, ["machineId", "bootId", "pidNamespace", "pid", "processStartTicks", "launchProtocol"])
    && typeof owner.machineId === "string" && /^[0-9a-f]{32}$/.test(owner.machineId)
    && typeof owner.bootId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner.bootId)
    && exactKeys(owner.pidNamespace, ["dev", "ino"])
    && typeof owner.pidNamespace.dev === "string" && DECIMAL.test(owner.pidNamespace.dev)
    && typeof owner.pidNamespace.ino === "string" && /^[1-9][0-9]*$/.test(owner.pidNamespace.ino)
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0 && owner.pid <= 2_147_483_647
    && typeof owner.processStartTicks === "string" && /^[1-9][0-9]*$/.test(owner.processStartTicks)
    && owner.launchProtocol === SUCCESSOR_V2_LAUNCH_PROTOCOL;
}

function validV2Record(value, expectedParentRunId) {
  const legalPair = (value?.state === "reserved" && value.stage === "pre-create")
    || (value?.state === "reserved" && value.stage === "creating-child")
    || (value?.state === "committed" && value.stage === "committed");
  return value?.schema === V2_SCHEMA
    && exactKeys(value, ["schema", "state", "stage", "parentRunId", "childRunId", "chainId", "token", "owner", "createdAt", "updatedAt"])
    && legalPair
    && validCommonRecord(value, expectedParentRunId)
    && validV2Owner(value.owner);
}

function decodeRecord(value, expectedParentRunId) {
  if (value?.schema === V1_SCHEMA && validV1Record(value, expectedParentRunId)) return value;
  if (value?.schema === V2_SCHEMA && validV2Record(value, expectedParentRunId)) return value;
  throw new Error("invalid successor record");
}

function readRecordData(file, expectedParentRunId, options = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_SUCCESSOR_RECORD_BYTES) {
      throw new Error("successor record must be a bounded regular file");
    }

    const buffer = Buffer.allocUnsafe(MAX_SUCCESSOR_RECORD_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_SUCCESSOR_RECORD_BYTES || offset !== before.size) {
      throw new Error("successor record changed or exceeded its bounded size while reading");
    }
    const value = decodeRecord(JSON.parse(buffer.subarray(0, offset).toString("utf8")), expectedParentRunId);
    return { value, identity: descriptorIdentity(descriptor) };
  } catch (error) {
    if (options.allowMissing && error?.code === "ENOENT") return undefined;
    throw new Error(`Could not read workflow successor record: ${error?.message || error}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readRecord(file, expectedParentRunId, options = {}) {
  return readRecordData(file, expectedParentRunId, options)?.value;
}

// Legacy writer retained for v1 behavior.
function writeExclusive(file, record) {
  const descriptor = fs.openSync(file, "wx", 0o600);
  let complete = false;
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    complete = true;
  } finally {
    fs.closeSync(descriptor);
    if (!complete) fs.rmSync(file, { force: true });
  }
}

function safeUnlinkOwnedPathOnce(file, expectedIdentity) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const information = fs.fstatSync(descriptor);
    const currentIdentity = descriptorIdentity(descriptor);
    if (!information.isFile() || !sameIdentity(currentIdentity, expectedIdentity)) return false;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function writeExclusiveV2(file, record) {
  let descriptor;
  let identity;
  let closed = false;
  try {
    descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    identity = descriptorIdentity(descriptor);
    fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    closed = true;
    return identity;
  } catch (error) {
    if (descriptor !== undefined && !closed) {
      try { fs.closeSync(descriptor); } catch { /* publication already failed closed */ }
    }
    if (identity) safeUnlinkOwnedPathOnce(file, identity);
    throw error;
  }
}

function writePrivateTemporary(file, record) {
  const temporary = `${file}.v2-${process.pid}-${randomUUID()}.tmp`;
  let descriptor;
  let identity;
  let closed = false;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    identity = descriptorIdentity(descriptor);
    fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    closed = true;
    return { temporary, identity };
  } catch (error) {
    if (descriptor !== undefined && !closed) {
      try { fs.closeSync(descriptor); } catch { /* mutation remains failed closed */ }
    }
    if (identity) safeUnlinkOwnedPathOnce(temporary, identity);
    throw error;
  }
}

function sameOwner(left, right) {
  return validV2Owner(left) && validV2Owner(right)
    && left.machineId === right.machineId
    && left.bootId === right.bootId
    && left.pidNamespace.dev === right.pidNamespace.dev
    && left.pidNamespace.ino === right.pidNamespace.ino
    && left.pid === right.pid
    && left.processStartTicks === right.processStartTicks
    && left.launchProtocol === right.launchProtocol;
}

function sameV2Claim(record, state, expectedState, expectedStage) {
  return record.schema === V2_SCHEMA
    && record.state === expectedState
    && record.stage === expectedStage
    && record.parentRunId === state.parentRunId
    && record.childRunId === state.childRunId
    && record.chainId === state.chainId
    && record.token === state.token
    && record.createdAt === state.createdAt
    && record.updatedAt === state.updatedAt
    && sameOwner(record.owner, state.owner);
}

function currentOwnerForState(state) {
  if (process.pid !== state.originPid) throw new Error("successor v2 capability belongs to a different origin process");
  const current = readLocalLinuxProcessIdentity(state.owner.launchProtocol);
  if (!sameOwner(current, state.owner)) throw new Error("successor v2 owner identity no longer matches the originating process");
}

function withV2Handle(handle, operation, allowedStatuses, callback) {
  const state = handle && typeof handle === "object" ? v2Handles.get(handle) : undefined;
  if (!state) throw new Error(`${operation} requires a live, nondelegable successor v2 handle`);
  if (state.busy) throw new Error(`${operation} cannot re-enter a successor v2 handle mutation`);
  if (!allowedStatuses.includes(state.status)) throw new Error(`${operation} rejected a stale or poisoned successor v2 handle`);
  state.busy = true;
  try {
    currentOwnerForState(state);
    return callback(state);
  } finally {
    state.busy = false;
  }
}

function exactCurrentV2(state, expectedState, expectedStage) {
  let current;
  try {
    current = readRecordData(state.file, state.parentRunId);
  } catch (error) {
    state.status = "validation-poisoned";
    throw error;
  }
  if (!sameIdentity(current.identity, state.fileIdentity)
      || !sameV2Claim(current.value, state, expectedState, expectedStage)) {
    state.status = "validation-poisoned";
    throw new Error("Workflow successor v2 reservation changed before mutation");
  }
  return current.value;
}

export function reserveSuccessor(parentRunId, childRunId, options = {}) {
  const parent = validateRunId(parentRunId, "parent run id");
  const child = validateRunId(childRunId, "child run id");
  if (!UUID.test(String(options.chainId || ""))) throw new Error("chainId must be a system-generated UUID");
  const directory = chainDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = successorFile(parent);
  const now = new Date(options.now === undefined ? Date.now() : Number(options.now)).toISOString();
  const record = {
    schema: V1_SCHEMA,
    state: "reserved",
    parentRunId: parent,
    childRunId: child,
    chainId: options.chainId,
    token: randomUUID(),
    pid: process.pid,
    createdAt: now,
    updatedAt: now,
  };

  try {
    writeExclusive(file, record);
    fsyncDirectory(directory);
    return { file, record };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readRecord(file, parent);
    if (existing.schema === V2_SCHEMA) throw new Error("Legacy successor reservation refuses a successor v2 record");
    if (existing.state === "committed") throw new Error(`Workflow ${parent} already has successor ${existing.childRunId}`);
    throw new Error(`Workflow ${parent} already has a pending successor ${existing.childRunId}`);
  }
}

export function commitSuccessor(reservation) {
  const current = readRecord(reservation.file, reservation.record.parentRunId);
  if (current.schema === V2_SCHEMA) throw new Error("Legacy successor commit refuses a successor v2 record");
  if (current.state !== "reserved" || current.token !== reservation.record.token || current.childRunId !== reservation.record.childRunId) {
    throw new Error("Workflow successor reservation changed before commit");
  }
  const committed = { ...current, state: "committed", updatedAt: new Date().toISOString() };
  const temporary = `${reservation.file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(committed, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, reservation.file);
    fsyncDirectory(chainDirectory());
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  reservation.record = committed;
  return committed;
}

export function releaseSuccessor(reservation) {
  if (!reservation?.file || !fs.existsSync(reservation.file)) return false;
  const current = readRecord(reservation.file, reservation.record.parentRunId);
  if (current.schema === V2_SCHEMA) throw new Error("Legacy successor release refuses a successor v2 record");
  if (current.state !== "reserved" || current.token !== reservation.record.token) return false;
  fs.rmSync(reservation.file, { force: true });
  fsyncDirectory(chainDirectory());
  return true;
}

export function reserveSuccessorV2(parentRunId, childRunId, options = {}) {
  const parent = validateRunId(parentRunId, "parent run id");
  const child = validateRunId(childRunId, "child run id");
  if (!UUID.test(String(options.chainId || ""))) throw new Error("chainId must be a system-generated UUID");
  if (["owner", "machineId", "bootId", "pidNamespace", "pid", "processStartTicks"].some((key) => Object.hasOwn(options, key))) {
    throw new Error("successor v2 does not accept caller-supplied owner identity");
  }
  if (options.launchProtocol !== SUCCESSOR_V2_LAUNCH_PROTOCOL) {
    throw new Error(`launchProtocol must be exactly ${SUCCESSOR_V2_LAUNCH_PROTOCOL}`);
  }

  const owner = readLocalLinuxProcessIdentity(SUCCESSOR_V2_LAUNCH_PROTOCOL);
  const directory = chainDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = successorFile(parent);
  const now = new Date(options.now === undefined ? Date.now() : Number(options.now)).toISOString();
  const record = {
    schema: V2_SCHEMA,
    state: "reserved",
    stage: "pre-create",
    parentRunId: parent,
    childRunId: child,
    chainId: options.chainId,
    token: randomUUID(),
    owner,
    createdAt: now,
    updatedAt: now,
  };

  let fileIdentity;
  try {
    fileIdentity = writeExclusiveV2(file, record);
    fsyncDirectory(directory);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const existing = readRecord(file, parent);
      if (existing.state === "committed") throw new Error(`Workflow ${parent} already has successor ${existing.childRunId}`);
      throw new Error(`Workflow ${parent} already has a pending successor ${existing.childRunId}`);
    }
    if (fileIdentity && safeUnlinkOwnedPathOnce(file, fileIdentity)) {
      try { fsyncDirectory(directory); } catch { /* publication failed and remains conservatively ambiguous */ }
    }
    throw error;
  }

  const handle = Object.freeze(Object.create(null));
  v2Handles.set(handle, {
    busy: false,
    status: "pre-create",
    originPid: process.pid,
    directory,
    file,
    fileIdentity,
    parentRunId: parent,
    childRunId: child,
    chainId: options.chainId,
    token: record.token,
    owner,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
  return handle;
}

export function markSuccessorLaunchIntent(handle) {
  return withV2Handle(handle, "markSuccessorLaunchIntent", ["pre-create"], (state) => {
    const current = exactCurrentV2(state, "reserved", "pre-create");
    const creating = { ...current, state: "reserved", stage: "creating-child", updatedAt: new Date().toISOString() };
    let temporary;
    try {
      temporary = writePrivateTemporary(state.file, creating);
      // From this point onward replacement is ambiguous even if rename reports
      // an error. Poisoning first permanently destroys release authority.
      state.status = "intent-poisoned";
      fs.renameSync(temporary.temporary, state.file);
      fsyncDirectory(state.directory);
      state.fileIdentity = temporary.identity;
      state.updatedAt = creating.updatedAt;
      state.status = "creating-child";
      return creating;
    } catch (error) {
      if (temporary) safeUnlinkOwnedPathOnce(temporary.temporary, temporary.identity);
      throw error;
    }
  });
}

export function commitSuccessorV2(handle) {
  return withV2Handle(handle, "commitSuccessorV2", ["creating-child"], (state) => {
    const current = exactCurrentV2(state, "reserved", "creating-child");
    const committed = { ...current, state: "committed", stage: "committed", updatedAt: new Date().toISOString() };
    let temporary;
    try {
      temporary = writePrivateTemporary(state.file, committed);
      state.status = "commit-poisoned";
      fs.renameSync(temporary.temporary, state.file);
      fsyncDirectory(state.directory);
      state.fileIdentity = temporary.identity;
      state.updatedAt = committed.updatedAt;
      state.status = "committed";
      return committed;
    } catch (error) {
      if (temporary) safeUnlinkOwnedPathOnce(temporary.temporary, temporary.identity);
      throw error;
    }
  });
}

export function releaseSuccessorV2(handle) {
  return withV2Handle(handle, "releaseSuccessorV2", ["pre-create"], (state) => {
    exactCurrentV2(state, "reserved", "pre-create");
    // Exactly one pathname unlink attempt. Poison before entering the syscall;
    // neither an unlink error nor directory-fsync ambiguity is retryable.
    state.status = "release-poisoned";
    fs.unlinkSync(state.file);
    fsyncDirectory(state.directory);
    state.status = "released";
    return true;
  });
}

export function readSuccessor(parentRunId) {
  const parent = validateRunId(parentRunId, "parent run id");
  const file = successorFile(parent);
  return readRecord(file, parent, { allowMissing: true });
}
