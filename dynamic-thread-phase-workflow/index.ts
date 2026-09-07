import { spawn } from "node:child_process";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
const MAX_SAVED_TEMPLATE_BYTES = 1_000_000;
const SAVED_TEMPLATE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function savedWorkflowDirectory(): string {
	return path.resolve(process.env.PI_DYNAMIC_WORKFLOW_TEMPLATE_DIR || path.join(homedir(), ".pi", "agent", "workflows"));
}

function availableSavedTemplates(extension: ".json" | ".mjs"): string[] {
	const directory = savedWorkflowDirectory();
	try {
		return readdirSync(directory)
			.filter((entry) => entry.endsWith(extension))
			.filter((entry) => {
				try {
					const info = lstatSync(path.join(directory, entry));
					return info.isFile() && !info.isSymbolicLink() && info.size <= MAX_SAVED_TEMPLATE_BYTES;
				} catch {
					return false;
				}
			})
			.map((entry) => entry.slice(0, -extension.length))
			.filter((entry) => SAVED_TEMPLATE_NAME.test(entry))
			.sort()
			.slice(0, 50);
	} catch {
		return [];
	}
}

function savedTemplatePath(name: unknown, extension: ".json" | ".mjs"): string {
	if (typeof name !== "string" || !SAVED_TEMPLATE_NAME.test(name)) {
		throw new Error("Saved workflow template names must start with an alphanumeric character and contain only letters, numbers, _, ., and -; paths are not accepted.");
	}
	const directory = savedWorkflowDirectory();
	const candidate = path.join(directory, `${name}${extension}`);
	let info;
	try {
		info = lstatSync(candidate);
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
		const available = availableSavedTemplates(extension);
		throw new Error(`Saved workflow template ${name}${extension} was not found under ${directory}.${available.length ? ` Available: ${available.join(", ")}` : ""}`);
	}
	if (info.isSymbolicLink()) throw new Error(`Saved workflow template must not be a symbolic link: ${candidate}`);
	if (!info.isFile()) throw new Error(`Saved workflow template must be a regular file: ${candidate}`);
	if (info.size > MAX_SAVED_TEMPLATE_BYTES) throw new Error(`Saved workflow template exceeds the ${MAX_SAVED_TEMPLATE_BYTES}-byte limit: ${candidate}`);
	const realDirectory = realpathSync(directory);
	const realCandidate = realpathSync(candidate);
	const relative = path.relative(realDirectory, realCandidate);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Saved workflow template resolves outside its template directory: ${candidate}`);
	return realCandidate;
}

function readSavedTemplate(name: unknown, extension: ".json" | ".mjs"): { file: string; source: string } {
	const file = savedTemplatePath(name, extension);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
		const info = fstatSync(descriptor);
		if (!info.isFile()) throw new Error(`Saved workflow template must remain a regular file: ${file}`);
		if (info.size > MAX_SAVED_TEMPLATE_BYTES) throw new Error(`Saved workflow template exceeds the ${MAX_SAVED_TEMPLATE_BYTES}-byte limit: ${file}`);
		const buffer = Buffer.allocUnsafe(MAX_SAVED_TEMPLATE_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (count === 0) break;
			bytesRead += count;
		}
		if (bytesRead > MAX_SAVED_TEMPLATE_BYTES) throw new Error(`Saved workflow template exceeds the ${MAX_SAVED_TEMPLATE_BYTES}-byte limit: ${file}`);
		return { file, source: buffer.subarray(0, bytesRead).toString("utf8") };
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function loadStructuredTemplate(name: unknown): any {
	const { file, source } = readSavedTemplate(name, ".json");
	let template;
	try {
		template = JSON.parse(source);
	} catch (error: any) {
		throw new Error(`Could not parse saved workflow template ${file}: ${error?.message || error}`);
	}
	if (!template || typeof template !== "object" || Array.isArray(template)) throw new Error(`Saved workflow template must contain a JSON object: ${file}`);
	if (!Array.isArray(template.phases) || template.phases.length === 0) throw new Error(`Saved workflow template must contain a non-empty phases array: ${file}`);
	if (["template", "inputs", "harness", "harnessFile", "spec"].some((key) => template[key] !== undefined)) throw new Error(`Saved structured workflow templates may contain only flat dynamic_workflow arguments: ${file}`);
	return template;
}

function definedProperties(value: any): any {
	return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined));
}

const SAVED_INPUT_REFERENCE = /\{\{\s*inputs\.([a-zA-Z0-9_.-]+)\s*\}\}/g;

function renderStructuredTemplate(value: any, inputs: Record<string, any>, used: Set<string>): any {
	if (Array.isArray(value)) return value.map((nested) => renderStructuredTemplate(nested, inputs, used));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, renderStructuredTemplate(nested, inputs, used)]));
	if (typeof value !== "string") return value;
	const exact = value.match(/^\{\{\s*inputs\.([a-zA-Z0-9_.-]+)\s*\}\}$/);
	if (exact) {
		const key = exact[1];
		if (!Object.prototype.hasOwnProperty.call(inputs, key)) throw new Error(`Saved workflow template requires input: ${key}`);
		used.add(key);
		return inputs[key];
	}
	return value.replace(SAVED_INPUT_REFERENCE, (_match, key) => {
		if (!Object.prototype.hasOwnProperty.call(inputs, key)) throw new Error(`Saved workflow template requires input: ${key}`);
		const replacement = inputs[key];
		if (replacement !== null && typeof replacement === "object") throw new Error(`Saved workflow template input ${key} must be a scalar when embedded in text`);
		used.add(key);
		return String(replacement ?? "");
	});
}

const PUBLIC_WORKFLOW_KEYS = new Set(["name", "cwd", "permissions", "model", "timeoutMs", "background", "after", "resumeRunId", "template", "inputs", "phases"]);
const SCRIPTED_WORKFLOW_KEYS = new Set(["script", "scriptFile", "template", "name", "cwd", "model", "timeoutMs", "background", "after", "permissions"]);
const TEMPLATE_WORKFLOW_KEYS = new Set(["name", "cwd", "permissions", "model", "timeoutMs", "background", "phases"]);
const LEGACY_OUTER_KEYS = new Set(["spec", "harness", "harnessFile", "name", "permissions", "cwd", "model", "background", "autoContinue", "after", "resumeRunId", "timeout"]);
const EXECUTABLE_PHASE_COMMON = ["type", "name", "permissions", "timeoutMs", "attempts"];
const WORKFLOW_NAME = /^[a-zA-Z0-9_.:-]+$/;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;

function rejectUnsupportedFields(value: any, allowed: Set<string>, label: string): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
	if (unsupported.length) throw new Error(`${label} has unsupported field(s): ${unsupported.join(", ")}`);
}

function validateOptionalString(value: unknown, label: string, nonEmpty = false): void {
	if (value === undefined) return;
	if (typeof value !== "string" || (nonEmpty && !value.trim())) throw new Error(`${label} must be ${nonEmpty ? "a non-empty" : "a"} string.`);
}

function validateBoundedInteger(value: unknown, label: string, maximum: number): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)) {
		throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
	}
}

function validatePermission(value: unknown, label: string): void {
	if (value !== undefined && (typeof value !== "string" || !(PERMISSIONS as readonly string[]).includes(value))) {
		throw new Error(`${label} must be one of r, w, rw, or rwx.`);
	}
}

function validateTools(value: unknown, label: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.length === 0 || !value.every((tool) => typeof tool === "string")) {
		throw new Error(`${label} must be a non-empty array of strings.`);
	}
}

function validatePublicWorkflow(params: any, label = "dynamic_workflow"): void {
	rejectUnsupportedFields(params, PUBLIC_WORKFLOW_KEYS, label);
	if (params.name !== undefined && (typeof params.name !== "string" || !WORKFLOW_NAME.test(params.name))) throw new Error(`${label}.name is invalid.`);
	validateOptionalString(params.cwd, `${label}.cwd`, true);
	validateOptionalString(params.model, `${label}.model`);
	validatePermission(params.permissions, `${label}.permissions`);
	validateBoundedInteger(params.timeoutMs, `${label}.timeoutMs`, 3_600_000);
	if (params.background !== undefined && typeof params.background !== "boolean") throw new Error(`${label}.background must be a boolean.`);
	if (params.after !== undefined && (typeof params.after !== "string" || !RUN_ID.test(params.after))) throw new Error(`${label}.after must be a safe run identifier.`);
	if (params.resumeRunId !== undefined && (typeof params.resumeRunId !== "string" || !RUN_ID.test(params.resumeRunId))) throw new Error(`${label}.resumeRunId must be a safe run identifier.`);
	if (params.template !== undefined && (typeof params.template !== "string" || !SAVED_TEMPLATE_NAME.test(params.template))) throw new Error(`${label}.template must be a safe saved-template name.`);
	if (params.inputs !== undefined && (!params.inputs || typeof params.inputs !== "object" || Array.isArray(params.inputs))) throw new Error(`${label}.inputs must be an object.`);
	if (params.phases === undefined) return;
	if (!Array.isArray(params.phases) || params.phases.length < 1 || params.phases.length > 30) throw new Error(`${label}.phases must contain between 1 and 30 phases.`);
	const seen = new Set<string>();
	for (const [index, phase] of params.phases.entries()) {
		const phaseLabel = `${label}.phases[${index}]`;
		if (!phase || typeof phase !== "object" || Array.isArray(phase)) throw new Error(`${phaseLabel} must be an object.`);
		if (typeof phase.name !== "string" || !WORKFLOW_NAME.test(phase.name)) throw new Error(`${phaseLabel}.name is invalid.`);
		if (seen.has(phase.name)) throw new Error(`${label} has duplicate phase name: ${phase.name}`);
		const byType: Record<string, string[]> = {
			agent: ["prompt", "tools", "model"],
			fanout: ["prompt", "items", "itemsFrom", "concurrency", "tools", "model", "failOnItemFailure"],
			shell: ["command"],
			artifact: ["type", "name", "content", "from", "title"],
		};
		if (typeof phase.type !== "string" || !Object.prototype.hasOwnProperty.call(byType, phase.type)) throw new Error(`Unsupported phase type for ${phaseLabel}: ${String(phase.type)}`);
		const allowed = phase.type === "artifact" ? byType.artifact : [...EXECUTABLE_PHASE_COMMON, ...byType[phase.type]];
		rejectUnsupportedFields(phase, new Set(allowed), phaseLabel);
		if (phase.type !== "artifact") {
			validatePermission(phase.permissions, `${phaseLabel}.permissions`);
			validateBoundedInteger(phase.timeoutMs, `${phaseLabel}.timeoutMs`, 3_600_000);
			validateBoundedInteger(phase.attempts, `${phaseLabel}.attempts`, 5);
		}
		if (phase.type === "agent") {
			validateOptionalString(phase.prompt, `${phaseLabel}.prompt`, true);
			validateOptionalString(phase.model, `${phaseLabel}.model`);
			validateTools(phase.tools, `${phaseLabel}.tools`);
		}
		if (phase.type === "fanout") {
			validateOptionalString(phase.prompt, `${phaseLabel}.prompt`, true);
			validateOptionalString(phase.model, `${phaseLabel}.model`);
			validateTools(phase.tools, `${phaseLabel}.tools`);
			validateBoundedInteger(phase.concurrency, `${phaseLabel}.concurrency`, 64);
			if (phase.failOnItemFailure !== undefined && typeof phase.failOnItemFailure !== "boolean") throw new Error(`${phaseLabel}.failOnItemFailure must be a boolean.`);
			const hasItems = phase.items !== undefined;
			const hasItemsFrom = phase.itemsFrom !== undefined;
			if (hasItems === hasItemsFrom) throw new Error(`${phaseLabel} must provide exactly one of items or itemsFrom.`);
			if (hasItems && (!Array.isArray(phase.items) || phase.items.length < 1 || phase.items.length > 1_000 || !phase.items.every((item: unknown) => typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))))) throw new Error(`${phaseLabel}.items is invalid.`);
			if (hasItemsFrom && (typeof phase.itemsFrom !== "string" || !seen.has(phase.itemsFrom))) throw new Error(`${phaseLabel}.itemsFrom must reference an earlier phase.`);
		}
		if (phase.type === "shell") validateOptionalString(phase.command, `${phaseLabel}.command`, true);
		if (phase.type === "artifact") {
			const hasContent = phase.content !== undefined;
			const hasFrom = phase.from !== undefined;
			if (hasContent === hasFrom) throw new Error(`${phaseLabel} must provide exactly one of content or from.`);
			if (hasContent && typeof phase.content !== "string") throw new Error(`${phaseLabel}.content must be a string.`);
			if (hasFrom && (typeof phase.from !== "string" || !seen.has(phase.from))) throw new Error(`${phaseLabel}.from must reference an earlier phase.`);
			validateOptionalString(phase.title, `${phaseLabel}.title`);
		}
		seen.add(phase.name);
	}
}

function resolvePublicWorkflowParams(params: any): any {
	validatePublicWorkflow(params);
	const hasTemplate = params.template !== undefined;
	const hasPhases = params.phases !== undefined;
	const hasResume = params.resumeRunId !== undefined;
	if ([hasTemplate, hasPhases, hasResume].filter(Boolean).length !== 1) throw new Error("Provide exactly one of template, phases, or resumeRunId.");
	if (hasResume) {
		const unsupported = Object.keys(definedProperties(params)).filter((key) => !["resumeRunId", "background"].includes(key));
		if (unsupported.length) throw new Error(`Run-ID-only resume accepts only resumeRunId and background; remove: ${unsupported.join(", ")}`);
		return params;
	}
	if (!hasTemplate) {
		if (params.inputs !== undefined) throw new Error("inputs may only be used with a saved structured workflow template.");
		return params;
	}
	const templateName = params.template;
	const rawInputs = params.inputs ?? {};
	if (!rawInputs || typeof rawInputs !== "object" || Array.isArray(rawInputs)) throw new Error("Saved workflow template inputs must be an object.");
	const loadedTemplate = loadStructuredTemplate(templateName);
	rejectUnsupportedFields(loadedTemplate, TEMPLATE_WORKFLOW_KEYS, "Saved structured workflow template");
	const usedInputs = new Set<string>();
	const template = renderStructuredTemplate(loadedTemplate, rawInputs, usedInputs);
	validatePublicWorkflow(template, "Saved structured workflow template");
	const unusedInputs = Object.keys(rawInputs).filter((key) => !usedInputs.has(key));
	if (unusedInputs.length) throw new Error(`Saved workflow template received unused inputs: ${unusedInputs.sort().join(", ")}`);
	const { template: _template, inputs: _inputs, phases: _phases, ...rawOverrides } = params;
	const overrides = definedProperties(rawOverrides);
	const resolved = { ...template, ...overrides, phases: template.phases };
	validatePublicWorkflow(resolved);
	return { ...resolved, systemTemplateProvenance: templateName };
}

function resolveScriptedWorkflowParams(params: any): any {
	rejectUnsupportedFields(params, SCRIPTED_WORKFLOW_KEYS, "scripted_workflow");
	if (params.name !== undefined && (typeof params.name !== "string" || params.name.length > 200 || !WORKFLOW_NAME.test(params.name))) throw new Error("scripted_workflow.name must be a safe workflow name of at most 200 characters.");
	validateOptionalString(params.cwd, "scripted_workflow.cwd", true);
	validateOptionalString(params.model, "scripted_workflow.model", true);
	validateBoundedInteger(params.timeoutMs, "scripted_workflow.timeoutMs", MAX_TIMEOUT_MS);
	if (params.background !== undefined && typeof params.background !== "boolean") throw new Error("scripted_workflow.background must be a boolean.");
	if (params.after !== undefined && (typeof params.after !== "string" || !RUN_ID.test(params.after))) throw new Error("scripted_workflow.after must be a safe run identifier.");
	if (params.permissions !== "rwx") throw new Error('scripted_workflow requires explicit permissions: "rwx".');
	if (params.template !== undefined && (typeof params.template !== "string" || params.template.length > 200 || !SAVED_TEMPLATE_NAME.test(params.template))) throw new Error("scripted_workflow.template must be a safe saved-template name of at most 200 characters.");
	if (params.script !== undefined && (typeof params.script !== "string" || !params.script.trim())) throw new Error("scripted_workflow.script must be a non-empty string.");
	if (params.scriptFile !== undefined && (typeof params.scriptFile !== "string" || !params.scriptFile.trim())) throw new Error("scripted_workflow.scriptFile must be a non-empty path.");
	const modes = [params.template !== undefined, params.script !== undefined, params.scriptFile !== undefined].filter(Boolean).length;
	if (modes !== 1) throw new Error("Provide exactly one of template, script, or scriptFile.");
	if (params.template === undefined) {
		const { script, scriptFile, ...controls } = params;
		return { ...controls, ...(script !== undefined ? { harness: script } : { harnessFile: scriptFile }) };
	}
	// All caller-controlled fields are validated before opening an operator-managed template.
	const { source } = readSavedTemplate(params.template, ".mjs");
	const { template, ...controls } = params;
	return { ...controls, harness: source, name: params.name || template };
}

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

function runnerFailure(result: { code: number; signal: NodeJS.Signals | null; stdout: string; stderr: string; aborted: boolean }, runnerName = "dynamic workflow runner"): string {
	const status = result.aborted
		? `${runnerName} cancelled${result.signal ? ` with ${result.signal}` : ""}`
		: result.signal
			? `${runnerName} terminated with ${result.signal}`
			: `${runnerName} exited ${result.code}`;
	const output = result.stderr || result.stdout;
	return output ? `${status}\n${output}` : status;
}

const PERMISSIONS = ["r", "w", "rw", "rwx"] as const;

function permissionSchema(optional = true) {
	const schema = StringEnum(PERMISSIONS, { description: "Capabilities: r (read), w (write), rw (read/write), or rwx (read/write/shell)." });
	return optional ? Type.Optional(schema) : schema;
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
		after: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$", description: "Terminal parent run whose single chained successor this workflow becomes." })),
		resumeRunId: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$", description: "Prior structured run whose validated phase-output artifacts should be reused." })),
		timeout: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_TIMEOUT_MS, multipleOf: 1, description: "Default phase timeout in milliseconds (positive integer)." })),

	});
}

function workflowParametersSchema() {
	const permissions = permissionSchema();
	const common = {
		name: Type.String({ pattern: "^[a-zA-Z0-9_.:-]+$", description: "Unique phase name." }),
		permissions,
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
		attempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Total attempts. Retry delay is deterministic runner policy." })),
	};
	const phases = Type.Union([
		Type.Object({
			...common,
			type: StringEnum(["agent"] as const),
			prompt: Type.String({ minLength: 1 }),
			tools: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
			model: Type.Optional(Type.String()),
		}, { additionalProperties: false }),
		Type.Object({
			...common,
			type: StringEnum(["fanout"] as const),
			prompt: Type.String({ minLength: 1, description: "Prompt template. Use {{item}}, {{index}}, and {{outputs.phase-name}} references." }),
			items: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()]), { minItems: 1, maxItems: 1_000 })),
			itemsFrom: Type.Optional(Type.String({ description: "Earlier phase whose line/array output supplies fanout items." })),
			concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
			tools: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
			model: Type.Optional(Type.String()),
			failOnItemFailure: Type.Optional(Type.Boolean({ description: "Fail after all siblings settle if any item fails. Default true." })),
		}, { additionalProperties: false }),
		Type.Object({
			...common,
			type: StringEnum(["shell"] as const),
			permissions: Type.Optional(StringEnum(["rwx"] as const, { description: "Shell phases require rwx." })),
			command: Type.String({ minLength: 1 }),
		}, { additionalProperties: false }),
		Type.Object({
			name: Type.String({ pattern: "^[a-zA-Z0-9_.:-]+$", description: "Unique phase name." }),
			type: StringEnum(["artifact"] as const),
			content: Type.Optional(Type.String()),
			from: Type.Optional(Type.String({ description: "Earlier phase whose output becomes the artifact." })),
			title: Type.Optional(Type.String()),
		}, { additionalProperties: false }),
	]);
	return Type.Object({
		name: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9_.:-]+$", description: "Workflow name." })),
		cwd: Type.Optional(Type.String({ description: "Workflow working directory. Defaults to Pi's current cwd." })),
		permissions,
		model: Type.Optional(Type.String({ description: "Default model pattern for agent/fanout phases." })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000, description: "Default agent/shell phase timeout." })),
		background: Type.Optional(Type.Boolean({ description: "Run in the background; successful and failed terminal runs return control to this Pi session, while cancellation does not." })),
		after: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$", description: "Terminal successful or failed parent run. This workflow becomes its single chained successor." })),
		resumeRunId: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$", description: "Resume this structured run from its trusted spec and completed phase artifacts. Use without phases or template." })),
		template: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$", description: "Saved structured workflow name from ~/.pi/agent/workflows/<name>.json. Use instead of phases." })),
		inputs: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Values for {{inputs.key}} placeholders in a saved structured workflow template." })),
		phases: Type.Optional(Type.Array(phases, { minItems: 1, maxItems: 30, description: "Ordered phases. Use exactly one of phases or template." })),
	}, { additionalProperties: false });
}

function scriptedWorkflowParametersSchema() {
	return Type.Object({
		script: Type.Optional(Type.String({ minLength: 1, description: "Self-contained ES module exporting default async function(ctx)." })),
		scriptFile: Type.Optional(Type.String({ minLength: 1 })),
		template: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$", maxLength: 200, description: "Saved ~/.pi/agent/workflows/<name>.mjs; replaces script/scriptFile." })),
		name: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9_.:-]+$", maxLength: 200 })),
		cwd: Type.Optional(Type.String({ minLength: 1 })),
		model: Type.Optional(Type.String({ minLength: 1 })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS })),
		background: Type.Optional(Type.Boolean({ description: "Return to chat after success/failure, not cancellation." })),
		after: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$" })),
		permissions: StringEnum(["rwx"] as const, { description: "Required: unsandboxed read/write/execute access." }),
	}, { additionalProperties: false });
}

function legacySpecToPublic(args: any): any {
	if (!args || typeof args !== "object" || Array.isArray(args) || !Object.prototype.hasOwnProperty.call(args, "spec")) return args;
	rejectUnsupportedFields(args, LEGACY_OUTER_KEYS, "Legacy dynamic_workflow arguments");
	if (!args.spec || args.harness !== undefined || args.harnessFile !== undefined) return args;
	const spec = args.spec;
	if (typeof spec !== "object" || Array.isArray(spec)) return args;
	if (spec.schema !== undefined && spec.schema !== "pi-dynamic-workflow/v1") throw new Error(`Unsupported legacy spec.schema: ${String(spec.schema)}`);
	if (args.permissions !== undefined && spec.permissions !== undefined && args.permissions !== spec.permissions) {
		throw new Error("Top-level permissions conflict with spec.permissions.");
	}
	if (args.timeout !== undefined && spec.timeoutMs !== undefined && args.timeout !== spec.timeoutMs) {
		throw new Error("Legacy timeout conflicts with spec.timeoutMs; use one timeout value.");
	}
	const phases = Array.isArray(spec.phases) ? spec.phases.map((phase: any) => {
		if (!phase || typeof phase !== "object" || Array.isArray(phase)) return phase;
		if (phase.artifact !== undefined || (phase.type === "artifact" && (phase.permissions !== undefined || phase.timeoutMs !== undefined || phase.retry !== undefined))) {
			throw new Error(`Legacy phase options on ${phase.name || "unnamed phase"} cannot be represented by the simplified format. Use an explicit artifact phase, or temporarily enable dynamic_thread_phase_workflow for the full legacy interface.`);
		}
		if (phase.type === "pi") return { ...phase, type: "agent" };
		if (phase.type === "fanout_pi") {
			const { promptTemplate, ...rest } = phase;
			return { ...rest, type: "fanout", prompt: promptTemplate };
		}
		return phase;
	}) : spec.phases;
	const { schema: _schema, ...publicSpec } = spec;
	const prepared = {
		...publicSpec,
		phases,
		...(args.permissions !== undefined ? { permissions: args.permissions } : {}),
		...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
		...(args.model !== undefined ? { model: args.model } : {}),
		...(args.timeout !== undefined ? { timeoutMs: args.timeout } : {}),
		...(args.background !== undefined ? { background: args.background } : {}),
		...(args.autoContinue !== undefined ? { autoContinue: args.autoContinue } : {}),
		...(args.after !== undefined ? { after: args.after } : {}),
		...(args.resumeRunId !== undefined ? { resumeRunId: args.resumeRunId } : {}),
	};
	validatePublicWorkflow(prepared);
	return prepared;
}

function publicWorkflowToLegacySpec(params: any): any {
	const { after: _after, background: _background, template: _template, resumeRunId: _resumeRunId, inputs: _inputs, systemTemplateProvenance: _provenance, ...spec } = params;
	return {
		schema: "pi-dynamic-workflow/v2",
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

async function executeDynamicWorkflow(params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any, legacyName: string, publicKind: "dynamic" | "scripted" = "dynamic") {
	if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Workflow arguments must be an object.");
	validateOptionalString(params.cwd, "cwd", true);
	validateOptionalString(params.model, "model");
	validateOptionalString(params.name, "name");
	if (params.background !== undefined && typeof params.background !== "boolean") throw new Error("background must be a boolean.");
	if (params.autoContinue !== undefined && typeof params.autoContinue !== "boolean") throw new Error("autoContinue must be a boolean.");
	if (params.after !== undefined && (typeof params.after !== "string" || !RUN_ID.test(params.after))) throw new Error("after must be a safe run identifier.");
	if (params.resumeRunId !== undefined && (typeof params.resumeRunId !== "string" || !RUN_ID.test(params.resumeRunId))) throw new Error("resumeRunId must be a safe run identifier.");
	if (params.systemTemplateProvenance !== undefined && (typeof params.systemTemplateProvenance !== "string" || !SAVED_TEMPLATE_NAME.test(params.systemTemplateProvenance))) throw new Error("Saved-template provenance is invalid.");
	const hasSpec = params.spec !== undefined;
	const hasHarness = params.harness !== undefined;
	const hasHarnessFile = params.harnessFile !== undefined;
	const hasResumeOnly = params.resumeRunId !== undefined && !hasSpec && !hasHarness && !hasHarnessFile;
	const inputModes = [hasSpec, hasHarness, hasHarnessFile, hasResumeOnly].filter(Boolean).length;
	if (inputModes !== 1) throw new Error("Provide exactly one of spec, resumeRunId, harness, or harnessFile.");
	if ((hasHarness || hasHarnessFile) && params.resumeRunId !== undefined) throw new Error("resumeRunId is supported only for structured workflows, not harnesses.");
	if (params.after !== undefined && params.resumeRunId !== undefined) throw new Error("Provide only one of after or resumeRunId.");
	if (hasSpec && (!params.spec || typeof params.spec !== "object" || Array.isArray(params.spec))) throw new Error("spec must be a non-null object.");
	if (hasHarness && (typeof params.harness !== "string" || !params.harness.trim())) throw new Error("harness must be a non-empty string.");
	if (hasHarnessFile && (typeof params.harnessFile !== "string" || !params.harnessFile.trim())) throw new Error("harnessFile must be a non-empty path.");
	const cwd = path.resolve(ctx.cwd, params.cwd || params.spec?.cwd || ".");
	let generatedInputFile: string | undefined;
	let retainGeneratedInput = false;
	try {
		const args = hasResumeOnly ? [] : ["--cwd", cwd];
		if (hasHarness || hasHarnessFile) {
			if (params.permissions !== "rwx") throw new Error("JavaScript harness mode requires explicit permissions: \"rwx\".");
			const harnessFile = hasHarnessFile ? path.resolve(ctx.cwd, params.harnessFile) : (generatedInputFile = writeHarnessFile(params.harness));
			args.push("--js-file", harnessFile, "--permissions", params.permissions);
			if (params.name) args.push("--name", params.name);
		} else if (hasSpec) {
			const spec = { ...params.spec };
			if (params.permissions) {
				if (spec.permissions && spec.permissions !== params.permissions) throw new Error("Top-level permissions conflict with spec.permissions.");
				spec.permissions = params.permissions;
			}
			generatedInputFile = writeJsonFile(spec);
			args.push("--spec-file", generatedInputFile);
			if (legacyName) args.push("--legacy-spec");
		}
		if (params.systemTemplateProvenance) args.push("--saved-template", params.systemTemplateProvenance);
		if (generatedInputFile) args.push("--cleanup-input");
		if (params.model) args.push("--model", params.model);
		if (params.timeout !== undefined) args.push("--timeout", String(normalizeTimeoutMs(params.timeout, "timeout")));
		if (params.background) args.push("--background");
		if (params.autoContinue) args.push("--auto-continue");
		if (params.after) args.push("--after", params.after);
		if (params.resumeRunId) args.push("--resume-run-id", params.resumeRunId);
		addSessionArgs(args, ctx);
		const displayKind = publicKind === "scripted" ? "scripted" : legacyName ? "dynamic thread-phase" : "dynamic";
		onUpdate?.({ content: [{ type: "text", text: `Starting ${displayKind} workflow in ${cwd}...` }] });
		const result = await runScript(args, cwd, signal);
		let details: any;
		try { details = parseJsonObject(result.stdout); } catch { details = { stdout: result.stdout, stderr: result.stderr }; }
		const failureName = publicKind === "scripted" ? "scripted workflow runner" : "dynamic workflow runner";
		if (params.background && !(result.code === 0 && details?.ok === true && details?.ready === true && details?.background === true && details?.runId && details?.pid)) throw new Error(runnerFailure(result, failureName));
		if (result.code !== 0 && !params.background) throw new Error(runnerFailure(result, failureName));
		retainGeneratedInput = Boolean(params.background && details?.background);
		const text = details?.background
			? `Started ${displayKind} workflow ${details.runId} in background (pid ${details.pid}). Open ctrl+shift+t to monitor it.`
			: result.stdout || `${displayKind[0].toUpperCase()}${displayKind.slice(1)} workflow started.`;
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
		"Use background=true for long workflows. Successful and failed background runs return control to chat; user-cancelled runs do not.",
		"Reusable structured workflows may be loaded by template name from ~/.pi/agent/workflows/<name>.json instead of supplying phases.",
		"Use after with a terminal successful or failed run id to create its single model-selected chained successor; Pi generates the child run and chain identities.",
		"Use resumeRunId by itself to continue the same structured workflow from its trusted stored spec and validated completed phase-output artifacts.",
	];

	pi.registerTool({
		name: "dynamic_workflow",
		label: "Dynamic Workflow",
		description: "Compose and execute a validated workflow of ordered agent, fanout, shell, and artifact phases, or run a saved structured workflow template.",
		promptSnippet: "Compose bounded subagent workflows with agent, fanout, shell, and artifact phases",
		promptGuidelines: guidelines,
		parameters: workflowParametersSchema(),
		prepareArguments: legacySpecToPublic,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const resolved = resolvePublicWorkflowParams(params);
			if (resolved.resumeRunId !== undefined) {
				return executeDynamicWorkflow({ resumeRunId: resolved.resumeRunId, background: resolved.background }, signal, onUpdate, ctx, "");
			}
			const spec = publicWorkflowToLegacySpec(resolved);
			return executeDynamicWorkflow({
				spec,
				cwd: resolved.cwd,
				model: resolved.model,
				background: resolved.background,
				after: resolved.after,
				systemTemplateProvenance: resolved.systemTemplateProvenance,
			}, signal, onUpdate, ctx, "");
		},
	});

	pi.registerTool({
		name: "scripted_workflow",
		label: "Scripted Workflow",
		description: "Execute an advanced unsandboxed JavaScript workflow for loops, branching, tournaments, or custom control flow. Prefer dynamic_workflow for ordinary composition.",
		promptSnippet: "Run advanced unsandboxed JavaScript workflows when declarative dynamic_workflow phases are insufficient",
		promptGuidelines: [
			"Use scripted_workflow only when declarative dynamic_workflow phases cannot express the required control flow; prefer dynamic_workflow for ordinary composition.",
			"scripted_workflow executes arbitrary unsandboxed Node.js and always requires explicit permissions=rwx.",
			"scripted_workflow accepts exactly one of inline script, scriptFile, or a saved self-contained .mjs template.",
			"scripted_workflow provides ctx.phase, ctx.shell, ctx.pi, ctx.fanout, ctx.artifact, ctx.emit, ctx.cancelled(), and ctx.signal.",
		],
		parameters: scriptedWorkflowParametersSchema(),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const resolved = resolveScriptedWorkflowParams(params);
			return executeDynamicWorkflow({ ...resolved, timeout: resolved.timeoutMs }, signal, onUpdate, ctx, "", "scripted");
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
