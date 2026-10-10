import * as fs from "node:fs";
import * as path from "node:path";
import type { CustomMessageEntryDraft, ExtensionAPI, ExtensionContext, TurnEndEventResult } from "@earendil-works/pi-coding-agent";
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
	normalizeStatus,
	observeSessionRunSummaries,
	readIndex,
	readIndexUpdates,
	readRun,
	runFileFor,
} from "./lib/store.mjs";
import { belongsToSession, formatOwnerMetadata, formatStaleIndicator, runSessionId } from "./lib/run-display.mjs";
import {
	createStatusBridgePublisher,
	statusBridgeConfiguration,
} from "./lib/status-bridge.mjs";
import { canonicalCwd, canInspectRun, createCwdState, matchesRunCwd, mergeMonitorRuns as mergeScopedMonitorRuns, trackCwdCommand } from "./lib/session-scope.mjs";
import {
	continuationClaimIsOwned,
	continuationEligibility,
	createContinuationClaimantId,
	currentProcessStartIdentity,
	discardPendingContinuation,
	loadPendingContinuationRecords,
	markContinuationDelivered,
	markContinuationSubmission,
	persistContinuationClaim,
	relinquishContinuationClaim,
	relinquishContinuationClaims,
	shouldAutoContinue,
	formatMarkedContinuation,
	sessionHistoryHasContinuation,
	sessionHistoryHasRunContinuation,
} from "./lib/continuation-runtime.ts";

const MAX_MESSAGE_BYTES = 20_000;
const requestedStatusRefreshMs = Number(process.env.PI_THREAD_PHASE_STATUS_REFRESH_MS || 5_000);
const STATUS_REFRESH_MS = Number.isFinite(requestedStatusRefreshMs) && requestedStatusRefreshMs >= 10
	? Math.floor(requestedStatusRefreshMs)
	: 5_000;

// Old results stay durably pending and visible, but require an explicit handoff.
// Receipt pruning is not delivery authority: persisted session history is checked
// again before every send. This window controls freshness, not record retention.
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

/** Freshness is checked at delivery time, including after a long busy turn. */
function endedFreshly(timestamp: string | undefined, nowMs: number, windowMs: number): boolean {
	const t = Date.parse(String(timestamp || ""));
	if (!Number.isFinite(t)) return false; // unknown end time needs explicit inspection
	return nowMs - t <= windowMs;
}

function persistedSessionEntries(ctx: ExtensionContext): readonly AnyEvent[] {
	// Receipts are session-wide side effects, not branch-sensitive model state.
	const entries = typeof ctx.sessionManager.getEntries === "function"
		? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch();
	if (!Array.isArray(entries)) throw new Error("Session history is unavailable");
	return entries;
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
			? `The workflow failed. Report the blocker and available partial results. Do not proceed as though the workflow succeeded. Recovery or replacement work requires the user's authorization.`
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
	let statusBridge: ReturnType<typeof createStatusBridgePublisher> | undefined;
	let statusRuntimeToken: object | undefined;
	const startupDeliveryTimers = new Set<ReturnType<typeof setTimeout>>();
	let retryDeferredSubmissions: (() => void) | undefined;
	let submitAtTurnEnd: (() => TurnEndEventResult | undefined) | undefined;
	let acknowledgeContinuation: ((runId: string, deliveryId: string) => void) | undefined;
	let requestHandoff: ((runId: string) => Promise<void>) | undefined;
	let dashboardRuns: typeof mergeMonitorRuns | undefined;
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
		await showThreadPhaseMonitor(ctx, cwdState.activeCwd || canonicalCwd(ctx.cwd) || path.resolve(ctx.cwd), dashboardRuns);
	};

	pi.registerCommand?.("workflows", {
		description: "Open the interactive thread-phase workflow dashboard",
		handler: async (_args, ctx) => openWorkflowDashboard(ctx),
	});

	pi.registerCommand?.("workflow-handoff", {
		description: "Explicitly deliver one held workflow result to this conversation: /workflow-handoff <runId>",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!runId || !requestHandoff) {
				ctx.ui.notify("Select a held result in /workflows, or use /workflow-handoff <runId>.", "info");
				return;
			}
			await requestHandoff(runId);
		},
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
		// persisted session-wide history can safely prove durable acceptance.
		if (event.message?.role !== "assistant") return;
		const storeDir = path.dirname(INDEX_FILE);
		try {
			const branchEntries = persistedSessionEntries(ctx);
			for (const pending of loadPendingContinuationRecords({ storeDir })) {
				if (!sessionHistoryHasContinuation(branchEntries, pending.deliveryId)) continue;
				const delivered = markContinuationDelivered(pending.runId, { storeDir, deliveryId: pending.deliveryId });
				if (delivered.delivered) acknowledgeContinuation?.(pending.runId, pending.deliveryId);
			}
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Could not reconcile thread-phase submission acceptance from session history: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.on("turn_end", (event, ctx) => {
		// Pi commits boundary entries after the whole tool batch, before selecting
		// the next request. Never leave a stale prompt in its steering queue.
		if (event.outcome !== "completed" || ctx.signal?.aborted) return;
		const handoff = submitAtTurnEnd?.();
		// Boundary handlers replace the accumulated entries; preserve prior peers.
		if (handoff?.entries) return { ...handoff, entries: [...event.entries, ...handoff.entries] };
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.isIdle()) retryDeferredSubmissions?.();
	});

	pi.on("session_start", async (_event, ctx) => {
		statusRuntimeToken = undefined;
		statusFooter?.dispose();
		statusFooter = undefined;
		try { statusBridge?.close(); } catch { /* optional observer cleanup is best-effort */ }
		statusBridge = undefined;
		if (statusRefreshTimer) clearInterval(statusRefreshTimer);
		statusRefreshTimer = undefined;
		sessionTerminated = false;
		for (const timer of startupDeliveryTimers) clearTimeout(timer);
		startupDeliveryTimers.clear();
		retryDeferredSubmissions = undefined;
		acknowledgeContinuation = undefined;
		requestHandoff = undefined;
		dashboardRuns = undefined;
		submitAtTurnEnd = undefined;
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
		const currentSessionId = ctx.sessionManager.getSessionId();
		const runtimeToken = {};
		statusRuntimeToken = runtimeToken;
		const bridgeConfiguration = (ctx.mode === "tui" || ctx.mode === "rpc") ? statusBridgeConfiguration() : undefined;
		let sessionBridge: ReturnType<typeof createStatusBridgePublisher> | undefined;
		if (bridgeConfiguration) {
			try {
				sessionBridge = createStatusBridgePublisher({
					root: bridgeConfiguration.root,
					sessionId: currentSessionId,
					normalizeStatus,
				});
				statusBridge = sessionBridge;
			} catch {
				// An optional observer must never interfere with the workflow/UI lifecycle.
				sessionBridge = undefined;
				statusBridge = undefined;
			}
		}
		const updateStatus = () => {
			// A cleared/replaced lifecycle must never read for or update its stale ctx.
			if (statusRuntimeToken !== runtimeToken) return;
			if (sessionFooter && statusFooter === sessionFooter) {
				try {
					const runs = mergeMonitorRuns(cwdState.activeCwd, currentSessionId);
					sessionFooter.setWorkflowIds(runs.filter(isLiveRun).map((run) => String(run.runId || "")).filter(Boolean));
				} catch {
					// Store/projection failures hide background status rather than leaving stale UI.
					sessionFooter.setWorkflowIds([]);
				}
			}
			if (sessionBridge && statusBridge === sessionBridge) {
				try {
					// Keep the footer's tolerant, 150-result cwd fallback independent from the
					// bridge's strict 256-result ownership projection. Sharing that projection
					// would change footer visibility or exhaust one side's verification budget.
					// Validation and projection share one contiguous bounded source window;
					// the store also checks index identity across ownership verification.
					const observation = observeSessionRunSummaries(currentSessionId);
					sessionBridge.observe(observation.runs);
				} catch {
					try { sessionBridge.markUnknown("store-read-failed"); } catch { /* lease expiry fails closed */ }
				}
			}
		};
		const continuationStoreDir = path.dirname(INDEX_FILE);
		// Progress is passive UI state, never a reason to prompt the main agent.
		// Deliberately do not load legacy progress-reviews.json: old schedules,
		// claims, cadence metadata and v3 defaults must remain inert after upgrade.
		let pendingContinuationRecords = loadPendingContinuationRecords({ storeDir: continuationStoreDir });

		// A receipt on any persisted branch proves the session already accepted it.
		// Branch navigation must not repeat a session-wide notification side effect.
		let branchEntries: readonly AnyEvent[] | undefined;
		try {
			branchEntries = persistedSessionEntries(ctx);
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
		const manualHandoffs = new Set<string>();
		const cardRunIds = new Set<string>((branchEntries || [])
			.filter((entry) => entry.type === "custom_message" && entry.customType === "thread-phase-run")
			.map((entry) => entry.details?.event?.runId || entry.details?.summary?.runId).filter(Boolean));
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

		const reconcileContinuation = (runId: string) => {
			const entries = persistedSessionEntries(ctx); // failure suppresses sending
			const record = loadPendingContinuationRecords({ storeDir: continuationStoreDir }).find((entry) => entry.runId === runId);
			const accepted = historyProvenRunIds.has(runId)
				|| sessionHistoryHasRunContinuation(entries, runId, currentSessionId)
				|| (record && sessionHistoryHasContinuation(entries, record.deliveryId));
			if (accepted) {
				historyProvenRunIds.add(runId);
				queuedContinuations.delete(runId);
				manualHandoffs.delete(runId);
				if (record) markContinuationDelivered(runId, { storeDir: continuationStoreDir, deliveryId: record.deliveryId });
				if (inFlightContinuation?.runId === runId) inFlightContinuation = undefined;
			}
			return { record, accepted };
		};
		const heldReason = (summary: AnyEvent, record?: AnyEvent) => {
			if (record && record.submissionState !== "unsent") return "delivery uncertain — explicit action required";
			if (!endedFreshly(summary.endedAt, Date.now(), STARTUP_CONTINUATION_FRESH_MS)) return "old result — explicit action required";
			return undefined;
		};
		let dashboardPending: { record: AnyEvent; summary: AnyEvent }[] = [];
		let nextDashboardRefreshAt = 0;
		dashboardRuns = (cwd, sessionId) => {
			const runs = new Map(mergeMonitorRuns(cwd, sessionId).map((run) => [run.runId, run]));
			const now = Date.now();
			if (now >= nextDashboardRefreshAt) {
				// ponytail: labels may lag one status interval; invalidate on writes if needed.
				// This display-only cache never grants permission to submit a handoff.
				dashboardPending = [];
				try {
					for (const record of loadPendingContinuationRecords({ storeDir: continuationStoreDir })) {
						try { dashboardPending.push({ record, summary: getRunSummary(record.runId) }); }
						catch { /* one unreadable run must not hide other pending results */ }
					}
				} catch { /* unavailable continuation state must not break the dashboard */ }
				nextDashboardRefreshAt = Date.now() + STATUS_REFRESH_MS;
			}
			for (const { record, summary } of dashboardPending) {
				if (!belongsToSession(summary, currentSessionId, cwdState.activeCwd) || !summary.endedAt || !shouldAutoContinue(summary)) continue;
				runs.set(record.runId, { ...summary, handoff: heldReason(summary, record) || "pending delivery" });
			}
			return [...runs.values()];
		};

		let boundaryEntries: CustomMessageEntryDraft[] | undefined;
		let pumpContinuations: () => void;
		let pumpSubmissions: () => void;
		let submissionGateActive = false;
		const scheduleContinuationPump = (delayMs = 0) => {
			if (sessionTerminated || inFlightContinuation) return;
			if (delayMs <= 0) {
				clearDeliveryTimer();
				pumpSubmissions();
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
				pumpSubmissions();
			}, Math.max(0, target - Date.now()));
			deliveryTimer.unref?.();
			startupDeliveryTimers.add(deliveryTimer);
		};

		pumpContinuations = () => {
			if (sessionTerminated || inFlightContinuation || (!ctx.isIdle() && !boundaryEntries)) return;
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
				if (!belongsToSession(summary, currentSessionId, cwdState.activeCwd) || !summary.endedAt || !shouldAutoContinue(summary)) {
					discardIneligibleContinuation(summary, runId);
					queuedContinuations.delete(runId);
					continue;
				}

				let claim;
				try {
					const { accepted, record } = reconcileContinuation(runId);
					if (accepted || (!manualHandoffs.has(runId) && heldReason(summary, record))) {
						queuedContinuations.delete(runId);
						continue;
					}
					claim = persistContinuationClaim(runId, {
						sessionId: currentSessionId,
						allowSubmitted: manualHandoffs.has(runId),
						storeDir: continuationStoreDir,
						retryPending: queued.retryPending,
						claimantId: continuationClaimantId,
						claimantProcessStart: continuationClaimantProcessStart,
					});
				} catch (error) {
					queuedContinuations.delete(runId);
					if (ctx.hasUI) ctx.ui.notify(`Could not reconcile or claim thread-phase continuation: ${error instanceof Error ? error.message : String(error)}`, "warning");
					continue;
				}
				if (!claim.claimed || !claim.deliveryId) {
					queuedContinuations.delete(runId);
					continue;
				}
				queued.retryPending = true;

				// Startup and waiting for the tool batch leave time for cancellation,
				// session scope, successor commitment, or durable ownership to change. Read
				// all of them again immediately before injecting the user message.
				try {
					summary = getRunSummary(runId);
				} catch {
					releaseSpecificClaim(runId, claim.deliveryId);
					queuedContinuations.delete(runId);
					continue;
				}
				if (!belongsToSession(summary, currentSessionId, cwdState.activeCwd) || !summary.endedAt || !shouldAutoContinue(summary)) {
					releaseSpecificClaim(runId, claim.deliveryId);
					discardIneligibleContinuation(summary, runId);
					queuedContinuations.delete(runId);
					continue;
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

				let prompt: string;
				try {
					prompt = formatMarkedContinuation(formatContinuationPrompt(summary), claim.deliveryId, { runId, sessionId: currentSessionId });
				} catch (error) {
					// Formatting is not submission. Retain the prior state and let other runs proceed.
					releaseSpecificClaim(runId, claim.deliveryId);
					queuedContinuations.delete(runId);
					manualHandoffs.delete(runId);
					if (ctx.hasUI) ctx.ui.notify(`Could not format thread-phase continuation ${runId}; it remains pending: ${error instanceof Error ? error.message : String(error)}`, "warning");
					continue;
				}
				const identity = { storeDir: continuationStoreDir, deliveryId: claim.deliveryId, claimantId: continuationClaimantId, claimantProcessStart: continuationClaimantProcessStart };
				// A user-confirmed resend of an uncertain record stays uncertain if the
				// resend itself fails to enqueue; only a proven-unsent record restores unsent.
				let restoreSubmissionState: "unsent" | "submitted" | "unknown" = "unsent";
				try {
					const latest = reconcileContinuation(runId);
					if (latest.accepted) continue;
					if (latest.record?.submissionState === "submitted" || latest.record?.submissionState === "unknown") {
						restoreSubmissionState = latest.record.submissionState;
					}
					if (!markContinuationSubmission(runId, { ...identity, submissionState: "submitted" })) {
						queuedContinuations.delete(runId);
						continue;
					}
				} catch {
					releaseSpecificClaim(runId, claim.deliveryId);
					queuedContinuations.delete(runId);
					continue;
				}
				queuedContinuations.delete(runId);
				inFlightContinuation = { runId, deliveryId: claim.deliveryId };
				try {
					if (boundaryEntries) {
						// The native boundary appends this directly to persisted context;
						// it does not enqueue text that can outlive delivery eligibility.
						boundaryEntries.push({ type: "custom_message", customType: "thread-phase-handoff",
							content: prompt, display: true, details: { deliveryId: claim.deliveryId, runId } });
					} else pi.sendUserMessage(prompt);
					manualHandoffs.delete(runId);
				} catch (error) {
					// A synchronous rejection did not enqueue a message. Retry at most three
					// submissions per extension runtime with bounded backoff, without retaining an
					// in-flight lock that would permanently block all later continuations.
					inFlightContinuation = undefined;
					try {
						if (!markContinuationSubmission(runId, { ...identity, submissionState: restoreSubmissionState })) continue;
					} catch { continue; } // uncertain persistence must never grant another send
					finally { releaseSpecificClaim(runId, claim.deliveryId); }
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
				// One message remains in flight until persisted session history acknowledges it.
				// Later completions wait for the next turn boundary or idle settlement.
				return;
			}
		};

		acknowledgeContinuation = (runId, deliveryId) => {
			historyProvenRunIds.add(runId);
			if (inFlightContinuation?.runId === runId && inFlightContinuation.deliveryId === deliveryId) {
				inFlightContinuation = undefined;
			}
		};
		const retryContinuations = (settled = false) => {
			// Reconsider durable records whose successor state was unreadable, or
			// whose earlier claimant was active. Never reset a submission retry budget.
			try {
				if (inFlightContinuation) {
					const flight = inFlightContinuation;
					if (!reconcileContinuation(flight.runId).accepted && settled) {
						// Only a lifecycle settlement can release an unaccepted flight.
						// Passive isIdle() is also true during asynchronous SDK preflight.
						// The submitted record stays uncertain, never automatically replayed.
						releaseSpecificClaim(flight.runId, flight.deliveryId);
						inFlightContinuation = undefined;
					}
				}
				for (const pending of loadPendingContinuationRecords({ storeDir: continuationStoreDir })) {
					if (queuedContinuations.has(pending.runId) || retryExhausted(pending.runId)
						|| inFlightContinuation?.runId === pending.runId) continue;
					let summary: AnyEvent;
					try { summary = getRunSummary(pending.runId); }
					catch { continue; } // durable pending work is retried without blocking its neighbors
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
			let historyAvailable = true;
			let record: AnyEvent | undefined;
			try {
				const reconciled = reconcileContinuation(runId);
				if (reconciled.accepted) return;
				record = reconciled.record;
			} catch { historyAvailable = false; } // retain unsent work without granting delivery
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
				// An already-durable held record needs no claim round-trip per idle edge.
				if (record && historyAvailable && !manualHandoffs.has(runId) && heldReason(_summary, record)) return;
				let claim;
				try {
					claim = persistContinuationClaim(runId, {
						sessionId: currentSessionId,
						allowSubmitted: manualHandoffs.has(runId),
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
				if (!historyAvailable || (!manualHandoffs.has(runId) && heldReason(_summary))) return;
				queuedContinuations.set(runId, { retryPending: true, notBefore });
			}
			scheduleContinuationPump(Math.max(0, notBefore - Date.now()));
		};

		pumpSubmissions = () => {
			if (submissionGateActive || sessionTerminated) return;
			submissionGateActive = true;
			try {
				pumpContinuations();
			} finally {
				submissionGateActive = false;
			}
		};

		retryDeferredSubmissions = () => retryContinuations(true);
		submitAtTurnEnd = () => {
			const entries: CustomMessageEntryDraft[] = [];
			boundaryEntries = entries;
			try { pumpSubmissions(); }
			finally { boundaryEntries = undefined; }
			// Pi coalesces this with a natural tool-loop continuation; it does not
			// add a second request when the tool batch already requires one.
			return entries.length ? { entries, continue: true } : undefined;
		};
		requestHandoff = async (runId) => {
			try {
				const summary = getRunSummary(runId);
				if (!belongsToSession(summary, currentSessionId, cwdState.activeCwd) || !summary.endedAt || !shouldAutoContinue(summary)) {
					ctx.ui.notify("No eligible terminal handoff owned by this session.", "warning");
					return;
				}
				const { accepted, record } = reconcileContinuation(runId);
				if (accepted) { ctx.ui.notify("This workflow result was already delivered to this session.", "info"); return; }
				if (inFlightContinuation?.runId === runId) {
					ctx.ui.notify("This handoff is still in flight; wait for the current turn to settle.", "info");
					return;
				}
				if (record && record.submissionState !== "unsent") {
					if (!ctx.hasUI || !await ctx.ui.confirm("Delivery is uncertain", "Pi may already have accepted this result. Submit it again?")) return;
				}
				if (sessionTerminated || statusRuntimeToken !== runtimeToken) return;
				submissionRetries.delete(runId); // an explicit request gets its own bounded retry budget
				manualHandoffs.add(runId);
				attemptAutoContinuation(summary, runId, true);
			} catch (error) {
				ctx.ui.notify(`Could not deliver workflow handoff: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		};

		// Prime completion rendering while reclaiming durable pending deliveries.
		// Legacy continuation ids migrate as delivered and are never replayed.
		let indexCursor = readIndexUpdates().cursor;
		const startupEvents = readIndex({ limit: 5000 });
		for (const event of startupEvents) {
			seen.add(eventKey(event));
			if (event.type === EVENT_TYPES.WORKFLOW_END) cardRunIds.add(event.runId);
		}
		const startupNowMs = Date.now();
		const startupRuns = new Set<string>(pendingContinuationRecords
			.filter((record: AnyEvent) => !historyProvenRunIds.has(record.runId))
			.map((record: AnyEvent) => record.runId));
		for (const event of startupEvents) {
			// Reconcile all pending work; old/uncertain results remain passive. The
			// index fallback discovers only fresh completions without a store receipt.
			if (event.type === EVENT_TYPES.WORKFLOW_END && event.runId
				&& !historyProvenRunIds.has(event.runId)
				&& endedFreshly(event.timestamp, startupNowMs, STARTUP_CONTINUATION_FRESH_MS)) {
				startupRuns.add(event.runId);
			}
		}
		const unresolvedCompletions = new Map<string, AnyEvent | undefined>();
		const processCompletion = (runId: string, event?: AnyEvent, startup = false) => {
			unresolvedCompletions.delete(runId);
			try {
				const summary = getRunSummary(runId);
				if (!belongsToSession(summary, currentSessionId, cwdState.activeCwd)) return;
				const newCompletion = event && !cardRunIds.has(runId);
				if (newCompletion) {
					pi.sendMessage({
						customType: "thread-phase-run",
						content: formatCompletion(event),
						display: true,
						details: { event, summary, events: readRun(runId, { readLimit: 50_000 }) },
					}, { triggerTurn: false });
					cardRunIds.add(runId);
				}
				if ([STATUSES.SUCCESS, STATUSES.FAILED].includes(summary?.normalizedStatus)
					&& continuationEligibility(summary) !== "ineligible") attemptAutoContinuation(summary, runId, !event, { startup });
				else discardIneligibleContinuation(summary, runId);
				if (newCompletion && ctx.hasUI) ctx.ui.notify(`thread-phase ${event.workflow}: ${event.status || "done"}`, summary.normalizedStatus === STATUSES.FAILED ? "warning" : "info");
			} catch {
				// Retain only the discovery hint; unreadable evidence grants no ownership.
				unresolvedCompletions.set(runId, event);
			}
		};
		for (const runId of startupRuns) processCompletion(runId, undefined, true);
		updateStatus();

		const processNewEvents = () => {
			if (sessionTerminated || statusRuntimeToken !== runtimeToken) return;
			const { events, cursor } = readIndexUpdates(indexCursor);
			// ponytail: retain one hint per unreadable run in this runtime, retry 100
			// per refresh round-robin; use a durable discovery outbox for restart recovery.
			const retries: [string, AnyEvent | undefined][] = [];
			for (const entry of unresolvedCompletions) {
				retries.push(entry);
				if (retries.length >= 100) break;
			}
			for (const [runId, event] of retries) processCompletion(runId, event, !event);
			for (const event of events) {
				if (event.type !== EVENT_TYPES.WORKFLOW_END) continue;
				const key = eventKey(event);
				if (seen.has(key)) continue;
				processCompletion(event.runId, event);
				seen.add(key);
			}
			indexCursor = cursor;
		};
		const refresh = () => {
			if (sessionTerminated || statusRuntimeToken !== runtimeToken) return;
			try {
				processNewEvents();
				if (ctx.isIdle()) retryContinuations();
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Could not refresh thread-phase completions: ${error instanceof Error ? error.message : String(error)}`, "warning");
			} finally {
				updateStatus(); // the bridge must still mark a missing/unreadable source unknown
			}
		};

		watcher?.close();
		watcher = undefined;
		// fs.watch is a latency hint, not delivery authority. Keep bounded discovery
		// alive even without a footer/bridge or a new user/idle edge. This is passive
		// store reconciliation, never periodic main-agent supervision.
		statusRefreshTimer = setInterval(refresh, STATUS_REFRESH_MS);
		statusRefreshTimer.unref?.();
		try {
			const installedWatcher = fs.watch(INDEX_FILE, { persistent: false }, refresh);
			watcher = installedWatcher;
			installedWatcher.on?.("error", () => {
				installedWatcher.close();
				if (watcher === installedWatcher) watcher = undefined;
			});
		} catch {
			// Watch quota/platform failures must not disable lifecycle-owned polling.
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionTerminated = true;
		statusRuntimeToken = undefined;
		for (const timer of startupDeliveryTimers) clearTimeout(timer);
		startupDeliveryTimers.clear();
		retryDeferredSubmissions = undefined;
		acknowledgeContinuation = undefined;
		requestHandoff = undefined;
		dashboardRuns = undefined;
		submitAtTurnEnd = undefined;
		watcher?.close();
		watcher = undefined;
		if (statusRefreshTimer) clearInterval(statusRefreshTimer);
		statusRefreshTimer = undefined;
		statusFooter?.dispose();
		statusFooter = undefined;
		try { statusBridge?.close(); } catch { /* optional observer cleanup is best-effort */ }
		statusBridge = undefined;
		try {
			relinquishContinuationClaims({
				storeDir: path.dirname(INDEX_FILE),
				claimantId: continuationClaimantId,
				claimantProcessStart: continuationClaimantProcessStart,
			});
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Could not relinquish pending thread-phase submission claims during shutdown: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		if (ctx.hasUI) {
			try { ctx.ui.setStatus("thread-phase", undefined); } catch { /* best-effort UI cleanup */ }
			try { ctx.ui.setStatus("thread-phase-cwd", undefined); } catch { /* best-effort UI cleanup */ }
			try { ctx.ui.setWidget("thread-phase", undefined); } catch { /* best-effort UI cleanup */ }
		}
	});
}
