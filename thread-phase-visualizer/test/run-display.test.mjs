import assert from "node:assert/strict";
import test from "node:test";
import {
  belongsToSession,
  formatOwnerMetadata,
  formatStaleIndicator,
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

test("owner and stale display use one canonical representation", () => {
  const run = {
    metadata: { sessionId: "session-a", launchSource: "background", cwdAtLaunch: "/repo" },
    stale: { reason: "pid_not_running", pid: 123 },
  };
  assert.equal(formatOwnerMetadata(run), "sessionId: session-a  launch source: background  cwd at launch: /repo");
  assert.equal(formatStaleIndicator(run), "[STALE] pid_not_running");
});
