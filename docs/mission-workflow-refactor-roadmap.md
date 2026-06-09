# Mission workflow refactor and completion trajectory

This document is the working source of truth for making `mission_workflow` more maintainable, typed, and complete. Update it after each implemented component.

## Guiding principles

- Preserve the Droid/Missions contract: plan first, explicit approval before activation, autonomous execution after approval, serial workers, creator/verifier split, strict handoffs, durable state, adversarial validation, and manual final merge.
- Keep behavior stable during refactors; prefer small logical commits with tests and code review.
- Keep code typed. New reusable code should live under `mission-workflow/src/**` with explicit TypeScript types.
- Use thread-phase where it improves observable multi-step work: planning/refactor assessments, validation pipelines, fanout review validators, and larger implementation workflows. Do not wrap trivial pure helpers in thread-phase.
- Do not push or tag unless explicitly requested.

## Current architecture state

- `mission-workflow/bin/mission-workflow.mjs` still contains most mission-runner logic.
- `mission-workflow/index.ts` is now thinner and imports typed extension wrapper helpers.
- The typed refactor has started under `mission-workflow/src/extension/`.

## Completed components

### 2026-06-09 — Typed extension wrapper helper extraction

Commit: `9f810a3 Extract typed mission tool wrapper helpers`

Extracted from `mission-workflow/index.ts`:

- `mission-workflow/src/extension/types.ts`
- `mission-workflow/src/extension/args.ts`
- `mission-workflow/src/extension/cwd.ts`
- `mission-workflow/src/extension/result.ts`

Validation/review:

- `pi --no-extensions -e . --list-models` passed.
- `npm test` passed.
- Post-commit review: `.git/pi-code-reviews/9f810a3c1792.md`, verdict low risk.

### 2026-06-09 — Focused wrapper helper smoke coverage

Implemented in current working tree.

Added targeted smoke coverage for the new `src/extension` helper modules. The tests are guarded so older Node runtimes without native TypeScript module loading do not fail merely because `npm test` runs plain `node`; the required package-level Pi extension load smoke still verifies the extension imports these `.ts` modules through Pi.

Covered checks:

- `splitList()` handles scalar comma/semicolon shorthand and explicit arrays.
- `buildArgs()` preserves optional mission args, session args, repeated explicit validation command entries, booleans, and model args.
- `parseSimpleCd()` handles `cd`, `cd -`, quoted paths, escaped spaces, trailing semicolon, and rejects non-`cd` commands.
- `resolveAgainstActive()` handles relative/absolute paths and home expansion.
- `truncate()` preserves UTF-8 boundaries and includes the standard thread-phase run hint.
- `parseJsonObject()` parses JSON and handles blank output.

Validation:

- `pi --no-extensions -e . --list-models` passed.
- `npm test` passed.

Remaining test gap:

- `runScript()` abort/process lifecycle coverage should be added once a stable helper-level test harness exists.

### 2026-06-09 — Typed core/domain model foundation

Implemented in current working tree.

Added pure typed core modules without changing the mission runner state machine:

- `mission-workflow/src/core/constants.ts`
- `mission-workflow/src/core/types.ts`
- `mission-workflow/src/core/text.ts`
- `mission-workflow/src/core/json.ts`
- `mission-workflow/src/core/time.ts`

Covered helpers/types:

- `parseMillis`
- `safeName`
- `compactText` / `appendBounded` as UTF-8/surrogate-safe variants for future migration
- `byteLength`
- `compactJson` with fail-fast handling for top-level non-JSON values
- `readJsonFile`
- mission plan, milestone, feature, validation contract, category, role/capability/prompt policy types
- mission enum/default constants

Validation:

- `pi --no-extensions -e . --list-models` passed.
- `npm test` passed.

### 2026-06-09 — Typed completion normalization helpers

Commit: `d71e522 Add typed mission completion normalizers`

Added `mission-workflow/src/planning/completion.ts` with typed pure helpers matching current runner completion semantics:

- `normalizeCompletionTarget()`
- `completionLevelAtLeast()`
- `normalizeRequiredFor()`
- `normalizeCompletionLevels()`

Smoke coverage checks default target behavior, reserved `code_complete` recognition, strict invalid-target rejection, target ordering, duplicate requiredFor dedupe, and object-shaped completion level preservation.

Post-commit review: `.git/pi-code-reviews/d71e522ba284.md`, verdict low risk.

### 2026-06-09 — Typed deliverables/external-service/policy normalizers

Implemented in current working tree.

Added typed pure planning modules:

- `mission-workflow/src/planning/deliverables.ts`
- `mission-workflow/src/planning/external-services.ts`
- `mission-workflow/src/planning/policies.ts`

Covered helpers:

- `normalizeDeliverables()`
- `normalizeExternalServices()`
- `normalizeRolePolicy()`
- `normalizeCapabilityPolicy()`
- `normalizePromptPolicy()`

Smoke coverage checks deliverable array preservation, external-service generated/default fields and skip-policy rejection, role model override/default behavior, capability timeout fallback, and prompt default preservation.

### 2026-06-09 — Typed validation category normalizers

Implemented in current working tree.

Added `mission-workflow/src/validation/categories.ts` with typed pure helpers matching current runner category semantics:

- `normalizeValidationCategory()`
- `normalizeValidationCategories()`

The module composes the typed completion, deliverables, and external-service normalizers. Smoke coverage checks single category defaults/errors, malformed category rejection, explicit category preservation, legacy validation command dedupe/unique IDs, user-test command generation, external-service and deliverable generated categories, and implicit adversarial category generation.

Post-commit review of `f2d32bc` found malformed `null` category entries were being silently normalized by the typed helper. The current working tree fixes that by rejecting null/non-object category entries with a clear error before these helpers are wired into runtime call sites.

## Active / next component

### Registry and trust model foundation

Goal: begin extracting registry path/default-state/trust helper types and pure path/default functions from `mission-workflow/bin/mission-workflow.mjs` while keeping runtime behavior stable.

## Refactor roadmap

### Phase 1 — Typed core/domain model

Status: implemented as foundation modules. The monolithic runner still owns runtime behavior until later slices switch call sites.

### Phase 2 — Planning and validation category normalization

Extract pure plan/category logic:

- `src/planning/normalize-plan.ts`
- `src/planning/validation-contract.ts`
- `src/planning/deliverables.ts`
- `src/planning/external-services.ts`
- `src/validation/categories.ts`

Keep completion target/category behavior exactly stable.

### Phase 3 — Registry and trust model

Extract durable registry and resume/trust helpers:

- `src/registry/paths.ts`
- `src/registry/state.ts`
- `src/registry/cursors.ts`
- `src/registry/trusted-checkpoints.ts`
- `src/git/fingerprints.ts`

Do not weaken trusted-head, cursor, or contaminated-branch semantics.

### Phase 4 — Process, Pi, cancellation, and observability boundary

Extract:

- `src/process/run-process.ts`
- `src/process/run-pi.ts`
- `src/process/cancellation.ts`
- `src/process/operations.ts`
- `src/process/active-io.ts`
- `src/observability/thread-phase.ts`
- `src/observability/heartbeat.ts`

Keep active I/O workflow-agnostic and privacy-preserving.

### Phase 5 — Git/worktree hygiene

Extract:

- `src/git/git.ts`
- `src/git/worktrees.ts`
- `src/git/branches.ts`
- `src/git/generated-junk.ts`
- `src/git/transient-artifacts.ts`
- `src/git/trusted-branch.ts`

Preserve transition-specific lockfile handling.

### Phase 6 — Worker handoff and shared notes

Extract:

- `src/execution/workers.ts`
- `src/execution/handoff.ts`
- `src/execution/shared-notes.ts`

Keep runner-owned changed files/assertion coverage authoritative.

### Phase 7 — Validation and repair loop

Extract:

- `src/validation/coverage.ts`
- `src/validation/feature-review.ts`
- `src/validation/adversarial-validator.ts`
- `src/validation/run-validation.ts`
- `src/execution/repairs.ts`
- `src/artifacts/repair-plan.ts`

Potential thread-phase use: typed validation pipeline phases and read-only feature-review fanout.

### Phase 8 — Typed CLI entrypoint

After stable lower-level modules:

- Add `src/cli/main.ts`.
- Keep `bin/mission-workflow.mjs` as a thin wrapper.
- Preserve stdout JSON, background behavior, exit codes, and command names.

## Product/completeness roadmap after refactor foundation

- `status` / `resume explain` mode with normalized registry integrity diagnostics.
- Metrics/analytics artifacts for roles, token/budget usage, validators, repair iterations, and category outcomes.
- Richer behavior adapters, starting with `http_flow`.
- Stronger prompt-injection hardening for worker-authored shared notes.
- Generated mission skills / persistent project notes for agent-X continuity.
- More explicit role/model policy and per-role metrics.
- Stronger runtime schema validation for plans, handoffs, reports, repair plans, and registry state.

## Validation protocol for each slice

Run at minimum:

```bash
cd /home/velvet/.pi/agent/extensions
pi --no-extensions -e . --list-models
npm test
```

Then run a working-tree code review. Commit only after the review is low-risk or findings are addressed. Run a post-commit review for each logical feature commit.
