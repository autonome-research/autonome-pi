export const COMMAND_LEDGER_SCHEMA = "thread-phase-command-ledger/v1";

const DEFAULT_MAX_COMMANDS = 64;
const DEFAULT_MAX_HISTORY = 12;
const MAX_ID_CHARS = 256;
const MAX_PREVIEW_BYTES = 4_096;
const COMMAND_TYPES = new Set([
  "tool_call_preparing",
  "tool_call_ready",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  // Historical collector records. `tool_call_completed` meant only that
  // argument generation completed; it never proves execution or success.
  "tool_call_started",
  "tool_call_completed",
  "agent_execution_scope_end",
]);

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function boundedString(value, max = MAX_ID_CHARS) {
  return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

function redactSecrets(text) {
  return String(text ?? "")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[redacted-api-key]")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|API[_-]?KEY|PASSWORD|PASSWD|AUTH|BEARER)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s'\"]+)/gi, "$1=[redacted]")
    .replace(/(--?(?:token|secret|api[-_]?key|password|passwd|auth|bearer)(?:\s+|=))(("[^"]*")|('[^']*')|[^\s]+)/gi, "$1[redacted]");
}

function boundedPreview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = String(value.text ?? "");
  const originalBytes = Number.isSafeInteger(value.bytes) && value.bytes >= 0
    ? value.bytes
    : Buffer.byteLength(raw, "utf8");
  const safe = redactSecrets(raw);
  let text = safe;
  if (Buffer.byteLength(text, "utf8") > MAX_PREVIEW_BYTES) {
    text = text.slice(0, MAX_PREVIEW_BYTES);
    while (Buffer.byteLength(text, "utf8") > MAX_PREVIEW_BYTES) text = text.slice(0, -1);
  }
  return {
    text,
    bytes: originalBytes,
    retainedBytes: Buffer.byteLength(text, "utf8"),
    truncated: Boolean(value.truncated) || Buffer.byteLength(raw, "utf8") > MAX_PREVIEW_BYTES,
    ...(value.omitted ? { omitted: boundedString(String(value.omitted), 64) } : {}),
    ...(value.redacted || safe !== raw ? { redacted: true } : {}),
  };
}

function legacyPreview(text) {
  if (text === undefined) return undefined;
  const raw = String(text);
  const safe = redactSecrets(raw);
  const bytes = Buffer.byteLength(raw, "utf8");
  let bounded = safe;
  if (bytes > MAX_PREVIEW_BYTES) {
    bounded = safe.slice(0, MAX_PREVIEW_BYTES);
    while (Buffer.byteLength(bounded, "utf8") > MAX_PREVIEW_BYTES) bounded = bounded.slice(0, -1);
  }
  return { text: bounded, bytes, retainedBytes: Buffer.byteLength(bounded, "utf8"), truncated: bytes > MAX_PREVIEW_BYTES, ...(safe !== raw ? { redacted: true } : {}) };
}

function eventKind(data) {
  if (data.type === "tool_call_started") return "preparing";
  if (data.type === "tool_call_completed") return "ready";
  if (data.type === "tool_call_preparing") return "preparing";
  if (data.type === "tool_call_ready") return "ready";
  if (data.type === "tool_execution_start") return "execution_start";
  if (data.type === "tool_execution_update") return "execution_update";
  if (data.type === "tool_execution_end") return "execution_end";
  if (data.type === "agent_execution_scope_end") return "scope_end";
  return undefined;
}

export function isCommandLedgerEvent(data) {
  return Boolean(data && typeof data === "object" && COMMAND_TYPES.has(data.type));
}

export function createCommandLedger(options = {}) {
  return {
    schema: COMMAND_LEDGER_SCHEMA,
    rows: [],
    observedEvents: 0,
    duplicateEvents: 0,
    droppedCommands: 0,
    truncated: false,
    _maxCommands: positiveInteger(options.maxCommands, DEFAULT_MAX_COMMANDS),
    _maxHistory: positiveInteger(options.maxHistory, DEFAULT_MAX_HISTORY),
    _byKey: new Map(),
    _seenEventIds: new Set(),
    _seenEventOrder: [],
    _syntheticSequence: 0,
  };
}

function identityFor(ledger, data) {
  const realId = boundedString(data.toolCallId);
  const invocationId = boundedString(data.invocationId);
  const itemId = data.itemId === undefined ? undefined : boundedString(String(data.itemId));
  const source = data.identitySource === "synthetic"
    ? "synthetic"
    : data.type === "tool_call_started" || data.type === "tool_call_completed"
      ? "legacy"
      : realId && invocationId ? "pi" : "synthetic";

  if (source === "synthetic" || !realId) {
    const token = boundedString(data.syntheticId || data.commandEventId)
      || `projection-${++ledger._syntheticSequence}`;
    return {
      key: JSON.stringify(["synthetic", invocationId, itemId, token]),
      source: "synthetic",
      toolCallId: realId,
      invocationId,
      itemId,
    };
  }

  if (source === "legacy") {
    // Historical ids were often fabricated from contentIndex. A new preparing
    // event, or an unpaired ready event, starts another occurrence after an
    // already-ready row so repeated turns cannot collapse forever. Ready may
    // attach only to an exact preparing legacy id; no name/order inference is used.
    const base = JSON.stringify(["legacy", itemId, realId]);
    const existing = ledger._byKey.get(base);
    const kind = eventKind(data);
    if (existing && ((kind === "preparing" && existing.state !== "preparing") || (kind === "ready" && existing.state !== "preparing"))) {
      ledger._byKey.delete(base);
      return { key: `${base}#${++ledger._syntheticSequence}`, lookupKey: base, source, toolCallId: realId, itemId };
    }
    return { key: existing?.key || base, lookupKey: base, source, toolCallId: realId, itemId };
  }

  const attempt = Number.isSafeInteger(data.attempt) && data.attempt > 0 ? data.attempt : undefined;
  const turn = Number.isSafeInteger(data.turn) && data.turn > 0 ? data.turn : undefined;
  const occurrence = Number.isSafeInteger(data.occurrence) && data.occurrence > 0 ? data.occurrence : undefined;
  return {
    key: JSON.stringify(["pi", invocationId, attempt ?? null, itemId, turn ?? null, occurrence ?? null, realId]),
    source,
    toolCallId: realId,
    invocationId,
    attempt,
    itemId,
  };
}

function rememberEvent(ledger, eventId) {
  if (!eventId) return false;
  if (ledger._seenEventIds.has(eventId)) return true;
  ledger._seenEventIds.add(eventId);
  ledger._seenEventOrder.push(eventId);
  const cap = ledger._maxCommands * ledger._maxHistory;
  while (ledger._seenEventOrder.length > cap) {
    ledger._seenEventIds.delete(ledger._seenEventOrder.shift());
  }
  return false;
}

function addHistory(ledger, row, type, state, at) {
  const previous = row.history[row.history.length - 1];
  if (previous?.type === type && previous?.state === state && previous?.at === at) {
    ledger.duplicateEvents++;
    return;
  }
  row.history.push({ type, state, at });
  if (row.history.length > ledger._maxHistory) {
    row.history.shift();
    row.historyDropped++;
    row.truncated = true;
  }
}

function evictIfNeeded(ledger) {
  while (ledger.rows.length >= ledger._maxCommands) {
    let index = ledger.rows.findIndex((row) => ["succeeded", "failed", "finished", "interrupted", "ready"].includes(row.state));
    if (index < 0) index = 0;
    const [removed] = ledger.rows.splice(index, 1);
    const lookupKey = removed._lookupKey || removed.key;
    if (ledger._byKey.get(lookupKey) === removed) ledger._byKey.delete(lookupKey);
    if (ledger._byKey.get(removed.key) === removed) ledger._byKey.delete(removed.key);
    ledger.droppedCommands++;
    ledger.truncated = true;
  }
}

function ensureRow(ledger, identity, data, at) {
  const lookupKey = identity.lookupKey || identity.key;
  let row = ledger._byKey.get(lookupKey) || ledger._byKey.get(identity.key);
  if (row) return row;
  evictIfNeeded(ledger);
  row = {
    key: identity.key,
    identitySource: identity.source,
    toolCallId: identity.toolCallId,
    invocationId: identity.invocationId,
    attempt: identity.attempt,
    itemId: identity.itemId,
    toolName: boundedString(data.toolName),
    contentIndex: Number.isSafeInteger(data.contentIndex) ? data.contentIndex : undefined,
    state: "preparing",
    outcome: "unobserved",
    firstObservedAt: at,
    updatedAt: at,
    executionObserved: false,
    executionStartObserved: false,
    executionEndObserved: false,
    updateCount: 0,
    observedEvents: 0,
    history: [],
    historyDropped: 0,
    truncated: false,
    _lookupKey: lookupKey,
  };
  ledger.rows.push(row);
  ledger._byKey.set(lookupKey, row);
  ledger._byKey.set(identity.key, row);
  return row;
}

function mergeCommon(row, data, at) {
  row.updatedAt = at || row.updatedAt;
  row.toolName ||= boundedString(data.toolName);
  if (row.contentIndex === undefined && Number.isSafeInteger(data.contentIndex)) row.contentIndex = data.contentIndex;
  const args = boundedPreview(data.argsPreview) || legacyPreview(data.args);
  if (args) {
    row.argsPreview = args;
    if (args.truncated || args.omitted) row.truncated = true;
  }
}

function samePreview(a, b) {
  return Boolean(a && b && a.text === b.text && a.bytes === b.bytes && a.truncated === b.truncated && a.omitted === b.omitted);
}

export function applyCommandLedgerEvent(ledger, data, timestamp) {
  if (!ledger || !isCommandLedgerEvent(data)) return false;
  ledger.observedEvents++;
  const commandEventId = boundedString(data.commandEventId, 512);
  if (rememberEvent(ledger, commandEventId)) {
    ledger.duplicateEvents++;
    return true;
  }
  const kind = eventKind(data);
  const at = timestamp || data.at;
  if (kind === "scope_end") {
    const invocationId = boundedString(data.invocationId);
    if (!invocationId) return true;
    for (const row of ledger.rows) {
      if (row.invocationId !== invocationId) continue;
      if (row.executionEndObserved) continue;
      if (row.executionObserved) {
        row.state = "interrupted";
        row.outcome = "interrupted";
        row.endedAt ||= at;
        row.updatedAt = at || row.updatedAt;
        addHistory(ledger, row, data.type, row.state, at);
      }
    }
    return true;
  }

  const identity = identityFor(ledger, data);
  const row = ensureRow(ledger, identity, data, at);
  row.observedEvents++;
  mergeCommon(row, data, at);

  if (kind === "preparing") {
    if (!row.executionObserved && !row.executionEndObserved && row.state !== "ready") row.state = "preparing";
  } else if (kind === "ready") {
    if (!row.executionObserved && !row.executionEndObserved) row.state = "ready";
    row.argumentsReadyAt ||= at;
  } else if (kind === "execution_start") {
    row.executionObserved = true;
    row.executionStartObserved = true;
    if (!row.endedAt || !at || String(at) <= String(row.endedAt)) row.startedAt ||= at;
    if (!row.executionEndObserved) {
      row.state = "executing";
      row.outcome = "running";
    }
  } else if (kind === "execution_update") {
    row.executionObserved = true;
    row.updateCount++;
    if (!row.executionEndObserved) {
      row.state = "executing";
      row.outcome = "running";
      const output = boundedPreview(data.outputPreview);
      if (output && !samePreview(row.outputPreview, output)) row.outputPreview = output;
    }
  } else if (kind === "execution_end") {
    row.executionObserved = true;
    row.executionEndObserved = true;
    row.endedAt ||= at;
    const hasOutcome = typeof data.isError === "boolean";
    const failed = data.isError === true;
    if (hasOutcome) row.isError = failed;
    row.state = hasOutcome ? (failed ? "failed" : "succeeded") : "finished";
    row.outcome = hasOutcome ? (failed ? "failure" : "success") : "unobserved";
    const preview = boundedPreview(data.resultPreview || data.outputPreview);
    if (preview) {
      if (failed) row.errorPreview = preview;
      else row.outputPreview = preview;
      if (preview.truncated || preview.omitted) row.truncated = true;
    }
  }
  addHistory(ledger, row, data.type, row.state, at);
  return true;
}

export function finalizeCommandLedger(ledger, options = {}) {
  if (!ledger) return undefined;
  const terminal = Boolean(options.terminal);
  const at = options.at;
  if (terminal) {
    for (const row of ledger.rows) {
      if (!row.executionEndObserved && row.executionObserved && row.state === "executing") {
        row.state = "interrupted";
        row.outcome = "interrupted";
        row.endedAt ||= at;
        row.updatedAt = at || row.updatedAt;
        addHistory(ledger, row, "scope_terminal", row.state, at);
      }
    }
  }
  const rows = ledger.rows.map((row) => {
    const { _lookupKey, ...publicRow } = row;
    return Object.fromEntries(Object.entries(publicRow).filter(([, value]) => value !== undefined));
  });
  return {
    schema: COMMAND_LEDGER_SCHEMA,
    rows,
    observedEvents: ledger.observedEvents,
    duplicateEvents: ledger.duplicateEvents,
    droppedCommands: ledger.droppedCommands,
    retainedCommands: rows.length,
    truncated: ledger.truncated || rows.some((row) => row.truncated),
  };
}
