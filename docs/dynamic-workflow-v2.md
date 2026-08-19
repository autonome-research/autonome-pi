# Dynamic Workflow v2

Status: approved design, implementation in progress.

## Goals

Dynamic Workflow v2 keeps dynamic workflows as a Pi integration compiled onto thread-phase. It does not introduce another lifecycle engine. The redesign makes the common declarative call smaller, makes background handoff predictable, adds durable parent/child chains, and clearly separates declarative workflows from unsandboxed scripted workflows.

Backward compatibility is not a design constraint for this revision. Removed public options may be deleted rather than retained behind permanent translation layers.

## Ownership boundaries

Thread-phase owns each individual run's lifecycle:

- run and phase persistence;
- cancellation and terminal state;
- heartbeat and ownership;
- fanout supervision;
- artifacts and terminal events.

Pi owns product-level workflow policy:

- session-scoped continuation delivery;
- chain identity and parent/child edges;
- deciding and launching a model-selected successor;
- resume invocation policy;
- tool schemas and dashboard chain presentation.

A chain is a durable relationship among ordinary thread-phase runs, not a nested execution engine.

## Terminal continuation policy

Foreground calls return to the active assistant turn and do not enqueue another turn.

Background runs use this terminal policy:

| Status | Main-chat continuation |
| --- | --- |
| `success` | yes |
| `failed` | yes, with failed phases, errors, and partial artifacts clearly identified |
| `cancelled` | no; user cancellation is authoritative |

When a runner-managed successor already exists, intermediate runs do not enqueue a duplicate main-chat continuation. The chain's terminal run hands control back to chat.

The public `autoContinue` option will be removed. Background execution means that terminal success or failure returns control to chat. A future intentionally silent/background API must be explicit rather than the default.

Continuation delivery remains durable, session-scoped, claim-based, and recoverable across extension reloads. Failure continuation is not success continuation with different styling: its prompt must explicitly ask the assistant to diagnose, resume, recover, or report rather than proceed as if work succeeded.

## Workflow chaining

### Model-facing call

The main agent chooses conditional successors using ordinary reasoning. A child workflow adds one link:

```json
{
  "after": "parent-run-id",
  "template": "implement-fix",
  "inputs": {
    "target": "src"
  },
  "background": true
}
```

The parent run id comes from a trusted workflow result or continuation message. The model never chooses the new run id or chain id.

A failed parent may be followed by either:

- `resumeRunId`, to continue the same validated structured workflow; or
- `after`, to start a different recovery workflow in the same chain.

### Durable identity

Pi generates and persists:

- `runId`: unique identity for one thread-phase run;
- `chainId`: unique identity for the chain;
- `rootRunId`: first run in the chain;
- `parentRunId`: direct predecessor;
- `step`: zero-based chain position;
- continuation delivery and successor-claim identities.

IDs are system-owned and collision-resistant. A stable specification hash is used for reproducibility and resume trust; run IDs must not be derived solely from a spec because concurrent identical runs are valid.

### Successor safety

Initially, a parent may have at most one child. Pi reserves the parent-to-child edge before launch and commits it only after the child creates a durable run. A failed launch releases or expires the reservation. Duplicate continuation delivery cannot create a second child.

Parallel work belongs inside a `fanout` phase rather than multiple child runs.

Chain depth is bounded by operator policy, not a model-facing option. The initial default is 20 runs. Parent ownership and Pi session identity fail closed. Cancellation does not automatically launch or suggest a successor.

### Output transfer

The main agent can inspect the parent's result and provide child template inputs. A later bounded convenience may support direct-parent references only:

```text
{{previous.outputs.phase-name}}
```

No general JSONPath or expression language will be added. Declarative phase topology remains fixed. Autonomous loops and `if`/`else` remain the scripted workflow use case.

## Declarative and scripted workflows

The normal tool remains `dynamic_workflow` and is described as a declarative workflow.

The advanced tool will become `scripted_workflow`. It executes arbitrary unsandboxed JavaScript and remains a distinct security boundary requiring explicit acknowledgement of `rwx`. The old harness-facing name may be removed rather than preserved indefinitely.

Both tools use the same runner integration, thread-phase event contract, artifacts, dashboard, cancellation, and continuation service.

## Simplified declarative API

Three mutually exclusive launch modes are planned.

### Direct

```json
{
  "name": "review-and-fix",
  "permissions": "rw",
  "background": true,
  "phases": [
    { "type": "agent", "name": "review", "permissions": "r", "prompt": "Review the repository." },
    { "type": "agent", "name": "fix", "prompt": "Implement this:\n{{outputs.review}}" },
    { "type": "artifact", "name": "report", "from": "fix" }
  ]
}
```

### Saved template

```json
{
  "template": "repository-review",
  "inputs": { "target": "src" },
  "background": true
}
```

### Resume

```json
{
  "resumeRunId": "failed-run-id"
}
```

Resume derives the trusted compiled spec, cwd, model, permissions, template provenance, and checkpoint outputs from the source run. The caller does not repeat them. Changing those values is a new or chained recovery workflow, not a resume.

A direct or template launch may include `after` to become the selected child of a terminal parent.

## Public fields to remove or simplify

Remove from the declarative model-facing schema:

- workflow and phase `description`;
- arbitrary caller `metadata`;
- top-level `concurrency`;
- fanout `label`;
- artifact `fileName` and `kind`;
- `autoContinue`;
- explicit retry backoff configuration;
- potentially phase tool arrays after permission-only dogfood.

Replace:

```json
{ "retry": { "maxAttempts": 3, "baseDelayMs": 1000 } }
```

with:

```json
{ "attempts": 3 }
```

Backoff becomes deterministic runner policy.

Keep the capabilities that materially change execution:

- cwd, permissions, model, timeout, and background;
- phase permission/model overrides;
- phase-local fanout concurrency;
- bounded attempt count;
- fanout failure tolerance;
- template inputs;
- `after` and `resumeRunId`.

## Initial implementation sequence

- [x] Make background success and failure eligible for continuation while excluding cancellation.
- [x] Add explicit failure-aware continuation content and regression coverage.
- [x] Add system-generated chain identity and parent/child provenance with bounded depth.
- [x] Add durable atomic one-child successor reservations and committed edges.
- [x] Add the model-facing `after` launch field.
- [x] Make resume run-ID-only and reject repeated execution configuration.
- [ ] Add explicit repair/recovery for a successor reservation orphaned by a process crash; automatic ambiguous reclamation remains fail-closed.
- [ ] Rename and narrow the scripted workflow tool.
- [ ] Reduce the declarative schema and runner contract.
- [ ] Group chains in the dashboard.
- [ ] Dogfood success, failure, recovery, resume, cancellation, duplicate-delivery, and branching paths before release.
