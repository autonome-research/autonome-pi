# Detach extension

Keeps an interactive Pi session available after an SSH logout by using tmux.

## Commands

```text
/detach [--name <tmux-name>] [--now|--wait] [prompt]
/detach-status
```

- **Already inside tmux:** `/detach` detaches the current tmux client. The same Pi process continues running. `--name` renames the current tmux session before detaching.
- **Outside tmux:** `/detach` starts a detached tmux handoff, shuts down the current Pi process, waits for it to exit, and resumes the same session file in a new Pi process.
- `--name` chooses the tmux session name. Otherwise a stable project/session-based name is generated.
- By default, detach is graceful: Pi drains active and queued work before shutdown. `--wait` makes that choice explicit. Outside tmux, the waiting wrapper is created first. A settled marker suppresses unnecessary follow-up after normal completion; if SSH logout interrupts Pi before that marker, the resumed session receives a cautious continuation prompt.
- `--now` aborts current work after detach/handoff succeeds. When work is actually interrupted and no prompt is supplied, the session receives a cautious continuation prompt. Outside tmux, `--now` is rejected while steering or follow-up messages are queued so those messages are not lost during process replacement.
- A positional prompt is sent to the resumed Pi process. Use `--` before a prompt that starts with `-`.
- `/detach-status` reports the latest handoff recorded in the current Pi session.

Reattach with:

```bash
tmux attach -t =<name>
```

## Requirements and limitations

- The command is available only in Pi's interactive TUI mode.
- `tmux` must be installed and available on `PATH`.
- Outside tmux, the running process cannot be migrated. This is a graceful handoff to a fresh Pi process on the same persisted session.
- Ephemeral sessions created with `--no-session` can only be detached when Pi was already started inside tmux.
- Before shutdown, the extension runs the resumed command with `--version`, starts the wrapper in tmux, and waits for a wrapper-ready acknowledgement. This catches missing/invalid commands and immediate wrapper failures, though failures after the old process exits can never be ruled out completely.
- The resumed process receives the current effective `--tools` allowlist and current model/thinking level, plus supported system-prompt, extension, skill, theme, trust, and resource-disabling flags. Local resource paths are made absolute against the original launch directory. This prevents a restricted session from silently regaining default write/shell tools or loading a different relative resource. Unknown extension flags are rejected rather than dropped. A CLI `--api-key` is not copied into the wrapper; use Pi auth storage or an environment variable instead.
- The handoff preserves selected environment variables so an existing tmux server can access the same toolchain and built-in provider credentials. Only explicit runtime/provider prefixes are copied; terminal-specific `TERM` and `GPG_TTY` values and unrelated password/secret variables are not. Add custom-provider variable names with comma-separated `PI_DETACH_PRESERVE_ENV`. Preserved values are written to a mode-`0700` self-deleting wrapper under the configured Pi agent directory (`PI_CODING_AGENT_DIR`, or its default). The wrapper is also removed if tmux startup fails.
- Set `PI_DETACH_PI_COMMAND` to override the resumed command, for example `mise exec -- pi`. The command must accept Pi's `--version` and `--session` arguments.
