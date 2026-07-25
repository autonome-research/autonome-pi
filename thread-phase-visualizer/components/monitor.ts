import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { STATUSES, latestRunSummaries, readArtifactContent, requestCancellation } from "../lib/store.mjs";
import { artifactEditorActionHint, artifactEditorTarget } from "../lib/artifact-action.mjs";
import { MONITOR_SORTS, MONITOR_STATUS_FILTERS, cycleMonitorOption, filterAndSortMonitorRuns } from "../lib/monitor-state.mjs";
import { FANOUT_PAGE_SIZE, detailViewportHeight, pageItems, windowLineRange } from "../lib/monitor-pagination.mjs";
import { formatElapsedDuration, formatOwnerMetadata, formatStaleIndicator, formatTotalTokens } from "../lib/run-display.mjs";
import { canInspectRun, mergeMonitorRuns } from "../lib/session-scope.mjs";
import { framePanel } from "./bordered-panel.ts";
import { formatFanout, formatProgress, statusColor, statusIcon } from "./phase-timeline.ts";

type RunSummary = Record<string, any>;
type PhaseSummary = Record<string, any>;
type ArtifactSummary = Record<string, any>;
type Mode = "list" | "detail" | "artifact";
type DetailItem = { kind: "phase"; index: number; phase: PhaseSummary } | { kind: "artifact"; index: number; artifact: ArtifactSummary };
type DetailLineRange = { start: number; end: number };

const MAX_VISIBLE_RUNS = 12;
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
	const running = phases.filter((phase) => phase.normalizedStatus === STATUSES.RUNNING).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
	const visible = running.length ? running.slice(0, 10) : phases.slice(-10);
	const prefix = phases.length > visible.length ? theme.fg("dim", `… ${phases.length - visible.length} older ─ `) : "";
	return prefix + visible.map((phase) => `${phaseGlyph(phase, theme)} ${phase.phase || "phase"}`).join(theme.fg("dim", " ─ "));
}

function currentPhaseText(run: RunSummary): string {
	const phases: PhaseSummary[] = run.phases || [];
	const phase = [...phases].reverse().find((p) => p.normalizedStatus === STATUSES.RUNNING) || phases[phases.length - 1];
	if (!phase) return "";
	const progress = phase.fanout ? formatFanout(phase.fanout) : formatProgress(phase.progress);
	const inference = inferenceLabel(phase);
	const io = run.activeIo?.component || run.activeIo?.role || run.activeIo?.command;
	return `${phase.phase || "phase"}${progress}${inference ? ` · ${inference}` : ""}${io ? ` · io:${String(io).slice(0, 32)}` : ""}`;
}

function inferenceLabel(value: Record<string, any>): string {
	const models = value?.usage?.models && typeof value.usage.models === "object" ? Object.keys(value.usage.models).filter(Boolean) : [];
	if (models.length === 1) return models[0];
	if (models.length > 1) return `${models[0]} +${models.length - 1}`;
	if (value?.model) return String(value.model);
	return value?.type === "shell" || value?.type === "artifact" ? value.type : "";
}

function cwdLabel(cwd: string | undefined): string {
	if (!cwd) return "unknown cwd";
	return basename(cwd) || cwd;
}

function elapsedForRun(run: RunSummary, now = Date.now()): string {
	const status = run.normalizedStatus || run.status;
	const end = status === STATUSES.RUNNING && !run.stale ? now : run.endedAt || run.updatedAt;
	return formatElapsedDuration(run.startedAt, end);
}

function elapsedForPhase(phase: PhaseSummary, now = Date.now()): string {
	const status = phase.normalizedStatus || phase.status;
	const end = status === STATUSES.RUNNING ? now : phase.endedAt || phase.updatedAt;
	return formatElapsedDuration(phase.startedAt, end);
}

function monitorRuns(cwd: string, sessionId?: string): RunSummary[] {
	const runs = latestRunSummaries({
		limit: 150,
		readLimit: 8000,
		ownershipFilter: (run: RunSummary) => canInspectRun(run, sessionId, cwd, STATUSES.RUNNING),
	});
	return mergeMonitorRuns(runs, cwd, sessionId, STATUSES.RUNNING);
}

function highlightMatch(value: string, query: string, theme: any): string {
	if (!query) return value;
	const lowerValue = value.toLocaleLowerCase();
	const lowerQuery = query.toLocaleLowerCase();
	if (!lowerQuery || !lowerValue.includes(lowerQuery)) return value;
	const parts: string[] = [];
	let cursor = 0;
	while (cursor < value.length) {
		const index = lowerValue.indexOf(lowerQuery, cursor);
		if (index < 0) {
			parts.push(value.slice(cursor));
			break;
		}
		parts.push(value.slice(cursor, index), theme.fg("accent", theme.bold(value.slice(index, index + query.length))));
		cursor = index + query.length;
	}
	return parts.join("");
}

function runtimePid(run: RunSummary): number | undefined {
	const pid = run.metadata?.pid;
	return typeof pid === "number" ? pid : undefined;
}

function isRunningCancellable(run: RunSummary | undefined): boolean {
	return Boolean(run?.normalizedStatus === STATUSES.RUNNING && !run?.stale && run?.runId);
}

function artifactTitle(artifact: ArtifactSummary | undefined): string {
	return artifact?.title || artifact?.kind || "artifact";
}

function artifactTarget(artifact: ArtifactSummary | undefined): string {
	return artifact?.path || artifact?.url || artifact?.preview || (artifact?.content ? "(inline)" : "");
}

function compactJson(value: any): string {
	try { return JSON.stringify(value); }
	catch { return String(value); }
}

function sanitizeIoText(value: any): string {
	return String(value || "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "�");
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

export class ThreadPhaseMonitorComponent {
	private cwd: string;
	private sessionId: string | undefined;
	private theme: any;
	private onClose: () => void;
	private onCancelRun: (run: RunSummary) => void;
	private onSendArtifactTarget: (target: string) => void;
	private loadRuns: (cwd: string, sessionId?: string) => RunSummary[];
	private mode: Mode = "list";
	private selected = 0;
	private selectedRunId?: string;
	private selectedDetail = 0;
	private expandedPhase?: number;
	private fanoutPage = 0;
	private anchorExpandedFanout = false;
	private selectedArtifact = 0;
	private scroll = 0;
	private viewportHeight = 24;
	private searchMode = false;
	private searchQuery = "";
	private statusFilter = "all";
	private hideStale = false;
	private sortMode = "status";
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		cwd: string,
		sessionId: string | undefined,
		theme: any,
		onClose: () => void,
		onCancelRun: (run: RunSummary) => void,
		onSendArtifactTarget: (target: string) => void,
		loadRuns: (cwd: string, sessionId?: string) => RunSummary[] = monitorRuns,
	) {
		this.cwd = cwd;
		this.sessionId = sessionId;
		this.theme = theme;
		this.onClose = onClose;
		this.onCancelRun = onCancelRun;
		this.onSendArtifactTarget = onSendArtifactTarget;
		this.loadRuns = loadRuns;
	}

	handleInput(data: string): void {
		if (this.searchMode) {
			if (matchesKey(data, Key.escape)) this.clearFilters();
			else if (matchesKey(data, Key.enter)) this.searchMode = false;
			else if (data === "\x7f" || data === "\b") this.setSearchQuery(this.searchQuery.slice(0, -1));
			else if (data.length === 1 && data >= " " && data !== "\x7f") this.setSearchQuery(this.searchQuery + data);
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.backOrClose();
			return;
		}
		if (matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}
		if (data === "/") {
			this.mode = "list";
			this.searchMode = true;
			this.resetListSelection();
			return;
		}
		if (this.mode === "list" && data === "f") {
			this.statusFilter = cycleMonitorOption(this.statusFilter, MONITOR_STATUS_FILTERS);
			this.resetListSelection();
			return;
		}
		if (this.mode === "list" && data === "h") {
			this.hideStale = !this.hideStale;
			this.resetListSelection();
			return;
		}
		if (this.mode === "list" && data === "s") {
			this.sortMode = cycleMonitorOption(this.sortMode, MONITOR_SORTS);
			this.selectedDetail = 0;
			this.scroll = 0;
			this.invalidate();
			return;
		}

		const runs = this.visibleRuns();
		const run = runs[this.selected];
		const items = detailItems(run);

		if (matchesKey(data, "b") || matchesKey(data, Key.left)) {
			this.backOrClose();
			return;
		}

		if (data === "x") {
			if (isRunningCancellable(run)) this.onCancelRun(run);
			this.invalidate();
			return;
		}

		if (this.mode === "artifact" && data === "c") {
			const target = artifactEditorTarget(run?.artifacts?.[this.selectedArtifact]);
			if (target) this.onSendArtifactTarget(target);
			return;
		}

		if (matchesKey(data, Key.ctrl("d"))) {
			this.movePage(1, run, items);
			return;
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.movePage(-1, run, items);
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") this.move(1, run, items);
		else if (matchesKey(data, Key.up) || data === "k") this.move(-1, run, items);
		else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) this.enter(run, items);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const runs = this.visibleRuns();
		this.selected = Math.max(0, Math.min(this.selected, Math.max(0, runs.length - 1)));
		const innerWidth = Math.max(1, width - 4);
		this.viewportHeight = detailViewportHeight(innerWidth);
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

	private visibleRuns(): RunSummary[] {
		const runs = filterAndSortMonitorRuns(this.loadRuns(this.cwd, this.sessionId), {
			query: this.searchQuery,
			status: this.statusFilter,
			sort: this.sortMode,
			hideStale: this.hideStale,
		});
		const selectedIndex = this.selectedRunId
			? runs.findIndex((run) => String(run?.runId || "") === this.selectedRunId)
			: -1;
		if (selectedIndex >= 0) this.selected = selectedIndex;
		else {
			// A detail or artifact view belongs to one run. If that run vanishes on
			// reload, return to the list rather than displaying the same index from
			// a different run as though it were the original selection.
			if (this.selectedRunId && this.mode !== "list") {
				this.mode = "list";
				this.selectedDetail = 0;
				this.expandedPhase = undefined;
				this.fanoutPage = 0;
				this.anchorExpandedFanout = false;
				this.selectedArtifact = 0;
				this.scroll = 0;
			}
			this.selected = Math.max(0, Math.min(this.selected, Math.max(0, runs.length - 1)));
			this.selectedRunId = runs[this.selected]?.runId ? String(runs[this.selected].runId) : undefined;
		}
		return runs;
	}

	private hasFilters(): boolean {
		return Boolean(this.searchQuery || this.statusFilter !== "all" || this.hideStale);
	}

	private setSearchQuery(query: string): void {
		this.searchQuery = query;
		this.resetListSelection();
	}

	private clearFilters(): void {
		this.mode = "list";
		this.searchMode = false;
		this.searchQuery = "";
		this.statusFilter = "all";
		this.hideStale = false;
		this.resetListSelection();
	}

	private backOrClose(): void {
		if (this.hasFilters()) {
			this.clearFilters();
			return;
		}
		if (this.mode === "artifact") this.mode = "detail";
		else if (this.mode === "detail") this.mode = "list";
		else {
			this.onClose();
			return;
		}
		this.scroll = 0;
		this.invalidate();
	}

	private resetListSelection(): void {
		this.selected = 0;
		this.selectedRunId = undefined;
		this.selectedDetail = 0;
		this.scroll = 0;
		this.invalidate();
	}

	private move(delta: number, run?: RunSummary, items: DetailItem[] = []): void {
		if (this.mode === "list") {
			const runs = this.visibleRuns();
			this.selected = Math.max(0, Math.min(this.selected + delta, Math.max(0, runs.length - 1)));
			this.selectedRunId = runs[this.selected]?.runId ? String(runs[this.selected].runId) : undefined;
			this.selectedDetail = 0;
		} else if (this.mode === "detail") {
			this.selectedDetail = Math.max(0, Math.min(this.selectedDetail + delta, Math.max(0, items.length - 1)));
			this.anchorExpandedFanout = false;
		} else {
			this.scroll = Math.max(0, this.scroll + delta);
		}
		this.invalidate();
	}

	private movePage(delta: number, run?: RunSummary, items: DetailItem[] = []): void {
		if (this.mode === "artifact") {
			this.scroll = Math.max(0, this.scroll + delta * Math.max(1, this.viewportHeight - 1));
		} else if (this.mode === "detail") {
			const selected = items[this.selectedDetail];
			if (selected?.kind === "phase" && this.expandedPhase === selected.index && (selected.phase.fanout?.items || []).length > FANOUT_PAGE_SIZE) {
				const page = pageItems(selected.phase.fanout.items, this.fanoutPage + delta, FANOUT_PAGE_SIZE);
				this.fanoutPage = page.page;
				this.anchorExpandedFanout = true;
			} else {
				const itemStep = Math.max(1, Math.floor(this.viewportHeight / 2));
				this.selectedDetail = Math.max(0, Math.min(this.selectedDetail + delta * itemStep, Math.max(0, items.length - 1)));
				this.anchorExpandedFanout = false;
			}
		} else {
			const runs = this.visibleRuns();
			this.selected = Math.max(0, Math.min(this.selected + delta * MAX_VISIBLE_RUNS, Math.max(0, runs.length - 1)));
			this.selectedRunId = runs[this.selected]?.runId ? String(runs[this.selected].runId) : undefined;
		}
		this.invalidate();
	}

	private enter(run?: RunSummary, items: DetailItem[] = []): void {
		if (this.mode === "list") {
			this.mode = "detail";
			this.scroll = 0;
		} else if (this.mode === "detail") {
			const item = items[this.selectedDetail];
			if (item?.kind === "phase") {
				const expanding = this.expandedPhase !== item.index;
				this.expandedPhase = expanding ? item.index : undefined;
				if (expanding) this.fanoutPage = 0;
				this.anchorExpandedFanout = Boolean(expanding && item.phase.fanout);
			}
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
		lines.push(truncateToWidth(t.fg("accent", t.bold("Thread-phase monitor")) + t.fg("dim", `  ↑↓ select • enter details${cancelHint} • / search • f status • h stale • s sort • q close`), width));
		const searchPrompt = this.searchMode ? `${this.searchQuery}▌` : this.searchQuery || "(none)";
		lines.push(truncateToWidth(t.fg("toolTitle", "Filter: ") + t.fg(this.searchMode ? "accent" : "muted", searchPrompt) + t.fg("dim", `  status:${this.statusFilter}  stale:${this.hideStale ? "hidden" : "shown"}  sort:${this.sortMode}${this.hasFilters() ? "  • esc/b clear" : ""}`), width));
		lines.push(truncateToWidth(t.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
		if (runs.length === 0) {
			const message = this.hasFilters() ? "No runs match filter." : "No runs for this working directory.";
			lines.push(truncateToWidth(t.fg("dim", message), width));
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
			const stale = formatStaleIndicator(run);
			const live = stale ? t.fg("warning", ` ${stale}`) : status === STATUSES.RUNNING ? t.fg("accent", " LIVE") : "";
			const workflow = highlightMatch(run.workflow || "workflow", this.searchQuery, t);
			const runId = this.searchQuery ? String(run.runId || "unknown") : shortRunId(run.runId);
			const statusLabel = this.searchQuery ? ` ${highlightMatch(String(status || "unknown"), this.searchQuery, t)}` : "";
			const head = `${prefix} ${workflowGlyph(stale ? STATUSES.UNKNOWN : status, t)} ${selected ? t.fg("accent", workflow) : workflow}${live}${statusLabel} ${t.fg("dim", `[${highlightMatch(runId, this.searchQuery, t)}]`)}`;
			const current = status === STATUSES.RUNNING ? currentPhaseText(run) : "";
			const cwd = this.searchQuery ? String(run.cwd || "") : cwdLabel(run.cwd);
			const location = run.cwd ? t.fg("dim", ` @ ${highlightMatch(cwd, this.searchQuery, t)}`) : "";
			const metrics = [elapsedForRun(run), formatTotalTokens(run.usage)].filter((value) => value && value !== "?").join(" · ");
			lines.push(truncateToWidth(`${head}${location}${metrics ? t.fg("muted", ` · ${metrics}`) : ""}${current ? t.fg("muted", ` — ${current}`) : ""}`, width));
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
		let fanoutVisibleRange: DetailLineRange | undefined;
		const add = (line: string, selectable = false) => {
			if (selectable && itemCursor === this.selectedDetail) selectedLine = lines.length;
			lines.push(line);
			if (selectable) itemCursor++;
		};

		const cancelHint = isRunningCancellable(run) ? " • x cancel" : "";
		add(t.fg("dim", `← back • ↑↓ select • ctrl+u/d page • enter ${selectedItem?.kind === "artifact" ? "open" : "expand"}${cancelHint} • q close`));
		add(t.fg("accent", t.bold(`${workflowGlyph(status, t)} ${run.workflow || "workflow"}`)) + t.fg("dim", ` [${run.runId || "unknown"}]`));
		const pid = runtimePid(run);
		add(t.fg("dim", `status: ${run.status || status}${run.stale ? `  ${formatStaleIndicator(run)}` : ""}  duration: ${elapsedForRun(run)}${pid && status === STATUSES.RUNNING ? `  pid: ${pid}` : ""}`));
		const owner = formatOwnerMetadata(run);
		if (owner) add(t.fg("dim", owner));
		if (run.heartbeat?.timestamp) add(t.fg("dim", `heartbeat: ${run.heartbeat.timestamp}${run.heartbeat.featureId ? `  feature: ${run.heartbeat.featureId}` : ""}`));
		const runTokens = formatTotalTokens(run.usage);
		if (runTokens) add(t.fg("muted", `tokens: ${runTokens}`));
		this.addActiveIo(lines, run.activeIo, width, "active I/O");
		add("");
		add(t.fg("toolTitle", t.bold("Phases")) + t.fg("dim", ` (${(run.phases || []).length})`));
		if (!(run.phases || []).length) add(t.fg("dim", "No phases recorded."));
		for (const phase of run.phases || []) {
			const pStatus = phase.normalizedStatus || phase.status;
			const progress = phase.fanout ? formatFanout(phase.fanout) : formatProgress(phase.progress);
			const selected = itemCursor === this.selectedDetail;
			const prefix = selected ? t.fg("accent", "›") : " ";
			const inference = inferenceLabel(phase);
			add(`${prefix} ${t.fg(statusColor(pStatus), phaseStatusGlyph(pStatus))} ${selected ? t.fg("accent", phase.phase || "phase") : phase.phase || "phase"}${t.fg("muted", progress)}${inference ? t.fg("dim", ` — ${inference}`) : ""}`, true);
			if (this.expandedPhase === itemCursor - 1) fanoutVisibleRange = this.addPhaseDetails(lines, phase, width);
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
		const visibleRange = this.anchorExpandedFanout ? fanoutVisibleRange : undefined;
		return this.windowLines(lines, width, this.viewportHeight, visibleRange ? undefined : selectedLine, visibleRange);
	}

	private addPhaseDetails(lines: string[], phase: PhaseSummary, width: number): DetailLineRange | undefined {
		const t = this.theme;
		if (phase.startedAt) lines.push(t.fg("dim", `    duration: ${elapsedForPhase(phase)}`));
		if (phase.progress) lines.push(t.fg("muted", `    progress: ${compactJson(phase.progress)}`));
		const phaseTokens = formatTotalTokens(phase.usage);
		if (phaseTokens) lines.push(t.fg("muted", `    tokens: ${phaseTokens}`));
		this.addActiveIo(lines, phase.activeIo, width, "    I/O");
		if (!phase.fanout) return undefined;
		const fanoutSummaryLine = lines.length;
		lines.push(t.fg("muted", `    fanout:${formatFanout(phase.fanout)} ${phase.fanout.label || ""}`));
		const page = pageItems(phase.fanout.items || [], this.fanoutPage, FANOUT_PAGE_SIZE);
		this.fanoutPage = page.page;
		if (page.pageCount > 1) lines.push(t.fg("dim", `      items ${page.start + 1}-${page.end} of ${page.total} • ctrl+u/d page (${page.page + 1}/${page.pageCount})`));
		for (const item of page.items) {
			const iStatus = item.normalizedStatus || item.status;
			const tokens = formatTotalTokens(item.usage);
			const inference = inferenceLabel(item);
			lines.push(truncateToWidth(`      ${t.fg(statusColor(iStatus), statusIcon(iStatus))} ${item.label || item.itemId}${tokens ? t.fg("muted", ` · ${tokens}`) : ""}${inference ? t.fg("dim", ` — ${inference}`) : ""}`, width));
		}
		// Track the complete expanded fanout block rather than one anchor line so
		// expansion, page changes, and responsive re-renders can keep the page
		// heading and every rendered item in view together.
		return { start: fanoutSummaryLine, end: Math.max(fanoutSummaryLine, lines.length - 1) };
	}

	private addActiveIo(lines: string[], io: any, width: number, title = "I/O"): void {
		if (!io) return;
		const t = this.theme;
		const label = io.component || io.role || io.command || io.componentId || "component";
		lines.push(truncateToWidth(t.fg("toolTitle", `${title}: `) + t.fg("accent", `${label}`) + t.fg("dim", `${io.status ? ` ${io.status}` : ""}${io.pid ? ` pid:${io.pid}` : ""}`), width));
		const input = io.inputPreview ? sanitizeIoText(io.inputPreview).split(/\r?\n/).slice(0, 3) : [];
		const output = io.outputPreview || io.stdoutPreview || io.stderrPreview;
		const outputLines = output ? sanitizeIoText(output).split(/\r?\n/).slice(-4) : [];
		for (const line of input) lines.push(truncateToWidth(t.fg("dim", `  in  │ ${line}`), width));
		for (const line of outputLines) lines.push(truncateToWidth(t.fg("muted", `  out │ ${line}`), width));
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
		all.push(t.fg("dim", `← back • ↑↓ line • ctrl+u/d page • ${artifactEditorActionHint(artifact)} • q close`));
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
		return this.windowLines(all, width, this.viewportHeight);
	}

	private windowLines(lines: string[], width: number, bodyHeight: number, selectedLine?: number, visibleRange?: DetailLineRange): string[] {
		let requestedScroll = this.scroll;
		if (visibleRange) {
			const height = Math.max(1, Math.floor(bodyHeight));
			const start = Math.max(0, Math.min(visibleRange.start, Math.max(0, lines.length - 1)));
			const end = Math.max(start, Math.min(visibleRange.end, Math.max(0, lines.length - 1)));
			if (end - start + 1 <= height) {
				if (start < requestedScroll) requestedScroll = start;
				if (end >= requestedScroll + height) requestedScroll = end - height + 1;
			} else {
				// If a future page grows beyond the viewport, prioritize its heading;
				// line navigation can still reach the remaining rows.
				requestedScroll = start;
			}
		}
		const range = windowLineRange(lines.length, bodyHeight, requestedScroll, selectedLine);
		this.scroll = range.start;
		const safeWidth = Math.max(1, Math.floor(width));
		return lines.slice(range.start, range.end).map((line) => truncateToWidth(line, safeWidth));
	}
}

export function createArtifactTargetEditorCallback(ctx: Pick<ExtensionContext, "ui">, done: () => void): (target: string) => void {
	return (target) => {
		ctx.ui.setEditorText(target);
		ctx.ui.notify("Artifact target sent to editor.", "info");
		done();
	};
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
			}, createArtifactTargetEditorCallback(ctx, done));
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
