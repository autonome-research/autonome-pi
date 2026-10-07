export const CONTINUATION_MARKER_SCHEMA = "thread-phase-continuation/v1";

/** Stable, machine-readable line included in every queued continuation user message. */
export function continuationDeliveryMarker(deliveryId, identity = {}) {
  if (typeof deliveryId !== "string" || !deliveryId.trim()) throw new Error("continuation delivery id is required");
  return `[${CONTINUATION_MARKER_SCHEMA}] ${JSON.stringify({ deliveryId, ...identity })}`;
}

export function formatMarkedContinuation(prompt, deliveryId, identity = {}) {
  return `${prompt}\n\n${continuationDeliveryMarker(deliveryId, identity)}`;
}

/** Delivery receipts are session-wide, not branch-sensitive conversation state. */
export function sessionHistoryHasContinuation(entries, deliveryId) {
  for (const entry of entries || []) {
    if (entry?.type === "custom_message" && entry.details?.deliveryId === deliveryId) return true;
    if (markedMessages(entry).some(({ marker }) => marker.deliveryId === deliveryId)) return true;
  }
  return false;
}

/** Also recognizes pre-v4 random-ID receipts after their store record was pruned. */
export function sessionHistoryHasRunContinuation(entries, runId, sessionId) {
  for (const entry of entries || []) {
    for (const { marker, text } of markedMessages(entry)) {
      if (marker.runId === runId && marker.sessionId === sessionId) return true;
      if (marker.runId === undefined && text.split("\n").includes(`Run: ${runId}`)) return true;
    }
  }
  return false;
}

function markedMessages(entry) {
  const content = entry?.type === "message" && entry.message?.role === "user" ? entry.message.content
    : entry?.type === "custom_message" ? entry.content : undefined;
  const texts = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text) : [];
  const result = [];
  for (const text of texts) {
    if (typeof text !== "string") continue;
    for (const line of text.split("\n")) {
      const prefix = `[${CONTINUATION_MARKER_SCHEMA}] `;
      if (!line.startsWith(prefix)) continue;
      try {
        const marker = JSON.parse(line.slice(prefix.length));
        if (typeof marker?.deliveryId === "string" && marker.deliveryId) result.push({ marker, text });
      } catch { /* malformed text is not an acknowledgement */ }
    }
  }
  return result;
}
