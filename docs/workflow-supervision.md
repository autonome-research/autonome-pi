# Workflow supervision

Since v0.18.2, workflow progress is **passive**. Elapsed time, activity and heartbeats do not inject messages into the main conversation or trigger model turns. Background Pi agents still have no implicit wall-clock deadline; foreground Pi agents and shells retain their default bound.

## Progress and completion are separate

- The footer, optional status bridge/title, `/workflows` dashboard and event/artifact store remain available without main-agent inference or conversation growth from progress updates.
- `thread_phase_runs` remains available for explicit, on-demand inspection.
- Successful/failed background workflows still return control through the existing durable `continuationMode: "terminal"` handoff. Those completion messages intentionally enter the conversation and may trigger reasoning.
- Cancellation does not auto-continue. An error event without `workflow_end` is not terminal proof.
- Ownership, session scoping, cancellation, continuation acknowledgement and successor suppression are unchanged.

There is no replacement polling agent, automatic intervention, or `pi-durable` integration in this fix.

## Upgrade and compatibility

**Fully restart every Pi host using the package after upgrading.** Already-running old hosts can still send reviews. This change cannot retract messages already submitted to Pi or remove historical messages from session context.

The visualizer no longer loads, creates, claims, acknowledges, reschedules or delivers periodic reviews. Existing `progress-reviews.json` files are left untouched and inert, including scheduled, pending and claimed records. Restart, idle transitions, historical review markers and v3 metadata cannot reactivate them. No deletion or migration is needed; downgrading to an older host can reactivate its old policy.

`progressReviewIntervalMs` is deprecated; omit it in new calls. For compatibility with existing callers, templates and trusted resume records, the existing launch validation and metadata transport remain:

- Dynamic/scripted launch values remain integers `60000..2147483647`; dynamic workflows also accept `null`.
- The field remains restricted to a new hosted background launch (TUI/RPC with an originating session ID), not foreground, unhosted, phase/helper or resume override input.
- A legitimate structured resume retains its verified source metadata; callers cannot add or override it.
- Immutable `supervisionMode: "main-agent"` and cadence metadata no longer authorize any periodic message.
- `PI_THREAD_PHASE_SUPERVISION_CHECK_MS` and v3's former fallback cadence have no host scheduling effect.

Internal legacy store utilities remain for compatibility and historical fixtures, but the extension no longer imports their runtime. These compatibility fields never alter execution deadlines or launch authorization.

## Subprocess deadline policy

Deadline selection is unchanged:

1. An explicit phase timeout or scripted helper timeout wins.
2. Otherwise an explicit workflow timeout applies.
3. Otherwise a background Pi subprocess has no wall-clock timeout timer.
4. Foreground Pi subprocesses and shell work use the default bound (10 minutes).

The no-deadline case applies to declarative `agent`, `fanout` and scripted `ctx.pi` work. Missing, malformed, zero, conflicting or oversized low-level timeout input never grants an unlimited run. Shell phases and `ctx.shell` remain bounded.

An explicit `timeoutMs` remains a hard limit (up to 2,147,483,647 ms for a dynamic workflow; `null` explicitly removes the deadline). Timeout and cancellation stay distinct in results. Both retain process-group SIGTERM and the bounded SIGKILL grace. Cooperative cancellation, readiness's five-second bound, process-journal launch ownership and resume descendant checks are unchanged.

Operators may set `PI_DYNAMIC_WORKFLOW_DEFAULT_TIMEOUT_MS` to change the bounded fallback. This is an internal deployment setting, not a workflow field or model-facing control.

## Inspecting and intervening

Use `thread_phase_runs` for summaries and bounded events, or `ctrl+shift+t` / `/workflows` for runs and artifacts. The monitor's cancellation action remains an intentional cooperative stop. Logs and heartbeats are evidence, not proof of progress or a stall; no timer kills, retries, resumes, launches successors or revises the workflow goal.
