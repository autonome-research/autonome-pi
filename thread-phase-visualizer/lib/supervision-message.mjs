export const PROGRESS_REVIEW_MARKER_SCHEMA = "thread-phase-progress-review/v1";
const MAX_PROMPT_BYTES = 12_000;
const MAX_BATCH = 8;
// Match the store's safe run-ID alphabet and supervision record's 512-byte
// bound, not the public input-name limit: generated IDs include a suffix.
const RUN_ID = /^[a-zA-Z0-9_.:-]{1,512}$/;
const CHECK_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;

export function progressReviewMarker(checks) {
  const normalized = (checks || []).map((check) => ({ runId: check?.runId, checkId: check?.checkId }));
  if (!normalized.length || normalized.length > MAX_BATCH || normalized.some((check) => !nonEmpty(check.runId) || !RUN_ID.test(check.runId) || !nonEmpty(check.checkId) || !CHECK_ID.test(check.checkId))) {
    throw new Error(`progress review marker requires 1-${MAX_BATCH} valid checks`);
  }
  return `[${PROGRESS_REVIEW_MARKER_SCHEMA}] ${JSON.stringify({ checks: normalized })}`;
}

export function formatProgressReviewPrompt(items, now = Date.now()) {
  const bounded = (items || []).slice(0, MAX_BATCH);
  if (!bounded.length) throw new Error("at least one progress review item is required");
  const checks = bounded.map(({ run, checkId }) => ({ runId: run.runId, checkId }));
  const lines = [
    "Periodic workflow progress review, not completion; the timer did not detect a stall.",
    "Activity, heartbeat, and tool-call fields below are evidence only, not proof of progress or a stuck workflow.",
    "",
  ];
  for (const { run } of bounded) {
    const active = (run.phases || []).filter((phase) => !phase.endedAt).slice(-3);
    const phaseText = active.length
      ? active.map((phase) => `${singleLine(phase.phase, 160)}${phase.lastMessage ? ` — ${singleLine(phase.lastMessage, 240)}` : ""}`).join(", ")
      : "no active phase reported";
    const artifacts = (run.artifacts || []).slice(-3).map((artifact) => artifact.path || artifact.url).filter(Boolean);
    lines.push(
      `Workflow: ${singleLine(run.workflow || "workflow", 160)} (${run.runId})`,
      `Elapsed: ${elapsed(run.startedAt, now)}; current phase: ${phaseText}`,
      `Event log: ${singleLine(run.runFile || "thread-phase run log (use thread_phase_runs)", 500)}`,
      artifacts.length ? `Artifacts: ${artifacts.map((value) => singleLine(value, 300)).join(", ")}` : "Artifacts: none reported; inspect the event log",
      run.stale ? `Diagnostic evidence: ${singleLine(run.stale.reason || "owner may be stale", 200)} (do not recover automatically)` : undefined,
      "",
    );
  }
  // Reserve the complete control suffix before truncating display evidence.
  // Losing this marker would prevent acknowledgement and cause repeat reviews.
  const suffix = [
    "",
    "Inspect the current logs and artifacts with existing tools, then use human/model judgment to decide whether to wait, report, or intervene.",
    "Do not automatically kill, retry, resume, launch successor work, or treat this review as workflow completion.",
    "",
    progressReviewMarker(checks),
  ].join("\n");
  return truncateUtf8(lines.filter((line) => line !== undefined).join("\n"), MAX_PROMPT_BYTES - Buffer.byteLength(suffix, "utf8")) + suffix;
}

/** Only an exact marker on the supplied active branch acknowledges a check. */
export function sessionHistoryHasProgressReview(entries, checkId) {
  if (!nonEmpty(checkId)) return false;
  for (const entry of entries || []) {
    let content;
    if (entry?.type === "message" && entry.message?.role === "user") content = entry.message.content;
    else if (entry?.type === "custom_message") content = entry.content;
    else continue;
    for (const text of contentTexts(content)) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith(`[${PROGRESS_REVIEW_MARKER_SCHEMA}] `)) continue;
        try {
          const marker = JSON.parse(line.slice(PROGRESS_REVIEW_MARKER_SCHEMA.length + 3));
          if (marker?.checks?.some((check) => check?.checkId === checkId)) return true;
        } catch { /* malformed text is not acknowledgement */ }
      }
    }
  }
  return false;
}

function contentTexts(content) {
  if (typeof content === "string") return [content];
  return Array.isArray(content) ? content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text) : [];
}
function elapsed(start, now) {
  const startMs = Date.parse(String(start || ""));
  if (!Number.isFinite(startMs) || now < startMs) return "unknown";
  const minutes = Math.floor((now - startMs) / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
function singleLine(value, max) { return String(value || "").replace(/\s+/g, " ").slice(0, max); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = text.slice(0, maxBytes - 80);
  while (Buffer.byteLength(out, "utf8") > maxBytes - 80) out = out.slice(0, -1);
  return `${out}\n[progress review details truncated]`;
}
