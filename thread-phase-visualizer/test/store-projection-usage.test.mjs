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
      model: "provider/model-a",
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
  assert.equal(projected.phases[0].model, "provider/model-a");
  assert.deepEqual(
    {
      inputTokens: projected.phases[0].usage.inputTokens,
      outputTokens: projected.phases[0].usage.outputTokens,
      reasoningTokens: projected.phases[0].usage.reasoningTokens,
    },
    { inputTokens: 22, outputTokens: 13, reasoningTokens: 7 },
  );
});

test("projectRun accepts Pi-native token keys (input/output/reasoning/cacheRead/cacheWrite)", () => {
  const projected = store.projectRun([
    usageEvent("pi-native", 1, {
      kind: "usage",
      usage: {
        input: 100,
        output: 30,
        reasoning: 12,
        cacheRead: 40,
        cacheWrite: 5,
        totalTokens: 175,
      },
    }),
  ]);
  assert.equal(projected.usage.entries, 1);
  assert.equal(projected.usage.inputTokens, 100);
  assert.equal(projected.usage.outputTokens, 30);
  assert.equal(projected.usage.totalTokens, 175);
  assert.equal(projected.usage.reasoningTokens, 12);
  assert.equal(projected.usage.cachedInputTokens, 40);
  assert.equal(projected.usage.cacheCreationInputTokens, 5);
});

test("absent-total fallback adds cache only for canonical Pi usage", () => {
  const projected = store.projectRun([
    usageEvent("canonical", 1, {
      kind: "usage",
      usage: { input: 100, output: 30, reasoning: 12, cacheRead: 40, cacheWrite: 5 },
    }),
    usageEvent("ambiguous-legacy", 2, {
      kind: "usage",
      usage: { input_tokens: 100, output_tokens: 30, cached_input_tokens: 40 },
    }),
  ]);
  assert.equal(projected.usage.totalTokens, 305, "175 canonical + 130 ambiguous legacy");
  assert.equal(projected.usage.reasoningTokens, 12, "reasoning remains a subset of output");
});

test("absent-total canonicality follows the selected input field rather than output aliases", () => {
  const cases = [
    ["hybrid-legacy", { input_tokens: 100, output: 30, cached_input_tokens: 40 }, 130],
    ["camel-legacy", { inputTokens: 100, output: 30, cacheRead: 40 }, 130],
    ["prompt-legacy", { promptTokens: 100, output: 30, cacheRead: 40 }, 130],
    ["mixed-prefers-legacy", { input_tokens: 100, input: 90, output: 30, cacheRead: 40 }, 130],
    ["invalid-legacy-selects-native", { input_tokens: "invalid", input: 100, output_tokens: 30, cacheRead: 40 }, 170],
    ["null-legacy-selects-native", { input_tokens: null, input: 100, output: 30, cacheRead: 40 }, 170],
    ["native", { input: 100, output: 30, cacheRead: 40 }, 170],
    ["explicit-total", { input_tokens: 100, output: 30, cached_input_tokens: 40, totalTokens: 777 }, 777],
    ["explicit-zero-total", { input: 100, output: 30, cacheRead: 40, total_tokens: 0 }, 0],
    ["invalid-total", { input_tokens: 100, output: 30, cached_input_tokens: 40, total: "invalid" }, 130],
    ["null-total", { input: 100, output: 30, cacheRead: 40, total: null }, 170],
  ];

  for (const [name, usage, expected] of cases) {
    const projected = store.projectRun([usageEvent(name, 1, { kind: "usage", usage })]);
    assert.equal(projected.usage.totalTokens, expected, name);
  }
});

test("cache-heavy usage is counted once across run, phase, and fanout hierarchy", () => {
  const fanoutStart = usageEvent("fanout-start", 0, { kind: "fanout_start", total: 2 });
  const first = usageEvent("item-a", 1, {
    kind: "usage",
    itemId: "a",
    usage: { input: 527_373, output: 87_266, reasoning: 30_791, cacheRead: 18_404_224, cacheWrite: 0, totalTokens: 19_018_863 },
  });
  const duplicate = { ...first };
  const second = usageEvent("item-b", 2, {
    kind: "usage",
    itemId: "b",
    usage: { input: 9_522, output: 1_385, reasoning: 1_088, cacheRead: 3_584, cacheWrite: 0, totalTokens: 14_491 },
  });
  const projected = store.projectRun([
    fanoutStart,
    usageEvent("item-a-start", 0.1, { kind: "fanout_item_start", itemId: "a", label: "a", index: 0 }),
    usageEvent("item-b-start", 0.2, { kind: "fanout_item_start", itemId: "b", label: "b", index: 1 }),
    first,
    duplicate,
    second,
    {
      ...envelope,
      eventId: "phase-end",
      timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, 3)).toISOString(),
      type: store.EVENT_TYPES.PHASE_END,
      status: "success",
    },
    {
      ...envelope,
      eventId: "workflow-end",
      timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, 4)).toISOString(),
      type: store.EVENT_TYPES.WORKFLOW_END,
      status: "success",
    },
  ]);

  assert.equal(projected.usage.totalTokens, 19_033_354);
  assert.equal(projected.usage.outputTokens, 88_651);
  assert.equal(projected.usage.reasoningTokens, 31_879);
  assert.equal(projected.phases[0].usage.totalTokens, projected.usage.totalTokens);
  assert.deepEqual(
    projected.phases[0].fanout.items.map((item) => item.usage.totalTokens),
    [19_018_863, 14_491],
  );
  assert.equal(
    projected.phases[0].fanout.items.reduce((sum, item) => sum + item.usage.totalTokens, 0),
    projected.usage.totalTokens,
    "item hierarchy reconciles but is not readded into the run",
  );
});
