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
  collector.push(Buffer.from(`{"type":"message_update","payload":"${"x".repeat(1_000_000)}`));
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
  assert.throws(() => new PiJsonEventCollector({ maxExecutionEventParseBytes: 0 }), /positive safe integer/);
  assert.throws(() => new PiJsonEventCollector({ maxResultPreviewBytes: -1 }), /positive safe integer/);
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

test("collector keeps assistant prose distinct from thinking", () => {
  const collector = new PiJsonEventCollector();
  collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "private thought" } }));
  collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "public prose" } }));
  const result = collector.finish();
  assert.equal(result.trace.reasoning, "private thought");
  assert.equal(result.trace.text, "public prose");
  assert.equal(result.piJson.reasoningDeltas, 1);
  assert.equal(result.piJson.textDeltas, 1);
  assert.deepEqual(result.trace.window.map((entry) => entry.contentType), ["thinking", "text"]);
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

test("captureContentDelta caps retained window records at the reasoning budget for non-coalescing streams", () => {
  // Small budget so reasoning fills up quickly; a distinct contentIndex per
  // record prevents window coalescing, exercising the path that used to leave
  // `keep` as the full uncapped safeDelta once the accumulation was at budget.
  const collector = new PiJsonEventCollector({ maxReasoningChars: 4, maxTraceWindow: 16 });
  const hugeDelta = "z".repeat(1_000);
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "abcd" },
  }));
  // Now at budget. A non-coalescing stream (different contentIndex) with a
  // huge delta arrives: the retained window record must honor the budget, not
  // carry the full delta text, and traceExcluded must reflect the exclusion.
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: hugeDelta },
  }));
  collector.push(eventLine(finalMessage()));
  const result = collector.finish();

  const contentDeltas = result.trace.window.filter((rec) => rec.type === "content_delta");
  for (const rec of contentDeltas) {
    assert.ok(Buffer.byteLength(rec.delta, "utf8") <= collector.maxReasoningChars, "window record delta honors the reasoning budget");
  }
  // The buffer filled with the first record, then the huge delta was entirely
  // excluded (keep was empty): reasoning stayed at budget.
  assert.ok(Buffer.byteLength(result.trace.reasoning, "utf8") <= 4);
  assert.ok(result.piJson.traceExcluded >= 1);
  assert.equal(result.trace.reasoning, "abcd");
  // No window record may carry even a fragment of the 1000-char delta.
  assert.ok(!contentDeltas.some((rec) => rec.delta.includes("z")), "uncapped delta text must not reach the retained window");
});

test("collector preserves real tool ids and treats argument completion as ready only", () => {
  const traces = [];
  const collector = new PiJsonEventCollector({ invocationId: "inv-one", attempt: 2, onTrace: (evt) => traces.push(evt) });
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "real-call", toolName: "read" },
  }));
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{\"path\":\"a" },
  }));
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { id: "real-call", name: "read", arguments: { path: "a/b/c" } } },
  }));
  const result = collector.finish();

  const window = result.trace.window;
  assert.equal(window[0].type, "tool_call_preparing");
  assert.equal(window[0].toolCallId, "real-call");
  assert.equal(window[0].toolName, "read");
  assert.equal(window[0].invocationId, "inv-one");
  assert.equal(window[0].attempt, 2);
  assert.equal(window[1].type, "tool_call_ready");
  assert.equal(window[1].toolName, "read");
  assert.match(window[1].argsPreview.text, /a\/b\/c/);
  assert.equal(result.piJson.toolCallStarted, 1);
  assert.equal(result.piJson.toolCallCompleted, 1);
  assert.equal(result.piJson.traceExcluded, 1); // the argument delta was excluded
  assert.deepEqual(traces.map((t) => t.type), ["tool_call_preparing", "tool_call_ready"]);
});

 test("collector captures observed execution snapshots and authoritative end outcomes", () => {
  const traces = [];
  const collector = new PiJsonEventCollector({ invocationId: "exec-inv", onTrace: (event) => traces.push(event) });
  collector.push(eventLine({ type: "tool_execution_start", toolCallId: "call-A", toolName: "bash", args: { command: "printf ok" } }));
  collector.push(eventLine({ type: "tool_execution_update", toolCallId: "call-A", toolName: "bash", args: { command: "printf ok" }, partialResult: { content: [{ type: "text", text: "partial" }], details: { headers: { authorization: "Bearer hidden" } } } }));
  collector.push(eventLine({ type: "tool_execution_end", toolCallId: "call-A", toolName: "bash", result: { content: [{ type: "text", text: "finished" }], details: { exitCode: 0 } }, isError: false }));
  collector.push(eventLine({ type: "tool_execution_start", toolCallId: "call-B", toolName: "bash", args: { command: "bad" } }));
  collector.push(eventLine({ type: "tool_execution_end", toolCallId: "call-B", toolName: "bash", result: { content: [{ type: "text", text: "permission denied" }] }, isError: true }));
  const result = collector.finish();

  assert.deepEqual(traces.map((event) => event.type), ["tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_execution_start", "tool_execution_end"]);
  assert.equal(traces[1].outputPreview.text, "partial");
  assert.equal(traces[2].resultPreview.text, "finished");
  assert.equal(traces[2].isError, false);
  assert.equal(traces[4].isError, true);
  assert.equal(traces[4].resultPreview.text, "permission denied");
  assert.equal("exitCode" in traces[2], false);
  assert.equal(result.piJson.toolExecutionEnded, 2);
 });

 test("collector gives every missing-id lifecycle event a distinct synthetic identity", () => {
  const traces = [];
  const collector = new PiJsonEventCollector({ invocationId: "missing", onTrace: (event) => traces.push(event) });
  collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, toolName: "bash" } }));
  collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { name: "bash", arguments: {} } } }));
  collector.push(eventLine({ type: "tool_execution_start", toolName: "bash", args: {} }));
  assert.equal(new Set(traces.map((event) => event.syntheticId)).size, 3);
  assert.ok(traces.every((event) => event.identitySource === "synthetic"));
 });

 test("collector bounds/redacts command payloads and omits successful read bodies", () => {
  const traces = [];
  const collector = new PiJsonEventCollector({ maxToolCallArgChars: 64, maxResultPreviewBytes: 48, maxExecutionEventParseBytes: 1_024, invocationId: "bounds", onTrace: (event) => traces.push(event) });
  collector.push(eventLine({ type: "tool_execution_start", toolCallId: "secret", toolName: "bash", args: { command: "echo ok", Authorization: "Bearer top-secret", imageBase64: "A".repeat(600) } }));
  collector.push(eventLine({ type: "tool_execution_end", toolCallId: "secret", toolName: "bash", result: { content: [{ type: "text", text: "x".repeat(2_000) }] }, isError: false }));
  collector.push(eventLine({ type: "tool_execution_end", toolCallId: "read", toolName: "read", result: { content: [{ type: "text", text: "private file body" }] }, isError: false }));
  const result = collector.finish();

  assert.doesNotMatch(JSON.stringify(traces), /top-secret|private file body|A{100}/);
  assert.equal(traces[0].argsPreview.truncated, true);
  assert.equal(traces[0].argsPreview.redacted, true);
  assert.equal(traces[1].resultPreview.omitted, "event_input_limit");
  assert.equal(traces[2].resultPreview.omitted, "read_output");
  assert.ok(result.trace.window.length <= collector.maxTraceWindow);
 });

 test("collector emits agent scope end without retaining agent messages", () => {
  const traces = [];
  const collector = new PiJsonEventCollector({ invocationId: "scope", onTrace: (event) => traces.push(event) });
  collector.push(eventLine({ type: "tool_execution_start", toolCallId: "open", toolName: "bash", args: {} }));
  collector.push(eventLine({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "x".repeat(100_000) }] }] }));
  assert.deepEqual(traces.map((event) => event.type), ["tool_execution_start", "agent_execution_scope_end"]);
  assert.equal(JSON.stringify(traces).includes("x".repeat(100)), false);
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

test("onTrace receives a shallow copy not aliased to the coalesced retained window", () => {
  // Hold the exact references (no defensive snapshot) so aliasing would surface:
  // if onTrace delivered the retained-window object, later coalescing would
  // mutate the deltas we already saw.
  const received = [];
  const collector = new PiJsonEventCollector({ onTrace: (evt) => received.push(evt) });
  collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "a" } }));
  collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "b" } }));
  collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "c" } }));
  const result = collector.finish();

  // Each delivered object still carries only its own individual delta.
  assert.equal(received.length, 3);
  assert.deepEqual(received.map((record) => record.delta), ["a", "b", "c"]);
  // The retained window coalesced the stream into one content_delta.
  assert.equal(result.trace.window.length, 1);
  assert.equal(result.trace.window[0].delta, "abc");
});

test("collector isolates a throwing onUsage observer without breaking the stream", () => {
  const calls = [];
  const collector = new PiJsonEventCollector({
    onUsage: () => { calls.push("seen"); throw new Error("boom"); },
  });
  collector.push(eventLine(finalMessage("still works")));
  const result = collector.finish();
  // The observer was invoked, its throw was swallowed, and usage/stream are intact.
  assert.equal(calls.length, 1);
  assert.equal(result.text, "still works");
  assert.equal(result.usage.length, 1);
  assert.equal(result.usage[0].input, 10);
  assert.equal(result.usage[0].output, 2);
});

test("collector scopes a reused real tool id to Pi turn_start boundaries only", () => {
  const traces = [];
  const collector = new PiJsonEventCollector({ invocationId: "turns", onTrace: (event) => traces.push(event) });
  const lifecycle = (argument, result) => {
    collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "reused", toolName: "bash" } }));
    collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "reused", name: "bash", arguments: { command: argument } } } }));
    collector.push(eventLine({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "reused", name: "bash", arguments: { command: argument } }] } }));
    collector.push(eventLine({ type: "tool_execution_start", toolCallId: "reused", toolName: "bash", args: { command: argument } }));
    collector.push(eventLine({ type: "tool_execution_end", toolCallId: "reused", toolName: "bash", result: { content: [{ type: "text", text: result }] }, isError: false }));
    // Pi emits tool-result message lifecycle records inside the same turn. They
    // must not be mistaken for another model turn.
    collector.push(eventLine({ type: "message_start", message: { role: "toolResult", toolCallId: "reused", content: [] } }));
    collector.push(eventLine({ type: "message_end", message: { role: "toolResult", toolCallId: "reused", content: [] } }));
    collector.push(eventLine({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] }));
  };

  collector.push(eventLine({ type: "agent_start" }));
  collector.push(eventLine({ type: "turn_start" }));
  collector.push(eventLine({ type: "message_start", message: { role: "user", content: "prompt" } }));
  collector.push(eventLine({ type: "message_end", message: { role: "user", content: "prompt" } }));
  lifecycle("first", "one");
  collector.push(eventLine({ type: "turn_start" }));
  lifecycle("second", "two");

  const commands = traces.filter((event) => event.schema === "pi-command-event/v1");
  assert.deepEqual(commands.map((event) => event.turn), [1, 1, 1, 1, 2, 2, 2, 2]);
  assert.equal(new Set(commands.slice(0, 4).map((event) => event.occurrence)).size, 1);
  assert.equal(new Set(commands.slice(4).map((event) => event.occurrence)).size, 1);
  assert.notEqual(commands[0].occurrence, commands[4].occurrence);
});

test("collector leaves execution association unknown for duplicate real ids in one turn", () => {
  const traces = [];
  const collector = new PiJsonEventCollector({ invocationId: "ambiguous", onTrace: (event) => traces.push(event) });
  collector.push(eventLine({ type: "turn_start" }));
  for (const contentIndex of [0, 1]) {
    collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex, id: "duplicate", toolName: "bash" } }));
    collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex, toolCall: { id: "duplicate", name: "bash", arguments: { command: String(contentIndex) } } } }));
  }
  collector.push(eventLine({ type: "tool_execution_start", toolCallId: "duplicate", toolName: "bash", args: {} }));
  collector.push(eventLine({ type: "tool_execution_end", toolCallId: "duplicate", toolName: "bash", result: { content: [{ type: "text", text: "unknown command" }] }, isError: false }));

  const commands = traces.filter((event) => event.schema === "pi-command-event/v1");
  assert.notEqual(commands[0].occurrence, commands[2].occurrence);
  assert.ok(commands.slice(0, 4).every((event) => event.identitySource === "pi"));
  assert.ok(commands.slice(4).every((event) => event.identitySource === "synthetic"));
  assert.ok(commands.slice(4).every((event) => event.occurrence === undefined));
});

test("collector bounds turn correlation metadata and degrades overflow to unknown identity", () => {
  const traces = [];
  const collector = new PiJsonEventCollector({ maxTraceWindow: 1, onTrace: (event) => traces.push(event) });
  collector.push(eventLine({ type: "turn_start" }));
  for (let index = 0; index <= 512; index++) {
    collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: index, id: `call-${index}`, toolName: "bash" } }));
  }
  assert.equal(traces[511].identitySource, "pi");
  assert.equal(traces[512].identitySource, "synthetic");
  assert.equal(traces[512].occurrence, undefined);
  assert.equal(collector.finish().trace.window.length, 1);
});

test("collector bounds unmatched execution keys as well as declaration records", () => {
  let latest;
  const collector = new PiJsonEventCollector({ maxTraceWindow: 1, onTrace: (event) => { latest = event; } });
  collector.push(eventLine({ type: "turn_start" }));
  for (let index = 0; index < 1_024; index++) {
    collector.push(eventLine({ type: "tool_execution_start", toolCallId: `unmatched-${index}`, toolName: "bash" }));
    assert.equal(latest.identitySource, index < 512 ? "pi" : "synthetic");
    assert.ok(collector.activeExecutions.size <= 512);
    assert.ok(collector.declarationsById.size <= 512);
  }
  assert.equal(collector.correlationRecords, 512);
  for (const type of ["tool_execution_update", "tool_execution_end"]) {
    collector.push(eventLine({ type, toolCallId: "unmatched-999", toolName: "bash", isError: false }));
    assert.equal(latest.identitySource, "synthetic");
    assert.equal(collector.activeExecutions.size, 512, "overflow never adds a retained key");
  }
  collector.push(eventLine({ type: "tool_execution_end", toolCallId: "unmatched-0", isError: false }));
  assert.equal(latest.identitySource, "pi", "retained commands still resolve after overflow");
  assert.equal(collector.activeExecutions.size, 511);
  collector.push(eventLine({ type: "turn_start" }));
  assert.equal(collector.activeExecutions.size, 0);
  assert.equal(collector.declarationsById.size, 0);
  assert.equal(collector.correlationRecords, 0);
});

test("oversized identifiers are rejected before correlation instead of prefix-truncated", () => {
  const traces = [];
  const collector = new PiJsonEventCollector({ onTrace: (event) => traces.push(event) });
  collector.push(eventLine({ type: "turn_start" }));
  for (const id of ["x".repeat(256) + "a", "x".repeat(256) + "b", "é".repeat(200), "x".repeat(300_000)]) {
    const toolName = "n".repeat(5_000);
    collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", id, toolName, contentIndex: 0 } }));
    collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id, name: toolName, arguments: {} } } }));
    collector.push(eventLine({ type: "tool_execution_start", toolCallId: id, toolName }));
    collector.push(eventLine({ type: "tool_execution_end", toolCallId: id, toolName, isError: false }));
  }
  assert.ok(traces.every((event) => event.identitySource === "synthetic"));
  assert.ok(traces.every((event) => event.toolCallId === undefined && event.toolName === undefined));
  assert.equal(new Set(traces.map((event) => event.syntheticId)).size, traces.length);
  assert.equal(collector.correlationRecords, 0);
  assert.equal(collector.declarationsById.size, 0);
  assert.equal(collector.declarationsByContent.size, 0);
  assert.equal(collector.activeExecutions.size, 0);

  // Oversized names alone must not pollute metadata for an otherwise valid ID.
  collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", id: "valid-id", toolName: "é".repeat(200), contentIndex: 1 } }));
  const [record] = [...collector.declarationsById.values()][0];
  assert.equal(record.toolCallId, "valid-id");
  assert.equal(record.toolName, undefined);
  assert.equal(traces.at(-1).identitySource, "pi");
});

test("oversized toolcall_end preserves the exact nested real id without retaining arguments", () => {
  const traces = [];
  const collector = new PiJsonEventCollector({ invocationId: "large-ready", onTrace: (event) => traces.push(event) });
  collector.push(eventLine({ type: "turn_start" }));
  collector.push(eventLine({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 3, id: "real-large-id", toolName: "write" } }));
  const misleading = 'argument text with \\"id\\":\\"not-the-call\\" and nested data';
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 3,
      toolCall: {
        arguments: { content: `${misleading}${"😀".repeat(70_000)}`, nested: { id: "also-not-the-call" } },
        name: "write",
        id: "real-large-id",
      },
    },
  }));
  collector.push(eventLine({ type: "tool_execution_start", toolCallId: "real-large-id", toolName: "write", args: { path: "x" } }));
  collector.push(eventLine({ type: "tool_execution_end", toolCallId: "real-large-id", toolName: "write", result: { content: [{ type: "text", text: "wrote" }] }, isError: false }));
  // No matching start metadata for this one: the direct toolCall.id appears
  // after a large escaped/nested argument payload and must be found
  // structurally, not by prefix retention or an argument-text regex.
  collector.push(eventLine({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 4,
      toolCall: {
        arguments: { content: `${misleading}${"é".repeat(140_000)}`, nested: { id: "nested-wrong-id" } },
        name: "write",
        id: "structural-large-id",
      },
    },
  }));
  collector.push(eventLine({ type: "tool_execution_start", toolCallId: "structural-large-id", toolName: "write", args: {} }));
  collector.push(eventLine({ type: "tool_execution_end", toolCallId: "structural-large-id", toolName: "write", result: { content: [{ type: "text", text: "wrote again" }] }, isError: false }));

  const commands = traces.filter((event) => event.schema === "pi-command-event/v1");
  assert.deepEqual(commands.slice(0, 4).map((event) => event.toolCallId), Array(4).fill("real-large-id"));
  assert.deepEqual(commands.slice(4).map((event) => event.toolCallId), Array(3).fill("structural-large-id"));
  assert.equal(new Set(commands.slice(0, 4).map((event) => event.occurrence)).size, 1);
  assert.equal(new Set(commands.slice(4).map((event) => event.occurrence)).size, 1);
  assert.notEqual(commands[0].occurrence, commands[4].occurrence);
  assert.equal(commands[1].argsPreview.omitted, "event_input_limit");
  assert.equal(commands[4].argsPreview.omitted, "event_input_limit");
  assert.doesNotMatch(JSON.stringify(commands), /not-the-call|nested-wrong-id|😀|é{20}/);
});

test("collector decodes args, result output, and final text across every UTF-8 byte split", () => {
  const records = [
    { type: "turn_start" },
    { type: "tool_execution_start", toolCallId: "utf8", toolName: "bash", args: { command: "printf '😀'" } },
    { type: "tool_execution_end", toolCallId: "utf8", toolName: "bash", result: { content: [{ type: "text", text: "résultat 😀" }] }, isError: false },
    finalMessage("final 😀 café"),
  ];
  const bytes = Buffer.from(records.map(eventLine).join(""));
  for (let split = 1; split < bytes.length; split++) {
    const collector = new PiJsonEventCollector();
    collector.push(bytes.subarray(0, split));
    collector.push(bytes.subarray(split));
    const result = collector.finish();
    const commands = result.trace.window.filter((event) => event.schema === "pi-command-event/v1");
    assert.match(commands[0].argsPreview.text, /😀/, `args split ${split}`);
    assert.equal(commands[1].resultPreview.text, "résultat 😀", `result split ${split}`);
    assert.equal(result.text, "final 😀 café", `text split ${split}`);
  }
});

test("collector accepts ordered string and Buffer chunks and flushes incomplete bytes on a mode switch", () => {
  const line = eventLine(finalMessage("mixed 😀"));
  const marker = line.indexOf("mixed");
  const collector = new PiJsonEventCollector();
  collector.push(line.slice(0, marker));
  collector.push(Buffer.from(line.slice(marker, marker + 3)));
  collector.push(line.slice(marker + 3));
  assert.equal(collector.finish().text, "mixed 😀");

  const incomplete = new PiJsonEventCollector();
  incomplete.push(Buffer.from([0xf0, 0x9f]));
  incomplete.push(`\n${eventLine(finalMessage("after invalid boundary"))}`);
  const result = incomplete.finish();
  assert.equal(result.text, "after invalid boundary");
  assert.equal(result.piJson.malformedEvents, 1);

  const eof = new PiJsonEventCollector();
  eof.push(Buffer.from([0xf0, 0x9f]));
  const eofResult = eof.finish();
  assert.equal(eofResult.piJson.malformedEvents, 1);
  assert.equal(eofResult.piJson.bufferedBytes, 0);
});
