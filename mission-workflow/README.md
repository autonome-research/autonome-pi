# mission-workflow

Droid/Missions-style long-running software workflow extension for Pi.

Status: MVP prototype. It is intended for small, approved missions first.

## Concept

A mission has two stages:

1. **Plan**: an orchestrator creates a mission plan and validation contract. The user reviews and approves this once.
2. **Activate**: the mission executes without more approval until success, failure, or cancellation.

Execution uses thread-phase observability and the generic monitor (`ctrl+shift+t`).

## Tool

`mission_workflow`

Actions:

- `plan` — create `mission-plan.json`, `validation-contract.json`, and approval instructions.
- `activate` — execute an approved plan in the background or foreground.
- `resume` — resume an approved mission after an unexpected stop by reusing the mission branch/worktrees and skipping already-merged feature branches.
- `status` — show git worktree status from the repo.

## Example

```js
await mission_workflow({
  action: "plan",
  goal: "Add password reset emails and tests",
  cwd: "/path/to/repo",
  validationCommands: ["npm test"],
  userTestCommand: "npm run test:e2e",
  maxRepairIterations: 10
});
```

After reviewing the generated plan:

```js
await mission_workflow({
  action: "activate",
  planPath: "/path/to/mission-plan.json",
  approved: true,
  background: true
});
```

## Execution model

- Creates a mission integration branch: `mission/<missionId>`.
- Creates an integration worktree under `~/.pi/agent/mission-workflow/worktrees/<missionId>/integration`.
- Runs worker features serially in isolated per-feature worktrees.
- The runner commits each feature and fast-forwards the mission branch.
- Scrutiny validators run configured `validationCommands` after each milestone.
- User-testing validator starts as a configured command (`userTestCommand`).
- Failed validation enqueues repair features up to `maxRepairIterations` (default `10`).
- Heartbeat events record current milestone/feature/branch/worktree and child process ids for stale-run detection.
- Final merge into the user's target branch is manual by default.

## Safety model

- `activate` requires `approved: true`.
- The runner avoids changing the user's current checkout by using separate worktrees.
- Workers are asked not to commit; the deterministic runner owns commits.
- Monitor cancellation is cooperative through the thread-phase visualizer cancel file.

## Current limitations

- This MVP is intentionally simple and should be dogfooded on small missions first.
- Resume/reuse is MVP-level: it skips feature branches already merged into the mission branch, but does not yet reconstruct dynamic repair queues beyond rerunning milestone validation.
- Worktree cleanup is best-effort.
- Browser/computer-use QA is not implemented; user testing is command-based.
- Repair planning currently creates generic corrective features from failed validators.
- Final merge is manual.
