export const COMMAND_LEDGER_SCHEMA: "thread-phase-command-ledger/v1";

export type CommandPreview = {
  text: string;
  /** UTF-8 bytes in the observed textual source when known. */
  bytes: number;
  retainedBytes: number;
  truncated: boolean;
  omitted?: "read_output" | "non_text" | "event_input_limit" | string;
  redacted?: boolean;
};

export type CommandState = "preparing" | "ready" | "executing" | "finished" | "succeeded" | "failed" | "interrupted";
export type CommandOutcome = "unobserved" | "running" | "success" | "failure" | "interrupted";

export type CommandLedgerRow = {
  /** Opaque stable projection key; consumers must not parse it. */
  key: string;
  identitySource: "pi" | "synthetic" | "legacy";
  toolCallId?: string;
  invocationId?: string;
  attempt?: number;
  itemId?: string;
  toolName?: string;
  contentIndex?: number;
  state: CommandState;
  outcome: CommandOutcome;
  firstObservedAt?: string;
  argumentsReadyAt?: string;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  executionObserved: boolean;
  executionStartObserved: boolean;
  executionEndObserved: boolean;
  isError?: boolean;
  argsPreview?: CommandPreview;
  outputPreview?: CommandPreview;
  errorPreview?: CommandPreview;
  updateCount: number;
  observedEvents: number;
  history: Array<{ type: string; state: CommandState; at?: string }>;
  historyDropped: number;
  truncated: boolean;
};

export type CommandLedgerProjection = {
  schema: "thread-phase-command-ledger/v1";
  rows: CommandLedgerRow[];
  observedEvents: number;
  duplicateEvents: number;
  droppedCommands: number;
  retainedCommands: number;
  truncated: boolean;
};

export type CommandLedgerEvent = {
  schema?: "pi-command-event/v1" | string;
  agent?: string;
  type: "tool_call_preparing" | "tool_call_ready" | "tool_execution_start" | "tool_execution_update" | "tool_execution_end" | "agent_execution_scope_end" | "tool_call_started" | "tool_call_completed";
  commandEventId?: string;
  invocationId?: string;
  attempt?: number;
  /** Collector-scoped Pi turn_start sequence; absent for conservative legacy events. */
  turn?: number;
  /** Collector-scoped command occurrence; absent when real-id association is ambiguous. */
  occurrence?: number;
  itemId?: string;
  item?: string;
  index?: number;
  identitySource?: "pi" | "synthetic" | "legacy";
  syntheticId?: string;
  toolCallId?: string;
  toolName?: string;
  contentIndex?: number;
  isError?: boolean;
  args?: string;
  argsPreview?: CommandPreview;
  outputPreview?: CommandPreview;
  resultPreview?: CommandPreview;
};

export type MutableCommandLedger = {
  schema: "thread-phase-command-ledger/v1";
  rows: CommandLedgerRow[];
  observedEvents: number;
  duplicateEvents: number;
  droppedCommands: number;
  truncated: boolean;
  [key: string]: unknown;
};
export function isCommandLedgerEvent(data: unknown): data is CommandLedgerEvent;
export function createCommandLedger(options?: { maxCommands?: number; maxHistory?: number }): MutableCommandLedger;
export function applyCommandLedgerEvent(ledger: MutableCommandLedger, data: CommandLedgerEvent, timestamp?: string): boolean;
export function finalizeCommandLedger(ledger: MutableCommandLedger | undefined, options?: { terminal?: boolean; at?: string }): CommandLedgerProjection | undefined;
