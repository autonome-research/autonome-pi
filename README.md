# pi-thread-phase-tools

Private Pi package for thread-phase workflow visualization and example workflows.

## Contents

- `thread-phase-visualizer` — generic TUI monitor and event store for `thread-phase-ui/v1` workflow events.
- `codebase-exploration-workflow` — fanout codebase exploration workflow using Pi subagents.
- `code-review-workflow` — git diff/commit code review workflow using Pi subagents.
- `dynamic-workflows` — validated ad-hoc workflow runner for dynamic workflows planned in chat, with structured spec mode and advanced JavaScript harness mode.

## Install

```bash
pi install git:git@github.com:Code4me2/pi-thread-phase-tools@v0.1.0
```

For active development:

```bash
pi install git:git@github.com:Code4me2/pi-thread-phase-tools@main
```

## Usage

- `ctrl+shift+t` opens the thread-phase monitor for workflows launched by the current Pi session, including cooperative cancellation via `x`.
- Background/session-launched workflows automatically queue a session follow-up so the assistant can summarize results and continue after the current generation finishes.
- `/codebase-explore` starts codebase exploration in the background by default.
- `/code-review` runs code review workflows.
- `dynamic_workflow` runs validated dynamic workflows from structured specs or JavaScript harnesses. `dynamic_thread_phase_workflow` remains as a deprecated compatibility alias.
- Tool/API inspection remains available through `thread_phase_runs`.

## Notes

This package intentionally stores workflow runtime data outside the package under:

```text
~/.pi/agent/thread-phase/
```

Do not commit generated run logs or artifacts.
