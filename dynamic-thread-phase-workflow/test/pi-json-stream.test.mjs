import assert from "node:assert/strict";
import test from "node:test";
import { PiJsonEventCollector } from "../lib/pi-json-stream.mjs";

function eventLine(event) {
  return `${JSON.stringify(event)}\n`;
}

function finalMessage(text = "done") {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      model: "test-model",
      stopReason: "stop",
      usage: { input: 10, output: 2 },
      content: [{ type: "text", text }],
    },
  };
}

test("collector discards cumulative message updates and retains final metadata", () => {
  const collector = new PiJsonEventCollector();
  for (let index = 1; index <= 100; index++) {
    collector.push(eventLine({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "toolCall", arguments: { content: "x".repeat(index * 1_000) } }] },
      assistantMessageEvent: { type: "toolcall_delta", delta: "x".repeat(1_000) },
    }));
  }
  collector.push(eventLine(finalMessage("complete")));
  const result = collector.finish();

  assert.equal(result.text, "complete");
  assert.equal(result.model, "test-model");
  assert.equal(result.usage.length, 1);
  assert.equal(result.piJson.droppedEvents, 100);
  assert.equal(result.piJson.bufferedBytes, 0);
});

test("collector handles NDJSON records split across arbitrary chunks", () => {
  const collector = new PiJsonEventCollector();
  const stream = eventLine(finalMessage("chunked"));
  for (let index = 0; index < stream.length; index += 3) collector.push(stream.slice(index, index + 3));
  assert.equal(collector.finish().text, "chunked");
});

test("collector bounds and skips an oversized unterminated record", () => {
  const collector = new PiJsonEventCollector({ maxLineBytes: 1_024 });
  collector.push(`{"type":"message_update","payload":"${"x".repeat(5_000)}`);
  collector.push(`"}\n${eventLine(finalMessage("after-oversize"))}`);
  const result = collector.finish();

  assert.equal(result.text, "after-oversize");
  assert.equal(result.piJson.oversizedEvents, 1);
  assert.equal(result.piJson.bufferedBytes, 0);
});

test("collector counts malformed records without failing the run", () => {
  const collector = new PiJsonEventCollector();
  collector.push("not-json\n");
  collector.push(eventLine(finalMessage()));
  const result = collector.finish();
  assert.equal(result.text, "done");
  assert.equal(result.piJson.malformedEvents, 1);
});
