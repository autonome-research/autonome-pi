# thread-phase-visualizer

Generic Pi-side event store and visualization extension for thread-phase workflows.

This is intentionally workflow-agnostic: workflows emit structured events and artifacts; the Pi extension watches those events and exposes them through generic tools/commands. Specific workflows should not implement their own TUI watchers.

## Store layout

Default store:

```text
~/.pi/agent/thread-phase/
├── index.jsonl          # global append-only event stream
├── run-starts.jsonl     # compact append-only ownership lookup catalog
├── continuations.json   # authoritative v4 pending/delivered + submission/claim identity state
├── progress-reviews.json # legacy review state, untouched and inert since v0.18.2
├── continued-runs.json  # legacy-compatible delivered/claimed id mirror
├── continued-runs.timestamps.json # legacy-compatible retention metadata
├── index-pending/       # transient durable index-reconciliation markers
├── index-quarantine/    # malformed/unsupported recovery markers
├── run-start-quarantine/# dead orphan start reservations
├── runs/
│   ├── <runId>.jsonl       # per-run event stream
│   └── <runId>.start.json  # immutable workflow-start ownership sidecar for new runs
└── artifacts/           # optional workflow-owned artifact location
```

Override with:

```bash
PI_THREAD_PHASE_STORE_DIR=/path/to/store
```

## Event schema

All events use this envelope:

```ts
type ThreadPhaseUiEvent = {
  schema: "thread-phase-ui/v1";
  eventId: string;
  timestamp: string;
  runId: string;
  workflow: string;
  cwd?: string;
  trigger?: unknown;
  type:
    | "workflow_start"
    | "workflow_end"
    | "phase_start"
    | "phase_event"
    | "phase_end"
    | "agent_event"
    | "artifact"
    | "error";
  phase?: string;
  // Raw event statuses are preserved as open strings. Projection helpers expose
  // normalizedStatus for UI decisions.
  status?: "running" | "success" | "failed" | "cancelled" | "skipped" | string;
  level?: "debug" | "info" | "warning" | "error" | string;
  message?: string;
  data?: unknown;
  artifact?: {
    kind: "markdown" | "file" | "url" | "json" | string;
    title: string;
    path?: string;
    url?: string;
    content?: string;
    preview?: string;
    data?: unknown;
  };
};
```

## Workflow integration

Treat `lib/store.mjs` as the stable public workflow API. UI code should also read through this module rather than parsing JSONL directly.

Status constants are exported as `STATUSES`:

```ts
STATUSES.RUNNING   // "running"
STATUSES.SUCCESS   // "success"
STATUSES.FAILED    // "failed"
STATUSES.CANCELLED // "cancelled"
STATUSES.SKIPPED   // "skipped"
STATUSES.UNKNOWN   // "unknown"
```

Use `phaseEvent(..., { kind: "progress", completed, total })` for progress-like events. Use `emitActiveIo(run, phase, snapshot)` for component I/O snapshots that any monitor, tool, or debugger can consume without being coupled to a particular UI. `phaseEvent(..., { kind: "active_io" })` is also normalized/redacted by the store, but `emitActiveIo` is preferred for clarity. Keep workflow-specific detail inside `data`; avoid inventing new top-level event types until the UI needs them.

Fanout phases use the same `phase_event` top-level type with a `data.kind` convention:

```ts
phaseEvent(run, "review", { kind: "fanout_start", total: files.length });
phaseEvent(run, "review", { kind: "fanout_item_start", itemId: file, label: file, index });
phaseEvent(run, "review", { kind: "fanout_item_end", itemId: file, status: STATUSES.SUCCESS });
phaseEvent(run, "review", { kind: "progress", completed, total: files.length });
```

Projection helpers expose this as `phase.fanout`, with item summaries for expanded UI views.

Active I/O snapshots use a workflow-agnostic payload:

```ts
emitActiveIo(run, "worker", {
  componentId: "worker-123",
  component: "worker M2-F1",
  role: "pi",                // pi | process | validator | custom
  status: "running",         // running | success | failed | timeout | ...
  pid: 12345,
  cwd: "/repo",
  command: "pi --mode json ...",
  inputPreview: "prompt or command preview",
  outputPreview: "latest model/process output preview",
  stdoutPreview: "stdout tail",
  stderrPreview: "stderr tail",
  inputBytes: 1234,
  stdoutBytes: 5678,
  stderrBytes: 0,
});
```

Projection helpers expose the latest snapshot as `run.activeIo` and `phase.activeIo`. The monitor panel renders that summary, and non-UI tools can read the same projected fields or raw `active_io` events from JSONL. Snapshots are persisted in append-only logs; the store applies conservative redaction for common token/secret forms and caps preview fields, but workflows should still keep previews compact and avoid including secrets. Set `PI_THREAD_PHASE_ACTIVE_IO=0` to disable active-I/O persistence.

From a Node/TypeScript workflow runner:

```ts
import {
  STATUSES,
  createRun,
  phaseStart,
  phaseEvent,
  phaseEnd,
  artifact,
  completeRun,
  failRun,
  emitActiveIo,
} from "~/.pi/agent/extensions/thread-phase-visualizer/lib/store.mjs";

const run = createRun({
  workflow: "code-review",
  cwd: process.cwd(),
  trigger: { kind: "post-commit", ref: "HEAD" },
  input: { commit: "HEAD" },
});

try {
  phaseStart(run, "collect-diff");
  // ...work...
  phaseEnd(run, "collect-diff", STATUSES.SUCCESS);

  artifact(run, {
    kind: "markdown",
    title: "Review report",
    path: "/repo/.git/pi-code-reviews/abc123.md",
  });

  completeRun(run, STATUSES.SUCCESS);
} catch (error) {
  failRun(run, error);
}
```

For `runPipeline(...)`, either mirror the pipeline event stream:

```ts
import { mirrorPipelineEvents } from "~/.pi/agent/extensions/thread-phase-visualizer/lib/store.mjs";

for await (const event of mirrorPipelineEvents(runPipeline(phases, ctx), run)) {
  // existing logging if desired
}
```

Or wrap phase objects so phase start/end are emitted consistently:

```ts
import { wrapPhases } from "~/.pi/agent/extensions/thread-phase-visualizer/lib/store.mjs";

const visualizedPhases = wrapPhases(phases, run);
for await (const event of runPipeline(visualizedPhases, ctx)) {
  // normal thread-phase event handling
}
```

## Projection/read APIs

> **v0.13 migration:** caller-supplied `runFile` overrides are rejected. All events use `runFileFor(runId)` so ownership verification and crash recovery share one authoritative path. Remove custom `runFile` fields and migrate external logs into the canonical store layout before upgrading.

UI code should consume projected summaries rather than reconstructing state itself:

```ts
import {
  projectRun,
  projectRuns,
  getRunSummary,
  latestRunSummaries,
  normalizeStatus,
  readArtifactContent,
} from "~/.pi/agent/extensions/thread-phase-visualizer/lib/store.mjs";

const runs = latestRunSummaries({ cwd: process.cwd(), limit: 20 });
const detail = getRunSummary(runs[0].runId);
```

The projected run shape includes:

- `normalizedStatus` for icon/color decisions
- `workflowStartResolved` for store-backed ownership confidence. New runs atomically reserve an immutable compact start sidecar (dead pre-publication reservations are quarantined on a safe retry) (strictly capped at 16 KiB) and publish the run log with no-replace semantics before appending the same ownership envelope to `run-starts.jsonl`. Every serialized event is capped at 512 KiB, so the complete start fits the 512 KiB verification prefix and pending index markers remain safely recoverable. The compact envelope contains only security/UI ownership fields; fully returned summaries verify it against the authoritative run prefix and preserve full public metadata and trigger values. Legacy runs fall back to per-run prefix verification within fixed per-run and aggregate byte/scan budgets. If lookup cannot prove the start, owner metadata and launch cwd remain unknown and session scoping fails closed; later tail events cannot supply ownership.
- `workflowStartCwdPresent` preserves whether that authoritative start contained `cwd`. Only an omitted `cwd` (including the JavaScript compatibility form `cwd: undefined`) may fall back to absolute legacy owner metadata. Explicit `null`, empty, whitespace-only, relative-without-a-known-base, or malformed primary values remain authoritative and fail closed. Synthetic in-memory events that retain an own `cwd: undefined` property (which JSON cannot persist) are treated as malformed and fail closed.
- ordered `phases[]`; if a workflow reaches a terminal status without explicit `phase_end` events for every phase, projection closes still-running phase-event-only phases with the workflow's terminal status so completed runs do not appear to have live historical phases
- deduplicated `artifacts[]` for stable external targets (`path`/`url`), keeping the latest event for repeated artifact paths or URLs; inline/preview-only artifacts remain distinct to avoid collapsing large or truncated content
- `errors[]`
- `progress` by phase
- latest `activeIo` snapshot for the run and per phase
- bounded `phase.commandLedger` for direct commands and `phase.fanout.items[].commandLedger` for item-attributed commands; fanout commands are not duplicated into the parent ledger
- raw `events[]` for advanced details

The monitor renders each ledger command as one updating row and uses only observed execution evidence for outcomes. See [`../docs/command-ledger-ui.md`](../docs/command-ledger-ui.md) for exact states, keyboard controls, token labels, and retention/privacy limits.

## Demo and test workflows

Generate sample events without running a real workflow:

```bash
~/.pi/agent/extensions/thread-phase-visualizer/bin/demo-workflow.mjs --cwd "$PWD"
~/.pi/agent/extensions/thread-phase-visualizer/bin/demo-workflow.mjs --cwd "$PWD" --fail
```

The demo script is intentionally not exposed as a slash command. Larger workflow examples, such as codebase exploration, live in their own workflow extensions and emit into this same visualizer store.

## Pi usage

- Tool: `thread_phase_runs` for agent/API inspection
- Command: select `/workflows` from the slash-command menu under the editor to open the interactive dashboard
- Shortcut: `ctrl+shift+t` opens the same dashboard directly
- In the monitor, arrows or `j`/`k` select rows, Enter/Right expands or opens them, Left/`b`/Esc goes back, and Ctrl+U/Ctrl+D pages. Press `x` on a running workflow to request cancellation. Cancellation is requested through `~/.pi/agent/thread-phase/cancel/<runId>.json`; workflow runners cooperatively abort their thread-phase `AbortSignal` and terminate child subprocesses. All controls are documented in [`../docs/command-ledger-ui.md`](../docs/command-ledger-ui.md).

## Footer status ownership and placement

The visualizer publishes active status only as the text-free workflow glyph string through `ctx.ui.setStatus("thread-phase", ...)` and clears `thread-phase` when idle. During shutdown it also clears the visualizer's legacy `thread-phase-cwd` key so an older status cannot remain visible. It does not provide or override a footer renderer. Stock Pi controls placement and normally displays extension statuses on a third footer status row.

RJLF's optional source patch changes that placement for **all** extension statuses, moving them onto the cwd/session row; Autonome does not install or apply the patch. RJLF's local/cloud chip is a separate `model-local-status` extension, independent of the patch, and uses `rjlf-model-class`. Both statuses can coexist, and neither extension should replace or clear the other's key.

For read-only `/rjlf-status` diagnostics, legacy standalone `model-class` migration, and the explicit `npm run patch:check`, `npm run patch:apply`, and `npm run patch:restore` commands, see RJLF's [footer diagnostics and workflow coexistence guide](https://github.com/Code4me2/rjlf-pi-extensions/blob/main/docs/footer-diagnostics.md).

## Optional read-only status bridge (v1)

The visualizer can publish a private, local, versioned JSON snapshot for separately configured observers. It is disabled by default, adds no agent tool or UI adapter, and does not alter workflow ownership, supervision, continuation, cancellation, or recovery.

Enable it before starting or reloading an interactive TUI or RPC session:

```bash
export PI_THREAD_PHASE_STATUS_BRIDGE=1
# Optional; must be absolute and should be on a private local filesystem:
export PI_THREAD_PHASE_STATUS_BRIDGE_DIR=/private/local/path
```

Without the override, the root is `${PI_THREAD_PHASE_STORE_DIR:-~/.pi/agent/thread-phase}/status-bridge`. Print and JSON worker invocations never publish. Disabling the option creates no bridge files or bridge timers.

Each Pi session maps to an opaque `scopeId`; each session host/reload uses its own random publisher directory:

```text
<root>/v1/scopes/<scopeId>/publishers/<publisherId>/
├── snapshot.json
└── lease.json
```

There is deliberately no `latest` pointer or session registry. A consumer must receive the raw Pi session ID (the shell tool exposes it as `PI_SESSION_ID`) or an opaque `scopeId` out of band, then inspect only that scope. Do not enumerate scopes to guess the active session. Multiple hosts for one chat never overwrite one another. Scope and workflow IDs are the canonical unpadded base64url encoding of 32 bytes (43 characters after the prefix); publisher IDs encode exactly 16 bytes (22 characters after the prefix).

The exact TypeScript shapes and reusable derivation/publisher/reader APIs are in [`lib/status-bridge.d.ts`](lib/status-bridge.d.ts). The snapshot exports only opaque identities, separate running/unknown/recent outcome counters, terminal timestamps, fixed policy/bounds, and publisher/source freshness. It never exports raw run IDs, names, paths, prompts, commands, errors, PIDs, hostnames, model/provider data, or a fabricated percentage/dominant status. Only a valid `workflow_end` establishes success, failure, or cancellation; phase errors and cancellation requests alone remain nonterminal. Historical terminal timestamps are evaluated as recorded and are not made recent by reload.

V1 bounds are fixed: at most 8,000 physical index records within an 8 MiB tail read, 512 KiB per serialized record (including LF, matching the writer limit), 256 projected runs, 64 published items, 256 publisher-directory entries, 16 KiB snapshots, and 2 KiB leases. Terminal results are recent for exactly 60 seconds. A successful bounded store observation is fresh for 30 seconds. Leases renew every 15 seconds and expire after 45 seconds; lease renewal does not change semantic snapshot `revision` or `changedAt`. Publisher freshness is availability, not workflow progress or evidence that a running workflow is not stalled.

Publisher-directory allocation uses exclusive filesystem creation and retries a bounded number of random-ID collisions; it never opens or overwrites a colliding directory. Sequential allocation fails closed when the 256-entry capacity is reached. There is no cross-process scope lock, so simultaneous allocators that both observe the last free slot can transiently exceed that bound; readers then fail closed rather than scanning an unbounded directory.

Each publisher removes only the exclusive directory it created, on clean replacement or shutdown. It never automatically deletes another publisher's directory: an expired timestamp makes a publisher unavailable to readers but does not prove that no live owner can renew it. A crash, interrupted initial write, or lease-less temporary-file residue can therefore consume capacity. Cleanup is deliberately offline/operator-owned: first stop every publisher for the configured session scope, then inspect and remove abandoned children of `<root>/v1/scopes/<scopeId>/publishers/`. If ownership cannot be established, leave the directory in place. This conservative policy avoids harmful deletion and accepts that repeated crashes can require manual cleanup.

A minimal polling consumer from this checkout is:

```js
import {
  createStatusBridgeReader,
  statusBridgeRootFromEnv,
} from "./thread-phase-visualizer/lib/status-bridge.mjs";

const root = statusBridgeRootFromEnv(process.env);
const reader = createStatusBridgeReader({ root, sessionId: process.env.PI_SESSION_ID });
setInterval(() => {
  const result = reader.read();
  // Clear any prior running/success/failure display whenever this is unknown.
  if (result.state === "unknown") return clearDisplay();
  renderCounts(result.snapshot.counts);
}, 5_000);
```

The reader validates schemas, exact canonical opaque-ID encodings, canonical `Date.prototype.toISOString()` UTC timestamps, freshness, revisions, regular no-follow files, size bounds, and publisher selection. A newer live publisher with unknown source wins; an expired newer publisher may yield to an older live one. `changedAt` is semantic and must not be used for freshness. Publication uses mode `0600` atomic same-directory replacement under mode `0700` directories. These local protections do not defend against a hostile process running as the same OS user, root, compromised storage or clock, or filesystems without normal same-directory atomic rename behavior.

The low-frequency lifecycle keeps the existing footer observation separate from bridge projection: the footer tolerates corrupt tail records and has a 150-result cwd fallback. The bridge uses `observeSessionRunSummaries(sessionId)`, validates and projects **the same contiguous suffix**, and selects up to 256 strictly session-owned runs. It does not use the tolerant `readIndex` recovery diagnostics as a source probe. General `readIndex`/`readRun` consumers and footer behavior are unchanged; the bridge still performs its own bounded synchronous observation. No bridge reads occur on animation ticks.

### Strict bounded-tail semantics

- Read at most the final 8 MiB of the regular index file in one bounded slab; never scan backward through arbitrarily large records or read the whole growing history. Walk backward through at most 8,000 physical records (empty lines also consume this bound), then project their events in timestamp order with existing event deduplication. Limits apply before session filtering.
- The chosen observation is a record-aligned suffix ending at the captured EOF. If the byte read excludes an older prefix, its first fragment is outside the observation: the fragment's terminating LF establishes the oldest trusted boundary. Even if the slab happens to begin on a record boundary, that first record is conservatively excluded because its preceding LF was not read. A fragment already exceeding 512 KiB fails closed. No older/smaller record is recovered across a cutoff, and no malformed/oversized interior record is skipped to infer running, success, or idle. Ordinary cumulative history exceeding 8 MiB is **not corruption**.
- Every included nonempty record must be complete, valid UTF-8 JSON with a usable event envelope (schema, run ID, workflow, event type, canonical UTC timestamp) and at most 512 KiB including LF. A partial final line, malformed included record, or individually oversized included record makes the entire observation unknown, even when its owner cannot be determined. Corruption wholly outside the chosen suffix is not inspected. This is a bounded observation, not a claim about all historical workflows; a lifecycle event outside that scope is not evidence available to this observer.
- Immutable ownership is restored and verified using the existing bounded catalog/sidecar/run-prefix budgets. Only a verified `workflow_start` with the exact current session ID grants inclusion; cwd fallback and later owner metadata never do. Restoration adds ownership, not missing lifecycle history. Unresolved/foreign runs remain excluded as before, and genuine unknown-active/recent-issue precedence is unchanged.
- File-descriptor and current-path device, inode, size, nanosecond mtime and ctime must agree before/after the complete observation and ownership projection. Short reads, unreadable/missing sources, append, truncation, rotation or in-place modification during observation fail closed; a later stable refresh can recover. An existing empty source remains a valid empty observation. These metadata checks are not a transactional snapshot of every run file or protection against a hostile same-user filesystem writer.
- The returned local `window` metadata describes `[startByte, endByte)`, physical record count, fixed byte/record limits, and the byte/record cutoff reason. It is not published as paths or offsets in the text-free v1 bridge. The snapshot's `bounded-tail` observation describes this scope; it is not an all-history liveness guarantee. Native store changes require a full Pi process restart; `/reload` alone may retain cached native modules.

## Remaining visualizer work

- Add usage budgets/threshold warnings on top of projected usage summaries.
- Continue improving monitor ergonomics and projection-level diagnostics as new generic workflow event patterns emerge.

JSONL reads are bounded, workflow-start ownership is verified within explicit scan/byte budgets, and focused coverage exists for ownership/session scoping, continuation/restart behavior, cancellation files, large artifacts, and corrupt JSONL. These are maintained correctness properties rather than unfinished work.

The continuation runtime uses a TypeScript bridge plus content-versioned native imports of both its store and message helpers so `/reload` cannot pair new handlers with older cached APIs. The retired supervision runtime is no longer imported by the extension. Same-process reload coverage uses Pi's actual extension loader. Changes to native modules outside those explicit bridges may still require restarting Pi.

## Current UI components

The first UI layer is implemented as generic custom message renderers:

- `thread-phase-run`: collapsed one-line workflow status; expand with Pi's tool/message expansion key to show phases, errors, and summary artifact content.
- compact built-in-footer status: each genuinely live, session/cwd-scoped workflow gets one high-contrast animated half-circle glyph (`◐ ◓ ◑ ◒`) separated horizontally by spaces. Surviving workflow IDs keep their relative position when recency ordering changes; new workflows append and terminal or stale/dead-PID workflows disappear, with no count, names, header, row cap, or extra widget rows. The animation updates about every 120ms from cached identities/state without polling the store; the existing bounded liveness refresh handles state changes even when no new event arrives. The status clears completely when idle and the legacy below-editor workflow widget is cleared. Animation runs only in TUI mode; RPC and other non-TUI modes receive no spinner updates. Use `/workflows` for workflow names and details.
- live monitor overlay: session-scoped keyboard-driven progress view with animated live workflow glyphs; one stable updating row per projected command; active commands plus three recent retained commands by default; item-only fanout command groups; terminal args/output/error/history details; explicit preparing, ready/unobserved, executing, finished/unobserved, succeeded, failed, and interrupted words; narrow-width labels that do not depend on color; compact output-first token summaries; expanded uncached/cache-read/cache-write/output/cumulative-processed breakdowns; inference model names beside phase/fanout titles; cancellation (`x`); and markdown-rendered artifact content. Optional bounded assistant prose and thinking stay distinct from the command ledger.
- session continuations (unreleased hardening): fresh background dynamic workflows return success/failure through `continuationMode: "terminal"`; hosted background code-review/codebase-exploration launches opt into the same terminal mode via an explicit wrapper-propagated `--continuation terminal` flag (never from hooks, bare CLI, foreground or print/JSON contexts); other integrations retain success-only `autoContinue: true`. Cancellation and committed successors remain ineligible. Busy delivery waits for idle; ownership, actual terminal evidence, eligibility and claim identity are rechecked before submission.
  - New delivery IDs are deterministic for `(session, run)`. Persisted session-wide receipts, including other branches and legacy random-ID markers, suppress replay even after the bounded store receipt expires or is evicted. Completion cards are separately deduplicated by run and explicitly never trigger a turn, even while busy (they still enter session context). Unavailable history suppresses sending without dropping unsent work.
  - The v4 store distinguishes pending `unsent`, `submitted` and legacy `unknown` status. Submission intent is persisted before calling Pi; acceptance is reconciled at startup, assistant message start, idle settlement and before sending. Synchronous rejection restores the prior submission state (`unsent` only when it was proven unsent, so a rejected resend of an uncertain send stays uncertain) and retries up to three times with bounded backoff. Ambiguous acceptance is held, not blindly retried; other fresh results may proceed at idle. Prompt formatting precedes submission intent; failure preserves pending state and releases the claim without blocking other results.
  - Old results (default freshness window: 30 minutes) and uncertain sends remain visible in `/workflows`. Freshness is checked at delivery time, including after a long busy turn: observing a completion live does not preserve automatic-delivery permission beyond that window. Press `r` on a pending handoff to prepare `/workflow-handoff <runId>` in the editor; submit it explicitly to request delivery. Uncertain sends require confirmation. This never authorizes a workflow restart or recovery launch. Failure prompts report blockers and partial results without inviting autonomous recovery.
  - Dashboard handoff annotations use the passive status refresh cadence (default 5 seconds), not per-frame store reads. Unreadable continuation state or a pending run hides only the affected annotations. This display cache never grants delivery authority.
  - Claims retain PID/process-start identity, runtime identity and a bounded lease. Shutdown relinquishes claims without deleting pending work. Pending records never expire or get capacity-pruned; the 500-pending-record bound rejects excess claims explicitly. Only permanently ineligible work is discarded, with exact identity checks.
  - v2/v3 state migrates to v4; legacy pending records become uncertain rather than presumed unsent. Delivered store receipts retain the 500-record/24-hour bounds, backed by session history. Older hosts reject v4 state: fully restart when upgrading, do not mix host versions, and back up before any deliberate downgrade. Pi input submission is not transactional with this store, so exactly-once transport is not promised.
- passive progress: since v0.18.2, no elapsed-time, heartbeat or activity update submits a main-agent review. Status, dashboard, event logs and explicit `thread_phase_runs` inspection remain available. The host no longer imports the periodic scheduler or reads/writes `progress-reviews.json`; existing scheduled, pending and claimed reviews remain untouched and inert across restarts. Legacy cadence fields, environment defaults and v3 metadata cannot reactivate them. Terminal handoffs remain separate from passive progress. Fully restart Pi after upgrading; already-submitted messages cannot be retracted and older running hosts retain their old policy. See [Workflow supervision](../docs/workflow-supervision.md).
- `thread_phase_runs` is session-scoped by default; session-owned history stays private to its owner, while unscoped running/direct-CLI runs are visible only from a canonically matching active or explicitly requested cwd.

Component files:

```text
components/
├── artifact-view.ts
├── monitor.ts
├── phase-timeline.ts
├── run-message-renderer.ts
└── status-widget.ts
```

The renderer intentionally stays workflow-agnostic and consumes projected summaries from `lib/store.mjs`.
