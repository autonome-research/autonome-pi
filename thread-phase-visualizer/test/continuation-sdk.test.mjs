// Run against an installed Pi with PI_HANDOFF_SDK_DIR=/path/to/pi-coding-agent.
// All responses are deterministic local streams; no provider or credentials are used.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { findPackageJSON } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const sdkDir = process.env.PI_HANDOFF_SDK_DIR;
test("real Pi terminal handoffs: busy, duplicate, restart, branch and explicit backlog", { skip: !sdkDir, timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "handoff-sdk-"));
  const agentDir = join(root, "agent"), storeDir = join(root, "store"), sessionDir = join(root, "sessions");
  for (const path of [agentDir, storeDir, sessionDir]) mkdirSync(path);
  process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
  process.env.PI_THREAD_PHASE_STATUS_BRIDGE = "0";
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(sdkDir, "dist/index.js")));
  const aiDir = dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(sdkDir, "package.json"))));
  const { createAssistantMessageEventStream } = await import(pathToFileURL(join(aiDir, "dist/index.js")));
  const store = await import("../lib/store.mjs");
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
  const waitFor = async predicate => {
    for (let i = 0; i < 400 && !predicate(); i++) await delay(10);
    assert.ok(predicate(), "expected lifecycle transition");
  };
  const open = async sessionFile => {
    manager = sessionFile ? SessionManager.open(sessionFile, sessionDir) : SessionManager.create(root, sessionDir);
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
    await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
  };
  const close = async () => {
    if (!session) return;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose(); session = undefined;
  };
  const run = id => store.createRun({ runId: id, workflow: "sdk-fixture", cwd: root,
    trigger: { kind: "background" }, metadata: { sessionId: manager.getSessionId(), continuationMode: "terminal" } });
  const pending = id => receipts.loadPendingContinuationRecords({ storeDir }).find(record => record.runId === id);
  try {
    await open();
    const initial = session.prompt("fixture: remain busy until released");
    await waitFor(() => release);
    const busy = run("sdk-busy");
    store.completeRun(busy, "failed");
    await waitFor(() => pending(busy.runId));
    assert.equal(requests, 1);
    assert.equal(pending(busy.runId).submissionState, "unsent");
    release(); await initial;
    await waitFor(() => requests >= 2 && session.isIdle);
    assert.equal(requests, 2, "one user turn plus one handoff; the completion card must not trigger another turn");
    const sessionId = manager.getSessionId(), sessionFile = manager.getSessionFile();
    assert.ok(sessionHistoryHasRunContinuation(manager.getEntries(), busy.runId, sessionId));
    store.completeRun(busy, "failed"); await delay(150);
    assert.equal(requests, 2);
    assert.equal(manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "thread-phase-run").length, 1);
    const original = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
    manager.branch(original.id);
    assert.equal(sessionHistoryHasRunContinuation(manager.getBranch(), busy.runId, sessionId), false);
    await close();
    receipts.persistContinuedRuns(new Set(Array.from({ length: 500 }, (_, i) => `sdk-other-${i}`)), { storeDir });
    await open(sessionFile); await delay(150);
    assert.equal(requests, 2, "reopen finds the receipt on the other persisted branch after store eviction");

    const uncertain = run("sdk-uncertain");
    await close();
    const old = { ...busy, runId: "sdk-old", runFile: undefined };
    const oldTime = Date.now() - 48 * 60 * 60 * 1000;
    store.emit(old, { type: store.EVENT_TYPES.WORKFLOW_START, status: "running", metadata: old.metadata, timestamp: new Date(oldTime - 1000).toISOString() });
    store.emit(old, { type: store.EVENT_TYPES.WORKFLOW_END, status: "failed", timestamp: new Date(oldTime).toISOString() });
    const claimantId = receipts.createContinuationClaimantId();
    const oldClaim = receipts.persistContinuationClaim(old.runId, { storeDir, sessionId, claimantId });
    receipts.relinquishContinuationClaim(old.runId, { storeDir, claimantId, deliveryId: oldClaim.deliveryId });
    store.completeRun(uncertain, "failed");
    const claim = receipts.persistContinuationClaim(uncertain.runId, { storeDir, sessionId, claimantId });
    const identity = { storeDir, claimantId, deliveryId: claim.deliveryId };
    assert.equal(receipts.markContinuationSubmission(uncertain.runId, { ...identity, submissionState: "submitted" }), true);
    receipts.relinquishContinuationClaim(uncertain.runId, identity);
    await open(sessionFile); await delay(150);
    assert.equal(requests, 2, "old and uncertain backlog is passive on reopen");
    await session.prompt(`/workflow-handoff ${uncertain.runId}`);
    assert.equal(requests, 2, "uncertain handoff needs interactive confirmation, unavailable in JSON mode");
    await session.prompt(`/workflow-handoff ${old.runId}`);
    await waitFor(() => requests === 3 && session.isIdle);
    assert.ok(sessionHistoryHasRunContinuation(manager.getEntries(), old.runId, sessionId));
    assert.deepEqual(errors, []);
  } finally {
    release?.();
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});
