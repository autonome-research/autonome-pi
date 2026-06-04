# Mission workflow continuation notes

This is a private, machine-local handoff for continuing the `mission_workflow` extension work in a fresh Pi session. It intentionally contains local paths, run IDs, commit hashes, and dogfood state for `/home/velvet/auto_trading`.

## Required context to read first

- Droid/Missions reference context: `/home/velvet/droid_flows.md`
  - This is the conceptual source for the mission workflow design: plan first, approved autonomous activation, creator/verifier split, strict handoffs, validation contracts, repair loops, and auditable mission state.
- Package skill: `/home/velvet/.pi/agent/extensions/skills/mission-workflow/SKILL.md`
- Extension docs: `/home/velvet/.pi/agent/extensions/mission-workflow/README.md`
- Current implementation: `/home/velvet/.pi/agent/extensions/mission-workflow/bin/mission-workflow.mjs`

## Design rules to preserve

- Always run `mission_workflow({ action: "plan" })` first and require explicit user approval before activation.
- After `approved: true`, do not add human approval gates unless the mission fails or is cancelled.
- Workers run serially in isolated per-feature git worktrees.
- The runner owns commits and fast-forwards the mission integration branch.
- Validators are adversarial/fresh-context and may be read-only.
- Command validators and user-test command validators are not sufficient by themselves; adversarial validation must remain part of milestone validation.
- Strict handoffs are mandatory. Missing, malformed, mismatched, or non-canonical handoffs should fail loudly.
- Final merge remains manual.
- Resume must use durable state plus git ancestry and skip already-merged feature branches.
- Keep the generic thread-phase visualizer workflow-agnostic. Mission-specific behavior belongs in `mission-workflow`.

## Thread-phase dependency status

The global `@autonome-research/thread-phase-cli` was updated to `4.1.0` on 2026-06-04:

```text
thread-phase-cli 4.1.0
@autonome-research/thread-phase 4.1.0
@autonome-research/thread-phase-agents 4.1.0
```

The extension package dependency was updated to `@autonome-research/thread-phase@^4.1.0`.

Likely useful upstream fixes/improvements in 4.1.x:

- safer error-message coercion for non-string abort/error reasons,
- abortable sleep/retry helpers,
- improved cancellation propagation in fanout/parallel patterns,
- JobRunner cancellation/signaling improvements and docs.

These help lifecycle/cancellation/fanout patterns, but they do **not** automatically fix extension-level mission failures such as strict handoff normalization, validation contract mapping, git/worktree hygiene, or runner-owned commit policy.

## Current auto_trading dogfood state

Repository:

```text
/home/velvet/auto_trading
```

Plan path:

```text
/home/velvet/.pi/agent/thread-phase/artifacts/mission-plan-2026-06-03T22-44-42-534Z-a3835889/mission-plan.json
```

Important plan backups from assertion/local-assertion migration:

```text
mission-plan.json.pre-localAssertions-2026-06-04T01-51-59-195Z.bak
mission-plan.json.pre-contract-map-2026-06-04T02-12-00-305Z.bak
```

Mission branch/worktree:

```text
mission/trading-automation-system-v1
/home/velvet/.pi/agent/mission-workflow/worktrees/trading-automation-system-v1/integration
```

Current active run after `v0.11.0` release/resume:

```text
mission-workflow-2026-06-04T23-24-17-413Z-8284068a
pid: 1412093
current observed feature: M2-F3
```

As of the connection-loss check, the mission process and child Pi worker were still alive. The run had skipped/validated M0 and M1, committed/recognized M2-F1 and M2-F2, and was re-running stale/unverified branch `M2-F3` with active I/O/watchdog telemetry visible in the thread-phase log.

Most recent resolved failure before this run:

```text
mission-workflow-2026-06-04T20-23-17-231Z-5ebe2499
```

That run failed at `M2-F1` strict handoff validation because the worker-created `.mission/handoffs/M2-F1.json` was tracked from a stale branch and then removed by the runner, so git status only saw the handoff-file deletion while the handoff listed implementation files. `v0.10.9`/`v0.11.0` restored the handoff path after artifact extraction and hardened operation timeouts/watchdogs, allowing the later resume to pass M2-F1.

## Failure-mode handling rules

When a mission fails, do **not** blindly relaunch. First classify the failure:

1. **Runner/lifecycle failure**
   - Examples: stale/dead process, `Invalid string length`, unbounded stdout capture, parser errors, bad cancellation, invalid registry state.
   - Action: patch/release the extension, run smoke tests, then resume.

2. **Strict handoff failure**
   - Examples: missing handoff file, mismatched `featureId`, changedFiles mismatch, unknown assertion refs, generated junk.
   - Action: inspect `handoffs/<feature>-invalid.json` and the raw handoff artifact. If the worker output is semantically valid but formatting is too strict, patch normalization/tests. If worker output is actually invalid, resume so the repair worker reruns.

3. **Validation/implementation failure**
   - Examples: command validators fail, adversarial validator raises must objections, coverage gaps remain.
   - Action: inspect validation report, coverage report, and adversarial report. Let the mission create targeted repair features unless max repair iterations has been reached.

4. **Git/worktree failure**
   - Examples: stale worktree path, branch exists but not merged, failed ff-only merge, untracked generated junk.
   - Action: inspect `git worktree list`, `git status`, and branch ancestry. Remove only stale failed feature worktrees/branches when safe; preserve mission integration branch.

5. **Plan/contract quality failure**
   - Examples: feature assertions are prose not contract IDs, contract assertions have no `coveredBy`, local assertions accidentally satisfy final coverage.
   - Action: patch the plan with a backup, preserving both global `assertions` and milestone-local `localAssertions`. Do not erase original local acceptance checks.

## Immediate recommended next step

The working tree now contains the intended `v0.11.0` mission hardening:

- handoff assertion canonicalization accepts strings like `assertion-003: detailed explanation` when the leading ID exists in the validation contract, accepts verbose assigned local assertions like `Local assertion: <assigned check>. Verified...`, and accepts supplemental worker-only local evidence either as `local:*` IDs or `{ type: "local", id: "..." }` objects without counting it as global contract coverage;
- resume no longer treats branch ancestry alone as proof of feature completion, so stale failed feature branches at the mission head are rerun;
- runner-owned commits now include `Mission-Feature-Id: <featureId>` and `Mission-Feature-Fingerprint: <fingerprint>` trailers;
- branch-only resume recognizes completed features only with stronger proof: merged, not at the base head, runner-owned commit subject plus matching `Mission-Feature-Id` and `Mission-Feature-Fingerprint` trailers; fingerprint schema `pi-mission-feature-fingerprint/v2` includes the milestone id, feature metadata, assigned assertion ids, local assertion ids, and assigned validation-contract assertion descriptions/priorities/methods/coverage refs; registry-backed legacy commit records may still use subject plus `Mission-Feature-Id` when no fingerprint was historically recorded, but still require current milestone/assignment metadata; valid completed no-change handoff artifacts remain trusted for legacy/no-change work; subject-only legacy skipped records are no longer trusted;
- failed worker diffs/status are preserved as artifacts before removing failed feature worktrees;
- hard failures/cancellations mark the durable registry `failed`/`cancelled` on a best-effort basis, without downgrading an already `completed` mission registry;
- operation-level watchdog telemetry is emitted on heartbeats, including child PID, operation label, elapsed time, idle time, hard timeout, and idle timeout; stale operations emit `progress_watchdog` events; Pi calls have hard and idle-output timeouts; validation/user-test shell commands now have explicit timeouts instead of being able to hang indefinitely;
- workflow-agnostic active I/O snapshots are emitted via `active_io` phase events and projected as `run.activeIo`/`phase.activeIo`, so the monitor panel, tools, and debugging sessions can inspect current component status and byte counts without coupling mission-specific logic to the UI; active I/O is redacted/capped, can be disabled with `PI_THREAD_PHASE_ACTIVE_IO=0`, and raw-ish process/model previews are opt-in (`PI_THREAD_PHASE_ACTIVE_IO_PREVIEWS=1`, `PI_THREAD_PHASE_ACTIVE_IO_COMMANDS=1`, `PI_THREAD_PHASE_ACTIVE_IO_PROMPTS=1`);
- smoke coverage was added for prefixed handoffs, stale branch rerun, completed-head skip with feature-id trailer, same-subject/no-trailer rerun, stale registry skipped/commit records, handoff-backed legacy skips, registry-failed marking, command timeout handling, and completed-registry non-downgrade/immutability.

`v0.11.0` has been committed/tagged/pushed (`2f703f9 Add active workflow IO snapshots`) and the approved auto_trading mission has already been resumed. If the current run fails or is cancelled, inspect the run artifacts first and classify the failure before resuming again.
