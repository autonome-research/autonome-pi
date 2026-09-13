import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVE_SYMBOL,
  ATTENTION_SYMBOL,
  COMPLETED_SYMBOL,
  TERMINAL_TITLE_COMPONENT_MAX_BYTES,
  TERMINAL_TITLE_MAX_BYTES,
  buildTerminalTitle,
  projectTerminalTitleState,
  sanitizeTitleComponent,
} from "../lib/terminal-title.mjs";

const empty = {
  running: 0,
  unknownActive: 0,
  successRecent: 0,
  failureRecent: 0,
  cancelledRecent: 0,
  unknownTerminalRecent: 0,
};
const current = (counts = {}) => ({ state: "current", snapshot: { counts: { ...empty, ...counts } } });

test("projection uses aggregate counters with documented attention precedence", () => {
  const cases = [
    [undefined, "attention"],
    [{ state: "unknown", reason: "no-live-publisher" }, "attention"],
    [{ state: "current", snapshot: {} }, "attention"],
    [current(), "idle"],
    [current({ successRecent: 1 }), "completed"],
    [current({ running: 1 }), "active"],
    [current({ running: 1, successRecent: 1 }), "active"],
    [current({ unknownActive: 1 }), "attention"],
    [current({ failureRecent: 1 }), "attention"],
    [current({ cancelledRecent: 1 }), "attention"],
    [current({ unknownTerminalRecent: 1 }), "attention"],
    [current({ running: 1, failureRecent: 1 }), "attention"],
    [current({ running: 1, cancelledRecent: 1, successRecent: 1 }), "attention"],
    [current({ successRecent: 1, unknownTerminalRecent: 1 }), "attention"],
  ];
  for (const [input, expected] of cases) assert.equal(projectTerminalTitleState(input), expected);
  assert.equal(projectTerminalTitleState(current({ cancelledRecent: -1 })), "attention", "malformed counts fail closed");
});

test("symbols and title forms use the exact requested code points", () => {
  assert.deepEqual([...ACTIVE_SYMBOL].map((value) => value.codePointAt(0)), [0x2699, 0xfe0e]);
  assert.deepEqual([...ATTENTION_SYMBOL].map((value) => value.codePointAt(0)), [0x238a]);
  assert.deepEqual([...COMPLETED_SYMBOL].map((value) => value.codePointAt(0)), [0x2318]);
  assert.equal(buildTerminalTitle({ state: "active", cwd: "/work/repo" }), "⚙︎ π - repo");
  assert.equal(buildTerminalTitle({ state: "attention", sessionName: "review", cwd: "/work/repo" }), "⎊ π - review - repo");
  assert.equal(buildTerminalTitle({ state: "completed", sessionName: "review", cwd: "/work/repo" }), "⌘ π - review - repo");
  assert.equal(buildTerminalTitle({ state: "idle", sessionName: "review", cwd: "/work/repo" }), "π - review - repo");
});

test("untrusted title components cannot inject controls and are bounded at graphemes", () => {
  const controls = "osc\u001b]0;bad\u0007 csi\u001b[31m\r\n c1\u009dtitle\u009c del\u007f end";
  const sanitized = sanitizeTitleComponent(controls);
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(sanitized), false);
  assert.equal(sanitized.includes("\u001b]"), false);
  assert.equal(sanitized.includes("\u009d"), false);

  const combining = "e\u0301".repeat(100);
  const combiningResult = sanitizeTitleComponent(combining);
  assert.ok(Buffer.byteLength(combiningResult, "utf8") <= TERMINAL_TITLE_COMPONENT_MAX_BYTES);
  assert.ok(combiningResult.endsWith("\u0301…"), "combining grapheme was split");

  const astral = "🧑🏽‍💻".repeat(100);
  const astralResult = sanitizeTitleComponent(astral);
  assert.ok(Buffer.byteLength(astralResult, "utf8") <= TERMINAL_TITLE_COMPONENT_MAX_BYTES);
  assert.equal(astralResult.includes("�"), false, "surrogate pair or emoji grapheme was split");
  assert.ok(astralResult.endsWith("…"));

  const title = buildTerminalTitle({
    state: "active",
    sessionName: `${controls}${combining}${astral}`,
    cwd: `/tmp/${controls}${astral}${combining}`,
  });
  assert.ok(title.startsWith("⚙︎ π - "), "fixed symbol prefix was split or discarded");
  assert.equal((title.match(/⚙︎/gu) || []).length, 1, "consumer duplicated its status prefix");
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(title), false);
  assert.ok(Buffer.byteLength(title, "utf8") <= TERMINAL_TITLE_MAX_BYTES);
  const dynamic = title.slice("⚙︎ π - ".length);
  assert.equal(dynamic.split(" - ").length >= 2, true, "session and cwd were not both retained");
  assert.equal((title.match(/…/gu) || []).length >= 2, true, "components were not independently truncated");
});
