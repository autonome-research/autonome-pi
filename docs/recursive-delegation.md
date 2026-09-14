# Bounded recursive delegation for dynamic workflows

Status: **runtime contract proposed; pure foundations implemented independently (§10)**. This document does not enable recursion. Public v3 acceptance, worker APIs, persistence, scheduling and scoped execution remain unavailable. Pure calculations do not establish durable or cross-process guarantees. “v1” below means the first recursive-delegation feature release, **not** the historical structured workflow v1 decoder.

## 1. Decision and support boundary

An executing worker may ask to decompose its assignment. The **shared, trusted dynamic runner** decides whether to grant that request, starts and tracks the children, waits for their results, and returns them to the **same live parent conversation** for integration. This is not an outer loop repeatedly prompting a planner, and is not delegation via `dynamic_workflow`, `scripted_workflow`, mission tools, shell-launched Pi, or detached child runners.

Minimal supportable v1:

- Explicit top-level opt-in on new, hosted, flat `dynamic_workflow` calls with direct `phases`.
- One cumulative agent-attempt budget for the **entire workflow**, including all sequential agent phases, all static fanout items, and every descendant. It is not a fresh budget for each root.
- Explicit per-root/subtree allocations; depth starts at zero for each declared root worker.
- Multiple root lanes can run concurrently. Within a root lane, delegated batches run **serially, in request order**, recursively depth-first. Parents block and then integrate. Parallel descendants within one root are deferred.
- One ordinary thread-phase run owns the complete forest. Descendants are invocation/node records and phase/agent events inside that run, not independent workflow runs.
- Scoped built-in file tools and explicit read/write ownership; `rwx` remains unsandboxed.
- Durable grants, launch intents, starts, results, and joins; down-tree cancellation; absolute inherited deadlines.
- **No recursive resume in v1**, including phase-boundary resume. Inspection and manual recovery from evidence are supported; resuming a lost arbitrary worker conversation is not.

Explicitly rejected on opted calls in v1: `template`, `inputs`, `resumeRunId`, `after`, legacy/prepared historical calls, explicit unhosted CLI opt-in, scripted sources/helpers, fanout `itemsFrom`, executable `attempts` other than omitted/`1`, and caller identity/policy metadata. Saved-template opt-in, dynamic root cardinality, automatic invocation retries, recursive resume, and parallel child batches need separately reviewed contracts. Ordinary non-opted direct/template/scripted/legacy/resume calls retain existing behavior.

Rejecting `after` **only when delegation is opted in** avoids touching successor claims/repair and prevents continuation-driven successors from silently replenishing a recursive budget. A later main-chat launch is a new, explicitly authorized workflow with a new budget, not an automatic continuation of the old allowance. There is no session-wide billing ceiling in this feature.

## 2. Baseline inspected and primitives to reuse

Relevant implementation anchors:

| Surface | Current behavior and consequence |
| --- | --- |
| `dynamic-thread-phase-workflow/index.ts` | Strict public/runtime validation, flat v2 compilation, template provenance, session launch flags; legacy `prepareArguments` is a compatibility path, not new authorization. |
| `bin/dynamic-thread-phase-workflow.mjs`: `runPi`, `runPiPhase`, `runFanoutPiPhase` | JSON/print Pi subprocesses with `--no-session --no-skills --no-prompt-templates --no-context-files --tools …`. Extension discovery is deliberately retained for local provider extensions. All recursion must enter a shared invocation scheduler here, not spawn in the worker extension. |
| Same runner: `executionDeadline`, `runProcess`, `main` | Existing supervised background deadline policy, cancellation controller, tracked subprocesses, readiness, thread-phase lifecycle and ordered phases. Workflow `timeoutMs` currently means an inherited subprocess timeout, not an end-to-end workflow deadline. |
| Same runner: `persistedSpecOptions`, `loadResumeInvocation`, `loadResumeState`, checkpoints | Exact checkpoint/v1 and /v2 selection, contiguous successful phase prefix, canonical cwd/spec fingerprint, bounded hashed output files, immutable start ownership and process-journal checks. Not a worker conversation checkpoint. |
| `lib/process-journal.mjs` | Durable pre-spawn intent, PID transition, same-host process-group checks. Unknown intent is not proof of no launch. POSIX groups remain after direct process exit because grandchildren may survive. |
| `lib/subprocess.mjs` | Bounded streams, AbortSignal, explicit timeout versus cancellation classification, process-group termination and bounded SIGKILL grace. Reuse this execution path. |
| `lib/artifact-layout.mjs` | Reserved internal filenames and atomic temporary namespaces. Reserve delegation storage before any artifact can claim it. |
| `lib/pi-json-stream.mjs` | Bounded NDJSON/trace collector. Currently sums any `message_end.message.usage` **before** checking assistant role, so nested tool usage can be counted. `agent_end.messages` is deliberately not parsed. |
| `thread-phase-visualizer/lib/store.mjs`, supervision/continuation modules | Existing run/phase/agent events, authoritative start resolution, artifact projections, session-scoped continuation and progress-review submission gate. Extend observations, do not replace lifecycle. |

Read [dynamic workflow v2](dynamic-workflow-v2.md), [supervision](workflow-supervision.md), [runner README](../dynamic-thread-phase-workflow/README.md), and [dynamic-workflows skill](../skills/dynamic-workflows/SKILL.md) with those sources.

Core `/home/velvet/thread-phase` is **read-only**. Installed dependency is thread-phase 6.1.0. Reuse `PipelineCache`, `runPipeline`, `boundedFanout`, phase wrappers, and existing retry primitives where already used. Inspected core `packages/thread-phase/src/patterns/bounded-fanout.ts` and `with-retry.ts`: fanout drains started workers and propagates signals; retry wraps an entire phase, does not restore side effects, and is unsuitable for blindly retrying an opted parent or an already-partially-successful fanout. Do not enable `retryItem`, a new mission engine, or core recursion changes.

### Installed Pi boundary, not an assumption about `--tools`

The default worker binary resolves to `/home/velvet/.npm-global/bin/pi`, installed Pi **0.85.1**; the repository's SDK dependency is **0.84.2**. Installed `README.md`, `docs/extensions.md`, `docs/sdk.md`, `docs/json.md`, and related `packages.md`, `environment-variables.md`, `session-format.md`, `compaction.md`, `rpc.md`, and `tui.md` were read. Relevant examples inspected: `examples/extensions/subagent/README.md` and subprocess code in `index.ts`, `structured-output.ts`, `tool-override.ts`, and SDK `05-tools.ts`/`06-extensions.ts`.

Actual installed `dist/core/sdk.js` passes `allowedToolNames`; `dist/core/agent-session.js::_refreshToolRegistry` filters built-in, extension and custom names, including registry refreshes. Repository-local 0.84.2 has the same filtering path. However, allowed-name extension definitions override built-ins, and **tool filtering does not stop extension factories/hooks executing arbitrary code**. The generic subagent example is not a durable, budgeted spawn authority.

Therefore opted workers must use a dedicated, tested worker profile: disable discovery with `--no-extensions`, explicitly load only the worker extension and approved provider-only resources, retain disabled skills/templates/context discovery, disallow project resource approval, and verify active tool **names and source provenance** before model execution. Do not merely add one tool to the current discovered profile. No main-chat extensions, mission/dynamic tools, detach/subagent tools, title/status bridge publishers, or continuation hosts in this profile. A model requiring an unapproved provider extension fails preflight rather than falling back to broad discovery. Use a runner-generated private agent directory/settings profile with no package sources or resource reconciliation, and only explicitly approved model/auth inputs; do not edit installed/global config. Clear inherited background, shell bridge/title, main-chat session and launch-authorization environment before starting workers. Bootstrap descriptors carry the worker's own authority, not a copied parent environment.

Installed `dist/core/tools/bash.js::createLocalShellOperations` also spawns **detached shell process groups** and tracks them only inside Pi. Tracking the outer Pi group alone does not supervise those groups. Opted `bash` must therefore use the runner-backed operations adapter specified below, not the ordinary local shell backend.

Pi tools normally execute in parallel within a message. The worker extension must reject the **entire tool batch** if `workflow_delegate`, `workflow_complete`, or opted `bash` appears alongside any other call (including another delegation). Installed docs guarantee `tool_call` sees session state through the current assistant message; inspect that full message in preflight, not sibling result timing. This gate plus one outstanding delegation per worker makes parking sound. Ordinary file-tool batches may remain parallel and use Pi's file mutation queue, but that queue is process-local, not cross-worker ownership.

## 3. Public opt-in and versioning

Proposed public names are normative for future implementation; all objects reject unknown fields and all integers are safe, finite JSON integers without string coercion (including rejection of negative zero). Foundation-local schemas are separate and do not accept/compile a public workflow.

```json
{
  "name": "review-and-integrate",
  "permissions": "r",
  "background": true,
  "delegation": {
    "maxDepth": 2,
    "totalAgentBudget": 12,
    "directoryScope": { "read": ["src", "test"], "write": [] },
    "context": {
      "objective": "Produce an evidence-based integrated review.",
      "constraints": ["Do not modify the repository.", "Parents integrate rather than repeat delegated investigations."]
    }
  },
  "phases": [
    {
      "type": "agent", "name": "map",
      "delegation": { "agentBudget": 4 },
      "prompt": "Map the concern. Delegate distinct bounded investigations if useful; integrate their evidence."
    },
    {
      "type": "fanout", "name": "review",
      "items": ["correctness", "maintainability"], "concurrency": 2,
      "delegation": { "agentBudget": 3 },
      "prompt": "Review {{item}} using {{outputs.map}}. Decompose only independent remaining work."
    },
    {
      "type": "agent", "name": "integrate",
      "delegation": { "agentBudget": 2 },
      "prompt": "Integrate {{outputs.review}}. Resolve contradictions without repeating completed investigations."
    },
    { "type": "artifact", "name": "report", "from": "integrate" }
  ]
}
```

Required top-level `delegation` fields:

- `maxDepth`: integer **0..4**. No default and no boolean shorthand. The top-level planner chooses it.
- `totalAgentBudget`: integer **1..128**, counting roots and descendants, not just additional agents. No default.
- `directoryScope`: explicit `{read: string[], write: string[]}` ceiling, as defined below.
- `context`: `{objective: string, constraints: string[]}` chosen by the top-level planner, containing the common workflow goal and all inherited non-negotiable textual requirements. Objective <=2048 bytes; <=8 constraints, each <=256 bytes. No implicit model-generated summarization of these fields.

For every `agent` and static `fanout` phase in an opted workflow, require phase `delegation: {agentBudget, directoryScope?}`. `agentBudget` is **1..128**, inclusive of that root's own activation and all its descendants. For fanout it is **per item**, not per phase. Optional phase scope narrows the top scope; omit to inherit it. Shell/artifact phases reject `delegation`. Shell phases use the workflow scope as an operational assignment, not a shell sandbox.

Preflight reserves all root quotas at once: `sum(agent budgets) + sum(item count × per-item budget) <= totalAgentBudget`. Reserve the later integration phase before earlier roots can consume anything. For the example: `4 + 2×3 + 2 = 12`. Both multiplication and sums check overflow before allocation. Static roots are enumerated by phase index and fanout item index, never by item label (duplicate labels are legal). At least one agent root is required. Deferred `itemsFrom` is rejected rather than reserving guessed future work.

When `maxDepth = 0`, roots execute normally but cannot delegate; require each root budget to be `1`. `workflow_delegate` is not advertised to depth-limited/budget-exhausted leaves; a direct bridge request still receives an explicit denial. Depth measures live delegation edges: root=0, child=1, grandchild=2. Phase index, fanout index, successor `chainStep`, and retry attempt are **not** depth.

### Strict version dispatch and trust

- Non-opted compilation remains **`pi-dynamic-workflow/v2`**, unchanged. Explicit v1/v2 inputs continue rejecting delegation fields; do not infer recursive authority while decoding historical artifacts.
- Opted public input compiles to a new exact **`pi-dynamic-workflow/v3`** decoder. v3 requires the delegation policy and the feature's narrower support rules. Do not add delegation keys to the v2 allowlists or re-fingerprint v1/v2 data as v3.
- The host passes a private launch authorization bound to the prepared v3 spec digest, canonical cwd, originating session, resolved worker profile/model, and operator policy. A runner-created immutable `workflow_start` envelope records `delegationVersion: 1`, `compiledSpecVersion: 3`, policy/profile digests, budget scope identity, and journal schema version. Caller JSON cannot supply these markers. A CLI flag or environment marker alone is not authority for opted execution.
- Host launch authorization should be a single-use inherited private pipe/descriptor; consume and validate it before background handoff. Only the already-authorized runner transfers its in-memory authorization to its supervised background owner. Do not expose a new caller-authored owner/root/budget flag.
- Until a v3 resume contract exists, **do not emit a checkpoint/v2 for v3**. Store v3 phase completion evidence under `delegation/phase-outputs/` and its own manifest, explicitly `resumable: false`. Existing resume preflight must deny a source marked delegation/v1 before any legacy decoding, and reject unsupported versions or a contradictory/missing marker. A forged /v2 checkpoint must not downgrade an opted source.
- Use **`pi-dynamic-workflow-result/v2`** only for opted results, including the delegation manifest reference, counters and `resumable: false`; preserve result/v1 for existing runs. Generic thread-phase event schema stays `thread-phase-ui/v1`, with namespaced versioned payloads. Renderers must tolerate unknown observation versions without treating them as authority.

## 4. Budget algebra and allocation semantics

One runner-generated `budgetScopeId` belongs to one hosted workflow run. A runner-generated `treeRootNodeId` identifies each root within its forest. Neither is the successor chain's `rootRunId`.

Use a single-writer ledger with these invariants at every committed transition:

```text
spent + freeWorkflow + sum(exclusively held unspent credits) = totalAgentBudget
spent never decreases
root subtree spent <= root's original agentBudget
child subtree spent <= child's accepted agentBudget
```

“Exclusively held” counts a credit once: a child's reservation is removed from its parent's available balance; do not add inclusive ancestor quotas to the total.

1. Preflight assigns fixed quotas to every declared root. Unassigned workflow surplus remains free but is not automatically borrowable in v1.
2. Starting any root or child requires a credit. At durable **launch intent**, charge one credit irreversibly. This conservatively charges an attempted activation even if spawn subsequently proves no child existed. A model turn/tool call inside the same live Pi invocation is not another agent.
3. A parent requesting a batch supplies a positive inclusive `agentBudget` for each child. Validate the entire batch, then reserve its summed quota **atomically** from the parent's available credits. No partial grant and no implicit shrinking. Accepted-but-queued children occupy budget, not processes or execution permits.
4. Each child's remaining quota is available only to that child for its own descendants. No sibling stealing, top-up, reparenting, or authority reassignment.
5. Once a subtree has durable terminal results, no live/unknown owned subprocess groups, and a structural join record, its **unused** credits return to its nearest still-open parent allocation. They may fund another explicit delegation there. At root close they return to `freeWorkflow`; v1 does not enlarge a different root's fixed quota. Spent credits never return, including failure, timeout, cancellation, missing completion, and side-effecting attempts.
6. Accepted work cancelled before launch intent returns all its unused credits at terminal join. After launch intent only the remainder can return. Ambiguous work holds its reservations; it does not become free because of age, heartbeat, worker disconnect, or runner restart.

**Separate admission bound:** at most **128 accepted nodes cumulatively per workflow, including reserved roots**, and at most **127 accepted direct children per node**. These fixed v1 limits are independent of `totalAgentBudget`; joining/cancelling unlaunched work never refunds admission counts. Validate the whole batch against both limits before reserving anything. Thus every own-child review obligation fits the 127-entry completion bound, even after repeated pre-launch expiry. Root enumeration consumes admission capacity at preflight.

**Retries:** every newly launched replacement invocation costs another credit even for the same task. In v1, root `attempts > 1` and worker `attempts`/`retry` fields are rejected; no automatic runner invocation retry occurs. A live parent may explicitly delegate a revised/replacement task after reading a known result, using a new request and remaining budget. This is visible as new work, not a free replay. Budget reducer tests must include repeated failed activations. Pi/provider transport retries and compaction inside an invocation are not new agents; their reported usage still counts. Keep their existing bounded provider policy, but never use it to replay a lost delegation grant.

These are enforceable **activation/allocation** caps on supported runner paths. They are not exact token, turn, dollar, memory, or OS-process ceilings. Unreported provider usage, transport retries, shell processes and external launches make hard billing claims invalid.

## 5. Worker-only tools and bridge

Register only in `dynamic-thread-phase-workflow/worker/index.ts`, explicitly loaded by opted workers, not the package's main extension manifest:

### `workflow_delegate`

```json
{
  "directoryRevision": 7,
  "children": [
    {
      "label": "parser-audit",
      "task": "Inspect parser error paths; do not repeat the schema review assigned elsewhere.",
      "acceptance": [{ "id": "errors", "criterion": "List concrete failure paths with file/line evidence, or explicitly report none found." }],
      "agentBudget": 2,
      "permissions": "r",
      "directoryScope": { "read": ["src/parser"], "write": [] },
      "contextSummary": "The parent is integrating parser and schema findings; focus only on parser execution."
    }
  ]
}
```

Required: revision and 1..4 children; each child has every field above except optional `contextSummary`; `timeoutMs` is an additional optional safe integer in 1..3,600,000 milliseconds. Permissions are `r|w|rw|rwx` and must be a subset of the actual parent's granted permission set. Built-in tool selection is inherited and intersected, never expanded. Child model and cwd are inherited; no model/profile/script/template selection in v1. Tasks are literal text, not template-expanded expressions. A lower budget/scope/timeout is a request; identity/authority are never request fields.

The tool awaits **all** children and their structural joins, then returns ordered results to the same parent. Each settled child releases its live slot and its lent scopes before the next sibling starts; the batch completion restores the parent's execution permit only after all siblings settle. Known child failure does not automatically cancel the next child in the batch; cancellation of the parent stops the batch. The parent must judge the failures. There is no detached mode, wait handle exposed for arbitrary tasks, or cross-tree await graph.

### `workflow_context`

Strict variants:

- `{view: "directory"}`: fresh bounded runner-authoritative view; no arbitrary root selector.
- `{view: "artifact", artifactId, offsetBytes?, limitBytes?}`: runner-generated artifact ID already visible to this node; offset defaults to 0 and must be a nonnegative safe integer <= artifact size, limit is a safe integer 1..8192 with default 4096. No paths/URLs; at most one artifact per call. Return byte boundaries and truncation status, never arbitrary filesystem reads.

Visibility: same workflow forest summaries, full own assignment and ancestor constraints, direct-child results/evidence, and explicitly inherited evidence references. Other nodes' raw prompts, conversations and artifacts are not implicitly readable through this API. The top-level main-chat host retains existing run inspection privileges.

### `workflow_complete`

Required typed handoff (no free-text-as-success fallback):

```text
{status: "success" | "partial" | "failed",
 summary,
 acceptance: [{id, outcome: "passed" | "failed" | "unverified", evidenceIds: string[]}],
 evidence: [{label, path, description}],
 childReviews: [{childNodeId, resultHash, decision: "accepted" | "rejected", reason}],
 remainingWork: string[]}
```

`path` here is a workspace-relative regular file inside this node's read or write scope; evidence labels use ASCII letters/digits/underscore/hyphen to keep `local:<label>` unambiguous. The runner validates and snapshots it to a generated artifact ID with bytes/hash. No arbitrary destination filename. Evidence IDs can also reference already-visible child artifacts. Newly submitted evidence is referred to as `local:<label>` in `evidenceIds` until the runner substitutes its generated `artifact:<uuid>` ID. Reject duplicate labels and unknown references; plain labels cannot alias durable IDs. Evidence descriptions are <=512 bytes; evidence-reference arrays are capped at 8 per acceptance item. Acceptance IDs must match the node assignment; generated root acceptance has one `assignment` criterion, “Satisfy the assigned phase task and cite supporting evidence,” bound to the rendered task's digest in v1. Root task rendering is subject to the same task/context bounds; reject overflow before root activation, never trim it. Reported pass/fail is **agent judgment**, not proof the runner executed a test.

Completion is a single-call tool batch. It submits a durable **completion candidate**, returns Pi `terminate: true`, revokes further delegation/mutation access, and waits for normal Pi settlement/process exit. Only the runner combines a valid candidate, descendant joins, clean execution outcome, and process-group inactivity into `result`. A candidate alone is not success. A worker exiting without one is `MISSING_COMPLETION`; nonzero exit, timeout or cancellation cannot be masked by claimed success. The existing `runPi` nonempty-text success check must be specialized for opted invocations; do not change legacy text outputs globally.

Every node has a runner-generated **own-child join-index artifact**, including an empty index at bootstrap. Each structural join publishes a new immutable version; required context always pins the current `{artifactId, revision, bytes, sha256, childCount}`. Its versioned contents enumerate every joined direct child's ID, exact result hash, execution status and result artifact reference in acceptance order. Older versions remain immutable; completion validates against the current ledger/index, never an old snapshot. The existing bounded artifact reader can read the complete current index in byte pages even when directory/evidence previews omit children. This index is mandatory visible metadata, not optional evidence, and is refreshed after compaction. IDs and hashes cannot be reconstructed from advisory summaries.

Every parent must review every joined direct child by exact result hash before completing; reject missing/duplicate/stale reviews. `accepted` means it considered and integrated that evidence, not automatic acceptance of its correctness. Structural `join` means durable result delivery eligibility, not model approval. A parent claiming success must mark all its own criteria passed and explicitly account for rejected/failed child work in its summary/remaining work; the runner checks structure/completeness, not semantic truth. Main-chat acceptance remains the final judgment.

### Transport and trust

Use a **private Unix-domain socket** served by the existing runner process, under a 0700 runner-owned temporary directory, socket mode 0600; POSIX-only recursive v1. JSONL frames split on LF only; cap before parsing. Do not reuse the read-only shell status bridge as a launch interface.

For every worker activation the runner creates a random capability and an immutable mapping to `{runId, budgetScopeId, nodeId, treeRootNodeId, parentNodeId, depth, invocationId, attempt, ownerEpoch}`. Bootstrap the capability via an inherited private descriptor (requires an optional extra-stdio/bootstrap hook in the existing subprocess helper); never include it in prompts, argv, artifacts, tool arguments/results, ordinary events or inherited shell env. Bind it to the expected worker connection/invocation; reconnect is allowed only to the **same still-live runner epoch and invocation**, using the existing capability. Process PID alone is not authentication. Agents cannot select or mint a root, owner, subtree balance, run/chain identity, or allocation grant.

The trusted worker adapter generates the wire request ID from its invocation plus actual tool-call occurrence; it is not a model-facing parameter. Runner deduplication key is `{invocationId, requestId}` with canonical payload digest. Same key/same digest returns the existing accepted/result state; same key/different digest is `REQUEST_CONFLICT`, never another spawn. A model repeating the same task with a new tool call is new budgeted work. No implicit semantic task deduplication.

For `rwx` only, the trusted adapter may send an internal **`shell_execute`** request for the existing model-facing `bash` tool (command <=16 KiB, optional bounded timeout); this is not a new worker-selectable launch API. The runner binds it to the current invocation/tool-call occurrence, validates its active lane and permission, persists command acceptance/launch/result identity, and executes it through `runProcess`/`runBoundedProcess` with the **root's process journal**. All such shell groups are thus root-owned even if the Pi worker disappears. At most one shell command runs per lane. Apply the minimum of inherited absolute deadline, explicit shell-tool timeout, and the existing shell fallback when no explicit shell timeout is supplied; waiting time counts. Bounded output/updates return through the adapter, with generated artifact references for retained evidence, not unlimited temporary output files. Same request identity returns existing command state, never a duplicate shell; ambiguous shell acceptance fails closed just like delegation. This records shell ownership, not arbitrary commands' idempotence or confinement. Read/search subprocesses must use non-detaching supported operations or the same tracked path; an unreviewed operations backend cannot claim descendant supervision.

**Group settlement contract:** each worker invocation and each shell command (including declared shell phases) owns its exact journaled process-group set under the workflow journal. Retain ownership and TERM-to-KILL escalation after the direct child exits; redirected-stdio/orphan descendants must drain. Do not remove the owned group merely because `close` fired. Prove inactivity of that invocation/command's groups before shell return, phase advancement, child/root join, permit restoration or lease release. Unknown/surviving groups hold these barriers and prevent successful settlement. A whole-run recovery inactivity assertion is not an individual join test: waiting ancestors and unrelated lanes legitimately remain alive. Unsupported group escape is not claimed to be contained. Controlled fixtures must include a direct child that exits while a redirected-stdio descendant survives, both inside worker shell and between a shell phase and the next root.

Every side-effecting request is validated again by the runner. The extension is a bridge, not an allocator. Request fields named `runId`, `rootRunId`, `owner`, `capability`, `budgetScopeId`, `depth`, `model`, `after`, `resumeRunId`, or `background` are rejected, not ignored. Capability/epoch mismatch, stale ownership, missing policy or unknown protocol version fail closed.

## 6. Scheduling, permits and cancellation

Keep `runPipeline` for declared phase order and `boundedFanout` for root fanout admission. The new runner-local scheduler is an allocation/dispatch layer around existing invocation execution, **not** a replacement run lifecycle engine.

Operator-only policy (not workflow or worker fields): `maxConcurrentAgents` default 3 (1..16), `maxLiveAgents` default 24 (1..128), ceilings no higher than `maxDepth=4` and `totalAgentBudget=128`. Record effective policy at start; reject malformed policy. Suggested env names: `PI_DYNAMIC_WORKFLOW_DELEGATION_MAX_CONCURRENT_AGENTS`, `PI_DYNAMIC_WORKFLOW_DELEGATION_MAX_LIVE_AGENTS`, `PI_DYNAMIC_WORKFLOW_DELEGATION_MAX_DEPTH`, `PI_DYNAMIC_WORKFLOW_DELEGATION_MAX_TOTAL_AGENTS`. Operators may lower ceilings, not silently raise a user's values.

- A root lane holds at most one **execution permit**: its currently running worker. A parent blocked on delegation gives that permit to its next child; before returning a joined tool result, the runner hands it back. No extra billing credit for this transfer.
- Waiting ancestors remain real live Pi processes because their conversations/tool stack are in memory. They still count toward `maxLiveAgents` but do not hold execution permits.
- Reserve `D+1` live slots for each admitted root lane for its entire lifetime, where `D` is the workflow's chosen maxDepth. Thus admitted lanes <= `min(maxConcurrentAgents, floor(maxLiveAgents/(D+1)), phase concurrency)`. Reject before starting if a single lane cannot fit. Surplus reserved headroom is not borrowed by another lane in v1.
- Each lane executes just one active ancestor-to-leaf path; remaining batch children are accepted records with no process. This establishes `live agents <= lanes × (D+1)` even if every parent delegates. No deadlock from a pool full of waiting parents, no polling workaround or process eviction. Depth-first serial children are a deliberate v1 throughput tradeoff.
- Root fanout order is input order. Conflicting directory ownership delays root admission rather than consuming a lane while waiting. Within a lane, ancestor ownership is lent down only after the parent is parked; it is restored before parent integration. See scope rules below.
- These caps count runner-launched Pi worker processes, not the main-chat Pi, runner, provider server, grep subprocesses, or arbitrary shell descendants. Process journals and cancellation track supported descendant process groups separately.

At root activation select the existing phase/workflow/default deadline policy, then store an absolute deadline or explicit trusted no-deadline mode. Root admission queue time does not start a new workflow-wide timer; child queue time does count against its already-accepted deadline. A child's deadline is `min(parent absolute deadline, child acceptance time + requested timeoutMs)`; omission inherits the parent deadline. Queued time and waiting-parent time count, deadlines never restart at join/retry, and children cannot remove them. An inherited supervised no-deadline mode remains no-deadline unless narrowed. Shell phases retain existing bounded timeouts; `timeoutMs` is not reinterpreted as a new total-workflow deadline for non-opted or opted roots.

User cancellation revokes all grants, stops root/child admission, and propagates through all active descendants and waiting ancestors. Cancel a failed/disconnected parent subtree before settling it; already-known unrelated root lanes follow the existing phase failure policy. Deadline expiration is failure/timeout, not user cancellation; parent timeout also cancels its descendants with an inherited-deadline cause. Reuse bounded SIGTERM-to-SIGKILL escalation. An unexpected surviving group keeps the lane/leases unresolved and prevents successful root/workflow settlement. Do not signal possibly reused PIDs during recovery.

Connection loss is not permission to launch elsewhere. The runner stops admitting that node's children and cooperatively cancels its subtree; reconnect can retrieve existing state but cannot create a replacement parent. Runner death leaves durable ambiguous work for inspection; no new runner claims or replays it automatically. No detached/untracked launching is supported, including intentional `setsid` escape by shell commands.

## 7. Context and directory contract

Two meanings must not be confused: **work directory** below means the concise forest directory; `directoryScope` means filesystem assignment.

Runner-generated snapshot schema **`pi-workflow-delegation-context/v1`**:

```text
{schema, runId, budgetScopeId, directoryRevision, asOfEventSequence,
 workflowContext: {objective, constraints},
 self: {nodeId, treeRootNodeId, parentNodeId?, depth, state, label,
        grantedPermissions, grantedTools, directoryScope, deadlineAt?,
        agentBudget, spent, available, reservedForChildren},
 ownChildJoinIndex: {artifactId, revision, bytes, sha256, childCount},
 assignment: {task, acceptance, parentContextSummary},
 ancestors: [{nodeId, label, constraintsSummary}],
 directory: [{nodeId, parentNodeId?, treeRootNodeId, phaseIndex, itemIndex?,
              depth, label, state, assignmentPreview, scopePreview,
              resultArtifactId?, resultStatus?}],
 visibleEvidence: [{artifactId, ownerNodeId, bytes, sha256, preview}],
 omitted: {directoryEntries, evidenceEntries}, limits}
```

Only the runner generates topology, state, balances, permissions, ownership, deadline, revision and evidence integrity fields. Agent-authored task/context/result text is quoted and labeled as content, never interpreted as a grant or trusted instruction. The top-level `delegation.context` is copied in full as `workflowContext` for every node and cannot be removed by a child's summary. The host planner must put inherited non-negotiables there rather than relying on extraction from arbitrary prose. Ancestor summaries are bounded advisory descriptions of assignments plus runner-owned scope/deadline constraints; they cannot add authority or erase `workflowContext`. Nodes see their ancestry plus enough sibling/root summaries to avoid duplicating work; no whole-transcript inheritance and no LLM calls for automatic context compression in v1.

Hard bounds (UTF-8 bytes, not JS character counts):

| Item | v1 limit |
| --- | --- |
| Incoming bridge frame / outgoing frame | 64 KiB / 64 KiB |
| Workflow objective / immutable constraints | 2048 / 8 entries × 256 |
| Task / parent context summary | 4096 / 2048 |
| Label / criterion ID | 80 / 64 |
| Acceptance criteria | 8, each criterion <=512 |
| Scope paths | 8 read + 8 write, each <=256 |
| Ancestors | <=4, each constraints summary <=512 |
| Directory | <=32 entries and <=8192 bytes total; each preview <=160 |
| Visible evidence preview directory | <=32 entries; each preview <=160 (required join-index reference is separate) |
| Accepted nodes / direct children | <=128 cumulatively including roots / <=127 cumulatively; never refunded |
| Injected context snapshot | <=24 KiB total |
| Complete summary / remaining work | 4096 / 8 entries × 512 |
| Complete evidence | <=8 regular files, <=256 KiB each, <=1 MiB per node |
| Complete child reviews | <=127; each reason <=128 |
| Complete payload | <=48 KiB total; reject rather than trim required evidence/reviews |
| Delegate model-visible result | <=24 KiB; at most 4 child summaries, <=2048 each, plus artifact references |
| Bridge requests | <=128 per invocation and <=4096 per workflow, including duplicates/denials/context reads |

Use deterministic Unicode-safe clipping only for **display previews** and summaries supplied as previews. Never truncate IDs, authority, required constraints, acceptance or caller inputs into different valid values: reject oversize. If required context cannot fit, deny `CONTEXT_LIMIT`; do not silently remove constraints. Directory selection prioritizes self, ancestor path, direct children, active same-parent siblings, then other roots/nodes in stable phase/index/creation order. Aggregate omitted counts and statuses. The bounded full forest is available to main-chat inspection; workers do not gain arbitrary pagination over private work.

Revision is a monotonically increasing integer over directory-affecting ledger transitions. Snapshots are projections, not authority. Inject at worker bootstrap and refresh in the trusted extension's `context` hook before each model request (also after compaction), replacing its prior synthetic snapshot rather than appending growing history. `workflow_context` can explicitly refresh. A delegation with a noncurrent revision gets `STALE_CONTEXT` plus a fresh bounded snapshot and **no reservation**. Revalidate all grants against current ledger anyway. Do not age-out a grant, auto-cancel work, or infer a stall because a snapshot is old. Busy parallel roots can cause a stale denial; the model may request again after inspection, within request limits.

### Filesystem narrowing and shared writes

`directoryScope` is `{read: [...], write: [...]}` using canonical workspace-relative directory prefixes. Arrays may be empty if the corresponding tool capability is absent; a granted read/write capability requires a nonempty corresponding scope. Top-level `.` is allowed only as an explicit user choice. Absolute paths, traversal, empty strings, NUL, glob patterns, interpolation, and symlink scope roots are rejected. Use canonical POSIX separators (foundation declarations reject backslashes, repeated/trailing separators and `./` aliases rather than silently rewriting caller input), canonicalize the workspace and nearest existing ancestor for new paths, and test containment by path components, not string prefixes. A child may keep or narrow each set but cannot expand it; `cwd` stays the canonical workflow cwd. Scope policy applies to roots as well as descendants.

Supported file tools (`read`, `grep`, `find`, `ls`, `edit`, `write`) need scoped adapters using Pi's existing operations/implementations where compatible, with permission and canonical-path checks at execution. Traversal/list/search must not follow links out of scope; new-file parent checks and hard-link aliases need fail-closed handling (reject writable existing files with multiple links in v1). Artifact/control directories and the worker's credential/config storage are never ordinary workspace grants. A bootstrap tool provenance check must prove the scoped adapter, not an unrelated same-name override, is installed. Cross-process ownership lives in the runner, not Pi's in-process mutation queue.

Use hierarchical prefix **leases** for supported paths:

- Multiple read leases may overlap. Across independent root lanes, any write scope conflicting with another lane's read **or** write scope delays the later root; this prevents readers observing half-written integrations. Root leases cover their entire subtree until root settlement, including waiting ancestors.
- A parked ancestor lends only the granted narrower child scopes within its lane. Parent file tools cannot run until the child's structural join and restoration. Serial children may reuse a prefix after join; concurrently active writers never share it.
- Parents decompose, assign distinct responsibilities, then integrate/review after children; they do not simultaneously implement a child's assignment. Shared integration files stay parent-owned, excluded from child write scopes. A child proposes changes through evidence when it does not own the shared target.
- Fanout's single scope currently applies to every item. Read-only items can run in parallel; overlapping writable items serialize. No templated per-item scopes in v1. Explain reduced concurrency in observations rather than pretending writes are isolated.
- For an `rwx` worker, path scopes are **cooperative assignments**, not confinement. Since shell access can affect any file, take an exclusive workspace lane while that root subtree can execute shell. A shell phase runs only after all preceding roots join. This does not coordinate unrelated external workflows or human editors; users must avoid concurrent external writes.

Neither capabilities, file checks, directory permissions nor Unix socket secrets contain malicious **same-user** shell/extension code. A shell can read credentials, forge files, invoke Pi directly or bypass the bridge. Supported execution paths are bounded; hostile-code containment requires a separate OS sandbox/user/container and is out of scope. Do not describe `rwx` as sandboxed or claim exact hard billing caps.

## 8. Durable transitions, results and crash behavior

Reserve **`delegation/`** in `artifact-layout.mjs` before enabling the feature. All new mutable atomic targets and temporaries live underneath it; user-generated artifacts cannot shadow that directory in any mode. Do not change protected successor files.

One single-writer **`pi-workflow-delegation-journal/v1`** log and its bounded projection belong to the root run. Suggested layout:

```text
delegation/manifest.json            # immutable policy/spec/profile/owner binding
delegation/events.jsonl             # authoritative transitions, append + fsync
delegation/state.json               # atomic derived projection, not sole authority
delegation/nodes/<nodeId>/...        # runner-generated assignments/results/evidence
delegation/phase-outputs/...         # completion evidence, NOT a resume checkpoint
```

Use monotonic event sequence, event ID, owner epoch, schema, exact node/request identities, payload digest and previous-record hash. Bound the state projection and manifest to 1 MiB each, journal to 16 MiB and each record to 64 KiB; oversized/truncated/unknown/corrupt authority fails closed. Request counters/denials are bounded; never let repeated denied requests create unlimited durable logs. Exhaustion denies further calls and fails the affected invocation with evidence, not a new retry. Reserve terminal headroom atomically before admission: 3 × 4096 bytes per outstanding node (result/join/closure), 4096 per outstanding batch, 3 × 4096 per outstanding shell command, and 4096 for workflow closure. Terminal records must be compact (<=4096 bytes), with large results/evidence/indexes in separately bounded artifacts referenced by hash. All ordinary appends, including completion candidates and denials, must leave this headroom intact; terminal appends consume only their matching reservation. Deny acceptance if either the record or new reserves cannot fit. Failure results need no new ordinary-record space. Unknown ownership retains reservations. Runtime must track actual serialized bytes, outstanding obligations and fsync ordering; the pure headroom calculation is not a journal implementation.

Required durable records and ordering:

1. `root_reserved`: all declared root identities, quotas and scope plan committed before readiness/activation. Persist the immutable root plan in the manifest (<=1 MiB), then reference its hash/count in this event so 128 scoped roots cannot overflow the event frame limit.
2. `delegation_accepted`: request identity/digest, parent, **all child identities and grants**, context revision and reservations in one atomic decision. Send accepted acknowledgement only after fsync.
3. `launch_intent`: consume activation credit for a Pi worker (not for a shell command) and bind the process-journal reservation token **before spawn**. Existing process journal reserves first; if either write fails, no spawn. A crash between those records is conservatively ambiguous, never an invitation to spawn later.
4. `worker_started`: durable process-journal PID transition followed by delegation start record, invocation/profile/epoch binding and deadline. If recording fails after spawn, stop admission and cancel owned processes; preserve ambiguity.
5. `completion_submitted`: immutable validated candidate/evidence references; not yet a terminal result.
6. `node_result`: terminal execution classification, acceptance claims, artifact hashes, exclusive usage completeness, descendant-result references, and process/group disposition. Persist evidence atomically and fsync before references. Emit observation projections only after authority is durable.
7. `node_joined`: exactly once per child after terminal result and group-inactivity proof; return unused child credits and release its live slot/lent scopes to the parked ancestor lane. This allows the next pre-reserved serial sibling to start. Then `delegation_joined`, exactly once per complete batch, references ordered result hashes and those credit-return transition IDs (it does **not** return credits again), and restores the parent's ownership/execution permit. Commit before sending final tool response. A lost response can be resent to the same live invocation without spawning children or returning credits twice.
8. `node_closed` / `workflow_delegation_closed`: final root settlement and fixed-quota returns, then ordinary workflow result and thread-phase terminal lifecycle.

Cancellation, no-child spawn failure, denied/conflicting requests and infrastructure failures have explicit terminal causes. Accepted/start/result/join are distinct; a start event is not success, a submitted completion is not process exit, a hash is not proof of test correctness. State projections and UI logs can be regenerated from authority; they cannot authorize launch. Capability secrets never enter this journal.

### Denial/error envelope

All worker API outcomes carry **`pi-workflow-delegation-response/v1`**:

```text
{schema, status: "joined" | "denied" | "error" | "completion_recorded" | "context",
 requestId, code?, message?, directoryRevision,
 accepted: boolean, results?, context?, artifactRefs?, budget?}
```

- `completion_recorded` acknowledges only a durable completion candidate, not worker success.
- `joined` means all accepted children have structural terminal records, including failed/cancelled children. Inspect each result's execution status; it is not “all succeeded.”
- `denied` means this request created no child/reservation. Codes: `NOT_ENABLED`, `DEPTH_LIMIT`, `BUDGET_EXHAUSTED`, `ADMISSION_LIMIT`, `JOURNAL_LIMIT`, `INVALID_REQUEST`, `PERMISSION_DENIED`, `SCOPE_DENIED`, `STALE_CONTEXT`, `CONTEXT_LIMIT`, `REQUEST_LIMIT`, `PARENT_NOT_ACTIVE`, `CANCELLED`, `DEADLINE_EXPIRED`, `UNSUPPORTED_MODE`.
- `error` is infrastructure/protocol failure, with `accepted` distinguishing known acceptance from known nonacceptance. Codes: `UNAUTHORIZED`, `REQUEST_CONFLICT`, `UNSUPPORTED_VERSION`, `PROFILE_UNAVAILABLE`, `PERSISTENCE_FAILED`, `OWNERSHIP_UNKNOWN`, `RESULT_INVALID`, `MISSING_COMPLETION`. If acceptance is unknowable on disconnect, the adapter reports `ACCEPTANCE_UNKNOWN` and **does not** claim `accepted: false` (omit that field only for this transport-local error).
- Expected denials are normal typed Pi tool results, so the model can revise scope or integrate without delegation. Installed Pi does not set `isError` just because a returned object contains it; actual adapter exceptions must throw a concise serialized error. Do not turn transport failure into a retry instruction. Child failure after acceptance returns its durable result, never an empty success string.

### Resume honesty

Existing workers use `--no-session`. A crash loses the live parent's tool stack and conversation; neither phase artifacts, a context summary, nor a Pi tool-call ID reconstructs that execution. In v1, **every opted `resumeRunId` is rejected before launch**. No automatic accepted-but-unstarted dispatch after restart, no restarted parent that reruns a delegation call, and no reconstruction of arbitrary conversation branches.

On inspection after runner death: accepted without launch intent, launch intent without PID, started without result, or result without join is unresolved/ambiguous, with held budget and explicit diagnostics. Even complete results without a live parent do not authorize a new parent. Existing journal inactivity proof can establish that supported groups are gone, but cannot prove side effects never happened. A new manually authorized workflow may consume verified evidence references; it is visibly new work with its own limits, not resume. No repair of successor edges is required or permitted by this feature.

## 9. Observation, supervision and usage

Emit namespaced `delegation/v1` phase events for acceptance, queueing, running, waiting, result, join, denial and ambiguous work. Node states must distinguish `reserved`, `queued`, `running`, `waiting_children`, `result_pending_exit`, `joined`, `failed`, `cancelled`, and `unknown`. Include runner identities with existing command invocation/attempt/item attribution so similarly named descendants cannot collide in command ledgers. A small tree projection in `thread_phase_runs` and the existing monitor shows depth, parent, scope ownership, spent/reserved/available budget, lane/live-slot counts and evidence links. Display live **delegation** edges separately from `after`/successor chain edges.

Only the owning root **workflow run**, not each forest root or child, gets main-chat terminal continuation/progress review. Existing session/cwd/start provenance and submission gating remain authoritative. Foreground returns to its caller; background success/failure returns to chat; user cancellation does not. Ten-minute reviews remain requests for judgment, not stall detection: inspect logs, wait, report, or explicitly intervene. No timer kills, retries, resumes, launches successors or declares progress from log volume. Include “parent waiting for children” and bounded directory/evidence pointers in reviews without changing cadence policy or the accepted LOW bounded-read bridge waiver.

**Exclusive usage accounting:** aggregate each worker's own provider-reported assistant usage once under `{invocationId, turn/message identity}`; separately account for its own reported compaction usage where available. Track missing/partial usage explicitly. Do not sum streaming cumulative usage plus final message usage, `agent_end.messages`, final result totals plus their source events, or child usage embedded in parent tool results/summaries. `workflow_delegate` and `workflow_complete` must **omit Pi's top-level tool `usage` field** for already-runner-accounted descendants; bounded display totals live in `details` with `accounting: "display-only"`. Never put these totals in thread-phase event `data.usage`, which the existing store aggregates. Fixtures must prove display-only observations bypass both collector and store accounting paths. Installed `grep` directly launches ripgrep and may bypass custom `readFile`; scoped search requires a proven adapter, not merely scoped read operations. Opted collector mode must classify usage sources before merging (current collector does not). Whole-forest usage = sum of exclusive invocation usage, including failed attempts. Parent integration's actual input tokens for reading child summaries are real parent usage, not an accounting duplicate to subtract. No hard token/dollar ceiling is promised.

## 10. Parent-controlled implementation sequence

No commits are made by this design agent. Parent reviews the contract, chooses scope changes explicitly, and controls staging/commits. Keep public opt-in unavailable until worker/runtime safety is end-to-end.

### Slice 1 — implemented pure foundations (internal only)

Actual new module boundaries under `dynamic-thread-phase-workflow/lib/`:

- **`delegation-contract.mjs`**: schema/version names, immutable bounds, strict pure validators for policy/internal root plans/worker requests/results. Internal schema constants and exact-version checks do not implement any public v3 decoder. Export `validateDelegationPolicy`, `validateRootAllocations`, `validateDelegationRequest`, `validateCompletionRequest`. No TypeBox/Pi imports or file I/O; extension schema must be checked against these fixtures.
- **`delegation-budget.mjs`**: `createBudgetState`, `reserveRoots`, `reserveChildren`, `chargeLaunchIntent`, `joinAllocation`, `assertBudgetInvariants`; immutable/reducer transitions with IDs/times passed in. Whole-forest conservation, fixed root quotas, idempotent transition IDs, conservative attempt charging. No spawn, clocks, UUID generation, timers, environment reads or persistence.
- **`delegation-context.mjs`**: `buildDelegationContext`, `selectDirectoryEntries`, `validateContextRevision`; deterministic bounded projections from trusted normalized records, hierarchy/visibility and UTF-8 preview clipping. Never derive authority from agent summaries.
- **`delegation-scope.mjs`**: pure component-wise normalized-path containment, permission/tool intersection and prefix lease conflict calculation. Receives canonicalized path facts; does **not** claim to canonicalize/secure a real filesystem. Runtime adapter owns realpath/no-follow/regular-file/hard-link checks.
- Matching **`delegation-contract.test.mjs`**, **`delegation-budget.test.mjs`**, **`delegation-context.test.mjs`**, **`delegation-scope.test.mjs`** in `test/`. No runner import or process creation. Add `.d.mts` only where TS consumers need declarations.

Tests: strict integer/unknown-key/version corpus; no v1/v2 opt-in upgrade; zero depth; many sequential roots; duplicate static item labels; all-or-nothing root/batch reservations; rejected oversubscription; idempotent charge/join; failed/replacement attempts charged; cancellation before/after launch intent; unused returns; ambiguous reservations held; randomized finite operation sequences conserving budget; bounded contexts, required-content overflow, stale revision, hidden evidence and deterministic omitted counts; permission/path-prefix narrowing and lease conflicts. Foundations do not register tools or broaden existing decoders.

#### Implemented interfaces and remaining boundaries

- `validateRootAllocations(policy, groups)` takes **internal extracted groups** `{phaseIndex, agentBudget, items?: string[], directoryScope?}`, not public phase objects. It returns index-ordered allocation descriptions; the future host must reject unsupported modes/attempts before extracting these groups. Root IDs remain supplied separately by the trusted runner.
- Budget APIs take immutable state, explicit node IDs and explicit transition IDs. Roots/children are `{nodeId, agentBudget}` arrays. Same transition ID and canonical payload is an in-memory no-op; conflicting payload is rejected. `chargeLaunchIntent` permits exactly one activation per node; replacements use new nodes. The model checks serial child eligibility but does **not** park a Pi parent, enforce deadlines/leases, or schedule processes. Callers must compose revision, permissions, scope, admission and journal checks before durable acceptance.
- `joinAllocation(state, nodeId, {terminal, groupsInactive, structuralJoin}, transitionId)` requires three literal `true` attestations from a future trusted runtime. They are **not evidence verified by the reducer**. `allocationCounters` projects subtree spent/held credits. No restart/recovery support is provided.
- `calculateJournalHeadroom` / `assertJournalCapacity` calculate ordinary-record capacity from supplied actual byte counts and outstanding node/batch/command/workflow obligations. They do not reserve disk space or integrate a durable journal transaction with the budget reducer. Future admission must atomically compose both checks; terminal appends must consume matching reservations.
- `buildDelegationContext` takes trusted normalized directory records (<=128), full self/assignment/ancestor records, an explicit inherited-artifact allowlist, and the mandatory current join-index reference. It validates topology, bounded fields and result/reference consistency; it cannot certify that caller-supplied state/hash/revision is current or authoritative. Directory inputs include `task`, `scopePreview`, and `createdSequence`; only clipped previews leave this projection. Evidence previews are capped at 32 entries; omitted evidence counts include only visible evidence, not private artifacts. Omitted directory state counts remain explicit. Optional previews are removed before rejecting oversized **required** context.
- `buildOwnChildJoinIndex` returns JSON content plus `{artifactId, revision, bytes, sha256, childCount}` for supplied acceptance-ordered joined results; it does not publish an artifact. The runtime must check parent ownership, publish immutable versions and pin the current version. `projectArtifactRead` verifies supplied immutable bytes/hash and an explicit visible-ID allowlist; returns base64 byte pages with offsets/EOF/truncation (safe even across UTF-8 boundaries). It reads no filesystem. `projectDelegationResults` is a bounded inner result projection, **not** a transport response envelope; it preserves execution status/hash/reference and flags summary clipping, without usage totals.
- `validateCompletionRequest` checks exact assignment criteria, current supplied direct-child review hashes and visible evidence IDs. Regular-file/scope/size snapshots, content hash integrity, candidate persistence and terminal execution settlement remain runtime obligations. No semantic correctness is inferred from claims.
- `narrowAuthority` uses explicit `deadlineAt: null` for trusted no-deadline mode and caller-supplied acceptance time; it intersects inherited file-tool names. Worker bridge tools are outside that file-tool calculation. `validateScopedPathFacts` checks supplied canonical/no-symlink/regular-file/link-count/protected-prefix facts only. Real filesystem verification, symlink scope-root rejection, new-file parent checks, search adapters, races and shell supervision remain unimplemented.

Focused test results and isolated scratch directories are recorded in `/tmp/autonome-pi-fractal-progress.md`. No existing public decoder, runner, usage collector, store, artifact layout or worker profile was modified.

### Commit 2 — shared scheduling and execution lifecycle (fixture-only entry)

Add `lib/delegation-journal.mjs` (single-writer durable transitions/recovery classification), `lib/delegation-runtime.mjs` (root lanes, quotas, permit transfers, queue/signals, joins), and `lib/delegation-filesystem.mjs` (canonical paths, scoped operations/leases/evidence copies). Extract/reuse invocation execution from the CLI as **`lib/agent-execution.mjs`**, without changing non-opted behavior; preserve process journal, deadlines, JSON traces and artifact collision discipline. Add the narrowly optional bootstrap FD hook to `subprocess.mjs` and reserve `delegation/` in `artifact-layout.mjs`.

No model-facing feature yet. Inject fake worker executor and clock; tests `delegation-runtime.test.mjs`, `delegation-journal.test.mjs`, `delegation-filesystem.test.mjs`. Cover deep waiting paths at minimum live cap, concurrent roots, serial siblings, mixed scope conflicts, cancellation/deadlines, crash injection at every durable boundary, duplicate joins/returns, surviving groups, request/log limits and usage-source classification. A log cannot accidentally authorize replay. Keep ordinary runner regressions green via explicit safe test lists.

### Commit 3 — worker tooling and hosted dynamic API

Add `worker/index.ts` and `lib/delegation-bridge.mjs`, including runner-backed `bash` operations and journaled internal shell request identities; activate strict hosted v3 decoding/compilation only when worker profile, single-use launch authorization, accepted/start/result/join persistence, and completion/permit gates are connected. Public schema alternatives isolate the v2 and opted branches (do not globally relax phase allowlists). Reject unsupported template/scripted/legacy/CLI/resume/after inputs with actionable messages. Add node attribution and exclusive usage mode to shared execution/collector without altering existing collection defaults.

Tests `delegation-worker.test.mjs`, `delegation-integration.test.mjs`: isolated installed-Pi extension loading with a **local deterministic fixture provider**, no network credentials/model calls; verify exact names/provenance and no top-level tools, mixed tool-batch rejection before any mutation, real worker-originated bridge delegation during one in-memory parent conversation, forged capability/authority fields, fragmented/malformed/oversized JSONL, disconnect-after-accept, stale context, clean terminating completion, shell process-group ownership after Pi exit, shell acceptance deduplication, descendant usage not counted twice, and each unsupported public mode denied before run creation. The fixture must demonstrate child-to-grandchild delegation, not just scripted runner calls. These fixtures require explicit parent authorization to run; ASTRA did not launch them for this design pass.

### Commit 4 — observation, documentation and controlled end-to-end acceptance

Extend existing monitor/run inspection/progress-review text with bounded forest views; root-only continuation tests **must already protect commit 3's live surface**, not wait for UI polish. Update skill/runner README with examples, serial-child limitation, scopes, budget units and no-resume policy. Tests `delegation-observation.test.mjs`, `delegation-e2e.test.mjs`: sequential planning/review/integration roots, static fanout roots, two live depths, denied budget/depth, failure/partial acceptance, cancellation while parent waits, explicit deadlines, lost runner without replay, artifact integrity, and one root terminal continuation/no child reviews-to-chat. No unattended live-provider dogfood; parent approves any later real launch.

If commit 2 extraction cannot preserve legacy behavior independently, split extraction plus regression tests before the scheduler. Do not land a publicly callable tool that has only pure budgets but no durable lifecycle/tool boundary.

## 11. Validation commands and release gates

The four foundation test files now exist; their execution is recorded in the progress handoff. All later-stage tests below remain proposed and unrun. Foundation success is not runtime approval. Never use `npm test`, `npm run test:dynamic`, or a wildcard containing paused successor work.

Run future commands from the repository root after creating the named files. Use this wrapper for **each** validation invocation (fresh HOME/store/session; no inherited local bridge/title/background/provider configuration):

```bash
repo="$PWD"
node_bin="$(command -v node)"
scratch="$(mktemp -d /tmp/autonome-fractal-validation.XXXXXX)"
mkdir -p "$scratch/home" "$scratch/agent" "$scratch/store" "$scratch/sessions" "$scratch/tmp"
env -i PATH="$(dirname "$node_bin"):/usr/bin:/bin" \
  HOME="$scratch/home" TMPDIR="$scratch/tmp" \
  PI_CODING_AGENT_DIR="$scratch/agent" \
  PI_CODING_AGENT_SESSION_DIR="$scratch/sessions" \
  PI_THREAD_PHASE_STORE_DIR="$scratch/store" \
  PI_DYNAMIC_WORKFLOW_BACKGROUND= PI_DYNAMIC_THREAD_PHASE_BACKGROUND= \
  PI_THREAD_PHASE_STATUS_BRIDGE=0 PI_THREAD_PHASE_TERMINAL_TITLE=0 \
  PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  "$node_bin" --test \
  "$repo/dynamic-thread-phase-workflow/test/delegation-contract.test.mjs" \
  "$repo/dynamic-thread-phase-workflow/test/delegation-budget.test.mjs" \
  "$repo/dynamic-thread-phase-workflow/test/delegation-context.test.mjs" \
  "$repo/dynamic-thread-phase-workflow/test/delegation-scope.test.mjs"
# Inspect retained scratch evidence; remove only this generated directory when done.
```

Later-stage exact test argument sets, each using the same fresh wrapper, replacing only its `--test` list:

```text
Commit 2:
 dynamic-thread-phase-workflow/test/delegation-runtime.test.mjs
 dynamic-thread-phase-workflow/test/delegation-journal.test.mjs
 dynamic-thread-phase-workflow/test/delegation-filesystem.test.mjs
Commit 3:
 dynamic-thread-phase-workflow/test/delegation-worker.test.mjs
 dynamic-thread-phase-workflow/test/delegation-integration.test.mjs
Commit 4:
 dynamic-thread-phase-workflow/test/delegation-observation.test.mjs
 dynamic-thread-phase-workflow/test/delegation-e2e.test.mjs
Focused existing regressions (controlled fixtures only, inspect before running):
 dynamic-thread-phase-workflow/test/schema-contract.test.mjs
 dynamic-thread-phase-workflow/test/pi-json-stream.test.mjs
 dynamic-thread-phase-workflow/test/process-journal.test.mjs
 dynamic-thread-phase-workflow/test/subprocess-output.test.mjs
 dynamic-thread-phase-workflow/test/artifact-collision.test.mjs
 dynamic-thread-phase-workflow/test/agent-timeout-policy.test.mjs
 dynamic-thread-phase-workflow/test/structured-resume.test.mjs
```

Worker compatibility tests must explicitly select the installed binary/module path and fixture provider within their isolated profile; never fall back to the real model/provider on fixture failure. Use no-network SDK/CLI resource probes, not actual external inference, to test both the worker binary 0.85.1 and repository SDK 0.84.2 or deliberately narrow the supported version pair. Do not install/update/reconcile Pi or edit its global settings. The configured package pin can reconcile/reset the protected dirty checkout.

Before and after every implementation batch, from repository cwd with the background variables cleared:

```bash
env -u PI_DYNAMIC_WORKFLOW_BACKGROUND -u PI_DYNAMIC_THREAD_PHASE_BACKGROUND \
  sha256sum -c /tmp/autonome-pi-paused-repair.hashes
```

Preserve exactly `thread-phase-visualizer/lib/chain-store.mjs`, `dynamic-thread-phase-workflow/lib/successor-repair.mjs`, and `dynamic-thread-phase-workflow/test/successor-repair.test.mjs`. Do not read/run the paused test, resume that work, modify core/templates/installed Pi, launch agents without authorization, or stage/commit/push/tag/release/switch branches/stash/reset.

### Genuinely blocking gates, not hidden assumptions

There is no unresolved budget/root/depth/resume decision needed to build commit 1 after parent review. Two empirical **enablement blockers** remain in addition to the wholly unimplemented runtime slices:

1. **Worker/provider compatibility:** disabling broad discovery can remove the local dynamically discovered provider which motivated today's `runPi` profile. Approve an explicit provider-only profile, demonstrate no main-chat hooks/tools or same-name unscoped overrides, and verify a model resolves under it. If this cannot be done without installed/global edits, support only already-configurable static/built-in providers initially and reject the others. Do not weaken isolation silently.
2. **Installed-Pi lifecycle proof:** controlled no-network fixtures must prove full-batch gating, bootstrap FD delivery, blocking tool continuation/`terminate` settlement, scoped-tool operations and expected usage events for the actual supported Pi binary/SDK versions. Static source inspection supports the design but is not an execution test. If the guarantee cannot be obtained through the documented extension API, stop before public exposure and review a narrow worker SDK entrypoint using the same subprocess runner (not a new mission engine or general conversation-resume system).

Parent approval is also required for the deliberate v1 restrictions: direct structured/static roots, serial descendant batches, fixed root quotas with no cross-root borrowing, no automatic invocation retries, and no recursive resume. If any is unacceptable, revise this contract before runtime implementation rather than implying that deferred modes work.
