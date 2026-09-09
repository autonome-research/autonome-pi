import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerDynamicWorkflows from "../index.ts";

function registeredTools() {
  const tools = new Map();
  registerDynamicWorkflows({ registerTool: (definition) => tools.set(definition.name, definition) });
  return tools;
}

function context(cwd) {
  return { cwd, sessionManager: { getSessionId: () => "scripted-command-attribution" } };
}

test("scripted_workflow fake-Pi commands are attributed only to their actual fanout item lanes", { timeout: 20_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "scripted-command-attribution-"));
  const previous = Object.fromEntries([
    "PI_THREAD_PHASE_STORE_DIR",
    "PI_DYNAMIC_WORKFLOW_PI_BIN",
    "PI_DYNAMIC_WORKFLOW_BACKGROUND",
    "PI_DYNAMIC_THREAD_PHASE_BACKGROUND",
  ].map((key) => [key, process.env[key]]));
  try {
    const storeDir = join(temp, "store");
    const fakePi = join(temp, "fake-pi.mjs");
    writeFileSync(fakePi, `#!/usr/bin/env node
const promptIndex = process.argv.indexOf("-p");
const prompt = promptIndex < 0 ? "unknown" : process.argv[promptIndex + 1];
const id = "call-" + prompt.replace(/[^a-z0-9]/gi, "-");
const emit = (value) => console.log(JSON.stringify(value));
emit({ type: "agent_start" });
emit({ type: "turn_start" });
emit({ type: "message_start", message: { role: "assistant", content: [] } });
emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id, toolName: "bash" } });
emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id, name: "bash", arguments: { command: prompt } } } });
emit({ type: "message_end", message: { role: "assistant", model: "fake", stopReason: "toolUse", usage: { input: 1, output: 1 }, content: [{ type: "toolCall", id, name: "bash", arguments: { command: prompt } }] } });
emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: prompt } });
emit({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: "ran " + prompt }] }, isError: false });
emit({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
emit({ type: "turn_start" });
emit({ type: "message_start", message: { role: "assistant", content: [] } });
emit({ type: "message_end", message: { role: "assistant", model: "fake", stopReason: "stop", usage: { input: 1, output: 1 }, content: [{ type: "text", text: "finished " + prompt }] } });
emit({ type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
emit({ type: "agent_end", messages: [] });
`);
    chmodSync(fakePi, 0o755);
    process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
    process.env.PI_DYNAMIC_WORKFLOW_PI_BIN = fakePi;
    delete process.env.PI_DYNAMIC_WORKFLOW_BACKGROUND;
    delete process.env.PI_DYNAMIC_THREAD_PHASE_BACKGROUND;

    const result = await registeredTools().get("scripted_workflow").execute("test", {
      name: "scripted-attribution",
      permissions: "rwx",
      script: `export default async function workflow(ctx) {
        await ctx.fanout(["a", "b"], { name: "outer", concurrency: 2, prompt: "direct {{item}}" });
        await ctx.fanout(["c"], { name: "custom", run: async (item, index, itemCtx) => itemCtx.pi("custom " + item, { name: "custom-pi" }) });
        await ctx.fanout(["parent"], { name: "parents", run: async (_item, _index, itemCtx) => itemCtx.fanout(["child"], { name: "nested", prompt: "nested {{item}}" }) });
      }`,
    }, undefined, undefined, context(temp));

    assert.ok(result.details?.runId);
    const store = await import(`../../thread-phase-visualizer/lib/store.mjs?scripted-attribution=${Date.now()}`);
    const projected = store.getRunSummary(result.details.runId);
    for (const [phaseName, expectedItems] of [["outer", 2], ["custom", 1], ["nested", 1]]) {
      const phase = projected.phases.find((entry) => entry.phase === phaseName);
      assert.ok(phase, `${phaseName} phase exists`);
      assert.equal(phase.commandLedger, undefined, `${phaseName} has no parent-level command duplication`);
      assert.equal(phase.fanout.items.length, expectedItems);
      assert.ok(phase.fanout.items.every((item) => item.commandLedger?.rows.length === 1));
      assert.ok(phase.fanout.items.every((item) => item.commandLedger.rows[0].state === "succeeded"));
    }
    const helperPhases = projected.phases.filter((phase) => /^(outer-|custom-pi$|nested-)/.test(phase.phase));
    assert.ok(helperPhases.length >= 4);
    assert.ok(helperPhases.every((phase) => phase.commandLedger === undefined), "nested helper phases do not double-count item commands");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
