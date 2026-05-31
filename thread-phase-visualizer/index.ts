import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EVENT_TYPES, STATUSES, ensureStore, INDEX_FILE, latestRuns, readIndex, readRun } from "./lib/store.mjs";

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

function formatRunSummary(run: AnyEvent): string {
	const phases = Object.entries(run.phases || {})
		.map(([name, status]) => `${status === STATUSES.SUCCESS ? "✓" : status === STATUSES.FAILED ? "✗" : "•"} ${name}`)
		.join(", ");
	const artifacts = (run.artifacts || []).map((a: AnyEvent) => a.path || a.title).filter(Boolean);
	return [
		`- ${run.status === STATUSES.FAILED ? "✗" : run.status === STATUSES.RUNNING ? "…" : "✓"} ${run.workflow} (${run.runId})`,
		`  updated: ${run.updatedAt}`,
		phases ? `  phases: ${phases}` : undefined,
		artifacts.length ? `  artifacts: ${artifacts.join(", ")}` : undefined,
		`  ${run.lastMessage || ""}`,
	].filter(Boolean).join("\n");
}

function formatCompletion(event: AnyEvent): string {
	const status = event.status || STATUSES.SUCCESS;
	const icon = status === STATUSES.FAILED ? "✗" : status === STATUSES.CANCELLED ? "⊘" : "✓";
	const runEvents = readRun(event.runId);
	const artifacts = runEvents.filter((e: AnyEvent) => e.type === EVENT_TYPES.ARTIFACT && e.artifact).map((e: AnyEvent) => e.artifact);
	const phaseEnds = runEvents.filter((e: AnyEvent) => e.type === EVENT_TYPES.PHASE_END);
	return truncate([
		`${icon} Thread-phase workflow ${status}: ${event.workflow}`,
		`Run: ${event.runId}`,
		event.cwd ? `CWD: ${event.cwd}` : undefined,
		phaseEnds.length ? `\nPhases:\n${phaseEnds.map((e: AnyEvent) => `- ${e.status === "failed" ? "✗" : "✓"} ${e.phase}`).join("\n")}` : undefined,
		artifacts.length ? `\nArtifacts:\n${artifacts.map((a: AnyEvent) => `- ${a.title || a.kind}: ${a.path || a.content || "(inline)"}`).join("\n")}` : undefined,
		event.message ? `\n${event.message}` : undefined,
	].filter(Boolean).join("\n"));
}

export default function threadPhaseVisualizer(pi: ExtensionAPI) {
	let watcher: fs.FSWatcher | undefined;
	const seen = new Set<string>();

	pi.registerTool({
		name: "thread_phase_runs",
		label: "Thread Phase Runs",
		description: "List recent generic thread-phase workflow runs or show events for a runId.",
		promptSnippet: "Inspect recent thread-phase workflow runs and artifacts",
		parameters: Type.Object({
			runId: Type.Optional(Type.String({ description: "Specific run id to inspect." })),
			workflow: Type.Optional(Type.String({ description: "Filter runs by workflow name." })),
			cwd: Type.Optional(Type.String({ description: "Filter runs by repository/directory." })),
			limit: Type.Optional(Type.Number({ description: "Max runs/events to return.", default: 20 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureStore();
			if (params.runId) {
				const events = readRun(params.runId).slice(-(params.limit || 80));
				return {
					content: [{ type: "text", text: truncate(JSON.stringify(events, null, 2)) }],
					details: { events },
				};
			}
			const cwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : undefined;
			const runs = latestRuns({ limit: params.limit || 20, workflow: params.workflow, cwd });
			return {
				content: [{ type: "text", text: runs.length ? runs.map(formatRunSummary).join("\n\n") : "No thread-phase runs found." }],
				details: { runs },
			};
		},
	});

	pi.registerCommand("thread-phase", {
		description: "Show recent generic thread-phase workflow runs",
		handler: async (args, ctx) => {
			ensureStore();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "run" && parts[1]) {
				const events = readRun(parts[1]);
				pi.sendMessage({
					customType: "thread-phase-run",
					content: truncate(JSON.stringify(events.slice(-120), null, 2)),
					display: true,
					details: { runId: parts[1], events },
				});
				return;
			}
			const runs = latestRuns({ limit: 20, cwd: ctx.cwd });
			pi.sendMessage({
				customType: "thread-phase-runs",
				content: runs.length ? runs.map(formatRunSummary).join("\n\n") : "No thread-phase runs found for this directory.",
				display: true,
				details: { runs },
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ensureStore();
		const cwd = path.resolve(ctx.cwd);
		const updateStatus = () => {
			if (!ctx.hasUI) return;
			const running = latestRuns({ limit: 100, cwd }).filter((run: AnyEvent) => run.status === STATUSES.RUNNING).length;
			ctx.ui.setStatus("thread-phase", running > 0 ? `${running} workflow(s) running` : "watching");
		};
		// Prime the seen set so reloading Pi does not replay old completed workflow messages.
		for (const event of readIndex({ limit: 5000 })) seen.add(eventKey(event));
		updateStatus();

		const processNewEvents = () => {
			const events = readIndex({ limit: 500 });
			for (const event of events) {
				const key = eventKey(event);
				if (seen.has(key)) continue;
				seen.add(key);
				if (event.cwd !== cwd) continue;
				if (event.type === EVENT_TYPES.WORKFLOW_END) {
					pi.sendMessage({
						customType: "thread-phase-run",
						content: formatCompletion(event),
						display: true,
						details: { event, events: readRun(event.runId) },
					});
					if (ctx.hasUI) ctx.ui.notify(`thread-phase ${event.workflow}: ${event.status || "done"}`, event.status === STATUSES.FAILED ? "warning" : "info");
				}
			}
			updateStatus();
		};

		watcher?.close();
		watcher = fs.watch(INDEX_FILE, { persistent: false }, () => processNewEvents());
	});

	pi.on("session_shutdown", () => {
		watcher?.close();
		watcher = undefined;
	});
}
