# dynamic-workflows

Status: experimental but usable.

Executes deterministic subagent workflows built live in chat. “Deterministic” describes the encoded topology—phase order, references, concurrency, retries, permissions, and terminal behavior—not model output. Structured workflows are validated and compiled into thread-phase phases; complex reusable workflows should graduate into standalone TypeScript extensions rather than indefinitely growing a chat-authored spec.

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

Default mode. The agent supplies a constrained `pi-dynamic-workflow/v1` JSON spec with phases. This is the preferred way to deploy bounded Pi subagents reliably: the full schema and cross-phase references are validated before execution or background detachment.

Supported phase types:

- `shell`
- `pi`
- `fanout_pi`
- `artifact`

### JavaScript harness mode

Advanced mode. The agent supplies a JavaScript module for richer control flow: loops, branches, tournaments, custom scoring, or unusual orchestration.

Harness mode requires workflow `permissions: "rwx"` because generated JavaScript executes as arbitrary Node code. `rwx` is an acknowledgement, not a sandbox. Cancellation is cooperative for harness code itself; helper-launched subprocesses receive the workflow signal. Prefer a standalone extension when logic is important, reusable, or long-lived.

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

## Subprocess output and timeout behavior

Subprocess output is bounded while it is being read, rather than truncated only after process exit:

- Generic shell stdout/stderr capture retains at most 1 MB per stream and marks truncated output.
- The Pi tool wrapper also bounds the dynamic runner's stdout/stderr to 1 MB per stream.
- `pi --mode json` output is parsed incrementally. Cumulative `message_update` events are discarded instead of being retained for the lifetime of the phase.
- A single Pi NDJSON record is capped at 4 MB. Oversized or malformed records are counted in the phase result under `piJson`; a later valid final message can still complete the phase.
- Fanout concurrency is capped at 64 and each fanout is capped at 1,000 items, including lists resolved through `itemsFrom` and JavaScript harness fanouts.

The workflow-level `timeoutMs` is the default for shell and Pi phases. A phase can override it with its own positive integer `timeoutMs`:

```json
{
  "name": "bounded-example",
  "permissions": "rwx",
  "timeoutMs": 600000,
  "phases": [
    { "type": "shell", "name": "quick-check", "timeoutMs": 30000, "command": "npm test" }
  ]
}
```

Timeouts use a phase-local abort controller composed with the workflow cancellation signal. The child receives `SIGTERM`, followed by `SIGKILL` after the five-second grace period if needed. The Pi tool wrapper waits eight seconds before force-killing the workflow runner, leaving enough time for the runner to escalate and reap its detached child process groups. Results distinguish `timedOut` from operator cancellation and preserve `code`, `signal`, `durationMs`, and structured `termination` metadata. A timeout is reported directly—for example, `pi timed out after 300000 ms; terminated with SIGTERM`—rather than as generic exit 143.

Generated specs and inline harnesses use an internal cleanup handshake. Foreground inputs are removed after execution; detached inputs are removed after the background runner has loaded them. Harness source is copied into the run artifact directory before cleanup, so the `Workflow harness source` artifact is durable. User-supplied harness files are copied for the audit artifact but are never deleted.

## Recent stabilization notes

- Harness mode requires explicit `permissions: "rwx"`; omission fails before import.
- Harness permissions are checked against `PI_DYNAMIC_WORKFLOW_MAX_PERMISSIONS` before importing generated JavaScript, so denied harnesses do not run top-level module side effects.
- Structured tool-level `permissions` are merged into the spec when absent and rejected on conflict.
- `phase.tools` must be an array of supported tool names.
- Background launches validate before detaching, preflight harness paths as readable regular files, and wait for the child to create a durable run. The acknowledgement contains `{ ok: true, ready: true, background: true, runId, pid }`.
- Structured references must point to earlier phases; unknown fields and conflicting `items`/`itemsFrom` or `content`/`from` sources are rejected.
- Fanout concurrency is bounded, sibling workers settle before terminal failure, and default artifact names include index/hash collision protection.
- Successful, failed, and cancelled runs write `workflow-result.json`; non-success results are labeled partial.
- Dynamic workflows do not auto-continue by default; use `autoContinue: true`.
- Subprocess capture is byte-bounded at ingestion, and Pi NDJSON is parsed incrementally to avoid cumulative-event memory growth.
- Timeout, cancellation, exit-code, and terminating-signal outcomes are recorded separately.

## Remaining work

- Expand automated tests for alias registration introspection, background validation, harness cancellation, broader permission matrices, and fanout terminal events.
- Add saved workflow templates and a command/tool to list/run them.
- Add resume/reuse semantics for structured workflows after interruption.
- Add worktree isolation helpers for patch/eval workflows.
- Add usage budgets using visualizer-projected usage summaries.
- Consider moving implementation files/folder to `dynamic-workflows` after a compatibility window; current folder and legacy tool remain for backwards compatibility.

## Structured workflow contract

Top-level fields:

- `schema`: optional literal `pi-dynamic-workflow/v1`
- `name`: workflow/run name
- `permissions`: default capabilities inherited by phases
- `model`, `timeoutMs`, `concurrency`: workflow defaults
- `phases`: 1–30 ordered phases

Every phase has a unique `name` and may declare `permissions`, `timeoutMs`, `artifact`, and an explicit retry policy:

```json
{ "retry": { "maxAttempts": 3, "baseDelayMs": 1000 } }
```

Retries are opt-in because shell and harness work may have side effects. Structured fanout is capped at 1,000 items and concurrency 64 by default; operators may lower runtime maxima with environment policy.

References (`from`, `itemsFrom`, `{{output:name}}`, and `{{outputs.name}}`) must identify an earlier phase. Fanout uses exactly one of `items` or `itemsFrom`; artifact phases use exactly one of `content` or `from`.

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
