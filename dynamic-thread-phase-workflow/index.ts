import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(EXT_DIR, "bin", "dynamic-thread-phase-workflow.mjs");
const MAX_TOOL_TEXT = 30_000;

function truncate(text: string, max = MAX_TOOL_TEXT): string {
	if (Buffer.byteLength(text, "utf8") <= max) return text;
	let out = text.slice(0, max);
	while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, -1);
	return `${out}\n\n[Tool output truncated. Full run is available through thread_phase_runs.]`;
}

function runScript(args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn(process.execPath, [SCRIPT, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.stderr.on("data", (d) => (stderr += d.toString()));
		proc.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
		proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
		if (signal) {
			const abort = () => {
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

function writeSpecFile(spec: unknown): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-dynamic-thread-phase-"));
	const file = path.join(dir, "workflow-spec.json");
	writeFileSync(file, JSON.stringify(spec, null, 2), "utf8");
	return file;
}

function addSessionArgs(args: string[], ctx: any): string[] {
	const sessionId = ctx.sessionManager?.getSessionId?.();
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (sessionId) args.push("--session-id", sessionId);
	if (sessionFile) args.push("--session-file", sessionFile);
	return args;
}

function parseJsonObject(stdout: string): any {
	const trimmed = stdout.trim();
	if (!trimmed) return undefined;
	return JSON.parse(trimmed);
}

export default function dynamicThreadPhaseWorkflow(pi: ExtensionAPI) {
	pi.registerTool({
		name: "dynamic_thread_phase_workflow",
		label: "Dynamic Thread-phase Workflow",
		description: "Execute a validated deterministic thread-phase workflow spec constructed live in chat. Emits generic thread-phase visualizer events and artifacts.",
		promptSnippet: "Run a deterministic multi-phase workflow from a JSON spec",
		promptGuidelines: [
			"Use dynamic_thread_phase_workflow when the user wants an ad-hoc deterministic workflow planned in chat and then executed with thread-phase observability.",
			"Build a concrete spec first and declare compact rwx permissions at the workflow or phase level.",
			"Permissions are capabilities, not tool names: r enables read/grep/find/ls, w enables edit/write, and x enables bash/shell execution.",
			"Supported phase types are shell, pi, fanout_pi, and artifact. The runner validates the spec against its configured max permissions policy.",
			"Use background: true for long workflows so normal Pi chat remains usable.",
		],
		parameters: Type.Object({
			spec: Type.Any({ description: "Workflow spec object. Required fields: phases[]. Supported phase types: shell, pi, fanout_pi, artifact." }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the workflow. Defaults to Pi's current cwd or spec.cwd." })),
			model: Type.Optional(Type.String({ description: "Optional default Pi model pattern for pi/fanout_pi phases." })),
			background: Type.Optional(Type.Boolean({ description: "Start the workflow in the background and return immediately." })),
			timeout: Type.Optional(Type.Number({ description: "Default phase timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = path.resolve(ctx.cwd, params.cwd || params.spec?.cwd || ".");
			const specFile = writeSpecFile(params.spec);
			const args = ["--spec-file", specFile, "--cwd", cwd];
			if (params.model) args.push("--model", params.model);
			if (params.timeout !== undefined) args.push("--timeout", String(params.timeout));
			if (params.background) args.push("--background");
			addSessionArgs(args, ctx);
			onUpdate?.({ content: [{ type: "text", text: `Starting dynamic thread-phase workflow in ${cwd}...` }] });
			const result = await runScript(args, cwd, signal);
			if (result.code !== 0 && !params.background) throw new Error(result.stderr || result.stdout || `dynamic_thread_phase_workflow exited ${result.code}`);
			let details: any;
			try { details = parseJsonObject(result.stdout); } catch { details = { stdout: result.stdout, stderr: result.stderr }; }
			const text = details?.background
				? `Started dynamic thread-phase workflow in background (pid ${details.pid}). Open ctrl+shift+t to monitor it.`
				: result.stdout || "Dynamic thread-phase workflow started.";
			return { content: [{ type: "text", text: truncate(text) }], details };
		},
	});
}
