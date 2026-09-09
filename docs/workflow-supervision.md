# Workflow supervision

Background dynamic workflows can contain legitimate agent calls that run longer than a fixed wall-clock default. The initial supervision policy replaces that implicit kill deadline with durable, periodic requests for main-agent judgment. It does not add automatic stall detection or recovery.

## Opt-in and trust boundary

The public `dynamic_workflow` and `scripted_workflow` schemas are unchanged. On a **new hosted background** call, the extension passes a private runner flag and the runner records:

```text
supervisionMode: "main-agent"
```

This value is immutable `workflow_start` ownership metadata. It is not accepted from workflow input or caller metadata. Scheduling trusts it only after the compact start projection verifies against the authoritative start record, the run belongs to the current Pi session, and its absolute launch `cwd` agrees canonically with the system-recorded `cwdAtLaunch`. Missing, relative, malformed, or contradictory launch ownership fails closed.

The marker is separate from `continuationMode: "terminal"`:

- `supervisionMode` opts an active run into periodic progress review.
- `continuationMode` retains the existing successful/failed terminal handoff behavior.
- A progress review never masquerades as a workflow completion.

The deprecated alias, explicit v1 CLI runs, replayed historical argument shapes, and unhosted calls do not silently opt in. A background structured resume inherits the policy only from its verified source ownership marker. The checkpoint and caller cannot add, remove, or override it. A source without the marker retains the older bounded policy, and foreground resume is bounded even when its source was supervised.

## Subprocess deadline policy

Deadline selection is deterministic:

1. An explicit phase timeout or scripted helper timeout wins.
2. Otherwise an explicit workflow timeout applies.
3. Otherwise a supervised background Pi subprocess has no wall-clock timeout timer.
4. All other subprocesses use the existing default bound (10 minutes).

The no-deadline case applies only to Pi subprocesses created for declarative `agent`, `fanout`, and scripted `ctx.pi` work. It is an explicit internal low-level mode: missing, malformed, zero, conflicting, or oversized low-level timeout input never grants an unlimited run.

Shell phases and scripted `ctx.shell` calls always retain a bound. Foreground workflows also remain bounded because they occupy their own caller/supervisor. Use background mode for agent work that may legitimately remain open-ended.

`timeoutMs` remains a hard limit. Supervision never erases or extends it. Timeout and cancellation stay distinct in results. Both use process-group SIGTERM followed by the existing bounded SIGKILL grace when needed. Cooperative user cancellation, readiness's five-second bound, subprocess-journal launch ownership, and resume descendant checks are unchanged.

Operators may set `PI_DYNAMIC_WORKFLOW_DEFAULT_TIMEOUT_MS` to change the bounded fallback. This is an internal deployment setting, not a workflow field or model-facing control.

## Periodic progress reviews

The visualizer schedules reviews only for verified, active runs carrying the marker and owned by the current session. Verified session ownership takes priority across tool-specified working directories: a Pi session may supervise its own hosted background workflow launched with `cwd` outside the session's startup/current directory. This does not weaken provenance checks—the authoritative launch `cwd` and system `cwdAtLaunch` must still be present, absolute, and canonically consistent, and another session's run remains denied. The default cadence for newly scheduled runs is ten minutes from the trusted run start. `PI_THREAD_PHASE_SUPERVISION_CHECK_MS` can change the cadence for an operator deployment (minimum one minute; `1200000` selects twenty minutes). Existing durable schedules retain their cadence across reload/restart. An explicit internal operator reschedule can adjust an unsubmitted schedule atomically without replacing its check identity or changing execution limits; pending/in-flight reviews are left intact. There is no model-facing cadence control in this release.

Scheduling is durable. Restarting the host does not restart elapsed time: an overdue record becomes pending. Records use a dedicated progress-review schema and marker, remain bounded, coalesce due runs into bounded batches, and permit at most one pending check per run. Terminal completion or cancellation supersedes stale checks.

TUI and RPC sessions host delivery. Recursive print/JSON workers do not. If the main agent is busy or unavailable, background work continues and the review remains pending. Terminal continuations have submission priority, and both paths share one submission gate so independent message loops cannot race.

A review message is deliberately limited evidence. It says that this is a progress review, not completion, and that the timer did not detect a stall. It provides workflow/run identity, current phase and elapsed time, plus log/artifact pointers. It asks the main agent to inspect current logs and decide whether to wait, report, or intervene using existing tools.

## What the timer never does

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

There is no new intervention tool, workflow schema knob, per-run cadence command, footer row, or automatic retry/resume mechanism in this initial release.
