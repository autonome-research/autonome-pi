# autonome-pi

Autonome's Pi package for shared extensions, workflow tooling, and skills.

## Contents

- `thread-phase-visualizer` — generic TUI monitor and event store for `thread-phase-ui/v1` workflow events.
- `detach` — `/detach` and `/detach-status` commands for handing an interactive Pi session off to tmux so it can survive an SSH logout.
- `codebase-exploration-workflow` — fanout codebase exploration workflow using Pi subagents.
- `code-review-workflow` — git diff/commit code review workflow using Pi subagents.
- `dynamic-workflows` — simple validated composer for ordered `agent`, `fanout`, `shell`, and `artifact` phases, plus a separate advanced scripted JavaScript tool.
- `mission-workflow` — Droid/Missions-style long-running software mission extension with plan approval, validation contracts, strict handoffs, per-feature worktrees/commits, command + adversarial validators, durable registry/resume, coverage artifacts, and repair loops.
- `skills/dynamic-workflows` and `skills/mission-workflow` — on-demand Pi skills that teach other sessions/configurations how to use these workflow tools safely.

## Install

```bash
pi install git:git@github.com:autonome-research/autonome-pi@v0.18.0
```

For active development:

```bash
pi install git:git@github.com:autonome-research/autonome-pi@main
```

To migrate an installation that still uses the old repository identity:

```bash
pi remove git:git@github.com:Code4me2/pi-thread-phase-tools@v0.12.0
pi install git:git@github.com:autonome-research/autonome-pi@v0.18.0
```

Pi identifies git packages by repository URL, so remove the old source before installing the renamed one to avoid loading both copies.

## Usage

- `/detach [--name <tmux-name>] [--now|--wait] [prompt]` hands the current session off to tmux; `/detach-status` reports the latest handoff. See [`detach/README.md`](detach/README.md).
- Select `/workflows` from the slash-command menu under the editor, or press `ctrl+shift+t`, to open the interactive thread-phase dashboard; select a run for observed command-ledger details or request cooperative cancellation via `x`. See [`docs/command-ledger-ui.md`](docs/command-ledger-ui.md) for controls, state semantics, token labels, and retention/privacy limits.
- Background dynamic workflows durably return control to the launching Pi session after success or failure; failed continuations identify failed phases/errors/partial artifacts, while user-cancelled runs never auto-continue. New hosted background agent work uses periodic main-agent progress reviews instead of an implicit wall-clock kill deadline; explicit timeouts remain hard limits. See [`docs/workflow-supervision.md`](docs/workflow-supervision.md).
- `/codebase-explore` starts codebase exploration in the background by default.
- `/code-review` runs code review workflows.
- `dynamic_workflow` composes validated subagent workflows directly from flat `agent`, `fanout`, `shell`, and `artifact` phases. `scripted_workflow` is the separate advanced unsandboxed JavaScript interface; `dynamic_thread_phase_workflow` is an inactive deprecated compatibility alias.
- `mission_workflow` plans and activates approved Droid/Missions-style software missions. Always run `action: "plan"` and get user approval before `action: "activate"`.
- Tool/API inspection remains available through `thread_phase_runs`.
- Workflow skills are included in the package and should load automatically when tasks ask for dynamic workflows, mission workflows, structured workflow specs, scripted JavaScript workflows, or multi-phase dynamic execution.

## Current status

Latest release: [`v0.18.0`](docs/releases/v0.18.0.md). Fully restart Pi after upgrading to load the updated native modules.

Recent changes:

- Recovered and completed the workflow-agnostic visualizer improvements on the renamed repository baseline.
- Added bounded/corruption-tolerant JSONL reads, immutable owner/session verification, aggregate ownership budgets, and crash-safe index reconciliation.
- Added interactive monitor search/filter/sort, responsive phase/fanout/artifact pagination, safe artifact editor actions, and consistent owner/stale displays.
- Added durable, deduplicated at-least-once continuation delivery with pending/delivered recovery across extension reloads and Pi session persistence boundaries.
- Added comprehensive visualizer projection, cancellation, continuation, session-scope, large-log, and TUI interaction tests.
- Renamed the package and repository from `pi-thread-phase-tools` to `autonome-pi`.
- Added the tmux-backed `/detach` extension and `/detach-status` command.
- Cooperative cancellation uses cancel request files under `~/.pi/agent/thread-phase/cancel/<runId>.json` instead of direct monitor PID killing.
- `dynamic_workflow` now accepts the workflow directly—no outer `spec` wrapper—and uses the clearer `agent`, `fanout`, `shell`, and `artifact` phase names.
- Permissions are explicit phase defaults/overrides: `r`, `w`, `rw`, and `rwx`; shell and Pi `bash` execution require `rwx`.
- Advanced unsandboxed JavaScript control flow uses `scripted_workflow`, which requires explicit `permissions: "rwx"`. Migrate `dynamic_workflow_harness` calls from `{ harness, harnessFile }` to `{ script, scriptFile }`; the old public tool name is no longer registered.
- `dynamic_thread_phase_workflow` remains registered for compatibility but is inactive by default, avoiding a duplicate legacy schema in normal model context.
- Structured specs have a reduced v2 contract with strict phase validation, bounded `attempts` and deterministic internal backoff, phase-local fanout concurrency, collision-safe artifacts, partial failure results, and background readiness acknowledgements containing `runId` + `pid`.
- New public hosted background dynamic/scripted launches carry immutable `supervisionMode: "main-agent"` ownership metadata. Their Pi agent subprocesses have no implicit wall-clock timer when no explicit phase/helper/workflow timeout exists; shells, foreground work, legacy/historical runs, and explicit deadlines retain bounded behavior.
- Reusable or operationally important workflows should graduate into standalone TypeScript extensions using thread-phase directly.
- Dynamic workflow runs carry system-generated chain provenance. A terminal successful or failed parent accepts at most one session-scoped successor through `after`; cancelled parents cannot continue a chain.
- Reusable structured workflows and self-contained scripted workflows can be loaded by safe template name from `~/.pi/agent/workflows/`; template loading is bounded, rejects traversal/symlinks, preserves provenance, and still enforces normal validation and permission ceilings.
- Structured workflows support fail-closed `resumeRunId` recovery through atomic checkpoint manifests and bounded, hashed phase-output artifacts; spec, cwd, model, session, phase identity, containment, size, and integrity must verify before reuse.
- The workflow dashboard is available through selectable `/workflows` and `ctrl+shift+t` entry points, shows one updating row per observed command under its phase or fanout item, retains terminal command details, and labels argument-only or malformed-end evidence as outcome unobserved rather than success.
- Usage events are aggregated into run, phase, and fanout-item summaries and rendered with output first, cache/input/output breakdowns in expanded monitor views, reasoning identified as an output subset, and inclusive totals labelled cumulative processed tokens rather than context length.
- `npm test` runs smoke coverage for extension load, permission denial before harness import, structured validation, JS harness mode, structured shell mode, usage projection, and mission registry/resume/strict-handoff checks.
- The package now ships workflow skills so fresh Pi sessions get progressive-disclosure guidance for dynamic workflows and mission workflows.
- Hardened `mission_workflow` with adversarial post-milestone validation, runner-owned handoff metadata, durable trusted checkpoints for resume, strict validation-cursor fingerprints/evidence checks, merge-blocking transient lockfile quarantine, stale `lastError` archival after successful resume/completion, cancellation-safe validation, contaminated-branch detection/reset, assertion coverage reports, generated-junk protection, transient `uv.lock` cleanup with audit artifacts, short content-addressed repair IDs, runner-provided handoff skeletons, compact result payloads, and capped repair loops.
- The generic visualizer now deduplicates repeated artifact paths, closes phase-event-only phases when a workflow reaches a terminal status, keeps compact run/monitor summaries focused on recent or active phases, and removes stale/dead or terminal workflows from the below-editor live-status widget.
- Thread-phase dependency is `^6.1.0`, using the built-in `node:sqlite` runtime plus authoritative lifecycle, supervised fanout, atomic terminal events, cancellation, ownership, heartbeat, defensive error normalization, and bounded cursor reconciliation.
- Workflow progress-review and timeout semantics are in `docs/workflow-supervision.md`. Mission continuation/failure-mode notes are in `docs/mission-workflow-continuation.md`; the DX/agent-X roadmap for making missions closer to a full software production pipeline is in `docs/mission-workflow-completeness-roadmap.md`.

## Remaining work

High-value follow-ups:

- Dynamic workflow hardening: add broader permission-matrix coverage.
- Usage budgets: optionally fail/stop workflows when projected token usage exceeds configured limits.
- Mission workflow follow-ups: validation categories/completion levels, operational-readiness contracts, heterogeneous model role policy, smarter repair planning, richer agent handoffs/shared mission notes, registry integrity/resume explain mode, external integration test conventions, and larger dogfood tests.

## Notes

This package intentionally stores workflow runtime data outside the package under:

```text
~/.pi/agent/thread-phase/
```

Do not commit generated run logs or artifacts.
