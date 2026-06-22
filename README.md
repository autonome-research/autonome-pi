# pi-thread-phase-tools

Private Pi package for thread-phase workflow visualization and example workflows.

## Contents

- `thread-phase-visualizer` — generic TUI monitor and event store for `thread-phase-ui/v1` workflow events.
- `codebase-exploration-workflow` — fanout codebase exploration workflow using Pi subagents.
- `code-review-workflow` — git diff/commit code review workflow using Pi subagents.
- `dynamic-workflows` — validated ad-hoc workflow runner for dynamic workflows planned in chat, with structured spec mode and advanced JavaScript harness mode.
- `mission-workflow` — Droid/Missions-style long-running software mission extension with plan approval, validation contracts, strict handoffs, per-feature worktrees/commits, command + adversarial validators, durable registry/resume, coverage artifacts, and repair loops.
- `bugKill` — persistent one-bug-per-transaction solver extension scaffold with read-only precheck, approval-gated activation surface, durable external artifacts, isolated transaction worktrees/branches, and thread-phase observability.
- `skills/dynamic-workflows` and `skills/mission-workflow` — on-demand Pi skills that teach other sessions/configurations how to use these workflow tools safely.

## Install

```bash
pi install git:git@github.com:Code4me2/pi-thread-phase-tools@v0.11.9
```

For active development:

```bash
pi install git:git@github.com:Code4me2/pi-thread-phase-tools@main
```

## Usage

- `ctrl+shift+t` opens the thread-phase monitor for workflows launched by the current Pi session, including cooperative cancellation via `x`.
- Background/session-launched workflows can queue a session follow-up after successful completion. Dynamic workflows are opt-in via `autoContinue: true` to avoid noisy autonomous callbacks.
- `/codebase-explore` starts codebase exploration in the background by default.
- `/code-review` runs code review workflows.
- `dynamic_workflow` runs validated dynamic workflows from structured specs or JavaScript harnesses. `dynamic_thread_phase_workflow` remains as a deprecated compatibility alias.
- `mission_workflow` plans and activates approved Droid/Missions-style software missions. Always run `action: "plan"` and get user approval before `action: "activate"`.
- `bugKill` prechecks and approval-gates a focused one-bug transaction. Always run `action: "precheck"` before `action: "solve"` with `approved: true`; use `action: "status"` with a transaction id/dir for read-only recovery. The tool and `/bugKill` command also expose safe optional background, timeout, and cleanup parameters without changing existing inputs. Runtime artifacts, reports, validation evidence, allowlist decisions, repair attempts, and failure classifications are external to the target repo under `~/.pi/agent/bugKill/`; solving runs on a reviewable `bugKill/<transaction>` branch in an isolated external worktree, runs targeted reproduction before broad validation, compares post-change results to the baseline, caps repairs, and leaves final reports for manual review instead of silently merging. See `bugKill/README.md` and `bugKill/examples/cli-and-tool-invocations.md` for CLI, `/bugKill`, and `bugKill` examples.
- Tool/API inspection remains available through `thread_phase_runs`.
- Workflow skills are included in the package and should load automatically when tasks ask for dynamic workflows, mission workflows, structured workflow specs, JS harness workflows, or multi-phase dynamic execution.

## Current status

Latest release: `v0.11.9`.

Recent changes:

- Cooperative cancellation uses cancel request files under `~/.pi/agent/thread-phase/cancel/<runId>.json` instead of direct monitor PID killing.
- `dynamic_workflow` is the preferred dynamic workflow tool; `dynamic_thread_phase_workflow` remains as a deprecated alias.
- Dynamic workflows support two modes:
  - structured spec mode for validated/auditable workflows,
  - JavaScript harness mode for richer control flow. Harness mode requires explicit `permissions: "rwx"`.
- Dynamic workflows do not auto-continue by default; pass `autoContinue: true` for successful-run follow-up.
- Usage events are aggregated into run, phase, and fanout-item summaries and rendered in tools/monitor/completion cards.
- `npm test` runs smoke coverage for extension load, permission denial before harness import, structured validation, JS harness mode, structured shell mode, usage projection, and mission registry/resume/strict-handoff checks.
- The package now ships workflow skills so fresh Pi sessions get progressive-disclosure guidance for dynamic workflows and mission workflows.
- Hardened `mission_workflow` with adversarial post-milestone validation, runner-owned handoff metadata, durable trusted checkpoints for resume, strict validation-cursor fingerprints/evidence checks, merge-blocking transient lockfile quarantine, stale `lastError` archival after successful resume/completion, cancellation-safe validation, contaminated-branch detection/reset, assertion coverage reports, generated-junk protection, transient `uv.lock` cleanup with audit artifacts, short content-addressed repair IDs, runner-provided handoff skeletons, compact result payloads, and capped repair loops.
- The generic visualizer now deduplicates repeated artifact paths, closes phase-event-only phases when a workflow reaches a terminal status, and keeps compact run/monitor summaries focused on recent or active phases instead of dumping every historical phase/artifact.
- Thread-phase dependency is `^4.1.0`; global `@autonome-research/thread-phase-cli` was updated to `4.1.0` for improved cancellation/error/fanout primitives.
- Mission continuation/failure-mode notes are in `docs/mission-workflow-continuation.md`; read `/home/velvet/droid_flows.md` first for Droid/Missions design context.
- bugKill workflow docs cover read-only precheck approval, unsafe-plan refusal, durable external artifacts, transaction branches/worktrees, validation ordering and baseline behavior, adaptive allowlist expansion with justification, capped repairs, failure classifications, outcome-based final verification, status recovery, and manual final-review reports.

## Remaining work

High-value follow-ups:

- Bounded JSONL reads: replace full-file index/run reads with tail/offset reads for large stores.
- Dynamic workflow hardening: add tests for harness cancellation, background invalid specs, broader permission matrices, and fanout terminal states.
- Usage budgets: optionally fail/stop workflows when projected token usage exceeds configured limits.
- Saved workflow templates: support reusable specs/harnesses under a Pi workflow directory.
- Resume support: allow structured/dynamic workflows to resume/reuse completed phase artifacts after interruption.
- Mission workflow follow-ups: smarter repair planning, browser/computer-use QA adapters, final merge policy options, and larger dogfood tests.

## Notes

This package intentionally stores workflow runtime data outside the package under:

```text
~/.pi/agent/thread-phase/
```

Do not commit generated run logs or artifacts.
