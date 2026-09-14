// FIXTURE transport only; no durable acceptance, reconnect, cancellation or epoch ownership.
import { StringDecoder } from 'node:string_decoder';
export function frames(stream, receive, fail, maxBytes = 65536) {
  const decoder = new StringDecoder('utf8'); let pending = ''; let dead = false;
  function stop(error) { if (!dead) { dead = true; fail(error); } }
  stream.on('data', chunk => {
    if (dead) return;
    const text = decoder.write(chunk);
    for (const [i, part] of text.split('\n').entries()) {
      if (i) {
        try { receive(JSON.parse(pending)); } catch (e) { stop(e); return; }
        pending = '';
      }
      if (Buffer.byteLength(pending) + Buffer.byteLength(part) > maxBytes) { stop(new Error('FRAME_LIMIT')); return; }
      pending += part;
    }
  });
  stream.on('end', () => { if (pending || decoder.end()) stop(new Error('TRUNCATED_FRAME')); });
  stream.on('error', stop);
}
export function send(stream, value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 65536) throw new Error('FRAME_LIMIT');
  stream.write(`${text}\n`);
}
