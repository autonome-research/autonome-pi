import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_LINE_BYTES = 4_000_000;
const DEFAULT_MAX_EXECUTION_EVENT_PARSE_BYTES = 256_000;
const DEFAULT_MAX_RESULT_PREVIEW_BYTES = 4_096;

// Bounded trace retention budgets. These mirror the usage-summation discipline:
// never retain an unbounded amount of reasoning/tool-call data from a long phase.
const DEFAULT_MAX_TRACE_WINDOW = 256;      // max records retained in the trace window
const DEFAULT_MAX_REASONING_CHARS = 4_096; // cap on accumulated reasoning text
const DEFAULT_MAX_TOOLCALL_ARG_CHARS = 1_024; // cap on a completed tool-call args snapshot
const MAX_CORRELATION_RECORDS_PER_TURN = 512;
const MAX_COMMAND_METADATA_BYTES = 256;

// Reject rather than truncate identity fields: shared prefixes must never
// alias separate commands. Enforce bounds before any correlation retention.
function boundedCommandString(value, maxBytes = MAX_COMMAND_METADATA_BYTES) {
  return typeof value === "string" && value.length > 0 && value.length <= maxBytes
    && Buffer.byteLength(value, "utf8") <= maxBytes ? value : undefined;
}

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
 * workflows, plus a bounded window of distinct thinking/text deltas and
 * command lifecycle evidence. Argument generation emits preparing/ready only;
 * actual execution start/update/end is captured from Pi's top-level events.
 * Result objects are reduced immediately to bounded textual previews and are
 * never retained raw. The runner separately rate-limits live update snapshots.
 */
export class PiJsonEventCollector {
  constructor({ maxLineBytes = DEFAULT_MAX_LINE_BYTES, onUsage, onTrace, maxTraceWindow, maxReasoningChars, maxToolCallArgChars, maxExecutionEventParseBytes, maxResultPreviewBytes, invocationId, attempt } = {}) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) throw new Error("maxLineBytes must be a positive safe integer");
    this.maxLineBytes = maxLineBytes;
    this.maxTraceWindow = positiveSafeInteger(maxTraceWindow, DEFAULT_MAX_TRACE_WINDOW, "maxTraceWindow");
    this.maxReasoningChars = positiveSafeInteger(maxReasoningChars, DEFAULT_MAX_REASONING_CHARS, "maxReasoningChars");
    this.maxToolCallArgChars = positiveSafeInteger(maxToolCallArgChars, DEFAULT_MAX_TOOLCALL_ARG_CHARS, "maxToolCallArgChars");
    this.maxExecutionEventParseBytes = positiveSafeInteger(maxExecutionEventParseBytes, DEFAULT_MAX_EXECUTION_EVENT_PARSE_BYTES, "maxExecutionEventParseBytes");
    this.maxResultPreviewBytes = positiveSafeInteger(maxResultPreviewBytes, DEFAULT_MAX_RESULT_PREVIEW_BYTES, "maxResultPreviewBytes");
    this.invocationId = typeof invocationId === "string" && invocationId ? invocationId.slice(0, 256) : randomUUID();
    this.attempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
    // Optional live callback invoked for each non-empty per-turn usage as it is
    // observed, before the run finishes. Lets callers stream token counts to the
    // visualizer during a phase instead of only after it completes.
    this.onUsage = typeof onUsage === "function" ? onUsage : undefined;
    // Optional live callback invoked for each captured trace record (reasoning
    // deltas, tool-call lifecycle) as it is observed, before the run finishes.
    this.onTrace = typeof onTrace === "function" ? onTrace : undefined;
    this.pending = "";
    this.decoder = new StringDecoder("utf8");
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
    this.reasoning = "";           // bounded thinking only (never includes assistant prose)
    this.assistantText = "";       // separately bounded assistant prose
    this.reasoningDeltas = 0;
    this.textDeltas = 0;
    this.toolCallStarted = 0;
    this.toolCallCompleted = 0;
    this.toolExecutionStarted = 0;
    this.toolExecutionUpdated = 0;
    this.toolExecutionEnded = 0;
    this.commandEvents = 0;
    // Pi emits one turn_start before the initial user message and one before
    // each later model request. Tool execution and tool-result messages remain
    // inside that turn, so only turn_start advances this scope.
    this.turnSequence = 0;
    this.currentTurn = undefined;
    this.occurrenceSequence = 0;
    this.declarationsById = new Map();
    this.declarationsByContent = new Map();
    this.activeExecutions = new Map();
    this.correlationRecords = 0;
  }

  push(value) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      // Keep decoder output chunks bounded even if a caller supplies one giant
      // Buffer. String inputs are already decoded by the runner and are passed
      // through without re-encoding.
      const chunkBytes = Math.min(this.maxLineBytes, 64 * 1024);
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        this.pushDecoded(this.decoder.write(bytes.subarray(offset, offset + chunkBytes)));
      }
      return;
    }
    // A string cannot complete bytes buffered inside StringDecoder. Flush an
    // incomplete sequence (as U+FFFD) before accepting the already-decoded
    // string, preserving input order instead of reordering it behind a later
    // Buffer. Complete Buffer boundaries produce an empty tail here.
    this.pushDecoded(this.decoder.end());
    this.pushDecoded(String(value ?? ""));
  }

  pushDecoded(value) {
    let input = value;
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
    this.pushDecoded(this.decoder.end());
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
        text: this.assistantText,
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
        textDeltas: this.textDeltas,
        toolCallStarted: this.toolCallStarted,
        toolCallCompleted: this.toolCallCompleted,
        toolExecutionStarted: this.toolExecutionStarted,
        toolExecutionUpdated: this.toolExecutionUpdated,
        toolExecutionEnded: this.toolExecutionEnded,
        commandEvents: this.commandEvents,
        invocationId: this.invocationId,
        attempt: this.attempt,
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
    if (type === "turn_start") {
      this.beginTurn();
      this.droppedEvents++;
      return;
    }
    if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
      this.consumeToolExecution(line, type);
      return;
    }
    if (type === "agent_end") {
      // Do not parse/retain agent_end.messages. The scope boundary alone is
      // enough to mark executions lacking a real execution end as interrupted.
      this.captureCommandEvent("agent_execution_scope_end", {});
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
      if (this.onUsage) safeCall(this.onUsage, { usage: message.usage, model: message.model });
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
    if (Buffer.byteLength(ameRaw, "utf8") > this.maxExecutionEventParseBytes) {
      this.traceExcluded++;
      const kind = parseJsonRaw(findTopLevelValueRaw(ameRaw, "type"));
      const contentIndex = parseJsonRaw(findTopLevelValueRaw(ameRaw, "contentIndex"));
      if (kind === "toolcall_start") {
        this.captureToolCallStarted({
          id: findObjectString(ameRaw, "id"),
          toolName: findObjectString(ameRaw, "toolName"),
          contentIndex,
        });
      } else if (kind === "toolcall_end") {
        // Prefer exact start metadata for this content block. If the start was
        // unavailable, structurally scan only direct toolCall scalar fields;
        // never regex through user arguments or parse the oversized object.
        const established = this.establishedDeclaration(contentIndex);
        this.captureToolCallCompletedFields({
          toolCallId: established?.toolCallId ?? findNestedObjectString(ameRaw, "toolCall", "id"),
          toolName: established?.toolName ?? findNestedObjectString(ameRaw, "toolCall", "name"),
          contentIndex,
          argsPreview: omittedPreview(Buffer.byteLength(ameRaw, "utf8"), "event_input_limit"),
        });
      }
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
    if (contentType === "thinking") this.reasoningDeltas++;
    else this.textDeltas++;

    // Bounded retention: accumulate each content class up to a fixed cap, never the
    // full stream, so an unbounded number of tiny deltas cannot grow heap.
    // Every retained content_delta record honors a UTF-8 byte budget (exposed
    // under the legacy maxReasoningChars option). When accumulation is at budget there is
    // no room left, so `keep` stays empty and the whole delta is excluded —
    // never leave `keep` as the full uncapped safeDelta, which would let a
    // single record carry up to maxLineBytes of text into the window for
    // non-coalescing content streams.
    const accumulator = contentType === "thinking" ? "reasoning" : "assistantText";
    let keep = "";
    const accumulatedBytes = Buffer.byteLength(this[accumulator], "utf8");
    if (accumulatedBytes < this.maxReasoningChars) {
      const added = truncateUtf8(safeDelta, this.maxReasoningChars - accumulatedBytes);
      this[accumulator] += added;
      keep = added;
    }
    // Align traceExcluded with what was truly not retained: any portion of the
    // delta beyond the remaining budget (or the entire delta, when at budget).
    if (keep.length < safeDelta.length) this.traceExcluded++;

    const record = { type: "content_delta", agent: "assistant", contentType, contentIndex, delta: keep };
    // Deliver a shallow copy so an external live consumer never observes the
    // same object being coalesced/mutated inside the retained window.
    if (this.onTrace) safeCall(this.onTrace, { ...record });
    this.retainTrace(record, true);
  }

  beginTurn() {
    this.turnSequence++;
    this.currentTurn = this.turnSequence;
    this.declarationsById.clear();
    this.declarationsByContent.clear();
    this.activeExecutions.clear();
    this.correlationRecords = 0;
  }

  correlationKey(toolCallId) {
    return `${this.currentTurn ?? "unknown"}\0${toolCallId}`;
  }

  newCorrelationRecord(toolCallId, toolName, contentIndex) {
    toolCallId = boundedCommandString(toolCallId);
    toolName = boundedCommandString(toolName);
    if (!toolCallId || this.correlationRecords >= MAX_CORRELATION_RECORDS_PER_TURN) return undefined;
    const record = {
      toolCallId,
      toolName,
      contentIndex: Number.isSafeInteger(contentIndex) ? contentIndex : undefined,
      occurrence: ++this.occurrenceSequence,
      ready: false,
      executionStarted: false,
      executionEnded: false,
    };
    this.correlationRecords++;
    const idKey = this.correlationKey(toolCallId);
    const byId = this.declarationsById.get(idKey) || [];
    byId.push(record);
    this.declarationsById.set(idKey, byId);
    if (record.contentIndex !== undefined) {
      const byContent = this.declarationsByContent.get(record.contentIndex) || [];
      byContent.push(record);
      this.declarationsByContent.set(record.contentIndex, byContent);
    }
    return record;
  }

  establishedDeclaration(contentIndex) {
    if (!Number.isSafeInteger(contentIndex)) return undefined;
    const candidates = (this.declarationsByContent.get(contentIndex) || []).filter((record) => !record.ready);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  declarationIdentity(toolCallId, toolName, contentIndex, completing = false) {
    toolCallId = boundedCommandString(toolCallId);
    toolName = boundedCommandString(toolName);
    if (!toolCallId) return {};
    let record;
    let ambiguous = false;
    if (completing) {
      const byContent = Number.isSafeInteger(contentIndex)
        ? (this.declarationsByContent.get(contentIndex) || []).filter((candidate) => !candidate.ready && candidate.toolCallId === toolCallId)
        : [];
      if (byContent.length === 1) record = byContent[0];
      else if (byContent.length > 1) ambiguous = true;
      if (!record && !ambiguous) {
        const byId = (this.declarationsById.get(this.correlationKey(toolCallId)) || []).filter((candidate) => !candidate.ready);
        if (byId.length === 1) record = byId[0];
        else if (byId.length > 1) ambiguous = true;
      }
    } else {
      record = this.newCorrelationRecord(toolCallId, toolName, contentIndex);
    }
    if (!record && !ambiguous) record = this.newCorrelationRecord(toolCallId, toolName, contentIndex);
    if (!record) return { turn: this.currentTurn, identitySource: "synthetic" };
    if (completing) record.ready = true;
    record.toolName ||= toolName;
    return { turn: this.currentTurn, occurrence: record.occurrence };
  }

  executionIdentity(type, toolCallId) {
    toolCallId = boundedCommandString(toolCallId);
    if (!toolCallId) return {};
    const key = this.correlationKey(toolCallId);
    let record;
    let ambiguous = false;
    if (type === "tool_execution_start") {
      if (this.activeExecutions.has(key)) {
        ambiguous = true;
      } else {
        const candidates = (this.declarationsById.get(key) || []).filter((candidate) => !candidate.executionStarted);
        if (candidates.length === 1) record = candidates[0];
        else if (candidates.length > 1) ambiguous = true;
        else record = this.newCorrelationRecord(toolCallId, undefined, undefined);
      }
      if (record) record.executionStarted = true;
      else ambiguous = true;
      // Unknown overflow must not retain another key. Ambiguity sentinels are
      // allowed only for IDs already charged to the bounded turn budget.
      if (this.declarationsById.has(key)
        && (this.activeExecutions.has(key) || this.activeExecutions.size < MAX_CORRELATION_RECORDS_PER_TURN)) {
        this.activeExecutions.set(key, record || null);
      }
    } else if (this.activeExecutions.has(key)) {
      record = this.activeExecutions.get(key) || undefined;
      ambiguous = !record;
    } else {
      const candidates = (this.declarationsById.get(key) || []).filter((candidate) => !candidate.executionEnded);
      if (candidates.length === 1) record = candidates[0];
      else if (candidates.length > 1) ambiguous = true;
      else record = this.newCorrelationRecord(toolCallId, undefined, undefined);
      if (!record) ambiguous = true;
    }
    if (type === "tool_execution_end") {
      if (record) record.executionEnded = true;
      this.activeExecutions.delete(key);
    }
    return ambiguous
      ? { turn: this.currentTurn, identitySource: "synthetic" }
      : { turn: this.currentTurn, occurrence: record?.occurrence };
  }

  captureToolCallStarted(ame) {
    this.toolCallStarted++;
    const toolCallId = boundedCommandString(ame.id);
    const toolName = boundedCommandString(ame.toolName);
    this.captureCommandEvent("tool_call_preparing", {
      toolCallId,
      toolName,
      contentIndex: ame.contentIndex,
      ...this.declarationIdentity(toolCallId, toolName, ame.contentIndex),
    });
  }

  captureToolCallCompleted(ame) {
    const toolCall = ame.toolCall && typeof ame.toolCall === "object" ? ame.toolCall : {};
    this.captureToolCallCompletedFields({
      toolCallId: typeof toolCall.id === "string" ? toolCall.id : undefined,
      toolName: typeof toolCall.name === "string" ? toolCall.name : undefined,
      contentIndex: ame.contentIndex,
      argsPreview: previewArguments(toolCall.arguments ?? {}, this.maxToolCallArgChars),
    });
  }

  captureToolCallCompletedFields(fields) {
    fields = { ...fields, toolCallId: boundedCommandString(fields.toolCallId), toolName: boundedCommandString(fields.toolName) };
    this.toolCallCompleted++;
    this.captureCommandEvent("tool_call_ready", {
      ...fields,
      ...this.declarationIdentity(fields.toolCallId, fields.toolName, fields.contentIndex, true),
    });
  }

  consumeToolExecution(line, type) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    let event;
    if (lineBytes <= this.maxExecutionEventParseBytes) {
      try { event = JSON.parse(line); }
      catch { this.malformedEvents++; return; }
    } else {
      // Preserve lifecycle truth and authoritative isError without materializing
      // a potentially multi-megabyte args/result object.
      event = {
        toolCallId: findObjectString(line, "toolCallId"),
        toolName: findObjectString(line, "toolName"),
        isError: parseJsonRaw(findTopLevelValueRaw(line, "isError")),
        _inputOmitted: true,
      };
      this.traceExcluded++;
    }

    const hasArgs = Object.prototype.hasOwnProperty.call(event, "args");
    const toolCallId = boundedCommandString(event.toolCallId);
    const common = {
      toolCallId,
      toolName: boundedCommandString(event.toolName),
      ...this.executionIdentity(type, toolCallId),
      argsPreview: event._inputOmitted
        ? type === "tool_execution_end" ? undefined : omittedPreview(lineBytes, "event_input_limit")
        : hasArgs ? previewArguments(event.args, this.maxToolCallArgChars) : undefined,
    };
    if (type === "tool_execution_start") {
      this.toolExecutionStarted++;
      this.captureCommandEvent(type, common);
      return;
    }
    if (type === "tool_execution_update") {
      this.toolExecutionUpdated++;
      this.captureCommandEvent(type, {
        ...common,
        outputPreview: event._inputOmitted
          ? omittedPreview(lineBytes, "event_input_limit")
          : previewToolResult(event.partialResult, event.toolName, false, this.maxResultPreviewBytes),
      });
      return;
    }
    this.toolExecutionEnded++;
    this.captureCommandEvent(type, {
      ...common,
      // Pi's boolean isError is the sole authority for command success/failure.
      // No exit status is inferred from result text.
      isError: typeof event.isError === "boolean" ? event.isError : undefined,
      resultPreview: event._inputOmitted
        ? omittedPreview(lineBytes, "event_input_limit")
        : previewToolResult(event.result, event.toolName, event.isError === true, this.maxResultPreviewBytes),
    });
  }

  captureCommandEvent(type, fields) {
    this.traceEvents++;
    this.commandEvents++;
    const sequence = this.commandEvents;
    const realId = boundedCommandString(fields.toolCallId);
    const identitySource = realId && fields.identitySource !== "synthetic" ? "pi" : "synthetic";
    const syntheticId = identitySource === "synthetic" ? `${this.invocationId}:missing:${sequence}` : undefined;
    const record = {
      schema: "pi-command-event/v1",
      type,
      agent: "assistant",
      commandEventId: `${this.invocationId}:${sequence}`,
      invocationId: this.invocationId,
      attempt: this.attempt,
      turn: Number.isSafeInteger(fields.turn) && fields.turn > 0 ? fields.turn : undefined,
      occurrence: Number.isSafeInteger(fields.occurrence) && fields.occurrence > 0 ? fields.occurrence : undefined,
      identitySource,
      toolCallId: realId,
      syntheticId,
      toolName: boundedCommandString(fields.toolName),
      contentIndex: Number.isSafeInteger(fields.contentIndex) ? fields.contentIndex : undefined,
      argsPreview: fields.argsPreview,
      outputPreview: fields.outputPreview,
      resultPreview: fields.resultPreview,
      isError: fields.isError,
    };
    const clean = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
    if (this.onTrace) safeCall(this.onTrace, { ...clean });
    this.retainTrace(clean, false);
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

function truncateUtf8(text, maxBytes) {
  const value = String(text ?? "");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let out = value.slice(0, maxBytes);
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return out;
}

function textPreview(text, maxBytes, extras = {}) {
  const source = String(text ?? "");
  const bytes = Buffer.byteLength(source, "utf8");
  const redacted = redactSecrets(source);
  const retained = truncateUtf8(redacted, maxBytes);
  return {
    text: retained,
    bytes: extras.bytes ?? bytes,
    retainedBytes: Buffer.byteLength(retained, "utf8"),
    truncated: extras.truncated ?? (bytes > maxBytes || Buffer.byteLength(redacted, "utf8") > maxBytes),
    ...(redacted !== source ? { redacted: true } : {}),
    ...extras,
  };
}

function omittedPreview(bytes, omitted) {
  return textPreview(`[${omitted === "read_output" ? "read output omitted by policy" : omitted === "non_text" ? "non-text result omitted" : "event content omitted at ingestion limit"}]`, DEFAULT_MAX_RESULT_PREVIEW_BYTES, {
    bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0,
    truncated: true,
    omitted,
  });
}

const SENSITIVE_FIELD = /(?:authorization|proxy-authorization|cookie|set-cookie|token|secret|api[-_]?key|password|passwd|credential|bearer)/i;
const BLOB_FIELD = /(?:headers?|base64|image|attachment|binary)/i;
const PROBABLE_BLOB = /^[A-Za-z0-9+/=_-]{512,}$/;

function sanitizeStructured(value, state, depth = 0, key = "") {
  if (SENSITIVE_FIELD.test(key)) { state.redacted = true; return "[redacted]"; }
  if (BLOB_FIELD.test(key)) { state.omitted = true; return "[omitted blob]"; }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (PROBABLE_BLOB.test(value)) { state.omitted = true; return `[omitted probable encoded blob: ${Buffer.byteLength(value, "utf8")} bytes]`; }
    const safe = redactSecrets(value);
    if (safe !== value) state.redacted = true;
    const remaining = Math.max(0, state.charBudget);
    const kept = safe.slice(0, Math.min(remaining, 2_048));
    state.charBudget -= kept.length;
    if (kept.length < safe.length) state.omitted = true;
    return kept;
  }
  if (depth >= 6 || state.nodes >= 160) { state.omitted = true; return "[omitted nested value]"; }
  state.nodes++;
  if (Array.isArray(value)) {
    const out = value.slice(0, 24).map((entry) => sanitizeStructured(entry, state, depth + 1));
    if (value.length > out.length) { state.omitted = true; out.push(`[${value.length - out.length} more items omitted]`); }
    return out;
  }
  if (!value || typeof value !== "object") return String(value);
  const out = {};
  const allEntries = Object.entries(value);
  const entries = allEntries.slice(0, 48);
  for (const [nestedKey, nested] of entries) out[String(nestedKey).slice(0, 128)] = sanitizeStructured(nested, state, depth + 1, nestedKey);
  if (allEntries.length > entries.length) { state.omitted = true; out["[omitted]"] = `${allEntries.length - entries.length} more fields`; }
  return out;
}

function previewArguments(args, maxBytes) {
  const state = { nodes: 0, charBudget: maxBytes * 2, redacted: false, omitted: false };
  let serialized;
  try { serialized = typeof args === "string" ? redactSecrets(args) : JSON.stringify(sanitizeStructured(args, state)); }
  catch { serialized = "[unserializable arguments omitted]"; state.omitted = true; }
  const preview = textPreview(serialized, maxBytes);
  if (state.redacted || (typeof args === "string" && serialized !== args)) preview.redacted = true;
  if (state.omitted) preview.truncated = true;
  return preview;
}

function resultText(result) {
  if (typeof result === "string") return { text: result, hasNonText: false };
  if (!result || typeof result !== "object") return { text: "", hasNonText: result !== undefined };
  const content = Array.isArray(result.content) ? result.content : [];
  let text = "";
  let hasNonText = false;
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") text += `${text ? "\n" : ""}${part.text}`;
    else if (part !== undefined) hasNonText = true;
  }
  return { text, hasNonText };
}

function previewToolResult(result, toolName, isError, maxBytes) {
  const extracted = resultText(result);
  const bytes = Buffer.byteLength(extracted.text, "utf8");
  if (String(toolName || "").toLowerCase() === "read" && !isError) return omittedPreview(bytes, "read_output");
  if (!extracted.text && extracted.hasNonText) return omittedPreview(0, "non_text");
  if (!extracted.text) return undefined;
  return textPreview(extracted.text, maxBytes);
}

function parseJsonRaw(raw) {
  // Only small discriminator/index/boolean scalars use this path. An oversized
  // or malformed metadata object must not bypass the event parse budget.
  if (raw === undefined || raw.length > 64) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
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

/** Extract one direct object value without materializing sibling payloads. */
function findObjectValueRange(line, key, objectStart = 0, objectEnd = line.length) {
  let depth = 0;
  let index = objectStart;
  while (index < objectEnd) {
    const char = line[index];
    if (char === "{") { depth++; index++; continue; }
    if (char === "}") { depth--; index++; continue; }
    if (char !== '"') { index++; continue; }
    const start = index;
    index = jsonStringEnd(line, index);
    let cursor = index + 1;
    while (/\s/.test(line[cursor] || "")) cursor++;
    // Values can themselves be very large strings. Check structural key
    // position before JSON.parse so only small property names are decoded.
    if (line[cursor] !== ":" || depth !== 1) { index++; continue; }
    if (index - start + 1 > key.length * 6 + 2) { index++; continue; }
    let parsedKey;
    try { parsedKey = JSON.parse(line.slice(start, index + 1)); } catch { index++; continue; }
    if (parsedKey !== key) { index++; continue; }
    cursor++;
    while (/\s/.test(line[cursor] || "")) cursor++;
    const end = jsonValueEnd(line, cursor);
    return end === undefined || end > objectEnd ? undefined : [cursor, end];
  }
  return undefined;
}

function findTopLevelValueRaw(line, key) {
  const range = findObjectValueRange(line, key);
  return range ? line.slice(range[0], range[1]) : undefined;
}

function boundedStringFromRange(line, range, maxBytes = MAX_COMMAND_METADATA_BYTES) {
  // A JSON string character can occupy six source characters as a \uXXXX
  // escape. Reject a larger scalar before slicing/parsing it, then check the
  // decoded UTF-8 bound without shortening an identifier into a shared prefix.
  if (!range || range[1] - range[0] > maxBytes * 6 + 2) return undefined;
  let value;
  try { value = JSON.parse(line.slice(range[0], range[1])); } catch { return undefined; }
  return boundedCommandString(value, maxBytes);
}

function findObjectString(line, key) {
  return boundedStringFromRange(line, findObjectValueRange(line, key));
}

/** Extract only a bounded direct string child from a named top-level object. */
function findNestedObjectString(line, objectKey, key) {
  const objectRange = findObjectValueRange(line, objectKey);
  if (!objectRange || line[objectRange[0]] !== "{") return undefined;
  return boundedStringFromRange(line, findObjectValueRange(line, key, objectRange[0], objectRange[1]));
}

function jsonStringEnd(text, start) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index++) {
    if (escaped) escaped = false;
    else if (text[index] === "\\") escaped = true;
    else if (text[index] === '"') return index;
  }
  return text.length - 1;
}

function jsonValueEnd(text, start) {
  if (text[start] === '"') return jsonStringEnd(text, start) + 1;
  if (text[start] === "{" || text[start] === "[") {
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let index = start; index < text.length; index++) {
      if (text[index] === '"') { index = jsonStringEnd(text, index); continue; }
      if (text[index] === open) depth++;
      else if (text[index] === close && --depth === 0) return index + 1;
    }
    return undefined;
  }
  let end = start;
  while (end < text.length && text[end] !== "," && text[end] !== "}") end++;
  return end;
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
