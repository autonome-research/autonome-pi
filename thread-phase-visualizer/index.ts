import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEMO_SCRIPT = path.join(EXT_DIR, "bin", "demo-workflow.mjs");
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

function runDemo(cwd: string, options: { fail?: boolean; workflow?: string; delay?: string }, signal?: AbortSignal) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		const args = [DEMO_SCRIPT, "--cwd", cwd];
		if (options.workflow) args.push("--workflow", options.workflow);
		if (options.delay) args.push("--delay", options.delay);
		if (options.fail) args.push("--fail");
		const proc = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.stderr.on("data", (d) => (stderr += d.toString()));
		proc.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
		proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
		if (signal) {
			const abort = () => proc.kill("SIGTERM");
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

export default function threadPhaseVisualizer(pi: ExtensionAPI) {
	let watcher: fs.FSWatcher | undefined;
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

	pi.registerCommand("thread-phase", {
		description: "Show recent generic thread-phase workflow runs; use 'demo' to emit a sample run",
		handler: async (args, ctx) => {
			ensureStore();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "demo") {
				const result = await runDemo(ctx.cwd, {
					fail: parts.includes("--fail") || parts.includes("fail"),
					workflow: parts.includes("--workflow") ? parts[parts.indexOf("--workflow") + 1] : undefined,
					delay: parts.includes("--delay") ? parts[parts.indexOf("--delay") + 1] : undefined,
				}, ctx.signal);
				if (result.code !== 0) ctx.ui.notify(result.stderr || result.stdout || "Demo workflow failed", "warning");
				else ctx.ui.notify("Demo thread-phase workflow emitted", "info");
				return;
			}
			if (parts[0] === "run" && parts[1]) {
				const events = readRun(parts[1]);
				const summary = getRunSummary(parts[1]);
				pi.sendMessage({
					customType: "thread-phase-run",
					content: formatRunDetail(summary),
					display: true,
					details: { runId: parts[1], summary, events },
				});
				return;
			}
			const runs = latestRunSummaries({ limit: 20, cwd: ctx.cwd });
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
			const running = latestRunSummaries({ limit: 100, cwd }).filter((run: AnyEvent) => run.normalizedStatus === STATUSES.RUNNING).length;
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
					const summary = getRunSummary(event.runId);
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

	pi.on("session_shutdown", () => {
		watcher?.close();
		watcher = undefined;
	});
}
