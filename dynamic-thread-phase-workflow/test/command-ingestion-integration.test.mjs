import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const cli = join(root, "dynamic-thread-phase-workflow/bin/dynamic-thread-phase-workflow.mjs");

function fakePiSource(counterFile) {
  return `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
const promptIndex = process.argv.indexOf("-p");
const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] : "";
const emit = (value) => console.log(JSON.stringify(value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (text) => emit({ type: "message_end", message: { role: "assistant", model: "fake", stopReason: "stop", usage: { input: 1, output: 1 }, content: [{ type: "text", text }] } });
if (prompt === "a" || prompt === "b") {
  const id = "reused-real-id";
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "thinking-" + prompt } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "prose-" + prompt } });
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id, toolName: "bash" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id, name: "bash", arguments: { command: prompt } } } });
  emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: prompt } });
  await sleep(prompt === "a" ? 20 : 5);
  emit({ type: "tool_execution_update", toolCallId: id, toolName: "bash", args: { command: prompt }, partialResult: { content: [{ type: "text", text: "partial-" + prompt }] } });
  for (let index = 0; index < 100; index++) emit({ type: "tool_execution_update", toolCallId: id, toolName: "bash", args: { command: prompt }, partialResult: { content: [{ type: "text", text: "snapshot-" + index }] } });
  await sleep(prompt === "a" ? 5 : 20);
  emit({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: prompt === "a" ? "finished" : "permission denied" }] }, isError: prompt === "b" });
  if (prompt === "a") {
    emit({ type: "tool_execution_start", toolCallId: "open-command", toolName: "bash", args: { command: "long" } });
    emit({ type: "tool_execution_update", toolCallId: "open-command", toolName: "bash", args: { command: "long" }, partialResult: { content: [{ type: "text", text: "z".repeat(300000) }] } });
    emit({ type: "tool_execution_end", toolCallId: "read-command", toolName: "read", result: { content: [{ type: "text", text: "private read body" }] }, isError: false });
  }
  message("fanout-" + prompt);
  emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "must not persist" }] }] });
} else {
  const first = !existsSync(${JSON.stringify(counterFile)});
  writeFileSync(${JSON.stringify(counterFile)}, "seen");
  emit({ type: "tool_execution_start", toolCallId: "retry-id", toolName: "bash", args: { command: "retry" } });
  emit({ type: "tool_execution_end", toolCallId: "retry-id", toolName: "bash", result: { content: [{ type: "text", text: first ? "first failed" : "second finished" }] }, isError: first });
  message(first ? "retry first" : "retry second");
  emit({ type: "agent_end", messages: [] });
  if (first) process.exitCode = 1;
}
`;
}

test("fake Pi NDJSON flows through collector, runner throttle, persisted events, and store command projection", { timeout: 20_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "command-ingestion-integration-"));
  try {
    const storeDir = join(temp, "store");
    const fakePi = join(temp, "fake-pi.mjs");
    const counter = join(temp, "retry-counter");
    const spec = join(temp, "spec.json");
    writeFileSync(fakePi, fakePiSource(counter));
    chmodSync(fakePi, 0o755);
    writeFileSync(spec, JSON.stringify({
      name: "command-contract",
      permissions: "rwx",
      phases: [
        { type: "fanout", name: "fan", items: ["a", "b"], prompt: "{{item}}", concurrency: 2, failOnItemFailure: false },
        { type: "agent", name: "retry", prompt: "retry", attempts: 2 },
      ],
    }));
    const result = spawnSync(process.execPath, [cli, "--spec-file", spec, "--cwd", temp], {
      cwd: root,
      env: {
        ...process.env,
        PI_THREAD_PHASE_STORE_DIR: storeDir,
        PI_DYNAMIC_WORKFLOW_PI_BIN: fakePi,
        PI_DYNAMIC_WORKFLOW_BACKGROUND: "",
        PI_DYNAMIC_THREAD_PHASE_BACKGROUND: "",
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
    const store = await import(`../../thread-phase-visualizer/lib/store.mjs?command-integration=${Date.now()}`);
    const runFile = readdirSync(join(storeDir, "runs")).find((name) => name.endsWith(".jsonl"));
    assert.ok(runFile);
    const runId = runFile.slice(0, -".jsonl".length);
    const projected = store.getRunSummary(runId);
    const fan = projected.phases.find((phase) => phase.phase === "fan");
    const a = fan.fanout.items.find((item) => item.itemId === "0:a");
    const b = fan.fanout.items.find((item) => item.itemId === "1:b");
    assert.equal(fan.commandLedger, undefined);
    assert.deepEqual(a.commandLedger.rows.map((row) => row.state), ["succeeded", "interrupted", "succeeded"]);
    assert.equal(a.commandLedger.rows[0].outputPreview.text, "finished");
    assert.equal(a.commandLedger.rows[1].outputPreview.omitted, "event_input_limit");
    assert.equal(a.commandLedger.rows[2].outputPreview.omitted, "read_output");
    assert.equal(b.commandLedger.rows[0].state, "failed");
    assert.equal(b.commandLedger.rows[0].errorPreview.text, "permission denied");
    assert.notEqual(a.commandLedger.rows[0].key, b.commandLedger.rows[0].key);

    const retry = projected.phases.find((phase) => phase.phase === "retry");
    assert.equal(retry.commandLedger.rows.length, 2);
    assert.deepEqual(retry.commandLedger.rows.map((row) => row.state), ["failed", "succeeded"]);
    assert.notEqual(retry.commandLedger.rows[0].invocationId, retry.commandLedger.rows[1].invocationId);
    assert.deepEqual(retry.commandLedger.rows.map((row) => row.attempt), [1, 2]);

    const commandUpdates = projected.events.filter((entry) => entry.data?.type === "tool_execution_update" && entry.data?.toolCallId === "reused-real-id");
    assert.ok(commandUpdates.length <= 4, `per-command update throttle emitted ${commandUpdates.length} records for 202 snapshots`);
    const content = projected.events.filter((entry) => entry.data?.type === "content_delta").map((entry) => entry.data);
    assert.ok(content.some((entry) => entry.contentType === "thinking" && entry.delta.startsWith("thinking-")));
    assert.ok(content.some((entry) => entry.contentType === "text" && entry.delta.startsWith("prose-")));
    assert.ok(content.every((entry) => !(entry.delta.includes("thinking-") && entry.delta.includes("prose-"))), "thinking and prose were never combined");
    const persisted = JSON.stringify(projected.events);
    assert.doesNotMatch(persisted, /private read body|must not persist|z{100}/);
    assert.equal(projected.usage.inputTokens, 4, "existing per-message usage arithmetic remains intact across retries/items");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
