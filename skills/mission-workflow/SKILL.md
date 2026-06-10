---
name: mission-workflow
description: Use when planning, approving, activating, debugging, or discussing Droid/Missions-style long-running Pi software missions with orchestrator planning, validation contracts, strict worker handoffs, per-feature git worktrees/commits, command/adversarial validators, durable registry/resume, coverage reports, and repair loops.
---

# Mission Workflow

Use this skill for the `mission_workflow` Pi extension.

Before changing implementation, read the Droid/Missions design context at `/home/velvet/droid_flows.md` (private machine-local context), then read the package-relative continuation notes at `../../docs/mission-workflow-continuation.md` for current dogfood state and failure-mode guidance.

## Mental model

A mission is a long-running software-delivery workflow inspired by Droid/Factory Missions:

1. An orchestrator creates a plan and validation contract before coding.
2. The user approves that plan once.
3. Activated execution runs without more approval until success, failure, or cancellation.
4. Workers implement features serially in isolated git worktrees.
5. The runner commits each feature and advances a mission integration branch.
6. Command validators, per-feature read-only review validators (default-on; disable with `capabilityPolicy.featureReviewValidators=false`), and a fresh read-only adversarial Pi validator run at milestone boundaries. Adversarial validators must return explicit per-assertion `assertionResults`; omitted results count as unverified and block.
7. Assertion coverage artifacts map requirements to features, commits, validators, and status.
8. Must-level objections or coverage gaps create targeted repair features up to a capped iteration count.

## Tool usage

Always plan first:

```js
await mission_workflow({
  action: "plan",
  goal: "Implement the requested mission",
  cwd: "/path/to/repo",
  validationCommands: ["npm test"],
  userTestCommand: "npm run test:e2e",
  maxRepairIterations: 10
});
```

After the user reviews and approves the generated plan:

```js
await mission_workflow({
  action: "activate",
  planPath: "/path/to/mission-plan.json",
  approved: true,
  background: true
});
```

Use `ctrl+shift+t` to monitor/cancel. Use `thread_phase_runs` to inspect artifacts. Durable mission state is under `~/.pi/agent/mission-workflow/registry/<missionId>/` and includes trusted resume checkpoints. If an approved mission stopped unexpectedly, use `action: "resume"` with the same plan path and `approved: true` only after classifying any failure artifacts.

## Important rules

- Do not activate without explicit user approval of the plan.
- Once activated with `approved: true`, do not insert new human approval gates unless the mission fails or is cancelled.
- Workers are serial, not parallel.
- Missing/malformed worker handoffs are failures; do not claim success without a valid handoff artifact.
- Must-level adversarial validator objections, must-level per-feature review findings, and coverage gaps fail milestone validation.
- Role prompts are versioned template files under `mission-workflow/prompts/` selected by `promptPolicy` versions; plans may carry orchestrator-authored `workerProcedures` text that every worker must follow and report compliance on in `notesForValidator`.
- Final merge is manual by default; do not assume the mission branch is merged into the user's current branch.
- Default `maxRepairIterations` is 10; it is configurable.
- The runner emits heartbeat, operation watchdog, and active I/O snapshot events. Stale runs can appear when the process is gone, heartbeats stop, or heartbeats continue without non-heartbeat operation progress. Passed milestone validation reports are resume cursors only when their trusted head, validation fingerprint, artifacts, and exact validated feature evidence verify. Legacy/ambiguous cursors should be revalidated instead of trusted. Cancellation during validation should abort without generating failed validation reports or repair features from the cancel reason.
- On failure, classify the failure before relaunching: runner/lifecycle, strict handoff, validation/implementation, git/worktree, or plan/contract quality.
- Strict handoff failures should be inspected via both the raw handoff artifact and the `*-invalid.json` artifact. Patch normalization only when the worker output is semantically valid but formatted differently than expected.
- If a run emits `state/contaminated-mission-branch.json`, do not blindly resume. The mission branch contains untrusted code relative to the durable checkpoint/registry/plan fingerprint. Either release a runner fix, restore the matching plan/checkpoint, or start a clean mission/registry.
- Handoffs are runner-owned for metadata: the worker supplies completion/outcome/evidence/commands/issues/left-undone/notes, while the runner derives actual changed files from git and attaches evidence to assigned contract/local assertions. Exact worker `assertionsAddressed` tags and `changedFiles` lists are non-authoritative compatibility fields; extra assertion mentions are supplemental and do not count as coverage. The runner pre-creates a handoff skeleton with the exact feature id and accepts only narrow safeName-equivalent feature-id canonicalization for harmless punctuation drift. Lockfiles are not generic junk: an omitted untracked root `uv.lock` in a feature worktree may be auto-cleaned only when no dependency manifest changed; a `uv.lock` accompanying dependency manifest changes must be committed; and an untracked integration-worktree `uv.lock` that would block merging a tracked `uv.lock` is quarantined with artifact backup/hash rather than blindly deleted. Dynamic repair ids are short/content-addressed; if a resumed validator returns a different repair queue, prior completed repair records must not be overwritten or rerun under a colliding sequential id.

## Current limitations

- User-testing is command-based only.
- Dynamic repair queue reconstruction should become smarter.
- Browser/computer-use QA adapters are not implemented.
- Worktree cleanup is best-effort.
- Use small missions first while dogfooding.
