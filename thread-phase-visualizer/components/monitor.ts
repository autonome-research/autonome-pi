import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { STATUSES, formatUsageSummary, latestRunSummaries, readArtifactContent, requestCancellation } from "../lib/store.mjs";
import { framePanel } from "./bordered-panel.ts";
import { formatFanout, formatProgress, statusColor, statusIcon } from "./phase-timeline.ts";

type RunSummary = Record<string, any>;
type PhaseSummary = Record<string, any>;
type ArtifactSummary = Record<string, any>;
type Mode = "list" | "detail" | "artifact";
type DetailItem = { kind: "phase"; index: number; phase: PhaseSummary } | { kind: "artifact"; index: number; artifact: ArtifactSummary };

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
	if (status === STATUSES.CANCELLED || status === STATUSES.SKIPPED || status === STATUSES.UNKNOWN) return "◇";
	return "◆";
}

function phaseGlyph(phase: PhaseSummary, theme: any): string {
	const status = phase.normalizedStatus || phase.status;
	return theme.fg(statusColor(status), phaseStatusGlyph(status));
}

function deterministicPhaseLine(run: RunSummary, theme: any): string {
	const phases: PhaseSummary[] = run.phases || [];
	if (phases.length === 0) return theme.fg("dim", "○ no phases yet");
	return phases.map((phase) => `${phaseGlyph(phase, theme)} ${phase.phase || "phase"}`).join(theme.fg("dim", " ─ "));
}

function currentPhaseText(run: RunSummary): string {
	const phases: PhaseSummary[] = run.phases || [];
	const phase = [...phases].reverse().find((p) => p.normalizedStatus === STATUSES.RUNNING) || phases[phases.length - 1];
	if (!phase) return "";
	const progress = phase.fanout ? formatFanout(phase.fanout) : formatProgress(phase.progress);
	return `${phase.phase || "phase"}${progress}`;
}

function cwdLabel(cwd: string | undefined): string {
	if (!cwd) return "unknown cwd";
	return basename(cwd) || cwd;
}

function runSessionId(run: RunSummary | undefined): string | undefined {
	const sessionId = run?.metadata?.sessionId;
	return typeof sessionId === "string" && sessionId ? sessionId : undefined;
}

function belongsToSession(run: RunSummary, sessionId?: string, cwd?: string): boolean {
	if (sessionId) return runSessionId(run) === sessionId;
	return !cwd || run.cwd === cwd;
}

function monitorRuns(cwd: string, sessionId?: string): RunSummary[] {
	const allRecent = latestRunSummaries({ limit: 150, readLimit: 8000 });
	const scopedRuns = allRecent.filter((run: RunSummary) => belongsToSession(run, sessionId, cwd));
	const localUnscopedRunning = allRecent.filter((run: RunSummary) => !runSessionId(run) && run.normalizedStatus === STATUSES.RUNNING);
	const byRun = new Map<string, RunSummary>();
	for (const run of [...scopedRuns, ...localUnscopedRunning]) if (run.runId) byRun.set(run.runId, run);
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
	return Boolean(run?.normalizedStatus === STATUSES.RUNNING && !run?.stale && run?.runId);
}

function staleText(run: RunSummary | undefined): string {
	if (!run?.stale) return "";
	if (run.stale.reason === "pid_not_running") return `STALE pid ${run.stale.pid} exited`;
	if (run.stale.reason === "heartbeat_stale") return `STALE heartbeat ${Math.round((run.stale.ageMs || 0) / 1000)}s ago`;
	return `STALE ${run.stale.reason || "unknown"}`;
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

function detailItems(run: RunSummary | undefined): DetailItem[] {
	if (!run) return [];
	const phases = (run.phases || []).map((phase: PhaseSummary, index: number) => ({ kind: "phase" as const, index, phase }));
	const artifacts = (run.artifacts || []).map((artifact: ArtifactSummary, index: number) => ({ kind: "artifact" as const, index, artifact }));
	return [...phases, ...artifacts];
}

function isMarkdownArtifact(artifact: ArtifactSummary): boolean {
	return String(artifact.kind || "").toLowerCase() === "markdown" || String(artifact.path || "").toLowerCase().endsWith(".md");
}

class ThreadPhaseMonitorComponent {
	private mode: Mode = "list";
	private selected = 0;
	private selectedDetail = 0;
	private expandedPhase?: number;
	private selectedArtifact = 0;
	private scroll = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private cwd: string, private sessionId: string | undefined, private theme: any, private onClose: () => void, private onCancelRun: (run: RunSummary) => void) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}

		const runs = monitorRuns(this.cwd, this.sessionId);
		const run = runs[this.selected];
		const items = detailItems(run);

		if (matchesKey(data, "b") || matchesKey(data, Key.left)) {
			if (this.mode === "artifact") this.mode = "detail";
			else if (this.mode === "detail") this.mode = "list";
			this.scroll = 0;
			this.invalidate();
			return;
		}

		if (data === "x") {
			if (isRunningCancellable(run)) this.onCancelRun(run);
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") this.move(1, run, items);
		else if (matchesKey(data, Key.up) || data === "k") this.move(-1, run, items);
		else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) this.enter(run, items);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const runs = monitorRuns(this.cwd, this.sessionId);
		this.selected = Math.max(0, Math.min(this.selected, Math.max(0, runs.length - 1)));
		const innerWidth = Math.max(20, width - 4);
		const content = this.mode === "artifact" ? this.renderArtifact(innerWidth, runs) : this.mode === "detail" ? this.renderDetail(innerWidth, runs) : this.renderList(innerWidth, runs);
		const lines = this.withBorder(content, width);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private move(delta: number, run?: RunSummary, items: DetailItem[] = []): void {
		if (this.mode === "list") {
			const runs = monitorRuns(this.cwd, this.sessionId);
			this.selected = Math.max(0, Math.min(this.selected + delta, Math.max(0, runs.length - 1)));
			this.selectedDetail = 0;
		} else if (this.mode === "detail") {
			this.selectedDetail = Math.max(0, Math.min(this.selectedDetail + delta, Math.max(0, items.length - 1)));
		} else {
			this.scroll = Math.max(0, this.scroll + delta);
		}
		this.invalidate();
	}

	private enter(run?: RunSummary, items: DetailItem[] = []): void {
		if (this.mode === "list") {
			this.mode = "detail";
			this.scroll = 0;
		} else if (this.mode === "detail") {
			const item = items[this.selectedDetail];
			if (item?.kind === "phase") this.expandedPhase = this.expandedPhase === item.index ? undefined : item.index;
			if (item?.kind === "artifact") {
				this.selectedArtifact = item.index;
				this.mode = "artifact";
				this.scroll = 0;
			}
		}
		this.invalidate();
	}

	private withBorder(content: string[], width: number): string[] {
		return framePanel(content, width, this.theme, { title: "Thread-phase" });
	}

	private renderList(width: number, runs: RunSummary[]): string[] {
		const t = this.theme;
		const lines: string[] = [];
		const selectedRun = runs[this.selected];
		const cancelHint = isRunningCancellable(selectedRun) ? " • x cancel" : "";
		lines.push(truncateToWidth(t.fg("accent", t.bold("Thread-phase monitor")) + t.fg("dim", `  ↑↓ select • enter details${cancelHint} • q close`), width));
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
			const stale = staleText(run);
			const live = stale ? t.fg("warning", ` ${stale}`) : status === STATUSES.RUNNING ? t.fg("accent", " LIVE") : "";
			const head = `${prefix} ${workflowGlyph(stale ? STATUSES.UNKNOWN : status, t)} ${selected ? t.fg("accent", run.workflow || "workflow") : run.workflow || "workflow"}${live} ${t.fg("dim", `[${shortRunId(run.runId)}]`)}`;
			const current = status === STATUSES.RUNNING ? currentPhaseText(run) : "";
			const location = run.cwd ? t.fg("dim", ` @ ${cwdLabel(run.cwd)}`) : "";
			lines.push(truncateToWidth(`${head}${location}${current ? t.fg("muted", ` — ${current}`) : ""}`, width));
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
		const items = detailItems(run);
		this.selectedDetail = Math.max(0, Math.min(this.selectedDetail, Math.max(0, items.length - 1)));
		const selectedItem = items[this.selectedDetail];
		const status = run.normalizedStatus || run.status;
		const lines: string[] = [];
		let itemCursor = 0;
		let selectedLine = 0;
		const add = (line: string, selectable = false) => {
			if (selectable && itemCursor === this.selectedDetail) selectedLine = lines.length;
			lines.push(line);
			if (selectable) itemCursor++;
		};

		const cancelHint = isRunningCancellable(run) ? " • x cancel" : "";
		add(t.fg("dim", `← back • ↑↓ select phase/artifact • enter ${selectedItem?.kind === "artifact" ? "open" : "expand"}${cancelHint} • q close`));
		add(t.fg("accent", t.bold(`${workflowGlyph(status, t)} ${run.workflow || "workflow"}`)) + t.fg("dim", ` [${run.runId || "unknown"}]`));
		const pid = runtimePid(run);
		add(t.fg("dim", `status: ${run.status || status}${run.stale ? ` (${staleText(run)})` : ""}  updated: ${run.updatedAt || "?"}${pid && status === STATUSES.RUNNING ? `  pid: ${pid}` : ""}`));
		if (run.cwd) add(t.fg("dim", `cwd: ${run.cwd}`));
		if (run.heartbeat?.timestamp) add(t.fg("dim", `heartbeat: ${run.heartbeat.timestamp}${run.heartbeat.featureId ? `  feature: ${run.heartbeat.featureId}` : ""}`));
		if (run.usage?.entries) add(t.fg("muted", `usage: ${formatUsageSummary(run.usage)}`));
		add("");
		add(t.fg("toolTitle", t.bold("Phases")) + t.fg("dim", ` (${(run.phases || []).length})`));
		if (!(run.phases || []).length) add(t.fg("dim", "No phases recorded."));
		for (const phase of run.phases || []) {
			const pStatus = phase.normalizedStatus || phase.status;
			const progress = phase.fanout ? formatFanout(phase.fanout) : formatProgress(phase.progress);
			const selected = itemCursor === this.selectedDetail;
			const prefix = selected ? t.fg("accent", "›") : " ";
			add(`${prefix} ${t.fg(statusColor(pStatus), phaseStatusGlyph(pStatus))} ${selected ? t.fg("accent", phase.phase || "phase") : phase.phase || "phase"}${t.fg("muted", progress)}${phase.lastMessage ? t.fg("dim", ` — ${phase.lastMessage}`) : ""}`, true);
			if (this.expandedPhase === itemCursor - 1) this.addPhaseDetails(lines, phase, width);
		}
		add("");
		add(t.fg("toolTitle", t.bold("Artifacts")) + t.fg("dim", ` (${(run.artifacts || []).length})`));
		if (!(run.artifacts || []).length) add(t.fg("dim", "No artifacts recorded."));
		for (const artifact of run.artifacts || []) {
			const selected = itemCursor === this.selectedDetail;
			const prefix = selected ? t.fg("accent", "›") : " ";
			add(`${prefix} ${t.fg("success", "◉")} ${selected ? t.fg("accent", artifactTitle(artifact)) : artifactTitle(artifact)}${artifactTarget(artifact) ? t.fg("dim", ` — ${artifactTarget(artifact)}`) : ""}`, true);
		}
		if (run.errors?.length) {
			add("");
			add(t.fg("error", t.bold("Errors")));
			for (const error of run.errors) add(t.fg("error", `- ${error.phase ? `${error.phase}: ` : ""}${error.message || error.error?.message || "error"}`));
		}
		return this.windowLines(lines, width, 24, selectedLine);
	}

	private addPhaseDetails(lines: string[], phase: PhaseSummary, width: number): void {
		const t = this.theme;
		if (phase.startedAt) lines.push(t.fg("dim", `    started: ${phase.startedAt}`));
		if (phase.endedAt) lines.push(t.fg("dim", `    ended:   ${phase.endedAt}`));
		if (phase.progress) lines.push(t.fg("muted", `    progress: ${compactJson(phase.progress)}`));
		if (phase.usage?.entries) lines.push(t.fg("muted", `    usage: ${formatUsageSummary(phase.usage)}`));
		if (!phase.fanout) return;
		lines.push(t.fg("muted", `    fanout:${formatFanout(phase.fanout)} ${phase.fanout.label || ""}`));
		for (const item of (phase.fanout.items || []).slice(0, MAX_DETAIL_PHASE_ITEMS)) {
			const iStatus = item.normalizedStatus || item.status;
			const usage = item.usage?.entries ? t.fg("muted", ` · ${formatUsageSummary(item.usage)}`) : "";
			lines.push(truncateToWidth(`      ${t.fg(statusColor(iStatus), statusIcon(iStatus))} ${item.label || item.itemId}${usage}${item.lastMessage ? t.fg("dim", ` — ${item.lastMessage}`) : ""}`, width));
		}
		if ((phase.fanout.items || []).length > MAX_DETAIL_PHASE_ITEMS) lines.push(t.fg("dim", `      … ${phase.fanout.items.length - MAX_DETAIL_PHASE_ITEMS} more item(s)`));
	}

	private renderArtifact(width: number, runs: RunSummary[]): string[] {
		const t = this.theme;
		const run = runs[this.selected];
		const artifact: ArtifactSummary | undefined = run?.artifacts?.[this.selectedArtifact];
		if (!run || !artifact) {
			this.mode = "detail";
			return this.renderDetail(width, runs);
		}
		const all: string[] = [];
		all.push(t.fg("dim", "← back • ↑↓ scroll • q close"));
		all.push(`${t.fg("success", "◉")} ${t.fg("accent", t.bold(artifactTitle(artifact)))}`);
		const target = artifactTarget(artifact);
		if (target) all.push(t.fg("dim", target));
		all.push(t.fg("borderMuted", "─".repeat(Math.max(0, width))));
		try {
			const result = readArtifactContent(artifact, { maxBytes: MAX_ARTIFACT_BYTES });
			if (!result?.content) all.push(t.fg("dim", "No readable artifact content."));
			else {
				const rendered = isMarkdownArtifact(artifact)
					? new Markdown(result.content, 0, 0, getMarkdownTheme()).render(width)
					: result.content.split(/\r?\n/);
				all.push(...rendered);
				if (result.truncated) all.push(t.fg("warning", "[artifact truncated]"));
			}
		} catch (error: any) {
			all.push(t.fg("error", `Could not read artifact: ${error?.message || error}`));
		}
		return this.windowLines(all, width, 24);
	}

	private windowLines(lines: string[], width: number, bodyHeight: number, selectedLine?: number): string[] {
		if (typeof selectedLine === "number") {
			if (selectedLine < this.scroll) this.scroll = selectedLine;
			if (selectedLine >= this.scroll + bodyHeight) this.scroll = selectedLine - bodyHeight + 1;
		}
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
		const sessionId = ctx.sessionManager.getSessionId();
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const component = new ThreadPhaseMonitorComponent(cwd, sessionId, theme, () => done(), (run) => {
				if (!run?.runId || run.normalizedStatus !== STATUSES.RUNNING) {
					ctx.ui.notify("Selected workflow is not currently cancellable.", "warning");
					return;
				}
				try {
					requestCancellation(run.runId, { reason: "cancelled from thread-phase monitor" });
					ctx.ui.notify(`Cancellation requested for ${run.workflow || "workflow"}`, "warning");
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
