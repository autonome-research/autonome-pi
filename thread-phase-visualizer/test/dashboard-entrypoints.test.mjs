import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const storeDir = mkdtempSync(join(tmpdir(), "thread-phase-dashboard-entrypoints-"));
process.env.PI_THREAD_PHASE_STORE_DIR = storeDir;
process.on("exit", () => rmSync(storeDir, { recursive: true, force: true }));

const loaderUrl = new URL("./support/pi-peer-loader.mjs", import.meta.url);
if (nodeModule.registerHooks) nodeModule.registerHooks(await import(loaderUrl));
else nodeModule.register(loaderUrl);

const { default: registerVisualizer } = await import("../index.ts");

const theme = {
  fg(_color, value) { return String(value); },
  bold(value) { return String(value); },
};

test("slash-command selection and shortcut open the same interactive workflow dashboard", async () => {
  const commands = new Map();
  const shortcuts = new Map();
  registerVisualizer({
    registerMessageRenderer() {},
    registerTool() {},
    registerCommand(name, options) { commands.set(name, options); },
    registerShortcut(key, options) { shortcuts.set(key, options); },
    on() {},
  });

  assert.match(commands.get("workflows")?.description || "", /interactive thread-phase workflow dashboard/);
  assert.match(shortcuts.get("ctrl+shift+t")?.description || "", /interactive thread-phase workflow dashboard/);

  let dashboardOpenCount = 0;
  const context = {
    cwd: storeDir,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "dashboard-session" },
    ui: {
      async custom(factory) {
        dashboardOpenCount++;
        factory({ requestRender() {} }, theme, {}, () => {});
      },
      notify() {},
      setEditorText() {},
    },
  };

  await commands.get("workflows").handler("", context);
  await shortcuts.get("ctrl+shift+t").handler(context);
  assert.equal(dashboardOpenCount, 2);
});

test("non-TUI modes get a notification and never start the custom dashboard", async () => {
  const commands = new Map();
  const shortcuts = new Map();
  registerVisualizer({
    registerMessageRenderer() {},
    registerTool() {},
    registerCommand(name, options) { commands.set(name, options); },
    registerShortcut(key, options) { shortcuts.set(key, options); },
    on() {},
  });

  // RPC clients report hasUI=true but cannot host ctx.ui.custom(); json/print
  // have no dialog UI. All three must notify instead of silently doing nothing.
  for (const [mode, hasUI] of [["rpc", true], ["json", false], ["print", false]]) {
    let customCalls = 0;
    const notifications = [];
    const context = {
      cwd: storeDir,
      mode,
      hasUI,
      sessionManager: { getSessionId: () => "dashboard-session" },
      ui: {
        async custom(factory) {
          customCalls++;
          factory({ requestRender() {} }, theme, {}, () => {});
        },
        notify(message, kind) { notifications.push([message, kind]); },
        setEditorText() {},
      },
    };
    await commands.get("workflows").handler("", context);
    assert.equal(customCalls, 0, `${mode} mode must not invoke the custom TUI factory`);
    assert.equal(notifications.length, 1, `${mode} mode gets exactly one explanatory notification`);
    assert.match(notifications[0][0], /interactive TUI mode/);
    assert.equal(notifications[0][1], "warning");
  }
});
