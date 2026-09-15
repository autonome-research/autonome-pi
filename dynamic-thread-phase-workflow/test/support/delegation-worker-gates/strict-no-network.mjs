// FIXTURE ONLY: tighten the historical network preload's Unix-socket allowance.
import net from 'node:net';
import { lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const deny = () => { throw new Error('FIXTURE_NETWORK_FORBIDDEN'); };
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const expectedEndpoint = process.env.PI_DELEGATION_BRIDGE_SOCKET;
function requestedPath(args) {
  const supplied = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  if (supplied.length !== 1 && !(supplied.length === 2 && (supplied[1] == null || typeof supplied[1] === 'function'))) return undefined;
  const first = supplied[0];
  if (typeof first === 'string') return first;
  if (!first || typeof first !== 'object' || Array.isArray(first)) return undefined;
  const keys = Object.keys(first);
  return keys.length === 1 && keys[0] === 'path' && typeof first.path === 'string' ? first.path : undefined;
}
function privateEndpoint(path) {
  const expected = expectedEndpoint;
  if (uid === null || typeof expected !== 'string' || expected !== path || !expected.startsWith('/') ||
      expected.includes('\0') || resolve(expected) !== expected || Buffer.byteLength(expected) > 107) return false;
  try {
    const socket = lstatSync(path);
    const privateRoot = lstatSync(dirname(path));
    if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600) return false;
    if (!privateRoot.isDirectory() || privateRoot.uid !== uid || (privateRoot.mode & 0o777) !== 0o700) return false;
    for (let current = dirname(path); ; current = dirname(current)) {
      if (lstatSync(current).isSymbolicLink()) return false;
      if (current === '/') break;
    }
    return true;
  } catch { return false; }
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const path = requestedPath(args);
  if (!path || !privateEndpoint(path)) return deny();
  return connect.apply(this, args);
};
