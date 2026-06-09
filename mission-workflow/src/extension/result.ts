import { spawn } from "node:child_process";
import type { ScriptResult } from "./types.ts";

export const MAX_TOOL_TEXT = 30_000;

export function truncate(text: string, max = MAX_TOOL_TEXT): string {
	if (Buffer.byteLength(text, "utf8") <= max) return text;
	let out = text.slice(0, max);
	while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, -1);
	return `${out}\n\n[Tool output truncated. Full run is available through thread_phase_runs.]`;
}

export function runScript(scriptPath: string, args: string[], cwd: string, signal?: AbortSignal): Promise<ScriptResult> {
	return new Promise((resolve) => {
		const proc = spawn(process.execPath, [scriptPath, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.stderr.on("data", (d) => (stderr += d.toString()));
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let abort: (() => void) | undefined;
		const cleanup = () => {
			if (killTimer) clearTimeout(killTimer);
			if (signal && abort) signal.removeEventListener("abort", abort);
		};
		proc.on("error", (error) => {
			cleanup();
			resolve({ code: 1, stdout, stderr: error.message });
		});
		proc.on("close", (code) => {
			cleanup();
			resolve({ code: code ?? 0, stdout, stderr });
		});
		if (signal) {
			abort = () => {
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
				killTimer.unref();
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

export function parseJsonObject(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return undefined;
	return JSON.parse(trimmed);
}

export function compactDetails(details: unknown): unknown {
	if (!details || typeof details !== "object") return details;
	const out = { ...(details as Record<string, any>) };
	if (out.plan && typeof out.plan === "object") out.plan = { missionId: out.plan.missionId, goal: out.plan.goal, planPath: out.planPath, milestoneCount: Array.isArray(out.plan.milestones) ? out.plan.milestones.length : undefined };
	if (out.env && typeof out.env === "object") out.env = { missionBranch: out.env.missionBranch, integrationPath: out.env.integrationPath, repoRoot: out.env.repoRoot };
	delete out.missionState;
	return out;
}
