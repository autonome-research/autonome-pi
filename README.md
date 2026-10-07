# autonome-pi

Autonome's Pi package for shared extensions, workflow tooling, and skills.

## Contents

- `thread-phase-visualizer` — generic TUI monitor and event store for `thread-phase-ui/v1` workflow events.
- `thread-phase-terminal-title` — separately opt-in, read-only TUI terminal-title projection of the visualizer's status bridge.
- `codebase-exploration-workflow` — fanout codebase exploration workflow using Pi subagents.
- `code-review-workflow` — git diff/commit code review workflow using Pi subagents.
- `dynamic-workflows` — simple validated composer for ordered `agent`, `fanout`, `shell`, and `artifact` phases, plus a separate advanced scripted JavaScript tool.
- `skills/dynamic-workflows` — on-demand Pi skill that teaches other sessions/configurations how to use these workflow tools safely.

## Install

```bash
pi install git:git@github.com:autonome-research/autonome-pi@v0.18.3
```

For active development:

```bash
pi install git:git@github.com:autonome-research/autonome-pi@main
```

To migrate an installation that still uses the old repository identity:

```bash
pi remove git:git@github.com:Code4me2/pi-thread-phase-tools@v0.12.0
pi install git:git@github.com:autonome-research/autonome-pi@v0.18.3
```

Pi identifies git packages by repository URL, so remove the old source before installing the renamed one to avoid loading both copies.

## Usage

- Select `/workflows` from the slash-command menu under the editor, or press `ctrl+shift+t`, to open the interactive thread-phase dashboard; select a run for observed command-ledger details or request cooperative cancellation via `x`. See [`docs/command-ledger-ui.md`](docs/command-ledger-ui.md) for controls, state semantics, token labels, and retention/privacy limits.
- Fresh background dynamic workflows return control after success or failure; user-cancelled runs never auto-continue. Old or uncertain handoffs stay visible in `/workflows`; press `r` to prepare an explicit `/workflow-handoff <runId>` request. Background Pi agents have no implicit deadline; foreground agents and shells retain their default bound. Progress is passive: periodic main-agent prompts are retired, including existing schedules. `progressReviewIntervalMs` is a deprecated compatibility field. See [`docs/workflow-supervision.md`](docs/workflow-supervision.md).
- `/codebase-explore` starts codebase exploration in the background by default.
- `/code-review` runs code review workflows.
- `dynamic_workflow` composes validated subagent workflows directly from flat `agent`, `fanout`, `shell`, and `artifact` phases. `scripted_workflow` is the separate advanced unsandboxed JavaScript interface; `dynamic_thread_phase_workflow` is an inactive deprecated compatibility alias.
- Tool/API inspection remains available through `thread_phase_runs`.
- Optional terminal-title symbols require both `PI_THREAD_PHASE_STATUS_BRIDGE=1` and `PI_THREAD_PHASE_TERMINAL_TITLE=1` before a full Pi restart. They use `⎊` for attention/unknown, exact `⚙︎` for active work, and `⌘` only for recent unaccompanied success while preserving Pi's session/cwd title. See [`thread-phase-terminal-title/README.md`](thread-phase-terminal-title/README.md) for precedence, sanitization, lifecycle, and terminal caveats.
- Workflow skills are included in the package and should load automatically when tasks ask for dynamic workflows, structured workflow specs, scripted JavaScript workflows, or multi-phase dynamic execution.

## Footer status coexistence

Autonome publishes text-free live-workflow glyphs through Pi's `setStatus("thread-phase", ...)` API and clears only that key when idle. It does not replace or reposition Pi's footer. Stock Pi controls placement and normally renders extension statuses on a third footer status row. The separately opt-in terminal-title consumer uses only `setTitle()` and does not alter footer/status/widget APIs.

The optional [RJLF Pi extensions](https://github.com/Code4me2/rjlf-pi-extensions) source patch is a separate operator action that moves **all** extension statuses onto the cwd/session row. Autonome neither installs nor applies it. RJLF's local/cloud chip is published by its separate `model-local-status` extension and does not depend on the patch. The extensions own distinct keys (`thread-phase` and `rjlf-model-class`); neither should replace or clear the other's status.

Use RJLF's read-only `/rjlf-status` command and its [footer diagnostics and migration guide](https://github.com/Code4me2/rjlf-pi-extensions/blob/main/docs/footer-diagnostics.md) to inspect publication/patch state or remove a legacy standalone `model-class` publisher. That guide documents the explicit `npm run patch:check`, `npm run patch:apply`, and `npm run patch:restore` commands; none are run by Autonome.

## Current status

Latest release: [`v0.18.3`](docs/releases/v0.18.3.md). Back up continuation state and fully restart Pi after upgrading; old hosts cannot safely share the new v4 continuation store.

The mission workflow extension was removed after v0.18.3: the `mission-workflow` implementation, prompts, mission skill, mission-only smoke checks, and active mission design/roadmap docs are gone. The `/detach` tmux handoff extension was removed as the wrong layer: its implementation, dedicated smoke checks, and manifest/keyword entries are gone, and the manifest now lists the five remaining extensions above. Saved mission registries, plans, worktrees, sessions, logs, artifacts, and any detach-wrapper state outside tracked source (for example under `~/.pi/agent/`) are user data and are preserved untouched; historical release notes under [`docs/releases/`](docs/releases/) remain as history.

Recent changes:

- Recovered and completed the workflow-agnostic visualizer improvements on the renamed repository baseline.
- Added bounded/corruption-tolerant JSONL reads, immutable owner/session verification, aggregate ownership budgets, and crash-safe index reconciliation.
- Added interactive monitor search/filter/sort, responsive phase/fanout/artifact pagination, safe artifact editor actions, and consistent owner/stale displays.
- Terminal handoffs use stable session/run identities, session-wide receipt reconciliation, explicit submission state and per-run card deduplication. Old or uncertain deliveries require explicit action instead of automatic replay.
- Session-hosted background reviews and explorations now request terminal handoffs explicitly. Foreground calls and unattended hooks keep their notification-only defaults; false-valued background environment markers no longer bypass validation or prevent detachment.
- Added comprehensive visualizer projection, cancellation, continuation, session-scope, large-log, and TUI interaction tests.
- Renamed the package and repository from `pi-thread-phase-tools` to `autonome-pi`.
- Cooperative cancellation uses cancel request files under `~/.pi/agent/thread-phase/cancel/<runId>.json` instead of direct monitor PID killing.
- `dynamic_workflow` now accepts the workflow directly—no outer `spec` wrapper—and uses the clearer `agent`, `fanout`, `shell`, and `artifact` phase names.
- Permissions are explicit phase defaults/overrides: `r`, `w`, `rw`, and `rwx`; shell and Pi `bash` execution require `rwx`.
- Advanced unsandboxed JavaScript control flow uses `scripted_workflow`, which requires explicit `permissions: "rwx"`. Migrate `dynamic_workflow_harness` calls from `{ harness, harnessFile }` to `{ script, scriptFile }`; the old public tool name is no longer registered.
- `dynamic_thread_phase_workflow` remains registered for compatibility but is inactive by default, avoiding a duplicate legacy schema in normal model context.
- Structured specs have a reduced v2 contract with strict phase validation, bounded `attempts` and deterministic internal backoff, phase-local fanout concurrency, collision-safe artifacts, partial failure results, and background readiness acknowledgements containing `runId` + `pid`.
- Hosted background dynamic/scripted launches carry immutable `supervisionMode: "main-agent"` ownership metadata. Background Pi agents, including CLI-launched ones, have no implicit wall-clock timer without an explicit timeout; shells and foreground work retain their default bounds. Periodic review prompts are retired; old schedules and cadence metadata are inert.
- Reusable or operationally important workflows should graduate into standalone TypeScript extensions using thread-phase directly.
- Dynamic workflow runs carry system-generated chain provenance. A terminal successful or failed parent accepts at most one session-scoped successor through `after`; cancelled parents cannot continue a chain.
- Reusable structured workflows and self-contained scripted workflows can be loaded by safe template name from `~/.pi/agent/workflows/`; template loading is bounded, rejects traversal/symlinks, preserves provenance, and still enforces normal validation and permission ceilings.
- Structured workflows support fail-closed `resumeRunId` recovery through atomic checkpoint manifests and bounded, hashed phase-output artifacts; spec, cwd, model, session, phase identity, containment, size, and integrity must verify before reuse.
- The workflow dashboard is available through selectable `/workflows` and `ctrl+shift+t` entry points, shows one updating row per observed command under its phase or fanout item, retains terminal command details, and labels argument-only or malformed-end evidence as outcome unobserved rather than success.
- Usage events are aggregated into run, phase, and fanout-item summaries and rendered with output first, cache/input/output breakdowns in expanded monitor views, reasoning identified as an output subset, and inclusive totals labelled cumulative processed tokens rather than context length.
- `npm test` runs smoke coverage for extension load, permission denial before harness import, structured validation, JS harness mode, structured shell mode, and usage projection.
- The package ships a workflow skill so fresh Pi sessions get progressive-disclosure guidance for dynamic workflows.
- The generic visualizer now deduplicates repeated artifact paths, closes phase-event-only phases when a workflow reaches a terminal status, keeps compact run/monitor summaries focused on recent or active phases, and removes stale/dead or terminal workflows from the below-editor live-status widget.
- Thread-phase dependency is `^6.1.0`, using the built-in `node:sqlite` runtime plus authoritative lifecycle, supervised fanout, atomic terminal events, cancellation, ownership, heartbeat, defensive error normalization, and bounded cursor reconciliation.
- Workflow progress-review and timeout semantics are in `docs/workflow-supervision.md`.

## Remaining work

High-value follow-ups:

- Dynamic workflow hardening: add broader permission-matrix coverage.
- Usage budgets: optionally fail/stop workflows when projected token usage exceeds configured limits.

## Notes

This package intentionally stores workflow runtime data outside the package under:

```text
~/.pi/agent/thread-phase/
```

Do not commit generated run logs or artifacts.
