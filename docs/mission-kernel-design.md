# Mission kernel design: inverting the architecture around deterministic enforcement

Status: design source of truth as of 2026-06-10. This document supersedes the ordering of phases 4–8 in `mission-workflow-refactor-roadmap.md`. The refactor goal is no longer "type the monolith in place"; it is "extract a deterministic kernel and move strategy up to models, prompts, and skills."

## Motivation

`/home/velvet/droid_flows.md` (Factory Missions): "almost all of the orchestration logic is defined in prompts and skills instead of a hard-coded state machine… the only deterministic logic is very thin and focused on enabling models to do what they do best while the system handles the bookkeeping."

The current `bin/mission-workflow.mjs` inverts this: strategy (repair decisions, validation orchestration, scheduling) is hard-coded JS, while the genuinely valuable deterministic parts (trust model, git hygiene, handoff verification, coverage accounting) are interleaved with it. The target architecture keeps every dogfood-proven invariant deterministic and relocates decision authority to a model-driven orchestrator whose decisions the kernel validates, executes, and records.

Already completed toward this design (2026-06-10 slice):

- Role prompts externalized to `mission-workflow/prompts/<version>.md`, resolved via `promptPolicy` versions with `{{placeholder}}` rendering. Prompt content changes no longer require runner releases.
- Plans may carry orchestrator-authored `workerProcedures` injected into worker prompts (cursor-fingerprinted, not plan-fingerprinted).
- Adversarial validators can no longer rubber-stamp: a missing `assertionResults` array marks scoped assertions unverified and fails coverage.
- Per-feature read-only review validators are default-on (`capabilityPolicy.featureReviewValidators=false` to opt out).

## The partition

Every piece of the monolith belongs to exactly one bucket:

1. **Kernel (deterministic, enforcing, ~60%)** — invariants a model must never be able to bypass. Lives in code, never in prompts.
2. **Orchestration (model-driven strategy, ~25%)** — decomposition, repair vs. rescope decisions, validation emphasis, scheduling within policy. Lives in prompts/skills; kernel validates and executes the decisions.
3. **Prompt content (~15%)** — externalized template files (done).

### Invariants that must never move to models

- Activation requires explicit user approval; no new approval gates after activation.
- Workers do not commit; the runner owns commits, trailers, fingerprints, and changed-file derivation.
- Strict handoff validation; runner-derived metadata is authoritative over worker claims.
- Required validation categories cannot be skipped, reordered out of existence, or marked passed by any agent.
- Adversarial validation per milestone with per-assertion evidence.
- Repair iteration caps.
- Trusted checkpoint/cursor semantics, contaminated-branch detection, immutable base commits.
- Capability policy (no destructive/live external actions, credential gates, deployment gating).
- Final merge remains manual.

## Kernel verb API

Module format: plain `.mjs` modules with adjacent `.d.ts` declarations under `mission-workflow/src/kernel/`, following the `thread-phase-visualizer/lib/store.mjs` + `store.d.ts` precedent. Rationale: `bin/mission-workflow.mjs` runs under plain `node`, which cannot import `.ts` modules (the smoke suite already guards for this). Existing typed `src/**/*.ts` helpers remain the reference implementations for Pi-loaded code and their semantics are ported into kernel `.mjs` modules as call sites switch; once a kernel module owns a behavior, the duplicated monolith code is deleted in the same slice.

Verbs (signatures abbreviated; every verb returns structured results and writes artifacts through the existing thread-phase store):

```text
kernel/plan.mjs
  loadPlan(planPath) -> NormalizedPlan
  validateForActivation(plan) -> NormalizedPlan        // throws on policy violations
  missionPlanFingerprint(plan, baseHead) -> string
  featureFingerprint(plan, milestone, feature, id) -> string

kernel/worktrees.mjs
  ensureMissionWorktrees(plan, opts) -> MissionEnv
  createFeatureWorktree(env, featureId) -> path
  removeFeatureWorktree(env, featureId, { preserveDiagnostics }) -> void

kernel/commits.mjs
  commitFeature(env, feature, handoff) -> { commit }   // junk protection, trailers, lockfile transitions
  ffMergeFeature(env, featureBranch) -> void           // transient-artifact quarantine/restore

kernel/handoff.mjs
  writeHandoffSkeleton(featurePath, featureId, schema) -> path
  readValidatedHandoff(featurePath, feature, plan) -> { handoff, changedFiles, supplementalNotes } // throws strict errors

kernel/validation.mjs
  runValidationCategories(env, plan, milestone, iterationState) -> CategoryResults  // credential gates, skips, artifacts
  runFeatureReviews(env, plan, milestone, iterationState) -> FeatureReview[]
  runAdversarialValidator(env, plan, milestone, ...) -> ValidatorReport             // unknown-on-omission semantics
  buildCoverageReport(...) -> Coverage

kernel/registry.mjs
  readState(missionId) -> RegistryState
  recordFeature / recordValidation / recordRepairPlan / recordDecision(...)
  markTerminal(missionId, status, error) -> void

kernel/trust.mjs
  enforceTrustedMissionBranch(plan, env, opts) -> void
  latestTrustedPassedValidationCursor(plan, env, milestone) -> Cursor | undefined
  recordCheckpoint(plan, env) -> void

kernel/agents.mjs
  runRoleAgent({ role, promptVersion, vars, tools, model, cwd }) -> AgentResult
  // enforces per-role tool allowlists (validators/planners read-only), timeouts, idle watchdogs, usage events
```

## Orchestrator decision schema

At each milestone boundary (and on validation failure) the runner asks the orchestrator role for a decision instead of hard-coding `queue = repairPlan.repairs`:

```json
{
  "schema": "pi-mission-workflow/decision/v1",
  "missionId": "...",
  "milestoneId": "...",
  "iteration": 2,
  "decision": "create_repairs | rerun_worker | split_milestone | amend_plan | escalate_failure | proceed",
  "rationale": "...",
  "repairs": [{ "title": "...", "description": "...", "assertions": ["..."] }],
  "amendment": { "see": "plan amendment schema below" },
  "evidence": ["artifact paths the decision is based on"]
}
```

Kernel enforcement of decisions:

- Unknown `decision` values, malformed JSON, or out-of-policy decisions fall back to the current deterministic repair clustering (the proven `strategicRepairPlanner` pattern, which this generalizes and replaces).
- `proceed` is only legal when the kernel itself computed `validation.passed === true`; the orchestrator can never assert passing.
- `create_repairs` / `rerun_worker` consume repair iterations exactly as today; caps are kernel-owned.
- `split_milestone` and `amend_plan` are plan amendments and must satisfy the lineage rules below.
- `escalate_failure` terminates the mission with a structured artifact (replaces silently burning iterations on a hopeless milestone).
- Every decision is recorded in the registry (`decisionHistory[]`) and as a run artifact — the audit trail gains the "why", not just the "what".

Rollout flag: `capabilityPolicy.missionOrchestrator` (default `false` until dogfooded; flips default after a clean dogfood mission, as `featureReviewValidators` did).

## Amendment-aware trust lineage

The current trust model intentionally treats any `trustedPlanFingerprint` mismatch as contamination, which makes mid-mission rescoping impossible. Amendments make lineage explicit instead of weakening trust:

```json
{
  "schema": "pi-mission-workflow/plan-amendment/v1",
  "missionId": "...",
  "parentPlanFingerprint": "abc...",
  "newPlanFingerprint": "def...",
  "reason": "...",
  "changedMilestones": ["m3"],
  "changedFeatures": ["m3-f2"],
  "addedAssertions": ["assertion-031"],
  "removedAssertions": [],
  "authoredBy": "orchestrator-decision artifact path",
  "createdAt": "..."
}
```

Rules:

- Registry gains `planLineage: [fingerprint, ...]` (ordered, rooted at the activation fingerprint). A checkpoint or branch state is trusted iff its plan fingerprint is **in the lineage**, not merely equal to the current fingerprint.
- Per-feature trust is unchanged: a completed feature carries over across an amendment iff its `featureFingerprint` is identical in the amended plan. Changed features rerun. This is already how `recordMatchesCurrentFeature` works — lineage extends it across plan versions.
- Validation cursors for milestones containing changed features invalidate naturally (the cursor fingerprint hashes milestone features and contract assertions).
- Amendments are only legal at milestone boundaries, may never change `baseHead`, may never remove a must-priority assertion that a completed feature already covers without replacing its coverage, and may never rewrite runner-owned commits.
- Contaminated-branch detection changes exactly one predicate: `fingerprint ∉ lineage` instead of `fingerprint !== trusted`.
- The plan file on disk is never mutated; each amendment writes `mission-plan.v<N>.json` next to the registry copy, and the registry points at the active version.

## Target runner loop

```text
for each milestone:
  cursor = kernel.trust.latestTrustedPassedValidationCursor(...)   # unchanged
  if cursor: skip
  loop (kernel-capped):
    for each queued feature: kernel worker execution (unchanged)
    validation = kernel.validation.run(...)                        # unchanged, deterministic
    decision  = orchestrator(state, validation, prompts)           # model-driven, NEW
    kernel.enforce(decision)                                       # schema + policy + lineage gate
    kernel.registry.recordDecision(decision)
    apply: proceed | repairs | rerun | amendment | escalate
```

Wall-clock optimization in the same slice: `runFeatureReviews` fans out read-only reviewers concurrently (thread-phase 4.1 fanout primitives); everything that writes stays serial.

## Migration plan (replaces refactor roadmap phases 4–8)

Each slice follows the existing validation protocol (`pi --no-extensions -e . --list-models`, `npm test`, working-tree review, dogfood mission for behavior-affecting slices).

- **M1 — Kernel extraction, behavior-stable.** Move worktrees/commits/handoff/validation/trust/registry verbs into `src/kernel/*.mjs` (+`.d.ts`), wire `bin/mission-workflow.mjs` call sites to them, delete the duplicated monolith code per slice. No semantic changes; smoke suite is the harness.
- **M2 — Decision point.** Implement `decision/v1` + `kernel.enforce` behind `capabilityPolicy.missionOrchestrator=true` with deterministic fallback. Absorbs/replaces `strategicRepairPlanner`. Orchestrator prompt ships as `prompts/mission-orchestrator-v1.md`.
- **M3 — Amendment lineage.** `planLineage`, amendment artifacts, lineage-aware trust predicates, `split_milestone`/`amend_plan` execution. Smoke coverage: amendment carries trusted unchanged features, reruns changed ones, rejects base/assertion-coverage violations.
- **M4 — Behavior adapters.** `http_flow` first as a kernel validation verb (request/response flow specs in validation categories), then `service_lifecycle`. `browser_computer_use` stays reserved until an adapter host exists.
- **M5 — Budget + decision surfacing.** Token/usage budgets per mission with kernel-enforced stop, decision log and burn-rate in the generic monitor projections (no mission-specific UI in the visualizer).

## Non-goals

- No ground-up rewrite; kernel code moves, it is not reauthored.
- No parallel workers; serial features with read-only internal fanout only.
- No weakening of any invariant listed above to make orchestration easier.

## 2026-06-11 — Live user-testing validator (liveness gap closed)

Implemented the live user-testing validator — Factory's "user testing validator" in command form, and the fix for the gap exposed by the auto_trading LLM-tier bug (a subsystem that degraded to a safe no-op while exiting 0 passed every mocked test and the mission's own validators).

- Validation categories gained `expectation` (one-line behavioral expectation) and `successCriteria` ({mustMatch, mustNotMatch} regexes). `successCriteria` is a deterministic gate over the command's REAL combined output, pushed as a report line so existing category gating/repair machinery applies unchanged. `expectation` drives a fresh `user-testing-judge` agent (prompt `mission-user-testing-validator/v1`) that reads the live output and decides whether the primary path fired or the software degraded; its verdict is also pushed as a report line.
- Live by definition: the agent only judges categories that executed live this milestone (`liveOutputByCategory`), never mock-passes, and relies on the deterministic criterion in mock-planner/offline test mode. Credential-gated + unreachable → honest skip evidence via existing machinery, never a pass. Failures are classed `behavior_liveness_gap`.
- Capability-gated `capabilityPolicy.userTestingValidator` (default true; only activates per-category when `expectation`/`successCriteria` are declared). `expectation`+`successCriteria` are hashed into the validation-cursor fingerprint. Typed mirrors updated (constants/types/categories/cursor-fingerprints). Planner prompt instructs declaring liveness for degrade-to-safe subsystems.
- Smoke acceptance (deterministic, fake-pi): exit-0-but-degraded output fails `successCriteria` and blocks; healthy output passes; fresh agent rejects degraded live behavior and blocks; fresh agent accepts genuine behavior and passes.

Maps onto the kernel design: `successCriteria` extends `kernel/validation.mjs`; the user-testing judge is a new role through `kernel/agents.mjs`. Supersedes the earlier roadmap note that behavior validators need a liveness assertion — that assertion now exists.
