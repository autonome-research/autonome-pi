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
6. Command validators and a fresh read-only adversarial Pi validator run at milestone boundaries.
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
- Must-level adversarial validator objections and coverage gaps fail milestone validation.
- Final merge is manual by default; do not assume the mission branch is merged into the user's current branch.
- Default `maxRepairIterations` is 10; it is configurable.
- The runner emits heartbeat, operation watchdog, and active I/O snapshot events. Stale runs can appear when the process is gone, heartbeats stop, or heartbeats continue without non-heartbeat operation progress.
- On failure, classify the failure before relaunching: runner/lifecycle, strict handoff, validation/implementation, git/worktree, or plan/contract quality.
- Strict handoff failures should be inspected via both the raw handoff artifact and the `*-invalid.json` artifact. Patch normalization only when the worker output is semantically valid but formatted differently than expected.
- If a run emits `state/contaminated-mission-branch.json`, do not blindly resume. The mission branch contains untrusted code relative to the durable checkpoint/registry/plan fingerprint. Either release a runner fix, restore the matching plan/checkpoint, or start a clean mission/registry.
- Handoff `assertionsAddressed` must cover assigned contract/local assertions. Supplemental worker-only local evidence is allowed as `local:<slug>` or `{ type: "local", id: "..." }`, but it must not be counted as global contract coverage. Handoff `changedFiles` must match actual git changes; no-change completions must use `changedFiles: []`. Lockfiles are not generic junk; the runner only auto-cleans an omitted untracked root `uv.lock` when no dependency manifest changed, and emits an audit artifact.

## Current limitations

- User-testing is command-based only.
- Dynamic repair queue reconstruction should become smarter.
- Browser/computer-use QA adapters are not implemented.
- Worktree cleanup is best-effort.
- Use small missions first while dogfooding.
