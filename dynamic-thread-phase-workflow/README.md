# dynamic-thread-phase-workflow

Executes deterministic thread-phase workflows from a constrained JSON spec built live in chat.

This is the Pi/thread-phase equivalent of a dynamic workflow: the agent can propose a workflow plan, but execution happens through a validated runner rather than generated/eval'd TypeScript.

## Tool

- `dynamic_thread_phase_workflow`

Use `background: true` for long workflows. Runs emit generic `thread-phase-ui/v1` events, so `ctrl+shift+t` can monitor/cancel them.

## Phase types

### `shell`

Runs a shell command and stores stdout in `{{output:phase-name}}`.

```json
{ "type": "shell", "name": "list-files", "command": "find src -maxdepth 2 -type f", "artifact": true }
```

Shell phases reject obviously mutating commands by default. Set `allowWrites: true` only after explicit user approval.

### `pi`

Runs a read-only Pi subagent and stores assistant markdown output.

```json
{
  "type": "pi",
  "name": "summarize-src",
  "tools": ["read", "grep", "find", "ls"],
  "prompt": "Summarize the src directory. Files:\n{{output:list-files}}"
}
```

By default only `read`, `grep`, `find`, and `ls` tools are allowed unless `allowWrites` is set.

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
