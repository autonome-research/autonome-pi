import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { STATUSES, latestRunSummaries, readArtifactContent } from "../lib/store.mjs";
import { framePanel } from "./bordered-panel.ts";
import { formatFanout, formatProgress, statusColor, statusIcon } from "./phase-timeline.ts";

type RunSummary = Record<string, any>;
type PhaseSummary = Record<string, any>;
type ArtifactSummary = Record<string, any>;

type Mode = "list" | "detail" | "phases" | "artifacts" | "artifact";

const MAX_VISIBLE_RUNS = 12;
const MAX_DETAIL_PHASE_ITEMS = 10;
const MAX_ARTIFACT_BYTES = 100_000;
const LIVE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function shortRunId(runId: string | undefined): string {
	if (!runId) return "unknown";
	const parts = runId.split("-");
	return parts.length > 1 ? parts.slice(-1)[0] : runId.slice(0, 12);
}

function liveFrame(): string {
	return LIVE_FRAMES[Math.floor(Date.now() / 140) % LIVE_FRAMES.length];
}

function workflowGlyph(status: string | undefined, theme: any): string {
	if (status === STATUSES.RUNNING) return theme.fg("accent", liveFrame());
	return theme.fg(statusColor(status), statusIcon(status));
}

function phaseStatusGlyph(status: string | undefined): string {
	if (status === STATUSES.RUNNING) return "◈";
	if (status === STATUSES.FAILED) return "⬢";
	if (status === STATUSES.CANCELLED) return "◇";
	if (status === STATUSES.SKIPPED) return "◇";
	if (status === STATUSES.UNKNOWN) return "◇";
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
	const phase = [...phases].reverse().find((p) => p.normalizedStatus === STATUSES.RUNNING) || phases[phases.length - 1];
	if (!phase) return "";
	const progress = phase.fanout ? formatFanout(phase.fanout) : formatProgress(phase.progress);
	return `${phase.phase || "phase"}${progress}`;
}

function monitorRuns(cwd: string): RunSummary[] {
	const globalRunning = latestRunSummaries({ limit: 100 }).filter((run: RunSummary) => run.normalizedStatus === STATUSES.RUNNING);
	const localRuns = latestRunSummaries({ cwd, limit: 50 });
	const byRun = new Map<string, RunSummary>();
	for (const run of [...globalRunning, ...localRuns]) if (run.runId) byRun.set(run.runId, run);
	return Array.from(byRun.values()).sort((a, b) => {
		if (a.normalizedStatus === STATUSES.RUNNING && b.normalizedStatus !== STATUSES.RUNNING) return -1;
		if (b.normalizedStatus === STATUSES.RUNNING && a.normalizedStatus !== STATUSES.RUNNING) return 1;
		return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
	});
}

function runtimePid(run: RunSummary): number | undefined {
	const pid = run.metadata?.pid;
	return typeof pid === "number" ? pid : undefined;
}

function isRunningCancellable(run: RunSummary | undefined): boolean {
	return Boolean(run?.normalizedStatus === STATUSES.RUNNING && runtimePid(run));
}

function artifactTitle(artifact: ArtifactSummary | undefined): string {
	return artifact?.title || artifact?.kind || "artifact";
}

function artifactTarget(artifact: ArtifactSummary | undefined): string {
	return artifact?.path || artifact?.preview || (artifact?.content ? "(inline)" : "");
}

function compactJson(value: any): string {
	try { return JSON.stringify(value); }
	catch { return String(value); }
}

class ThreadPhaseMonitorComponent {
	private mode: Mode = "list";
	private selected = 0;
	private selectedPhase = 0;
	private selectedArtifact = 0;
	private scroll = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private cwd: string, private theme: any, private onClose: () => void, private onCancelRun: (run: RunSummary) => void) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}

		const runs = monitorRuns(this.cwd);
		const run = runs[this.selected];

		if (this.mode !== "list" && (matchesKey(data, "b") || matchesKey(data, Key.left))) {
			if (this.mode === "artifact") this.mode = "artifacts";
			else if (this.mode === "detail") this.mode = "list";
			else this.mode = "detail";
			this.scroll = 0;
			this.invalidate();
			return;
		}

		if (data === "x") {
			if (isRunningCancellable(run)) this.onCancelRun(run);
			this.invalidate();
			return;
		}

		if (this.mode !== "list" && data === "p" && run?.phases?.length) {
			this.mode = "phases";
			this.selectedPhase = Math.min(this.selectedPhase, run.phases.length - 1);
			this.scroll = 0;
			this.invalidate();
			return;
		}
		if (this.mode !== "list" && data === "a" && run?.artifacts?.length) {
			this.mode = "artifacts";
			this.selectedArtifact = Math.min(this.selectedArtifact, run.artifacts.length - 1);
			this.scroll = 0;
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") this.move(1, run);
		else if (matchesKey(data, Key.up) || data === "k") this.move(-1, run);
		else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			if (this.mode === "list") this.mode = "detail";
			else if (this.mode === "artifacts" && run?.artifacts?.length) {
				this.mode = "artifact";
				this.scroll = 0;
			}
			this.invalidate();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const runs = monitorRuns(this.cwd);
		this.selected = Math.max(0, Math.min(this.selected, Math.max(0, runs.length - 1)));
		const innerWidth = Math.max(20, width - 4);
		const content = this.renderMode(innerWidth, runs);
		const lines = this.withBorder(content, width);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private move(delta: number, run?: RunSummary): void {
		if (this.mode === "list") {
			const runs = monitorRuns(this.cwd);
			this.selected = Math.max(0, Math.min(this.selected + delta, Math.max(0, runs.length - 1)));
		} else if (this.mode === "phases") {
			const phases = run?.phases || [];
			this.selectedPhase = Math.max(0, Math.min(this.selectedPhase + delta, Math.max(0, phases.length - 1)));
		} else if (this.mode === "artifacts") {
			const artifacts = run?.artifacts || [];
			this.selectedArtifact = Math.max(0, Math.min(this.selectedArtifact + delta, Math.max(0, artifacts.length - 1)));
		} else {
			this.scroll = Math.max(0, this.scroll + delta);
		}
		this.invalidate();
	}

	private withBorder(content: string[], width: number): string[] {
		return framePanel(content, width, this.theme, { title: "Thread-phase" });
	}

	private renderMode(width: number, runs: RunSummary[]): string[] {
		if (this.mode === "detail") return this.renderDetail(width, runs);
		if (this.mode === "phases") return this.renderPhases(width, runs);
		if (this.mode === "artifacts") return this.renderArtifacts(width, runs);
		if (this.mode === "artifact") return this.renderArtifact(width, runs);
		return this.renderList(width, runs);
	}

	private renderList(width: number, runs: RunSummary[]): string[] {
		const t = this.theme;
		const lines: string[] = [];
		const selectedRun = runs[this.selected];
		const cancelHint = isRunningCancellable(selectedRun) ? " • x cancel" : "";
		lines.push(truncateToWidth(t.fg("accent", t.bold("Thread-phase monitor")) + t.fg("dim", `  ↑↓ select • enter detail${cancelHint} • q close`), width));
		lines.push(truncateToWidth(t.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
		if (runs.length === 0) {
			lines.push(truncateToWidth(t.fg("dim", "No runs for this working directory."), width));
			return lines;
		}
		const start = Math.max(0, Math.min(this.selected - MAX_VISIBLE_RUNS + 1, Math.max(0, runs.length - MAX_VISIBLE_RUNS)));
		const visible = runs.slice(start, start + MAX_VISIBLE_RUNS);
		if (start > 0) lines.push(truncateToWidth(t.fg("dim", `… ${start} newer/active run(s)`), width));
		for (let i = 0; i < visible.length; i++) {
			const run = visible[i];
			const index = start + i;
			const selected = index === this.selected;
			const status = run.normalizedStatus || run.status;
			const prefix = selected ? t.fg("accent", "›") : " ";
			const live = status === STATUSES.RUNNING ? t.fg("accent", " LIVE") : "";
			const head = `${prefix} ${workflowGlyph(status, t)} ${selected ? t.fg("accent", run.workflow || "workflow") : run.workflow || "workflow"}${live} ${t.fg("dim", `[${shortRunId(run.runId)}]`)}`;
			const current = status === STATUSES.RUNNING ? currentPhaseText(run) : "";
			lines.push(truncateToWidth(`${head}${current ? t.fg("muted", ` — ${current}`) : ""}`, width));
			if (status === STATUSES.RUNNING) lines.push(truncateToWidth(`  ${deterministicPhaseLine(run, t)}`, width));
		}
		const remaining = runs.length - start - visible.length;
		if (remaining > 0) lines.push(truncateToWidth(t.fg("dim", `… ${remaining} older run(s)`), width));
		return lines;
	}

	private renderDetail(width: number, runs: RunSummary[]): string[] {
		const t = this.theme;
		const run = runs[this.selected];
		if (!run) return this.renderList(width, runs);
		const status = run.normalizedStatus || run.status;
		const all: string[] = [];
		const cancelHint = isRunningCancellable(run) ? " • x cancel" : "";
		all.push(t.fg("dim", `←/b list • p phases • a artifacts${cancelHint} • q close`));
		all.push(t.fg("accent", t.bold(`${workflowGlyph(status, t)} ${run.workflow || "workflow"}`)) + t.fg("dim", ` [${run.runId || "unknown"}]`));
		const pid = runtimePid(run);
		all.push(t.fg("dim", `status: ${run.status || status}  updated: ${run.updatedAt || "?"}${pid && status === STATUSES.RUNNING ? `  pid: ${pid}` : ""}`));
		all.push("");
		all.push(t.fg("toolTitle", t.bold("Phases")) + t.fg("dim", ` (${(run.phases || []).length})`));
		for (const phase of (run.phases || []).slice(0, 6)) {
			const pStatus = phase.normalizedStatus || phase.status;
			const progress = phase.fanout ? formatFanout(phase.fanout) : formatProgress(phase.progress);
			all.push(`${t.fg(statusColor(pStatus), phaseStatusGlyph(pStatus))} ${t.fg("accent", phase.phase || "phase")}${t.fg("muted", progress)}${phase.lastMessage ? t.fg("dim", ` — ${phase.lastMessage}`) : ""}`);
		}
		if ((run.phases || []).length > 6) all.push(t.fg("dim", `… ${(run.phases || []).length - 6} more phase(s); press p`));
		all.push("");
		all.push(t.fg("toolTitle", t.bold("Artifacts")) + t.fg("dim", ` (${(run.artifacts || []).length})`));
		for (const artifact of (run.artifacts || []).slice(0, 5)) all.push(`${t.fg("success", "◉")} ${artifactTitle(artifact)}${artifactTarget(artifact) ? t.fg("dim", ` — ${artifactTarget(artifact)}`) : ""}`);
		if ((run.artifacts || []).length > 5) all.push(t.fg("dim", `… ${(run.artifacts || []).length - 5} more artifact(s); press a`));
		if (run.errors?.length) {
			all.push("");
			all.push(t.fg("error", t.bold("Errors")));
			for (const error of run.errors) all.push(t.fg("error", `- ${error.phase ? `${error.phase}: ` : ""}${error.message || error.error?.message || "error"}`));
		}
		return this.windowLines(all, width, 22);
	}

	private renderPhases(width: number, runs: RunSummary[]): string[] {
		const t = this.theme;
		const run = runs[this.selected];
		if (!run) return this.renderList(width, runs);
		const phases: PhaseSummary[] = run.phases || [];
		this.selectedPhase = Math.max(0, Math.min(this.selectedPhase, Math.max(0, phases.length - 1)));
		const phase = phases[this.selectedPhase];
		const lines: string[] = [];
		lines.push(t.fg("dim", "←/b detail • ↑↓ select stage • a artifacts • q close"));
		lines.push(t.fg("toolTitle", t.bold(`Stages for ${run.workflow || "workflow"}`)) + t.fg("dim", ` [${shortRunId(run.runId)}]`));
		lines.push(t.fg("borderMuted", "─".repeat(Math.max(0, width))));
		if (!phases.length) {
			lines.push(t.fg("dim", "No phases recorded."));
			return lines.map((line) => truncateToWidth(line, width));
		}
		for (let i = 0; i < phases.length; i++) {
			const p = phases[i];
			const pStatus = p.normalizedStatus || p.status;
			const progress = p.fanout ? formatFanout(p.fanout) : formatProgress(p.progress);
			const prefix = i === this.selectedPhase ? t.fg("accent", "›") : " ";
			lines.push(`${prefix} ${t.fg(statusColor(pStatus), phaseStatusGlyph(pStatus))} ${i === this.selectedPhase ? t.fg("accent", p.phase || "phase") : p.phase || "phase"}${t.fg("muted", progress)}${p.lastMessage ? t.fg("dim", ` — ${p.lastMessage}`) : ""}`);
		}
		if (phase) {
			const pStatus = phase.normalizedStatus || phase.status;
			lines.push("");
			lines.push(t.fg("toolTitle", t.bold("Selected stage")));
			lines.push(`${t.fg(statusColor(pStatus), phaseStatusGlyph(pStatus))} ${t.fg("accent", phase.phase || "phase")} ${t.fg("dim", String(pStatus || "unknown"))}`);
			if (phase.startedAt) lines.push(t.fg("dim", `started: ${phase.startedAt}`));
			if (phase.endedAt) lines.push(t.fg("dim", `ended:   ${phase.endedAt}`));
			if (phase.progress) lines.push(t.fg("muted", `progress: ${compactJson(phase.progress)}`));
			if (phase.fanout) {
				lines.push(t.fg("muted", `fanout:${formatFanout(phase.fanout)} ${phase.fanout.label || ""}`));
				for (const item of (phase.fanout.items || []).slice(0, MAX_DETAIL_PHASE_ITEMS)) {
					const iStatus = item.normalizedStatus || item.status;
					lines.push(`  ${t.fg(statusColor(iStatus), statusIcon(iStatus))} ${item.label || item.itemId}${item.lastMessage ? t.fg("dim", ` — ${item.lastMessage}`) : ""}`);
				}
				if ((phase.fanout.items || []).length > MAX_DETAIL_PHASE_ITEMS) lines.push(t.fg("dim", `  … ${phase.fanout.items.length - MAX_DETAIL_PHASE_ITEMS} more item(s)`));
			}
		}
		return lines.map((line) => truncateToWidth(line, width));
	}

	private renderArtifacts(width: number, runs: RunSummary[]): string[] {
		const t = this.theme;
		const run = runs[this.selected];
		if (!run) return this.renderList(width, runs);
		const artifacts: ArtifactSummary[] = run.artifacts || [];
		this.selectedArtifact = Math.max(0, Math.min(this.selectedArtifact, Math.max(0, artifacts.length - 1)));
		const lines: string[] = [];
		lines.push(t.fg("dim", "←/b detail • ↑↓ select artifact • enter open • p phases • q close"));
		lines.push(t.fg("toolTitle", t.bold(`Artifacts for ${run.workflow || "workflow"}`)) + t.fg("dim", ` [${shortRunId(run.runId)}]`));
		lines.push(t.fg("borderMuted", "─".repeat(Math.max(0, width))));
		if (!artifacts.length) lines.push(t.fg("dim", "No artifacts recorded."));
		for (let i = 0; i < artifacts.length; i++) {
			const artifact = artifacts[i];
			const prefix = i === this.selectedArtifact ? t.fg("accent", "›") : " ";
			lines.push(`${prefix} ${t.fg("success", "◉")} ${i === this.selectedArtifact ? t.fg("accent", artifactTitle(artifact)) : artifactTitle(artifact)}${artifactTarget(artifact) ? t.fg("dim", ` — ${artifactTarget(artifact)}`) : ""}`);
		}
		return lines.map((line) => truncateToWidth(line, width));
	}

	private renderArtifact(width: number, runs: RunSummary[]): string[] {
		const t = this.theme;
		const run = runs[this.selected];
		const artifact: ArtifactSummary | undefined = run?.artifacts?.[this.selectedArtifact];
		if (!run || !artifact) return this.renderArtifacts(width, runs);
		const all: string[] = [];
		all.push(t.fg("dim", "←/b artifacts • ↑↓ scroll • q close"));
		all.push(`${t.fg("success", "◉")} ${t.fg("accent", t.bold(artifactTitle(artifact)))}`);
		const target = artifactTarget(artifact);
		if (target) all.push(t.fg("dim", target));
		all.push(t.fg("borderMuted", "─".repeat(Math.max(0, width))));
		try {
			const result = readArtifactContent(artifact, { maxBytes: MAX_ARTIFACT_BYTES });
			if (!result?.content) all.push(t.fg("dim", "No readable artifact content."));
			else {
				all.push(...result.content.split(/\r?\n/));
				if (result.truncated) all.push(t.fg("warning", "[artifact truncated]"));
			}
		} catch (error: any) {
			all.push(t.fg("error", `Could not read artifact: ${error?.message || error}`));
		}
		return this.windowLines(all, width, 24);
	}

	private windowLines(lines: string[], width: number, bodyHeight: number): string[] {
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - bodyHeight));
		return lines.slice(this.scroll, this.scroll + bodyHeight).map((line) => truncateToWidth(line, width));
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
			const component = new ThreadPhaseMonitorComponent(cwd, theme, () => done(), (run) => {
				const pid = runtimePid(run);
				if (!pid || run.normalizedStatus !== STATUSES.RUNNING) {
					ctx.ui.notify("Selected workflow is not currently cancellable.", "warning");
					return;
				}
				try {
					process.kill(pid, "SIGTERM");
					ctx.ui.notify(`Cancellation requested for ${run.workflow || "workflow"} (${pid})`, "warning");
				} catch (error: any) {
					ctx.ui.notify(`Could not cancel workflow: ${error?.message || error}`, "error");
				}
			});
			timer = setInterval(() => {
				component.invalidate();
				tui.requestRender();
			}, 150);
			return component;
		}, { overlay: true, overlayOptions: { width: "88%", maxHeight: "80%", anchor: "center", margin: 1 } });
	} finally {
		if (timer) clearInterval(timer);
	}
}
