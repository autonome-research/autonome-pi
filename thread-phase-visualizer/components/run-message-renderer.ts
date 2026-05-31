import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { STATUSES } from "../lib/store.mjs";
import { artifactSummaryText, renderArtifactList } from "./artifact-view.ts";
import { phaseSummaryText, renderPhaseTimeline, statusColor, statusIcon } from "./phase-timeline.ts";

type RunSummary = Record<string, any>;

function shortRunId(runId: string | undefined): string {
	if (!runId) return "unknown";
	const parts = runId.split("-");
	return parts.length > 1 ? parts.slice(-1)[0] : runId.slice(0, 12);
}

function compactRunLine(run: RunSummary, theme: any): string {
	const status = run.normalizedStatus || run.status;
	const icon = theme.fg(statusColor(status), statusIcon(status));
	const workflow = theme.fg("accent", run.workflow || "workflow");
	const statusText = status === STATUSES.RUNNING ? "running" : status === STATUSES.FAILED ? "failed" : "completed";
	const counts = theme.fg("muted", `${phaseSummaryText(run)} · ${artifactSummaryText(run)}`);
	const id = theme.fg("dim", shortRunId(run.runId));
	return `${icon} phased workflow ${statusText}: ${workflow} ${theme.fg("dim", "[")}${id}${theme.fg("dim", "]")} ${counts}`;
}

function runFromMessage(message: any): RunSummary | undefined {
	const details = message.details as any;
	return details?.summary || details?.event || undefined;
}

function renderRunMessage(message: any, expanded: boolean, theme: any) {
	const run = runFromMessage(message);
	if (!run) {
		return new Text(message.content || "thread-phase run", 0, 0);
	}

	const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
	const container = new Container();
	container.addChild(new Text(compactRunLine(run, theme), 0, 0));

	if (!expanded) {
		container.addChild(new Text(theme.fg("dim", keyHint("app.tools.expand", "expand")), 0, 0));
		box.addChild(container);
		return box;
	}

	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", `Run: ${run.runId || "unknown"}`), 0, 0));
	if (run.cwd) container.addChild(new Text(theme.fg("muted", `CWD: ${run.cwd}`), 0, 0));
	if (run.startedAt || run.updatedAt) {
		container.addChild(new Text(theme.fg("dim", `Started: ${run.startedAt || "?"}  Updated: ${run.updatedAt || "?"}`), 0, 0));
	}

	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("toolTitle", theme.bold("Phases")), 0, 0));
	container.addChild(renderPhaseTimeline(run, theme, true));

	if (run.errors?.length) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("error", theme.bold("Errors")), 0, 0));
		for (const error of run.errors) {
			const prefix = error.phase ? `${error.phase}: ` : "";
			container.addChild(new Text(theme.fg("error", `- ${prefix}${error.message || error.error?.message || "error"}`), 0, 0));
		}
	}

	if (run.artifacts?.length) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("toolTitle", theme.bold("Artifacts")), 0, 0));
		container.addChild(renderArtifactList(run, theme, true, { contentMode: "summary" }));
	}

	box.addChild(container);
	return box;
}

export function registerThreadPhaseMessageRenderers(pi: ExtensionAPI) {
	pi.registerMessageRenderer("thread-phase-run", (message, { expanded }, theme) => renderRunMessage(message, expanded, theme));
}
