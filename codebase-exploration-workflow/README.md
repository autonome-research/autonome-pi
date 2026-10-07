# codebase-exploration-workflow

A read-only fanout workflow for exploring a project by subdirectory. It emits generic `thread-phase-ui/v1` events consumed by the sibling `thread-phase-visualizer` extension.

## Pi usage

- Tool: `codebase_exploration_workflow`
- Command: `/codebase-explore`

The default directory follows simple `cd <dir>` user-bash commands issued inside the Pi session. If you start Pi in `~/`, run `cd chiya-library/`, then run `/codebase-explore`, it explores `~/chiya-library`. Use `--cwd /path` to override.

Examples:

```text
/codebase-explore --dirs src,tests,docs --concurrency 2
/codebase-explore --cwd /repo --maxDirs 8
/codebase-explore --agent mock --dirs src,tests,docs --delay 1000
```

Defaults:

- `--agent pi` for real read-only Pi subagents
- `--concurrency 3`
- `--maxDirs 8`

Use `--agent mock` only for fast UI testing. `--agent pi` launches read-only Pi subagents with `read,grep,find,ls` enabled.

## Direct CLI

```bash
~/.pi/agent/extensions/codebase-exploration-workflow/bin/codebase-exploration-workflow.mjs --cwd "$PWD" --dirs src,tests,docs --concurrency 2
~/.pi/agent/extensions/codebase-exploration-workflow/bin/codebase-exploration-workflow.mjs --cwd "$PWD" --agent mock --dirs src,tests,docs
```

## Visualizer output

Events are written to:

```text
~/.pi/agent/thread-phase/index.jsonl
~/.pi/agent/thread-phase/runs/<runId>.jsonl
```

Artifacts are written under:

```text
~/.pi/agent/thread-phase/artifacts/<runId>/
```

## Terminal handoff to chat

A background exploration deliberately launched by the hosting interactive Pi session (TUI or RPC tool call, or `/codebase-explore` without `--foreground`, with a valid originating session) carries an explicit `--continuation terminal --session-id <id>` opt-in and hands its success **or** failure back to that conversation through the visualizer's durable `continuationMode: "terminal"` path. Foreground runs return to their caller directly, and bare CLI runs or print/JSON worker contexts never carry the opt-in: they stay notification-only. The `PI_CODEBASE_EXPLORATION_BACKGROUND` marker and inherited `PI_SESSION_*` environment alone never authorize a handoff. Cancellation never auto-continues; a failure handoff reports blockers/partial results and does not authorize recovery work.

Direct background runs are notification-only by default. Explicit opt-in (normally set by the Pi extension, not by hand):

```bash
codebase-exploration-workflow.mjs --cwd "$PWD" --background --session-id <owning-session-id> --continuation terminal
```

`--continuation terminal` is rejected without `--background` and `--session-id`.
