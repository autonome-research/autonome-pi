# Workflow supervision

Background Pi agents have no implicit wall-clock deadline; foreground Pi agents and shells retain their default bound. Hosted background runs request periodic main-agent judgment only when a review cadence is explicitly assigned. Reviews do not detect stalls or trigger recovery.

## Opt-in and trust boundary

The public `dynamic_workflow` and `scripted_workflow` schemas expose optional `progressReviewIntervalMs` (integer `60000..2147483647`; dynamic workflows also accept `null` to disable). Omission schedules no review. An assigned cadence is valid only for a new hosted supervised background launch: the host must be TUI or RPC with an originating session ID. On such a call, the extension passes private runner flags and the runner records:

```text
supervisionMode: "main-agent"
progressReviewIntervalMs: 3600000 // only when explicitly supplied
```

The public field is validated as a launch argument and transported through the trusted runner seam; the resulting value is immutable `workflow_start` ownership metadata. It is not read from the compiled workflow spec or arbitrary caller-authored metadata. Scheduling trusts it only after the compact start projection verifies against the authoritative start record, the run belongs to the current Pi session, and its absolute launch `cwd` agrees canonically with the system-recorded `cwdAtLaunch`. Missing, relative, malformed, or contradictory launch ownership fails closed.

The marker is separate from `continuationMode: "terminal"`:

- `supervisionMode` marks an active run eligible for a review; an explicit cadence schedules it.
- `continuationMode` retains the existing successful/failed terminal handoff behavior.
- A progress review never masquerades as a workflow completion.

The deprecated alias, explicit v1 CLI runs, and unhosted calls cannot assign hosted progress reviews. A background structured resume inherits only its verified source's assigned cadence; the caller cannot add or override it. A source without the cadence remains unscheduled. Foreground resume remains bounded even if its source was supervised. V3 delegation retains its separate operator/default cadence.

## Subprocess deadline policy

Deadline selection is deterministic:

1. An explicit phase timeout or scripted helper timeout wins.
2. Otherwise an explicit workflow timeout applies.
3. Otherwise any background Pi subprocess has no wall-clock timeout timer.
4. Foreground Pi subprocesses and shell work use the default bound (10 minutes).

The no-deadline case applies only to Pi subprocesses created for declarative `agent`, `fanout`, and scripted `ctx.pi` work. It is an explicit internal low-level mode: missing, malformed, zero, conflicting, or oversized low-level timeout input never grants an unlimited run.

Shell phases and scripted `ctx.shell` calls always retain a bound. Foreground workflows also remain bounded because they occupy their own caller/supervisor. Use background mode for agent work that may legitimately remain open-ended.

An explicit `timeoutMs` remains a hard limit (up to 2,147,483,647 ms for a dynamic workflow; `null` explicitly removes the deadline). Supervision never erases or extends an assigned limit. Timeout and cancellation stay distinct in results. Both use process-group SIGTERM followed by the existing bounded SIGKILL grace when needed. Cooperative user cancellation, readiness's five-second bound, subprocess-journal launch ownership, and resume descendant checks are unchanged.

Operators may set `PI_DYNAMIC_WORKFLOW_DEFAULT_TIMEOUT_MS` to change the bounded fallback. This is an internal deployment setting, not a workflow field or model-facing control.

## Periodic progress reviews

The visualizer schedules reviews only for verified, active runs carrying the marker and owned by the current session. Verified session ownership takes priority across tool-specified working directories: a Pi session may supervise its own hosted background workflow launched with `cwd` outside the session's startup/current directory. This does not weaken provenance checks—the authoritative launch `cwd` and system `cwdAtLaunch` must still be present, absolute, and canonically consistent, and another session's run remains denied. On reload/restart, an existing durable schedule retains its cadence and check identity. A new dynamic/scripted schedule requires an explicit valid `progressReviewIntervalMs`; omitted or `null` cadence produces no schedule. V3 delegation alone keeps the operator `PI_THREAD_PHASE_SUPERVISION_CHECK_MS`/ten-minute fallback. The existing trusted operator reschedule primitive can adjust an unsubmitted schedule without changing its identity or execution limits; it is not a public post-launch command. Malformed cadence never grants a new schedule.

Scheduling is durable. Restarting the host does not restart elapsed time: an overdue record becomes pending. Records use a dedicated progress-review schema and marker, remain bounded, coalesce due runs into bounded batches, and permit at most one pending check per run. Terminal completion or cancellation supersedes stale checks.

TUI and RPC sessions host delivery. Recursive print/JSON workers do not. If the main agent is busy or unavailable, background work continues and the review remains pending. Terminal continuations have submission priority, and both paths share one submission gate so independent message loops cannot race.

A review message is deliberately limited evidence. It says that this is a progress review, not completion, and that the timer did not detect a stall. It provides workflow/run identity, current phase and elapsed time, plus log/artifact pointers. It asks the main agent to inspect current logs and decide whether to wait, report, or intervene using existing tools.

## What the timer never does

When assigned, the root workflow run owns the review cadence. Recursive workers/nodes share the root policy and do not receive independent schedules; no public recursion opt-in is added. New `after` launches are independent policies and do not inherit cadence.

The periodic timer does **not**:

- classify a run as busy, inactive, progressing, or stuck;
- score progress from log volume, heartbeats, or tool-call argument completion;
- kill or cancel a workflow;
- retry a phase;
- resume a run;
- launch successor or replacement work;
- steer an active model turn; or
- change an explicit deadline.

Log activity and heartbeat timestamps are evidence for human/model review only. An error event without `workflow_end` is not terminal proof. A stale or dead runner owner may justify a diagnostic review, but never automatic recovery.

## Inspecting and intervening

The main agent can use existing surfaces:

- `thread_phase_runs` to inspect current summaries and bounded events;
- `ctrl+shift+t` or `/workflows` to inspect runs and artifacts;
- the existing monitor cancellation action for an intentional cooperative stop; and
- normal chat reporting to explain status or recommend waiting.

The typed launch-time `progressReviewIntervalMs` field is the only public workflow cadence control. There is no new intervention tool, public post-launch cadence mutation/helper, per-run reschedule command, footer row, or automatic retry/resume mechanism in this initial release.
