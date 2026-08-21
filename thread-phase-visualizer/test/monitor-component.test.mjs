import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import test from "node:test";

const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);
const { ThreadPhaseMonitorComponent, createArtifactTargetEditorCallback } = await import("../components/monitor.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

const theme = {
  fg(_color, value) { return String(value); },
  bold(value) { return String(value); },
};

function run(overrides = {}) {
  return {
    runId: "run-alpha",
    workflow: "Alpha Build",
    normalizedStatus: "success",
    status: "success",
    cwd: "/repo",
    updatedAt: "2026-01-01T00:00:00.000Z",
    phases: [{ phase: "compile", normalizedStatus: "success", status: "success" }],
    artifacts: [{ kind: "markdown", title: "Build report", content: "line-1\nline-2" }],
    errors: [],
    ...overrides,
  };
}

function component(runs) {
  return new ThreadPhaseMonitorComponent("/repo", undefined, theme, () => {}, () => {}, () => {}, () => runs);
}

// A completed phase with one generated artifact nested under it (the tree viewer
// reads artifacts from phase.artifacts / stage.artifacts, not run.artifacts).
function runWithPhaseArtifact(artifact, phaseName = "compile") {
  return run({
    phases: [{ phase: phaseName, normalizedStatus: "success", status: "success", artifacts: [artifact] }],
    artifacts: [],
  });
}

// phases terminated with a completed fanout phase carrying `count` stages.
function fanoutPhases(count, phaseIndex) {
  const phases = [
    { phase: "p1", normalizedStatus: "success", status: "success" },
    { phase: "fanout", normalizedStatus: "success", status: "success", fanout: { total: count, completed: count, failed: 0, running: 0, items: Array.from({ length: count }, (_, index) => ({
        itemId: `item-${index}`, label: `item-${String.fromCharCode(97 + index)}`, index, normalizedStatus: "success", status: "success",
      })) } },
    { phase: "p3", normalizedStatus: "success", status: "success" },
  ];
  if (phaseIndex === undefined) return phases;
  return phases.slice(0, phaseIndex).concat(phases[phaseIndex]).concat(phases.slice(phaseIndex + 1));
}

function text(lines) {
  return lines.join("\n");
}

test("monitor renders a consistently framed Thread-phase panel", () => {
  const width = 64;
  const lines = component([run()]).render(width);
  assert.match(lines[0], /^╭.* Thread-phase .*╮$/);
  assert.match(lines.at(-1), /^╰─+╯$/);
  assert.ok(lines.slice(1, -1).every((line) => line.startsWith("│ ") && line.endsWith(" │")));
  assert.ok(lines.every((line) => visibleWidth(line) === width));
  assert.match(text(lines), /↑↓ select/);
});

test("monitor detail renders canonical owner metadata and stale reason", () => {
  const monitor = component([run({
    normalizedStatus: "running",
    status: "running",
    stale: { reason: "heartbeat_stale", ageMs: 600000 },
    metadata: { sessionId: "session-42", launchSource: "background", cwdAtLaunch: "/repo-at-launch" },
  })]);
  monitor.handleInput("\r");
  const detail = text(monitor.render(100));
  assert.match(detail, /\[STALE\] heartbeat_stale/);
  // Owner telemetry (sessionId / cwd at launch) is dropped as low-signal (audit MUST).
  assert.doesNotMatch(detail, /sessionId: session-42|cwd at launch|launch source/);
});

test("dashboard detail shows aggregate duration and total tokens without timestamp or token breakdown noise", () => {
  const monitor = component([run({
    normalizedStatus: "success",
    status: "success",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T01:02:03.000Z",
    usage: { entries: 2, inputTokens: 8000, outputTokens: 750, totalTokens: 8750, cachedInputTokens: 4000, models: { "test/model": {} } },
    phases: [{
      phase: "compile",
      normalizedStatus: "success",
      status: "success",
      startedAt: "2026-01-01T00:01:00.000Z",
      endedAt: "2026-01-01T00:03:03.000Z",
      updatedAt: "2026-01-01T00:03:03.000Z",
      lastMessage: "compile success",
      model: "provider/inference-model",
      usage: { entries: 1, inputTokens: 1000, outputTokens: 250, totalTokens: 1250, reasoningTokens: 100 },
    }],
  })]);

  const list = text(monitor.render(100));
  assert.match(list, /1h 2m · 8\.8K tok/);

  monitor.handleInput("\r");
  monitor.handleInput("\r");
  const detail = text(monitor.render(100));
  assert.match(detail, /duration: 1h 2m /);
  assert.match(detail, /tokens: 8\.8K tok/);
  assert.match(detail, /duration: 2m 3s/);
  assert.match(detail, /tokens: 1\.3K tok/);
  assert.match(detail, /compile — provider\/inference-model/);
  assert.doesNotMatch(detail, /compile success|started:|ended:|updated:|8K in|750 out|cached|reasoning|test\/model/);
});

test("dashboard prefers observed inference models over a configured model pattern", () => {
  const monitor = component([run({ normalizedStatus: "running", status: "running", phases: [{
    phase: "review",
    normalizedStatus: "success",
    status: "success",
    model: "configured/pattern",
    usage: { entries: 2, models: { "actual/model-a": {}, "actual/model-b": {} } },
  }] })]);
  assert.match(text(monitor.render(100)), /review · actual\/model-a \+1/);
  monitor.handleInput("\r");
  const detail = text(monitor.render(100));
  assert.match(detail, /review — actual\/model-a \+1/);
  assert.doesNotMatch(detail, /configured\/pattern/);
});

test("h toggles the monitor stale-run filter and escape restores stale runs", () => {
  const monitor = component([
    run({ runId: "stale-run", workflow: "Stale Run", normalizedStatus: "running", status: "running", stale: { reason: "pid_not_running" } }),
    run({ runId: "fresh-run", workflow: "Fresh Run", normalizedStatus: "running", status: "running" }),
  ]);
  monitor.handleInput("h");
  let rendered = text(monitor.render(90));
  assert.match(rendered, /stale:hidden/);
  assert.match(rendered, /Fresh Run/);
  assert.doesNotMatch(rendered, /Stale Run/);
  monitor.handleInput("\x1b");
  rendered = text(monitor.render(90));
  // With no active filter the summary line is hidden; stale runs are restored.
  assert.doesNotMatch(rendered, /stale:/);
  assert.match(rendered, /Stale Run/);
});

test("handleInput transitions list to detail to nested artifact and left returns toward list", () => {
  const monitor = component([runWithPhaseArtifact({ kind: "markdown", title: "Build report", content: "line-1\nline-2" })]);
  monitor.handleInput("\r");
  assert.match(text(monitor.render(72)), /Phases/);
  assert.doesNotMatch(text(monitor.render(72)), /Thread-phase monitor/);

  // Expand the compile phase to reveal its nested artifact, then open it.
  monitor.handleInput("\r");
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\r");
  const artifact = text(monitor.render(72));
  assert.match(artifact, /Build report/);
  assert.match(artifact, /line-1/);
  assert.match(artifact, /↑↓ line/);

  monitor.handleInput("\x1b[D");
  assert.match(text(monitor.render(72)), /Phases/);
  monitor.handleInput("\x1b[D");
  assert.match(text(monitor.render(72)), /↑↓ select/);
});

test("artifact c action delivers path and URL targets through the monitor callback", () => {
  for (const [artifact, expectedTarget] of [
    [{ kind: "file", title: "Local report", path: "/repo/report.txt", content: "local report" }, "/repo/report.txt"],
    [{ kind: "url", title: "Remote report", url: "https://example.test/report", content: "remote report" }, "https://example.test/report"],
  ]) {
    const delivered = [];
    const monitor = new ThreadPhaseMonitorComponent(
      "/repo",
      undefined,
      theme,
      () => {},
      () => {},
      (target) => delivered.push(target),
      () => [runWithPhaseArtifact(artifact)],
    );

    monitor.handleInput("\r");
    monitor.handleInput("\r");
    monitor.handleInput("\x1b[B");
    monitor.handleInput("\r");
    const rendered = text(monitor.render(80));
    assert.match(rendered, /c send target to editor/);
    assert.doesNotMatch(rendered, /no actionable target/);

    monitor.handleInput("c");
    assert.deepEqual(delivered, [expectedTarget]);
  }
});

test("artifact editor callback sends the monitor's trimmed target to setEditorText", () => {
  const editorTargets = [];
  const notifications = [];
  let closeCount = 0;
  const ctx = {
    ui: {
      setEditorText(target) { editorTargets.push(target); },
      notify(message, level) { notifications.push([message, level]); },
    },
  };
  const monitor = new ThreadPhaseMonitorComponent(
    "/repo",
    undefined,
    theme,
    () => {},
    () => {},
    createArtifactTargetEditorCallback(ctx, () => { closeCount++; }),
    () => [runWithPhaseArtifact({ kind: "file", title: "Editor report", path: "  /repo/editor-report.txt  ", content: "report" })],
  );

  monitor.handleInput("\r");
  monitor.handleInput("\r");
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\r");
  monitor.handleInput("c");

  assert.deepEqual(editorTargets, ["/repo/editor-report.txt"]);
  assert.deepEqual(notifications, [["Artifact target sent to editor.", "info"]]);
  assert.equal(closeCount, 1);
});

test("inline-only artifact c action is a no-op and renders no actionable hint", () => {
  const delivered = [];
  const monitor = new ThreadPhaseMonitorComponent(
    "/repo",
    undefined,
    theme,
    () => {},
    () => {},
    (target) => delivered.push(target),
    () => [runWithPhaseArtifact({ kind: "markdown", title: "Inline report", content: "inline body" })],
  );

  monitor.handleInput("\r");
  monitor.handleInput("\r");
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\r");
  const rendered = text(monitor.render(100));
  assert.match(rendered, /no actionable target \(inline\/preview only\)/);
  assert.doesNotMatch(rendered, /c send target to editor|copy|open/);

  monitor.handleInput("c");
  assert.deepEqual(delivered, []);
  assert.match(text(monitor.render(100)), /inline body/);
});

test("live trace pane renders for a running phase and degrades without recentItems", () => {
  const monitor = component([run({
    normalizedStatus: "running",
    status: "running",
    phases: [{
      phase: "review",
      normalizedStatus: "running",
      status: "running",
      lastMessage: "review running",
      recentItems: [
        { type: "content_delta", contentType: "thinking", delta: "deep reasoning" },
        { type: "tool_call_started", toolCallId: "tc1" },
        { type: "tool_call_completed", toolName: "bash", args: "{\"cmd\":\"ls\"}" },
      ],
    }],
    artifacts: [],
  })]);

  monitor.handleInput("\r");
  monitor.handleInput("\r"); // expand the running phase
  const trace = text(monitor.render(100));
  assert.match(trace, /trace:/);
  assert.match(trace, /deep reasoning/);
  assert.match(trace, /bash/);
  assert.doesNotMatch(trace, /review running/); // live reasoning shown, not stale message alone

  // A running phase with no recentItems degrades gracefully to status/lastMessage.
  const empty = component([run({
    normalizedStatus: "running",
    status: "running",
    phases: [{ phase: "solo", normalizedStatus: "running", status: "running", lastMessage: "working hard" }],
    artifacts: [],
  })]);
  empty.handleInput("\r");
  empty.handleInput("\r");
  assert.doesNotThrow(() => text(empty.render(100)));
  assert.match(text(empty.render(100)), /solo/);
});

test("search input filters mock runs and escape restores the full list", () => {
  const monitor = component([
    run(),
    run({ runId: "run-beta", workflow: "Beta Review", normalizedStatus: "failed", status: "failed" }),
  ]);
  monitor.handleInput("/");
  for (const character of "bEtA") monitor.handleInput(character);
  monitor.handleInput("\r");
  const filtered = text(monitor.render(80));
  assert.match(filtered, /Beta Review/);
  assert.doesNotMatch(filtered, /Alpha Build/);
  assert.match(filtered, /search:bEtA/);

  monitor.handleInput("\x1b");
  const cleared = text(monitor.render(80));
  assert.match(cleared, /Alpha Build/);
  assert.match(cleared, /Beta Review/);
  // With no active filter the summary line is hidden entirely (signal dedup).
  assert.doesNotMatch(cleared, /Filter:|search:|status:|stale:/);
});

test("clear actions restore the unfiltered list from every mode and reset selection", () => {
  const monitor = component([
    run({ normalizedStatus: "running", status: "running" }),
    run({
      runId: "run-beta",
      workflow: "Beta Review",
      normalizedStatus: "success",
      status: "success",
      artifacts: [],
      phases: [{ phase: "compile", normalizedStatus: "success", status: "success", artifacts: [{ kind: "markdown", title: "Build report", content: "build-body" }] }],
    }),
  ]);

  monitor.handleInput("/");
  for (const character of "beta") monitor.handleInput(character);
  monitor.handleInput("\r");
  assert.match(text(monitor.render(80)), /› ✓ Beta Review/);
  monitor.handleInput("b");
  let cleared = text(monitor.render(80));
  assert.match(cleared, /↑↓ select/);
  assert.match(cleared, /Alpha Build/);
  assert.match(cleared, /› .* Alpha Build/);

  monitor.handleInput("/");
  for (const character of "beta") monitor.handleInput(character);
  monitor.handleInput("\x1b");
  cleared = text(monitor.render(80));
  assert.match(cleared, /Alpha Build/);
  assert.match(cleared, /Beta Review/);
  assert.match(cleared, /› .* Alpha Build/);

  monitor.handleInput("/");
  for (const character of "beta") monitor.handleInput(character);
  monitor.handleInput("\r");
  monitor.handleInput("\r");
  assert.match(text(monitor.render(80)), /Phases/);
  monitor.handleInput("\x1b");
  cleared = text(monitor.render(80));
  assert.match(cleared, /↑↓ select/);
  assert.match(cleared, /Alpha Build/);
  assert.match(cleared, /› .* Alpha Build/);

  // Open a nested artifact (expand compile, select the artifact, enter) in
  // artifact mode, then clear back to the unfiltered list.
  monitor.handleInput("/");
  for (const character of "beta") monitor.handleInput(character);
  monitor.handleInput("\r");
  monitor.handleInput("\r");
  monitor.handleInput("\r");
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\r");
  assert.match(text(monitor.render(80)), /Build report/);
  monitor.handleInput("b");
  cleared = text(monitor.render(80));
  assert.match(cleared, /↑↓ select/);
  assert.match(cleared, /Alpha Build/);
  assert.match(cleared, /› .* Alpha Build/);
});

test("escape and back keys navigate consistently in list, detail, and artifact modes", () => {
  for (const key of ["\x1b", "b", "\x1b[D"]) {
    let closeCount = 0;
    const makeMonitor = () => new ThreadPhaseMonitorComponent(
      "/repo",
      undefined,
      theme,
      () => { closeCount++; },
      () => {},
      () => {},
      () => [runWithPhaseArtifact({ kind: "file", title: "Build report", path: "/repo/build.txt", content: "report body" })],
    );

    const listMonitor = makeMonitor();
    listMonitor.handleInput(key);
    assert.equal(closeCount, 1, `${JSON.stringify(key)} closes from list`);

    closeCount = 0;
    const detailMonitor = makeMonitor();
    detailMonitor.handleInput("\r");
    detailMonitor.handleInput(key);
    assert.match(text(detailMonitor.render(80)), /↑↓ select/);
    assert.equal(closeCount, 0, `${JSON.stringify(key)} returns from detail without closing`);

    const artifactMonitor = makeMonitor();
    artifactMonitor.handleInput("\r");
    artifactMonitor.handleInput("\r");
    artifactMonitor.handleInput("\x1b[B");
    artifactMonitor.handleInput("\r");
    artifactMonitor.handleInput(key);
    const rendered = text(artifactMonitor.render(80));
    assert.match(rendered, /Phases/);
    assert.doesNotMatch(rendered, /↑↓ line/);
    assert.equal(closeCount, 0, `${JSON.stringify(key)} returns from artifact without closing`);
  }
});

test("selection follows runId across sorting changes and live reloads", () => {
  let runs = [
    run({ runId: "run-alpha", workflow: "Alpha Build", normalizedStatus: "success", status: "success", updatedAt: "2026-01-03T00:00:00.000Z" }),
    run({ runId: "run-beta", workflow: "Beta Review", normalizedStatus: "failed", status: "failed", updatedAt: "2026-01-02T00:00:00.000Z" }),
  ];
  const monitor = new ThreadPhaseMonitorComponent("/repo", undefined, theme, () => {}, () => {}, () => {}, () => runs);

  monitor.render(80);
  monitor.handleInput("\x1b[B");
  assert.match(text(monitor.render(80)), /› ✓ Alpha Build/);

  monitor.handleInput("s");
  assert.match(text(monitor.render(80)), /› ✓ Alpha Build/);

  runs = [
    ...runs,
    run({ runId: "run-gamma", workflow: "Gamma Test", updatedAt: "2026-01-04T00:00:00.000Z" }),
  ];
  monitor.invalidate();
  assert.match(text(monitor.render(80)), /› ✓ Alpha Build/);
});

test("detail view keeps the selected run when a matching run is inserted ahead", () => {
  let runs = [
    run({ runId: "run-alpha", workflow: "Alpha Review", updatedAt: "2026-01-03T00:00:00.000Z" }),
    run({ runId: "run-beta", workflow: "Beta Review", updatedAt: "2026-01-02T00:00:00.000Z" }),
  ];
  const monitor = new ThreadPhaseMonitorComponent("/repo", undefined, theme, () => {}, () => {}, () => {}, () => runs);

  monitor.handleInput("/");
  for (const character of "review") monitor.handleInput(character);
  monitor.handleInput("\r");
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\r");
  assert.match(text(monitor.render(80)), /Beta Review/);

  runs = [
    ...runs,
    run({ runId: "run-gamma", workflow: "Gamma Review", updatedAt: "2026-01-04T00:00:00.000Z" }),
  ];
  monitor.invalidate();
  const reloadedDetail = text(monitor.render(80));
  assert.match(reloadedDetail, /Beta Review/);
  assert.doesNotMatch(reloadedDetail, /Gamma Review/);
  assert.match(reloadedDetail, /Phases/);
});

test("artifact view keeps its run identity across reloads and exits if that run disappears", () => {
  const betaRun = {
    runId: "run-beta",
    workflow: "Beta Review",
    normalizedStatus: "success",
    status: "success",
    updatedAt: "2026-01-02T00:00:00.000Z",
    artifacts: [],
    phases: [{ phase: "compile", normalizedStatus: "success", status: "success", artifacts: [{ kind: "markdown", title: "Beta report", content: "beta-only" }] }],
  };
  let runs = [
    run({ runId: "run-alpha", workflow: "Alpha Build", updatedAt: "2026-01-03T00:00:00.000Z" }),
    betaRun,
  ];
  const monitor = new ThreadPhaseMonitorComponent("/repo", undefined, theme, () => {}, () => {}, () => {}, () => runs);

  monitor.handleInput("\x1b[B"); // select run-beta
  monitor.handleInput("\r"); // detail
  monitor.handleInput("\r"); // expand compile
  monitor.handleInput("\x1b[B"); // Beta report
  monitor.handleInput("\r"); // open artifact
  assert.match(text(monitor.render(80)), /beta-only/);

  runs = [
    ...runs,
    run({ runId: "run-gamma", workflow: "Gamma Test", updatedAt: "2026-01-04T00:00:00.000Z" }),
  ];
  monitor.invalidate();
  const reloadedArtifact = text(monitor.render(80));
  assert.match(reloadedArtifact, /Beta report/);
  assert.match(reloadedArtifact, /beta-only/);
  assert.doesNotMatch(reloadedArtifact, /Gamma Test/);

  runs = runs.filter((candidate) => candidate.runId !== "run-beta");
  monitor.invalidate();
  const fallback = text(monitor.render(80));
  assert.match(fallback, /↑↓ select/);
  assert.doesNotMatch(fallback, /beta-only|↑↓ line/);
});

test("detail view returns safely to the list if its selected run disappears", () => {
  let runs = [run(), run({ runId: "run-beta", workflow: "Beta Review" })];
  const monitor = new ThreadPhaseMonitorComponent("/repo", undefined, theme, () => {}, () => {}, () => {}, () => runs);

  monitor.handleInput("\r");
  assert.match(text(monitor.render(80)), /Alpha Build/);
  runs = [runs[1]];
  monitor.invalidate();

  const fallback = text(monitor.render(80));
  assert.match(fallback, /↑↓ select/);
  assert.match(fallback, /Beta Review/);
  assert.doesNotMatch(fallback, /Phases/);
});

test("active search results update when matching runs arrive", () => {
  let runs = [run()];
  const monitor = new ThreadPhaseMonitorComponent("/repo", undefined, theme, () => {}, () => {}, () => {}, () => runs);
  monitor.handleInput("/");
  for (const character of "beta") monitor.handleInput(character);
  monitor.handleInput("\r");
  assert.match(text(monitor.render(80)), /No runs match filter/);

  runs = [...runs, run({ runId: "run-beta", workflow: "Beta Review" })];
  monitor.invalidate();
  const updated = text(monitor.render(80));
  assert.match(updated, /Beta Review/);
  assert.doesNotMatch(updated, /Alpha Build/);
});
