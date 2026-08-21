const DEFAULT_MAX_LINE_BYTES = 4_000_000;

// Bounded trace retention budgets. These mirror the usage-summation discipline:
// never retain an unbounded amount of reasoning/tool-call data from a long phase.
const DEFAULT_MAX_TRACE_WINDOW = 256;      // max records retained in the trace window
const DEFAULT_MAX_REASONING_CHARS = 4_096; // cap on accumulated reasoning text
const DEFAULT_MAX_TOOLCALL_ARG_CHARS = 1_024; // cap on a completed tool-call args snapshot

function positiveSafeInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

/**
 * Incremental collector for `pi --mode json` NDJSON.
 *
 * Pi message_update events contain both a delta and the cumulative partial
 * assistant message. Retaining the complete stream therefore grows roughly
 * quadratically for large tool calls. This collector discards the cumulative
 * update payloads and retains only the final message metadata used by
 * workflows, plus a bounded, throttled window of live reasoning deltas and
 * tool-call start/completed records.
 *
 * Reasoning deltas are mapped onto thread-phase's AgentStreamEvent
 * `content_delta` shape; tool-call lifecycle maps onto `tool_call_started` /
 * `tool_call_completed`. See package `@autonome-research/thread-phase`
 * `AgentStreamEvent` (src/agent/types.ts).
 */
export class PiJsonEventCollector {
  constructor({ maxLineBytes = DEFAULT_MAX_LINE_BYTES, onUsage, onTrace, maxTraceWindow, maxReasoningChars, maxToolCallArgChars } = {}) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) throw new Error("maxLineBytes must be a positive safe integer");
    this.maxLineBytes = maxLineBytes;
    this.maxTraceWindow = positiveSafeInteger(maxTraceWindow, DEFAULT_MAX_TRACE_WINDOW, "maxTraceWindow");
    this.maxReasoningChars = positiveSafeInteger(maxReasoningChars, DEFAULT_MAX_REASONING_CHARS, "maxReasoningChars");
    this.maxToolCallArgChars = positiveSafeInteger(maxToolCallArgChars, DEFAULT_MAX_TOOLCALL_ARG_CHARS, "maxToolCallArgChars");
    // Optional live callback invoked for each non-empty per-turn usage as it is
    // observed, before the run finishes. Lets callers stream token counts to the
    // visualizer during a phase instead of only after it completes.
    this.onUsage = typeof onUsage === "function" ? onUsage : undefined;
    // Optional live callback invoked for each captured trace record (reasoning
    // deltas, tool-call lifecycle) as it is observed, before the run finishes.
    this.onTrace = typeof onTrace === "function" ? onTrace : undefined;
    this.pending = "";
    this.droppingLine = false;
    this.droppedEvents = 0;
    this.malformedEvents = 0;
    this.oversizedEvents = 0;
    this.usageTotals = {};
    this.usageEvents = 0;
    this.text = "";
    this.model = undefined;
    this.stopReason = undefined;
    // Bounded live-trace capture.
    this.traceWindow = [];
    this.traceEvents = 0;          // trace records observed (delivered + retained)
    this.traceDropped = 0;         // trace records dropped because the window was full
    this.traceExcluded = 0;        // update content deliberately not retained
    this.reasoning = "";           // bounded accumulated reasoning text (never grows past maxReasoningChars)
    this.reasoningDeltas = 0;
    this.toolCallStarted = 0;
    this.toolCallCompleted = 0;
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

      const pendingBytes = Buffer.byteLength(this.pending, "utf8");
      const inputBytes = Buffer.byteLength(input, "utf8");
      if (pendingBytes + inputBytes > this.maxLineBytes) {
        // Check before concatenating so the configured line cap is also an
        // allocation cap, not merely a post-allocation retention cap.
        this.pending = "";
        this.droppingLine = true;
        this.oversizedEvents++;
        return;
      }
      this.pending += input;
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
      usage: this.usageEvents ? [this.usageTotals] : [],
      model: this.model,
      stopReason: this.stopReason,
      trace: {
        schema: "pi-agent-trace/v1",
        window: this.traceWindow,
        reasoning: this.reasoning,
      },
      piJson: {
        droppedEvents: this.droppedEvents,
        malformedEvents: this.malformedEvents,
        oversizedEvents: this.oversizedEvents,
        usageEvents: this.usageEvents,
        traceEvents: this.traceEvents,
        traceDropped: this.traceDropped,
        traceExcluded: this.traceExcluded,
        reasoningDeltas: this.reasoningDeltas,
        toolCallStarted: this.toolCallStarted,
        toolCallCompleted: this.toolCallCompleted,
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
    // memory fix: cumulative message_update payloads are never materialized as
    // JavaScript objects and are immediately eligible for collection.
    const type = eventTypeFromPrefix(line);
    if (type === "message_update") {
      this.consumeUpdate(line);
      return;
    }
    if (type && type !== "message_end") {
      this.droppedEvents++;
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
    if (message.usage) {
      // Pi emits per-assistant-message (per-turn) usage, matching the former
      // array-of-events behavior; summing preserves run totals without retaining
      // an unbounded event list.
      mergeNumericUsage(this.usageTotals, message.usage);
      this.usageEvents++;
      if (this.onUsage) this.onUsage({ usage: message.usage, model: message.model });
    }
    if (message.role !== "assistant") return;
    this.model = message.model || this.model;
    this.stopReason = message.stopReason || this.stopReason;
    const textParts = (message.content || [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text);
    if (textParts.length) this.text = textParts.join("");
  }

  /**
   * Handle a delta-only message_update record. We extract ONLY the nested
   * `assistantMessageEvent` sub-object (bounded), never the cumulative
   * assistant `message` payload, so the quadratic-memory fix is preserved even
   * for shapes that embed a full cumulative message.
   */
  consumeUpdate(line) {
    const ameRaw = findTopLevelValueRaw(line, "assistantMessageEvent");
    if (!ameRaw) {
      // No nestable assistantMessageEvent discriminator -> treat as dropped.
      this.droppedEvents++;
      return;
    }
    let ame;
    try {
      ame = JSON.parse(ameRaw);
    } catch {
      this.malformedEvents++;
      return;
    }
    if (!ame || typeof ame !== "object" || Array.isArray(ame)) {
      this.droppedEvents++;
      return;
    }

    const kind = ame.type;
    switch (kind) {
      case "thinking_delta":
      case "text_delta":
        this.captureContentDelta(kind === "thinking_delta" ? "thinking" : "text", ame.contentIndex, ame.delta);
        return;
      case "thinking_start":
      case "thinking_end":
      case "text_start":
      case "text_end":
        // Lifecycle markers carry no retained content; counted as observed
        // trace events but asserted as content-free.
        this.traceEvents++;
        return;
      case "toolcall_start":
        this.captureToolCallStarted(ame);
        return;
      case "toolcall_end":
        this.captureToolCallCompleted(ame);
        return;
      case "toolcall_delta":
        // Partial tool-call argument JSON. Never accumulated: retaining it is
        // the quadratic-memory regression we must not reintroduce.
        this.traceExcluded++;
        return;
      default:
        // Unrecognized update discriminator: compensate drop accounting.
        this.traceExcluded++;
        return;
    }
  }

  captureContentDelta(contentType, contentIndex, delta) {
    if (typeof delta !== "string" || !delta) return;
    const safeDelta = redactSecrets(delta);
    if (!safeDelta) return;
    this.traceEvents++;
    this.reasoningDeltas++;

    // Throttled retention: accumulate reasoning up to a fixed cap, never the
    // full stream, so an unbounded number of tiny deltas cannot grow heap.
    // Every retained content_delta record must honor the reasoning char budget
    // (maxReasoningChars). When the accumulation is already at budget there is
    // no room left, so `keep` stays empty and the whole delta is excluded —
    // never leave `keep` as the full uncapped safeDelta, which would let a
    // single record carry up to maxLineBytes of text into the window for
    // non-coalescing content streams.
    let keep = "";
    if (this.reasoning.length < this.maxReasoningChars) {
      const added = safeDelta.slice(0, this.maxReasoningChars - this.reasoning.length);
      this.reasoning += added;
      keep = added;
    }
    // Align traceExcluded with what was truly not retained: any portion of the
    // delta beyond the remaining budget (or the entire delta, when at budget).
    if (keep.length < safeDelta.length) this.traceExcluded++;

    const record = { type: "content_delta", agent: "assistant", contentType, contentIndex, delta: keep };
    if (this.onTrace) safeCall(this.onTrace, record);
    this.retainTrace(record, true);
  }

  captureToolCallStarted(ame) {
    this.traceEvents++;
    this.toolCallStarted++;
    const record = {
      type: "tool_call_started",
      agent: "assistant",
      toolCallId: toolCallIdFor(ame.contentIndex),
      contentIndex: ame.contentIndex,
    };
    if (this.onTrace) safeCall(this.onTrace, record);
    this.retainTrace(record, false);
  }

  captureToolCallCompleted(ame) {
    this.traceEvents++;
    this.toolCallCompleted++;
    const toolCall = ame.toolCall && typeof ame.toolCall === "object" ? ame.toolCall : {};
    const argsJson = typeof toolCall.arguments === "string"
      ? toolCall.arguments
      : JSON.stringify(toolCall.arguments ?? {});
    const record = {
      type: "tool_call_completed",
      agent: "assistant",
      toolCallId: toolCallIdFor(ame.contentIndex),
      toolName: typeof toolCall.name === "string" ? toolCall.name : undefined,
      contentIndex: ame.contentIndex,
      args: truncateUtf8(redactSecrets(argsJson), this.maxToolCallArgChars),
    };
    if (this.onTrace) safeCall(this.onTrace, record);
    this.retainTrace(record, false);
  }

  /**
   * Store a trace record in the bounded window. Reasoning `content_delta`
   * records for the same content stream are coalesced into a single record to
   * throttle the number of tiny deltas; when the window is full the oldest
   * record is evicted (drop accounting preserved).
   */
  retainTrace(record, coalesce) {
    const last = this.traceWindow[this.traceWindow.length - 1];
    if (coalesce && last && last.type === "content_delta" && last.contentIndex === record.contentIndex && last.contentType === record.contentType) {
      last.delta += record.delta;
      if (Buffer.byteLength(last.delta, "utf8") > this.maxReasoningChars) {
        last.delta = truncateUtf8(last.delta, this.maxReasoningChars);
        this.traceExcluded++;
      }
      return;
    }
    if (record.type !== "content_delta" || record.delta) {
      this.traceWindow.push(record);
    }
    while (this.traceWindow.length > this.maxTraceWindow) {
      this.traceWindow.shift();
      this.traceDropped++;
    }
  }
}

function safeCall(fn, arg) {
  try { return fn(arg); } catch { /* a throwing observer must not break the pipeline */ return undefined; }
}

function toolCallIdFor(contentIndex) {
  return typeof contentIndex === "number" ? `tc-${contentIndex}` : `tc-${String(contentIndex ?? 0)}`;
}

function truncateUtf8(text, maxBytes) {
  const value = String(text ?? "");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let out = value.slice(0, maxBytes);
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return out;
}

const NUMERIC_USAGE_KEYS = new Set([
  "input", "output", "totalTokens", "reasoning", "cacheRead", "cacheWrite",
  "input_tokens", "output_tokens", "total_tokens", "reasoning_tokens",
  "cached_input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
  "promptTokens", "completionTokens", "cachedInputTokens", "cacheCreationInputTokens", "reasoningTokens",
]);
const NUMERIC_COST_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite", "total"]);

function mergeNumericUsage(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  // Provider usage schemas vary, but retaining arbitrary keys would allow many
  // small events to grow this aggregate forever. Keep a fixed numeric schema.
  for (const key of NUMERIC_USAGE_KEYS) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) target[key] = (target[key] || 0) + value;
  }
  if (source.cost && typeof source.cost === "object" && !Array.isArray(source.cost)) {
    target.cost ||= {};
    for (const key of NUMERIC_COST_KEYS) {
      const value = source.cost[key];
      if (typeof value === "number" && Number.isFinite(value)) target.cost[key] = (target.cost[key] || 0) + value;
    }
  }
}

function eventTypeFromPrefix(line) {
  // Scan the bounded record for a top-level string property named `type`.
  // This avoids materializing cumulative update objects and does not depend on
  // property order or mistake escaped type-like text inside another value.
  let depth = 0;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "{") { depth++; continue; }
    if (char === "}") { depth--; continue; }
    if (char !== '"') continue;

    const start = index;
    index++;
    let escaped = false;
    while (index < line.length) {
      const current = line[index];
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') break;
      index++;
    }
    if (depth !== 1) continue;
    let cursor = index + 1;
    while (/\s/.test(line[cursor] || "")) cursor++;
    if (line[cursor] !== ":") continue;
    let key;
    try { key = JSON.parse(line.slice(start, index + 1)); } catch { continue; }
    if (key !== "type") continue;
    cursor++;
    while (/\s/.test(line[cursor] || "")) cursor++;
    if (line[cursor] !== '"') return undefined;
    const valueStart = cursor;
    cursor++;
    escaped = false;
    while (cursor < line.length) {
      const current = line[cursor];
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') break;
      cursor++;
    }
    try { return JSON.parse(line.slice(valueStart, cursor + 1)); } catch { return undefined; }
  }
  return undefined;
}

/**
 * Extract the raw JSON text of a named top-level object-valued member from a
 * single NDJSON line, without parsing the whole record. Used to pull out the
 * nested `assistantMessageEvent` discriminator while never materializing the
 * cumulative assistant `message` payload (the quadratic-memory fix).
 */
function findTopLevelValueRaw(line, key) {
  let depth = 0;
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "{") { depth++; index++; continue; }
    if (char === "}") { depth--; index++; continue; }
    if (char !== '"') { index++; continue; }

    const start = index;
    index++;
    let escaped = false;
    while (index < line.length) {
      const current = line[index];
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') break;
      index++;
    }
    let strKey;
    try { strKey = JSON.parse(line.slice(start, index + 1)); } catch { continue; }
    let cursor = index + 1;
    while (/\s/.test(line[cursor] || "")) cursor++;
    if (line[cursor] !== ":") continue;
    if (strKey !== key || depth !== 1) continue;
    cursor++;
    while (/\s/.test(line[cursor] || "")) cursor++;
    if (line[cursor] !== "{") return undefined; // only object values supported
    const valueStart = cursor;
    // Match the closing brace with string-awareness so braces/quotes inside
    // nested string values (e.g. tool-call argument deltas) are not miscounted.
    let valueDepth = 0;
    let end = cursor;
    while (end < line.length) {
      const c = line[end];
      if (c === "\"") {
        // Skip the entire string literal (handling escapes) as one unit.
        end++;
        let escaped = false;
        while (end < line.length) {
          const current = line[end];
          if (escaped) escaped = false;
          else if (current === "\\") escaped = true;
          else if (current === "\"") break;
          end++;
        }
        end++;
        continue;
      }
      if (c === "{") valueDepth++;
      else if (c === "}") { valueDepth--; if (valueDepth === 0) break; }
      end++;
    }
    if (valueDepth !== 0) return undefined;
    return line.slice(valueStart, end + 1);
  }
  return undefined;
}

/**
 * Best-effort secrets redaction for captured reasoning / tool-call text, so a
 * model's leaked keys never reach the trace window. Mirrors the store-level
 * redaction in thread-phase-visualizer/lib/store.mjs.
 */
function redactSecrets(text) {
  return String(text ?? "")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[redacted-api-key]")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|API[_-]?KEY|PASSWORD|PASSWD|AUTH|BEARER)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s'\"]+)/gi, "$1=[redacted]")
    .replace(/(--?(?:token|secret|api[-_]?key|password|passwd|auth|bearer)(?:\s+|=))(("[^"]*")|('[^']*')|[^\s]+)/gi, "$1[redacted]");
}
