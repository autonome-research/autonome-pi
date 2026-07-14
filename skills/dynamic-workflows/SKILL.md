---
name: dynamic-workflows
description: Use when planning or running Pi dynamic workflows, multi-phase agent pipelines, ad-hoc deterministic workflows, structured JSON workflow specs, JavaScript harness workflows, workflow cancellation/monitoring, or when deciding between dynamic_workflow and dynamic_thread_phase_workflow.
---

# Dynamic Workflows

Use this skill when a user asks to create, run, debug, or reason about Pi dynamic workflows in this package.

## Core rule

Prefer the `dynamic_workflow` tool. `dynamic_thread_phase_workflow` is a deprecated compatibility alias and should only be used if the canonical tool is unavailable.

Dynamic workflows are the first-line mechanism for deploying bounded deterministic subagents from chat. Deterministic means topology and policy, not model output. Runs are backed by the package's generic workflow event store, so they can be monitored with `ctrl+shift+t`, inspected with `thread_phase_runs`, and cancelled cooperatively from the monitor. When workflow logic becomes reusable or operationally important, implement it as a standalone TypeScript extension using thread-phase directly.

## Choose the workflow mode

### Structured spec mode — default

Use a structured spec for most tasks. It is validated, auditable, monitor-friendly, and easier to replay.

Supported phase types:

- `shell`
- `pi`
- `fanout_pi`
- `artifact`

Specs use ordered dependencies: `from`, `itemsFrom`, and output templates may only reference earlier phases. Fanout must provide exactly one of `items` or `itemsFrom`; artifact phases exactly one of `content` or `from`. Unknown fields are rejected. Per-phase `retry: { maxAttempts, baseDelayMs }` is explicit and bounded; never retry side-effecting work without considering idempotence.

Example:

```json
{
  "name": "review-src",
  "permissions": "r",
  "phases": [
    {
      "type": "pi",
      "name": "summarize",
      "permissions": "r",
      "prompt": "Summarize the repository structure. Do not modify files."
    },
    {
      "type": "artifact",
      "name": "report",
      "title": "Repository summary",
      "from": "summarize"
    }
  ]
}
```

### JavaScript harness mode — advanced

Use JS harness mode only when the workflow needs rich control flow that structured specs cannot express, such as loops, branching, tournaments, custom scoring, or dynamic fanout generation.

Harness mode executes generated Node.js code and is **not sandboxed**. `rwx` is an acknowledgement, not confinement. It requires explicit `permissions: "rwx"` and is checked against `PI_DYNAMIC_WORKFLOW_MAX_PERMISSIONS` before import.

Example:

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

Available harness helpers:

- `ctx.phase(name, fn)`
- `ctx.shell(command, options)`
- `ctx.pi(prompt, options)`
- `ctx.fanout(items, options)`
- `ctx.artifact(title, content, options)`
- `ctx.emit(kind, data)`
- `ctx.cancelled()` / `ctx.signal`

## Permission policy

Dynamic workflows use compact capability strings:

- `r`: read/search/list tools (`read`, `grep`, `find`, `ls`)
- `w`: write tools (`edit`, `write`)
- `x`: command execution capability as part of `rwx`

Important:

- Shell phases require `rwx` because command execution is not sandboxed.
- Pi `bash` usage requires `rwx`.
- JavaScript harness mode requires explicit `permissions: "rwx"`.
- Default workflow permissions are bounded by `PI_DYNAMIC_WORKFLOW_MAX_PERMISSIONS`.
- Legacy `PI_DYNAMIC_THREAD_PHASE_*` env vars may still work as fallbacks, but prefer `PI_DYNAMIC_WORKFLOW_*`.

## Runtime behavior

- Use `background: true` for long workflows so normal chat remains usable. A successful launch acknowledgement includes both `runId` and `pid` only after the child creates its durable run.
- Dynamic workflows do **not** auto-continue by default. Set `autoContinue: true` only when a successful background run should queue a follow-up.
- Workflow visibility is session-scoped. The monitor should show workflows launched by the current Pi session.
- Execution cwd may differ from the session cwd; set `cwd` explicitly when needed.
- Avoid `rg` unless you know it is installed; prefer `find`/`grep` in shell phases.

## Recommended tool call patterns

Structured workflow:

```js
await dynamic_workflow({
  spec: {
    name: "my-workflow",
    permissions: "r",
    phases: [/* ... */]
  },
  cwd: "/path/to/project",
  background: true
});
```

Harness workflow:

```js
await dynamic_workflow({
  name: "advanced-workflow",
  harness: "export default async function workflow(ctx) { /* ... */ }",
  permissions: "rwx",
  cwd: "/path/to/project",
  background: true
});
```

Inspect runs:

```js
await thread_phase_runs({ limit: 10 });
await thread_phase_runs({ runId: "..." });
```

## Validation checklist before running

1. Prefer structured spec mode unless rich control flow is required.
2. Name phases clearly and deterministically.
3. Set the minimum permissions needed.
4. Use `rwx` only for shell/JS/unsafe command execution.
5. For `pi`/`fanout_pi`, `tools` must be an array of supported tool names if provided.
6. Use `background: true` for long workflows.
7. Use `autoContinue: true` only when follow-up is desired.
8. Include an artifact/report phase when the user expects a durable result.
9. Keep fanout item count and concurrency minimal; runtime limits are intentionally bounded.
10. Prefer a standalone extension for reusable workflows, domain-specific state, complex recovery, or operational deployment.

## Current known remaining work

Treat these as implementation caveats, not usage blockers:

- Store scalability still needs bounded JSONL tail/offset reads for very large stores.
- Automated tests should still be expanded for harness cancellation, broader permission matrices, alias registration introspection, and more fanout terminal races.
- Usage is projected and rendered, but usage budgets/threshold enforcement are not implemented yet.
- Saved workflow templates, resume/reuse semantics, and worktree isolation are planned but not yet implemented.
