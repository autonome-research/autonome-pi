import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(EXT_DIR, "bin", "codebase-exploration-workflow.mjs");
const MAX_TOOL_TEXT = 20_000;

type AgentMode = "mock" | "pi";

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
			const abort = () => proc.kill("SIGTERM");
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

function optionAfter(parts: string[], name: string): string | undefined {
	const index = parts.indexOf(name);
	return index >= 0 ? parts[index + 1] : undefined;
}

function buildArgs(params: {
	cwd: string;
	dirs?: string;
	agent?: AgentMode;
	concurrency?: number;
	maxDirs?: number;
	delay?: number;
	model?: string;
	background?: boolean;
}) {
	const args = ["--cwd", params.cwd];
	if (params.dirs) args.push("--dirs", params.dirs);
	if (params.agent) args.push("--agent", params.agent);
	if (params.concurrency !== undefined) args.push("--concurrency", String(params.concurrency));
	if (params.maxDirs !== undefined) args.push("--maxDirs", String(params.maxDirs));
	if (params.delay !== undefined) args.push("--delay", String(params.delay));
	if (params.model) args.push("--model", params.model);
	if (params.background) args.push("--background");
	return args;
}

function commandUsage() {
	return [
		"Usage:",
		"  /codebase-explore --dirs src,tests,docs --concurrency 2",
		"  /codebase-explore --agent mock --dirs src,tests,docs --delay 1000",
		"  /codebase-explore --cwd /repo --maxDirs 8",
		"",
		"Defaults: --agent pi --concurrency 3 --maxDirs 8",
	].join("\n");
}

export default function codebaseExplorationWorkflow(pi: ExtensionAPI) {
	pi.registerTool({
		name: "codebase_exploration_workflow",
		label: "Codebase Exploration Workflow",
		description: "Explore a repository by fanning out read-only agents across predetermined subdirectories and emitting generic thread-phase visualization events.",
		promptSnippet: "Run codebase exploration fanout across project subdirectories",
		promptGuidelines: [
			"Use codebase_exploration_workflow when the user asks to explore or map a codebase with fanout over subdirectories.",
			"codebase_exploration_workflow is read-only and defaults to real Pi subagents. Use agent='mock' only for UI testing.",
		],
		parameters: Type.Object({
			cwd: Type.Optional(Type.String({ description: "Repository/project directory. Defaults to Pi's cwd." })),
			dirs: Type.Optional(Type.String({ description: "Comma-separated subdirectories to explore, e.g. src,tests,docs." })),
			agent: Type.Optional(StringEnum(["mock", "pi"] as const, { default: "pi", description: "pi for real read-only Pi subagents; mock for UI testing." })),
			concurrency: Type.Optional(Type.Number({ description: "Fanout concurrency. Default 3." })),
			maxDirs: Type.Optional(Type.Number({ description: "Max auto-discovered directories. Default 8." })),
			delay: Type.Optional(Type.Number({ description: "Mock-agent delay per item in milliseconds." })),
			model: Type.Optional(Type.String({ description: "Optional Pi model pattern for --agent pi." })),
			background: Type.Optional(Type.Boolean({ description: "Start the workflow in the background and return immediately." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = path.resolve(ctx.cwd, params.cwd || ".");
			onUpdate?.({ content: [{ type: "text", text: `Starting codebase exploration in ${cwd}...` }] });
			const result = await runScript(buildArgs({
				cwd,
				dirs: params.dirs,
				agent: (params.agent || "pi") as AgentMode,
				concurrency: params.concurrency,
				maxDirs: params.maxDirs,
				delay: params.delay,
				model: params.model,
				background: params.background,
			}), cwd, signal);
			if (result.code !== 0 && !params.background) throw new Error(result.stderr || result.stdout || `codebase exploration exited ${result.code}`);
			let details: any;
			try { details = JSON.parse(result.stdout); } catch { details = { stdout: result.stdout, stderr: result.stderr }; }
			return { content: [{ type: "text", text: truncate(result.stdout || "Codebase exploration started.") }], details };
		},
	});

	pi.registerCommand("codebase-explore", {
		description: "Run the codebase exploration fanout workflow",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.includes("--help") || parts.includes("-h") || parts[0] === "help") {
				ctx.ui.notify(commandUsage(), "info");
				return;
			}
			const cwd = optionAfter(parts, "--cwd") ? path.resolve(ctx.cwd, optionAfter(parts, "--cwd")!) : ctx.cwd;
			ctx.ui.setStatus("codebase-explore", "running...");
			try {
				const result = await runScript(buildArgs({
					cwd,
					dirs: optionAfter(parts, "--dirs"),
					agent: (optionAfter(parts, "--agent") || "pi") as AgentMode,
					concurrency: optionAfter(parts, "--concurrency") ? Number(optionAfter(parts, "--concurrency")) : undefined,
					maxDirs: optionAfter(parts, "--maxDirs") ? Number(optionAfter(parts, "--maxDirs")) : undefined,
					delay: optionAfter(parts, "--delay") ? Number(optionAfter(parts, "--delay")) : undefined,
					model: optionAfter(parts, "--model"),
				}), cwd, ctx.signal);
				if (result.code !== 0) ctx.ui.notify(result.stderr || result.stdout || "Codebase exploration failed", "warning");
				else ctx.ui.notify("Codebase exploration workflow emitted", "info");
			} finally {
				ctx.ui.setStatus("codebase-explore", undefined);
			}
		},
	});
}
