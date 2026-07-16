import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { showThreadPhaseMonitor } from "./components/monitor.ts";
import { registerThreadPhaseMessageRenderers } from "./components/run-message-renderer.ts";
import { activeRunWidgetLines } from "./components/status-widget.ts";
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
import { loadContinuedRuns, persistContinuationClaim, releaseContinuationClaim, shouldAutoContinue } from "./lib/continuation-store.mjs";

const MAX_MESSAGE_BYTES = 20_000;

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
		run.heartbeat?.timestamp ? `  heartbeat: ${run.heartbeat.timestamp}${run.heartbeat.featureId ? ` feature=${run.heartbeat.featureId}` : ""}` : undefined,
		run.usage?.entries ? `  usage: ${formatUsageSummary(run.usage)}` : undefined,
		phases ? `  phases: ${phases}` : undefined,
		artifacts.length ? `  artifacts: ${artifacts.join(", ")}` : undefined,
		`  ${run.lastMessage || ""}`,
	].filter(Boolean).join("\n");
}

function formatRunDetail(run: AnyEvent): string {
	const artifacts = run.artifacts || [];
	return truncate([
		`${statusIcon(run.normalizedStatus)} Thread-phase workflow ${run.status}: ${run.workflow}${run.stale ? ` ${formatStaleIndicator(run)}` : ""}`,
		`Run: ${run.runId}`,
		formatOwnerMetadata(run) || undefined,
		run.heartbeat?.timestamp ? `Heartbeat: ${run.heartbeat.timestamp}${run.heartbeat.featureId ? ` feature=${run.heartbeat.featureId}` : ""}` : undefined,
		run.usage?.entries ? `Usage: ${formatUsageSummary(run.usage)}` : undefined,
		run.phases?.length ? `\nPhases:\n${run.phases.map((p: AnyEvent) => `- ${statusIcon(p.normalizedStatus)} ${p.phase}${p.usage?.entries ? ` · ${formatUsageSummary(p.usage)}` : ""}${p.lastMessage ? ` — ${p.lastMessage}` : ""}`).join("\n")}` : undefined,
		artifacts.length ? `\nArtifacts:\n${artifacts.map((a: AnyEvent) => `- ${a.title || a.kind}: ${a.path || a.preview || (a.content ? "(inline)" : "")}`).join("\n")}` : undefined,
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

function formatContinuationPrompt(run: AnyEvent): string {
	const artifacts = (run.artifacts || [])
		.map((artifact: AnyEvent) => `- ${artifact.title || artifact.kind}: ${artifact.path || artifact.preview || (artifact.content ? "(inline)" : "")}`)
		.join("\n");
	const phases = (run.phases || [])
		.map((phase: AnyEvent) => `- ${statusIcon(phase.normalizedStatus)} ${phase.phase}${phase.lastMessage ? ` — ${phase.lastMessage}` : ""}`)
		.join("\n");
	return [
		`A thread-phase workflow completed in this Pi session.`,
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
		`Please inspect the workflow result/artifacts as needed, summarize the outcome, and continue with the user's task.`,
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
	let cwdState = createCwdState(process.cwd());
	let continuedRuns = new Set<string>();
	const seen = new Set<string>();

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

	pi.registerShortcut("ctrl+shift+t", {
		description: "Open live thread-phase monitor",
		handler: async (ctx) => {
			ensureStore();
			await showThreadPhaseMonitor(ctx, cwdState.activeCwd || canonicalCwd(ctx.cwd) || path.resolve(ctx.cwd));
		},
	});

	pi.on("user_bash", (event, ctx) => {
		cwdState = trackCwdCommand(cwdState, event.command, event.cwd || ctx.cwd);
	});

	pi.on("session_start", async (_event, ctx) => {
		ensureStore();
		cwdState = createCwdState(ctx.cwd);
		const updateStatus = () => {
			if (!ctx.hasUI) return;
			const runs = mergeMonitorRuns(cwdState.activeCwd, currentSessionId);
			const running = runs.filter((run: AnyEvent) => run.normalizedStatus === STATUSES.RUNNING).length;
			ctx.ui.setStatus("thread-phase", running > 0 ? `${running} workflow(s) running` : undefined);
			const widgetLines = activeRunWidgetLines(runs);
			ctx.ui.setWidget("thread-phase", widgetLines.length > 0 ? widgetLines : undefined, { placement: "belowEditor" });
		};
		const currentSessionId = ctx.sessionManager.getSessionId();
		// Normalize/prune persisted history at startup. This set mirrors the durable
		// state for diagnostics only; live delivery decisions never use it as a
		// precondition because entries can expire while this session remains open.
		continuedRuns = loadContinuedRuns({ storeDir: path.dirname(INDEX_FILE) });
		const attemptAutoContinuation = (summary: AnyEvent, runId: string) => {
			let claim;
			try {
				claim = persistContinuationClaim(runId, { storeDir: path.dirname(INDEX_FILE) });
				continuedRuns = claim.runs;
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Could not persist thread-phase continuation claim: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			}
			if (!claim.claimed) return;
			try {
				const prompt = formatContinuationPrompt(summary);
				if (ctx.isIdle()) pi.sendUserMessage(prompt);
				else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			} catch (error) {
				try {
					continuedRuns = releaseContinuationClaim(runId, { storeDir: path.dirname(INDEX_FILE) }).runs;
				} catch (releaseError) {
					if (ctx.hasUI) ctx.ui.notify(`Continuation delivery failed and its claim could not be released: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`, "warning");
					return;
				}
				if (ctx.hasUI) ctx.ui.notify(`Could not deliver thread-phase continuation; it remains retryable: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		};

		// Prime completion rendering while retrying explicitly opted-in runs whose
		// prior synchronous continuation enqueue failed and released its claim.
		const startupEvents = readIndex({ limit: 5000 });
		for (const event of startupEvents) seen.add(eventKey(event));
		const startupRuns = new Set<string>();
		for (const event of startupEvents) {
			if (event.type !== EVENT_TYPES.WORKFLOW_END || !event.runId || startupRuns.has(event.runId)) continue;
			startupRuns.add(event.runId);
			const summary = getRunSummary(event.runId);
			if (belongsToSession(summary, currentSessionId, cwdState.activeCwd) && shouldAutoContinue(summary)) attemptAutoContinuation(summary, event.runId);
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
					if (event.runId && shouldAutoContinue(summary)) attemptAutoContinuation(summary, event.runId);
					if (ctx.hasUI) ctx.ui.notify(`thread-phase ${event.workflow}: ${event.status || "done"}`, summary.normalizedStatus === STATUSES.FAILED ? "warning" : "info");
				}
			}
			updateStatus();
		};

		watcher?.close();
		watcher = fs.watch(INDEX_FILE, { persistent: false }, () => processNewEvents());
	});

	pi.on("session_shutdown", (_event, ctx) => {
		watcher?.close();
		watcher = undefined;
		if (ctx.hasUI) {
			ctx.ui.setStatus("thread-phase", undefined);
			ctx.ui.setStatus("thread-phase-cwd", undefined);
			ctx.ui.setWidget("thread-phase", undefined);
		}
	});
}
