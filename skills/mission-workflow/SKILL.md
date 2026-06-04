---
name: mission-workflow
description: Use when planning, approving, activating, debugging, or discussing Droid/Missions-style long-running Pi software missions with orchestrator planning, validation contracts, serial worker features, per-feature git worktrees/commits, command-based validators, and repair loops.
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
6. Validators run at milestone boundaries.
7. Failed validation creates repair features up to a capped iteration count.

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

Use `ctrl+shift+t` to monitor/cancel. Use `thread_phase_runs` to inspect artifacts. If an approved mission stopped unexpectedly, use `action: "resume"` with the same plan path and `approved: true`.

## Important rules

- Do not activate without explicit user approval of the plan.
- Once activated with `approved: true`, do not insert new human approval gates unless the mission fails or is cancelled.
- Workers are serial, not parallel.
- Read-only validators may fan out later, but the MVP is command-based.
- Final merge is manual by default; do not assume the mission branch is merged into the user's current branch.
- Default `maxRepairIterations` is 10; it is configurable.
- The runner emits heartbeat events. Stale runs can appear when the process is gone or heartbeats stop.

## Current MVP limitations

- User-testing is command-based only.
- Resume/reuse is MVP-level and skips already-merged planned feature branches; dynamic repair queue reconstruction should become smarter.
- Repair features are generic and should become smarter.
- Worktree cleanup is best-effort.
- Use small missions first while dogfooding.
