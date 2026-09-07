import { STATUSES } from "../lib/store.mjs";

type RunSummary = Record<string, any>;

export const WORKFLOW_SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
export const WORKFLOW_SPINNER_INTERVAL_MS = 120;

export function isLiveRun(run: RunSummary | undefined): boolean {
	return Boolean(run?.normalizedStatus === STATUSES.RUNNING && !run.stale);
}

/** Render one high-contrast glyph for each cached workflow animation state. */
export function workflowFooterText(frameIndices: readonly number[]): string | undefined {
	if (frameIndices.length === 0) return undefined;
	return frameIndices
		.map((frameIndex) => WORKFLOW_SPINNER_FRAMES[Math.abs(Math.floor(frameIndex)) % WORKFLOW_SPINNER_FRAMES.length])
		.join(" ");
}

type WorkflowFooterAnimatorOptions = {
	setStatus: (text: string | undefined) => void;
	clearWidget: () => void;
	intervalMs?: number;
};

type AnimatedWorkflow = {
	id: string;
	frameIndex: number;
};

/** Animate cached workflow identities without performing store or liveness reads. */
export function createWorkflowFooterAnimator(options: WorkflowFooterAnimatorOptions) {
	let workflows: AnimatedWorkflow[] = [];
	let nextStaggerOffset = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let disposed = false;
	let failed = false;

	const stopTimer = () => {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	};
	const clearUi = () => {
		try { options.setStatus(undefined); } catch { /* best-effort fail-closed cleanup */ }
		try { options.clearWidget(); } catch { /* best-effort fail-closed cleanup */ }
	};
	const failClosed = () => {
		failed = true;
		workflows = [];
		stopTimer();
		clearUi();
	};
	const render = () => {
		if (disposed || failed || workflows.length === 0) return;
		try {
			options.setStatus(workflowFooterText(workflows.map(({ frameIndex }) => frameIndex)));
		} catch {
			failClosed();
		}
	};

	// Remove the legacy below-editor widget immediately on startup/reload.
	try {
		options.clearWidget();
		options.setStatus(undefined);
	} catch {
		failClosed();
	}

	return {
		setWorkflowIds(nextWorkflowIds: readonly string[]) {
			if (disposed || failed) return;

			const incomingIds: string[] = [];
			const incoming = new Set<string>();
			for (const id of nextWorkflowIds) {
				if (typeof id !== "string" || id.length === 0 || incoming.has(id)) continue;
				incoming.add(id);
				incomingIds.push(id);
			}

			// Input summaries are recency-ordered and may reshuffle on every refresh.
			// Keep surviving identities in their established order, then append new IDs.
			const next = workflows.filter(({ id }) => incoming.has(id));
			const retained = new Set(next.map(({ id }) => id));
			for (const id of incomingIds) {
				if (retained.has(id)) continue;
				next.push({ id, frameIndex: nextStaggerOffset % WORKFLOW_SPINNER_FRAMES.length });
				nextStaggerOffset++;
			}

			const wasActive = workflows.length > 0;
			workflows = next;
			if (workflows.length === 0) {
				stopTimer();
				if (wasActive) {
					try { options.setStatus(undefined); } catch { failClosed(); }
				}
				return;
			}

			render();
			if (timer || failed) return;
			timer = setInterval(() => {
				for (const workflow of workflows) {
					workflow.frameIndex = (workflow.frameIndex + 1) % WORKFLOW_SPINNER_FRAMES.length;
				}
				render();
			}, options.intervalMs ?? WORKFLOW_SPINNER_INTERVAL_MS);
			timer.unref?.();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			workflows = [];
			stopTimer();
			clearUi();
		},
	};
}
