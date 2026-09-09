import assert from "node:assert/strict";
import test from "node:test";
import {
  belongsToSession,
  formatElapsedDuration,
  formatOwnerMetadata,
  formatStaleIndicator,
  formatTokenBreakdown,
  formatTokenSummary,
  formatTotalTokens,
  processedTokenTotal,
  runSessionId,
} from "../lib/run-display.mjs";

test("runSessionId reads metadata.sessionId and belongsToSession compares owners", () => {
  const run = { cwd: "/repo", metadata: { sessionId: "session-a" } };
  assert.equal(runSessionId(run), "session-a");
  assert.equal(belongsToSession(run, "session-a", "/other"), true);
  assert.equal(belongsToSession(run, "session-b", "/repo"), false);
  assert.equal(belongsToSession({ cwd: "/repo", normalizedStatus: "running" }, undefined, "/repo"), true);
  assert.equal(belongsToSession({ cwd: "/repo", normalizedStatus: "success" }, undefined, "/repo"), false);
  assert.equal(belongsToSession({ cwd: "/elsewhere", normalizedStatus: "running" }, undefined, "/repo"), false);
  assert.equal(belongsToSession({}, undefined, "/repo"), false);
});

test("dashboard duration uses compact aggregate hours, minutes, and seconds", () => {
  const start = "2026-01-01T00:00:00.000Z";
  assert.equal(formatElapsedDuration(start, "2026-01-01T00:00:00.999Z"), "0s");
  assert.equal(formatElapsedDuration(start, "2026-01-01T00:02:03.000Z"), "2m 3s");
  assert.equal(formatElapsedDuration(start, "2026-01-02T02:03:04.000Z"), "26h 3m");
  assert.equal(formatElapsedDuration("invalid", start), "?");
});

test("dashboard token labels distinguish output from cumulative processed traffic", () => {
  const cacheHeavy = {
    inputTokens: 527_373,
    outputTokens: 87_266,
    reasoningTokens: 30_791,
    cachedInputTokens: 18_404_224,
    cacheCreationInputTokens: 0,
    totalTokens: 19_018_863,
  };
  assert.equal(formatTokenSummary(cacheHeavy), "87.3K output · 19M cumulative processed tokens");
  assert.deepEqual(formatTokenBreakdown(cacheHeavy), [
    "527,373 uncached input · 18,404,224 cache-read input · 0 cache-write input",
    "87,266 output (30,791 reasoning included) · 19,018,863 cumulative processed tokens",
  ]);
  assert.equal(formatTotalTokens({ totalTokens: 42 }), "42 cumulative processed tokens");
  assert.equal(formatTotalTokens(undefined), "");
});

test("canonical projected fallback includes cache traffic without readding reasoning", () => {
  const usage = {
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheCreationInputTokens: 5,
    outputTokens: 30,
    reasoningTokens: 12,
  };
  assert.equal(processedTokenTotal(usage), 175);
  assert.equal(formatTokenSummary(usage), "30 output · 175 cumulative processed tokens");
  assert.match(formatTokenBreakdown(usage)[1], /^30 output \(12 reasoning included\) · 175 /);
});

test("owner and stale display use one canonical representation", () => {
  const run = {
    metadata: { sessionId: "session-a", launchSource: "background", cwdAtLaunch: "/repo" },
    stale: { reason: "pid_not_running", pid: 123 },
  };
  // Owner metadata is trimmed to high-signal fields only (audit MUST): full session
  // IDs and launch cwd are dropped as low-value provenance.
  assert.equal(formatOwnerMetadata(run), "launch source: background");
  assert.equal(formatStaleIndicator(run), "[STALE] pid_not_running");
});
