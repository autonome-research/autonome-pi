import type { CommandLedgerEvent, CommandPreview } from "../../thread-phase-visualizer/lib/command-ledger.mjs";

export type PiTraceEvent = CommandLedgerEvent | {
  type: "content_delta";
  agent: "assistant";
  contentType: "thinking" | "text";
  contentIndex?: number;
  delta: string;
};

export type PiJsonCollectorOptions = {
  maxLineBytes?: number;
  maxTraceWindow?: number;
  maxReasoningChars?: number;
  maxToolCallArgChars?: number;
  /** Events larger than this are discriminator/scalar-scanned, not fully parsed. */
  maxExecutionEventParseBytes?: number;
  maxResultPreviewBytes?: number;
  invocationId?: string;
  attempt?: number;
  onUsage?: (entry: { usage: Record<string, unknown>; model?: string }) => void;
  onTrace?: (event: PiTraceEvent) => void;
};

export type PiJsonCollectorResult = {
  text: string;
  usage: Array<Record<string, unknown>>;
  model?: string;
  stopReason?: string;
  trace: { schema: "pi-agent-trace/v1"; window: PiTraceEvent[]; reasoning: string; text: string };
  piJson: {
    droppedEvents: number;
    malformedEvents: number;
    oversizedEvents: number;
    usageEvents: number;
    traceEvents: number;
    traceDropped: number;
    traceExcluded: number;
    reasoningDeltas: number;
    textDeltas: number;
    toolCallStarted: number;
    toolCallCompleted: number;
    toolExecutionStarted: number;
    toolExecutionUpdated: number;
    toolExecutionEnded: number;
    commandEvents: number;
    invocationId: string;
    attempt: number;
    bufferedBytes: number;
  };
};

export class PiJsonEventCollector {
  constructor(options?: PiJsonCollectorOptions);
  readonly invocationId: string;
  readonly attempt: number;
  readonly maxLineBytes: number;
  readonly maxTraceWindow: number;
  readonly maxReasoningChars: number;
  readonly maxToolCallArgChars: number;
  readonly maxExecutionEventParseBytes: number;
  readonly maxResultPreviewBytes: number;
  push(value: unknown): void;
  finish(): PiJsonCollectorResult;
  result(): PiJsonCollectorResult;
}

export type { CommandPreview };
