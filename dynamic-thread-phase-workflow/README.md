# dynamic-workflows

Status: experimental-but-usable as of `pi-thread-phase-tools@v0.8.0`.

Executes dynamic workflows built live in chat. The implementation uses thread-phase internally for structured execution, cancellation, events, and artifacts, but the user-facing concept is a Pi dynamic workflow.

## Tools

- `dynamic_workflow` — preferred tool.
- `dynamic_thread_phase_workflow` — deprecated compatibility alias.

CLI entrypoints:

```bash
~/.pi/agent/extensions/dynamic-thread-phase-workflow/bin/dynamic-workflow.mjs --spec-file spec.json
~/.pi/agent/extensions/dynamic-thread-phase-workflow/bin/dynamic-workflow.mjs --js-file workflow.mjs --permissions rwx
```

The older `dynamic-thread-phase-workflow.mjs` entrypoint remains available.

Use `background: true` for long workflows. Runs emit generic `thread-phase-ui/v1` events, so `ctrl+shift+t` can monitor/cancel them. Dynamic workflows do not auto-continue the chat by default; pass `autoContinue: true` when you want a successful background run to queue a follow-up.

## Modes

### Structured spec mode

Default mode. The agent supplies a constrained JSON spec with phases. This is best for auditability, replay, permissions, and monitor visualization.

Supported phase types:

- `shell`
- `pi`
- `fanout_pi`
- `artifact`

### JavaScript harness mode

Advanced mode. The agent supplies a JavaScript module for richer control flow: loops, branches, tournaments, custom scoring, or unusual orchestration.

Harness mode requires workflow `permissions: "rwx"` because generated JavaScript executes as Node code. The harness should use the provided helpers so the monitor still sees phases, artifacts, cancellation, and fanout progress.

```js
export default async function workflow(ctx) {
  const files = await ctx.shell("find src -type f | head -20", { name: "list-files" });
  const reviews = await ctx.fanout(files.split(/\n/).filter(Boolean), {
    name: "review-files",
    concurrency: 3,
    promptTemplate: "Review {{item}} for maintainability risks. Do not modify files.",
    pi: { permissions: "r" }
  });
  await ctx.artifact("Review report", reviews.join("\n\n---\n\n"));
}
```

Harness helpers:

- `ctx.phase(name, fn)`
- `ctx.shell(command, options)`
- `ctx.pi(prompt, options)`
- `ctx.fanout(items, options)`
- `ctx.artifact(title, content, options)`
- `ctx.emit(kind, data)`
- `ctx.cancelled()` / `ctx.signal`

## Permissions

Dynamic workflows use compact `rwx` capability declarations. There is no per-run `permissionMode` field; the extension executes declared capabilities automatically, bounded by its configured max policy.

```json
{ "permissions": "rwx" }
```

Mapping:

- `r` enables Pi `read`, `grep`, `find`, `ls`
- `w` enables Pi `edit`, `write`
- shell phases, Pi `bash`, and JavaScript harness mode require full `rwx` because command/code execution is not sandboxed

Defaults are controlled by environment:

- `PI_DYNAMIC_WORKFLOW_DEFAULT_PERMISSIONS` default: `r`
- `PI_DYNAMIC_WORKFLOW_MAX_PERMISSIONS` default: `rwx`
- `PI_DYNAMIC_WORKFLOW_PI_BIN` optional Pi binary override

Legacy `PI_DYNAMIC_THREAD_PHASE_*` environment variables remain supported as fallbacks.

## Recent stabilization notes

- Harness mode requires explicit `permissions: "rwx"`; omission fails before import.
- Harness permissions are checked against `PI_DYNAMIC_WORKFLOW_MAX_PERMISSIONS` before importing generated JavaScript, so denied harnesses do not run top-level module side effects.
- Structured tool-level `permissions` are merged into the spec when absent and rejected on conflict.
- `phase.tools` must be an array of supported tool names.
- Background launches validate before detaching and require a valid `{ ok: true, background: true, pid }` acknowledgement.
- Dynamic workflows do not auto-continue by default; use `autoContinue: true`.

## Remaining work

- Expand automated tests for alias registration introspection, background validation, harness cancellation, broader permission matrices, and fanout terminal events.
- Add saved workflow templates and a command/tool to list/run them.
- Add resume/reuse semantics for structured workflows after interruption.
- Add worktree isolation helpers for patch/eval workflows.
- Add usage budgets using visualizer-projected usage summaries.
- Consider moving implementation files/folder to `dynamic-workflows` after a compatibility window; current folder and legacy tool remain for backwards compatibility.

## Structured phase examples

### `shell`

```json
{ "type": "shell", "name": "list-files", "permissions": "rwx", "command": "find src -maxdepth 2 -type f", "artifact": true }
```

### `pi`

```json
{
  "type": "pi",
  "name": "summarize-src",
  "permissions": "r",
  "prompt": "Summarize the src directory. Files:\n{{output:list-files}}"
}
```

### `fanout_pi`

```json
{
  "type": "fanout_pi",
  "name": "review-files",
  "itemsFrom": "list-files",
  "concurrency": 3,
  "promptTemplate": "Review {{item}} for maintainability risks. Do not modify files."
}
```

### `artifact`

```json
{ "type": "artifact", "name": "final-report", "title": "Report", "from": "summarize-src" }
```
