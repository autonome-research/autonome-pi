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

function writeJsonFile(value: unknown, fileName = "workflow-spec.json"): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-dynamic-workflow-"));
	const file = path.join(dir, fileName);
	writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
	return file;
}

function writeHarnessFile(source: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-dynamic-workflow-"));
	const file = path.join(dir, "workflow-harness.mjs");
	writeFileSync(file, source, "utf8");
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

function structuredSpecSchema() {
	const permissions = Type.Optional(Type.String({ pattern: "^[rwx]+$", description: "Capabilities: r, rw, or rwx." }));
	const retry = Type.Optional(Type.Object({
		maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
		baseDelayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })),
	}, { additionalProperties: false }));
	const artifactConfig = Type.Union([
		Type.Boolean(),
		Type.Object({
			kind: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			fileName: Type.Optional(Type.String()),
			titleTemplate: Type.Optional(Type.String()),
			fileNameTemplate: Type.Optional(Type.String()),
		}, { additionalProperties: false }),
	]);
	const common = {
		name: Type.String({ pattern: "^[a-zA-Z0-9_.:-]+$" }),
		description: Type.Optional(Type.String()),
		permissions,
		timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 3_600_000 })),
		artifact: Type.Optional(artifactConfig),
		retry,
	};
	const phases = Type.Union([
		Type.Object({ ...common, type: Type.Literal("shell"), command: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		Type.Object({
			...common,
			type: Type.Literal("pi"),
			prompt: Type.String({ minLength: 1 }),
			tools: Type.Optional(Type.Array(Type.String())),
			model: Type.Optional(Type.String()),
		}, { additionalProperties: false }),
		Type.Object({
			...common,
			type: Type.Literal("fanout_pi"),
			promptTemplate: Type.String({ minLength: 1 }),
			items: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()]), { minItems: 1, maxItems: 100 })),
			itemsFrom: Type.Optional(Type.String()),
			concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
			label: Type.Optional(Type.String()),
			tools: Type.Optional(Type.Array(Type.String())),
			model: Type.Optional(Type.String()),
			failOnItemFailure: Type.Optional(Type.Boolean()),
		}, { additionalProperties: false }),
		Type.Object({
			...common,
			type: Type.Literal("artifact"),
			content: Type.Optional(Type.String()),
			from: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			fileName: Type.Optional(Type.String()),
			kind: Type.Optional(Type.String()),
		}, { additionalProperties: false }),
	]);
	return Type.Object({
		schema: Type.Optional(Type.Literal("pi-dynamic-workflow/v1")),
		name: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9_.:-]+$" })),
		description: Type.Optional(Type.String()),
		permissions,
		cwd: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 3_600_000 })),
		concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
		autoContinue: Type.Optional(Type.Boolean()),
		metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
		phases: Type.Array(phases, { minItems: 1, maxItems: 30 }),
	}, { additionalProperties: false });
}

function parametersSchema() {
	return Type.Object({
		spec: Type.Optional(structuredSpecSchema()),
		harness: Type.Optional(Type.String({ description: "Advanced JavaScript harness source. Must export default async function(ctx). Requires rwx permissions." })),
		harnessFile: Type.Optional(Type.String({ description: "Path to an advanced JavaScript harness module. Requires rwx permissions." })),
		name: Type.Optional(Type.String({ description: "Optional workflow name for harness mode." })),
		permissions: Type.Optional(Type.String({ description: "Workflow permissions, e.g. r, rw, rwx. Harness mode requires rwx." })),
		cwd: Type.Optional(Type.String({ description: "Working directory for the workflow. Defaults to Pi's current cwd or spec.cwd." })),
		model: Type.Optional(Type.String({ description: "Optional default Pi model pattern for pi/fanout_pi phases." })),
		background: Type.Optional(Type.Boolean({ description: "Start the workflow in the background and return immediately." })),
		autoContinue: Type.Optional(Type.Boolean({ description: "Queue a follow-up assistant continuation when the workflow completes successfully. Default false for dynamic workflows." })),
		timeout: Type.Optional(Type.Number({ description: "Default phase timeout in milliseconds." })),
	});
}

async function executeDynamicWorkflow(params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any, legacyName: string) {
	const modes = [params.spec !== undefined, params.harness !== undefined, params.harnessFile !== undefined].filter(Boolean).length;
	if (modes !== 1) throw new Error("Provide exactly one of spec, harness, or harnessFile.");
	const cwd = path.resolve(ctx.cwd, params.cwd || params.spec?.cwd || ".");
	const args = ["--cwd", cwd];
	if (params.harness || params.harnessFile) {
		if (params.permissions !== "rwx") throw new Error("JavaScript harness mode requires explicit permissions: \"rwx\".");
		const harnessFile = params.harnessFile ? path.resolve(ctx.cwd, params.harnessFile) : writeHarnessFile(params.harness);
		args.push("--js-file", harnessFile, "--permissions", params.permissions);
		if (params.name) args.push("--name", params.name);
	} else {
		const spec = { ...params.spec };
		if (params.permissions) {
			if (spec.permissions && spec.permissions !== params.permissions) throw new Error("Top-level permissions conflict with spec.permissions.");
			spec.permissions = params.permissions;
		}
		args.push("--spec-file", writeJsonFile(spec));
	}
	if (params.model) args.push("--model", params.model);
	if (params.timeout !== undefined) args.push("--timeout", String(params.timeout));
	if (params.background) args.push("--background");
	if (params.autoContinue) args.push("--auto-continue");
	addSessionArgs(args, ctx);
	onUpdate?.({ content: [{ type: "text", text: `Starting ${legacyName ? "dynamic thread-phase" : "dynamic"} workflow in ${cwd}...` }] });
	const result = await runScript(args, cwd, signal);
	let details: any;
	try { details = parseJsonObject(result.stdout); } catch { details = { stdout: result.stdout, stderr: result.stderr }; }
	if (params.background && !(result.code === 0 && details?.ok === true && details?.ready === true && details?.background === true && details?.runId && details?.pid)) throw new Error(result.stderr || result.stdout || "dynamic workflow background launch failed");
	if (result.code !== 0 && !params.background) throw new Error(result.stderr || result.stdout || `dynamic workflow exited ${result.code}`);
	const text = details?.background
		? `Started dynamic workflow ${details.runId || ""} in background (pid ${details.pid}). Open ctrl+shift+t to monitor it.`
		: result.stdout || "Dynamic workflow started.";
	return { content: [{ type: "text", text: truncate(text) }], details };
}

export default function dynamicWorkflows(pi: ExtensionAPI) {
	const guidelines = [
		"Use dynamic_workflow when the user wants an ad-hoc deterministic workflow planned in chat and then executed with workflow observability.",
		"Default to structured spec mode for auditability. Use JavaScript harness mode only when loops, branching, tournaments, custom scoring, or other rich control flow are needed.",
		"Build a concrete spec or harness first and declare compact rwx permissions at the workflow or phase level.",
		"Permissions are capabilities, not tool names: r enables read/grep/find/ls, w enables edit/write, and shell or bash execution requires rwx because command execution is not sandboxed.",
		"Structured phase types are shell, pi, fanout_pi, and artifact. References may only target earlier phases; retries are explicit and bounded.",
		"Harness mode receives ctx.phase, ctx.shell, ctx.pi, ctx.fanout, and ctx.artifact helpers. It is arbitrary unsandboxed Node.js; rwx is an acknowledgement, not confinement.",
		"Use background: true for long workflows so normal Pi chat remains usable. Readiness acknowledgement includes runId and pid.",
		"When logic becomes reusable, domain-specific, or operationally important, graduate it into a standalone TypeScript extension using thread-phase directly.",
	];

	pi.registerTool({
		name: "dynamic_workflow",
		label: "Dynamic Workflow",
		description: "Execute a validated dynamic workflow from a structured spec or advanced JavaScript harness. Emits generic workflow events and artifacts.",
		promptSnippet: "Run a deterministic multi-phase workflow from a spec or JavaScript harness",
		promptGuidelines: guidelines,
		parameters: parametersSchema(),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeDynamicWorkflow(params, signal, onUpdate, ctx, "");
		},
	});

	pi.registerTool({
		name: "dynamic_thread_phase_workflow",
		label: "Dynamic Workflow (deprecated alias)",
		description: "Deprecated alias for dynamic_workflow. Execute a validated dynamic workflow spec or JavaScript harness.",
		promptSnippet: "Run a deterministic multi-phase workflow from a spec or JavaScript harness",
		promptGuidelines: ["Prefer dynamic_workflow. This tool remains for compatibility.", ...guidelines],
		parameters: parametersSchema(),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeDynamicWorkflow(params, signal, onUpdate, ctx, "legacy");
		},
	});
}
