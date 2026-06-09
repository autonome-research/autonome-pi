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

Latest dogfood failure after `v0.11.0` release/resume:

```text
mission-workflow-2026-06-04T23-24-17-413Z-8284068a
failed at: M2-F4
```

The run skipped/validated M0 and M1, committed M2-F1/M2-F2/M2-F3, then failed strict handoff validation for M2-F4:

```text
handoff.changedFiles listed files not changed in git status/diff:
auto_trading/data/adapters.py, auto_trading/data/federation.py, tests/test_data_federation.py
```

Root cause: the mission branch already contained old/unverified legacy commits for future M2 features, including an older token-bucket implementation. Resume hardening stopped trusting branch ancestry, but workers still inherited the contaminated code in the integration branch. The M2-F4 worker found the feature already present and wrote a handoff claiming files it did not actually change. This is not caused by chat compaction; it is a mismatch between trusted resume bookkeeping and an untrusted legacy code state.

Reset for fresh dogfood:

- `/home/velvet/auto_trading` is back on `main` at baseline commit `66bd4fd` with only `specs.md` in the project tree.
- Removed stale mission worktrees under `~/.pi/agent/mission-workflow/worktrees/trading-automation-system-v1`.
- Removed stale durable registry `~/.pi/agent/mission-workflow/registry/trading-automation-system-v1`.
- Deleted stale branches `mission/trading-automation-system-v1` and `mission-feature/trading-automation-system-v1/*`.
- Fresh dogfood should generate a new plan/registry rather than resuming the old one.

Current unreleased fix after this diagnosis:

- new plans resolve `baseRef` to an immutable commit hash, and registry records `trustedBaseHead`, `trustedHead`, `trustedPlanFingerprint`, and `trustedCommits`;
- resume resets branch drift back to an existing trusted checkpoint after backing up the previous mission branch under `mission-backup/...`;
- if no trusted checkpoint exists and the branch contains untrusted commits while registry completion evidence exists, resume fails early with `state/contaminated-mission-branch.json` instead of letting workers inherit stale/unverified code;
- if no registry completion evidence exists, a contaminated branch can be backed up/reset to the base and rerun cleanly;
- worker prompts now explicitly instruct no-change completions to use `changedFiles: []` when the inherited trusted codebase already satisfies the feature.

## Why `uv.lock` kept causing failures

The repeated `uv.lock` failures were not one bug recurring unchanged; they were the same file crossing different trust boundaries in the mission state machine:

1. **Feature-worktree accidental transient (`v0.11.2`)**: a worker/validation command produced an untracked root `uv.lock` but did not change a dependency manifest. The runner treated omitted untracked files as real changed files and strict handoff failed. Fix: auto-clean omitted untracked root `uv.lock` only when no dependency manifest changed, with an audit artifact.
2. **Intentional lockfile after manifest changes (`v0.11.5`)**: once handoff metadata became runner-owned, dependency manifest changes plus `uv.lock` should be committed even if the worker did not list `uv.lock` perfectly. Fix: runner-derived changed files/coverage made intentional lockfile commits possible and kept lockfiles out of generic-junk cleanup.
3. **Integration-worktree transient blocking a later merge (`v0.11.8`)**: validation commands in the integration worktree created an untracked `uv.lock`; a later feature branch intentionally tracked `uv.lock` because it added dependencies. Git refused the ff-only merge because the untracked integration file would be overwritten. Fix: quarantine regular untracked integration `uv.lock` into artifacts with bytes/hash before merge, restore on merge failure, and refuse to read/delete symlinks/special/oversized files.

The durable lesson: lockfiles are neither always junk nor always sacred. They are stateful artifacts whose handling depends on **where** they appear (feature vs integration worktree), **why** they appear (manifest changed or not), and **which transition** is happening (handoff validation vs runner commit vs integration merge). Future lockfile fixes should start by identifying that transition instead of adding a blanket cleanup rule.

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
   - Examples: stale worktree path, branch exists but not merged, failed ff-only merge, transient lockfile conflicts, untracked generated junk, contaminated mission branch.
   - Action: inspect `git worktree list`, `git status`, branch ancestry, handoff cleanup/quarantine artifacts, and any `state/contaminated-mission-branch.json` artifact. If a trusted checkpoint exists, resume should back up/reset branch drift automatically. If no trusted checkpoint exists and registry evidence is mixed with untrusted commits, start a fresh mission/registry or restore a known-good checkpoint rather than continuing on the contaminated branch.

5. **Plan/contract quality failure**
   - Examples: feature assertions are prose not contract IDs, contract assertions have no `coveredBy`, local assertions accidentally satisfy final coverage.
   - Action: patch the plan with a backup, preserving both global `assertions` and milestone-local `localAssertions`. Do not erase original local acceptance checks.

## Immediate recommended next step

The working tree now contains the intended `v0.11.1` mission hardening:

- handoff assertion canonicalization accepts strings like `assertion-003: detailed explanation` when the leading ID exists in the validation contract, accepts verbose assigned local assertions like `Local assertion: <assigned check>. Verified...`, and accepts supplemental worker-only local evidence either as `local:*` IDs or `{ type: "local", id: "..." }` objects without counting it as global contract coverage;
- resume no longer treats branch ancestry alone as proof of feature completion, so stale failed feature branches at the mission head are rerun;
- runner-owned commits now include `Mission-Feature-Id: <featureId>` and `Mission-Feature-Fingerprint: <fingerprint>` trailers;
- branch-only resume recognizes completed features only with stronger proof: merged, not at the base head, runner-owned commit subject plus matching `Mission-Feature-Id` and `Mission-Feature-Fingerprint` trailers; fingerprint schema `pi-mission-feature-fingerprint/v2` includes the milestone id, feature metadata, assigned assertion ids, local assertion ids, and assigned validation-contract assertion descriptions/priorities/methods/coverage refs; registry/commit trust now requires feature-id and fingerprint trailers; verified trusted mission-branch commits can be reused as completion proof even if per-feature branches were pruned; trusted checkpoints are tied to a plan/contract/base fingerprint; valid no-change handoff artifacts are trusted only when they do not require inheriting an untrusted/contaminated mission branch;
- failed worker diffs/status are preserved as artifacts before removing failed feature worktrees;
- hard failures/cancellations mark the durable registry `failed`/`cancelled` on a best-effort basis, without downgrading an already `completed` mission registry;
- operation-level watchdog telemetry is emitted on heartbeats, including child PID, operation label, elapsed time, idle time, hard timeout, and idle timeout; stale operations emit `progress_watchdog` events; Pi calls have hard and idle-output timeouts; validation/user-test shell commands now have explicit timeouts instead of being able to hang indefinitely;
- workflow-agnostic active I/O snapshots are emitted via `active_io` phase events and projected as `run.activeIo`/`phase.activeIo`, so the monitor panel, tools, and debugging sessions can inspect current component status and byte counts without coupling mission-specific logic to the UI; active I/O is redacted/capped, can be disabled with `PI_THREAD_PHASE_ACTIVE_IO=0`, and raw-ish process/model previews are opt-in (`PI_THREAD_PHASE_ACTIVE_IO_PREVIEWS=1`, `PI_THREAD_PHASE_ACTIVE_IO_COMMANDS=1`, `PI_THREAD_PHASE_ACTIVE_IO_PROMPTS=1`);
- smoke coverage was added for prefixed handoffs, stale branch rerun, trusted-checkpoint reset after contamination, trusted mission-branch commit reuse without feature branches, completed-head skip with feature-id trailer, same-subject/no-trailer rerun, stale registry skipped/commit records, contaminated legacy registry branches, registry-failed marking, command timeout handling, and completed-registry non-downgrade/immutability.

`v0.11.8` was committed/tagged/pushed (`79a281b Harden mission transient lock merge cleanup`). The fresh auto_trading dogfood mission then resumed, passed all milestones, wrote final coverage with 30/30 assertions passing, and was manually fast-forward merged into `/home/velvet/auto_trading` `main` at `e3071c3`. The current working tree is preparing `v0.11.9` follow-up hardening: successful resume/completion clears stale registry `lastError` into `lastResolvedError`, and the generic visualizer deduplicates repeated artifact paths, closes phase-event-only phases when a workflow reaches terminal status, and keeps compact summaries focused on recent/active phases. Passed milestone validation reports are reusable only when their trusted head, validation config/model/runtime fingerprint, artifacts, and exact validated feature/repair/no-change evidence verify. Legacy or ambiguous cursors are intentionally revalidated. Do not resume obsolete pre-reset auto_trading runs; the fresh dogfood mission completed successfully.

## 2026-06-09 — Uncommitted mission-workflow foundation slice

This section is the current handoff for the next session. It supersedes the stale "Immediate recommended next step" wording above for the present working tree.

### Working tree state

Repository:

```text
/home/velvet/.pi/agent/extensions
```

Current branch:

```text
main
```

Current working tree is **modified and not committed**:

```text
 M mission-workflow/README.md
 M mission-workflow/bin/mission-workflow.mjs
 M mission-workflow/index.ts
 M scripts/smoke-test.mjs
```

Approximate diff size at handoff:

```text
mission-workflow/README.md                |  11 +-
mission-workflow/bin/mission-workflow.mjs | 554 +++++++++++++++++++++++++++---
mission-workflow/index.ts                 |   6 +-
scripts/smoke-test.mjs                    | 212 +++++++++++-
```

Do **not** assume these changes are committed, tagged, or pushed.

### How this slice started

A dynamic workflow was launched to implement the first safe foundation slice from `docs/mission-workflow-completeness-roadmap.md`:

```text
workflow: mission-design-foundation-implementation
run: mission-design-foundation-implementation-2026-06-09T01-36-04-308Z-a0a2453f
cwd: /home/velvet/.pi/agent/extensions
status: success
```

Important artifacts:

```text
/home/velvet/.pi/agent/thread-phase/artifacts/mission-design-foundation-implementation-2026-06-09T01-36-04-308Z-a0a2453f/implement-foundation-slice.md
/home/velvet/.pi/agent/thread-phase/artifacts/mission-design-foundation-implementation-2026-06-09T01-36-04-308Z-a0a2453f/validation-output.md
/home/velvet/.pi/agent/thread-phase/artifacts/mission-design-foundation-implementation-2026-06-09T01-36-04-308Z-a0a2453f/mission-design-foundation-workflow-review.md
```

The first post-workflow review found a must-fix: higher completion targets could be over-reported because required skipped categories did not block the target. Multiple follow-up patches were applied manually in chat.

### Current implemented behavior in the uncommitted slice

Primary file changed:

```text
mission-workflow/bin/mission-workflow.mjs
```

Implemented foundations:

- Additive constants and normalizers for:
  - completion levels/targets;
  - validation categories/scopes/skip policies;
  - behavior adapters;
  - failure taxonomy;
  - role policy;
  - capability policy;
  - prompt policy;
  - planning clarification artifact detection.
- Default `completionTarget` remains `contract_validated`.
- `completionTarget=code_complete` is currently **rejected for activation** rather than partially implemented.
- Unknown completion targets and unknown `requiredFor` levels are rejected for activation instead of silently downgrading.
- Unknown validation category enum values, scope enum values, adapter enum values, skip policies, duplicate explicit validation category IDs, and invalid `timeoutMs` values are rejected.
- Existing `validationCommands` and `userTestCommand` are normalized into category records, but legacy behavior is preserved.
- Generated legacy category IDs are protected against plan-category shadowing and repeated normalization duplicate accumulation.
- Planner output with explicit `validationCommands: []` no longer inherits fallback CLI validation categories.
- Planning clarification artifacts (`pi-mission-workflow/planning-clarification/v1`) are written and activation is rejected for them.
- Registry defaults now include additive completion/category/role/prompt/failure/DX placeholders.
- `status` can inspect registry state by `--plan-path` or `--mission-id`.
- `mission-workflow/index.ts` exposes/passes `missionId` for status and `completionTarget` for planning.
- Handoff skeleton was extended additively with v3-style optional arrays:
  - `architecturalDecisions`
  - `assumptions`
  - `externalServiceAssumptions`
  - `operatorSteps`
  - `testsAdded`
  - `risksNotAddressed`
  - `broadcastNotes`
- Validation reports include category results and blocking category results.
- Required non-executed categories block the requested completion target.
- Required operational/deployment targets require implemented categories for the exact requested level; e.g. `deployment_ready` cannot be achieved with only an `operationally_ready` health check.
- Out-of-target/optional validation categories do not block `contract_validated` and their commands are not executed.
- Required deployment categories require `capabilityPolicy.deployment=true`; otherwise activation fails.
- Required unsupported adversarial categories (domain/ops critic placeholders) are rejected until real execution exists.
- Required unsupported non-command adapters are rejected until implemented.
- `skipPolicy=explicit_skip_allowed` is reserved but rejected for required categories until real skip evidence/artifacts are implemented.
- Required command categories with no `commands` are rejected before workers run.
- Required credential-gated categories are rejected at activation if their env vars are missing; command execution also records `credential_missing` if reached.
- `artifactsRequired` is enforced after category command execution relative to the integration worktree.
- Validation cursor fingerprints now include broader normalized category execution fields and capability policy.
- Trusted resume skipped milestones preserve `categoryResults` and `blockingCategoryResults` from the trusted report.
- Final achieved level is computed from satisfied category results rather than always equaling the requested target.

### Current tests

After the latest manual patch, this command passed:

```bash
cd /home/velvet/.pi/agent/extensions
npm test
```

Latest observed result:

```text
All smoke tests passed.
```

New/updated smoke coverage includes:

- default completion target normalization;
- legacy validation command/user-test mapping;
- planner output overriding CLI validation command fallback;
- registry additive defaults;
- status by mission id;
- required operational category skipped -> blocks;
- explicit operational category command -> achieves `operationally_ready`;
- missing `artifactsRequired` -> blocks;
- missing `credentialGates` -> blocks;
- optional/out-of-target failing category -> does not block contract target;
- out-of-target deployment command is not executed;
- deployment target without deployment category -> rejected;
- invalid completion target spelling -> rejected;
- `code_complete` target -> rejected;
- unknown validation category enum -> rejected;
- unknown skip policy -> rejected;
- explicit validation category ID collision cannot shadow explicit validation commands;
- duplicate explicit validation category IDs -> rejected;
- explicit skip without validated skip artifact -> blocks/rejects;
- unsupported required adversarial category -> rejected.

### Code review state

Several working-tree code reviews were run during repair. Earlier reports found real bugs and were addressed.

Important reports:

```text
/home/velvet/.pi/agent/extensions/.git/pi-code-reviews/2026-06-09T01-58-29-718Z-working_tree.md
/home/velvet/.pi/agent/extensions/.git/pi-code-reviews/2026-06-09T02-03-42-186Z-working_tree.md
/home/velvet/.pi/agent/extensions/.git/pi-code-reviews/2026-06-09T02-08-05-233Z-working_tree.md
/home/velvet/.pi/agent/extensions/.git/pi-code-reviews/2026-06-09T02-12-44-415Z-working_tree.md
/home/velvet/.pi/agent/extensions/.git/pi-code-reviews/2026-06-09T02-18-01-880Z-working_tree.md
/home/velvet/.pi/agent/extensions/.git/pi-code-reviews/2026-06-09T02-21-51-907Z-working_tree.md
/home/velvet/.pi/agent/extensions/.git/pi-code-reviews/2026-06-09T02-26-56-045Z-working_tree.md
/home/velvet/.pi/agent/extensions/.git/pi-code-reviews/2026-06-09T02-31-48-746Z-working_tree.md
/home/velvet/.pi/agent/extensions/.git/pi-code-reviews/2026-06-09T02-36-27-885Z-working_tree.md
/home/velvet/.pi/agent/extensions/.git/pi-code-reviews/2026-06-09T02-41-45-595Z-working_tree.md
/home/velvet/.pi/agent/extensions/.git/pi-code-reviews/2026-06-09T02-48-04-936Z-working_tree.md
/home/velvet/.pi/agent/extensions/.git/pi-code-reviews/2026-06-09T02-54-30-656Z-working_tree.md
```

The last completed review (`2026-06-09T02-54-30-656Z-working_tree.md`) raised two issues:

1. `explicit_skip_allowed` was accepted but not implemented.
2. Known non-repairable category failures could enter the normal repair loop.

Follow-up patch after that review:

- required `explicit_skip_allowed` categories now fail activation because the policy is reserved but not implemented;
- required commandless categories now fail activation;
- required credential gates now fail activation when env vars are absent;
- unknown skip policies are rejected;
- tests were added and `npm test` passed.

A final code review was started after these patches but was cancelled by the user:

```text
run: code-review-2026-06-09T02-55-33-347Z-53da6c7a
status: cancelled during review phase
```

Therefore the latest patch has **not** received a completed code-review verdict. The next session should run another working-tree code review before committing.

### Recommended next steps

1. Inspect the current diff:

   ```bash
   cd /home/velvet/.pi/agent/extensions
   git diff --stat
   git diff -- mission-workflow/bin/mission-workflow.mjs mission-workflow/index.ts scripts/smoke-test.mjs mission-workflow/README.md
   ```

2. Run validation:

   ```bash
   npm test
   ```

3. Run a final working-tree code review:

   ```text
   code_review_workflow({ cwd: "/home/velvet/.pi/agent/extensions", mode: "working_tree" })
   ```

4. If review is clean/acceptable, commit but **do not tag/publish unless explicitly requested**. Suggested commit subject:

   ```text
   Add mission completion category foundations
   ```

5. After commit, consider a follow-up implementation mission for the next roadmap layer rather than expanding this patch further. Good next slices:

   - real category-aware execution helpers (`normalizeValidationCategories`, `runValidationCategory`, credential-gated skip artifacts);
   - strategic repair planner;
   - generated mission skills/shared mission notes;
   - metrics/analytics artifact;
   - richer status/resume-explain.

### Cautions for next session

- Do not claim this is released. Package version is still `0.11.9` and the working tree is uncommitted.
- Do not reintroduce workflow-specific visualizer logic; this slice stays inside `mission-workflow` plus smoke tests/docs.
- Be careful with completion semantics: `contract_validated` is the compatibility default. Higher targets must not be marked achieved unless their exact required categories pass.
- `explicit_skip_allowed` is intentionally rejected for required categories until real skip evidence/artifact semantics exist.
- Required categories with missing credentials, missing commands, unsupported adapters, unsupported adversarial roles, unsupported scopes, or missing artifacts should fail early or block clearly; they should not be silently treated as success.

## 2026-06-09 — Foundation slice committed and extended

The previously uncommitted foundation work has now been validated and committed in logical local commits. These commits are **not tagged or pushed** unless a later session does so explicitly.

Latest local commits:

```text
fbc43dc Generate validation categories from mission deliverables
a7d3bc3 Refine mission validation category reporting
fe7d114 Update mission workflow continuation handoff
0b76caf Add mission completion category foundations
```

Validation performed after the committed slices:

```bash
cd /home/velvet/.pi/agent/extensions
npm test
```

Latest result observed after `fbc43dc`:

```text
All smoke tests passed.
```

Latest completed working-tree code review after `fbc43dc`:

```text
/home/velvet/.pi/agent/extensions/.git/pi-code-reviews/2026-06-09T03-29-40-515Z-working_tree.md
verdict: ✅ low risk
```

### Additional behavior added after the first foundation commit

Commit `a7d3bc3`:

- reports out-of-target validation categories as `not_applicable` instead of confusing skipped failures;
- adds a successful `deployment_ready` smoke case with explicit operational and deployment categories plus `capabilityPolicy.deployment=true`;
- documents the full `validationCategories` schema in `mission-workflow/README.md`.

Commit `fbc43dc`:

- generates validation categories from `externalServices[]`:
  - `healthCommand` -> `operational` category `external-<id>-health`;
  - `smokeCommand` -> `integration` category `external-<id>-smoke`;
  - `credentialEnv` -> generated category `credentialGates`.
- generates validation categories from `deliverables`:
  - `entrypoints[].validationCommand` -> executable category;
  - `runtimeArtifacts[].path` and `runbooks[].path` -> artifact-required categories.
- defaults empty/missing deliverable `requiredFor` to `operationally_ready` rather than accidentally falling back to `contract_validated`.
- marks generated categories with `generatedFrom` so re-normalization regenerates them from source fields instead of treating them as user-authored explicit categories.
- rejects explicit `validationCategories[].id` collisions with generated external-service/deliverable category IDs.
- keeps safeName-colliding generated categories distinct via unique suffixes, so required generated checks are not silently dropped.
- adds smoke coverage for missing/present deliverables, external-service derived categories, empty `requiredFor`, safeName collisions, explicit-generated ID collision rejection, deployment-ready success, and out-of-target `not_applicable` reports.

### Current remaining roadmap themes

The extension is still not "complete" against the full Factory/Droid-style roadmap. Good next implementation slices:

1. Strategic repair planner: classify/cluster validator failures before generating repair features.
2. Explicit skip evidence for `skipPolicy=explicit_skip_allowed` with durable skip artifacts.
3. Per-feature read-only review validators and optional domain/ops critic routes.
4. Behavioral adapter implementations beyond command adapters (`http_flow`, service lifecycle, workflow replay, browser/computer-use when available).
5. Status/resume explain mode with normalized registry integrity checks and clearer operator diagnostics.
6. Metrics/analytics artifacts for model roles, token/budget usage, repairs, validators, and category outcomes.
7. Generated mission skills/shared mission notes for agent-X continuity across long missions.
