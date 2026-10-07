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

## Terminal handoff to chat

A background review deliberately launched by the hosting interactive Pi session (TUI or RPC tool call with a valid originating session) carries an explicit `--continuation terminal --session-id <id>` opt-in and hands its success **or** failure back to that conversation through the visualizer's durable `continuationMode: "terminal"` path. Foreground reviews return to their caller directly, and the generated post-commit hook, bare CLI runs, and print/JSON worker contexts never carry the opt-in: they stay notification-only. The `PI_CODE_REVIEW_BACKGROUND` marker and inherited `PI_SESSION_*` environment alone never authorize a handoff. Cancellation and committed-successor chains never auto-continue; a failure handoff reports blockers/partial results and does not authorize recovery work.

Disable the hook temporarily:

```bash
PI_CODE_REVIEW_DISABLE=1 git commit ...
```

## Direct CLI

```bash
~/.pi/agent/extensions/code-review-workflow/bin/code-review-workflow.mjs review --cwd /path/to/repo --mode last_commit
~/.pi/agent/extensions/code-review-workflow/bin/code-review-workflow.mjs install-hook --cwd /path/to/repo
```

Direct background runs are notification-only by default. To request the terminal handoff explicitly (normally done by the Pi extension, not by hand):

```bash
code-review-workflow.mjs review --cwd /path/to/repo --background --session-id <owning-session-id> --continuation terminal
```

`--continuation terminal` is rejected without `--background` and `--session-id`.

Environment knobs:

- `PI_CODE_REVIEW_PI_BIN`: path to the `pi` binary.
- `PI_CODE_REVIEW_DIFF_LIMIT`: max diff bytes included in the prompt before truncation.
- `PI_CODE_REVIEW_TIMEOUT_MS`: reviewer subprocess timeout.
- `PI_CODE_REVIEW_DISABLE=1`: disable installed hooks for one command.
- `--continuation terminal`: explicit terminal-handoff opt-in; only valid with `--background` and `--session-id`. Never set by the generated hook.
