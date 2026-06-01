import * as fs from "node:fs";
import { homedir } from "node:os";
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
	getRunSummary,
	latestRunSummaries,
	readIndex,
	readRun,
} from "./lib/store.mjs";

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

function formatRunSummary(run: AnyEvent): string {
	const phases = (run.phases || [])
		.map((phase: AnyEvent) => `${statusIcon(phase.normalizedStatus)} ${phase.phase}`)
		.join(", ");
	const artifacts = (run.artifacts || []).map((a: AnyEvent) => a.path || a.title).filter(Boolean);
	return [
		`- ${statusIcon(run.normalizedStatus)} ${run.workflow} (${run.runId})`,
		`  updated: ${run.updatedAt}`,
		phases ? `  phases: ${phases}` : undefined,
		artifacts.length ? `  artifacts: ${artifacts.join(", ")}` : undefined,
		`  ${run.lastMessage || ""}`,
	].filter(Boolean).join("\n");
}

function formatRunDetail(run: AnyEvent): string {
	const artifacts = run.artifacts || [];
	return truncate([
		`${statusIcon(run.normalizedStatus)} Thread-phase workflow ${run.status}: ${run.workflow}`,
		`Run: ${run.runId}`,
		run.cwd ? `CWD: ${run.cwd}` : undefined,
		run.phases?.length ? `\nPhases:\n${run.phases.map((p: AnyEvent) => `- ${statusIcon(p.normalizedStatus)} ${p.phase}${p.lastMessage ? ` — ${p.lastMessage}` : ""}`).join("\n")}` : undefined,
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

function shellUnquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
	return trimmed.replace(/\\ /g, " ");
}

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
	return input;
}

function parseSimpleCd(command: string): string | undefined {
	const trimmed = command.trim().replace(/;\s*$/, "");
	const match = trimmed.match(/^cd(?:\s+(.+))?$/);
	if (!match) return undefined;
	return shellUnquote(match[1] || "~");
}

function directoryExists(candidate: string): boolean {
	try { return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory(); }
	catch { return false; }
}

function runSessionId(run: AnyEvent | undefined): string | undefined {
	const sessionId = run?.metadata?.sessionId;
	return typeof sessionId === "string" && sessionId ? sessionId : undefined;
}

function belongsToSession(run: AnyEvent, sessionId?: string, cwd?: string): boolean {
	if (sessionId) return runSessionId(run) === sessionId;
	return !cwd || run.cwd === cwd;
}

function mergeMonitorRuns(cwd: string, sessionId?: string): AnyEvent[] {
	const allRecent = latestRunSummaries({ limit: 150, readLimit: 8000 });
	const scopedRuns = allRecent.filter((run: AnyEvent) => belongsToSession(run, sessionId, cwd));
	const localUnscopedRunning = allRecent.filter((run: AnyEvent) => !runSessionId(run) && run.cwd === cwd && run.normalizedStatus === STATUSES.RUNNING);
	const byRun = new Map<string, AnyEvent>();
	for (const run of [...scopedRuns, ...localUnscopedRunning]) if (run.runId) byRun.set(run.runId, run);
	return Array.from(byRun.values()).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

export default function threadPhaseVisualizer(pi: ExtensionAPI) {
	registerThreadPhaseMessageRenderers(pi);

	let watcher: fs.FSWatcher | undefined;
	let activeCwd = process.cwd();
	let previousCwd = activeCwd;
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
			if (params.runId) {
				const events = readRun(params.runId).slice(-(params.limit || 80));
				const summary = getRunSummary(params.runId);
				return {
					content: [{ type: "text", text: truncate(params.rawEvents ? JSON.stringify(events, null, 2) : formatRunDetail(summary)) }],
					details: { summary, events },
				};
			}
			const cwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : undefined;
			const runs = latestRunSummaries({ limit: params.limit || 20, workflow: params.workflow, cwd });
			return {
				content: [{ type: "text", text: runs.length ? runs.map(formatRunSummary).join("\n\n") : "No thread-phase runs found." }],
				details: { runs },
			};
		},
	});

	pi.registerShortcut("ctrl+shift+t", {
		description: "Open live thread-phase monitor",
		handler: async (ctx) => {
			ensureStore();
			await showThreadPhaseMonitor(ctx, path.resolve(activeCwd || ctx.cwd));
		},
	});

	pi.on("user_bash", (event, ctx) => {
		const target = parseSimpleCd(event.command);
		if (target === undefined) return;
		const base = activeCwd || event.cwd || ctx.cwd;
		const next = target === "-" ? previousCwd : path.resolve(base, expandHome(target));
		if (!directoryExists(next)) return;
		previousCwd = base;
		activeCwd = next;
	});

	pi.on("session_start", async (_event, ctx) => {
		ensureStore();
		activeCwd = path.resolve(ctx.cwd);
		previousCwd = activeCwd;
		const updateStatus = () => {
			if (!ctx.hasUI) return;
			const runs = mergeMonitorRuns(activeCwd, currentSessionId);
			const running = runs.filter((run: AnyEvent) => run.normalizedStatus === STATUSES.RUNNING).length;
			ctx.ui.setStatus("thread-phase", running > 0 ? `${running} workflow(s) running` : undefined);
			const widgetLines = activeRunWidgetLines(runs);
			ctx.ui.setWidget("thread-phase", widgetLines.length > 0 ? widgetLines : undefined, { placement: "belowEditor" });
		};
		const currentSessionId = ctx.sessionManager.getSessionId();
		// Prime the seen set so reloading Pi does not replay old completed workflow messages.
		for (const event of readIndex({ limit: 5000 })) seen.add(eventKey(event));
		updateStatus();

		const processNewEvents = () => {
			const events = readIndex({ limit: 500 });
			for (const event of events) {
				const key = eventKey(event);
				if (seen.has(key)) continue;
				seen.add(key);
				if (event.type === EVENT_TYPES.WORKFLOW_END) {
					const summary = getRunSummary(event.runId);
					if (!belongsToSession(summary, currentSessionId, activeCwd)) continue;
					pi.sendMessage({
						customType: "thread-phase-run",
						content: formatCompletion(event),
						display: true,
						details: { event, summary, events: readRun(event.runId) },
					});
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
