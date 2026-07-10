const DEFAULT_MAX_LINE_BYTES = 4_000_000;
const MAX_UNTYPED_LINE_BYTES = 64_000;

/**
 * Incremental collector for `pi --mode json` NDJSON.
 *
 * Pi message_update events contain both a delta and the cumulative partial
 * assistant message. Retaining the complete stream therefore grows roughly
 * quadratically for large tool calls. This collector discards update events as
 * they arrive and retains only the final message metadata used by workflows.
 */
export class PiJsonEventCollector {
  constructor({ maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) throw new Error("maxLineBytes must be a positive safe integer");
    this.maxLineBytes = maxLineBytes;
    this.pending = "";
    this.droppingLine = false;
    this.droppedEvents = 0;
    this.malformedEvents = 0;
    this.oversizedEvents = 0;
    this.usage = [];
    this.text = "";
    this.model = undefined;
    this.stopReason = undefined;
  }

  push(value) {
    let input = String(value ?? "");
    while (input) {
      if (this.droppingLine) {
        const newline = input.indexOf("\n");
        if (newline === -1) return;
        input = input.slice(newline + 1);
        this.droppingLine = false;
        continue;
      }

      const newline = input.indexOf("\n");
      if (newline !== -1) {
        const segment = input.slice(0, newline);
        input = input.slice(newline + 1);
        // Check each side before concatenation. Without this guard, one giant
        // complete record can briefly allocate pending + segment even though
        // consumeLine would immediately reject the oversized result.
        const lineBytes = Buffer.byteLength(this.pending, "utf8") + Buffer.byteLength(segment, "utf8");
        if (lineBytes > this.maxLineBytes) {
          this.pending = "";
          this.oversizedEvents++;
          continue;
        }
        const line = `${this.pending}${segment}`;
        this.pending = "";
        this.consumeLine(line.replace(/\r$/, ""));
        continue;
      }

      this.pending += input;
      if (Buffer.byteLength(this.pending, "utf8") > this.maxLineBytes) {
        // Never let a malformed or unexpectedly giant unterminated record turn
        // back into an unbounded process-lifetime buffer.
        this.pending = "";
        this.droppingLine = true;
        this.oversizedEvents++;
      }
      return;
    }
  }

  finish() {
    if (this.pending.trim()) this.consumeLine(this.pending.replace(/\r$/, ""));
    this.pending = "";
    return this.result();
  }

  result() {
    return {
      text: this.text,
      usage: this.usage,
      model: this.model,
      stopReason: this.stopReason,
      piJson: {
        droppedEvents: this.droppedEvents,
        malformedEvents: this.malformedEvents,
        oversizedEvents: this.oversizedEvents,
        bufferedBytes: Buffer.byteLength(this.pending, "utf8"),
      },
    };
  }

  consumeLine(line) {
    if (!line.trim()) return;
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
      this.oversizedEvents++;
      return;
    }

    // Inspect the event discriminator before JSON.parse. This is the critical
    // memory fix: cumulative message_update records are never materialized as
    // JavaScript objects and are immediately eligible for collection.
    const type = eventTypeFromPrefix(line);
    if (type && type !== "message_end") {
      this.droppedEvents++;
      return;
    }
    // Pi currently serializes the top-level event discriminator first. Small
    // untyped records (such as a session header) remain parseable, but refuse
    // to materialize a large untyped record if that protocol invariant changes.
    if (!type && Buffer.byteLength(line, "utf8") > MAX_UNTYPED_LINE_BYTES) {
      this.malformedEvents++;
      return;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.malformedEvents++;
      return;
    }
    if (event?.type !== "message_end" || !event.message) {
      this.droppedEvents++;
      return;
    }

    const message = event.message;
    if (message.usage) this.usage.push(message.usage);
    if (message.role !== "assistant") return;
    this.model = message.model || this.model;
    this.stopReason = message.stopReason || this.stopReason;
    const textParts = (message.content || [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text);
    if (textParts.length) this.text = textParts.join("");
  }
}

function eventTypeFromPrefix(line) {
  // `type` is emitted near the beginning by Pi. Restrict the scan so a giant
  // tool argument containing a coincidental `type` key cannot be mistaken for
  // the event discriminator.
  return line.slice(0, 512).match(/"type"\s*:\s*"([^"]+)"/)?.[1];
}
