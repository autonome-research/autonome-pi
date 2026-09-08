import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const supervision = await import("../lib/supervision-store.mjs");
const messages = await import("../lib/supervision-message.mjs");

function temporaryStore(t) {
  const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-progress-review-"));
  t.after(() => rmSync(storeDir, { recursive: true, force: true }));
  return storeDir;
}

test("reviews are anchored to trusted start, become overdue across restart, and remain periodic", (t) => {
  const storeDir = temporaryStore(t);
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const first = supervision.ensureProgressReview("run-periodic", { storeDir, startedAt: start, cadenceMs: 1_000, now: start + 200 });
  assert.equal(first.state, "scheduled");
  assert.equal(Date.parse(first.dueAt), start + 1_000);
  const chatty = supervision.ensureProgressReview("run-periodic", { storeDir, startedAt: start, cadenceMs: 1_000, now: start + 900 });
  assert.equal(chatty.checkId, first.checkId);
  assert.equal(chatty.dueAt, first.dueAt, "activity does not postpone the timer");

  // A fresh module/runtime does not reset elapsed time: the same durable check
  // is pending with its original identity and due timestamp.
  const overdue = supervision.ensureProgressReview("run-periodic", { storeDir, startedAt: start, cadenceMs: 1_000, now: start + 2_500 });
  assert.equal(overdue.state, "pending");
  assert.equal(overdue.checkId, first.checkId);
  assert.equal(Date.parse(overdue.dueAt), start + 1_000);

  const claimantId = supervision.createProgressReviewClaimantId();
  const claim = supervision.claimProgressReview("run-periodic", { storeDir, claimantId, now: start + 2_500 });
  assert.equal(claim.claimed, true);
  const acknowledged = supervision.acknowledgeProgressReview("run-periodic", { storeDir, checkId: claim.checkId, now: start + 2_500 });
  assert.equal(acknowledged.acknowledged, true);
  assert.equal(Date.parse(acknowledged.dueAt), start + 3_000, "late intervals coalesce instead of emitting a burst");
  assert.notEqual(acknowledged.nextCheckId, claim.checkId);
});

test("claims deduplicate, survive reload, back off failed submission, and can be relinquished", (t) => {
  const storeDir = temporaryStore(t);
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  supervision.ensureProgressReview("run-claim", { storeDir, startedAt: start, cadenceMs: 100, now: start + 101 });
  const owner = supervision.createProgressReviewClaimantId();
  const other = supervision.createProgressReviewClaimantId();
  const claim = supervision.claimProgressReview("run-claim", { storeDir, claimantId: owner, now: start + 101, claimLeaseMs: 1_000 });
  assert.equal(claim.claimed, true);
  assert.equal(supervision.claimProgressReview("run-claim", { storeDir, claimantId: other, now: start + 102 }).claimed, false);
  assert.equal(supervision.progressReviewClaimIsOwned("run-claim", { storeDir, checkId: claim.checkId, claimantId: owner, now: start + 102 }), true);

  const deferred = supervision.deferProgressReview("run-claim", { storeDir, checkId: claim.checkId, claimantId: owner, now: start + 103, baseBackoffMs: 50 });
  assert.equal(deferred.deferred, true);
  assert.equal(supervision.claimProgressReview("run-claim", { storeDir, claimantId: other, now: start + 120 }).claimed, false);
  assert.equal(supervision.claimProgressReview("run-claim", { storeDir, claimantId: other, now: start + 153 }).claimed, true);
  assert.equal(supervision.relinquishProgressReviewClaims({ storeDir, claimantId: other, now: start + 154 }).relinquished, 1);
  assert.equal(supervision.claimProgressReview("run-claim", { storeDir, claimantId: owner, now: start + 155 }).claimed, true);
});

test("storage is bounded and malformed authoritative state fails closed", (t) => {
  const storeDir = temporaryStore(t);
  supervision.ensureProgressReview("bounded-one", { storeDir, startedAt: 1_000, cadenceMs: 100, now: 1_000, maxEntries: 1 });
  assert.throws(() => supervision.ensureProgressReview("bounded-two", { storeDir, startedAt: 1_000, cadenceMs: 100, now: 1_000, maxEntries: 1 }), /limit reached/i);
  const persisted = JSON.parse(readFileSync(supervision.progressReviewFile(storeDir), "utf8"));
  assert.equal(persisted.schema, supervision.PROGRESS_REVIEW_SCHEMA);
  assert.equal(persisted.records.length, 1);
  writeFileSync(supervision.progressReviewFile(storeDir), "{\"schema\":\"wrong\",\"records\":[]}");
  assert.throws(() => supervision.loadProgressReviewRecords({ storeDir }), /unsupported/i);
});

test("large Unicode batches retain every acknowledgement ID and the control instructions", () => {
  const items = Array.from({ length: 8 }, (_, index) => ({
    checkId: `check-${index}-${"c".repeat(192)}`,
    run: {
      runId: `run-${index}-${"r".repeat(506)}`,
      workflow: "界".repeat(200),
      phases: Array.from({ length: 3 }, () => ({ phase: "界".repeat(20_000), lastMessage: "界".repeat(1_000) })),
      artifacts: Array.from({ length: 3 }, () => ({ path: "/" + "界".repeat(1_000) })),
      runFile: "/" + "界".repeat(1_000),
    },
  }));
  const prompt = messages.formatProgressReviewPrompt(items);
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 12_000);
  assert.match(prompt, /progress review details truncated/);
  assert.match(prompt, /Do not automatically kill, retry, resume, launch successor work/);
  const branch = [{ type: "message", message: { role: "user", content: prompt } }];
  for (const { checkId } of items) assert.equal(messages.sessionHistoryHasProgressReview(branch, checkId), true);
  assert.ok(prompt.endsWith(messages.progressReviewMarker(items.map(({ run, checkId }) => ({ runId: run.runId, checkId })))));
  assert.throws(() => messages.progressReviewMarker([{ runId: "x".repeat(20_000), checkId: "check-one" }]), /valid checks/);
});

test("progress marker is distinct, branch-specific, bounded, and avoids automatic action language", () => {
  const run = {
    runId: "message-run",
    workflow: "message workflow",
    startedAt: "2026-01-01T00:00:00.000Z",
    phases: [{ phase: "worker", lastMessage: "tool arguments completed (not proof of progress)" }],
    artifacts: [{ path: "/repo/report.md" }],
    runFile: "/store/runs/message-run.jsonl",
  };
  const prompt = messages.formatProgressReviewPrompt([{ run, checkId: "check-one" }], Date.parse("2026-01-01T00:05:00.000Z"));
  assert.match(prompt, /progress review, not completion; the timer did not detect a stall/i);
  assert.match(prompt, /decide whether to wait, report, or intervene/i);
  assert.match(prompt, /Do not automatically kill, retry, resume, launch successor work/i);
  assert.match(prompt, /thread-phase-progress-review\/v1/);
  assert.ok(Buffer.byteLength(prompt) <= 12_000);
  const active = [{ type: "message", message: { role: "user", content: prompt } }];
  assert.equal(messages.sessionHistoryHasProgressReview(active, "check-one"), true);
  assert.equal(messages.sessionHistoryHasProgressReview([], "check-one"), false, "another branch does not acknowledge delivery");
});
