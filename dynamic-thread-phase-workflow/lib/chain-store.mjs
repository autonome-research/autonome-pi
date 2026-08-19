import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SUCCESSOR_RECORD_BYTES = 16 * 1024;

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
    descriptor = openSync(directory, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readRecord(file, expectedParentRunId) {
  let descriptor;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > MAX_SUCCESSOR_RECORD_BYTES) throw new Error("successor record must be a bounded regular file");
    const buffer = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const value = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
    if (!value || value.schema !== "pi-dynamic-workflow-successor/v1"
        || !["reserved", "committed"].includes(value.state)
        || !RUN_ID.test(String(value.parentRunId || ""))
        || !RUN_ID.test(String(value.childRunId || ""))
        || (expectedParentRunId && value.parentRunId !== expectedParentRunId)
        || !UUID.test(String(value.chainId || ""))
        || !UUID.test(String(value.token || ""))
        || !Number.isInteger(value.pid) || value.pid <= 0
        || !Number.isFinite(Date.parse(value.createdAt || ""))
        || !Number.isFinite(Date.parse(value.updatedAt || ""))) {
      throw new Error("invalid successor record");
    }
    return value;
  } catch (error) {
    throw new Error(`Could not read workflow successor record: ${error?.message || error}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeExclusive(file, record) {
  const descriptor = openSync(file, "wx", 0o600);
  let complete = false;
  try {
    writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    complete = true;
  } finally {
    closeSync(descriptor);
    if (!complete) rmSync(file, { force: true });
  }
}

export function reserveSuccessor(parentRunId, childRunId, options = {}) {
  const parent = validateRunId(parentRunId, "parent run id");
  const child = validateRunId(childRunId, "child run id");
  if (!UUID.test(String(options.chainId || ""))) throw new Error("chainId must be a system-generated UUID");
  const directory = chainDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = successorFile(parent);
  const now = new Date(options.now === undefined ? Date.now() : Number(options.now)).toISOString();
  const record = {
    schema: "pi-dynamic-workflow-successor/v1",
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
    if (existing.state === "committed") throw new Error(`Workflow ${parent} already has successor ${existing.childRunId}`);
    // Fail closed rather than racing automatic stale-claim reclamation. Normal
    // launch failures release their reservation; crash recovery can later gain
    // an explicit operator repair path with process-start identity checks.
    throw new Error(`Workflow ${parent} already has a pending successor ${existing.childRunId}`);
  }
}

export function commitSuccessor(reservation) {
  const current = readRecord(reservation.file, reservation.record.parentRunId);
  if (current.state !== "reserved" || current.token !== reservation.record.token || current.childRunId !== reservation.record.childRunId) {
    throw new Error("Workflow successor reservation changed before commit");
  }
  const committed = { ...current, state: "committed", updatedAt: new Date().toISOString() };
  const temporary = `${reservation.file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(committed, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, reservation.file);
    fsyncDirectory(chainDirectory());
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  reservation.record = committed;
  return committed;
}

export function releaseSuccessor(reservation) {
  if (!reservation?.file || !existsSync(reservation.file)) return false;
  const current = readRecord(reservation.file, reservation.record.parentRunId);
  if (current.state !== "reserved" || current.token !== reservation.record.token) return false;
  rmSync(reservation.file, { force: true });
  fsyncDirectory(chainDirectory());
  return true;
}

export function readSuccessor(parentRunId) {
  const parent = validateRunId(parentRunId, "parent run id");
  const file = successorFile(parent);
  return existsSync(file) ? readRecord(file, parent) : undefined;
}
