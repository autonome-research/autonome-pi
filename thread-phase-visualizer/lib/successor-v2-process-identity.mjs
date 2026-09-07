import fs from "node:fs";
import process from "node:process";
import { isMainThread } from "node:worker_threads";

const MACHINE_ID = /^[0-9a-f]{32}$/;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const IDENTITY_FILE_LIMIT = 4096;

function readBoundedRegularFile(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const information = fs.fstatSync(descriptor);
    if (!information.isFile() || information.size > IDENTITY_FILE_LIMIT) {
      throw new Error(`${file} must be a bounded regular file`);
    }

    const chunks = [];
    let total = 0;
    while (total <= IDENTITY_FILE_LIMIT) {
      const buffer = Buffer.allocUnsafe(Math.min(512, IDENTITY_FILE_LIMIT + 1 - total));
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
    }
    if (total > IDENTITY_FILE_LIMIT) throw new Error(`${file} exceeds the identity read limit`);
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function normalizedSingleLine(file, pattern, label) {
  const value = readBoundedRegularFile(file).trim().toLowerCase();
  if (!pattern.test(value)) throw new Error(`invalid local Linux ${label}`);
  return value;
}

function processStartTicks(pid) {
  const value = readBoundedRegularFile(`/proc/${pid}/stat`);
  const closeParen = value.lastIndexOf(")");
  if (!value.startsWith(`${pid} (`) || closeParen < 2 || value[closeParen + 1] !== " ") {
    throw new Error("invalid local Linux process stat");
  }
  const fieldsAfterCommand = value.slice(closeParen + 2).trim().split(/\s+/);
  const ticks = fieldsAfterCommand[19]; // proc(5) field 22
  if (fieldsAfterCommand.length < 20 || !DECIMAL.test(String(ticks || "")) || ticks === "0") {
    throw new Error("invalid local Linux process start ticks");
  }
  return ticks;
}

export function readLocalLinuxProcessIdentity(launchProtocol) {
  if (process.platform !== "linux") throw new Error("successor v2 requires Linux process identity support");
  if (!isMainThread) throw new Error("successor v2 capabilities may only be used on the originating main thread");
  if (typeof launchProtocol !== "string" || launchProtocol.length === 0) {
    throw new Error("successor v2 requires an explicit launch protocol");
  }

  const pid = process.pid;
  const namespace = fs.statSync("/proc/self/ns/pid", { bigint: true });
  if (!namespace.isFile() || namespace.dev < 0n || namespace.ino <= 0n) {
    throw new Error("invalid local Linux PID namespace identity");
  }

  return Object.freeze({
    machineId: normalizedSingleLine("/etc/machine-id", MACHINE_ID, "machine id"),
    bootId: normalizedSingleLine("/proc/sys/kernel/random/boot_id", BOOT_ID, "boot id"),
    pidNamespace: Object.freeze({ dev: String(namespace.dev), ino: String(namespace.ino) }),
    pid,
    processStartTicks: processStartTicks(pid),
    launchProtocol,
  });
}
