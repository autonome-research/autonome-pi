// FIXTURE ONLY: deny network entry points before importing Pi. Not an OS sandbox.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => { throw new Error('FIXTURE_NETWORK_FORBIDDEN'); };
globalThis.fetch = deny;
http.request = http.get = https.request = https.get = tls.connect = deny;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node normalizes connect arguments into [options, callback] internally.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const path = typeof first === 'object' ? first?.path : typeof first === 'string' ? first : undefined;
  if (!path || !path.startsWith(`${process.env.TMPDIR}/`) || !path.endsWith('.sock')) return deny();
  return connect.apply(this, args);
};
syncBuiltinESMExports();
