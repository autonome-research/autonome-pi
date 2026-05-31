import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import { latestRunSummaries } from "../lib/store.mjs";
import { phaseSummaryText, statusColor, statusIcon } from "./phase-timeline.ts";
import { artifactSummaryText } from "./artifact-view.ts";
import { showRunDetailOverlay } from "./run-detail.ts";

type RunSummary = Record<string, any>;

function shortRunId(runId: string | undefined): string {
	if (!runId) return "unknown";
	const parts = runId.split("-");
	return parts.length > 1 ? parts.slice(-1)[0] : runId.slice(0, 12);
}

function itemForRun(run: RunSummary) {
	return {
		value: run.runId,
		label: `${run.workflow || "workflow"} [${shortRunId(run.runId)}]`,
		description: `${run.status || run.normalizedStatus || "unknown"} · ${phaseSummaryText(run)} · ${artifactSummaryText(run)} · ${run.updatedAt || ""}`,
		run,
	};
}

export async function showRunBrowser(ctx: ExtensionCommandContext, options: { cwd?: string; workflow?: string; limit?: number } = {}) {
	if (!ctx.hasUI) {
		ctx.ui.notify("Thread-phase browser requires interactive mode", "warning");
		return;
	}
	const runs = latestRunSummaries({ cwd: options.cwd ?? ctx.cwd, workflow: options.workflow, limit: options.limit ?? 50 });
	if (runs.length === 0) {
		ctx.ui.notify("No thread-phase runs found", "info");
		return;
	}

	const selectedRunId = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Thread-phase runs")), 1, 0));
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter open • esc close"), 1, 0));

		const items = runs.map(itemForRun);
		const list = new SelectList(items as any[], Math.min(items.length, 12), {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});
		list.onSelect = (item: any) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput?.(data);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center", margin: 1 } });

	if (!selectedRunId) return;
	const selected = runs.find((run) => run.runId === selectedRunId);
	if (selected) await showRunDetailOverlay(ctx, selected);
}

export function formatRunBrowserLine(run: RunSummary, theme: any): string {
	const status = run.normalizedStatus || run.status;
	return `${theme.fg(statusColor(status), statusIcon(status))} ${theme.fg("accent", run.workflow || "workflow")} ${theme.fg("dim", `[${shortRunId(run.runId)}] ${phaseSummaryText(run)} · ${artifactSummaryText(run)}`)}`;
}
