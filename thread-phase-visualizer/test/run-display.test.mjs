import assert from "node:assert/strict";
import test from "node:test";
import {
  belongsToSession,
  formatElapsedDuration,
  formatOwnerMetadata,
  formatStaleIndicator,
  formatTotalTokens,
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
  assert.equal(formatElapsedDuration(start, "2026-01-02T02:03:04.000Z"), "26h 3m 4s");
  assert.equal(formatElapsedDuration("invalid", start), "?");
});

test("dashboard tokens use one compact aggregate total", () => {
  assert.equal(formatTotalTokens({ totalTokens: 8750, inputTokens: 8000, outputTokens: 750 }), "8.8K tok");
  assert.equal(formatTotalTokens({ inputTokens: 1_000_000, outputTokens: 250_000 }), "1.3M tok");
  assert.equal(formatTotalTokens({ totalTokens: 42 }), "42 tok");
  assert.equal(formatTotalTokens(undefined), "");
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
