// Shared offline fixtures for hosted terminal-handoff opt-in tests.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
export const REVIEW_CLI = join(REPO_ROOT, "code-review-workflow", "bin", "code-review-workflow.mjs");
export const EXPLORATION_CLI = join(REPO_ROOT, "codebase-exploration-workflow", "bin", "codebase-exploration-workflow.mjs");
export const FAKE_PI = join(REPO_ROOT, "thread-phase-visualizer", "test", "support", "fake-pi-reviewer.mjs");

export function makeGitRepo(prefix = "handoff-repo-") {
	const repo = mkdtempSync(join(tmpdir(), prefix));
	for (const args of [["init", "-q"], ["config", "user.email", "fixture@example.com"], ["config", "user.name", "Fixture"]]) {
		const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
		if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
	}
	writeFileSync(join(repo, "file.txt"), "fixture change\n", "utf8");
	const add = spawnSync("git", ["add", "."], { cwd: repo, encoding: "utf8" });
	if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);
	const commit = spawnSync("git", ["commit", "-q", "-m", "fixture commit"], { cwd: repo, encoding: "utf8" });
	if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
	return repo;
}

export function makeProject(prefix = "handoff-project-") {
	const project = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(join(project, "src"), { recursive: true });
	writeFileSync(join(project, "src", "index.js"), "export const fixture = 1;\n", "utf8");
	return project;
}

export function makeStore(prefix = "handoff-store-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Child environment: the validated isolated env plus an explicit store and fake reviewer. */
export function childEnv(store, extra = {}) {
	const env = { ...process.env, PI_THREAD_PHASE_STORE_DIR: store, PI_CODE_REVIEW_PI_BIN: FAKE_PI };
	delete env.PI_CODE_REVIEW_BACKGROUND;
	delete env.PI_CODEBASE_EXPLORATION_BACKGROUND;
	delete env.PI_FAKE_PI_FAIL;
	delete env.PI_FAKE_PI_SLEEP_MS;
	for (const [key, value] of Object.entries(extra)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

export function runCli(script, args, env) {
	return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env, timeout: 120_000 });
}

export function listRuns(store) {
	const dir = join(store, "runs");
	if (!existsSync(dir)) return [];
	const runs = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const events = readFileSync(join(dir, name), "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
			try { return JSON.parse(line); } catch { return undefined; }
		}).filter(Boolean);
		const start = events.find((event) => event.type === "workflow_start");
		const end = events.find((event) => event.type === "workflow_end");
		if (start) runs.push({ runId: start.runId, start, end, events });
	}
	return runs;
}

export function findNewRun(store, known, predicate = () => true) {
	return listRuns(store).find((run) => !known.has(run.runId) && predicate(run));
}

export async function waitFor(predicate, message, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = predicate();
		if (value) return value;
		await delay(25);
	}
	throw new Error(`Timed out waiting: ${message}`);
}

export function cancelRun(store, runId, reason = "test cancellation") {
	mkdirSync(join(store, "cancel"), { recursive: true });
	writeFileSync(join(store, "cancel", `${runId}.json`), JSON.stringify({ runId, requestedAt: new Date().toISOString(), reason }), { mode: 0o600 });
}

/** continuationEligibility input built from the runner's own emitted events. */
export function eligibilityInput(run, status) {
	return { runId: run.runId, normalizedStatus: status || run.end?.status, metadata: run.start.metadata };
}
