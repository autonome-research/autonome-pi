const TRUNCATION_MARKER = "output truncated while streaming";

/**
 * Incrementally retain a byte-bounded prefix or suffix of a text stream.
 *
 * Limiting at ingestion time is important: truncating after a child exits still
 * allows stdout/stderr to exhaust the Node process while the child is running.
 */
export class BoundedTextBuffer {
  constructor(maxBytes, { keep = "tail" } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive safe integer");
    if (keep !== "head" && keep !== "tail") throw new Error('keep must be "head" or "tail"');
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.text = "";
    this.observedBytes = 0;
    this.truncated = false;
  }

  append(value) {
    const chunk = String(value ?? "");
    this.observedBytes += Buffer.byteLength(chunk, "utf8");
    if (!chunk || (this.keep === "head" && this.truncated)) return;

    this.text += chunk;
    if (Buffer.byteLength(this.text, "utf8") <= this.maxBytes) return;

    this.truncated = true;
    this.text = this.keep === "tail"
      ? takeUtf8Suffix(this.text, this.maxBytes)
      : takeUtf8Prefix(this.text, this.maxBytes);
  }

  value({ marker = true } = {}) {
    if (!this.truncated || !marker) return this.text;
    const detail = `[${TRUNCATION_MARKER}; observed ${this.observedBytes} bytes, retained ${this.maxBytes} ${this.keep} bytes]`;
    return this.keep === "tail" ? `${detail}\n${this.text}` : `${this.text}\n${detail}`;
  }
}

export function takeUtf8Prefix(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // UTF-8 code points are at most four bytes, so at most three boundary bytes
  // need to be removed. Fatal decoding distinguishes an incomplete boundary
  // from a legitimate U+FFFD character in the original text.
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end--) {
    try { return decoder.decode(bytes.subarray(0, end)); } catch { /* try the previous code-point boundary */ }
  }
  return "";
}

export function takeUtf8Suffix(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const first = bytes.length - maxBytes;
  for (let start = first; start <= Math.min(bytes.length, first + 3); start++) {
    try { return decoder.decode(bytes.subarray(start)); } catch { /* try the next code-point boundary */ }
  }
  return "";
}
