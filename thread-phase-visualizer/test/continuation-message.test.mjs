import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTINUATION_MARKER_SCHEMA,
  continuationDeliveryMarker,
  formatMarkedContinuation,
  sessionHistoryHasContinuation,
} from "../lib/continuation-message.mjs";

test("continuation marker is machine-readable and matches only its stable delivery id", () => {
  const deliveryId = "delivery-123";
  const marker = continuationDeliveryMarker(deliveryId);
  assert.ok(marker.startsWith(`[${CONTINUATION_MARKER_SCHEMA}] `));
  assert.deepEqual(JSON.parse(marker.slice(marker.indexOf("{") )), { deliveryId });

  const entries = [{ type: "message", message: { role: "user", content: formatMarkedContinuation("continue", deliveryId) } }];
  assert.equal(sessionHistoryHasContinuation(entries, deliveryId), true);
  assert.equal(sessionHistoryHasContinuation(entries, "delivery-12"), false);
});

test("history reconciliation accepts documented user text blocks and custom-message details", () => {
  assert.equal(sessionHistoryHasContinuation([{
    type: "message",
    message: { role: "user", content: [{ type: "text", text: formatMarkedContinuation("continue", "array-id") }] },
  }], "array-id"), true);
  assert.equal(sessionHistoryHasContinuation([{
    type: "custom_message",
    customType: "thread-phase-continuation",
    content: "continuation",
    details: { deliveryId: "details-id" },
  }], "details-id"), true);
});
