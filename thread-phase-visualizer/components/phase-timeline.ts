import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { STATUSES, formatUsageSummary } from "../lib/store.mjs";

type RunSummary = Record<string, any>;
type PhaseSummary = Record<string, any>;

export function statusIcon(status: string | undefined): string {
	if (status === STATUSES.FAILED) return "✗";
	if (status === STATUSES.CANCELLED) return "⊘";
	if (status === STATUSES.RUNNING) return "…";
	if (status === STATUSES.SKIPPED) return "↷";
	if (status === STATUSES.UNKNOWN) return "?";
	return "✓";
}

export function statusColor(status: string | undefined): "success" | "error" | "warning" | "muted" | "dim" {
	if (status === STATUSES.FAILED) return "error";
	if (status === STATUSES.CANCELLED || status === STATUSES.SKIPPED || status === STATUSES.UNKNOWN) return "warning";
	if (status === STATUSES.RUNNING) return "muted";
	return "success";
}

export function formatProgress(progress: any): string {
	if (!progress || typeof progress !== "object") return "";
	const current = progress.current;
	const total = progress.total;
	if (typeof current === "number" && typeof total === "number") return ` ${current}/${total}`;
	if (typeof progress.percent === "number") return ` ${Math.round(progress.percent * 100)}%`;
	return "";
}

export function formatFanout(fanout: any): string {
	if (!fanout || typeof fanout !== "object") return "";
	const total = typeof fanout.total === "number" ? fanout.total : fanout.items?.length;
	const completed = fanout.completed ?? 0;
	const failed = fanout.failed ?? 0;
	const running = fanout.running ?? 0;
	let text = ` ${completed}/${total ?? "?"}`;
	if (failed > 0) text += `, ${failed} failed`;
	else if (running > 0) text += `, ${running} running`;
	return text;
}

export function renderPhaseTimeline(run: RunSummary, theme: Theme, expanded: boolean) {
	const phases: PhaseSummary[] = run.phases || [];
	const container = new Container();
	if (phases.length === 0) {
		container.addChild(new Text(theme.fg("dim", "No phases recorded"), 0, 0));
		return container;
	}

	const visible = expanded ? phases : phases.slice(0, 6);
	for (const phase of visible) {
		const normalized = phase.normalizedStatus || phase.status;
		const icon = theme.fg(statusColor(normalized), statusIcon(normalized));
		const name = theme.fg("accent", phase.phase || "phase");
		const progress = theme.fg("muted", phase.fanout ? formatFanout(phase.fanout) : formatProgress(phase.progress));
		const usage = expanded && phase.usage ? theme.fg("muted", ` · ${formatUsageSummary(phase.usage)}`) : "";
		const message = expanded && phase.lastMessage ? theme.fg("dim", ` — ${phase.lastMessage}`) : "";
		container.addChild(new Text(`${icon} ${name}${progress}${usage}${message}`, 0, 0));
		if (expanded && phase.fanout?.items?.length) {
			for (const item of phase.fanout.items.slice(0, 20)) {
				const itemStatus = item.normalizedStatus || item.status;
				container.addChild(new Text(`  ${theme.fg(statusColor(itemStatus), statusIcon(itemStatus))} ${theme.fg("muted", item.label || item.itemId)}${item.lastMessage ? theme.fg("dim", ` — ${item.lastMessage}`) : ""}`, 0, 0));
			}
			if (phase.fanout.items.length > 20) container.addChild(new Text(theme.fg("dim", `  … ${phase.fanout.items.length - 20} more item(s)`), 0, 0));
		}
	}
	if (!expanded && phases.length > visible.length) {
		container.addChild(new Text(theme.fg("dim", `… ${phases.length - visible.length} more phase(s)`), 0, 0));
	}
	return container;
}

export function phaseSummaryText(run: RunSummary): string {
	const phases: PhaseSummary[] = run.phases || [];
	if (phases.length === 0) return "0 phases";
	const failed = phases.filter((p) => p.normalizedStatus === STATUSES.FAILED).length;
	const running = phases.filter((p) => p.normalizedStatus === STATUSES.RUNNING).length;
	const fanoutItems = phases.reduce((sum, p) => sum + (p.fanout?.total || 0), 0);
	const fanoutPart = fanoutItems > 0 ? `, ${fanoutItems} fanout item${fanoutItems === 1 ? "" : "s"}` : "";
	if (failed > 0) return `${phases.length} phases, ${failed} failed${fanoutPart}`;
	if (running > 0) return `${phases.length} phases, ${running} running${fanoutPart}`;
	return `${phases.length} phase${phases.length === 1 ? "" : "s"}${fanoutPart}`;
}
