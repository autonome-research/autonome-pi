export const CONTINUATION_MARKER_SCHEMA = "thread-phase-continuation/v1";

/** Stable, machine-readable line included in every queued continuation user message. */
export function continuationDeliveryMarker(deliveryId) {
  if (typeof deliveryId !== "string" || !deliveryId.trim()) throw new Error("continuation delivery id is required");
  return `[${CONTINUATION_MARKER_SCHEMA}] ${JSON.stringify({ deliveryId })}`;
}

export function formatMarkedContinuation(prompt, deliveryId) {
  return `${prompt}\n\n${continuationDeliveryMarker(deliveryId)}`;
}

/** Inspect documented SessionManager entries for proof that Pi already accepted this delivery. */
export function sessionHistoryHasContinuation(entries, deliveryId) {
  const marker = continuationDeliveryMarker(deliveryId);
  for (const entry of entries || []) {
    if (entry?.type === "message" && entry.message?.role === "user" && contentContains(entry.message.content, marker)) return true;
    if (entry?.type === "custom_message") {
      if (entry.details?.deliveryId === deliveryId || contentContains(entry.content, marker)) return true;
    }
  }
  return false;
}

function contentContains(content, marker) {
  if (typeof content === "string") return content.includes(marker);
  return Array.isArray(content) && content.some((block) => block?.type === "text" && typeof block.text === "string" && block.text.includes(marker));
}
