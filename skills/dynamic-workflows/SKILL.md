---
name: dynamic-workflows
description: Use when composing or running bounded Pi subagent workflows with dynamic_workflow, agent/fanout/shell/artifact phases, workflow permissions, monitoring, or advanced JavaScript harnesses.
---

# Dynamic Workflows

Use `dynamic_workflow` as the simple first-line composer for bounded, observable subagent workflows. The tool input is the workflow itself; do not wrap it in `spec`.

Dynamic workflows compile onto thread-phase. Deterministic means the encoded phase order, references, concurrency, retries, permissions, and terminal behavior—not model output.

## Basic shape

```json
{
  "name": "review-src",
  "permissions": "r",
  "background": true,
  "phases": [
    {
      "type": "agent",
      "name": "review",
      "prompt": "Review src for correctness. Do not modify files."
    },
    {
      "type": "artifact",
      "name": "report",
      "title": "Source review",
      "from": "review"
    }
  ]
}
```

## Permissions

- `r`: `read`, `grep`, `find`, `ls`
- `w`: `edit`, `write`
- `rw`: all read and write tools
- `rwx`: read/write plus Pi `bash` and `shell` phases

A shell can inherently read and write, so command execution requires full `rwx`; there is no isolated `x` mode. Top-level permissions are phase defaults. A phase may override that default within `PI_DYNAMIC_WORKFLOW_MAX_PERMISSIONS` policy. A non-empty `tools` array may narrow, never expand, the tools allowed by permissions; omit it for all permitted tools.

## Phase types

### `agent`

One Pi subagent:

```json
{ "type": "agent", "name": "inspect", "permissions": "r", "prompt": "Inspect the repository." }
```

### `fanout`

Parallel Pi subagents over explicit or earlier-phase items:

```json
{
  "type": "fanout",
  "name": "review-files",
  "items": ["src/a.ts", "src/b.ts"],
  "concurrency": 2,
  "prompt": "Review {{item}}."
}
```

Use `itemsFrom: "phase-name"` instead of `items` to consume an earlier output. Arrays pass through; strings are parsed as JSON arrays/objects when possible, otherwise as non-empty lines with `-`/`*` bullets removed. `failOnItemFailure` defaults to true and waits for siblings to settle; `label` customizes progress event wording.

### `shell`

```json
{ "type": "shell", "name": "test", "permissions": "rwx", "command": "npm test" }
```

### `artifact`

```json
{ "type": "artifact", "name": "report", "title": "Report", "from": "inspect" }
```

Artifact phases require exactly one of `content` or `from`.

## Composition rules

- Phases execute in declared order.
- Names must be unique.
- Use `{{outputs.phase-name}}` to reference a complete earlier phase output; JSON subfield access is not supported.
- Fanout prompts may use `{{item}}` and `{{index}}`.
- References may not point forward.
- `fanout` requires exactly one of `items` or `itemsFrom`.
- Retries are explicit and bounded: `retry: { maxAttempts, baseDelayMs }`.
- Retry delays use exponential backoff without jitter.
- Do not retry non-idempotent side effects casually.

Mixed-permission example:

```json
{
  "name": "review-fix-test",
  "permissions": "r",
  "phases": [
    { "type": "agent", "name": "review", "prompt": "Find the highest-priority defect." },
    { "type": "agent", "name": "fix", "permissions": "rw", "prompt": "Fix this defect:\n{{outputs.review}}" },
    { "type": "shell", "name": "test", "permissions": "rwx", "command": "npm test" },
    { "type": "artifact", "name": "result", "title": "Implementation result", "from": "test" }
  ]
}
```

## Execution policy

- Set `cwd` explicitly when execution differs from the Pi session cwd.
- Top-level `model`, `timeoutMs`, and `concurrency` provide phase defaults; `metadata` retains optional caller metadata in the compiled input.
- Use `background: true` for long workflows.
- Use `autoContinue: true` only when successful completion should queue a follow-up.
- Add an artifact phase when the user expects a durable report.
- Keep fanout item count and concurrency minimal.
- Use `thread_phase_runs` to inspect results and `ctrl+shift+t` to monitor/cancel interactively.

## Saved templates

Store reusable workflows under `~/.pi/agent/workflows/` (or `PI_DYNAMIC_WORKFLOW_TEMPLATE_DIR`):

- `<name>.json` is a flat structured `dynamic_workflow` object. Invoke it with `{ "template": "name", "inputs": { ... } }` instead of phases. Use `{{inputs.key}}` placeholders; exact placeholders preserve JSON values, while placeholders embedded in text require scalars.
- `<name>.mjs` is a self-contained advanced harness. Invoke it with `dynamic_workflow_harness` using `{ "template": "name", "permissions": "rwx" }`.

Missing or unused structured-template inputs fail preflight. Invocation-level workflow defaults override structured-template defaults; metadata is merged and records `savedTemplate`. Do not provide both `template` and `phases`, or combine a harness template with `harness`/`harnessFile`. Template names are safe identifiers rather than paths. Symlinks, non-files, traversal, and files above 1 MB fail preflight. Templates do not bypass permission ceilings or normal validation. Authoring remains explicit and file-based; the tools do not overwrite saved templates.

## Structured artifact resume

Structured workflows write an atomic `workflow-checkpoint.json` plus hashed per-phase output artifacts after each successfully completed phase. To continue an interrupted run, invoke the same workflow with `resumeRunId` set to the earlier run id:

```json
{
  "name": "review-src",
  "permissions": "r",
  "resumeRunId": "review-src-...",
  "phases": [
    { "type": "agent", "name": "review", "prompt": "Review src." },
    { "type": "artifact", "name": "report", "from": "review" }
  ]
}
```

Resume is fail-closed. The compiled spec, real working directory, effective model, and Pi session must match. Checkpoints must contain a contiguous prefix of matching phases, output files must remain inside the source run's artifact directory, and their sizes and SHA-256 hashes must verify. Validated outputs are copied into the new run's own checkpoint chain; completed phases are not re-executed, and execution continues at the first uncheckpointed phase. Harness workflows cannot use `resumeRunId`. A single resumable phase output is capped at 4 MB.

Resume proves that the earlier phase completed and that its output artifact is intact. It cannot make an interrupted, non-checkpointed side effect idempotent; design shell/write phases accordingly.

## Advanced harnesses

Use the separate `dynamic_workflow_harness` tool only for loops, branching, tournaments, custom scoring, or control flow that structured phases cannot represent. It requires explicit `permissions: "rwx"` and executes arbitrary unsandboxed JavaScript.

Harness helpers:

- `ctx.phase(name, fn)`
- `ctx.shell(command, options)`
- `ctx.pi(prompt, options)`
- `ctx.fanout(items, options)`
- `ctx.artifact(title, content, options)`
- `ctx.emit(kind, data)`
- `ctx.cancelled()` / `ctx.signal`

Prefer a standalone TypeScript extension using thread-phase directly when logic becomes reusable, domain-specific, operationally important, or recovery-heavy.

## Compatibility

`dynamic_thread_phase_workflow` is a deprecated legacy interface and is inactive by default. Do not use it for new calls. Ordinary old `{ spec: ... }` structured arguments are upgraded by `dynamic_workflow.prepareArguments`; full legacy harness and per-phase artifact-option compatibility remains available through the alias when explicitly enabled. Unsupported legacy-only phase options fail with an actionable migration error rather than being silently discarded.

## Checklist

1. Use flat `dynamic_workflow` arguments, not `{ spec: ... }`.
2. Prefer `agent` and `fanout` phases for subagents.
3. Choose the minimum meaningful permission: `r`, `w`, `rw`, or `rwx`.
4. Use phase overrides only where needed.
5. Use `shell` only with `rwx`.
6. Reference only earlier phases with `{{outputs.name}}`.
7. Use background mode for long runs.
8. Include a durable artifact when appropriate.
9. Keep retries and fanout bounded.
10. Use a saved template for repeated workflows; use direct phases for one-off composition.
11. Use `resumeRunId` only with the identical structured workflow, cwd, model, and session.
12. Use `dynamic_workflow_harness` only for genuinely advanced control flow.
