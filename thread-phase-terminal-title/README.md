# thread-phase-terminal-title

Small read-only Pi TUI extension that projects the optional thread-phase status bridge into the terminal title. It registers only session lifecycle handlers: no tools, commands, workflow tracking, footer/status/widget changes, renderer, animation, color, or direct terminal escape output.

It is loaded immediately after `thread-phase-visualizer` by this package and remains inert unless both flags are set before Pi starts:

```bash
export PI_THREAD_PHASE_STATUS_BRIDGE=1
export PI_THREAD_PHASE_TERMINAL_TITLE=1
# Optional; must be absolute:
export PI_THREAD_PHASE_STATUS_BRIDGE_DIR=/private/local/path
pi
```

A full Pi process restart is recommended after changing these flags or native `.mjs` files. A title-only configuration may show one warning but does not claim the title. Bridge-only, disabled, RPC, print, and JSON sessions create no title reader timer and perform no title writes. The extension does not enable the bridge itself or modify settings/environment variables.

The consumer reads the current Pi session scope through `ctx.sessionManager.getSessionId()` and uses the bridge's aggregate counters. Unknown/unavailable/malformed/stale/rolled-back bridge state, unknown active work, recent failure, recent cancellation, and recent unknown-terminal work all project to attention. Otherwise running projects to active, recent success to completed, and no work to idle. Running plus a recent success remains active; any issue takes precedence. Cancellation, failure, and unknown-terminal remain distinct bridge outcomes—the shared title glyph means only attention.

```text
attention: ⎊ π - [session - ]cwd
active:    ⚙︎ π - [session - ]cwd
completed: ⌘ π - [session - ]cwd
idle:        π - [session - ]cwd
```

The terminal-result window remains exactly 60 seconds. The reader is polled every five seconds, including while no workflow event arrives, and a title is written only when its derived value changes or after a justified Pi title lifecycle write (initial handoff or rename). Polling is unref'd and performs no animation.

Every session/cwd value passed by this extension to `ctx.ui.setTitle()` has C0/C1 controls removed, is truncated at grapheme boundaries to 96 UTF-8 bytes independently, and the full payload is bounded to 240 bytes. The fixed prefix is reserved and never truncated. The base uses Pi v0.85.1's stock-compatible `π - cwd` / `π - session - cwd` shape and the session manager's cwd basename.

## Lifecycle and limitations

The initial reconciliation is delayed briefly because Pi writes its stock title after binding extensions. Rename reconciliation runs after Pi's `session_info_changed` stock write. Session replacement/reload cancels and invalidates old callbacks before a new delayed handoff. Clean shutdown cancels timers first and restores a sanitized stock-compatible title only if this instance owned a non-idle title.

Pi exposes no title getter, ownership stack, or composition API. Title ownership is last-writer-wins, so this extension cannot preserve an arbitrary prior title or safely compose with another title extension. It does not repeatedly reassert an unchanged title to fight another owner. Pi's own v0.85.1 stock writes are independently unsanitized and may appear briefly before this extension's handoff; fixing that would require an excluded core patch. Abrupt process death can skip restoration.

The extension uses only `ctx.ui.setTitle()`. Unicode glyph appearance and whether a tab/window follows dynamic titles depend on terminal fonts, pinning, and multiplexer/cmux policy; there is no blanket tmux/screen/cmux guarantee. Mac Terminal, Ghostty, and cmux receive ordinary Unicode title text without terminal-specific APIs.
