import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { latestRunSummaries } from "../lib/store.mjs";
import { framePanel } from "./bordered-panel.ts";
import { formatFanout, formatProgress, statusColor, statusIcon } from "./phase-timeline.ts";

type RunSummary = Record<string, any>;
type PhaseSummary = Record<string, any>;

type Mode = "list" | "detail";

const MAX_VISIBLE_RUNS = 12;
const MAX_DETAIL_PHASE_ITEMS = 10;

function shortRunId(runId: string | undefined): string {
	if (!runId) return "unknown";
	const parts = runId.split("-");
	return parts.length > 1 ? parts.slice(-1)[0] : runId.slice(0, 12);
}

function phaseStatusGlyph(status: string | undefined): string {
	if (status === "running") return "◈";
	if (status === "failed") return "⬢";
	if (status === "cancelled") return "◇";
	if (status === "skipped") return "◇";
	if (status === "unknown") return "◇";
	return "◆";
}

function phaseGlyph(phase: PhaseSummary, theme: any): string {
	const status = phase.normalizedStatus || phase.status;
	return theme.fg(statusColor(status), phaseStatusGlyph(status));
}

function deterministicPhaseLine(run: RunSummary, theme: any): string {
	const phases: PhaseSummary[] = run.phases || [];
	if (phases.length === 0) return theme.fg("dim", "○ no phases yet");
	return phases
		.map((phase) => `${phaseGlyph(phase, theme)} ${phase.phase || "phase"}`)
		.join(theme.fg("dim", " ─ "));
}

function currentPhaseText(run: RunSummary): string {
	const phases: PhaseSummary[] = run.phases || [];
	const phase = [...phases].reverse().find((p) => p.normalizedStatus === "running") || phases[phases.length - 1];
	if (!phase) return "";
	const progress = phase.fanout ? formatFanout(phase.fanout) : formatProgress(phase.progress);
	return `${phase.phase || "phase"}${progress}`;
}

class ThreadPhaseMonitorComponent {
	private mode: Mode = "list";
	private selected = 0;
	private scroll = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private cwd: string, private theme: any, private onClose: () => void) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}
		if (this.mode === "detail" && (matchesKey(data, "b") || matchesKey(data, Key.left))) {
			this.mode = "list";
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") this.move(1);
		else if (matchesKey(data, Key.up) || data === "k") this.move(-1);
		else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			if (this.mode === "list") this.mode = "detail";
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const runs = latestRunSummaries({ cwd: this.cwd, limit: 50 });
		this.selected = Math.max(0, Math.min(this.selected, Math.max(0, runs.length - 1)));
		const innerWidth = Math.max(20, width - 4);
		const content = this.mode === "detail" ? this.renderDetail(innerWidth, runs) : this.renderList(innerWidth, runs);
		const lines = this.withBorder(content, width);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private move(delta: number): void {
		if (this.mode === "detail") {
			this.scroll = Math.max(0, this.scroll + delta);
		} else {
			const runs = latestRunSummaries({ cwd: this.cwd, limit: 50 });
			this.selected = Math.max(0, Math.min(this.selected + delta, Math.max(0, runs.length - 1)));
		}
		this.invalidate();
	}

	private withBorder(content: string[], width: number): string[] {
		return framePanel(content, width, this.theme, { title: "Thread-phase" });
	}

	private renderList(width: number, runs: RunSummary[]): string[] {
		const t = this.theme;
		const lines: string[] = [];
		lines.push(truncateToWidth(t.fg("accent", t.bold("Thread-phase monitor")) + t.fg("dim", "  ↑↓ select • enter detail • q close"), width));
		lines.push(truncateToWidth(t.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
		if (runs.length === 0) {
			lines.push(truncateToWidth(t.fg("dim", "No runs for this working directory."), width));
			return lines;
		}
		const visible = runs.slice(0, MAX_VISIBLE_RUNS);
		for (let i = 0; i < visible.length; i++) {
			const run = visible[i];
			const selected = i === this.selected;
			const status = run.normalizedStatus || run.status;
			const prefix = selected ? t.fg("accent", "›") : " ";
			const head = `${prefix} ${t.fg(statusColor(status), statusIcon(status))} ${selected ? t.fg("accent", run.workflow || "workflow") : run.workflow || "workflow"} ${t.fg("dim", `[${shortRunId(run.runId)}]`)}`;
			const current = currentPhaseText(run);
			lines.push(truncateToWidth(`${head}${current ? t.fg("muted", ` — ${current}`) : ""}`, width));
			if (status === "running") lines.push(truncateToWidth(`  ${deterministicPhaseLine(run, t)}`, width));
		}
		if (runs.length > visible.length) lines.push(truncateToWidth(t.fg("dim", `… ${runs.length - visible.length} older run(s)`), width));
		return lines;
	}

	private renderDetail(width: number, runs: RunSummary[]): string[] {
		const t = this.theme;
		const run = runs[this.selected];
		if (!run) return this.renderList(width, runs);
		const status = run.normalizedStatus || run.status;
		const all: string[] = [];
		all.push(t.fg("accent", t.bold(`${statusIcon(status)} ${run.workflow || "workflow"}`)) + t.fg("dim", ` [${run.runId || "unknown"}]`));
		all.push(t.fg("dim", `status: ${run.status || status}  updated: ${run.updatedAt || "?"}`));
		all.push("");
		all.push(t.fg("toolTitle", t.bold("Phases")));
		for (const phase of run.phases || []) {
			const pStatus = phase.normalizedStatus || phase.status;
			const progress = phase.fanout ? formatFanout(phase.fanout) : formatProgress(phase.progress);
			all.push(`${t.fg(statusColor(pStatus), phaseStatusGlyph(pStatus))} ${t.fg("accent", phase.phase || "phase")}${t.fg("muted", progress)}${phase.lastMessage ? t.fg("dim", ` — ${phase.lastMessage}`) : ""}`);
			if (phase.fanout?.items?.length) {
				for (const item of phase.fanout.items.slice(0, MAX_DETAIL_PHASE_ITEMS)) {
					const iStatus = item.normalizedStatus || item.status;
					all.push(`  ${t.fg(statusColor(iStatus), statusIcon(iStatus))} ${item.label || item.itemId}${item.lastMessage ? t.fg("dim", ` — ${item.lastMessage}`) : ""}`);
				}
				if (phase.fanout.items.length > MAX_DETAIL_PHASE_ITEMS) all.push(t.fg("dim", `  … ${phase.fanout.items.length - MAX_DETAIL_PHASE_ITEMS} more item(s)`));
			}
		}
		if (run.artifacts?.length) {
			all.push("");
			all.push(t.fg("toolTitle", t.bold("Artifacts")));
			for (const artifact of run.artifacts) all.push(`${t.fg("success", "◉")} ${artifact.title || artifact.kind}${artifact.path ? t.fg("dim", ` — ${artifact.path}`) : ""}`);
		}
		if (run.errors?.length) {
			all.push("");
			all.push(t.fg("error", t.bold("Errors")));
			for (const error of run.errors) all.push(t.fg("error", `- ${error.phase ? `${error.phase}: ` : ""}${error.message || error.error?.message || "error"}`));
		}
		const bodyHeight = 22;
		this.scroll = Math.min(this.scroll, Math.max(0, all.length - bodyHeight));
		const visible = all.slice(this.scroll, this.scroll + bodyHeight).map((line) => truncateToWidth(line, width));
		visible.unshift(truncateToWidth(t.fg("dim", "←/b back • ↑↓ scroll • q close"), width));
		return visible;
	}
}

export async function showThreadPhaseMonitor(ctx: ExtensionContext, cwd: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Thread-phase monitor requires interactive mode", "warning");
		return;
	}
	let timer: NodeJS.Timeout | undefined;
	try {
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const component = new ThreadPhaseMonitorComponent(cwd, theme, () => done());
			timer = setInterval(() => {
				component.invalidate();
				tui.requestRender();
			}, 1000);
			return component;
		}, { overlay: true, overlayOptions: { width: "88%", maxHeight: "80%", anchor: "center", margin: 1 } });
	} finally {
		if (timer) clearInterval(timer);
	}
}
