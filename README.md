# pi-thread-phase-tools

Private Pi package for thread-phase workflow visualization and example workflows.

## Contents

- `thread-phase-visualizer` — generic TUI monitor and event store for `thread-phase-ui/v1` workflow events.
- `codebase-exploration-workflow` — fanout codebase exploration workflow using Pi subagents.
- `code-review-workflow` — git diff/commit code review workflow using Pi subagents.
- `dynamic-workflows` — validated ad-hoc workflow runner for dynamic workflows planned in chat, with structured spec mode and advanced JavaScript harness mode.

## Install

```bash
pi install git:git@github.com:Code4me2/pi-thread-phase-tools@v0.7.1
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
- Tool/API inspection remains available through `thread_phase_runs`.

## Current status

Latest release: `v0.7.1`.

Recent changes:

- Cooperative cancellation uses cancel request files under `~/.pi/agent/thread-phase/cancel/<runId>.json` instead of direct monitor PID killing.
- `dynamic_workflow` is the preferred dynamic workflow tool; `dynamic_thread_phase_workflow` remains as a deprecated alias.
- Dynamic workflows support two modes:
  - structured spec mode for validated/auditable workflows,
  - JavaScript harness mode for richer control flow. Harness mode requires explicit `permissions: "rwx"`.
- Dynamic workflows do not auto-continue by default; pass `autoContinue: true` for successful-run follow-up.
- Thread-phase dependency is `^4.0.0`.

## Remaining work

High-value follow-ups:

- Usage accounting: aggregate `kind: "usage"` events into run/phase summaries and render compact usage in the monitor and completion messages.
- Bounded JSONL reads: replace full-file index/run reads with tail/offset reads for large stores.
- Dynamic workflow hardening: add tests for harness cancellation, background invalid specs, permission matrices, and fanout terminal states.
- Saved workflow templates: support reusable specs/harnesses under a Pi workflow directory.
- Resume support: allow structured workflows to resume/reuse completed phase artifacts after interruption.
- Worktree isolation: optional per-phase/per-fanout worktrees for patch/eval workflows.

## Notes

This package intentionally stores workflow runtime data outside the package under:

```text
~/.pi/agent/thread-phase/
```

Do not commit generated run logs or artifacts.
