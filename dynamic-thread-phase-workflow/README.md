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

A shell is inherently able to read and write, so `x` is not offered independently: shell and Pi `bash` execution require `rwx`. A non-empty phase-level `tools` list may narrow the tools granted by its permissions but cannot expand them; omit `tools` to receive all tools allowed by the phase permissions. Every request is bounded by `PI_DYNAMIC_WORKFLOW_MAX_PERMISSIONS` (default `rwx`).

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
  "label": "files",
  "failOnItemFailure": false,
  "prompt": "Review {{item}} (item {{index}})."
}
```

`itemsFrom` accepts an array directly. String output is parsed as a JSON array/object when possible, otherwise as non-empty lines with leading `-` or `*` bullets removed; numbered-list prefixes are preserved. `failOnItemFailure` defaults to true and fails only after all siblings settle. `label` customizes fanout progress events.

Fanout is capped at 1,000 items and concurrency 64 in the public tool schema; operators may configure lower runtime limits.

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

- `{{outputs.phase-name}}` — complete earlier phase output (JSON subfield access is not supported)
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

Retries use exponential backoff (`baseDelayMs`, then double for each later retry) without jitter. Do not retry side-effecting work unless it is idempotent.

## Execution controls

Top-level controls:

- `cwd` — workflow working directory; defaults to the current Pi cwd
- `permissions` — inherited phase capability default
- `model` — inherited agent model pattern
- `timeoutMs` — inherited agent/shell timeout
- `concurrency` — inherited fanout concurrency
- `background` — detach after durable readiness and return `runId` + `pid`
- `autoContinue` — after successful background completion, queue a Pi follow-up through the visualizer continuation service
- `metadata` — optional caller metadata retained in the compiled workflow input

Use `background: true` for long workflows. `autoContinue` defaults to false.

## Saved workflow templates

Reusable workflows can be stored under `~/.pi/agent/workflows/`. Set `PI_DYNAMIC_WORKFLOW_TEMPLATE_DIR` to use a different operator-managed directory.

A structured template is a flat `dynamic_workflow` JSON object saved as `<name>.json`:

```json
{
  "name": "repository-review",
  "permissions": "r",
  "background": true,
  "phases": [
    { "type": "agent", "name": "review", "prompt": "Review {{inputs.target}} in the current repository. Do not modify files." },
    { "type": "artifact", "name": "report", "title": "Repository review", "from": "review" }
  ]
}
```

Invoke `~/.pi/agent/workflows/repository-review.json` with:

```json
{
  "template": "repository-review",
  "inputs": { "target": "src" },
  "autoContinue": true,
  "metadata": { "requestedBy": "operator" }
}
```

Use exactly one of `template` or `phases`. `{{inputs.key}}` placeholders make structured templates reusable: an exact placeholder preserves the input's JSON type, while a placeholder embedded in text requires a scalar. Missing and unused inputs fail preflight to catch mistakes. Invocation-level workflow controls override template defaults; metadata is merged, and `metadata.savedTemplate` records the selected template. Phases cannot be replaced at invocation time. The normal schema, permission ceiling, semantic preflight, cancellation, and runtime bounds still apply after loading.

A saved advanced harness is a self-contained `<name>.mjs` file in the same directory. Invoke it through the separate harness tool:

```json
{ "template": "custom-tournament", "permissions": "rwx", "background": true }
```

Use exactly one of `template`, `harness`, or `harnessFile`. Saved harnesses remain arbitrary unsandboxed JavaScript and still require explicit `rwx`. They must be self-contained because the runner executes a durable copy from the run artifact directory.

Template names are identifiers, not paths. Traversal and symlinked files are rejected, files must be regular files no larger than 1 MB, and parse/preflight failures occur before a visualizer run is created. Template authoring is intentionally file-based; this tool does not silently create or overwrite persistent templates.

## Structured artifact resume

After every successfully completed structured phase, the runner atomically writes a `workflow-checkpoint.json` manifest and a hashed output file under that run's `phase-outputs/` artifact directory. Continue an interrupted workflow by supplying the earlier run id with the otherwise identical invocation:

```json
{
  "name": "review-and-fix",
  "permissions": "rw",
  "resumeRunId": "review-and-fix-...",
  "phases": [
    { "type": "agent", "name": "review", "permissions": "r", "prompt": "Review the repository." },
    { "type": "agent", "name": "fix", "prompt": "Implement {{outputs.review}}." },
    { "type": "artifact", "name": "report", "from": "fix" }
  ]
}
```

Resume validates the compiled spec, real cwd, effective model, Pi session, contiguous phase identities, artifact containment, output size, and SHA-256 hash before creating the new run. Validated outputs are copied into the new run's checkpoint chain, completed phases are represented in its lifecycle without re-execution, and execution starts at the first uncheckpointed phase. Any mismatch fails preflight. JavaScript harnesses cannot be resumed this way.

A checkpoint proves completion only for phases whose output artifact was durably written. An interrupted phase runs again, so side-effecting shell/write phases still need idempotent design. Each resumable phase output is capped at 4 MB.

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

The deprecated `dynamic_thread_phase_workflow` tool remains registered for old `{ spec: ... }` and harness calls but is inactive by default. Set `PI_DYNAMIC_WORKFLOW_ENABLE_LEGACY_ALIAS=1` only when an old session must call it. The canonical tool's `prepareArguments` upgrades ordinary legacy nested structured calls, metadata, fanout labels, old `pi`/`fanout_pi` phase names, and `timeout` to `timeoutMs`. Conflicting duplicate defaults fail clearly.

Legacy per-phase output-artifact configuration and control fields on artifact phases cannot be represented by the simplified schema. Convert them to an explicit `artifact` phase, or temporarily use the enabled legacy alias; argument preparation reports this case rather than silently dropping behavior.

The runner CLI accepts both the new `agent`/`fanout` spec names and the old `pi`/`fanout_pi` names:

```bash
~/.pi/agent/extensions/dynamic-thread-phase-workflow/bin/dynamic-workflow.mjs --spec-file workflow.json
```

Advanced harness CLI:

```bash
~/.pi/agent/extensions/dynamic-thread-phase-workflow/bin/dynamic-workflow.mjs --js-file workflow.mjs --permissions rwx
```

## Runtime bounds

- Saved structured/harness template file: 1 MB
- Resumable phase output artifact: 4 MB
- Resume checkpoint manifest: 1 MB
- Workflow phase count: 30
- Fanout items: 1,000
- Fanout concurrency: 64
- Retries: 5 attempts
- Generic subprocess stdout/stderr retention: 1 MB per stream
- Pi NDJSON record limit: 4 MB
- Tool response text is truncated; complete run data remains available through `thread_phase_runs`
- Timeout and cancellation terminate subprocess groups with a bounded grace period

Successful, failed, and cancelled runs write `workflow-result.json`; non-success results are marked partial.
