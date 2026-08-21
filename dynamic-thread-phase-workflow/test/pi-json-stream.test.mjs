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

test("collector excludes cumulative tool-call argument deltas without materializing the cumulative message", () => {
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

  // The cumulative `message` payload is never retained; only the tiny nested
  // discriminator is inspected. toolcall argument deltas are excluded (never
  // accumulated -> no quadratic growth), not counted as dropped records.
  assert.equal(result.text, "complete");
  assert.equal(result.model, "test-model");
  assert.equal(result.usage.length, 1);
  assert.equal(result.piJson.droppedEvents, 0);
  assert.equal(result.piJson.traceExcluded, 100);
  assert.equal(result.piJson.bufferedBytes, 0);
  assert.equal(result.trace.window.length, 0);
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

test("collector streams each per-turn usage to onUsage before finishing", () => {
  const seen = [];
  const collector = new PiJsonEventCollector({ onUsage: (entry) => seen.push(entry) });
  // Two assistant turns, each with its own per-turn usage delta.
  collector.push(eventLine({
    type: "message_end",
    message: { role: "assistant", model: "m1", usage: { input: 5, output: 1 }, content: [{ type: "text", text: "a" }] },
  }));
  collector.push(eventLine({
    type: "message_end",
    message: { role: "assistant", model: "m2", usage: { input: 7, output: 3 }, content: [{ type: "text", text: "b" }] },
  }));
  const result = collector.finish();

  // Live callback received both per-turn deltas as they streamed in.
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].usage, { input: 5, output: 1 });
  assert.equal(seen[0].model, "m1");
  assert.deepEqual(seen[1].usage, { input: 7, output: 3 });
  assert.equal(seen[1].model, "m2");
  // The aggregate result still sums both turns for downstream metadata.
  assert.equal(result.usage.length, 1);
  assert.equal(result.usage[0].input, 12);
  assert.equal(result.usage[0].output, 4);
});

test("collector omits onUsage callback when none is supplied", () => {
  // Should not throw; onUsage stays undefined and streaming is a no-op.
  const collector = new PiJsonEventCollector();
  collector.push(eventLine(finalMessage("plain")));
  collector.finish();
  assert.equal(collector.onUsage, undefined);
});

test("collector captures bounded reasoning deltas into the trace window", () => {
  const collector = new PiJsonEventCollector();
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Let me " },
  }));
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reason about this." },
  }));
  collector.push(eventLine(finalMessage("done")));
  const result = collector.finish();

  const window = result.trace.window;
  assert.equal(window.length, 1);
  assert.equal(window[0].type, "content_delta");
  assert.equal(window[0].contentType, "thinking");
  assert.equal(window[0].delta, "Let me reason about this.");
  assert.equal(result.trace.reasoning, "Let me reason about this.");
  assert.equal(result.piJson.reasoningDeltas, 2);
});

test("collector streams reasoning content_delta records live via onTrace", () => {
  const traces = [];
  // Snapshot each record at delivery time so the test asserts the live payload
  // rather than depending on window-coalescing aliasing of the same object.
  const collector = new PiJsonEventCollector({ onTrace: (evt) => traces.push({ ...evt }) });
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "Live " },
  }));
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "reasoning. " },
  }));
  collector.push(eventLine(finalMessage("done")));
  const result = collector.finish();

  // onTrace delivers each individual reasoning delta as it streams in, in the
  // AgentStreamEvent content_delta shape, even though the retained window
  // coalesces them into a single record.
  assert.equal(traces.length, 2);
  assert.ok(traces.every((t) => t.type === "content_delta"));
  assert.equal(traces[0].contentType, "thinking");
  assert.equal(traces[0].contentIndex, 2);
  assert.equal(traces[0].delta, "Live ");
  assert.equal(traces[1].delta, "reasoning. ");
  // The retained window coalesces the same stream into one content_delta.
  assert.equal(result.trace.window.length, 1);
  assert.equal(result.trace.window[0].delta, "Live reasoning. ");
});

test("collector throttles an unbounded number of tiny reasoning deltas", () => {
  const collector = new PiJsonEventCollector({ maxReasoningChars: 128, maxTraceWindow: 8 });
  for (let index = 0; index < 50_000; index++) {
    collector.push(eventLine({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "ab" },
    }));
  }
  collector.push(eventLine(finalMessage()));
  const result = collector.finish();

  // Reasoning is capped and the window stays tiny regardless of delta count.
  assert.ok(Buffer.byteLength(result.trace.reasoning, "utf8") <= 128);
  assert.ok(result.trace.window.length <= 8);
  assert.equal(result.piJson.reasoningDeltas, 50_000);
});

test("collector captures tool-call start and completed records", () => {
  const traces = [];
  const collector = new PiJsonEventCollector({ onTrace: (evt) => traces.push(evt) });
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
  }));
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{\"path\":\"a" },
  }));
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { id: "tc-1", name: "read", arguments: { path: "a/b/c" } } },
  }));
  const result = collector.finish();

  const window = result.trace.window;
  assert.equal(window[0].type, "tool_call_started");
  assert.equal(window[0].toolCallId, "tc-1");
  assert.equal(window[1].type, "tool_call_completed");
  assert.equal(window[1].toolName, "read");
  assert.match(window[1].args, /a\/b\/c/);
  assert.equal(result.piJson.toolCallStarted, 1);
  assert.equal(result.piJson.toolCallCompleted, 1);
  assert.equal(result.piJson.traceExcluded, 1); // the argument delta was excluded
  // Live onTrace received the start and completed records but not the excluded delta.
  assert.deepEqual(traces.map((t) => t.type), ["tool_call_started", "tool_call_completed"]);
});

test("collector redacts secrets from captured reasoning text", () => {
  const collector = new PiJsonEventCollector();
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "key sk-abcdefghijklmnopqrstuvwxyz appears" },
  }));
  const result = collector.finish();
  assert.equal(result.trace.reasoning, "key [redacted-api-key] appears");
});

test("collector keeps onTrace optional and never breaks on a throwing observer", () => {
  const collector = new PiJsonEventCollector({ onTrace: () => { throw new Error("observer boom"); } });
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hi" },
  }));
  collector.push(eventLine(finalMessage()));
  const result = collector.finish();
  assert.equal(result.text, "done");
  assert.equal(result.trace.window.length, 1);
});
