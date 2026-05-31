export type ThreadPhaseUiStatus = "running" | "success" | "failed" | "cancelled" | "skipped" | string;

export type ThreadPhaseArtifact = {
  kind: "markdown" | "file" | "url" | "json" | string;
  title: string;
  path?: string;
  content?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
};

export type ThreadPhaseRunContext = {
  runId: string;
  workflow: string;
  cwd?: string;
  trigger?: unknown;
  metadata?: unknown;
  runFile?: string;
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
  metadata?: unknown;
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
}>;
export const AGENT_DIR: string;
export const STORE_DIR: string;
export const RUNS_DIR: string;
export const ARTIFACTS_DIR: string;
export const INDEX_FILE: string;

export function ensureStore(): void;
export function createRunId(workflow?: string): string;
export function runFileFor(runId: string): string;
export function createRun(options?: {
  workflow?: string;
  cwd?: string;
  trigger?: unknown;
  input?: unknown;
  metadata?: unknown;
  runId?: string;
  message?: string;
}): ThreadPhaseRunContext;
export function emit(run: ThreadPhaseRunContext, event?: Partial<ThreadPhaseUiEvent>): ThreadPhaseUiEvent;
export function phaseStart(run: ThreadPhaseRunContext, phase: string, data?: unknown): ThreadPhaseUiEvent;
export function phaseEvent(run: ThreadPhaseRunContext, phase: string, event?: unknown): ThreadPhaseUiEvent;
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
export function readRun(runId: string): ThreadPhaseUiEvent[];
export function readIndex(options?: { limit?: number; workflow?: string; cwd?: string }): ThreadPhaseUiEvent[];
export function latestRuns(options?: { limit?: number; workflow?: string; cwd?: string }): Array<Record<string, unknown>>;
