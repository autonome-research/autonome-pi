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

Latest failed run:

```text
mission-workflow-2026-06-04T02-14-04-825Z-f9bfa40e
```

Progress in that run:

- M0 validated successfully after earlier repairs.
- M1 original features were skipped as already merged.
- M1 repair commits landed on the mission branch:
  - `d410000` — `repair-M1-1-1`, risk-approved order boundary before broker adapters.
  - `0c81846` — `repair-M1-1-2`, coverage gap for `assertion-006`.
- M1 iteration 2 validation still had must objections for:
  - `assertion-003` — malformed LLM output auditability,
  - `assertion-009` — quant-feature reproducibility payload validation,
  - `assertion-006` — risk approval forgery concerns.
- The runner generated `repair-M1-2-1` and the worker changed:
  - `auto_trading/signals/llm.py`
  - `tests/test_llm_combiner.py`
- That repair was **not committed** because strict handoff validation failed.

Exact latest failure:

```text
Strict handoff validation failed for repair-M1-2-1:
Unknown assertion addressed: "assertion-003: malformed LLM endpoint responses now degrade to a neutral assessment while preserving the actual endpoint raw output and explicit failure metadata in parsed_output."
Unknown assertion addressed: "assertion-009: LLM invocation audit material now keeps the raw malformed output for ledger/reconstruction paths instead of replacing it with fallback JSON."
```

Interpretation: this is likely an extension strict-handoff normalization issue. The worker wrote verbose strings prefixed with valid assertion IDs. The normalizer should canonicalize `assertion-003: ...` to `assertion-003` and `assertion-009: ...` to `assertion-009`, provided those IDs exist in the validation contract and are assigned to the repair feature.

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

The working tree now contains the intended `v0.10.7` mission hardening:

- handoff assertion canonicalization accepts strings like `assertion-003: detailed explanation` when the leading ID exists in the validation contract, accepts verbose assigned local assertions like `Local assertion: <assigned check>. Verified...`, and accepts supplemental `local:*` worker test/evidence IDs without counting them as global contract coverage;
- resume no longer treats branch ancestry alone as proof of feature completion, so stale failed feature branches at the mission head are rerun;
- runner-owned commits now include `Mission-Feature-Id: <featureId>` and `Mission-Feature-Fingerprint: <fingerprint>` trailers;
- branch-only resume recognizes completed features only with stronger proof: merged, not at the base head, runner-owned commit subject plus matching `Mission-Feature-Id` and `Mission-Feature-Fingerprint` trailers; fingerprint schema `pi-mission-feature-fingerprint/v2` includes the milestone id, feature metadata, assigned assertion ids, local assertion ids, and assigned validation-contract assertion descriptions/priorities/methods/coverage refs; registry-backed legacy commit records may still use subject plus `Mission-Feature-Id` when no fingerprint was historically recorded, but still require current milestone/assignment metadata; valid completed no-change handoff artifacts remain trusted for legacy/no-change work; subject-only legacy skipped records are no longer trusted;
- failed worker diffs/status are preserved as artifacts before removing failed feature worktrees;
- hard failures/cancellations mark the durable registry `failed`/`cancelled` on a best-effort basis, without downgrading an already `completed` mission registry;
- smoke coverage was added for prefixed handoffs, stale branch rerun, completed-head skip with feature-id trailer, same-subject/no-trailer rerun, stale registry skipped/commit records, handoff-backed legacy skips, registry-failed marking, and completed-registry non-downgrade/immutability.

Before resuming auto_trading again:

1. run `node --check mission-workflow/bin/mission-workflow.mjs`,
2. run `PI_OFFLINE=1 pi --no-extensions -e . --list-models`,
3. run `npm test`,
4. code-review the working tree,
5. commit/release the package tag,
6. resume the approved auto_trading mission with the same plan path.
