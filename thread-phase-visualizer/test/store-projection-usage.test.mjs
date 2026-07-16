import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-usage-projection-store-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
const store = await import(`../lib/store.mjs?projection-usage=${Date.now()}`);

test.after(() => rmSync(storeDir, { recursive: true, force: true }));

const envelope = {
  schema: store.SCHEMA_VERSION,
  runId: "usage-projection-run",
  workflow: "projection-test",
  type: store.EVENT_TYPES.PHASE_EVENT,
  phase: "agent",
};

function usageEvent(eventId, seconds, data) {
  return {
    ...envelope,
    eventId,
    timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, seconds)).toISOString(),
    data,
  };
}

test("projectRun sums input, output, and reasoning tokens across usage events", () => {
  const projected = store.projectRun([
    usageEvent("snake-case", 1, {
      kind: "usage",
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        output_token_details: { reasoning_tokens: 2 },
      },
    }),
    usageEvent("camel-case-array", 2, {
      kind: "usage",
      usage: [
        { promptTokens: 7, completionTokens: 3, reasoningTokens: 1 },
        { inputTokens: 5, outputTokens: 6, completion_tokens_details: { reasoning_tokens: 4 } },
      ],
    }),
  ]);

  assert.deepEqual(
    {
      entries: projected.usage.entries,
      inputTokens: projected.usage.inputTokens,
      outputTokens: projected.usage.outputTokens,
      totalTokens: projected.usage.totalTokens,
      reasoningTokens: projected.usage.reasoningTokens,
    },
    {
      entries: 3,
      inputTokens: 22,
      outputTokens: 13,
      totalTokens: 35,
      reasoningTokens: 7,
    },
  );
  assert.equal(projected.phases.length, 1);
  assert.deepEqual(
    {
      inputTokens: projected.phases[0].usage.inputTokens,
      outputTokens: projected.phases[0].usage.outputTokens,
      reasoningTokens: projected.phases[0].usage.reasoningTokens,
    },
    { inputTokens: 22, outputTokens: 13, reasoningTokens: 7 },
  );
});
