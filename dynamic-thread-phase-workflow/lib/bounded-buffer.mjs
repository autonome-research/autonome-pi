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
  const bytes = Buffer.from(text, "utf8").subarray(0, maxBytes);
  return bytes.toString("utf8").replace(/\uFFFD$/, "");
}

export function takeUtf8Suffix(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  let suffix = bytes.subarray(bytes.length - maxBytes).toString("utf8");
  // Starting in the middle of a multi-byte code point yields one replacement
  // character. Remove only that boundary artifact, not legitimate content.
  if (suffix.startsWith("\uFFFD")) suffix = suffix.slice(1);
  return suffix;
}
