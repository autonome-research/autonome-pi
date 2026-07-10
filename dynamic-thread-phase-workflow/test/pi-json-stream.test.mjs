import assert from "node:assert/strict";
import test from "node:test";
import { PiJsonEventCollector } from "../lib/pi-json-stream.mjs";
import { runBoundedProcess } from "../lib/subprocess.mjs";

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

test("collector aggregates arbitrarily many usage events into one bounded record", () => {
  const collector = new PiJsonEventCollector();
  const line = eventLine(finalMessage("usage"));
  for (let index = 0; index < 20_000; index++) collector.push(line);
  const result = collector.finish();
  assert.equal(result.usage.length, 1);
  assert.equal(result.usage[0].input, 200_000);
  assert.equal(result.usage[0].output, 40_000);
  assert.equal(result.piJson.usageEvents, 20_000);
  assert.ok(JSON.stringify(result.usage).length < 1_000);
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

test("collector rejects a giant unterminated chunk before appending it", () => {
  const collector = new PiJsonEventCollector({ maxLineBytes: 1_024 });
  collector.push(`{"type":"message_update","payload":"${"x".repeat(1_000_000)}`);
  const interim = collector.result();
  assert.equal(interim.piJson.bufferedBytes, 0);
  assert.equal(interim.piJson.oversizedEvents, 1);
});

test("collector rejects a complete oversized line before concatenation and recovers in the same chunk", () => {
  const collector = new PiJsonEventCollector({ maxLineBytes: 1_024 });
  collector.push(`${JSON.stringify({ type: "message_update", payload: "x".repeat(5_000) })}\n${eventLine(finalMessage("same-chunk-recovery"))}`);
  const result = collector.finish();
  assert.equal(result.text, "same-chunk-recovery");
  assert.equal(result.piJson.oversizedEvents, 1);
});

test("collector counts malformed records without failing the run", () => {
  const collector = new PiJsonEventCollector();
  collector.push("not-json\n");
  collector.push(eventLine(finalMessage()));
  const result = collector.finish();
  assert.equal(result.text, "done");
  assert.equal(result.piJson.malformedEvents, 1);
});

test("escaped type-like text in an earlier field is not treated as the discriminator", () => {
  const collector = new PiJsonEventCollector();
  const event = { note: 'quoted text: "type":"message_update"', ...finalMessage("not-confused") };
  collector.push(eventLine(event));
  assert.equal(collector.finish().text, "not-confused");
});

test("large reordered message_end records are recognized without first-field type", () => {
  const collector = new PiJsonEventCollector();
  const event = { note: "x".repeat(100_000), ...finalMessage("large-reordered") };
  collector.push(eventLine(event));
  const result = collector.finish();
  assert.equal(result.text, "large-reordered");
  assert.equal(result.piJson.malformedEvents, 0);
});

test("collector joins multiple text parts and keeps the latest assistant message", () => {
  const collector = new PiJsonEventCollector();
  collector.push(eventLine(finalMessage("first")));
  collector.push(eventLine({
    ...finalMessage(),
    message: { ...finalMessage().message, content: [{ type: "text", text: "second " }, { type: "text", text: "message" }] },
  }));
  assert.equal(collector.finish().text, "second message");
});

test("collector validates its maximum NDJSON record size", () => {
  assert.throws(() => new PiJsonEventCollector({ maxLineBytes: 0 }), /positive safe integer/);
  assert.throws(() => new PiJsonEventCollector({ maxLineBytes: 1.5 }), /positive safe integer/);
});

test("Pi NDJSON preserves raw Unicode split across byte chunks", async () => {
  const collector = new PiJsonEventCollector();
  const line = eventLine(finalMessage("café 😀"));
  const emojiStart = Buffer.from(line).indexOf(Buffer.from("😀"));
  const script = [
    `const value=Buffer.from(${JSON.stringify(line)});`,
    `process.stdout.write(value.subarray(0,${emojiStart + 2}));`,
    `setTimeout(()=>process.stdout.end(value.subarray(${emojiStart + 2})),10);`,
  ].join("");
  const processResult = await runBoundedProcess(process.execPath, ["-e", script], {
    timeoutMs: 5_000,
    captureStdout: false,
    onStdout: (chunk) => collector.push(chunk),
  });

  assert.equal(processResult.ok, true);
  assert.equal(collector.finish().text, "café 😀");
});
