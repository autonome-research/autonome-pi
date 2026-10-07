// Wrapper-level contract: the real extension entry points decide the handoff
// opt-in from host mode and session identity, then the real runner executes.
// Covers tool and slash-command paths for both workflows.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { continuationEligibility } from "../lib/continuation-store.mjs";
import codeReviewWorkflow from "../../code-review-workflow/index.ts";
import codebaseExplorationWorkflow from "../../codebase-exploration-workflow/index.ts";
import {
	FAKE_PI,
	eligibilityInput,
	makeGitRepo,
	makeProject,
	makeStore,
	waitFor,
} from "./support/hosted-handoff-fixture.mjs";
import { listRuns } from "./support/hosted-handoff-fixture.mjs";

function fakeHost() {
	const tools = new Map();
	const commands = new Map();
	const listeners = new Map();
	const pi = {
		registerTool: (definition) => tools.set(definition.name, definition),
		registerCommand: (name, definition) => commands.set(name, definition),
		on: (name, fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
		registerShortcut: () => {},
	};
	codeReviewWorkflow(pi);
	codebaseExplorationWorkflow(pi);
	// Real Pi fires session_start before any tool/command call, and both
	// extensions default an arg-less command's cwd from it. Fire it explicitly
	// so these tests do not depend on the test runner's own cwd being a git
	// repository (it is not one in a .git-less source snapshot).
	const sessionStart = (cwd) => {
		for (const fn of listeners.get("session_start") ?? []) fn({}, { cwd });
	};
	return { tools, commands, sessionStart };
}

function ctxFor(mode, cwd, sessionId) {
	return {
		cwd,
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => (sessionId ? join(cwd, `${sessionId}.jsonl`) : undefined),
		},
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
		signal: new AbortController().signal,
	};
}

function withStore(store, fn) {
	const previous = process.env.PI_THREAD_PHASE_STORE_DIR;
	const previousPi = process.env.PI_CODE_REVIEW_PI_BIN;
	process.env.PI_THREAD_PHASE_STORE_DIR = store;
	process.env.PI_CODE_REVIEW_PI_BIN = FAKE_PI;
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			if (previous === undefined) delete process.env.PI_THREAD_PHASE_STORE_DIR;
			else process.env.PI_THREAD_PHASE_STORE_DIR = previous;
			if (previousPi === undefined) delete process.env.PI_CODE_REVIEW_PI_BIN;
			else process.env.PI_CODE_REVIEW_PI_BIN = previousPi;
		});
}

// Each case owns a unique session id so completion polling is exact.
async function completedRun(store, label, sessionId) {
	return waitFor(() => listRuns(store).find((run) => run.end && run.start.metadata?.sessionId === sessionId), label);
}

async function assertHandoff(store, label, sessionId, expected) {
	const run = await completedRun(store, label, sessionId);
	assert.equal(run.start.metadata.continuationMode, expected ? "terminal" : undefined, `${label}: ${JSON.stringify(run.start.metadata)}`);
	assert.equal(continuationEligibility(eligibilityInput(run)), expected ? "eligible" : "ineligible", label);
	return run;
}

test("tool launches: handoff opt-in only for hosted interactive background runs", { timeout: 120_000 }, async () => {
	const { tools } = fakeHost();
	const review = tools.get("code_review_workflow");
	const explore = tools.get("codebase_exploration_workflow");
	const repo = makeGitRepo();
	const project = makeProject();
	const store = makeStore();

	await withStore(store, async () => {
		// Hosted TUI/RPC background runs opt in through both tools.
		for (const mode of ["tui", "rpc"]) {
			const reviewId = `wrapper-${mode}-review`;
			const result = await review.execute("call", { action: "review", cwd: repo, background: true }, undefined, undefined, ctxFor(mode, repo, reviewId));
			assert.match(result.content[0].text, /background/i);
			await assertHandoff(store, `${mode} background review`, reviewId, true);

			const exploreId = `wrapper-${mode}-explore`;
			await explore.execute("call", { cwd: project, dirs: "src", agent: "mock", delay: 5, background: true }, undefined, undefined, ctxFor(mode, project, exploreId));
			await assertHandoff(store, `${mode} background exploration`, exploreId, true);
		}

		// Print/JSON worker contexts and missing session identity never opt in.
		for (const mode of ["json", "print"]) {
			const reviewId = `wrapper-${mode}-review`;
			await review.execute("call", { action: "review", cwd: repo, background: true }, undefined, undefined, ctxFor(mode, repo, reviewId));
			await assertHandoff(store, `${mode} background review`, reviewId, false);

			const exploreId = `wrapper-${mode}-explore`;
			await explore.execute("call", { cwd: project, dirs: "src", agent: "mock", delay: 5, background: true }, undefined, undefined, ctxFor(mode, project, exploreId));
			await assertHandoff(store, `${mode} background exploration`, exploreId, false);
		}

		// A hosted background launch without an originating session id never opts in.
		await review.execute("call", { action: "review", cwd: repo, background: true }, undefined, undefined, ctxFor("tui", repo, undefined));
		const anonymous = await waitFor(
			() => listRuns(store).find((run) => run.end && run.start.workflow === "code-review" && !run.start.metadata?.sessionId),
			"anonymous background review",
		);
		assert.equal(anonymous.start.metadata.continuationMode, undefined);
		assert.equal(continuationEligibility(eligibilityInput(anonymous)), "ineligible");

		// Foreground returns to the caller directly and never opts in.
		const foregroundId = "wrapper-foreground-review";
		const foreground = await review.execute("call", { action: "review", cwd: repo }, undefined, undefined, ctxFor("tui", repo, foregroundId));
		assert.match(foreground.content[0].text, /Code review complete/);
		await assertHandoff(store, "foreground review", foregroundId, false);
	});
});

test("command launches: /code-review stays foreground; /codebase-explore background opts in", { timeout: 120_000 }, async () => {
	const { commands, sessionStart } = fakeHost();
	const repo = makeGitRepo();
	const project = makeProject();
	const store = makeStore();

	await withStore(store, async () => {
		// The review slash command runs foreground: notification/card only.
		sessionStart(repo);
		await commands.get("code-review").handler("", ctxFor("tui", repo, "wrapper-cmd-review"));
		const reviewRun = await assertHandoff(store, "slash command review", "wrapper-cmd-review", false);
		assert.equal(reviewRun.start.trigger.kind, "manual");

		// The exploration slash command defaults to hosted background: opts in.
		sessionStart(project);
		await commands.get("codebase-explore").handler("--agent mock --dirs src --delay 5", ctxFor("tui", project, "wrapper-cmd-explore"));
		await assertHandoff(store, "slash command background exploration", "wrapper-cmd-explore", true);

		// Explicit --foreground suppresses the opt-in.
		await commands.get("codebase-explore").handler("--foreground --agent mock --dirs src --delay 5", ctxFor("tui", project, "wrapper-cmd-explore-fg"));
		await assertHandoff(store, "slash command foreground exploration", "wrapper-cmd-explore-fg", false);
	});
});
