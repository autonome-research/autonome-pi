import { STATUSES } from "../lib/store.mjs";
import { formatOwnerMetadata } from "../lib/run-display.mjs";

type RunSummary = Record<string, any>;

function latestActivePhase(run: RunSummary): Record<string, any> | undefined {
	const phases: Record<string, any>[] = run.phases || [];
	return [...phases].reverse().find((phase) => phase.normalizedStatus === STATUSES.RUNNING) || phases[phases.length - 1];
}

function progressText(phase: Record<string, any> | undefined): string {
	const progress = phase?.progress;
	if (!progress) return "";
	if (typeof progress.current === "number" && typeof progress.total === "number") return ` ${progress.current}/${progress.total}`;
	if (typeof progress.percent === "number") return ` ${Math.round(progress.percent * 100)}%`;
	return "";
}

export function isLiveRun(run: RunSummary | undefined): boolean {
	return Boolean(run?.normalizedStatus === STATUSES.RUNNING && !run.stale);
}

export function activeRunWidgetLines(runs: RunSummary[], options: { maxRuns?: number } = {}): string[] {
	const active = runs.filter(isLiveRun);
	if (active.length === 0) return [];

	const maxRuns = options.maxRuns ?? 3;
	const lines = ["thread-phase workflows"];
	for (const run of active.slice(0, maxRuns)) {
		const phase = latestActivePhase(run);
		const phasePart = phase?.phase ? `: ${phase.phase}${progressText(phase)}` : "";
		const owner = formatOwnerMetadata(run);
		lines.push(`… ${run.workflow || "workflow"}${phasePart}${owner ? ` · ${owner}` : ""}`);
	}
	if (active.length > maxRuns) lines.push(`… +${active.length - maxRuns} more`);
	return lines;
}
