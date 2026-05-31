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
  UNKNOWN: "unknown",
});
export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const STORE_DIR = process.env.PI_THREAD_PHASE_STORE_DIR || join(AGENT_DIR, "thread-phase");
export const RUNS_DIR = join(STORE_DIR, "runs");
export const ARTIFACTS_DIR = join(STORE_DIR, "artifacts");
export const INDEX_FILE = join(STORE_DIR, "index.jsonl");

const KNOWN_STATUSES = new Set(Object.values(STATUSES));
const STATUS_ALIASES = new Map([
  ["ok", STATUSES.SUCCESS],
  ["done", STATUSES.SUCCESS],
  ["complete", STATUSES.SUCCESS],
  ["completed", STATUSES.SUCCESS],
  ["pass", STATUSES.SUCCESS],
  ["passed", STATUSES.SUCCESS],
  ["error", STATUSES.FAILED],
  ["fail", STATUSES.FAILED],
  ["failure", STATUSES.FAILED],
  ["aborted", STATUSES.CANCELLED],
  ["abort", STATUSES.CANCELLED],
  ["canceled", STATUSES.CANCELLED],
  ["cancelled", STATUSES.CANCELLED],
  ["pending", STATUSES.RUNNING],
  ["in_progress", STATUSES.RUNNING],
  ["in-progress", STATUSES.RUNNING],
]);

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
    // Preserve workflow-specific statuses as strings in the event log. Projection helpers
    // expose normalizedStatus for UI decisions.
    status: event.status ? normalizeStatusValue(event.status) : undefined,
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

export function projectRun(events = []) {
  const sorted = [...events].filter(Boolean).sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  const first = sorted[0] || {};
  const summary = {
    runId: first.runId,
    workflow: first.workflow,
    cwd: first.cwd,
    trigger: first.trigger,
    startedAt: first.timestamp,
    updatedAt: first.timestamp,
    status: STATUSES.RUNNING,
    normalizedStatus: STATUSES.RUNNING,
    phases: [],
    phaseMap: {},
    artifacts: [],
    errors: [],
    progress: {},
    lastMessage: first.message,
    eventCount: sorted.length,
    events: sorted,
  };

  for (const event of sorted) {
    summary.runId ||= event.runId;
    summary.workflow ||= event.workflow;
    summary.cwd ||= event.cwd;
    summary.trigger ||= event.trigger;
    summary.startedAt ||= event.timestamp;
    summary.updatedAt = event.timestamp || summary.updatedAt;
    summary.lastMessage = event.message || summary.lastMessage;

    if (event.type === EVENT_TYPES.WORKFLOW_START) {
      summary.status = event.status || STATUSES.RUNNING;
      summary.normalizedStatus = normalizeStatus(event.status);
    }
    if (event.type === EVENT_TYPES.WORKFLOW_END) {
      summary.status = event.status || STATUSES.SUCCESS;
      summary.normalizedStatus = normalizeStatus(event.status || STATUSES.SUCCESS);
    }
    if (event.type === EVENT_TYPES.ERROR || event.error) {
      summary.errors.push({
        timestamp: event.timestamp,
        phase: event.phase,
        message: event.message || event.error?.message,
        error: event.error,
      });
    }
    if (event.type === EVENT_TYPES.PHASE_START && event.phase) {
      upsertPhase(summary, event.phase, {
        phase: event.phase,
        status: event.status || STATUSES.RUNNING,
        normalizedStatus: normalizeStatus(event.status || STATUSES.RUNNING),
        startedAt: event.timestamp,
        updatedAt: event.timestamp,
        eventCount: 0,
        lastMessage: event.message,
      });
    }
    if (event.type === EVENT_TYPES.PHASE_EVENT && event.phase) {
      const phase = upsertPhase(summary, event.phase, {
        phase: event.phase,
        status: STATUSES.RUNNING,
        normalizedStatus: STATUSES.RUNNING,
        startedAt: event.timestamp,
      });
      phase.updatedAt = event.timestamp || phase.updatedAt;
      phase.lastMessage = event.message || phase.lastMessage;
      phase.eventCount = (phase.eventCount || 0) + 1;
      const progress = extractProgress(event.data);
      if (progress) {
        summary.progress[event.phase] = progress;
        phase.progress = progress;
      }
      applyFanoutEvent(phase, event.data, event);
    }
    if (event.type === EVENT_TYPES.PHASE_END && event.phase) {
      const phase = upsertPhase(summary, event.phase, { phase: event.phase });
      phase.status = event.status || STATUSES.SUCCESS;
      phase.normalizedStatus = normalizeStatus(event.status || STATUSES.SUCCESS);
      phase.endedAt = event.timestamp;
      phase.updatedAt = event.timestamp || phase.updatedAt;
      phase.lastMessage = event.message || phase.lastMessage;
      if (!phase.startedAt) phase.startedAt = event.timestamp;
    }
    if (event.type === EVENT_TYPES.ARTIFACT && event.artifact) {
      summary.artifacts.push({ ...event.artifact, eventId: event.eventId, timestamp: event.timestamp });
    }
  }

  for (const phase of Object.values(summary.phaseMap)) finalizeFanout(phase);
  summary.phases = Object.values(summary.phaseMap).sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
  delete summary.phaseMap;
  if (summary.normalizedStatus !== STATUSES.FAILED && summary.errors.length > 0 && !sorted.some((e) => e.type === EVENT_TYPES.WORKFLOW_END)) {
    summary.status = STATUSES.FAILED;
    summary.normalizedStatus = STATUSES.FAILED;
  }
  return summary;
}

export function projectRuns(events = []) {
  const byRun = new Map();
  for (const event of events) {
    if (!event?.runId) continue;
    const bucket = byRun.get(event.runId) || [];
    bucket.push(event);
    byRun.set(event.runId, bucket);
  }
  return Array.from(byRun.values())
    .map((runEvents) => projectRun(runEvents))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

export function getRunSummary(runId) {
  return projectRun(readRun(runId));
}

export function latestRunSummaries({ limit = 20, cwd, workflow, readLimit = 5000 } = {}) {
  return projectRuns(readIndex({ limit: readLimit, cwd, workflow })).slice(0, limit);
}

// Backward-compatible alias for the original projected run helper.
export function latestRuns(options = {}) {
  return latestRunSummaries(options);
}

export function readArtifactContent(artifact, { maxBytes = 500_000 } = {}) {
  if (!artifact) return undefined;
  if (typeof artifact.content === "string") return compactText(artifact.content, maxBytes);
  if (!artifact.path) return undefined;
  const content = readFileSync(artifact.path, "utf8");
  return compactText(content, maxBytes);
}

export function normalizeStatus(status) {
  const value = normalizeStatusValue(status);
  if (!value) return STATUSES.UNKNOWN;
  if (KNOWN_STATUSES.has(value)) return value;
  return STATUS_ALIASES.get(value) || STATUSES.UNKNOWN;
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

function normalizeStatusValue(status) {
  const value = String(status || "").trim().toLowerCase();
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_") || undefined;
}

function upsertPhase(summary, phaseName, patch) {
  const existing = summary.phaseMap[phaseName] || { phase: phaseName, eventCount: 0 };
  Object.assign(existing, patch);
  summary.phaseMap[phaseName] = existing;
  return existing;
}

function extractProgress(data) {
  if (!data || typeof data !== "object") return undefined;
  const kind = data.kind || data.type;
  if (kind !== "progress") return undefined;
  const current = data.current ?? data.completed ?? data.done;
  const total = data.total;
  const percent = typeof data.percent === "number"
    ? data.percent
    : typeof current === "number" && typeof total === "number" && total > 0
      ? current / total
      : undefined;
  return dropUndefined({ current, total, percent, message: data.message });
}

function applyFanoutEvent(phase, data, event) {
  if (!data || typeof data !== "object") return;
  const kind = data.kind || data.type;
  if (!String(kind || "").startsWith("fanout")) return;

  phase.fanout ||= { total: undefined, completed: 0, failed: 0, running: 0, items: [] };
  phase._fanoutItemMap ||= {};

  if (kind === "fanout_start") {
    if (typeof data.total === "number") phase.fanout.total = data.total;
    phase.fanout.label = data.label || phase.fanout.label;
    return;
  }

  const itemId = String(data.itemId ?? data.id ?? data.label ?? data.index ?? "item");
  const item = phase._fanoutItemMap[itemId] || {
    itemId,
    label: data.label || itemId,
    index: data.index,
    startedAt: event.timestamp,
    status: STATUSES.RUNNING,
    normalizedStatus: STATUSES.RUNNING,
    lastMessage: data.message,
  };
  item.label = data.label || item.label;
  item.index = data.index ?? item.index;
  item.updatedAt = event.timestamp;
  item.lastMessage = data.message || item.lastMessage;

  if (kind === "fanout_item_start") {
    item.startedAt ||= event.timestamp;
    item.status = data.status || STATUSES.RUNNING;
    item.normalizedStatus = normalizeStatus(item.status);
  } else if (kind === "fanout_item_end") {
    item.endedAt = event.timestamp;
    item.status = data.status || STATUSES.SUCCESS;
    item.normalizedStatus = normalizeStatus(item.status);
    item.error = data.error;
  }
  phase._fanoutItemMap[itemId] = item;
}

function finalizeFanout(phase) {
  if (!phase.fanout) return;
  const items = Object.values(phase._fanoutItemMap || {}).sort((a, b) => {
    if (typeof a.index === "number" && typeof b.index === "number") return a.index - b.index;
    return String(a.startedAt || "").localeCompare(String(b.startedAt || ""));
  });
  const completed = items.filter((item) => item.normalizedStatus === STATUSES.SUCCESS || item.normalizedStatus === STATUSES.SKIPPED).length;
  const failed = items.filter((item) => item.normalizedStatus === STATUSES.FAILED).length;
  const running = items.filter((item) => item.normalizedStatus === STATUSES.RUNNING).length;
  phase.fanout.items = items;
  phase.fanout.completed = completed;
  phase.fanout.failed = failed;
  phase.fanout.running = running;
  phase.fanout.total ||= items.length;
  delete phase._fanoutItemMap;
}

function compactText(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { content: text, truncated: false };
  let out = text.slice(0, maxBytes);
  while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
  return { content: out, truncated: true, bytes: Buffer.byteLength(text, "utf8") };
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
