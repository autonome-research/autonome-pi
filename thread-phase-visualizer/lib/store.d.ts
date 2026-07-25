export type ThreadPhaseUiStatus = "running" | "success" | "failed" | "cancelled" | "skipped" | "unknown" | string;
export type ThreadPhaseNormalizedStatus = "running" | "success" | "failed" | "cancelled" | "skipped" | "unknown";

export type ThreadPhaseArtifact = {
  kind: "markdown" | "file" | "url" | "json" | string;
  title: string;
  path?: string;
  url?: string;
  content?: string;
  preview?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
};

export type ThreadPhaseOwnerMetadata = {
  sessionId?: string;
  sessionFile?: string;
  launchSource?: string;
  cwdAtLaunch?: string;
  [key: string]: unknown;
};

export type ThreadPhaseRunContext = {
  runId: string;
  workflow: string;
  cwd?: string;
  trigger?: unknown;
  metadata?: ThreadPhaseOwnerMetadata;
  /** Canonical path returned by createRun; caller-provided overrides are rejected. */
  readonly runFile?: string;
};

export type ThreadPhaseUiEvent = {
  schema: "thread-phase-ui/v1";
  eventId: string;
  timestamp: string;
  runId: string;
  workflow: string;
  cwd?: string;
  trigger?: unknown;
  type:
    | "workflow_start"
    | "workflow_end"
    | "phase_start"
    | "phase_event"
    | "phase_end"
    | "agent_event"
    | "artifact"
    | "error"
    | string;
  phase?: string;
  status?: ThreadPhaseUiStatus;
  level?: "debug" | "info" | "warning" | "error" | string;
  message?: string;
  data?: unknown;
  artifact?: ThreadPhaseArtifact;
  error?: { name?: string; message: string; stack?: string; code?: string };
  metadata?: ThreadPhaseOwnerMetadata;
};

export type ThreadPhaseUsageSummary = {
  entries: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  fields: Record<string, number>;
  models: Record<string, ThreadPhaseUsageSummary>;
};

export type ThreadPhaseFanoutItemSummary = {
  itemId: string;
  label: string;
  index?: number;
  status?: ThreadPhaseUiStatus;
  normalizedStatus: ThreadPhaseNormalizedStatus;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  lastMessage?: string;
  error?: unknown;
  model?: string;
  usage?: ThreadPhaseUsageSummary;
};

export type ThreadPhaseFanoutSummary = {
  label?: string;
  total?: number;
  completed: number;
  failed: number;
  running: number;
  items: ThreadPhaseFanoutItemSummary[];
};

export type ThreadPhaseActiveIoSnapshot = {
  schema?: "thread-phase-active-io/v1" | string;
  timestamp?: string;
  updatedAt?: string;
  phase?: string;
  componentId?: string;
  component?: string;
  role?: string;
  status?: string;
  pid?: number;
  cwd?: string;
  command?: string;
  inputPreview?: string;
  outputPreview?: string;
  stdoutPreview?: string;
  stderrPreview?: string;
  inputBytes?: number;
  outputBytes?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  truncated?: boolean;
  message?: string;
};

export type ThreadPhaseHeartbeatSummary = {
  timestamp?: string;
  pid?: number;
  childPids?: number[];
  phase?: string;
  message?: string;
  milestoneId?: string;
  featureId?: string;
  validator?: string;
  branch?: string;
  worktree?: string;
};

export type ThreadPhaseStaleSummary = {
  reason: "pid_not_running" | "heartbeat_stale" | string;
  pid?: number;
  ageMs?: number;
  checkedAt?: string;
};

export type ThreadPhasePhaseSummary = {
  phase: string;
  status?: ThreadPhaseUiStatus;
  normalizedStatus: ThreadPhaseNormalizedStatus;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  eventCount: number;
  lastMessage?: string;
  type?: string;
  model?: string;
  progress?: { current?: number; total?: number; percent?: number; message?: string };
  fanout?: ThreadPhaseFanoutSummary;
  usage?: ThreadPhaseUsageSummary;
  heartbeat?: ThreadPhaseHeartbeatSummary;
  activeIo?: ThreadPhaseActiveIoSnapshot;
};

export type ThreadPhaseRunSummary = {
  runId?: string;
  workflow?: string;
  cwd?: string;
  trigger?: unknown;
  metadata?: ThreadPhaseOwnerMetadata;
  /** Whether workflow_start was present or verified by a bounded store lookup. */
  workflowStartResolved: boolean;
  /** Whether the authoritative workflow_start record contained its own cwd field. */
  workflowStartCwdPresent?: boolean;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  status: ThreadPhaseUiStatus;
  normalizedStatus: ThreadPhaseNormalizedStatus;
  phases: ThreadPhasePhaseSummary[];
  artifacts: Array<ThreadPhaseArtifact & { eventId?: string; timestamp?: string }>;
  errors: Array<{ timestamp?: string; phase?: string; message?: string; error?: unknown }>;
  progress: Record<string, { current?: number; total?: number; percent?: number; message?: string }>;
  usage: ThreadPhaseUsageSummary;
  heartbeat?: ThreadPhaseHeartbeatSummary;
  activeIo?: ThreadPhaseActiveIoSnapshot;
  stale?: ThreadPhaseStaleSummary;
  lastMessage?: string;
  eventCount: number;
  events: ThreadPhaseUiEvent[];
};

export const SCHEMA_VERSION: "thread-phase-ui/v1";
export const EVENT_TYPES: Readonly<{
  WORKFLOW_START: "workflow_start";
  WORKFLOW_END: "workflow_end";
  PHASE_START: "phase_start";
  PHASE_EVENT: "phase_event";
  PHASE_END: "phase_end";
  AGENT_EVENT: "agent_event";
  ARTIFACT: "artifact";
  ERROR: "error";
}>;
export const STATUSES: Readonly<{
  RUNNING: "running";
  SUCCESS: "success";
  FAILED: "failed";
  CANCELLED: "cancelled";
  SKIPPED: "skipped";
  UNKNOWN: "unknown";
}>;
export const AGENT_DIR: string;
export const STORE_DIR: string;
export const RUNS_DIR: string;
export const ARTIFACTS_DIR: string;
export const CANCEL_DIR: string;
export const INDEX_FILE: string;

export function ensureStore(): void;
export function createRunId(workflow?: string): string;
export function safeRunId(runId: string): string;
export function runFileFor(runId: string): string;
export function cancelFileFor(runId: string): string;
export function requestCancellation(runId: string, options?: { reason?: string; source?: string }): { runId: string; requestedAt: string; reason: string; source: string };
export function readCancellation(runId: string): { runId?: string; requestedAt?: string; reason?: string; source?: string } | undefined;
export function createRun(options?: {
  workflow?: string;
  cwd?: string;
  trigger?: unknown;
  input?: unknown;
  metadata?: ThreadPhaseOwnerMetadata;
  runId?: string;
  message?: string;
}): ThreadPhaseRunContext;
export function emit(run: ThreadPhaseRunContext, event?: Partial<ThreadPhaseUiEvent>): ThreadPhaseUiEvent | undefined;
export function phaseStart(run: ThreadPhaseRunContext, phase: string, data?: unknown): ThreadPhaseUiEvent;
export function phaseEvent(run: ThreadPhaseRunContext, phase: string, event?: unknown): ThreadPhaseUiEvent | undefined;
export function emitActiveIo(run: ThreadPhaseRunContext, phase: string, io?: ThreadPhaseActiveIoSnapshot): ThreadPhaseUiEvent | undefined;
export function phaseEnd(run: ThreadPhaseRunContext, phase: string, status?: ThreadPhaseUiStatus, data?: unknown): ThreadPhaseUiEvent;
export function artifact(run: ThreadPhaseRunContext, artifact: ThreadPhaseArtifact): ThreadPhaseUiEvent;
export function completeRun(run: ThreadPhaseRunContext, status?: ThreadPhaseUiStatus, data?: unknown): ThreadPhaseUiEvent;
export function failRun(run: ThreadPhaseRunContext, error: unknown, data?: unknown): ThreadPhaseUiEvent;
export function emitAgentEvent(run: ThreadPhaseRunContext, phase: string | undefined, agentEvent: unknown): ThreadPhaseUiEvent;
export function emitPipelineEvent(run: ThreadPhaseRunContext, phase: string | undefined, pipelineEvent: unknown): ThreadPhaseUiEvent;
export function mirrorPipelineEvents<T>(events: AsyncIterable<T>, run: ThreadPhaseRunContext, options?: { phase?: string }): AsyncGenerator<T>;
export function wrapPhase<TPhase extends { name?: string; run(ctx: any, ...args: any[]): AsyncIterable<any> }>(
  phase: TPhase,
  run: ThreadPhaseRunContext,
  options?: { name?: string; input?: (ctx: any) => unknown; output?: (ctx: any) => unknown },
): TPhase;
export function wrapPhases<TPhase extends { name?: string; run(ctx: any, ...args: any[]): AsyncIterable<any> }>(
  phases: TPhase[],
  run: ThreadPhaseRunContext,
  options?: Record<string, { name?: string; input?: (ctx: any) => unknown; output?: (ctx: any) => unknown }>,
): TPhase[];
export type ThreadPhaseBoundedReadOptions = {
  /** Read forward from this byte offset; omitted reads from the file tail. */
  fromByte?: number;
  /** Maximum events returned. */
  limit?: number;
  /** Maximum JSONL lines inspected. */
  readLimit?: number;
  /** Maximum file bytes retained and decoded by one read. */
  maxBytes?: number;
};

export type ThreadPhaseJsonlParseError = {
  kind: "invalid_json" | "partial_final_line" | "oversized_record";
  file: string;
  /** Zero-based position within the bounded read window. */
  lineIndex: number;
  message: string;
  preview: string;
};

export type ThreadPhaseJsonlReadResult = ThreadPhaseUiEvent[] & {
  /** Invalid and incomplete lines skipped while producing this result. */
  readonly parseErrors: ThreadPhaseJsonlParseError[];
};

export function readJsonl(file: string, options?: ThreadPhaseBoundedReadOptions): ThreadPhaseJsonlReadResult;
export function readRunBounded(runId: string, options?: ThreadPhaseBoundedReadOptions): ThreadPhaseJsonlReadResult;
export function readIndexBounded(options?: ThreadPhaseBoundedReadOptions & { workflow?: string; cwd?: string }): ThreadPhaseJsonlReadResult;
export function readRun(runId: string, options?: ThreadPhaseBoundedReadOptions): ThreadPhaseJsonlReadResult;
export function readIndex(options?: ThreadPhaseBoundedReadOptions & { workflow?: string; cwd?: string }): ThreadPhaseJsonlReadResult;
export type ThreadPhaseProjectionOptions = {
  /** Shared clock used for stale age and checkedAt calculations. */
  referenceTime?: number | string | Date;
};

export function projectRun(events?: ThreadPhaseUiEvent[], options?: ThreadPhaseProjectionOptions): ThreadPhaseRunSummary;
export function projectRuns(events?: ThreadPhaseUiEvent[], options?: ThreadPhaseProjectionOptions): ThreadPhaseRunSummary[];
export function getRunSummary(runId: string): ThreadPhaseRunSummary;
export type ThreadPhaseRunSummaryReadOptions = {
  limit?: number;
  workflow?: string;
  cwd?: string;
  readLimit?: number;
  /** Aggregate bytes allowed for authoritative run-prefix verification, including sidecar cross-checks. Default 8 MiB. */
  ownershipReadBudgetBytes?: number;
  /** Maximum authoritative run-prefix scans per query, including sidecar cross-checks. Default 256. */
  ownershipFallbackScanLimit?: number;
  /** Aggregate bytes allowed for sidecar fallback when a catalog record is unavailable. Default 4 MiB. */
  ownershipSidecarReadBudgetBytes?: number;
  /** Maximum sidecar fallback reads per query. Catalog hits do not consume this budget. Default 256. */
  ownershipSidecarScanLimit?: number;
  /** Applied exactly once to each fully restored public summary and before limit. */
  filter?: (run: ThreadPhaseRunSummary) => boolean;
  /** Internal security prefilter over compact ownership data; may be rechecked after sidecar verification. */
  ownershipFilter?: (run: ThreadPhaseRunSummary) => boolean;
};
export function latestRunSummaries(options?: ThreadPhaseRunSummaryReadOptions): ThreadPhaseRunSummary[];
export function latestRuns(options?: ThreadPhaseRunSummaryReadOptions): ThreadPhaseRunSummary[];
export function formatUsageSummary(usage: ThreadPhaseUsageSummary | undefined): string;
export function readArtifactContent(artifact: ThreadPhaseArtifact, options?: { maxBytes?: number }): { content: string; truncated: boolean; bytes?: number } | undefined;
export function normalizeStatus(status?: unknown): ThreadPhaseNormalizedStatus;
