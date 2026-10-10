# Workflow supervision

Since v0.18.2, workflow progress is **passive**. Elapsed time, activity and heartbeats do not inject messages into the main conversation or trigger model turns. Background Pi agents still have no implicit wall-clock deadline; foreground Pi agents and shells retain their default bound.

## Progress and completion are separate

- The footer, optional status bridge/title, `/workflows` dashboard and event/artifact store remain available without main-agent inference or conversation growth from progress updates.
- `thread_phase_runs` remains available for explicit, on-demand inspection.
- Fresh successful/failed background workflows return control through a durable `continuationMode: "terminal"` handoff. Those completion messages intentionally enter the conversation and may trigger reasoning. Old or uncertain deliveries remain passive until explicitly requested. Hosted background code-review and codebase-exploration runs (TUI/RPC launches with a valid originating session) use this path through an explicit wrapper-propagated `--continuation terminal` opt-in; hooks, bare CLI runs, foreground calls and print/JSON workers stay notification-only.
- Cancellation does not auto-continue. An error event without `workflow_end` is not terminal proof.
- Ownership, session scoping, cancellation and successor suppression remain enforced. Delivery receipts are session-wide, including other branches; branch navigation must not repeat a notification.

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

## Terminal handoff delivery (v0.19.3)

A terminal handoff has a deterministic identity derived from the owning session and run. Before sending, the host checks persisted session history, including legacy random-ID markers with the original run identity. Receipt-store eviction or expiry is not permission to deliver again. Duplicate terminal envelopes produce one completion card per run. Cards explicitly do not trigger a model turn, including while Pi is busy; they still enter session context.

While Pi is busy, a completion stays durably unsent until its native `turn_end` boundary, after the entire tool batch. The host revalidates it there and returns a marked context entry with a continuation request. Pi combines this with a natural tool-loop continuation rather than starting a redundant post-answer turn. Nothing is placed in the steering queue while tools run. Idle handoffs remain marked user messages. Both forms use the same receipt/claim machinery; a rejected boundary commit leaves submitted state uncertain. Completions that arrive after an answer was generated can still require another request.

New pending records distinguish `unsent` from `submitted`; submission intent is persisted **before** calling Pi. Acceptance is reconciled at startup, assistant message start, idle settlement and before sending. A synchronous rejection restores the prior submission state — `unsent` for proven-unsent work, while a confirmed resend of an uncertain record keeps its uncertainty — and uses bounded retries. Missing acknowledgement is ambiguous, not an automatic retry instruction. Other fresh results can proceed when the main agent is idle. Prompt formatting happens before submission intent is recorded: a formatting failure preserves the prior pending state, releases the claim, and does not block other runs.

Unsent results older than the default 30-minute freshness window, submitted results without acceptance proof, and legacy pending records with unknown submission status remain durable and visible in `/workflows`. Opening the dashboard causes no inference. Select a held result and press `r` to prepare `/workflow-handoff <runId>` in the editor, then submit that command explicitly. Uncertain deliveries require confirmation because a resend could duplicate a message Pi already accepted. This requests a conversation handoff, **not** a workflow restart or recovery launch.

Freshness is checked at delivery time, not latched when completion is observed. A result observed live but still waiting more than 30 minutes after completion therefore requires an explicit handoff at the next turn boundary or when Pi becomes idle. The original completion timestamp remains authoritative; the legacy-named `PI_THREAD_PHASE_STARTUP_FRESH_MS` controls this window both during startup and later delivery. Workflow runtime is not result age: a fresh terminal result from a run started hours ago remains eligible.

Live completion discovery follows an index byte cursor rather than a sliding recent-event window. Filesystem notifications accelerate discovery; a passive poll at the status refresh cadence (5 seconds by default), independent of footer/bridge availability, also discovers missed events and rechecks durable pending work while idle. Each refresh reads at most 5,000 records / 8 MiB; larger bursts drain over subsequent refreshes without skipping their earlier terminals. Partial final records wait for completion. This is store reconciliation, not periodic model supervision. Startup still uses bounded recent history plus durable pending records; it does not promise discovery of never-observed terminals already outside that startup window. Fully restart hosts for this native store change.

Dashboard handoff annotations refresh at the passive status cadence (5 seconds by default), not on each animation frame. An unreadable continuation store or pending run hides the affected annotations without breaking the dashboard. This display-only cache cannot authorize delivery; the handoff path always revalidates current state.

Unreadable session history suppresses delivery without dropping unsent work. Known acceptance anywhere in the session suppresses replay, including an explicit handoff request. Cancellation, committed successors and foreign-session ownership still prohibit delivery. Failure prompts report blockers and partial results rather than suggesting autonomous recovery.

The authoritative store is now `thread-phase-continuations/v4`. v2/v3 records migrate on read; legacy pending records become `unknown`, never presumed unsent. Pending work does not expire. Delivered store receipts remain bounded (500 records, 24-hour retention); persisted session history supplies longer-lived evidence. Full restart is recommended when upgrading. Older hosts reject v4 state rather than safely operating alongside it: do not mix old/new hosts or downgrade without a backup and deliberate migration. The Pi submission API is not transactional with this store; no exactly-once transport guarantee is claimed.

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
