# code-review-workflow pi extension

A Pi-callable code review workflow that can also run automatically after each git commit.

This workflow now emits generic `thread-phase-ui/v1` events through the sibling `thread-phase-visualizer` abstraction instead of owning its own watcher/UI layer.

## Pi usage

- Tool: `code_review_workflow`
- Slash command: `/code-review`

Examples:

```text
/code-review                 # review HEAD
/code-review staged          # review staged changes
/code-review working         # review unstaged diff
/code-review range main..HEAD
/code-review --cwd /repo staged
/code-review install         # install post-commit hook for this repo
/code-review status
```

The default directory follows simple `cd <dir>` user-bash commands issued inside the Pi session. Use `--cwd /path` to override.

## Git hook behavior

`/code-review install` appends a marked block to `.git/hooks/post-commit` in the current repo. After each commit, the hook starts a background review and writes reports to:

```text
.git/pi-code-reviews/<commit>.md
```

Workflow telemetry is emitted to the generic store:

```text
~/.pi/agent/thread-phase/index.jsonl
~/.pi/agent/thread-phase/runs/<runId>.jsonl
```

The generic `thread-phase-visualizer` extension watches that store and posts completed workflow summaries into Pi sessions.

Disable the hook temporarily:

```bash
PI_CODE_REVIEW_DISABLE=1 git commit ...
```

## Direct CLI

```bash
~/.pi/agent/extensions/code-review-workflow/bin/code-review-workflow.mjs review --cwd /path/to/repo --mode last_commit
~/.pi/agent/extensions/code-review-workflow/bin/code-review-workflow.mjs install-hook --cwd /path/to/repo
```

Environment knobs:

- `PI_CODE_REVIEW_PI_BIN`: path to the `pi` binary.
- `PI_CODE_REVIEW_DIFF_LIMIT`: max diff bytes included in the prompt before truncation.
- `PI_CODE_REVIEW_TIMEOUT_MS`: reviewer subprocess timeout.
- `PI_CODE_REVIEW_DISABLE=1`: disable installed hooks for one command.
