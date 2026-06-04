import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
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
export const CANCEL_DIR = join(STORE_DIR, "cancel");
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
  mkdirSync(CANCEL_DIR, { recursive: true });
  const fd = openSync(INDEX_FILE, "a");
  closeSync(fd);
}

export function createRunId(workflow = "workflow") {
  const safeWorkflow = normalizeWorkflowName(workflow);
  return `${safeWorkflow}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export function runFileFor(runId) {
  return join(RUNS_DIR, `${safeRunId(runId)}.jsonl`);
}

export function cancelFileFor(runId) {
  return join(CANCEL_DIR, `${safeRunId(runId)}.json`);
}

export function requestCancellation(runId, options = {}) {
  ensureStore();
  const request = {
    runId: safeRunId(runId),
    requestedAt: new Date().toISOString(),
    reason: options.reason || "cancelled from thread-phase monitor",
    source: options.source || "thread-phase-visualizer",
  };
  writeFileSync(cancelFileFor(runId), JSON.stringify(request, null, 2), "utf8");
  return request;
}

export function readCancellation(runId) {
  const file = cancelFileFor(runId);
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return { runId: safeRunId(runId), reason: "cancel requested" }; }
}

export function safeRunId(runId) {
  const value = String(runId || "").trim();
  if (!/^[a-zA-Z0-9_.:-]+$/.test(value)) throw new Error(`Invalid thread-phase runId: ${value || "(empty)"}`);
  return value;
}

function stringifyValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? nested.toString() : nested);
  } catch (error) {
    return JSON.stringify({ unserializable: true, message: error?.message || String(error), preview: String(value) });
  }
}

function compactValue(value, maxBytes = 200_000) {
  if (value === undefined) return undefined;
  const text = stringifyValue(value);
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
    runId: safeRunId(options.runId || createRunId(workflow)),
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
    metadata: options.metadata,
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
        const cancelled = error?.name === "AbortError" || /aborted|cancelled/i.test(String(error?.message || error));
        phaseEnd(run, phaseName, cancelled ? STATUSES.CANCELLED : STATUSES.FAILED, { error: serializeError(error) });
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
    metadata: first.metadata,
    startedAt: first.timestamp,
    updatedAt: first.timestamp,
    status: STATUSES.RUNNING,
    normalizedStatus: STATUSES.RUNNING,
    phases: [],
    phaseMap: {},
    artifacts: [],
    errors: [],
    progress: {},
    usage: emptyUsageSummary(),
    heartbeat: undefined,
    stale: undefined,
    lastMessage: first.message,
    eventCount: sorted.length,
    events: sorted,
  };

  for (const event of sorted) {
    summary.runId ||= event.runId;
    summary.workflow ||= event.workflow;
    summary.cwd ||= event.cwd;
    summary.trigger ||= event.trigger;
    summary.metadata ||= event.metadata;
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
      const heartbeat = extractHeartbeat(event.data, event);
      if (heartbeat) {
        summary.heartbeat = heartbeat;
        phase.heartbeat = heartbeat;
        phase.lastMessage = heartbeat.message || phase.lastMessage;
      }
      applyFanoutEvent(phase, event.data, event);
      applyUsageEvent(summary, phase, event.data, event);
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
  if (summary.normalizedStatus === STATUSES.RUNNING) summary.stale = detectStaleRun(summary);
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

export function formatUsageSummary(usage) {
  if (!usage || typeof usage !== "object" || !usage.entries) return "";
  const parts = [];
  if (typeof usage.inputTokens === "number" && usage.inputTokens > 0) parts.push(`${formatNumber(usage.inputTokens)} in`);
  if (typeof usage.outputTokens === "number" && usage.outputTokens > 0) parts.push(`${formatNumber(usage.outputTokens)} out`);
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0 && parts.length === 0) parts.push(`${formatNumber(usage.totalTokens)} tok`);
  if (typeof usage.reasoningTokens === "number" && usage.reasoningTokens > 0) parts.push(`${formatNumber(usage.reasoningTokens)} reasoning`);
  if (typeof usage.cachedInputTokens === "number" && usage.cachedInputTokens > 0) parts.push(`${formatNumber(usage.cachedInputTokens)} cached`);
  const models = usage.models && typeof usage.models === "object" ? Object.keys(usage.models).filter(Boolean) : [];
  const modelPart = models.length === 1 ? ` · ${models[0]}` : models.length > 1 ? ` · ${models.length} models` : "";
  return parts.length ? `${parts.join(" / ")}${modelPart}` : `${usage.entries} usage event${usage.entries === 1 ? "" : "s"}${modelPart}`;
}

export function readArtifactContent(artifact, { maxBytes = 500_000 } = {}) {
  if (!artifact) return undefined;
  if (typeof artifact.content === "string") return compactText(artifact.content, maxBytes);
  if (!artifact.path) return undefined;
  const fd = openSync(artifact.path, "r");
  try {
    const size = fstatSync(fd).size;
    const bytesToRead = Math.min(size, maxBytes + 1);
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0);
    const content = buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8");
    return { content, truncated: size > maxBytes || bytesRead > maxBytes, bytes: size };
  } finally {
    closeSync(fd);
  }
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

function extractHeartbeat(data, event) {
  if (!data || typeof data !== "object") return undefined;
  const kind = data.kind || data.type;
  if (kind !== "heartbeat") return undefined;
  return dropUndefined({
    timestamp: event.timestamp,
    pid: data.pid,
    childPids: Array.isArray(data.childPids) ? data.childPids : undefined,
    phase: event.phase,
    message: data.message,
    milestoneId: data.milestoneId,
    featureId: data.featureId,
    validator: data.validator,
    branch: data.branch,
    worktree: data.worktree,
  });
}

function detectStaleRun(summary) {
  const pid = summary.metadata?.pid;
  if (typeof pid === "number" && !isPidAlive(pid)) return { reason: "pid_not_running", pid, checkedAt: new Date().toISOString() };
  if (summary.heartbeat?.timestamp) {
    const ageMs = Date.now() - Date.parse(summary.heartbeat.timestamp);
    if (Number.isFinite(ageMs) && ageMs > 5 * 60 * 1000) return { reason: "heartbeat_stale", ageMs, checkedAt: new Date().toISOString() };
  }
  return undefined;
}

function isPidAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function emptyUsageSummary() {
  return {
    entries: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    fields: {},
    models: {},
  };
}

function applyUsageEvent(summary, phase, data, event) {
  const entries = extractUsageEntries(data);
  if (!entries.length) return;
  phase.usage ||= emptyUsageSummary();
  for (const entry of entries) {
    const model = entry.model || data.model || event.data?.model;
    addUsage(summary.usage, entry.usage, model);
    addUsage(phase.usage, entry.usage, model);
    if (data.item !== undefined || data.itemId !== undefined || data.index !== undefined) {
      applyFanoutUsage(phase, data, entry.usage, model);
    }
  }
}

function extractUsageEntries(data) {
  if (!data || typeof data !== "object") return [];
  const kind = data.kind || data.type;
  if (kind !== "usage" && data.usage === undefined) return [];
  const raw = data.usage ?? data;
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .map((value) => value?.message?.usage ? { usage: value.message.usage, model: value.message.model || value.model } : { usage: value, model: value?.model })
    .filter((entry) => entry.usage && typeof entry.usage === "object");
}

function addUsage(target, usage, model) {
  target.entries += 1;
  const input = numberFrom(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens);
  const output = numberFrom(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens);
  const total = numberFrom(usage.total_tokens, usage.totalTokens) ?? ((input || 0) + (output || 0) || undefined);
  const cached = numberFrom(usage.cache_read_input_tokens, usage.cached_input_tokens, usage.cachedInputTokens, usage.input_token_details?.cached_tokens, usage.prompt_tokens_details?.cached_tokens);
  const cacheCreation = numberFrom(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens);
  const reasoning = numberFrom(usage.output_token_details?.reasoning_tokens, usage.completion_tokens_details?.reasoning_tokens, usage.reasoning_tokens, usage.reasoningTokens);
  if (input) target.inputTokens += input;
  if (output) target.outputTokens += output;
  if (total) target.totalTokens += total;
  if (cached) target.cachedInputTokens += cached;
  if (cacheCreation) target.cacheCreationInputTokens += cacheCreation;
  if (reasoning) target.reasoningTokens += reasoning;
  addNumericFields(target.fields, usage);
  if (model) {
    const key = String(model);
    target.models[key] ||= emptyUsageSummary();
    addUsage(target.models[key], { ...usage, model: undefined }, undefined);
  }
}

function applyFanoutUsage(phase, data, usage, model) {
  const itemId = String(data.itemId ?? data.item ?? data.label ?? data.index ?? "item");
  const item = phase._fanoutItemMap?.[itemId];
  if (!item) return;
  item.usage ||= emptyUsageSummary();
  addUsage(item.usage, usage, model);
}

function addNumericFields(fields, value, prefix = "") {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "model") continue;
    const name = normalizeFieldName(prefix ? `${prefix}.${key}` : key);
    if (typeof nested === "number" && Number.isFinite(nested)) fields[name] = (fields[name] || 0) + nested;
    else if (nested && typeof nested === "object" && !Array.isArray(nested)) addNumericFields(fields, nested, name);
  }
}

function numberFrom(...values) {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function normalizeFieldName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.:-]+/g, "_");
}

function formatNumber(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
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
