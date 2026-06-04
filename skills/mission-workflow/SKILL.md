---
name: mission-workflow
description: Use when planning, approving, activating, debugging, or discussing Droid/Missions-style long-running Pi software missions with orchestrator planning, validation contracts, strict worker handoffs, per-feature git worktrees/commits, command/adversarial validators, durable registry/resume, coverage reports, and repair loops.
---

# Mission Workflow

Use this skill for the `mission_workflow` Pi extension.

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

Use `ctrl+shift+t` to monitor/cancel. Use `thread_phase_runs` to inspect artifacts. Durable mission state is under `~/.pi/agent/mission-workflow/registry/<missionId>/`. If an approved mission stopped unexpectedly, use `action: "resume"` with the same plan path and `approved: true`.

## Important rules

- Do not activate without explicit user approval of the plan.
- Once activated with `approved: true`, do not insert new human approval gates unless the mission fails or is cancelled.
- Workers are serial, not parallel.
- Missing/malformed worker handoffs are failures; do not claim success without a valid handoff artifact.
- Must-level adversarial validator objections and coverage gaps fail milestone validation.
- Final merge is manual by default; do not assume the mission branch is merged into the user's current branch.
- Default `maxRepairIterations` is 10; it is configurable.
- The runner emits heartbeat events. Stale runs can appear when the process is gone or heartbeats stop.

## Current limitations

- User-testing is command-based only.
- Dynamic repair queue reconstruction should become smarter.
- Browser/computer-use QA adapters are not implemented.
- Worktree cleanup is best-effort.
- Use small missions first while dogfooding.
