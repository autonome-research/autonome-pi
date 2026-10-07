// Runner-level contract for the hosted terminal-handoff opt-in: real CLI
// launches against a deterministic local fake reviewer, asserting the exact
// metadata the runners emit and how the existing eligibility gate classifies it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { continuationEligibility } from "../lib/continuation-store.mjs";
import { commitSuccessor, reserveSuccessor } from "../lib/chain-store.mjs";
import {
	EXPLORATION_CLI,
	REVIEW_CLI,
	cancelRun,
	childEnv,
	eligibilityInput,
	findNewRun,
	listRuns,
	makeGitRepo,
	makeProject,
	makeStore,
	runCli,
	waitFor,
} from "./support/hosted-handoff-fixture.mjs";

const SESSION = "hosted-handoff-cli-session";

for (const [cli, marker] of [
	[REVIEW_CLI, "PI_CODE_REVIEW_BACKGROUND"],
	[EXPLORATION_CLI, "PI_CODEBASE_EXPLORATION_BACKGROUND"],
]) {
	for (const value of ["", "0", "false", "1"]) {
		const worker = value === "1";
		const review = cli === REVIEW_CLI;
		const backgroundKind = review ? "session" : "background";
		const argsFor = (cwd) => review ? reviewArgs({ repo: cwd })
			: ["--cwd", cwd, "--agent", "mock", "--dirs", "src", "--delay", "5"];

		test(`${marker}=${JSON.stringify(value)}: validate handoff and notification-only defaults`, () => {
			const cwd = review ? makeGitRepo() : makeProject();
			const store = makeStore();
			const env = childEnv(store, { [marker]: value });
			const result = runCli(cli, [...argsFor(cwd), "--session-id", SESSION, "--continuation", "terminal"], env);
			if (worker) {
				assert.equal(result.status, 0, result.stderr || result.stdout);
				const [run] = listRuns(store);
				assert.equal(run.end.status, "success");
				assert.equal(run.start.metadata.continuationMode, "terminal");
				assert.equal(run.start.trigger.kind, backgroundKind);
			} else {
				assert.equal(result.status, 1, result.stderr || result.stdout);
				assert.match(result.stdout + result.stderr, /requires --background/);
				assert.equal(listRuns(store).length, 0, "reject before creating a run");
			}

			const known = new Set(listRuns(store).map((run) => run.runId));
			const plain = runCli(cli, argsFor(cwd), env);
			assert.equal(plain.status, 0, plain.stderr || plain.stdout);
			const run = findNewRun(store, known);
			assert.equal(run.end.status, "success");
			assert.equal(run.start.metadata.continuationMode, undefined);
			assert.equal(run.start.trigger.kind, worker ? (review ? "post-commit" : "background") : "manual");
		});

		test(`${marker}=${JSON.stringify(value)}: --background detaches only outside a worker`, async () => {
			const cwd = review ? makeGitRepo() : makeProject();
			const store = makeStore();
			const result = runCli(cli, [...argsFor(cwd), "--background", "--session-id", SESSION, "--continuation", "terminal"], childEnv(store, { [marker]: value }));
			assert.equal(result.status, 0, result.stderr || result.stdout);
			const output = JSON.parse(result.stdout);
			// Wait for the owned run even when a later detachment assertion fails.
			const run = await waitFor(() => listRuns(store).find((r) => r.end), "background marker fixture completion");
			assert.equal(run.end.status, "success");
			assert.equal(listRuns(store).length, 1, "worker must not recursively relaunch");
			assert.equal(run.start.metadata.continuationMode, "terminal");
			assert.equal(run.start.trigger.kind, backgroundKind);
			if (worker) {
				assert.equal(output.background, undefined);
				assert.equal(run.start.metadata.pid, result.pid, "worker executes in place");
			} else {
				assert.equal(output.background, true);
				assert.notEqual(output.pid, result.pid);
				assert.equal(run.start.metadata.pid, output.pid, "detached child owns the run");
			}
		});
	}
}

function reviewArgs(store, extra = []) {
	return ["review", "--cwd", store.repo, "--mode", "last_commit", "--json", ...extra];
}

test("hosted background opt-in emits terminal handoff metadata; success and failure are eligible", async () => {
	const repo = makeGitRepo();
	const store = makeStore();
	const known = new Set();
	const launch = runCli(REVIEW_CLI, reviewArgs({ repo }, ["--background", "--session-id", SESSION, "--session-file", "/tmp/session.jsonl", "--continuation", "terminal"]), childEnv(store));
	assert.equal(launch.status, 0, launch.stderr);
	const run = await waitFor(() => findNewRun(store, known, (r) => r.end), "opted-in background review completion");
	known.add(run.runId);
	assert.equal(run.start.metadata.continuationMode, "terminal");
	assert.equal(run.start.metadata.sessionId, SESSION);
	assert.equal(run.start.trigger.kind, "session", "explicit opt-in corrects the misleading post-commit label");
	assert.equal(run.end.status, "success");
	assert.equal(continuationEligibility(eligibilityInput(run)), "eligible");

	// A failed opted-in run still hands off (blocker reporting), never cancellation.
	const fail = runCli(REVIEW_CLI, reviewArgs({ repo }, ["--background", "--session-id", SESSION, "--continuation", "terminal"]), childEnv(store, { PI_FAKE_PI_FAIL: "1" }));
	assert.equal(fail.status, 0, fail.stderr);
	const failedRun = await waitFor(() => findNewRun(store, known, (r) => r.end), "opted-in background review failure");
	assert.equal(failedRun.end.status, "failed");
	assert.equal(failedRun.start.metadata.continuationMode, "terminal");
	assert.equal(continuationEligibility(eligibilityInput(failedRun)), "eligible");
});

test("background without the opt-in stays notification-only and keeps the post-commit label", async () => {
	const repo = makeGitRepo();
	const store = makeStore();
	const launch = runCli(REVIEW_CLI, reviewArgs({ repo }, ["--background", "--session-id", SESSION, "--session-file", "/tmp/session.jsonl"]), childEnv(store));
	assert.equal(launch.status, 0, launch.stderr);
	const run = await waitFor(() => listRuns(store).find((r) => r.end), "unopted background review completion");
	assert.equal(run.start.metadata.continuationMode, undefined);
	assert.equal(run.start.metadata.sessionId, SESSION, "session identity alone is not a handoff decision");
	assert.equal(run.start.trigger.kind, "post-commit");
	assert.equal(continuationEligibility(eligibilityInput(run)), "ineligible");
});

test("the opt-in requires background and an owning session identity", () => {
	const repo = makeGitRepo();
	const store = makeStore();
	const foreground = runCli(REVIEW_CLI, reviewArgs({ repo }, ["--session-id", SESSION, "--continuation", "terminal"]), childEnv(store));
	assert.notEqual(foreground.status, 0);
	assert.match(foreground.stdout + foreground.stderr, /--background/);
	assert.equal(listRuns(store).length, 0, "rejected before a run is created");

	const anonymous = runCli(REVIEW_CLI, reviewArgs({ repo }, ["--background", "--continuation", "terminal"]), childEnv(store));
	assert.notEqual(anonymous.status, 0);
	assert.match(anonymous.stdout + anonymous.stderr, /--session-id/);
	assert.equal(listRuns(store).length, 0);

	const bogus = runCli(REVIEW_CLI, reviewArgs({ repo }, ["--background", "--session-id", SESSION, "--continuation", "always"]), childEnv(store));
	assert.notEqual(bogus.status, 0);
	assert.match(bogus.stdout + bogus.stderr, /--continuation/);
	assert.equal(listRuns(store).length, 0);
});

test("the background environment marker alone does not authorize a handoff", async () => {
	const repo = makeGitRepo();
	const store = makeStore();
	// Simulates the relaunched worker context: marker env plus session args, no flag.
	const result = runCli(REVIEW_CLI, reviewArgs({ repo }, ["--session-id", SESSION, "--session-file", "/tmp/session.jsonl"]), childEnv(store, { PI_CODE_REVIEW_BACKGROUND: "1" }));
	assert.equal(result.status, 0, result.stderr);
	const run = await waitFor(() => listRuns(store).find((r) => r.end), "env-marked review completion");
	assert.equal(run.start.metadata.continuationMode, undefined);
	assert.equal(run.start.trigger.kind, "post-commit");
	assert.equal(continuationEligibility(eligibilityInput(run)), "ineligible");
});

test("the generated post-commit hook stays notification-only even with inherited session env", async () => {
	const repo = makeGitRepo();
	const store = makeStore();
	const install = runCli(REVIEW_CLI, ["install-hook", "--cwd", repo, "--json"], childEnv(store));
	assert.equal(install.status, 0, install.stderr);
	const hookPath = JSON.parse(install.stdout).hookPath;
	const hook = readFileSync(hookPath, "utf8");
	assert.ok(!hook.includes("--continuation"), "generated hook never carries the handoff opt-in");
	assert.ok(!hook.includes("--session-id"), "generated hook never carries session identity");

	const { spawnSync } = await import("node:child_process");
	const hookRun = spawnSync("sh", [hookPath], {
		cwd: repo,
		env: childEnv(store, { PI_SESSION_ID: "inherited-session", PI_SESSION_FILE: "/tmp/inherited.jsonl" }),
	});
	assert.equal(hookRun.status, 0, hookRun.stderr);
	const run = await waitFor(() => listRuns(store).find((r) => r.end), "hook review completion");
	assert.equal(run.start.metadata.continuationMode, undefined);
	assert.equal(run.start.metadata.sessionId, undefined, "inherited PI_SESSION_* is never picked up");
	assert.equal(run.start.trigger.kind, "post-commit");
	assert.equal(continuationEligibility(eligibilityInput(run)), "ineligible");
});

test("cancellation suppresses an opted-in handoff", async () => {
	const repo = makeGitRepo();
	const store = makeStore();
	const launch = runCli(REVIEW_CLI, reviewArgs({ repo }, ["--background", "--session-id", SESSION, "--continuation", "terminal"]), childEnv(store, { PI_FAKE_PI_SLEEP_MS: "30000" }));
	assert.equal(launch.status, 0, launch.stderr);
	const running = await waitFor(() => listRuns(store).find((r) => !r.end), "opted-in review start");
	cancelRun(store, running.runId);
	const run = await waitFor(() => listRuns(store).find((r) => r.runId === running.runId && r.end), "cancelled review end");
	assert.equal(run.end.status, "cancelled");
	assert.equal(run.start.metadata.continuationMode, "terminal");
	assert.equal(continuationEligibility(eligibilityInput(run)), "ineligible", "cancellation never auto-continues");
});

test("a committed successor suppresses an opted-in handoff", async () => {
	const repo = makeGitRepo();
	const store = makeStore();
	const launch = runCli(REVIEW_CLI, reviewArgs({ repo }, ["--background", "--session-id", SESSION, "--continuation", "terminal"]), childEnv(store));
	assert.equal(launch.status, 0, launch.stderr);
	const run = await waitFor(() => listRuns(store).find((r) => r.end), "opted-in review completion");
	assert.equal(continuationEligibility(eligibilityInput(run)), "eligible");
	const previousStore = process.env.PI_THREAD_PHASE_STORE_DIR;
	process.env.PI_THREAD_PHASE_STORE_DIR = store;
	try {
		commitSuccessor(reserveSuccessor(run.runId, `${run.runId}-child`, { chainId: randomUUID() }));
		assert.equal(continuationEligibility(eligibilityInput(run)), "ineligible", "the chain's terminal run owns the handoff");
	} finally {
		if (previousStore === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
		else process.env.PI_THREAD_PHASE_STORE_DIR = previousStore;
	}
});

test("exploration runner: identical opt-in contract over the mock fixture", async () => {
	const project = makeProject();
	const store = makeStore();
	const known = new Set();
	const base = ["--cwd", project, "--agent", "mock", "--dirs", "src", "--delay", "5"];

	const opted = runCli(EXPLORATION_CLI, [...base, "--background", "--session-id", SESSION, "--session-file", "/tmp/session.jsonl", "--continuation", "terminal"], childEnv(store));
	assert.equal(opted.status, 0, opted.stderr);
	const run = await waitFor(() => findNewRun(store, known, (r) => r.end), "opted-in exploration completion");
	known.add(run.runId);
	assert.equal(run.start.metadata.continuationMode, "terminal");
	assert.equal(run.start.metadata.sessionId, SESSION);
	assert.equal(run.end.status, "success");
	assert.equal(continuationEligibility(eligibilityInput(run)), "eligible");

	const plain = runCli(EXPLORATION_CLI, [...base, "--background", "--session-id", SESSION], childEnv(store));
	assert.equal(plain.status, 0, plain.stderr);
	const plainRun = await waitFor(() => findNewRun(store, known, (r) => r.end), "unopted exploration completion");
	assert.equal(plainRun.start.metadata.continuationMode, undefined);
	assert.equal(continuationEligibility(eligibilityInput(plainRun)), "ineligible");

	const foreground = runCli(EXPLORATION_CLI, [...base, "--session-id", SESSION, "--continuation", "terminal"], childEnv(store));
	assert.notEqual(foreground.status, 0);
	assert.match(foreground.stderr, /--background/);

	const anonymous = runCli(EXPLORATION_CLI, [...base, "--background", "--continuation", "terminal"], childEnv(store));
	assert.notEqual(anonymous.status, 0);
	assert.match(anonymous.stderr, /--session-id/);
});

test("exploration env marker and inherited session env do not authorize a handoff", async () => {
	const project = makeProject();
	const store = makeStore();
	const result = runCli(EXPLORATION_CLI, ["--cwd", project, "--agent", "mock", "--dirs", "src", "--delay", "5", "--session-id", SESSION], childEnv(store, {
		PI_CODEBASE_EXPLORATION_BACKGROUND: "1",
		PI_SESSION_ID: "inherited-session",
	}));
	assert.equal(result.status, 0, result.stderr);
	const run = await waitFor(() => listRuns(store).find((r) => r.end), "env-marked exploration completion");
	assert.equal(run.start.metadata.continuationMode, undefined);
	assert.equal(continuationEligibility(eligibilityInput(run)), "ineligible");
});
