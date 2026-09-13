import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_TITLE_HANDOFF_MS,
  TERMINAL_TITLE_POLL_MS,
  registerThreadPhaseTerminalTitle,
} from "../lib/terminal-title.mjs";

const emptyCounts = () => ({
  running: 0,
  unknownActive: 0,
  successRecent: 0,
  failureRecent: 0,
  cancelledRecent: 0,
  unknownTerminalRecent: 0,
});
const result = (counts = {}) => ({ state: "current", snapshot: { counts: { ...emptyCounts(), ...counts } } });

class FakeTimers {
  now = 0;
  nextId = 1;
  entries = new Map();
  callbacks = [];
  setTimeout = (callback, delay) => this.add(callback, delay, 0);
  setInterval = (callback, delay) => this.add(callback, delay, delay);
  clearTimeout = (timer) => this.entries.delete(timer.id);
  clearInterval = (timer) => this.entries.delete(timer.id);
  add(callback, delay, interval) {
    const timer = { id: this.nextId++, unrefCalled: false, unref() { this.unrefCalled = true; } };
    const entry = { timer, callback, at: this.now + delay, interval };
    this.entries.set(timer.id, entry);
    this.callbacks.push(entry);
    return timer;
  }
  tick(ms) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.entries.values()].filter((entry) => entry.at <= end)
        .sort((left, right) => left.at - right.at || left.timer.id - right.timer.id)[0];
      if (!next) break;
      this.now = next.at;
      if (next.interval) next.at += next.interval;
      else this.entries.delete(next.timer.id);
      next.callback();
    }
    this.now = end;
  }
  activeIntervals() { return [...this.entries.values()].filter((entry) => entry.interval).length; }
  activeTimeouts() { return [...this.entries.values()].filter((entry) => !entry.interval).length; }
}

function harness({ env, initialResult = { state: "unknown", reason: "no-live-publisher" } } = {}) {
  const handlers = new Map();
  const timers = new FakeTimers();
  const reads = { value: initialResult, count: 0 };
  const readerCalls = [];
  const api = {
    on(name, handler) { handlers.set(name, handler); },
    getSessionName() { return undefined; },
  };
  registerThreadPhaseTerminalTitle(api, {
    env: env ?? { PI_THREAD_PHASE_STATUS_BRIDGE: "1", PI_THREAD_PHASE_TERMINAL_TITLE: "1" },
    rootFromEnv: () => "/private/bridge",
    createReader(options) {
      readerCalls.push(options);
      return { read() { reads.count++; return reads.value; } };
    },
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    setIntervalFn: timers.setInterval,
    clearIntervalFn: timers.clearInterval,
  });
  return { handlers, timers, reads, readerCalls };
}

function context(sessionId, mode = "tui", values = {}) {
  const state = { cwd: values.cwd || "/work/alpha", name: values.name };
  const titles = [];
  const warnings = [];
  const footerCalls = [];
  return {
    state,
    titles,
    warnings,
    footerCalls,
    ctx: {
      mode,
      sessionManager: {
        getSessionId: () => sessionId,
        getCwd: () => state.cwd,
        getSessionName: () => state.name,
      },
      ui: {
        setTitle: (title) => titles.push(title),
        notify: (...args) => warnings.push(args),
        setStatus: (...args) => footerCalls.push(["status", ...args]),
        setWidget: (...args) => footerCalls.push(["widget", ...args]),
        setFooter: (...args) => footerCalls.push(["footer", ...args]),
      },
    },
  };
}

test("all host modes and dual flags gate every title resource", () => {
  for (const mode of ["rpc", "print", "json"]) {
    const h = harness();
    const c = context(`mode-${mode}`, mode);
    h.handlers.get("session_start")({}, c.ctx);
    h.timers.tick(20_000);
    assert.deepEqual(c.titles, [], mode);
    assert.equal(h.readerCalls.length, 0, mode);
    assert.equal(h.timers.entries.size, 0, mode);
  }

  for (const env of [
    {},
    { PI_THREAD_PHASE_STATUS_BRIDGE: "1" },
    { PI_THREAD_PHASE_TERMINAL_TITLE: "1" },
    { PI_THREAD_PHASE_STATUS_BRIDGE: "0", PI_THREAD_PHASE_TERMINAL_TITLE: "1" },
  ]) {
    const h = harness({ env });
    const c = context("flags");
    h.handlers.get("session_start")({}, c.ctx);
    h.handlers.get("session_start")({}, c.ctx);
    h.timers.tick(20_000);
    assert.deepEqual(c.titles, []);
    assert.equal(h.readerCalls.length, 0);
    assert.equal(h.timers.entries.size, 0);
    const titleOnly = env.PI_THREAD_PHASE_TERMINAL_TITLE === "1" && env.PI_THREAD_PHASE_STATUS_BRIDGE !== "1";
    assert.equal(c.warnings.length, titleOnly ? 1 : 0);
  }
});

test("startup handoff is delayed, unrefed, polled slowly, and deduplicated", () => {
  const h = harness();
  const c = context("startup");
  h.handlers.get("session_start")({}, c.ctx);
  assert.equal(h.readerCalls.length, 1);
  assert.equal(h.timers.activeTimeouts(), 1);
  assert.equal([...h.timers.entries.values()][0].timer.unrefCalled, true);
  h.timers.tick(TERMINAL_TITLE_HANDOFF_MS - 1);
  assert.deepEqual(c.titles, []);
  h.timers.tick(1);
  assert.deepEqual(c.titles, ["⎊ π - alpha"]);
  assert.equal(h.timers.activeIntervals(), 1);
  assert.equal([...h.timers.entries.values()][0].timer.unrefCalled, true);

  h.timers.tick(TERMINAL_TITLE_POLL_MS * 2);
  assert.equal(c.titles.length, 1, "unchanged attention was periodically reasserted");
  h.reads.value = result({ running: 1 });
  h.timers.tick(TERMINAL_TITLE_POLL_MS);
  assert.equal(c.titles.at(-1), "⚙︎ π - alpha");
  h.timers.tick(TERMINAL_TITLE_POLL_MS);
  assert.equal(c.titles.length, 2, "unchanged active title was periodically reasserted");
  assert.deepEqual(c.footerCalls, [], "title consumer altered footer/widget APIs");
});

test("rename, idle transition, completion expiry, and shutdown restore stock-compatible titles", () => {
  const h = harness({ initialResult: result({ successRecent: 1 }) });
  const c = context("lifecycle", "tui", { cwd: "/old/repo", name: "old" });
  h.handlers.get("session_start")({}, c.ctx);
  h.timers.tick(TERMINAL_TITLE_HANDOFF_MS);
  assert.equal(c.titles.at(-1), "⌘ π - old - repo");

  c.state.name = "renamed\u001b]0;unsafe\u0007";
  c.state.cwd = "/new/location";
  h.handlers.get("session_info_changed")({ name: c.state.name }, c.ctx);
  assert.equal(c.titles.at(-1), "⌘ π - renamed ]0;unsafe  - location");
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(c.titles.at(-1)), false);

  h.reads.value = result();
  h.timers.tick(TERMINAL_TITLE_POLL_MS);
  assert.equal(c.titles.at(-1), "π - renamed ]0;unsafe  - location");
  const countAtIdle = c.titles.length;
  h.timers.tick(TERMINAL_TITLE_POLL_MS * 2);
  assert.equal(c.titles.length, countAtIdle);
  h.handlers.get("session_shutdown")({ reason: "quit" }, c.ctx);
  assert.equal(c.titles.length, countAtIdle, "idle shutdown needlessly rewrote stock title");
  assert.equal(h.timers.entries.size, 0);

  const active = harness({ initialResult: result({ running: 1 }) });
  const activeContext = context("active-shutdown", "tui", { cwd: "/work/active", name: "named" });
  active.handlers.get("session_start")({}, activeContext.ctx);
  active.timers.tick(TERMINAL_TITLE_HANDOFF_MS);
  active.handlers.get("session_shutdown")({ reason: "reload" }, activeContext.ctx);
  assert.deepEqual(activeContext.titles, ["⚙︎ π - named - active", "π - named - active"]);
  assert.equal(active.timers.entries.size, 0);
});

test("switch, reload-shaped reinitialization, late callbacks, and old shutdown cannot overwrite a new session", () => {
  const h = harness({ initialResult: result({ running: 1 }) });
  const first = context("first", "tui", { cwd: "/work/first" });
  const second = context("second", "tui", { cwd: "/work/second", name: "two" });
  h.handlers.get("session_start")({ reason: "startup" }, first.ctx);
  const lateHandoff = h.timers.callbacks[0].callback;
  h.timers.tick(TERMINAL_TITLE_HANDOFF_MS);
  const latePoll = h.timers.callbacks.find((entry) => entry.interval).callback;
  assert.equal(first.titles.at(-1), "⚙︎ π - first");

  h.handlers.get("session_start")({ reason: "reload" }, second.ctx);
  assert.equal(h.timers.activeIntervals(), 0, "old polling timer survived replacement start");
  lateHandoff();
  latePoll();
  h.handlers.get("session_info_changed")({}, first.ctx);
  h.handlers.get("session_shutdown")({ reason: "resume" }, first.ctx);
  assert.equal(first.titles.length, 1, "late old callback restored or rewrote old title");

  h.timers.tick(TERMINAL_TITLE_HANDOFF_MS);
  assert.equal(second.titles.at(-1), "⚙︎ π - two - second");
  h.handlers.get("session_start")({ reason: "reload" }, second.ctx);
  h.timers.tick(TERMINAL_TITLE_HANDOFF_MS);
  assert.equal(second.titles.filter((title) => title === "⚙︎ π - two - second").length, 2);
  assert.equal(h.timers.activeIntervals(), 1, "repeated initialization leaked polling timers");
  h.handlers.get("session_shutdown")({ reason: "quit" }, second.ctx);
  assert.equal(second.titles.at(-1), "π - two - second");
  latePoll();
  assert.equal(second.titles.at(-1), "π - two - second", "late poll overwrote shutdown restoration");
});
