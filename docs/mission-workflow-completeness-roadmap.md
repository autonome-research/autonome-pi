# Mission workflow completeness roadmap and implementation design

This document tracks the concrete work needed to make `mission_workflow` closer to a complete Factory/Droid-style software production pipeline. It intentionally prioritizes **DX** (developer/operator experience) and **agent-X** (agent execution quality, validation, handoff, repair, model routing, resumability, and inspectable artifacts) over end-user visual polish.

## Scope and implementation map

Primary implementation files:

- `mission-workflow/bin/mission-workflow.mjs`
  - CLI runner, durable registry, planning, worktree orchestration, worker execution, validation, repair loops, coverage, final report, cancellation, watchdogs, and artifacts.
  - Current hotspots to extend:
    - `parseArgs()` — CLI flags.
    - `defaultRegistryState()`, `persistRegistryPlan()`, `updateRegistryState()` — registry schema and state persistence.
    - `defaultPlan()`, `createPlan()`, `normalizePlan()`, `normalizeValidationContract()`, `validatePlanForActivation()` — plan schema, planner prompt, validation contract shape.
    - `runWorkerForFeature()`, `validateHandoff()` — worker prompt, handoff schema, runner-owned handoff validation.
    - `runValidation()`, `runAdversarialValidator()`, `normalizeValidatorReport()`, `buildCoverageReport()` — validation execution, validator prompt/report schema, coverage semantics.
    - `repairFeaturesFromReport()` — current deterministic repair-feature generation; should become repair planning.
    - `activateMission()` — mission state machine, completion-level decisions, milestone loop, registry updates.
    - `latestTrustedPassedValidationCursor()` and related cursor helpers — resume trust and validation reuse.
    - `status()` — currently minimal; should become registry/worktree/mission-state inspection.
- `mission-workflow/index.ts`
  - Pi tool registration and parameter schema.
  - Current hotspots to extend:
    - `MissionAction` type if new actions are added.
    - `buildArgs()` for new CLI flags.
    - `pi.registerTool({ parameters: ... })` for new DX/agent-X parameters.
    - `compactDetails()` for concise tool responses.
- `thread-phase-visualizer/lib/store.mjs`
  - Generic run/event store and projections used by `thread_phase_runs` and monitor components.
  - Should remain workflow-agnostic. Prefer richer generic `phaseEvent()` metadata emitted by `mission-workflow/bin/mission-workflow.mjs` before adding store-specific mission behavior.
- `thread-phase-visualizer/lib/store.d.ts`
  - Update only when projected store shapes gain stable fields.
- `thread-phase-visualizer/components/monitor.ts`, `thread-phase-visualizer/index.ts`
  - Do not add mission-specific rendering unless a generic projection cannot represent the information.
- `scripts/smoke-test.mjs`
  - Add deterministic regression coverage for new schemas, event projections, resume behavior, cancellation, repair planning, and compatibility.
- `mission-workflow/README.md`, `docs/mission-workflow-continuation.md`, `skills/mission-workflow/SKILL.md`
  - Update when tool behavior, approval policy, resume policy, validation categories, or operator expectations change.

Design rule: keep the **state machine deterministic and auditable**, but move strategy into **schemas, prompts, skills, and validation contracts** wherever possible so the system benefits from model improvements.

## Current baseline

The extension already has the core production-loop skeleton:

- plan first, then one-time approval before activation;
- serial worker execution in isolated worktrees;
- runner-owned commits and fast-forward mission branch advancement;
- strict worker handoffs with runner-owned changed-file/assertion metadata;
- command validation plus fresh adversarial validation at milestone boundaries;
- repair feature generation with capped iterations;
- durable registry, trusted checkpoints, validation-cursor hardening, and resume;
- active I/O telemetry, watchdogs, cancellation, generated-junk protection, and transient lockfile handling;
- final coverage artifacts and manual final merge.

The `auto_trading` dogfood mission proved this can produce and validate a substantial codebase. It also exposed the key gap: **code-contract completion is not the same as operational software readiness**.

## Target architecture

The next version should model a mission as four independent but connected tracks:

1. **Implementation track** — workers implement serial features.
2. **Validation track** — categorized validators prove code, behavior, domain, integration, and operational readiness.
3. **Repair-planning track** — failures are classified and clustered into deliberate repair work.
4. **DX/artifact track** — the mission leaves behind commands, runbooks, health checks, reports, and enough structured artifacts for a future developer or agent to continue without chat history.

The orchestrator should still be deterministic about safety-critical transitions:

- activation requires explicit approval;
- workers do not commit;
- runner owns changed files, commits, fingerprints, and coverage accounting;
- adversarial validation remains mandatory unless a plan explicitly targets only a lower completion level;
- final merge remains manual;
- registry completion state is immutable against later failed/cancelled attempts.

## Schema design: additive `pi-mission-workflow/v1` fields

Keep the plan schema string as `pi-mission-workflow/v1` until a breaking migration is required. Add fields compatibly and normalize missing values in `normalizePlan()`.

### Plan-level fields

Add to plan objects generated by `defaultPlan()` and `createPlan()`, normalized by `normalizePlan()`, and checked by `validatePlanForActivation()`:

```json
{
  "completionTarget": "contract_validated",
  "completionLevels": {
    "code_complete": { "required": true },
    "contract_validated": { "required": true },
    "operationally_ready": { "required": false },
    "deployment_ready": { "required": false }
  },
  "validationCategories": [],
  "externalServices": [],
  "deliverables": { "entrypoints": [], "runtimeArtifacts": [], "runbooks": [] },
  "rolePolicy": {},
  "capabilityPolicy": {},
  "promptPolicy": {}
}
```

Recommended completion levels:

- `code_complete`: assigned workers finished and runner-owned commits/no-change handoffs exist.
- `contract_validated`: scrutiny commands, adversarial validator, and final coverage pass for all must assertions.
- `operationally_ready`: required operator commands/config/service-health checks pass or have explicit credential-gated skip artifacts.
- `deployment_ready`: startup/deployment dry-runs, service lifecycle checks, release/runbook artifacts, and safety gates pass.

Initial default should remain `contract_validated` to preserve current behavior. Missions can opt into `operationally_ready` or `deployment_ready` through planner output or future tool flags.

### Validation category schema

Add a normalized category object shape:

```json
{
  "id": "pytest",
  "category": "scrutiny",
  "title": "Run unit test suite",
  "scope": "milestone",
  "requiredFor": ["contract_validated"],
  "commands": ["npm test"],
  "userTest": false,
  "adversarial": false,
  "modelRole": "validator",
  "credentialGates": [],
  "skipPolicy": "fail_when_skipped",
  "timeoutMs": null,
  "artifactsRequired": []
}
```

Allowed `category` values:

- `scrutiny`: tests, lint, typecheck, compile, static review.
- `behavior`: local end-to-end/user-flow command validators.
- `operational`: config validation, health checks, scheduler/service dry-runs, dependency install checks.
- `integration`: real or credential-gated external endpoint smoke tests.
- `domain`: domain-specific invariants, such as trading PIT/leakage/risk checks.
- `deployment`: startup/deployment dry-run checks, packaging/release/runbook checks.

Allowed `skipPolicy` values:

- `fail_when_skipped`: missing credentials/env/config is a failure.
- `explicit_skip_allowed`: missing credentials/env/config is not failure, but a skip artifact must be written.
- `optional`: run if possible, never blocks completion.

Compatibility mapping:

- Existing `plan.validationCommands[]` becomes one `scrutiny` category per command.
- Existing `plan.userTestCommand` becomes one `behavior` category.
- Existing adversarial validator remains mandatory for `contract_validated` and should be represented internally as an `adversarial-scrutiny` category result even if not listed in the plan.

### External service schema

Planner output should declare external services explicitly:

```json
{
  "id": "alpaca",
  "purpose": "US equity/ETF market bars and paper execution",
  "requiredFor": ["operationally_ready"],
  "credentialEnv": ["ALPACA_API_KEY", "ALPACA_SECRET_KEY"],
  "healthCommand": "auto-trading-data-health --provider alpaca",
  "smokeCommand": "auto-trading-ingest-once --symbols SPY --sources alpaca --limit 5",
  "destructive": false,
  "liveExternalAction": false
}
```

`validatePlanForActivation()` should reject `destructive: true` or `liveExternalAction: true` unless the plan capability policy explicitly allows it and the tool invocation includes an explicit future override. Do not add live external action support by default.

### Deliverable/DX schema

Planner output should describe operator/developer-facing entry points expected from the target repo:

```json
{
  "entrypoints": [
    {
      "name": "data health",
      "type": "cli",
      "command": "auto-trading-data-health",
      "requiredFor": ["operationally_ready"],
      "validationCommand": "auto-trading-data-health --help"
    }
  ],
  "runtimeArtifacts": [
    { "path": "var/", "description": "runtime cache/store root", "requiredFor": ["operationally_ready"] }
  ],
  "runbooks": [
    { "path": "README.md", "section": "Data provider setup", "requiredFor": ["operationally_ready"] }
  ]
}
```

Validators should check these deliverables when their `requiredFor` level is at or below the mission `completionTarget`.

### Role/model policy schema

Add normalized role policy fields so heterogeneous model usage becomes explicit and measurable:

```json
{
  "rolePolicy": {
    "planner": { "model": "...", "profile": "high_reasoning" },
    "worker": { "model": "...", "profile": "code_fluent" },
    "validator": { "model": "...", "profile": "adversarial_precise" },
    "domainCritic": { "model": "...", "profile": "domain_specialist", "enabled": false },
    "opsCritic": { "model": "...", "profile": "sre_operational", "enabled": false }
  }
}
```

Mapping to current CLI/tool params:

- `modelPlan` / `--model-plan` -> `rolePolicy.planner.model`.
- `modelWorker` / `--model-worker` -> `rolePolicy.worker.model`.
- `modelValidator` / `--model-validator` -> `rolePolicy.validator.model`.
- Add future tool params in `mission-workflow/index.ts` and `parseArgs()` for:
  - `modelDomain` / `--model-domain`;
  - `modelOps` / `--model-ops`;
  - `completionTarget` / `--completion-target`.

### Capability policy schema

Add a conservative default capability policy:

```json
{
  "capabilityPolicy": {
    "network": "allowed_for_validation",
    "secrets": "env_only_redacted",
    "destructiveGit": false,
    "deployment": false,
    "liveExternalActions": false,
    "maxCommandTimeoutMs": 1200000
  }
}
```

Use this in validation category execution before running commands that may contact external services or mutate state. This is agent-X/DX safety, not UI.

### Prompt/skill/schema version policy

Add prompt and schema identity to plans, registry, and artifacts:

```json
{
  "promptPolicy": {
    "plannerPromptVersion": "mission-planner/v2",
    "workerPromptVersion": "mission-worker/v3",
    "validatorPromptVersion": "mission-validator/v3",
    "repairPlannerPromptVersion": "mission-repair-planner/v1",
    "handoffSchema": "pi-mission-worker-handoff/v3",
    "validationReportSchema": "pi-mission-workflow/milestone-validation/v2"
  }
}
```

Implementation locations:

- Define constants near the top of `mission-workflow/bin/mission-workflow.mjs`.
- Include prompt versions in `defaultPlan()` and `normalizePlan()`.
- Emit them in planner, worker, validator, and repair-planner artifacts.
- Persist them in `defaultRegistryState()` and every validation cursor fingerprint if they affect reuse.

## Registry design: additive registry v2 fields

Current registry state is created by `defaultRegistryState()` with schema `pi-mission-workflow/registry/v1`. Keep reading v1, but add v2-like fields compatibly:

```json
{
  "schema": "pi-mission-workflow/registry/v1",
  "completion": {
    "target": "contract_validated",
    "level": "code_complete",
    "categoryResults": [],
    "blockedBy": []
  },
  "roleModels": {},
  "roleMetrics": {},
  "promptVersions": {},
  "failureHistory": [],
  "repairHistory": [],
  "operatorDx": {
    "entrypointsVerified": [],
    "runbooksVerified": [],
    "externalChecksSkipped": []
  }
}
```

Implementation details:

- Extend `defaultRegistryState()` with these fields.
- Update `persistRegistryPlan()` to preserve older registry fields and initialize missing new fields.
- Update `activateMission()` after each worker, validation category, repair plan, and final coverage step.
- Extend `markMissionRegistryTerminalFromArgs()` so failures include `failureClass` when available.
- Add registry integrity checks to `status()` first, then consider a future `action: "doctor"`.

## Failure taxonomy

Introduce deterministic failure classification before repair planning and terminal registry writes.

Suggested enum:

- `implementation_bug`
- `missing_acceptance_test`
- `bad_plan_decomposition`
- `ambiguous_spec`
- `operational_gap`
- `external_dependency_unavailable`
- `credential_missing`
- `validator_false_positive`
- `model_or_handoff_failure`
- `runner_git_worktree_failure`
- `runner_lifecycle_failure`
- `capability_policy_block`
- `unknown`

Implementation locations:

- Add `classifyValidationFailure(report)` near `normalizeValidatorReport()` / `runValidation()`.
- Add `classifyCaughtError(error)` near `markMissionRegistryTerminalFromArgs()`.
- Include `failureClass` on:
  - validator objections;
  - command/category reports;
  - repair-planner inputs/outputs;
  - terminal registry `lastError`;
  - `phaseEvent(..., { kind: "failure_classification", ... })`.

## Validation execution design

Refactor `runValidation()` into category-aware execution while preserving current behavior.

Proposed new helpers in `mission-workflow/bin/mission-workflow.mjs`:

- `normalizeValidationCategories(plan)`
  - Converts legacy `validationCommands` and `userTestCommand` to category objects.
  - Adds implicit `adversarial-scrutiny` if completion target requires `contract_validated`.
- `credentialGateStatus(category, env)`
  - Checks env vars listed in `credentialGates` or referenced external services.
  - Returns `{ runnable, missing, skipAllowed }`.
- `runValidationCategory(env, plan, milestone, iterationState, category, ctx, run)`
  - Dispatches to command, adversarial, domain, ops, or external category execution.
- `runCommandValidationCategory(...)`
  - Uses existing `runProcess()` behavior, timeouts, cancellation, and artifact writing.
- `runPiValidationCategory(...)`
  - Generalized version of `runAdversarialValidator()` for validator/domain/ops critics.
- `aggregateValidationResults(...)`
  - Computes category pass/fail/skip and whether target completion level is satisfied.

Category report shape:

```json
{
  "schema": "pi-mission-workflow/validation-category-result/v1",
  "id": "pytest",
  "category": "scrutiny",
  "requiredFor": ["contract_validated"],
  "status": "pass",
  "passed": true,
  "skipped": false,
  "skipReason": null,
  "failureClass": null,
  "commandReports": [],
  "validatorReport": null,
  "artifacts": []
}
```

`runValidation()` should continue returning `pi-mission-workflow/milestone-validation/...`, but with `categoryResults[]` added. `buildCoverageReport()` should include category validators in each assertion row rather than only `commandReports` plus `adversarial-scrutiny`.

## Multi-validator design

Factory-style validation separates scrutiny and user testing. This extension should support more validator roles while keeping them optional and scoped.

Implementation plan:

1. Keep `runAdversarialValidator()` as the general code/contract validator.
2. Add `runRoleValidator({ role, category, ... })` as a generic Pi validator runner.
3. Make domain and ops validators category-driven:
   - `category: "domain"` uses `ctx.modelDomain || ctx.modelValidator`.
   - `category: "operational"` / `deployment` uses `ctx.modelOps || ctx.modelValidator`.
4. Add validator disagreement handling:
   - If one blocking validator passes and another fails, do not silently accept either.
   - Emit `validation-disagreement` and feed both reports into repair planning.
   - Repairs should target the blocking report unless the repair planner classifies it as `validator_false_positive`.

Tool/API changes in `mission-workflow/index.ts`:

- Add optional parameters:
  - `modelDomain`;
  - `modelOps`;
  - `completionTarget`;
  - possibly `validationProfile` later, but avoid large nested tool schemas until CLI support is stable.
- Add corresponding `buildArgs()` entries.

## Strategic repair planning design

Current `repairFeaturesFromReport()` directly converts validator corrective features and coverage gaps into repair features. Replace this with a strategic repair-planning layer.

New helper:

```js
async function planRepairsFromValidation(env, plan, milestone, validation, iteration, ctx, run) { ... }
```

Behavior:

1. Build deterministic repair input:
   - validation category results;
   - must objections;
   - coverage gaps;
   - command failures;
   - failure classifications;
   - previous repair signatures for this milestone;
   - current diff stat/files;
   - handoff summaries.
2. If planner mode is `mock`, use deterministic fallback.
3. Otherwise run a repair-planner Pi call with read-only tools first.
4. Normalize output to repair features.
5. Cluster duplicate or related objections.
6. Produce `repairPlan` artifact:

```json
{
  "schema": "pi-mission-workflow/repair-plan/v1",
  "milestoneId": "M1",
  "iteration": 2,
  "failureClasses": ["operational_gap"],
  "decision": "create_repairs",
  "rationale": "Endpoint health command missing",
  "repairs": [],
  "objectionMap": []
}
```

Allowed decisions:

- `create_repairs`
- `rerun_worker`
- `add_tests`
- `add_operational_tooling`
- `split_milestone`
- `mark_validator_false_positive`
- `fail_under_specified`
- `fail_capability_blocked`

`activateMission()` should call `planRepairsFromValidation()` instead of `repairFeaturesFromReport()` when validation fails. Keep `repairFeaturesFromReport()` as deterministic fallback.

## Handoff and shared mission context design

Current handoff skeleton is written by `runWorkerForFeature()` using schema `pi-mission-worker-handoff/v2`. Extend it additively to v3 while accepting v2.

New optional fields:

```json
{
  "schema": "pi-mission-worker-handoff/v3",
  "architecturalDecisions": [],
  "assumptions": [],
  "externalServiceAssumptions": [],
  "operatorSteps": [],
  "testsAdded": [],
  "risksNotAddressed": [],
  "broadcastNotes": []
}
```

Implementation locations:

- Update skeleton in `runWorkerForFeature()`.
- Update `validateHandoff()` to type-check these fields when present without making them mandatory initially.
- Update `summarizeHandoff()` to include compact versions.
- Add `updateSharedMissionNotes(plan, milestone, featureResult, run)` called after each successful worker and validation.
- Write artifacts:
  - `state/shared-mission-notes.json`
  - optionally `state/shared-mission-notes.md`
- Include compact shared notes in later worker prompts and validator prompts, but keep within `MAX_PROMPT_CONTEXT_BYTES`.

Important: exact changed files, assigned assertions, coverage, commit metadata, and feature fingerprints remain runner-owned.

## DX command-surface validation

The planner should not only create code features; it should plan the commands that prove the target software can be operated.

Implementation changes:

- `createPlan()` prompt should require `deliverables.entrypoints`, `externalServices`, and operational validation categories when the goal implies a runnable app/service/CLI/integration.
- `validatePlanForActivation()` should ensure any `completionTarget` above `contract_validated` includes corresponding deliverables and categories.
- `runValidationCategory()` should execute deliverable validation commands.
- Final report in `activateMission()` should include:
  - completion target and achieved level;
  - commands verified;
  - commands skipped and why;
  - external services checked/skipped;
  - remaining manual configuration.

For the `auto_trading` follow-up mission, the target project should expose commands such as:

- `auto-trading-data-health`
- `auto-trading-ingest-once --symbols SPY,QQQ --sources alpaca,edgar,fred,finnhub`
- `auto-trading-paper-forward-once --dry-run`

The mission extension should be able to plan and verify similar command surfaces for any project, not hard-code trading-specific behavior.

## Resume, status, and registry integrity design

The current resume logic is strong but hard to inspect. Improve mission-operator DX without adding approval gates after activation.

Implementation locations:

- `status()` in `mission-workflow/bin/mission-workflow.mjs`.
- `mission-workflow/index.ts` action enum and tool schema if adding actions.
- Registry helpers around `registryStatePath()`, `readJsonFile()`, `writeRegistryState()`.

Needed behavior:

- `status` should accept `--plan-path` and/or `--mission-id`.
- Return:
  - registry status;
  - current milestone/feature;
  - completion target/achieved level;
  - latest failure and failure class;
  - validation category summary;
  - worktree/branch health;
  - trusted head/base/plan fingerprint status;
  - resumability: `safe`, `requires_revalidation`, `contaminated`, `completed`, `unknown`.
- Add future `resume --explain` or `status --resume-explain`:
  - what would be skipped;
  - what would be revalidated;
  - what branch drift would be reset/backed up;
  - why a cursor is or is not trusted.
- Add artifact reference validation:
  - validation reports point to existing artifacts;
  - coverage artifacts exist and parse;
  - handoff artifacts exist for no-change trusted records;
  - trusted commit trailers still match.

## Event and projection design for agents/tools

Do not make `thread-phase-visualizer` mission-specific. Instead, emit richer generic events from `mission-workflow/bin/mission-workflow.mjs`.

Add event kinds through `phaseEvent()`:

- `mission_progress`
- `unit_start`
- `unit_end`
- `validation_category_start`
- `validation_category_end`
- `repair_plan_created`
- `failure_classification`
- `completion_level_changed`
- `resume_explain`

Example generic event payload:

```json
{
  "kind": "unit_start",
  "unit": { "type": "feature", "id": "M1-F2", "title": "Add health CLI" },
  "progress": { "completed": 3, "total": 8, "iteration": 1 },
  "category": null,
  "message": "Starting feature M1-F2"
}
```

Store/projection implications:

- `thread-phase-visualizer/lib/store.mjs` should only need changes if `thread_phase_runs` needs a stable summarized field not derivable by callers.
- Prefer generic summary fields such as active unit, latest failure, completion level, and latest artifact pointers.
- Update `thread-phase-visualizer/lib/store.d.ts` if stable projection fields are added.

## Metrics and feedback-loop design

The extension should produce a final analytics artifact and enough registry data to compare model/role performance.

Implementation locations:

- `runPi()` already collects usage entries and emits `usage` phase events.
- `activateMission()` and `createPlan()` should persist role usage to registry.
- Add helper `recordRoleMetric(plan, role, data)` around `updateRegistryState()`.

Metrics to persist:

- role, requested model, resolved model;
- prompt version;
- wall-clock duration;
- token usage when available;
- child process/command duration;
- validation failures by category;
- repair iterations;
- failure classes;
- files changed;
- tests added if detectable;
- repeated objection signatures.

Final artifact:

- `analytics/mission-analytics.json`
- optional `analytics/mission-critique.md`

Post-mission critique prompts should ask:

- what did the plan miss?
- what failures recurred?
- which validation categories produced the most repairs?
- which model roles underperformed?
- what should the mission skill/docs include for next time?

## Evaluation and smoke-test design

Add an explicit mission-workflow eval harness to `scripts/smoke-test.mjs`. These should be deterministic and mostly use `--planner mock` or tiny fixture repos.

Required evals:

1. Plan normalization keeps legacy plans working.
2. New validation category fields normalize from legacy `validationCommands`/`userTestCommand`.
3. `completionTarget=contract_validated` preserves current behavior.
4. `completionTarget=operationally_ready` fails or skips honestly when required credentials are absent.
5. Credential-gated skip writes an artifact and appears in final report.
6. Repair planner clusters duplicate objections and uses stable repair IDs.
7. Failure taxonomy is attached to command failures, validator objections, and terminal registry errors.
8. Handoff v2 remains accepted; handoff v3 optional arrays are summarized.
9. Shared mission notes are compacted and included in later prompts.
10. Registry status/explain reports trusted cursor decisions.
11. Cancellation during category validation does not synthesize repair objections.
12. Unknown/legacy registry fields do not break resume.
13. Generic event projections still render without mission-specific visualizer code.

Optional Pi-backed evals can run separately under an opt-in env var; default smoke tests should stay deterministic.

## Suggested implementation sequence

1. Add constants and schema normalizers in `mission-workflow/bin/mission-workflow.mjs`:
   - completion levels;
   - validation categories;
   - role policy;
   - capability policy;
   - prompt versions;
   - failure taxonomy.
2. Extend `defaultPlan()`, `createPlan()`, `normalizePlan()`, and `validatePlanForActivation()` for additive plan fields.
3. Extend `defaultRegistryState()` and registry updates for completion/category/role/failure fields.
4. Refactor `runValidation()` into category-aware helpers while preserving legacy command/adversarial behavior.
5. Add skip artifacts and credential-gated validation semantics.
6. Replace direct `repairFeaturesFromReport()` usage with `planRepairsFromValidation()` plus deterministic fallback.
7. Extend worker handoff skeleton to v3 and add shared mission notes.
8. Add role/model/prompt metrics and final analytics artifact.
9. Improve `status()` and optionally add resume-explain behavior.
10. Emit richer generic phase events; only then update `thread-phase-visualizer/lib/store.mjs` if projections need stable generic fields.
11. Add smoke/eval coverage in `scripts/smoke-test.mjs`.
12. Update `mission-workflow/README.md`, `docs/mission-workflow-continuation.md`, and `skills/mission-workflow/SKILL.md`.
13. Dogfood on a narrow `auto_trading` operational-readiness mission.

## Success criteria

The extension should be considered substantially more complete when a mission can:

- produce a plan that explicitly includes implementation, validation, operationalization, and documentation/runbook deliverables;
- target and report a completion level beyond simple code completion;
- use heterogeneous models by role with recorded prompt/model/usage metrics;
- run categorized validators with honest credential-gated skip artifacts;
- prove not just that code passes tests, but that delivered software can be configured and run safely for the requested target level;
- generate coherent repair plans from clustered and classified validator objections;
- resume safely with explainable trust decisions and artifact validation;
- leave behind enough plan, registry, handoff, validation, analytics, and DX artifacts for a new agent or developer to continue without chat context.
