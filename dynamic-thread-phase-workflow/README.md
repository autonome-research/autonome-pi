# dynamic-thread-phase-workflow

Executes deterministic thread-phase workflows from a constrained JSON spec built live in chat.

This is the Pi/thread-phase equivalent of a dynamic workflow: the agent can propose a workflow plan, but execution happens through a validated runner rather than generated/eval'd TypeScript.

## Tool

- `dynamic_thread_phase_workflow`

Use `background: true` for long workflows. Runs emit generic `thread-phase-ui/v1` events, so `ctrl+shift+t` can monitor/cancel them.

## Permissions

Dynamic workflows use compact `rwx` capability declarations. There is no per-run `permissionMode` field; the extension executes declared capabilities automatically, bounded by its configured max policy.

```json
{ "permissions": "rwx" }
```

Mapping:

- `r` enables Pi `read`, `grep`, `find`, `ls`
- `w` enables Pi `edit`, `write`
- `x` participates in execution privileges; shell phases and Pi `bash` require full `rwx` because command execution is not sandboxed

Phase-level `permissions` can narrow or expand within the runner max policy. Defaults are controlled by environment:

- `PI_DYNAMIC_THREAD_PHASE_DEFAULT_PERMISSIONS` default: `r`
- `PI_DYNAMIC_THREAD_PHASE_MAX_PERMISSIONS` default: `rwx`

### `shell`

Runs a shell command and stores stdout in `{{output:phase-name}}`. Shell execution is not sandboxed, so shell phases require full `rwx` even for read-looking commands.

```json
{ "type": "shell", "name": "list-files", "permissions": "rwx", "command": "find src -maxdepth 2 -type f", "artifact": true }
```

### `pi`

Runs a Pi subagent and stores assistant markdown output.

```json
{
  "type": "pi",
  "name": "summarize-src",
  "permissions": "r",
  "prompt": "Summarize the src directory. Files:\n{{output:list-files}}"
}
```

If `tools` is omitted, the runner derives tools from `permissions`. If `tools` is present, each named tool must be allowed by the phase permissions.

### `fanout_pi`

Runs Pi over a list of items with bounded concurrency.

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

Writes a final markdown/json artifact from literal content or a previous phase output.

```json
{ "type": "artifact", "name": "final-report", "title": "Report", "from": "summarize-src" }
```

## Template variables

- `{{cwd}}`
- `{{runId}}`
- `{{item}}` / `{{index}}` inside fanout phases
- `{{output:phase-name}}`
- `{{outputs.phase-name}}`
- `{{spec.fieldName}}`

## Example spec

```json
{
  "name": "repo-doc-audit",
  "permissions": "rwx",
  "phases": [
    {
      "type": "shell",
      "name": "list-docs",
      "command": "find . -maxdepth 3 -type f \\( -name 'README*' -o -path './docs/*' \\)",
      "artifact": true
    },
    {
      "type": "pi",
      "name": "audit-docs",
      "permissions": "r",
      "prompt": "Audit these docs for stale or missing setup instructions. Do not modify files.\n\n{{output:list-docs}}"
    },
    {
      "type": "artifact",
      "name": "doc-audit-report",
      "title": "Documentation audit",
      "from": "audit-docs"
    }
  ]
}
```
