# thread-phase-visualizer

Generic Pi-side event store and visualization extension for thread-phase workflows.

This is intentionally workflow-agnostic: workflows emit structured events and artifacts; the Pi extension watches those events and exposes them through generic tools/commands. Specific workflows should not implement their own TUI watchers.

## Store layout

Default store:

```text
~/.pi/agent/thread-phase/
├── index.jsonl          # global append-only event stream
├── run-starts.jsonl     # compact append-only ownership lookup catalog
├── continuations.json   # authoritative v3 pending/delivered + delivery/claim identity state
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

Projection helpers expose the latest snapshot as `run.activeIo` and `phase.activeIo`. The monitor panel renders that summary, and non-UI tools can read the same projected fields or raw `active_io` events from JSONL. Snapshots are persisted in append-only logs; the store applies conservative redaction for common token/secret forms and caps preview fields, but workflows should still keep previews compact and avoid including secrets. Set `PI_THREAD_PHASE_ACTIVE_IO=0` to disable active-I/O persistence. Mission active I/O defaults to metadata/status/byte counts only; process/model output previews are opt-in with `PI_THREAD_PHASE_ACTIVE_IO_PREVIEWS=1`, process command text with `PI_THREAD_PHASE_ACTIVE_IO_COMMANDS=1`, and Pi prompt previews with `PI_THREAD_PHASE_ACTIVE_IO_PROMPTS=1`.

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
- raw `events[]` for advanced details

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
- In the monitor, press `x` on a running workflow to request cancellation. Cancellation is requested through `~/.pi/agent/thread-phase/cancel/<runId>.json`; workflow runners cooperatively abort their thread-phase `AbortSignal` and terminate child subprocesses.

## Remaining visualizer work

- Add usage budgets/threshold warnings on top of projected usage summaries.
- Continue improving monitor ergonomics and projection-level diagnostics as new generic workflow event patterns emerge.

JSONL reads are bounded, workflow-start ownership is verified within explicit scan/byte budgets, and focused coverage exists for ownership/session scoping, continuation/restart behavior, cancellation files, large artifacts, and corrupt JSONL. These are maintained correctness properties rather than unfinished work.

## Current UI components

The first UI layer is implemented as generic custom message renderers:

- `thread-phase-run`: collapsed one-line workflow status; expand with Pi's tool/message expansion key to show phases, errors, and summary artifact content.
- below-editor status widget: shows only genuinely live workflows; terminal and stale/dead-PID runs are removed, including when liveness changes without a new store event. Its `/workflows open dashboard` hint points to the selectable slash-command entry under the editor.
- live monitor overlay: session-scoped keyboard-driven progress view with animated live workflow glyphs, compact recent/active phase summaries, arrow/enter navigation across phases and artifacts in one detail view, cancellation (`x` for running workflows), markdown-rendered artifact content, and separate phase glyphs (`◆`, `◈`, `◇`) for quick visual scanning.
- session continuations: successful background/session-launched workflows can emit a normal follow-up user message for the current Pi session; if the main agent is still generating, the continuation is queued with Pi's follow-up delivery instead of interrupting the stream. Workflows opt in through generic `autoContinue: true` metadata. Before submission, the visualizer durably records `pending` with a stable delivery ID and claimant identity. The queued user message includes a `thread-phase-continuation/v1` machine marker carrying that ID. Because `sendUserMessage()` is fire-and-forget and user `message_start` precedes persistence, the record remains pending until active-branch history proves acceptance. The visualizer checks at startup and at the subsequent assistant `message_start`, after Pi has persisted the finalized user entry; only then is `delivered` persisted.
  - On startup, pending records are reconciled against `ctx.sessionManager.getBranch()`. Only a marker visible on the active branch proves that Pi accepted the message; markers on abandoned branches do not suppress replay.
  - If current-session history is unavailable, truncated, branched away, or otherwise cannot prove enqueue, a pending record is replayed with **at-least-once** semantics. The extension does not claim exactly-once delivery.
  - Pending claims carry PID, process-start identity when the platform exposes it, a per-extension-runtime claimant ID, and a bounded claimant lease (default 30 minutes). A genuinely active claimant is not stolen during its lease. `session_shutdown` relinquishes that runtime's claims without deleting pending work; lease expiry guarantees eventual recovery after PID reuse on platforms without process-start identity.
  - Pending work is never silently expired or capacity-pruned. New claims are rejected once the independent pending-record bound (default 500) is reached, making backlog growth explicit instead of dropping work.
  - Notifications distinguish claim persistence failure, synchronous submission rejection, and acknowledgement persistence failure. Asynchronous input rejection produces no `message_start`, so the record remains pending and is relinquished on shutdown for retry. Delivered and safely migrated legacy records remain deduplicated while retained. The v3 state reader accepts v2 documents and legacy ID/timestamp mirrors, assigns deterministic delivery IDs during migration, and rewrites canonical v3 state. Legacy mirrors retain their old file shape; a downgrade that does not understand v3 conservatively sees mirrored IDs as already continued rather than replaying pending work.
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
