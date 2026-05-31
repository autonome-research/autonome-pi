# codebase-exploration-workflow

A read-only fanout workflow for exploring a project by subdirectory. It emits generic `thread-phase-ui/v1` events consumed by the sibling `thread-phase-visualizer` extension.

## Pi usage

- Tool: `codebase_exploration_workflow`
- Command: `/codebase-explore`

Examples:

```text
/codebase-explore --agent mock --dirs src,tests,docs --delay 1000
/codebase-explore --agent pi --dirs src,tests,docs --concurrency 2
/codebase-explore --cwd /repo --maxDirs 8
```

Defaults:

- `--agent mock` for UI testing
- `--concurrency 3`
- `--maxDirs 8`

`--agent pi` launches read-only Pi subagents with `read,grep,find,ls` enabled.

## Direct CLI

```bash
~/.pi/agent/extensions/codebase-exploration-workflow/bin/codebase-exploration-workflow.mjs --cwd "$PWD" --agent mock --dirs src,tests,docs
~/.pi/agent/extensions/codebase-exploration-workflow/bin/codebase-exploration-workflow.mjs --cwd "$PWD" --agent pi --dirs src,tests,docs --concurrency 2
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
