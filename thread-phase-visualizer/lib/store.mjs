import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const SCHEMA_VERSION = "thread-phase-ui/v1";
export const EVENT_TYPES = Object.freeze({
  WORKFLOW_START: "workflow_start",
  WORKFLOW_END: "workflow_end",
  PHASE_START: "phase_start",
  PHASE_EVENT: "phase_event",
  PHASE_END: "phase_end",
  AGENT_EVENT: "agent_event",
  ARTIFACT: "artifact",
  ERROR: "error",
});
export const STATUSES = Object.freeze({
  RUNNING: "running",
  SUCCESS: "success",
  FAILED: "failed",
  CANCELLED: "cancelled",
  SKIPPED: "skipped",
});
export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const STORE_DIR = process.env.PI_THREAD_PHASE_STORE_DIR || join(AGENT_DIR, "thread-phase");
export const RUNS_DIR = join(STORE_DIR, "runs");
export const ARTIFACTS_DIR = join(STORE_DIR, "artifacts");
export const INDEX_FILE = join(STORE_DIR, "index.jsonl");

export function ensureStore() {
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  if (!existsSync(INDEX_FILE)) writeFileSync(INDEX_FILE, "", "utf8");
}

export function createRunId(workflow = "workflow") {
  const safeWorkflow = normalizeWorkflowName(workflow);
  return `${safeWorkflow}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export function runFileFor(runId) {
  return join(RUNS_DIR, `${runId}.jsonl`);
}

function compactValue(value, maxBytes = 200_000) {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return value;
  let out = text.slice(0, maxBytes);
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return {
    truncated: true,
    bytes: Buffer.byteLength(text, "utf8"),
    preview: `${out}\n[truncated]`,
  };
}

function normalizeRun(run) {
  if (!run || typeof run !== "object") throw new Error("run context is required");
  if (!run.runId) throw new Error("run.runId is required");
  if (!run.workflow) throw new Error("run.workflow is required");
  return {
    runId: String(run.runId),
    workflow: String(run.workflow),
    cwd: run.cwd ? String(run.cwd) : undefined,
    trigger: run.trigger,
    metadata: run.metadata,
    runFile: run.runFile || runFileFor(String(run.runId)),
  };
}

export function createRun(options = {}) {
  ensureStore();
  const workflow = normalizeWorkflowName(options.workflow || "workflow");
  const run = {
    runId: options.runId || createRunId(workflow),
    workflow,
    cwd: options.cwd,
    trigger: options.trigger,
    metadata: options.metadata,
  };
  run.runFile = runFileFor(run.runId);
  emit(run, {
    type: EVENT_TYPES.WORKFLOW_START,
    status: STATUSES.RUNNING,
    message: options.message || `${workflow} started`,
    data: compactValue(options.input),
  });
  return run;
}

export function emit(runContext, event = {}) {
  ensureStore();
  const run = normalizeRun(runContext);
  const normalized = {
    schema: SCHEMA_VERSION,
    eventId: event.eventId || randomUUID(),
    timestamp: event.timestamp || new Date().toISOString(),
    runId: run.runId,
    workflow: run.workflow,
    cwd: run.cwd,
    trigger: run.trigger,
    type: normalizeEventType(event.type || EVENT_TYPES.PHASE_EVENT),
    phase: event.phase ? String(event.phase) : undefined,
    status: event.status ? normalizeStatus(event.status) : undefined,
    level: event.level,
    message: event.message,
    data: compactValue(event.data),
    artifact: compactValue(event.artifact, 20_000),
    error: event.error ? serializeError(event.error) : undefined,
    metadata: compactValue(event.metadata),
  };
  const line = `${JSON.stringify(dropUndefined(normalized))}\n`;
  appendFileSync(run.runFile, line, "utf8");
  appendFileSync(INDEX_FILE, line, "utf8");
  return normalized;
}

export function phaseStart(run, phase, data) {
  return emit(run, { type: EVENT_TYPES.PHASE_START, phase, status: STATUSES.RUNNING, message: `${phase} started`, data });
}

export function phaseEvent(run, phase, event) {
  return emit(run, { type: EVENT_TYPES.PHASE_EVENT, phase, message: event?.message, data: event });
}

export function phaseEnd(run, phase, status = STATUSES.SUCCESS, data) {
  return emit(run, { type: EVENT_TYPES.PHASE_END, phase, status, message: `${phase} ${status}`, data });
}

export function artifact(run, artifact) {
  return emit(run, {
    type: EVENT_TYPES.ARTIFACT,
    status: STATUSES.SUCCESS,
    message: artifact?.title || artifact?.path || "artifact",
    artifact,
  });
}

export function completeRun(run, status = STATUSES.SUCCESS, data) {
  return emit(run, {
    type: EVENT_TYPES.WORKFLOW_END,
    status,
    message: `${run.workflow || "workflow"} ${status}`,
    data,
  });
}

export function failRun(run, error, data) {
  emit(run, {
    type: EVENT_TYPES.ERROR,
    status: STATUSES.FAILED,
    level: "error",
    message: error?.message || String(error),
    error,
    data,
  });
  return completeRun(run, STATUSES.FAILED, { error: serializeError(error), ...data });
}

export function emitAgentEvent(run, phase, agentEvent) {
  return emit(run, {
    type: EVENT_TYPES.AGENT_EVENT,
    phase,
    status: agentEvent?.type === "agent_end" ? agentEvent?.finishReason || undefined : undefined,
    message: agentEvent?.text || agentEvent?.message || agentEvent?.type,
    data: agentEvent,
  });
}

export function emitPipelineEvent(run, phase, pipelineEvent) {
  return emit(run, {
    type: EVENT_TYPES.PHASE_EVENT,
    phase: phase || pipelineEvent?.phase || pipelineEvent?.name,
    message: pipelineEvent?.message || pipelineEvent?.type,
    data: pipelineEvent,
  });
}

export async function* mirrorPipelineEvents(events, run, options = {}) {
  for await (const event of events) {
    emitPipelineEvent(run, options.phase, event);
    yield event;
  }
}

export function wrapPhase(phase, run, options = {}) {
  if (!phase || typeof phase.run !== "function") throw new Error("wrapPhase expected a Phase-like object with run(ctx)");
  const phaseName = options.name || phase.name || "phase";
  return {
    ...phase,
    name: phase.name || phaseName,
    async *run(ctx, ...args) {
      phaseStart(run, phaseName, options.input?.(ctx));
      try {
        for await (const event of phase.run(ctx, ...args)) {
          phaseEvent(run, phaseName, event);
          yield event;
        }
        phaseEnd(run, phaseName, ctx?.stop ? STATUSES.CANCELLED : STATUSES.SUCCESS, options.output?.(ctx));
      } catch (error) {
        phaseEnd(run, phaseName, STATUSES.FAILED, { error: serializeError(error) });
        throw error;
      }
    },
  };
}

export function wrapPhases(phases, run, options = {}) {
  return phases.map((phase) => wrapPhase(phase, run, options[phase.name] || {}));
}

export function readRun(runId) {
  const file = runFileFor(runId);
  if (!existsSync(file)) return [];
  return readJsonl(file);
}

export function readIndex({ limit = 200, workflow, cwd } = {}) {
  if (!existsSync(INDEX_FILE)) return [];
  let events = readJsonl(INDEX_FILE);
  if (workflow) events = events.filter((event) => event.workflow === workflow);
  if (cwd) events = events.filter((event) => event.cwd === cwd);
  return events.slice(-limit);
}

export function latestRuns({ limit = 20, cwd, workflow } = {}) {
  const events = readIndex({ limit: 5000, cwd, workflow });
  const byRun = new Map();
  for (const event of events) {
    const current = byRun.get(event.runId) || {
      runId: event.runId,
      workflow: event.workflow,
      cwd: event.cwd,
      trigger: event.trigger,
      startedAt: event.timestamp,
      updatedAt: event.timestamp,
      status: STATUSES.RUNNING,
      phases: {},
      artifacts: [],
      lastMessage: event.message,
    };
    current.updatedAt = event.timestamp;
    current.lastMessage = event.message || current.lastMessage;
    if (event.type === EVENT_TYPES.WORKFLOW_END) current.status = event.status || STATUSES.SUCCESS;
    if (event.type === EVENT_TYPES.PHASE_START && event.phase) current.phases[event.phase] = STATUSES.RUNNING;
    if (event.type === EVENT_TYPES.PHASE_END && event.phase) current.phases[event.phase] = event.status || STATUSES.SUCCESS;
    if (event.type === EVENT_TYPES.ARTIFACT && event.artifact) current.artifacts.push(event.artifact);
    byRun.set(event.runId, current);
  }
  return Array.from(byRun.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

function readJsonl(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); }
      catch { return undefined; }
    })
    .filter(Boolean);
}

function normalizeWorkflowName(workflow) {
  const value = String(workflow || "workflow").trim();
  if (!value) return "workflow";
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
}

function normalizeEventType(type) {
  const value = String(type || EVENT_TYPES.PHASE_EVENT);
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_");
}

function normalizeStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_") || undefined;
}

function dropUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

function serializeError(error) {
  if (!error) return undefined;
  if (typeof error === "string") return { message: error };
  return {
    name: error.name,
    message: error.message || String(error),
    stack: error.stack,
    code: error.code,
  };
}
