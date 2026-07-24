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
  assert.match(text(lines), /Thread-phase monitor/);
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
  assert.match(detail, /sessionId: session-42  launch source: background  cwd at launch: \/repo-at-launch/);
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
      usage: { entries: 1, inputTokens: 1000, outputTokens: 250, totalTokens: 1250, reasoningTokens: 100 },
    }],
  })]);

  const list = text(monitor.render(100));
  assert.match(list, /1h 2m 3s · 8\.8K tok/);

  monitor.handleInput("\r");
  monitor.handleInput("\r");
  const detail = text(monitor.render(100));
  assert.match(detail, /duration: 1h 2m 3s/);
  assert.match(detail, /tokens: 8\.8K tok/);
  assert.match(detail, /duration: 2m 3s/);
  assert.match(detail, /tokens: 1\.3K tok/);
  assert.doesNotMatch(detail, /started:|ended:|updated:|8K in|750 out|cached|reasoning|test\/model/);
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
  assert.match(rendered, /stale:shown/);
  assert.match(rendered, /Stale Run/);
});

test("handleInput transitions list to detail to artifact and left returns toward list", () => {
  const monitor = component([run()]);
  monitor.handleInput("\r");
  assert.match(text(monitor.render(72)), /Phases/);
  assert.doesNotMatch(text(monitor.render(72)), /Thread-phase monitor/);

  monitor.handleInput("\x1b[B");
  monitor.handleInput("\r");
  const artifact = text(monitor.render(72));
  assert.match(artifact, /Build report/);
  assert.match(artifact, /line-1/);
  assert.match(artifact, /↑↓ line/);

  monitor.handleInput("\x1b[D");
  assert.match(text(monitor.render(72)), /Artifacts/);
  monitor.handleInput("\x1b[D");
  assert.match(text(monitor.render(72)), /Thread-phase monitor/);
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
      () => [run({ artifacts: [artifact] })],
    );

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
    () => [run({ artifacts: [{ kind: "file", title: "Editor report", path: "  /repo/editor-report.txt  ", content: "report" }] })],
  );

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
    () => [run({ artifacts: [{ kind: "markdown", title: "Inline report", content: "inline body" }] })],
  );

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

test("detail and artifact pagination move through content and clamp at zero", () => {
  const phases = Array.from({ length: 30 }, (_, index) => ({
    phase: `phase-${index + 1}`,
    normalizedStatus: "success",
    status: "success",
  }));
  const content = Array.from({ length: 80 }, (_, index) => `artifact-line-${index + 1}`).join("\n");
  const monitor = component([run({ phases, artifacts: [{ kind: "markdown", title: "Long report", content }] })]);

  monitor.handleInput("\r");
  monitor.render(100);
  monitor.handleInput("\x04");
  assert.match(text(monitor.render(100)), /› ◆ phase-13/);
  monitor.handleInput("\x15");
  monitor.handleInput("\x15");
  assert.match(text(monitor.render(100)), /› ◆ phase-1/);

  for (let index = 0; index < phases.length; index++) monitor.handleInput("\x1b[B");
  monitor.handleInput("\r");
  const firstPage = text(monitor.render(100));
  assert.match(firstPage, /artifact-line-1/);
  monitor.handleInput("\x1b[A");
  assert.match(text(monitor.render(100)), /artifact-line-1/);
  monitor.handleInput("\x04");
  const secondPage = text(monitor.render(100));
  assert.match(secondPage, /artifact-line-2[0-9]/);
  assert.doesNotMatch(secondPage, /artifact-line-1(?:\D|$)/);
  monitor.handleInput("\x15");
  monitor.handleInput("\x15");
  assert.match(text(monitor.render(100)), /artifact-line-1/);
});

test("expanding and paging fanout near the viewport bottom reveals each rendered page", () => {
  const phases = Array.from({ length: 18 }, (_, index) => ({
    phase: `phase-${index + 1}`,
    normalizedStatus: "success",
    status: "success",
  }));
  phases.at(-1).fanout = {
    total: 23,
    completed: 23,
    failed: 0,
    running: 0,
    items: Array.from({ length: 23 }, (_, index) => ({
      itemId: `item-${index + 1}`,
      label: `fanout-item-${index + 1}`,
      normalizedStatus: "success",
      status: "success",
    })),
  };
  const monitor = component([run({ phases, artifacts: [] })]);

  monitor.handleInput("\r");
  for (let index = 1; index < phases.length; index++) monitor.handleInput("\x1b[B");
  assert.match(text(monitor.render(100)), /› ◆ phase-18/);

  monitor.handleInput("\r");
  const firstPage = text(monitor.render(100));
  assert.match(firstPage, /items 1-10 of 23/);
  assert.match(firstPage, /fanout-item-1(?:\D|$)/);
  assert.match(firstPage, /fanout-item-10/);

  monitor.handleInput("\x04");
  const secondPage = text(monitor.render(100));
  assert.match(secondPage, /items 11-20 of 23/);
  assert.match(secondPage, /fanout-item-11/);
  assert.match(secondPage, /fanout-item-20/);
  assert.doesNotMatch(secondPage, /fanout-item-1(?:\D|$)/);

  monitor.handleInput("\x04");
  const lastPage = text(monitor.render(100));
  assert.match(lastPage, /items 21-23 of 23/);
  assert.match(lastPage, /fanout-item-21/);
  assert.match(lastPage, /fanout-item-23/);
});

test("every fanout page remains visible in a narrow viewport after ctrl+d and ctrl+u page changes", () => {
  const phases = Array.from({ length: 16 }, (_, index) => ({
    phase: `phase-${index + 1}`,
    normalizedStatus: "success",
    status: "success",
  }));
  phases.at(-1).fanout = {
    total: 23,
    completed: 23,
    failed: 0,
    running: 0,
    items: Array.from({ length: 23 }, (_, index) => ({
      itemId: `item-${index + 1}`,
      label: `F${String(index + 1).padStart(2, "0")}`,
      normalizedStatus: "success",
      status: "success",
    })),
  };
  const monitor = component([run({ phases, artifacts: [] })]);

  monitor.handleInput("\r");
  for (let index = 1; index < phases.length; index++) monitor.handleInput("\x1b[B");
  monitor.render(28); // 24-column body selects the minimum 12-row detail viewport.
  monitor.handleInput("\r");

  const pages = [
    ["items 1-10 of 23", "F01", "F10"],
    ["items 11-20 of 23", "F11", "F20"],
    ["items 21-23 of 23", "F21", "F23"],
  ];
  const assertVisiblePage = ([heading, first, last]) => {
    const page = text(monitor.render(28));
    assert.match(page, new RegExp(heading));
    assert.match(page, new RegExp(`✓ ${first}(?:\\D|$)`));
    assert.match(page, new RegExp(`✓ ${last}(?:\\D|$)`));
  };

  assertVisiblePage(pages[0]);
  monitor.handleInput("\x04");
  assertVisiblePage(pages[1]);
  monitor.handleInput("\x04");
  assertVisiblePage(pages[2]);
  monitor.handleInput("\x15");
  assertVisiblePage(pages[1]);
  monitor.handleInput("\x15");
  assertVisiblePage(pages[0]);
});

test("detail line navigation resumes selected-item anchoring after fanout paging", () => {
  const phases = Array.from({ length: 16 }, (_, index) => ({
    phase: `phase-${index + 1}`,
    normalizedStatus: "success",
    status: "success",
  }));
  phases.at(-1).fanout = {
    total: 23,
    completed: 23,
    failed: 0,
    running: 0,
    items: Array.from({ length: 23 }, (_, index) => ({
      itemId: `item-${index + 1}`,
      label: `F${String(index + 1).padStart(2, "0")}`,
      normalizedStatus: "success",
      status: "success",
    })),
  };
  const monitor = component([run({
    phases,
    artifacts: [{ kind: "markdown", title: "Tail report", content: "tail" }],
  })]);

  monitor.handleInput("\r");
  for (let index = 1; index < phases.length; index++) monitor.handleInput("j");
  monitor.render(28);
  monitor.handleInput("\r");
  monitor.handleInput("\x04");
  assert.match(text(monitor.render(28)), /items 11-20 of 23/);

  // Moving off the expanded phase must release the fanout-page anchor and let
  // the ordinary selected-line viewport reveal the artifact below the page.
  monitor.handleInput("\x1b[B");
  assert.match(text(monitor.render(28)), /› ◉ Tail report/);

  monitor.handleInput("k");
  assert.match(text(monitor.render(28)), /› ◆ phase-16/);
  monitor.handleInput("j");
  assert.match(text(monitor.render(28)), /› ◉ Tail report/);
  monitor.handleInput("\x1b[A");
  assert.match(text(monitor.render(28)), /› ◆ phase-16/);
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
  assert.match(filtered, /Filter: bEtA/);

  monitor.handleInput("\x1b");
  const cleared = text(monitor.render(80));
  assert.match(cleared, /Alpha Build/);
  assert.match(cleared, /Beta Review/);
  assert.match(cleared, /Filter: \(none\)/);
});

test("clear actions restore the unfiltered list from every mode and reset selection", () => {
  const monitor = component([
    run({ normalizedStatus: "running", status: "running" }),
    run({ runId: "run-beta", workflow: "Beta Review", normalizedStatus: "success", status: "success" }),
  ]);

  monitor.handleInput("/");
  for (const character of "beta") monitor.handleInput(character);
  monitor.handleInput("\r");
  assert.match(text(monitor.render(80)), /› ✓ Beta Review/);
  monitor.handleInput("b");
  let cleared = text(monitor.render(80));
  assert.match(cleared, /Thread-phase monitor/);
  assert.match(cleared, /Alpha Build/);
  assert.match(cleared, /› .* Alpha Build LIVE/);

  monitor.handleInput("/");
  for (const character of "beta") monitor.handleInput(character);
  monitor.handleInput("\x1b");
  cleared = text(monitor.render(80));
  assert.match(cleared, /Alpha Build/);
  assert.match(cleared, /Beta Review/);
  assert.match(cleared, /› .* Alpha Build LIVE/);

  monitor.handleInput("/");
  for (const character of "beta") monitor.handleInput(character);
  monitor.handleInput("\r");
  monitor.handleInput("\r");
  assert.match(text(monitor.render(80)), /Phases/);
  monitor.handleInput("\x1b");
  cleared = text(monitor.render(80));
  assert.match(cleared, /Thread-phase monitor/);
  assert.match(cleared, /Alpha Build/);
  assert.match(cleared, /› .* Alpha Build LIVE/);

  monitor.handleInput("/");
  for (const character of "beta") monitor.handleInput(character);
  monitor.handleInput("\r");
  monitor.handleInput("\r");
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\r");
  assert.match(text(monitor.render(80)), /Build report/);
  monitor.handleInput("b");
  cleared = text(monitor.render(80));
  assert.match(cleared, /Thread-phase monitor/);
  assert.match(cleared, /Alpha Build/);
  assert.match(cleared, /› .* Alpha Build LIVE/);
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
      () => [run()],
    );

    const listMonitor = makeMonitor();
    listMonitor.handleInput(key);
    assert.equal(closeCount, 1, `${JSON.stringify(key)} closes from list`);

    closeCount = 0;
    const detailMonitor = makeMonitor();
    detailMonitor.handleInput("\r");
    detailMonitor.handleInput(key);
    assert.match(text(detailMonitor.render(80)), /Thread-phase monitor/);
    assert.equal(closeCount, 0, `${JSON.stringify(key)} returns from detail without closing`);

    const artifactMonitor = makeMonitor();
    artifactMonitor.handleInput("\r");
    artifactMonitor.handleInput("\x1b[B");
    artifactMonitor.handleInput("\r");
    artifactMonitor.handleInput(key);
    const rendered = text(artifactMonitor.render(80));
    assert.match(rendered, /Artifacts/);
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
  let runs = [
    run({ runId: "run-alpha", workflow: "Alpha Build", updatedAt: "2026-01-03T00:00:00.000Z" }),
    run({
      runId: "run-beta",
      workflow: "Beta Review",
      updatedAt: "2026-01-02T00:00:00.000Z",
      artifacts: [{ kind: "markdown", title: "Beta report", content: "beta-only" }],
    }),
  ];
  const monitor = new ThreadPhaseMonitorComponent("/repo", undefined, theme, () => {}, () => {}, () => {}, () => runs);

  monitor.handleInput("\x1b[B");
  monitor.handleInput("\r");
  monitor.handleInput("\x1b[B");
  monitor.handleInput("\r");
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
  assert.match(fallback, /Thread-phase monitor/);
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
  assert.match(fallback, /Thread-phase monitor/);
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
