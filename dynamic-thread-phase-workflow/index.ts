import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { BoundedTextBuffer } from "./lib/bounded-buffer.mjs";
import { MAX_TIMEOUT_MS, normalizeTimeoutMs } from "./lib/subprocess.mjs";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(EXT_DIR, "bin", "dynamic-thread-phase-workflow.mjs");
const MAX_TOOL_TEXT = 30_000;
const MAX_RUNNER_CAPTURE_BYTES = 1_000_000;
// The runner gives its own child process groups five seconds to escalate from
// SIGTERM to SIGKILL. Keep the wrapper alive longer so that escalation cannot
// be cut off and leave detached descendants behind.
const RUNNER_KILL_GRACE_MS = 8_000;

function truncate(text: string, max = MAX_TOOL_TEXT): string {
	if (Buffer.byteLength(text, "utf8") <= max) return text;
	let out = text.slice(0, max);
	while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, -1);
	return `${out}\n\n[Tool output truncated. Full run is available through thread_phase_runs.]`;
}

function runScript(args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; signal: NodeJS.Signals | null; stdout: string; stderr: string; aborted: boolean }> {
	if (signal?.aborted) {
		return Promise.resolve({ code: 130, signal: null, stdout: "", stderr: String(signal.reason || "cancelled"), aborted: true });
	}
	return new Promise((resolve) => {
		const proc = spawn(process.execPath, [SCRIPT, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
		// The runner normally emits one small JSON result, but bound both streams
		// while reading so a noisy/crashing child cannot exhaust the Pi process.
		const stdout = new BoundedTextBuffer(MAX_RUNNER_CAPTURE_BYTES, { keep: "tail" });
		const stderr = new BoundedTextBuffer(MAX_RUNNER_CAPTURE_BYTES, { keep: "tail" });
		let aborted = false;
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;
		const cleanup = () => {
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", abort);
		};
		const finish = (code: number, observedSignal: NodeJS.Signals | null, error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({ code, signal: observedSignal, stdout: stdout.value(), stderr: error?.message || stderr.value(), aborted });
		};
		const abort = () => {
			aborted = true;
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => proc.kill("SIGKILL"), RUNNER_KILL_GRACE_MS);
			killTimer.unref();
		};
		// Preserve UTF-8 code points split across native Buffer boundaries.
		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");
		proc.stdout.on("data", (chunk) => stdout.append(chunk));
		proc.stderr.on("data", (chunk) => stderr.append(chunk));
		proc.on("error", (error) => finish(1, null, error));
		proc.on("close", (code, observedSignal) => finish(code ?? (aborted ? 130 : 1), observedSignal));
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
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

function runnerFailure(result: { code: number; signal: NodeJS.Signals | null; stdout: string; stderr: string; aborted: boolean }): string {
	const status = result.aborted
		? `dynamic workflow runner cancelled${result.signal ? ` with ${result.signal}` : ""}`
		: result.signal
			? `dynamic workflow runner terminated with ${result.signal}`
			: `dynamic workflow runner exited ${result.code}`;
	const output = result.stderr || result.stdout;
	return output ? `${status}\n${output}` : status;
}

const PERMISSIONS = ["r", "w", "rw", "rwx"] as const;

function permissionSchema(optional = true) {
	const schema = StringEnum(PERMISSIONS, { description: "Capabilities: r (read), w (write), rw (read/write), or rwx (read/write/shell)." });
	return optional ? Type.Optional(schema) : schema;
}

function retrySchema() {
	return Type.Optional(Type.Object({
		maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
		baseDelayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })),
	}, { additionalProperties: false }));
}

function legacyStructuredSpecSchema() {
	const permissions = Type.Optional(Type.String({ pattern: "^[rwx]+$", description: "Capabilities accepted by the legacy format." }));
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
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
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
			items: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()]), { minItems: 1, maxItems: 1_000 })),
			itemsFrom: Type.Optional(Type.String()),
			concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
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
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
		concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
		autoContinue: Type.Optional(Type.Boolean()),
		metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
		phases: Type.Array(phases, { minItems: 1, maxItems: 30 }),
	}, { additionalProperties: false });
}

function legacyParametersSchema() {
	return Type.Object({
		spec: Type.Optional(legacyStructuredSpecSchema()),
		harness: Type.Optional(Type.String({ description: "Advanced JavaScript harness source. Must export default async function(ctx). Requires rwx permissions." })),
		harnessFile: Type.Optional(Type.String({ description: "Path to an advanced JavaScript harness module. Requires rwx permissions." })),
		name: Type.Optional(Type.String({ description: "Optional workflow name for harness mode." })),
		permissions: Type.Optional(Type.String({ description: "Workflow permissions, e.g. r, rw, rwx. Harness mode requires rwx." })),
		cwd: Type.Optional(Type.String({ description: "Working directory for the workflow. Defaults to Pi's current cwd or spec.cwd." })),
		model: Type.Optional(Type.String({ description: "Optional default Pi model pattern for pi/fanout_pi phases." })),
		background: Type.Optional(Type.Boolean({ description: "Start the workflow in the background and return immediately." })),
		autoContinue: Type.Optional(Type.Boolean({ description: "Queue a follow-up assistant continuation when the workflow completes successfully. Default false for dynamic workflows." })),
		timeout: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_TIMEOUT_MS, multipleOf: 1, description: "Default phase timeout in milliseconds (positive integer)." })),
	});
}

function workflowParametersSchema() {
	const permissions = permissionSchema();
	const retry = retrySchema();
	const common = {
		name: Type.String({ pattern: "^[a-zA-Z0-9_.:-]+$", description: "Unique phase name." }),
		description: Type.Optional(Type.String()),
		permissions,
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
		retry,
	};
	const phases = Type.Union([
		Type.Object({
			...common,
			type: StringEnum(["agent"] as const),
			prompt: Type.String({ minLength: 1 }),
			tools: Type.Optional(Type.Array(Type.String())),
			model: Type.Optional(Type.String()),
		}, { additionalProperties: false }),
		Type.Object({
			...common,
			type: StringEnum(["fanout"] as const),
			prompt: Type.String({ minLength: 1, description: "Prompt template. Use {{item}}, {{index}}, and {{outputs.phase-name}} references." }),
			items: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()]), { minItems: 1, maxItems: 1_000 })),
			itemsFrom: Type.Optional(Type.String({ description: "Earlier phase whose line/array output supplies fanout items." })),
			concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
			tools: Type.Optional(Type.Array(Type.String())),
			model: Type.Optional(Type.String()),
			failOnItemFailure: Type.Optional(Type.Boolean()),
		}, { additionalProperties: false }),
		Type.Object({
			...common,
			type: StringEnum(["shell"] as const),
			permissions: Type.Optional(StringEnum(["rwx"] as const, { description: "Shell phases require rwx." })),
			command: Type.String({ minLength: 1 }),
		}, { additionalProperties: false }),
		Type.Object({
			name: Type.String({ pattern: "^[a-zA-Z0-9_.:-]+$", description: "Unique phase name." }),
			description: Type.Optional(Type.String()),
			type: StringEnum(["artifact"] as const),
			content: Type.Optional(Type.String()),
			from: Type.Optional(Type.String({ description: "Earlier phase whose output becomes the artifact." })),
			title: Type.Optional(Type.String()),
			fileName: Type.Optional(Type.String()),
			kind: Type.Optional(Type.String()),
		}, { additionalProperties: false }),
	]);
	return Type.Object({
		name: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9_.:-]+$", description: "Workflow name." })),
		description: Type.Optional(Type.String()),
		cwd: Type.Optional(Type.String({ description: "Workflow working directory. Defaults to Pi's current cwd." })),
		permissions,
		model: Type.Optional(Type.String({ description: "Default model pattern for agent/fanout phases." })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000, description: "Default agent/shell phase timeout." })),
		concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 64, description: "Default fanout concurrency." })),
		background: Type.Optional(Type.Boolean({ description: "Run in the background and return a run id immediately." })),
		autoContinue: Type.Optional(Type.Boolean({ description: "After successful background completion, queue a follow-up in this Pi session." })),
		phases: Type.Array(phases, { minItems: 1, maxItems: 30 }),
	}, { additionalProperties: false });
}

function harnessParametersSchema() {
	return Type.Object({
		harness: Type.Optional(Type.String({ description: "JavaScript module source exporting default async function(ctx)." })),
		harnessFile: Type.Optional(Type.String({ description: "Path to a JavaScript harness module." })),
		name: Type.Optional(Type.String()),
		permissions: StringEnum(["rwx"] as const, { description: "Harness code is unsandboxed and requires rwx." }),
		cwd: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS })),
		background: Type.Optional(Type.Boolean()),
		autoContinue: Type.Optional(Type.Boolean()),
	}, { additionalProperties: false });
}

function legacySpecToPublic(args: any): any {
	if (!args || typeof args !== "object" || Array.isArray(args) || !args.spec || args.harness !== undefined || args.harnessFile !== undefined) return args;
	const spec = args.spec;
	if (typeof spec !== "object" || Array.isArray(spec)) return args;
	const phases = Array.isArray(spec.phases) ? spec.phases.map((phase: any) => {
		if (!phase || typeof phase !== "object" || Array.isArray(phase)) return phase;
		if (phase.type === "pi") return { ...phase, type: "agent" };
		if (phase.type === "fanout_pi") {
			const { promptTemplate, ...rest } = phase;
			return { ...rest, type: "fanout", prompt: promptTemplate };
		}
		return phase;
	}) : spec.phases;
	const { schema: _schema, metadata: _metadata, ...publicSpec } = spec;
	return {
		...publicSpec,
		phases,
		...(args.permissions !== undefined ? { permissions: args.permissions } : {}),
		...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
		...(args.model !== undefined ? { model: args.model } : {}),
		...(args.timeout !== undefined ? { timeoutMs: args.timeout } : {}),
		...(args.background !== undefined ? { background: args.background } : {}),
		...(args.autoContinue !== undefined ? { autoContinue: args.autoContinue } : {}),
	};
}

function publicWorkflowToLegacySpec(params: any): any {
	const { background: _background, ...spec } = params;
	return {
		...spec,
		phases: spec.phases.map((phase: any) => {
			if (phase.type === "agent") return { ...phase, type: "pi" };
			if (phase.type === "fanout") {
				const { prompt, ...rest } = phase;
				return { ...rest, type: "fanout_pi", promptTemplate: prompt };
			}
			return phase;
		}),
	};
}

async function executeDynamicWorkflow(params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any, legacyName: string) {
	const hasSpec = params.spec !== undefined;
	const hasHarness = params.harness !== undefined;
	const hasHarnessFile = params.harnessFile !== undefined;
	const inputModes = [hasSpec, hasHarness, hasHarnessFile].filter(Boolean).length;
	if (inputModes !== 1) throw new Error("Provide exactly one of spec, harness, or harnessFile.");
	if (hasSpec && (!params.spec || typeof params.spec !== "object" || Array.isArray(params.spec))) throw new Error("spec must be a non-null object.");
	if (hasHarness && (typeof params.harness !== "string" || !params.harness.trim())) throw new Error("harness must be a non-empty string.");
	if (hasHarnessFile && (typeof params.harnessFile !== "string" || !params.harnessFile.trim())) throw new Error("harnessFile must be a non-empty path.");
	const cwd = path.resolve(ctx.cwd, params.cwd || params.spec?.cwd || ".");
	let generatedInputFile: string | undefined;
	let retainGeneratedInput = false;
	try {
		const args = ["--cwd", cwd];
		if (hasHarness || hasHarnessFile) {
			if (params.permissions !== "rwx") throw new Error("JavaScript harness mode requires explicit permissions: \"rwx\".");
			const harnessFile = hasHarnessFile ? path.resolve(ctx.cwd, params.harnessFile) : (generatedInputFile = writeHarnessFile(params.harness));
			args.push("--js-file", harnessFile, "--permissions", params.permissions);
			if (params.name) args.push("--name", params.name);
		} else {
			const spec = { ...params.spec };
			if (params.permissions) {
				if (spec.permissions && spec.permissions !== params.permissions) throw new Error("Top-level permissions conflict with spec.permissions.");
				spec.permissions = params.permissions;
			}
			generatedInputFile = writeJsonFile(spec);
			args.push("--spec-file", generatedInputFile);
		}
		if (generatedInputFile) args.push("--cleanup-input");
		if (params.model) args.push("--model", params.model);
		if (params.timeout !== undefined) args.push("--timeout", String(normalizeTimeoutMs(params.timeout, "timeout")));
		if (params.background) args.push("--background");
		if (params.autoContinue) args.push("--auto-continue");
		addSessionArgs(args, ctx);
		onUpdate?.({ content: [{ type: "text", text: `Starting ${legacyName ? "dynamic thread-phase" : "dynamic"} workflow in ${cwd}...` }] });
		const result = await runScript(args, cwd, signal);
		let details: any;
		try { details = parseJsonObject(result.stdout); } catch { details = { stdout: result.stdout, stderr: result.stderr }; }
		if (params.background && !(result.code === 0 && details?.ok === true && details?.ready === true && details?.background === true && details?.runId && details?.pid)) throw new Error(runnerFailure(result));
		if (result.code !== 0 && !params.background) throw new Error(runnerFailure(result));
		retainGeneratedInput = Boolean(params.background && details?.background);
		const text = details?.background
			? `Started dynamic workflow ${details.runId} in background (pid ${details.pid}). Open ctrl+shift+t to monitor it.`
			: result.stdout || "Dynamic workflow started.";
		return { content: [{ type: "text", text: truncate(text) }], details };
	} finally {
		// Detached runs may not have opened their input yet when the launcher
		// acknowledges them, so retain background inputs. Foreground inputs are
		// private implementation details and can be removed immediately.
		if (generatedInputFile && !retainGeneratedInput) rmSync(path.dirname(generatedInputFile), { recursive: true, force: true });
	}
}

export default function dynamicWorkflows(pi: ExtensionAPI) {
	const guidelines = [
		"Use dynamic_workflow to compose bounded subagent workflows directly from ordered agent, fanout, shell, and artifact phases.",
		"Set dynamic_workflow permissions to r, w, rw, or rwx; phases inherit that default and may override it within operator policy.",
		"Use dynamic_workflow agent phases for one subagent and fanout phases for parallel subagents. Shell phases require rwx.",
		"Use {{outputs.phase-name}} only to reference earlier phase outputs; fanout prompts may also use {{item}} and {{index}}.",
		"Use dynamic_workflow background=true for long workflows and autoContinue=true only when a successful run should queue a follow-up.",
	];

	pi.registerTool({
		name: "dynamic_workflow",
		label: "Dynamic Workflow",
		description: "Compose and execute a validated workflow of ordered agent, fanout, shell, and artifact phases.",
		promptSnippet: "Compose bounded subagent workflows with agent, fanout, shell, and artifact phases",
		promptGuidelines: guidelines,
		parameters: workflowParametersSchema(),
		prepareArguments: legacySpecToPublic,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const spec = publicWorkflowToLegacySpec(params);
			return executeDynamicWorkflow({
				spec,
				cwd: params.cwd,
				model: params.model,
				background: params.background,
				autoContinue: params.autoContinue,
			}, signal, onUpdate, ctx, "");
		},
	});

	pi.registerTool({
		name: "dynamic_workflow_harness",
		label: "Dynamic Workflow Harness",
		description: "Advanced unsandboxed JavaScript workflow harness for loops, branching, tournaments, or custom control flow. Prefer dynamic_workflow for normal subagent composition.",
		parameters: harnessParametersSchema(),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeDynamicWorkflow({ ...params, timeout: params.timeoutMs }, signal, onUpdate, ctx, "");
		},
	});

	pi.registerTool({
		name: "dynamic_thread_phase_workflow",
		label: "Dynamic Workflow (deprecated alias)",
		description: "Deprecated legacy interface for old workflow spec and harness calls.",
		parameters: legacyParametersSchema(),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeDynamicWorkflow(params, signal, onUpdate, ctx, "legacy");
		},
	});

	pi.on?.("session_start", () => {
		if (/^(1|true|yes|on)$/i.test(process.env.PI_DYNAMIC_WORKFLOW_ENABLE_LEGACY_ALIAS || "")) return;
		const active = pi.getActiveTools?.() || [];
		if (active.includes("dynamic_thread_phase_workflow")) pi.setActiveTools?.(active.filter((name) => name !== "dynamic_thread_phase_workflow"));
	});
}
