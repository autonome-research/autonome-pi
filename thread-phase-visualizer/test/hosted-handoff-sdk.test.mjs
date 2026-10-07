// End-to-end: runs emitted by the REAL code-review / codebase-exploration
// runners (deterministic local fixtures, no provider) reach the visualizer's
// existing marked-handoff/model-turn path exactly when the explicit opt-in
// metadata is present. Run against installed Pi via PI_HANDOFF_SDK_DIR.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { findPackageJSON } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
	EXPLORATION_CLI,
	FAKE_PI,
	REVIEW_CLI,
	cancelRun,
	listRuns,
	makeGitRepo,
	makeProject,
	makeStore,
	waitFor,
} from "./support/hosted-handoff-fixture.mjs";

const sdkDir = process.env.PI_HANDOFF_SDK_DIR;
test("hosted opt-in completions reach the marked handoff; mismatched owners, cancellation and cards do not", { skip: !sdkDir, timeout: 90_000 }, async () => {
	const root = makeStore("hosted-handoff-sdk-");
	const agentDir = join(root, "agent"), storeDir = join(root, "store"), sessionDir = join(root, "sessions");
	for (const path of [agentDir, storeDir, sessionDir]) mkdirSync(path);
	process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
	process.env.PI_THREAD_PHASE_STATUS_BRIDGE = "0";
	const repo = makeGitRepo();
	const project = makeProject();
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(sdkDir, "dist/index.js")));
	const aiDir = dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(sdkDir, "package.json"))));
	const { createAssistantMessageEventStream } = await import(pathToFileURL(join(aiDir, "dist/index.js")));
	const receipts = await import("../lib/continuation-store.mjs");
	const { sessionHistoryHasRunContinuation } = await import("../lib/continuation-message.mjs");
	writeFileSync(join(agentDir, "auth.json"), "{}");
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "handoff-fixture": {
		api: "openai-completions", baseUrl: "https://fixture.invalid", apiKey: "fixture-only",
		models: [{ id: "local" }],
	} } }));
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
	const model = runtime.getModel("handoff-fixture", "local");
	assert.ok(model);
	let requests = 0, release, session, manager;
	const errors = [];
	const manager0 = SessionManager.create(root, sessionDir);
	const sessionId = manager0.getSessionId();
	const sessionFile = manager0.getSessionFile();
	const launch = (script, args, extraEnv = {}) => {
		const env = { ...process.env, PI_THREAD_PHASE_STORE_DIR: storeDir, PI_CODE_REVIEW_PI_BIN: FAKE_PI, ...extraEnv };
		delete env.PI_CODE_REVIEW_BACKGROUND;
		delete env.PI_CODEBASE_EXPLORATION_BACKGROUND;
		const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env, timeout: 60_000 });
		assert.equal(result.status, 0, result.stderr || result.stdout);
	};
	const reviewArgs = (id, extra = []) => ["review", "--cwd", repo, "--mode", "last_commit", "--json", "--background", "--session-id", id, "--session-file", sessionFile, ...extra];
	const exploreArgs = (id, extra = []) => ["--cwd", project, "--agent", "mock", "--dirs", "src", "--delay", "5", "--background", "--session-id", id, "--session-file", sessionFile, ...extra];
	const known = new Set();
	const completedRun = (id, label, workflow) => waitFor(
		() => listRuns(storeDir).find((run) => run.end && !known.has(run.runId)
			&& run.start.metadata?.sessionId === id && (!workflow || run.start.workflow === workflow)),
		label,
	);
	const pending = (runId) => receipts.loadPendingContinuationRecords({ storeDir }).find((record) => record.runId === runId);
	const userTextFor = (runId) => manager.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "user")
		.map((entry) => entry.message.content?.map?.((part) => part.text).join("\n") || "")
		.find((text) => text.includes(runId));
	try {
		manager = manager0;
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
			systemPrompt: "Offline handoff fixture", appendSystemPrompt: [] });
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model,
			sessionManager: manager, settingsManager, resourceLoader, tools: [] }));
		session.agent.streamFunction = () => {
			requests++;
			const stream = createAssistantMessageEventStream();
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "text", text: "Offline fixture response" }], stopReason: "stop", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const finish = () => { stream.push({ type: "done", reason: "stop", message }); stream.end(); };
			if (requests === 1) release = finish;
			else queueMicrotask(finish);
			return stream;
		};
		await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });

		// Busy agent: an opted-in failed review waits durably, then hands off once.
		const initial = session.prompt("fixture: remain busy until released");
		await waitFor(() => release, "busy turn started");
		launch(REVIEW_CLI, reviewArgs(sessionId, ["--continuation", "terminal"]), { PI_FAKE_PI_FAIL: "1" });
		const failed = await completedRun(sessionId, "opted-in failed review", "code-review");
		known.add(failed.runId);
		assert.equal(failed.end.status, "failed");
		await waitFor(() => pending(failed.runId), "failed run continuation queued while busy");
		assert.equal(requests, 1, "no delivery while the agent is busy");
		release();
		await initial;
		await waitFor(() => requests >= 2 && session.isIdle, "failure handoff delivered once idle");
		assert.equal(requests, 2, "one user turn plus one handoff; the completion card must not trigger another turn");
		assert.ok(sessionHistoryHasRunContinuation(manager.getEntries(), failed.runId, sessionId));
		const failurePrompt = userTextFor(failed.runId);
		assert.match(failurePrompt, /Report the blocker and available partial results/);
		assert.match(failurePrompt, /requires the user's authorization/, "failure handoff never authorizes restart/recovery");

		// Idle agent: an opted-in successful exploration hands off.
		launch(EXPLORATION_CLI, exploreArgs(sessionId, ["--continuation", "terminal"]));
		const explored = await completedRun(sessionId, "opted-in exploration", "codebase-exploration");
		known.add(explored.runId);
		assert.equal(explored.end.status, "success");
		await waitFor(() => requests >= 3 && session.isIdle, "success handoff delivered");
		assert.ok(sessionHistoryHasRunContinuation(manager.getEntries(), explored.runId, sessionId));
		await delay(250);
		assert.equal(requests, 3, "completion cards never trigger an extra turn");

		// A run owned by another session is eligible in the store but is never
		// claimed or delivered here.
		launch(REVIEW_CLI, reviewArgs("foreign-session", ["--continuation", "terminal"]));
		const foreign = await completedRun("foreign-session", "foreign-owned review", "code-review");
		known.add(foreign.runId);
		assert.equal(foreign.start.metadata.continuationMode, "terminal");
		await delay(400);
		assert.equal(requests, 3);
		assert.equal(pending(foreign.runId), undefined, "foreign runs are never claimed");

		// Cancellation suppresses the handoff even with the opt-in.
		launch(REVIEW_CLI, reviewArgs(sessionId, ["--continuation", "terminal"]), { PI_FAKE_PI_SLEEP_MS: "30000" });
		const running = await waitFor(
			() => listRuns(storeDir).find((run) => !run.end && !known.has(run.runId) && run.start.metadata?.sessionId === sessionId && run.start.metadata?.continuationMode === "terminal"),
			"cancel-target review start",
		);
		cancelRun(storeDir, running.runId);
		const cancelled = await waitFor(
			() => listRuns(storeDir).find((run) => run.runId === running.runId && run.end),
			"cancelled review end",
		);
		assert.equal(cancelled.end.status, "cancelled");
		await delay(400);
		assert.equal(requests, 3, "cancelled runs never auto-continue");
		assert.equal(pending(cancelled.runId), undefined);
		assert.deepEqual(errors, []);
	} finally {
		release?.();
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
			session.dispose();
		}
	}
});
