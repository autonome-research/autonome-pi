import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, Spacer, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { renderArtifactList } from "./artifact-view.ts";
import { renderPhaseTimeline, statusColor, statusIcon } from "./phase-timeline.ts";

type RunSummary = Record<string, any>;

const VIEW_LINES = 34;

class RunDetailComponent {
	private offset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private run: RunSummary, private theme: any, private onClose: () => void) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, "b") || matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") this.scroll(1);
		else if (matchesKey(data, Key.up) || data === "k") this.scroll(-1);
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, "ctrl+f")) this.scroll(VIEW_LINES - 3);
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, "ctrl+b")) this.scroll(-(VIEW_LINES - 3));
	}

	render(width: number): string[] {
		if (!this.cachedLines || this.cachedWidth !== width) {
			this.cachedWidth = width;
			this.cachedLines = this.buildLines(width);
			this.offset = Math.min(this.offset, Math.max(0, this.cachedLines.length - VIEW_LINES));
		}
		const total = this.cachedLines.length;
		const visible = this.cachedLines.slice(this.offset, this.offset + VIEW_LINES);
		const footer = this.theme.fg("dim", `↑↓/jk scroll • q/esc close • ${Math.min(total, this.offset + VIEW_LINES)}/${total}`);
		return [...visible, truncateToWidth(footer, width)];
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private scroll(delta: number): void {
		const total = this.cachedLines?.length || 0;
		this.offset = Math.max(0, Math.min(Math.max(0, total - VIEW_LINES), this.offset + delta));
	}

	private buildLines(width: number): string[] {
		const t = this.theme;
		const run = this.run;
		const status = run.normalizedStatus || run.status;
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => t.fg(statusColor(status), s)));
		container.addChild(new Text(`${t.fg(statusColor(status), statusIcon(status))} ${t.fg("accent", t.bold(run.workflow || "workflow"))} ${t.fg("muted", run.status || status || "")}`, 1, 0));
		container.addChild(new Text(t.fg("dim", `Run: ${run.runId || "unknown"}`), 1, 0));
		if (run.cwd) container.addChild(new Text(t.fg("dim", `CWD: ${run.cwd}`), 1, 0));
		if (run.startedAt || run.updatedAt) container.addChild(new Text(t.fg("dim", `Started: ${run.startedAt || "?"}  Updated: ${run.updatedAt || "?"}`), 1, 0));

		container.addChild(new Spacer(1));
		container.addChild(new Text(t.fg("toolTitle", t.bold("Phases")), 1, 0));
		container.addChild(renderPhaseTimeline(run, t, true));

		if (run.errors?.length) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(t.fg("error", t.bold("Errors")), 1, 0));
			for (const error of run.errors) {
				const prefix = error.phase ? `${error.phase}: ` : "";
				container.addChild(new Text(t.fg("error", `- ${prefix}${error.message || error.error?.message || "error"}`), 1, 0));
			}
		}

		if (run.artifacts?.length) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(t.fg("toolTitle", t.bold("Artifacts")), 1, 0));
			container.addChild(renderArtifactList(run, t, true));
		}

		container.addChild(new DynamicBorder((s: string) => t.fg(statusColor(status), s)));
		return container.render(width).map((line) => truncateToWidth(line, width));
	}
}

export async function showRunDetailOverlay(ctx: ExtensionCommandContext, run: RunSummary): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Run detail overlay requires interactive mode", "warning");
		return;
	}
	await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => new RunDetailComponent(run, theme, () => done()), {
		overlay: true,
		overlayOptions: { width: "85%", maxHeight: "85%", anchor: "center", margin: 1 },
	});
}
