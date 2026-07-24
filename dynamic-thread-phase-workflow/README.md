# dynamic-workflows

Status: experimental but usable.

`dynamic_workflow` is a small, validated workflow composer for bounded subagents. The tool input is the workflow: provide defaults plus an ordered list of `agent`, `fanout`, `shell`, and `artifact` phases. Structured workflows compile onto thread-phase and emit generic `thread-phase-ui/v1` events for `thread_phase_runs` and the `ctrl+shift+t` monitor.

## Basic workflow

```json
{
  "name": "review-and-fix",
  "permissions": "rw",
  "background": true,
  "phases": [
    {
      "type": "agent",
      "name": "review",
      "permissions": "r",
      "prompt": "Review the repository and identify the highest-priority issue."
    },
    {
      "type": "agent",
      "name": "fix",
      "prompt": "Implement the recommended fix.\n\nReview:\n{{outputs.review}}"
    },
    {
      "type": "artifact",
      "name": "report",
      "title": "Review and implementation report",
      "from": "fix"
    }
  ]
}
```

There is no outer `spec` object. Workflow defaults live at the top level, and phases inherit them unless they provide an override.

## Permissions

Permissions are capabilities rather than tool names:

| Value | Default Pi tools |
| --- | --- |
| `r` | `read`, `grep`, `find`, `ls` |
| `w` | `edit`, `write` |
| `rw` | all read and write tools |
| `rwx` | read/write tools plus `bash`; also permits `shell` phases |

A shell is inherently able to read and write, so `x` is not offered independently: shell and Pi `bash` execution require `rwx`. A phase-level `tools` list may narrow the tools granted by its permissions but cannot expand them. Every request is bounded by `PI_DYNAMIC_WORKFLOW_MAX_PERMISSIONS` (default `rwx`).

```json
{
  "name": "mixed-permissions",
  "permissions": "r",
  "phases": [
    { "type": "agent", "name": "inspect", "prompt": "Inspect the code." },
    { "type": "agent", "name": "implement", "permissions": "rw", "prompt": "Implement {{outputs.inspect}}." },
    { "type": "shell", "name": "test", "permissions": "rwx", "command": "npm test" }
  ]
}
```

The top-level permission is a default, not a security ceiling. Operator policy is the ceiling.

## Phases

### `agent`

Run one bounded Pi subagent:

```json
{
  "type": "agent",
  "name": "review",
  "prompt": "Review the authentication implementation.",
  "permissions": "r",
  "model": "optional/model-pattern",
  "tools": ["read", "grep"]
}
```

### `fanout`

Run the same subagent template over explicit items:

```json
{
  "type": "fanout",
  "name": "review-areas",
  "items": ["src", "tests", "docs"],
  "concurrency": 3,
  "prompt": "Review {{item}} for correctness and maintainability."
}
```

Or use an earlier phase's output as items:

```json
{
  "type": "fanout",
  "name": "review-files",
  "itemsFrom": "find-files",
  "prompt": "Review {{item}} (item {{index}})."
}
```

Fanout is capped at 1,000 items and concurrency 64; operators may configure lower limits.

### `shell`

```json
{
  "type": "shell",
  "name": "tests",
  "permissions": "rwx",
  "command": "npm test",
  "timeoutMs": 600000
}
```

Shell execution is not sandboxed and always requires `rwx`.

### `artifact`

Persist literal content or an earlier phase output:

```json
{ "type": "artifact", "name": "report", "title": "Final report", "from": "review" }
```

An artifact phase must provide exactly one of `content` or `from`.

## Composition

Phases are ordered. References must point to earlier phases.

- `{{outputs.phase-name}}` — earlier phase output
- `{{item}}` — current fanout item
- `{{index}}` — current fanout index
- `{{cwd}}` and `{{runId}}` — workflow context

Retries are explicit and bounded:

```json
{
  "type": "agent",
  "name": "flaky-check",
  "prompt": "Run the bounded check.",
  "retry": { "maxAttempts": 3, "baseDelayMs": 1000 }
}
```

Do not retry side-effecting work unless it is idempotent.

## Execution controls

Top-level controls:

- `cwd` — workflow working directory; defaults to the current Pi cwd
- `permissions` — inherited phase capability default
- `model` — inherited agent model pattern
- `timeoutMs` — inherited agent/shell timeout
- `concurrency` — inherited fanout concurrency
- `background` — detach after durable readiness and return `runId` + `pid`
- `autoContinue` — after successful background completion, queue a Pi follow-up

Use `background: true` for long workflows. `autoContinue` defaults to false.

## Advanced JavaScript harnesses

`dynamic_workflow_harness` is a separate advanced tool for loops, branching, tournaments, custom scoring, or other control flow that structured phases cannot express. Harness code is arbitrary unsandboxed Node.js and requires explicit `permissions: "rwx"`.

```js
export default async function workflow(ctx) {
  const files = await ctx.shell("find src -type f | head -20", { name: "list-files" });
  const reviews = await ctx.fanout(files.split(/\n/).filter(Boolean), {
    name: "review-files",
    concurrency: 3,
    promptTemplate: "Review {{item}}. Do not modify files.",
    pi: { permissions: "r" }
  });
  await ctx.artifact("Review report", reviews.join("\n\n---\n\n"));
}
```

Prefer `dynamic_workflow` for normal composition. Reusable or operationally important logic should graduate into a standalone TypeScript extension using thread-phase directly.

## Compatibility

The deprecated `dynamic_thread_phase_workflow` tool remains registered for old `{ spec: ... }` and harness calls but is inactive by default. Set `PI_DYNAMIC_WORKFLOW_ENABLE_LEGACY_ALIAS=1` only when an old session must call it. The canonical tool's `prepareArguments` also upgrades ordinary legacy nested structured calls and old `pi`/`fanout_pi` phase names.

The runner CLI accepts both the new `agent`/`fanout` spec names and the old `pi`/`fanout_pi` names:

```bash
~/.pi/agent/extensions/dynamic-thread-phase-workflow/bin/dynamic-workflow.mjs --spec-file workflow.json
```

Advanced harness CLI:

```bash
~/.pi/agent/extensions/dynamic-thread-phase-workflow/bin/dynamic-workflow.mjs --js-file workflow.mjs --permissions rwx
```

## Runtime bounds

- Workflow phase count: 30
- Fanout items: 1,000
- Fanout concurrency: 64
- Retries: 5 attempts
- Generic subprocess stdout/stderr retention: 1 MB per stream
- Pi NDJSON record limit: 4 MB
- Tool response text is truncated; complete run data remains available through `thread_phase_runs`
- Timeout and cancellation terminate subprocess groups with a bounded grace period

Successful, failed, and cancelled runs write `workflow-result.json`; non-success results are marked partial.
