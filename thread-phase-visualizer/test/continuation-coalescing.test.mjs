// Actual Pi 1.0.4, synthetic provider, real held tool batch; no provider transport.
// PI_HANDOFF_SDK_DIR explicitly selects the genuine installed SDK.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { findPackageJSON } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "handoff-coalescing-"));
const dirs = Object.fromEntries(["home", "tmp", "agent", "store", "sessions"].map(name => {
  const path = join(root, name); mkdirSync(path); return [name, path];
}));
Object.assign(process.env, { HOME: dirs.home, TMPDIR: dirs.tmp,
  PI_THREAD_PHASE_STORE_DIR: dirs.store, PI_THREAD_PHASE_STATUS_BRIDGE: "0" });
test.after(() => rmSync(root, { recursive: true, force: true }));
const sdkDir = process.env.PI_HANDOFF_SDK_DIR;
const skip = !sdkDir && "PI_HANDOFF_SDK_DIR is not set";
const options = { skip, timeout: 20_000 };

async function fixture(t, { earlierBoundary = false, initialTools = true } = {}) {
  const sdk = await import(pathToFileURL(join(sdkDir, "dist/index.js")));
  assert.equal(JSON.parse(readFileSync(join(sdkDir, "package.json"))).version, "1.0.4");
  assert.equal(sdk.VERSION, "1.0.4");
  const aiDir = dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(sdkDir, "package.json"))));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(aiDir, "dist/index.js")));
  const store = await import("../lib/store.mjs");
  const receipts = await import("../lib/continuation-store.mjs");
  const { sessionHistoryHasRunContinuation } = await import("../lib/continuation-message.mjs");
  writeFileSync(join(dirs.agent, "auth.json"), "{}");
  writeFileSync(join(dirs.agent, "models.json"), JSON.stringify({ providers: { fixture: {
    api: "openai-completions", baseUrl: "https://fixture.invalid", apiKey: "fixture-only", models: [{ id: "local" }],
  } } }));
  const runtime = await sdk.ModelRuntime.create({ authPath: join(dirs.agent, "auth.json"),
    modelsPath: join(dirs.agent, "models.json"), allowModelNetwork: false });
  const model = runtime.getModel("fixture", "local");
  let session, manager, initial, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const state = { contexts: [], started: [], finished: [], agentStarts: 0, errors: [] };
  const tool = { name: "fixture_hold", label: "Hold", description: "Hold a tool batch",
    parameters: Type.Object({ label: Type.String() }),
    async execute(_id, { label }) {
      state.started.push(label); await barrier; state.finished.push(label);
      return { content: [{ type: "text", text: `finished ${label}` }], details: undefined };
    } };
  const earlierPath = join(dirs.agent, `earlier-boundary-${randomUUID()}.mjs`);
  if (earlierBoundary) writeFileSync(earlierPath, `export default pi => {
    pi.on('turn_end', event => event.turnIndex === 0 ? { entries: [...event.entries,
      { type: 'custom', customType: 'fixture-state', data: { keep: true } },
      { type: 'custom_message', customType: 'fixture-context', content: 'Keep earlier context', display: false }
    ], continue: true } : undefined);
  };`);
  const open = async file => {
    manager = file ? sdk.SessionManager.open(file, dirs.sessions) : sdk.SessionManager.create(root, dirs.sessions);
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: dirs.agent, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [...(earlierBoundary ? [earlierPath] : []), fileURLToPath(new URL("../index.ts", import.meta.url))],
      systemPrompt: "Offline handoff fixture", appendSystemPrompt: [] });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: dirs.agent, modelRuntime: runtime, model,
      sessionManager: manager, settingsManager, resourceLoader, tools: [tool.name], customTools: [tool] }));
    session.subscribe(event => { if (event.type === "agent_start") state.agentStarts++; });
    session.agent.streamFunction = (_model, context) => {
      state.contexts.push(context.messages.map(message => ({ role: message.role,
        text: typeof message.content === "string" ? message.content : message.content.map(part => part.text || "").join("\n") })));
      const first = initialTools && state.contexts.length === 1;
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: first ? ["first", "second"].map(label => ({ type: "toolCall", id: label, name: tool.name, arguments: { label } }))
          : [{ type: "text", text: "Final fixture answer" }], stopReason: first ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
      return stream;
    };
    await session.bindExtensions({ mode: "json", onError: error => state.errors.push(error) });
  };
  const close = async () => {
    if (!session) return;
    const old = session; session = undefined;
    await old.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    release(); await old.abort(); await initial?.catch(() => {}); old.dispose();
  };
  t.after(close);
  const wait = async (predicate, label) => {
    for (let i = 0; i < 400 && !predicate(); i++) await delay(10);
    assert.ok(predicate(), label);
  };
  const record = id => JSON.parse(readFileSync(join(dirs.store, receipts.CONTINUATION_STATE_FILENAME), "utf8")).records.find(r => r.runId === id);
  const pending = id => receipts.loadPendingContinuationRecords({ storeDir: dirs.store }).find(r => r.runId === id);
  const run = id => store.createRun({ runId: id, workflow: "fixture", cwd: root,
    trigger: { kind: "background" }, metadata: { sessionId: manager.getSessionId(), continuationMode: "terminal" } });
  return { state, open, close, release, wait, record, pending, run, store,
    get session() { return session; }, get manager() { return manager; },
    history: id => sessionHistoryHasRunContinuation(manager.getEntries(), id, manager.getSessionId()),
    start() { initial = session.prompt("Call both hold tools"); initial.catch(() => {}); return initial; } };
}

test("busy tool batch coalesces its completion into the natural next request", options, async t => {
  const f = await fixture(t); await f.open();
  const initial = f.start(); await f.wait(() => f.state.started.length > 0, "tool batch started");
  const run = f.run("boundary-busy"); f.store.completeRun(run, "success");
  await f.wait(() => f.pending(run.runId), "durable pending completion");
  assert.equal(f.pending(run.runId).submissionState, "unsent");
  assert.deepEqual(f.session.getSteeringMessages(), [], "no irrevocable SDK queue while tools are running");
  assert.equal(f.history(run.runId), false);
  const id = f.pending(run.runId).deliveryId;
  f.release(); await initial;
  await f.wait(() => f.session.isIdle, "settled");
  assert.equal(f.state.contexts.length, 2, "tool request plus natural answer, no extra post-answer request");
  assert.equal(f.state.agentStarts, 1);
  assert.deepEqual(f.state.finished.sort(), ["first", "second"], "whole tool batch executes");
  const natural = f.state.contexts[1];
  const toolIndices = natural.flatMap((m, i) => m.role === "toolResult" ? [i] : []);
  assert.equal(toolIndices.length, 2);
  assert.ok(natural.findIndex(m => m.text.includes(id)) > Math.max(...toolIndices));
  assert.equal(f.record(run.runId).state, "delivered");
  assert.equal(f.record(run.runId).deliveryId, id);
  assert.equal(f.history(run.runId), true);
  f.store.completeRun(run, "success"); await delay(150);
  assert.equal(f.state.contexts.length, 2);
  assert.equal(f.manager.getEntries().filter(e => e.customType === "thread-phase-handoff").length, 1);
  const file = f.manager.getSessionFile();
  await f.close(); await f.open(file); await delay(150);
  assert.equal(f.state.contexts.length, 2, "native boundary receipt suppresses replay after reload");
  assert.deepEqual(f.state.errors, []);
});

test("two completions wait for successive boundaries, not an opaque steering queue", options, async t => {
  const f = await fixture(t); await f.open();
  const initial = f.start(); await f.wait(() => f.state.started.length > 0, "tools started");
  const runs = [f.run("boundary-first"), f.run("boundary-second")];
  for (const run of runs) f.store.completeRun(run, "success");
  await f.wait(() => runs.every(r => f.pending(r.runId)), "both completions pending");
  for (const run of runs) assert.equal(f.pending(run.runId).submissionState, "unsent");
  f.release(); await initial;
  await f.wait(() => f.session.isIdle, "settled");
  assert.equal(f.state.contexts.length, 3);
  assert.equal(f.state.agentStarts, 1);
  for (const run of runs) assert.equal(f.record(run.runId).state, "delivered");
  await delay(150); assert.equal(f.state.contexts.length, 3);
  assert.deepEqual(f.state.errors, []);
});

for (const change of ["expired", "cancelled", "superseded"]) {
  test(`${change} completion is revalidated after the held tool batch`, options, async t => {
    const f = await fixture(t); await f.open();
    const initial = f.start(); await f.wait(() => f.state.started.length > 0, "tools started");
    const run = f.run(`boundary-${change}`); f.store.completeRun(run, "success");
    await f.wait(() => f.pending(run.runId), "completion durably queued");
    const id = f.pending(run.runId).deliveryId;
    if (change === "expired") {
      const future = Date.now() + 31 * 60 * 1000;
      t.mock.method(Date, "now", () => future);
    } else if (change === "cancelled") f.store.completeRun(run, "cancelled");
    else {
      const { reserveSuccessor, commitSuccessor } = await import("../lib/chain-store.mjs");
      commitSuccessor(reserveSuccessor(run.runId, "boundary-child", { chainId: randomUUID() }));
    }
    f.release(); await initial;
    await f.wait(() => f.session.isIdle, "settled");
    assert.equal(f.state.contexts.length, 2, "only the natural tool-loop answer");
    assert.equal(f.state.contexts.some(request => request.some(m => m.text.includes(id))), false);
    assert.equal(f.history(run.runId), false);
    if (change === "expired") assert.equal(f.pending(run.runId)?.submissionState, "unsent");
    else assert.equal(f.pending(run.runId), undefined);
    await delay(150); assert.equal(f.state.contexts.length, 2);
    assert.deepEqual(f.state.errors, []);
  });
}

for (const handoff of [false, true]) {
  test(`earlier boundary entries and continuation survive with handoff=${handoff}`, options, async t => {
    const f = await fixture(t, { earlierBoundary: true, initialTools: handoff }); await f.open();
    const initial = f.start();
    if (handoff) {
      await f.wait(() => f.state.started.length > 0, "tools started");
      const run = f.run("boundary-coexistence"); f.store.completeRun(run, "success");
      await f.wait(() => f.pending(run.runId), "pending handoff");
      f.release();
    }
    await initial; await f.wait(() => f.session.isIdle, "settled");
    const entries = f.manager.getEntries().filter(e => ["fixture-state", "fixture-context", "thread-phase-handoff"].includes(e.customType));
    assert.deepEqual(entries.map(e => e.customType), ["fixture-state", "fixture-context", ...(handoff ? ["thread-phase-handoff"] : [])]);
    assert.deepEqual(entries[0].data, { keep: true });
    assert.equal(f.state.contexts.length, 2, "earlier continuation survives even without a natural tool continuation or handoff");
    assert.ok(f.state.contexts[1].some(m => m.text === "Keep earlier context"));
    assert.equal(f.state.agentStarts, 1);
    assert.deepEqual(f.state.errors, []);
  });
}

test("failed boundary persistence remains uncertain across settlement and reload", options, async t => {
  const f = await fixture(t); await f.open();
  const file = f.manager.getSessionFile();
  const original = f.manager.appendCustomMessageEntry.bind(f.manager);
  const mocked = t.mock.method(f.manager, "appendCustomMessageEntry", (type, ...args) => {
    if (type === "thread-phase-handoff") throw new Error("fixture boundary persistence failure");
    return original(type, ...args);
  });
  const initial = f.start(); await f.wait(() => f.state.started.length > 0, "tools started");
  const run = f.run("boundary-uncertain"); f.store.completeRun(run, "success");
  await f.wait(() => f.pending(run.runId), "pending");
  f.release(); await initial.catch(() => {});
  await f.wait(() => f.session.isIdle, "settled after failed persistence");
  assert.equal(f.history(run.runId), false);
  assert.equal(f.pending(run.runId)?.submissionState, "submitted", "do not pretend a failed SDK acceptance was never submitted");
  const requests = f.state.contexts.length;
  mocked.mock.restore(); await f.close(); await f.open(file); await delay(150);
  assert.equal(f.state.contexts.length, requests, "uncertainty never grants an automatic resend");
  assert.equal(f.pending(run.runId)?.submissionState, "submitted");
});
