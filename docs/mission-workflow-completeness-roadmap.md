# Mission workflow completeness roadmap

This document tracks what the `mission_workflow` extension still needs in order to become a more complete Factory/Droid-style software production pipeline. It intentionally prioritizes **DX** (developer/operator experience) and **agent-X** (agent execution, validation, handoff, and orchestration quality) over end-user visual polish.

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

The `auto_trading` dogfood mission proved this can produce and validate a substantial codebase, but it also exposed gaps between **code completion** and **operational software production**.

## Priority 1 — Production-readiness validation contracts

Current validation is strong for code correctness but weaker for proving the resulting software is runnable in its intended environment.

Needed work:

- Add first-class validation categories instead of only arbitrary command strings:
  - `scrutiny`: tests, type checks, lint, compile, static review.
  - `operational`: environment readiness, dependency install, config validation, provider/service health.
  - `integration`: real or credential-gated endpoint smoke tests.
  - `deployment`: dry-run startup, scheduler/service checks, artifact/runbook checks.
  - `domain`: project-specific invariants, e.g. trading PIT/leakage/risk checks.
- Let plans declare which validation categories are required for each milestone and for final completion.
- Distinguish terminal statuses such as:
  - `code_complete`
  - `contract_validated`
  - `operationally_ready`
  - `deployment_ready`
- Prevent a mission from being reported as fully complete when only code-contract validation passed but operational readiness was never exercised.
- Add credential-gated validators that skip with explicit evidence when secrets are absent, rather than silently treating external integration as out of scope.

Example gap from dogfood:

- `auto_trading` generated data adapters and 198 tests, but real Alpaca/FRED/Finnhub ingestion was not configured or running. A better mission contract would require data-health and one-shot ingestion commands before calling the system operationally ready.

## Priority 2 — Better planner output and validation-contract decomposition

The planner should create plans that reflect software delivery stages, not only implementation feature chunks.

Needed work:

- Require the planner to classify each milestone as one or more of:
  - foundations
  - feature implementation
  - integration
  - operationalization
  - documentation/runbook
  - deployment readiness
- Require every plan to include explicit “definition of done” levels:
  - code done
  - tests done
  - integration done
  - operator-ready
- Add explicit plan fields for:
  - external services and credentials needed;
  - endpoint health checks;
  - generated CLI/API entry points;
  - expected persistent/runtime artifacts;
  - how to manually verify the delivered system after mission completion.
- Improve contract generation so global assertions are smaller, less overlapping, and easier for validators to evaluate independently.
- Add planner self-review before plan artifact emission: “what would make this implementation still unusable even if all tests pass?”

## Priority 3 — Heterogeneous model routing and role policies

The extension exposes `modelPlan`, `modelWorker`, and `modelValidator`, but it does not yet strongly encode role-specific model policy or measure model-role performance.

Needed work:

- Define recommended model profiles:
  - planner: high-reasoning, slower, better at decomposition and contracts;
  - worker: fast code-fluent model;
  - validator: separate model/provider when possible, precise and adversarial;
  - domain critic: specialist prompt/model for domain-specific risks;
  - ops critic: deployment/SRE readiness model.
- Persist role/model identity in registry and validation artifacts in a way that supports later analysis.
- Add optional multi-validator mode:
  - general code validator;
  - domain validator;
  - operational validator.
- Add validator disagreement handling: if validators conflict, trigger a repair-planning/arbiter phase rather than accepting the first report.
- Add role-level budgets and fallback models.
- Track pass/fail and repair rates by model role to learn which model combinations work best.

## Priority 4 — Repair planning should become strategic

Current repairs are useful but too directly derived from validator objections. Factory-style “negotiation” at milestone boundaries should be more deliberate.

Needed work:

- Insert a repair-planner phase between validation failure and repair worker execution.
- Cluster related objections into fewer coherent repair features.
- Detect when validation failure indicates a bad plan or missing contract rather than an implementation bug.
- Allow the repair planner to recommend:
  - rerun a worker;
  - add tests;
  - add missing operational tooling;
  - split a milestone;
  - revise local acceptance checks;
  - fail the mission as under-specified.
- Preserve repair rationale and objection-to-repair mapping as runner-owned artifacts.
- Add repair quality metrics:
  - number of objections fixed;
  - new objections introduced;
  - repeated objection signatures;
  - iteration count per milestone.

## Priority 5 — Agent handoff and context quality

Handoff v2 is strong, but agent-to-agent context could be more useful and less fragile.

Needed work:

- Add structured handoff sections for:
  - architectural decisions made;
  - assumptions and constraints discovered;
  - external service assumptions;
  - future operator steps;
  - tests added and why;
  - risks deliberately not addressed.
- Make handoff summaries available to later workers in compact, runner-curated form instead of passing too much raw prior context.
- Add broadcast-style shared mission notes that are updated by the orchestrator after each milestone.
- Add automatic detection of contradiction between new handoffs and prior architectural decisions.
- Continue keeping exact changed files/assertion coverage runner-owned and non-authoritative when supplied by workers.

## Priority 6 — DX-focused command surfaces for delivered software

Missions should encourage production-ready entry points, not just libraries and tests.

Needed work:

- Planner should ask for or infer necessary operator commands:
  - health check;
  - one-shot ingest;
  - dry-run execution;
  - scheduler start/stop/status;
  - config validation;
  - artifact/report generation.
- Validators should verify those commands exist and work.
- For Python projects, prefer console scripts under `pyproject.toml` when appropriate.
- For service projects, require local run instructions and dependency/env examples.
- Add a final DX artifact that summarizes:
  - how to install;
  - how to configure;
  - how to validate;
  - how to run safely;
  - what remains unconfigured.

Example next mission for `auto_trading`:

- Add `auto-trading-data-health`.
- Add `auto-trading-ingest-once --symbols SPY,QQQ --sources alpaca,edgar,fred,finnhub`.
- Add `auto-trading-paper-forward-once --dry-run`.
- Add credential-gated endpoint tests.
- Add scheduler runbook and dry-run status command.

## Priority 7 — Registry, resume, and artifact durability

The registry is much stronger after dogfooding, but still needs more production hardening.

Needed work:

- Version registry schemas and add migration/compatibility checks.
- Add registry integrity checks command/action.
- Add explicit distinction between:
  - active run state;
  - last failed attempt;
  - resolved failure;
  - completed mission state.
- Add resume dry-run/explain mode: show what would be skipped, rerun, reset, or rejected before activation.
- Add artifact reference validation so trusted cursors fail if required artifacts are missing or corrupted.
- Add cleanup/quarantine policies for old worktrees and feature branches that are safe, explicit, and auditable.

## Priority 8 — Workflow/event projection quality for agents and tools

The visualizer should stay workflow-agnostic, but the event model can better support agents and debugging tools.

Needed work:

- Emit richer generic progress metadata:
  - unit type (`feature`, `milestone`, `repair`, `validator`, `command`);
  - completed/total;
  - current item id/title;
  - retry/iteration counts;
  - validation category.
- Add stable event schemas for operation start/end, validation category results, and repair queues.
- Make `thread_phase_runs` better for agents:
  - concise current state;
  - latest failure;
  - latest artifact pointers;
  - active child process details;
  - completed vs operationally-ready status.
- Avoid workflow-specific UI code, but allow mission workflow to emit generic metadata that any renderer or agent can interpret.

## Priority 9 — Metrics and feedback loops

The extension should learn from long missions.

Needed work:

- Record metrics by role and milestone:
  - wall-clock time;
  - token usage;
  - model identity;
  - files changed;
  - tests added;
  - validation failures;
  - repair iterations;
  - repeated objection signatures.
- Generate a final mission analytics artifact.
- Add post-mission critique prompts:
  - what did the plan miss?
  - what failures recurred?
  - what should future plans include?
  - which model roles underperformed?
- Feed distilled lessons into docs/skills without requiring chat history.

## Priority 10 — Safer external integration testing

External endpoint tests are necessary but must not leak secrets or accidentally trade.

Needed work:

- Add a standard credential-gated test convention:
  - `AUTO_TRADING_RUN_EXTERNAL_TESTS=1`
  - provider-specific required env vars;
  - never run live broker actions by default.
- Add provider health probes that identify:
  - credentials missing;
  - network unreachable;
  - provider rejects request;
  - rate limit hit;
  - response schema changed.
- Add tests for “paper-only” execution paths with real credentials where possible.
- Add explicit skip artifacts for missing credentials so mission completion honestly states which external checks were not run.

## Suggested implementation sequence

1. Add validation categories and final completion levels.
2. Add operational-readiness contract fields to plans.
3. Add role-specific model policy and registry metrics.
4. Add repair-planner phase.
5. Add richer handoff/shared mission notes.
6. Improve agent/tool-readable event projections.
7. Add registry integrity/resume dry-run.
8. Add external integration test convention.
9. Dogfood on a narrow `auto_trading` operational-readiness mission.

## Success criteria

The extension should be considered substantially more complete when a mission can:

- produce a plan that includes implementation, validation, operationalization, and documentation;
- use heterogeneous models by role with recorded metrics;
- prove not just that code passes tests, but that the delivered software can be configured and run safely;
- generate coherent repair work from clustered validator objections;
- resume safely with explainable trust decisions;
- leave behind enough artifacts for a new agent or developer to continue without chat context.
