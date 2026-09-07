import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { showThreadPhaseMonitor } from "./components/monitor.ts";
import { registerThreadPhaseMessageRenderers } from "./components/run-message-renderer.ts";
import { createWorkflowFooterAnimator, isLiveRun } from "./components/status-widget.ts";
import {
	EVENT_TYPES,
	INDEX_FILE,
	STATUSES,
	ensureStore,
	formatUsageSummary,
	getRunSummary,
	latestRunSummaries,
	readIndex,
	readRun,
} from "./lib/store.mjs";
import { belongsToSession, formatOwnerMetadata, formatStaleIndicator, runSessionId } from "./lib/run-display.mjs";
import { canonicalCwd, canInspectRun, createCwdState, matchesRunCwd, mergeMonitorRuns as mergeScopedMonitorRuns, trackCwdCommand } from "./lib/session-scope.mjs";
import {
	continuationClaimIsOwned,
	continuationEligibility,
	createContinuationClaimantId,
	currentProcessStartIdentity,
	discardPendingContinuation,
	loadPendingContinuationRecords,
	markContinuationDelivered,
	persistContinuationClaim,
	relinquishContinuationClaim,
	relinquishContinuationClaims,
	shouldAutoContinue,
} from "./lib/continuation-runtime.ts";
import { formatMarkedContinuation, sessionHistoryHasContinuation } from "./lib/continuation-message.mjs";

const MAX_MESSAGE_BYTES = 20_000;
const requestedStatusRefreshMs = Number(process.env.PI_THREAD_PHASE_STATUS_REFRESH_MS || 5_000);
const STATUS_REFRESH_MS = Number.isFinite(requestedStatusRefreshMs) && requestedStatusRefreshMs >= 10
	? Math.floor(requestedStatusRefreshMs)
	: 5_000;

// Continuations for workflow runs that ended longer ago than this window are not
// auto-injected on a fresh session continue. Delivered continuation records are
// age-pruned from the store (24h retention), so without this gate a session resume
// would re-claim and re-inject every old completed workflow — re-triggering an
// agent turn over stale results (“often an old workflow”). Genuinely undelivered
// work is still retried via durable pending records, which never expire by age.
const STARTUP_CONTINUATION_FRESH_MS = (() => {
	const v = Number(process.env.PI_THREAD_PHASE_STARTUP_FRESH_MS);
	return Number.isFinite(v) && v >= 0 ? v : 30 * 60 * 1000;
})();

// A continuation LLM turn injected synchronously from a session_start handler runs
// before pi has bound the interactive editor to the session's streaming context, so
// `escape` (app.interrupt) and chat-tree navigation cannot abort it. Defer startup
// injections a short beat so pi binds the injected turn to interrupt context first.
const STARTUP_DELIVERY_SETTLE_MS = (() => {
	const v = Number(process.env.PI_THREAD_PHASE_STARTUP_DELIVERY_MS);
	return Number.isFinite(v) && v >= 0 ? v : 350;
})();

type AnyEvent = Record<string, any>;

function truncate(text: string, max = MAX_MESSAGE_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= max) return text;
	let out = text.slice(0, max);
	while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, -1);
	return `${out}\n\n[thread-phase visualizer output truncated]`;
}

function eventKey(event: AnyEvent): string {
	return event.eventId || `${event.runId}:${event.type}:${event.timestamp}:${event.phase || ""}`;
}

/** True when a workflow_end is recent enough to auto-inject on a session continue. */
function endedFreshly(timestamp: string | undefined, nowMs: number, windowMs: number): boolean {
	const t = Date.parse(String(timestamp || ""));
	if (!Number.isFinite(t)) return true; // unknown end time → don't drop it
	return nowMs - t <= windowMs;
}

function statusIcon(status: string | undefined): string {
	if (status === STATUSES.FAILED) return "✗";
	if (status === STATUSES.CANCELLED) return "⊘";
	if (status === STATUSES.RUNNING) return "…";
	if (status === STATUSES.SKIPPED) return "↷";
	return "✓";
}

function compactPhaseSummary(run: AnyEvent): string {
	const phases = run.phases || [];
	if (!phases.length) return "";
	const running = phases.filter((phase: AnyEvent) => phase.normalizedStatus === STATUSES.RUNNING).sort((a: AnyEvent, b: AnyEvent) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
	const failed = phases.filter((phase: AnyEvent) => phase.normalizedStatus === STATUSES.FAILED);
	const interesting = running.length ? running.slice(0, 3) : failed.length ? failed.slice(0, 3) : phases.slice(-8);
	const counts = `${phases.length} phase${phases.length === 1 ? "" : "s"}`;
	const names = interesting.map((phase: AnyEvent) => `${statusIcon(phase.normalizedStatus)} ${phase.phase}`).join(", ");
	const omitted = phases.length > interesting.length ? ` (+${phases.length - interesting.length} older)` : "";
	return `${counts}: ${names}${omitted}`;
}

function compactArtifactSummary(run: AnyEvent): string[] {
	const artifacts = (run.artifacts || []).map((a: AnyEvent) => a.path || a.title).filter(Boolean);
	const visible = artifacts.slice(-8);
	return artifacts.length > visible.length ? [...visible, `+${artifacts.length - visible.length} older artifact(s)`] : visible;
}

export function formatRunSummary(run: AnyEvent): string {
	const phases = compactPhaseSummary(run);
	const artifacts = compactArtifactSummary(run);
	return [
		`- ${statusIcon(run.normalizedStatus)} ${run.workflow} (${run.runId})${run.stale ? ` ${formatStaleIndicator(run)}` : ""}`,
		`  updated: ${run.updatedAt}`,
		formatOwnerMetadata(run) ? `  ${formatOwnerMetadata(run)}` : undefined,
		run.usage?.entries ? `  usage: ${formatUsageSummary(run.usage)}` : undefined,
		phases ? `  phases: ${phases}` : undefined,
		artifacts.length ? `  artifacts: ${artifacts.join(", ")}` : undefined,
		`  ${run.lastMessage || ""}`,
	].filter(Boolean).join("\n");
}

function readoutPhaseLines(run: AnyEvent): string[] {
	const nested = new Set<string>();
	const lines: string[] = [];
	for (const phase of run.phases || []) {
		const icon = statusIcon(phase.normalizedStatus);
		const usage = phase.usage?.entries ? ` · ${formatUsageSummary(phase.usage)}` : "";
		const msg = phase.lastMessage ? ` — ${phase.lastMessage}` : "";
		lines.push(`- ${icon} ${phase.phase}${usage}${msg}`);
		if (phase.fanout?.items?.length) {
			for (const stage of phase.fanout.items) {
				const sicon = statusIcon(stage.normalizedStatus);
				lines.push(`  - ${sicon} ${stage.label || stage.itemId}`);
				for (const a of stage.artifacts || []) {
					nested.add(artifactKey(a));
					lines.push(`    · ${a.title || a.kind}: ${artifactTargetText(a)}`);
				}
			}
		} else {
			for (const a of phase.artifacts || []) {
				nested.add(artifactKey(a));
				lines.push(`  · ${a.title || a.kind}: ${artifactTargetText(a)}`);
			}
		}
	}
	// Any artifacts not attached to a phase/stage still render, but with no separate
	// flat "Artifacts" section duplication.
	for (const a of run.artifacts || []) {
		if (!a || nested.has(artifactKey(a))) continue;
		lines.push(`  · ${a.title || a.kind}: ${artifactTargetText(a)}`);
	}
	return lines;
}
function artifactKey(a: AnyEvent): string {
	return String(a?.eventId || a?.path || a?.title || "");
}
function artifactTargetText(a: AnyEvent): string {
	return a?.path || a?.url || "";
}

function formatRunDetail(run: AnyEvent): string {
	const phases = (run.phases || []).length ? readoutPhaseLines(run) : [];
	return truncate([
		`${statusIcon(run.normalizedStatus)} Thread-phase workflow ${run.status}: ${run.workflow}${run.stale ? ` ${formatStaleIndicator(run)}` : ""}`,
		`Run: ${run.runId}`,
		formatOwnerMetadata(run) || undefined,
		run.usage?.entries ? `Usage: ${formatUsageSummary(run.usage)}` : undefined,
		phases.length ? `\nPhases:\n${phases.join("\n")}` : undefined,
		run.errors?.length ? `\nErrors:\n${run.errors.map((e: AnyEvent) => `- ${e.phase ? `${e.phase}: ` : ""}${e.message || e.error?.message || "error"}`).join("\n")}` : undefined,
		run.lastMessage ? `\n${run.lastMessage}` : undefined,
	].filter(Boolean).join("\n"));
}

function formatCompletion(event: AnyEvent): string {
	const run = getRunSummary(event.runId);
	// Intentionally compact for now. The later TUI/message renderer can use details.events
	// plus artifacts to show a one-line collapsed view and Ctrl+O expanded report.
	return formatRunDetail(run);
}

export function formatContinuationPrompt(run: AnyEvent): string {
	const artifacts = (run.artifacts || [])
		.map((artifact: AnyEvent) => `- ${artifact.title || artifact.kind}: ${artifact.path || artifact.preview || (artifact.content ? "(inline)" : "")}`)
		.join("\n");
	const phases = (run.phases || [])
		.map((phase: AnyEvent) => `- ${statusIcon(phase.normalizedStatus)} ${phase.phase}${phase.lastMessage ? ` — ${phase.lastMessage}` : ""}`)
		.join("\n");
	const failed = run.normalizedStatus === STATUSES.FAILED;
	return [
		failed ? `A thread-phase workflow failed in this Pi session.` : `A thread-phase workflow completed in this Pi session.`,
		``,
		`Workflow: ${run.workflow || "workflow"}`,
		`Status: ${run.status || run.normalizedStatus || "unknown"}`,
		`Run: ${run.runId || "unknown"}`,
		run.cwd ? `CWD: ${run.cwd}` : undefined,
		phases ? `\nPhases:\n${phases}` : undefined,
		run.usage?.entries ? `\nUsage: ${formatUsageSummary(run.usage)}` : undefined,
		artifacts ? `\nArtifacts:\n${artifacts}` : undefined,
		run.errors?.length ? `\nErrors:\n${run.errors.map((e: AnyEvent) => `- ${e.phase ? `${e.phase}: ` : ""}${e.message || e.error?.message || "error"}`).join("\n")}` : undefined,
		``,
		failed
			? `The workflow failed. Inspect the failed phases, errors, checkpoints, and partial artifacts. Decide whether to resume the structured run, launch a recovery workflow, or report the blocker. Do not proceed as though the workflow succeeded.`
			: `Please inspect the workflow result/artifacts as needed, summarize the outcome, and continue with the user's task.`,
	].filter(Boolean).join("\n").slice(0, 12000);
}

function mergeMonitorRuns(cwd: string, sessionId?: string): AnyEvent[] {
	const runs = latestRunSummaries({
		limit: 150,
		readLimit: 8000,
		ownershipFilter: (run: AnyEvent) => canInspectRun(run, sessionId, cwd, STATUSES.RUNNING),
	});
	return mergeScopedMonitorRuns(runs, cwd, sessionId, STATUSES.RUNNING);
}

export default function threadPhaseVisualizer(pi: ExtensionAPI) {
	registerThreadPhaseMessageRenderers(pi);

	let watcher: fs.FSWatcher | undefined;
	let statusRefreshTimer: NodeJS.Timeout | undefined;
	let statusFooter: ReturnType<typeof createWorkflowFooterAnimator> | undefined;
	const startupDeliveryTimers = new Set<ReturnType<typeof setTimeout>>();
	let retryDeferredContinuations: (() => void) | undefined;
	let acknowledgeContinuation: ((runId: string, deliveryId: string) => void) | undefined;
	let sessionTerminated = false;
	let cwdState = createCwdState(process.cwd());
	const seen = new Set<string>();
	const continuationClaimantId = createContinuationClaimantId();
	const continuationClaimantProcessStart = currentProcessStartIdentity();

	pi.registerTool({
		name: "thread_phase_runs",
		label: "Thread Phase Runs",
		description: "List recent generic thread-phase workflow runs or show projected details/events for a runId.",
		promptSnippet: "Inspect recent thread-phase workflow runs and artifacts",
		parameters: Type.Object({
			runId: Type.Optional(Type.String({ description: "Specific run id to inspect." })),
			workflow: Type.Optional(Type.String({ description: "Filter runs by workflow name." })),
			cwd: Type.Optional(Type.String({ description: "Filter runs by repository/directory." })),
			limit: Type.Optional(Type.Number({ description: "Max runs/events to return.", default: 20 })),
			rawEvents: Type.Optional(Type.Boolean({ description: "Return raw events instead of the projected run summary." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureStore();
			const sessionId = ctx.sessionManager.getSessionId();
			const cwd = params.cwd ? canonicalCwd(params.cwd, ctx.cwd) : undefined;
			const fallbackCwd = cwd || canonicalCwd(ctx.cwd) || path.resolve(ctx.cwd);
			if (params.runId) {
				const summary = getRunSummary(params.runId);
				if (!canInspectRun(summary, sessionId, fallbackCwd)) {
					return { content: [{ type: "text", text: "No thread-phase run found for this session." }], details: { summary: undefined, events: [] } };
				}
				const events = readRun(params.runId, { limit: params.limit || 80, readLimit: params.limit || 80 });
				return {
					content: [{ type: "text", text: truncate(params.rawEvents ? JSON.stringify(events, null, 2) : formatRunDetail(summary)) }],
					details: { summary, events, ...(runSessionId(summary) ? { sessionId: runSessionId(summary) } : {}) },
				};
			}
			const max = Math.max(1, Math.min(Number(params.limit || 20), 100));
			const recentRuns = latestRunSummaries({
				limit: max,
				workflow: params.workflow,
				readLimit: 8000,
				ownershipFilter: (run: AnyEvent) => canInspectRun(run, sessionId, cwd || fallbackCwd, STATUSES.RUNNING)
					&& (!cwd || matchesRunCwd(run, cwd)),
			});
			const runs = cwd
				? recentRuns
				: mergeScopedMonitorRuns(recentRuns, fallbackCwd, sessionId, STATUSES.RUNNING);
			return {
				content: [{ type: "text", text: runs.length ? runs.map(formatRunSummary).join("\n\n") : "No thread-phase runs found for this session." }],
				details: { runs },
			};
		},
	});

	const openWorkflowDashboard = async (ctx: ExtensionContext) => {
		ensureStore();
		await showThreadPhaseMonitor(ctx, cwdState.activeCwd || canonicalCwd(ctx.cwd) || path.resolve(ctx.cwd));
	};

	pi.registerCommand?.("workflows", {
		description: "Open the interactive thread-phase workflow dashboard",
		handler: async (_args, ctx) => openWorkflowDashboard(ctx),
	});

	pi.registerShortcut("ctrl+shift+t", {
		description: "Open the interactive thread-phase workflow dashboard",
		handler: openWorkflowDashboard,
	});

	pi.on("user_bash", (event, ctx) => {
		cwdState = trackCwdCommand(cwdState, event.command, event.cwd || ctx.cwd);
	});

	pi.on("message_start", (event, ctx) => {
		// Pi persists a finalized user entry after its message_end handlers. A
		// subsequent assistant start is therefore the first lifecycle point where
		// active-branch history can safely prove durable acceptance.
		if (event.message?.role !== "assistant") return;
		const storeDir = path.dirname(INDEX_FILE);
		try {
			const branchEntries = ctx.sessionManager.getBranch();
			for (const pending of loadPendingContinuationRecords({ storeDir })) {
				if (!sessionHistoryHasContinuation(branchEntries, pending.deliveryId)) continue;
				const delivered = markContinuationDelivered(pending.runId, { storeDir, deliveryId: pending.deliveryId });
				if (delivered.delivered) acknowledgeContinuation?.(pending.runId, pending.deliveryId);
			}
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`A thread-phase continuation is present in active-branch history, but delivered-state persistence failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.isIdle()) retryDeferredContinuations?.();
	});

	pi.on("session_start", async (_event, ctx) => {
		statusFooter?.dispose();
		statusFooter = undefined;
		if (statusRefreshTimer) clearInterval(statusRefreshTimer);
		statusRefreshTimer = undefined;
		sessionTerminated = false;
		for (const timer of startupDeliveryTimers) clearTimeout(timer);
		startupDeliveryTimers.clear();
		retryDeferredContinuations = undefined;
		acknowledgeContinuation = undefined;
		ensureStore();
		cwdState = createCwdState(ctx.cwd);
		// RPC also has UI support; animation belongs only in the terminal footer.
		const sessionFooter = ctx.hasUI && ctx.mode === "tui"
			? createWorkflowFooterAnimator({
				setStatus: (text) => ctx.ui.setStatus("thread-phase", text),
				clearWidget: () => ctx.ui.setWidget("thread-phase", undefined),
			})
			: undefined;
		statusFooter = sessionFooter;
		const updateStatus = () => {
			// A cleared/replaced lifecycle must never read for or update its stale ctx.
			if (!sessionFooter || statusFooter !== sessionFooter) return;
			try {
				const runs = mergeMonitorRuns(cwdState.activeCwd, currentSessionId);
				sessionFooter.setWorkflowIds(runs.filter(isLiveRun).map((run) => String(run.runId || "")).filter(Boolean));
			} catch {
				// Store/projection failures hide background status rather than leaving stale UI.
				sessionFooter.setWorkflowIds([]);
			}
		};
		const currentSessionId = ctx.sessionManager.getSessionId();
		const continuationStoreDir = path.dirname(INDEX_FILE);
		let pendingContinuationRecords = loadPendingContinuationRecords({ storeDir: continuationStoreDir });

		// Only the active branch proves that a continuation is visible to the
		// user. Markers on abandoned session-tree branches must not suppress replay.
		// If branch history is unavailable or no marker is present, replay remains
		// deliberately at-least-once rather than claiming exactly-once.
		let branchEntries: readonly AnyEvent[] | undefined;
		try {
			branchEntries = ctx.sessionManager.getBranch();
		} catch {
			branchEntries = undefined;
		}
		const historyProvenRunIds = new Set<string>();
		if (branchEntries) {
			for (const pending of pendingContinuationRecords) {
				if (!sessionHistoryHasContinuation(branchEntries, pending.deliveryId)) continue;
				historyProvenRunIds.add(pending.runId);
				try {
					const reconciled = markContinuationDelivered(pending.runId, { storeDir: continuationStoreDir, deliveryId: pending.deliveryId });
					if (!reconciled.delivered) throw new Error("pending continuation record changed before reconciliation");
				} catch (error) {
					if (ctx.hasUI) ctx.ui.notify(`Thread-phase continuation ${pending.deliveryId} is already enqueued, but delivered-state persistence failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
			}
			pendingContinuationRecords = loadPendingContinuationRecords({ storeDir: continuationStoreDir });
		}

		type QueuedContinuation = { retryPending: boolean; notBefore: number };
		const queuedContinuations = new Map<string, QueuedContinuation>();
		// Retry budgets and deadlines outlive queue membership: duplicate terminal
		// events and transient eligibility changes must not reset either one.
		const submissionRetries = new Map<string, { failures: number; notBefore: number }>();
		const retryExhausted = (runId: string) => (submissionRetries.get(runId)?.failures || 0) >= 3;
		let inFlightContinuation: { runId: string; deliveryId: string } | undefined;
		let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
		let deliveryTimerAt = Number.POSITIVE_INFINITY;

		const clearDeliveryTimer = () => {
			if (!deliveryTimer) return;
			clearTimeout(deliveryTimer);
			startupDeliveryTimers.delete(deliveryTimer);
			deliveryTimer = undefined;
			deliveryTimerAt = Number.POSITIVE_INFINITY;
		};

		const releaseSpecificClaim = (runId: string, deliveryId: string) => {
			try {
				relinquishContinuationClaim(runId, {
					storeDir: continuationStoreDir,
					deliveryId,
					claimantId: continuationClaimantId,
					claimantProcessStart: continuationClaimantProcessStart,
				});
			} catch { /* best-effort; the durable lease still bounds ownership */ }
		};

		const discardIneligibleContinuation = (summary: AnyEvent, runId: string) => {
			if (inFlightContinuation?.runId === runId || !belongsToSession(summary, currentSessionId, cwdState.activeCwd)
				|| ![STATUSES.SUCCESS, STATUSES.FAILED, STATUSES.CANCELLED].includes(summary?.normalizedStatus)
				|| continuationEligibility(summary) !== "ineligible") return;
			queuedContinuations.delete(runId);
			try {
				const record = loadPendingContinuationRecords({ storeDir: continuationStoreDir }).find((pending) => pending.runId === runId);
				if (!record) return;
				discardPendingContinuation(runId, {
					storeDir: continuationStoreDir,
					deliveryId: record.deliveryId,
					claimantId: continuationClaimantId,
					claimantProcessStart: continuationClaimantProcessStart,
				});
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Could not discard ineligible thread-phase continuation: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		};

		let pumpContinuations: () => void;
		const scheduleContinuationPump = (delayMs = 0) => {
			if (sessionTerminated || inFlightContinuation) return;
			if (delayMs <= 0) {
				clearDeliveryTimer();
				pumpContinuations();
				return;
			}
			const target = Date.now() + delayMs;
			if (deliveryTimer && deliveryTimerAt <= target) return;
			clearDeliveryTimer();
			deliveryTimerAt = target;
			deliveryTimer = setTimeout(() => {
				const fired = deliveryTimer;
				deliveryTimer = undefined;
				deliveryTimerAt = Number.POSITIVE_INFINITY;
				if (fired) startupDeliveryTimers.delete(fired);
				pumpContinuations();
			}, Math.max(0, target - Date.now()));
			deliveryTimer.unref?.();
			startupDeliveryTimers.add(deliveryTimer);
		};

		pumpContinuations = () => {
			if (sessionTerminated || inFlightContinuation || !ctx.isIdle()) return;
			while (queuedContinuations.size > 0) {
				const [runId, queued] = queuedContinuations.entries().next().value as [string, QueuedContinuation];
				if (retryExhausted(runId)) {
					queuedContinuations.delete(runId);
					continue;
				}
				const waitMs = queued.notBefore - Date.now();
				if (waitMs > 0) {
					scheduleContinuationPump(waitMs);
					return;
				}

				let summary: AnyEvent;
				try {
					summary = getRunSummary(runId);
				} catch (error) {
					queuedContinuations.delete(runId);
					if (ctx.hasUI) ctx.ui.notify(`Could not revalidate thread-phase continuation ${runId}: ${error instanceof Error ? error.message : String(error)}`, "warning");
					continue;
				}
				if (!belongsToSession(summary, currentSessionId, cwdState.activeCwd) || !shouldAutoContinue(summary)) {
					discardIneligibleContinuation(summary, runId);
					queuedContinuations.delete(runId);
					continue;
				}

				let claim;
				try {
					claim = persistContinuationClaim(runId, {
						storeDir: continuationStoreDir,
						retryPending: queued.retryPending,
						claimantId: continuationClaimantId,
						claimantProcessStart: continuationClaimantProcessStart,
					});
				} catch (error) {
					queuedContinuations.delete(runId);
					if (ctx.hasUI) ctx.ui.notify(`Could not persist thread-phase continuation claim: ${error instanceof Error ? error.message : String(error)}`, "warning");
					continue;
				}
				if (!claim.claimed || !claim.deliveryId) {
					queuedContinuations.delete(runId);
					continue;
				}
				queued.retryPending = true;

				// The startup delay and an idle transition both leave time for cancellation,
				// session scope, successor commitment, or durable ownership to change. Read
				// all of them again immediately before injecting the user message.
				try {
					summary = getRunSummary(runId);
				} catch {
					releaseSpecificClaim(runId, claim.deliveryId);
					queuedContinuations.delete(runId);
					continue;
				}
				if (!belongsToSession(summary, currentSessionId, cwdState.activeCwd) || !shouldAutoContinue(summary)) {
					releaseSpecificClaim(runId, claim.deliveryId);
					discardIneligibleContinuation(summary, runId);
					queuedContinuations.delete(runId);
					continue;
				}
				if (!ctx.isIdle()) {
					releaseSpecificClaim(runId, claim.deliveryId);
					if (ctx.hasUI) ctx.ui.notify("Thread-phase continuation deferred (agent busy); it will retry when idle.", "info");
					return;
				}
				try {
					if (!continuationClaimIsOwned(runId, {
						storeDir: continuationStoreDir,
						deliveryId: claim.deliveryId,
						claimantId: continuationClaimantId,
						claimantProcessStart: continuationClaimantProcessStart,
					})) {
						queuedContinuations.delete(runId);
						continue;
					}
				} catch (error) {
					releaseSpecificClaim(runId, claim.deliveryId);
					if (ctx.hasUI) ctx.ui.notify(`Could not verify thread-phase continuation ownership: ${error instanceof Error ? error.message : String(error)}`, "warning");
					return;
				}

				queuedContinuations.delete(runId);
				inFlightContinuation = { runId, deliveryId: claim.deliveryId };
				const prompt = formatMarkedContinuation(formatContinuationPrompt(summary), claim.deliveryId);
				try {
					pi.sendUserMessage(prompt);
				} catch (error) {
					// A synchronous rejection did not enqueue a message. Retry at most three
					// submissions per extension runtime with bounded backoff, without retaining an
					// in-flight lock that would permanently block all later continuations.
					inFlightContinuation = undefined;
					releaseSpecificClaim(runId, claim.deliveryId);
					const failures = (submissionRetries.get(runId)?.failures || 0) + 1;
					const notBefore = Date.now() + 100 * (2 ** (failures - 1));
					submissionRetries.set(runId, { failures, notBefore });
					if (failures < 3) {
						queued.notBefore = notBefore;
						queuedContinuations.set(runId, queued);
						scheduleContinuationPump(queued.notBefore - Date.now());
					} else {
						// The durable record stays pending for restart/operator recovery.
						scheduleContinuationPump();
					}
					if (ctx.hasUI) ctx.ui.notify(`Could not submit thread-phase continuation ${claim.deliveryId} (attempt ${failures}/3); it remains pending: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
				// One message remains in flight until active-branch history acknowledges it.
				// agent_settled schedules the next queued continuation once Pi is truly idle.
				return;
			}
		};

		acknowledgeContinuation = (runId, deliveryId) => {
			if (inFlightContinuation?.runId === runId && inFlightContinuation.deliveryId === deliveryId) {
				inFlightContinuation = undefined;
			}
		};
		retryDeferredContinuations = () => {
			// Reconsider durable records whose successor state was unreadable, or
			// whose earlier claimant was active. Never reset a submission retry budget.
			try {
				for (const pending of loadPendingContinuationRecords({ storeDir: continuationStoreDir })) {
					if (queuedContinuations.has(pending.runId) || retryExhausted(pending.runId)
						|| inFlightContinuation?.runId === pending.runId) continue;
					const summary = getRunSummary(pending.runId);
					if (belongsToSession(summary, currentSessionId, cwdState.activeCwd)
						&& [STATUSES.SUCCESS, STATUSES.FAILED].includes(summary?.normalizedStatus)
						&& continuationEligibility(summary) !== "ineligible") {
						attemptAutoContinuation(summary, pending.runId, true);
					} else discardIneligibleContinuation(summary, pending.runId);
				}
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Could not reload pending thread-phase continuations: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
			scheduleContinuationPump();
		};

		const attemptAutoContinuation = (_summary: AnyEvent, runId: string, retryPending = false, opts: { startup?: boolean } = {}) => {
			if (sessionTerminated || inFlightContinuation?.runId === runId || retryExhausted(runId)) return;
			const existing = queuedContinuations.get(runId);
			const notBefore = Math.max(
				opts.startup && ctx.hasUI ? Date.now() + STARTUP_DELIVERY_SETTLE_MS : Date.now(),
				submissionRetries.get(runId)?.notBefore || 0,
			);
			if (existing) {
				existing.retryPending ||= retryPending;
				existing.notBefore = Math.min(existing.notBefore, notBefore);
			} else {
				// Persist the backlog before waiting for idle/startup readiness. Otherwise
				// a reload after the freshness window could lose a deferred completion.
				// Only the one message being submitted should retain a delivery claim.
				let claim;
				try {
					claim = persistContinuationClaim(runId, {
						storeDir: continuationStoreDir,
						retryPending,
						claimantId: continuationClaimantId,
						claimantProcessStart: continuationClaimantProcessStart,
					});
				} catch (error) {
					if (ctx.hasUI) ctx.ui.notify(`Could not persist deferred thread-phase continuation: ${error instanceof Error ? error.message : String(error)}`, "warning");
					return;
				}
				if (!claim.claimed || !claim.deliveryId) return;
				releaseSpecificClaim(runId, claim.deliveryId);
				queuedContinuations.set(runId, { retryPending: true, notBefore });
			}
			scheduleContinuationPump(Math.max(0, notBefore - Date.now()));
		};

		// Prime completion rendering while reclaiming durable pending deliveries.
		// Legacy continuation ids migrate as delivered and are never replayed.
		const startupEvents = readIndex({ limit: 5000 });
		for (const event of startupEvents) seen.add(eventKey(event));
		const startupNowMs = Date.now();
		const startupRuns = new Set<string>(pendingContinuationRecords
			.filter((record: AnyEvent) => !historyProvenRunIds.has(record.runId))
			.map((record: AnyEvent) => record.runId));
		for (const event of startupEvents) {
			// Only pending (genuinely undelivered) work retries regardless of age; the
			// WORKFLOW_END fallback re-scan must be freshness-gated so a completed run
			// whose delivered marker expired is not re-injected on a later continue.
			if (event.type === EVENT_TYPES.WORKFLOW_END && event.runId
				&& !historyProvenRunIds.has(event.runId)
				&& endedFreshly(event.timestamp, startupNowMs, STARTUP_CONTINUATION_FRESH_MS)) {
				startupRuns.add(event.runId);
			}
		}
		for (const runId of startupRuns) {
			const summary = getRunSummary(runId);
			if (belongsToSession(summary, currentSessionId, cwdState.activeCwd)
				&& [STATUSES.SUCCESS, STATUSES.FAILED].includes(summary?.normalizedStatus)
				&& continuationEligibility(summary) !== "ineligible") attemptAutoContinuation(summary, runId, true, { startup: true });
			else discardIneligibleContinuation(summary, runId);
		}
		updateStatus();

		const processNewEvents = () => {
			const events = readIndex({ limit: 500 });
			for (const event of events) {
				const key = eventKey(event);
				if (seen.has(key)) continue;
				seen.add(key);
				if (event.type === EVENT_TYPES.WORKFLOW_END) {
					const summary = getRunSummary(event.runId);
					if (!belongsToSession(summary, currentSessionId, cwdState.activeCwd)) continue;
					pi.sendMessage({
						customType: "thread-phase-run",
						content: formatCompletion(event),
						display: true,
						details: { event, summary, events: readRun(event.runId, { readLimit: 50_000 }) },
					});
					if (event.runId && [STATUSES.SUCCESS, STATUSES.FAILED].includes(summary?.normalizedStatus)
						&& continuationEligibility(summary) !== "ineligible") attemptAutoContinuation(summary, event.runId);
					else if (event.runId) discardIneligibleContinuation(summary, event.runId);
					if (ctx.hasUI) ctx.ui.notify(`thread-phase ${event.workflow}: ${event.status || "done"}`, summary.normalizedStatus === STATUSES.FAILED ? "warning" : "info");
				}
			}
			updateStatus();
		};

		watcher?.close();
		watcher = fs.watch(INDEX_FILE, { persistent: false }, () => processNewEvents());
		// Index events refresh the cached footer identities immediately. This bounded
		// poll also removes runs that become stale solely because time passes or
		// their PID exits, neither of which necessarily appends another event.
		// The 120ms animation itself performs no store or liveness reads.
		statusRefreshTimer = setInterval(updateStatus, STATUS_REFRESH_MS);
		statusRefreshTimer.unref?.();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionTerminated = true;
		for (const timer of startupDeliveryTimers) clearTimeout(timer);
		startupDeliveryTimers.clear();
		retryDeferredContinuations = undefined;
		acknowledgeContinuation = undefined;
		watcher?.close();
		watcher = undefined;
		if (statusRefreshTimer) clearInterval(statusRefreshTimer);
		statusRefreshTimer = undefined;
		statusFooter?.dispose();
		statusFooter = undefined;
		try {
			relinquishContinuationClaims({
				storeDir: path.dirname(INDEX_FILE),
				claimantId: continuationClaimantId,
				claimantProcessStart: continuationClaimantProcessStart,
			});
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Could not relinquish pending thread-phase continuation claims during shutdown: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		if (ctx.hasUI) {
			try { ctx.ui.setStatus("thread-phase", undefined); } catch { /* best-effort UI cleanup */ }
			try { ctx.ui.setStatus("thread-phase-cwd", undefined); } catch { /* best-effort UI cleanup */ }
			try { ctx.ui.setWidget("thread-phase", undefined); } catch { /* best-effort UI cleanup */ }
		}
	});
}
