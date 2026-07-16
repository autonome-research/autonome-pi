import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FANOUT_PAGE_SIZE,
  clampWindowScroll,
  detailViewportHeight,
  pageItems,
  windowLineRange,
} from "../lib/monitor-pagination.mjs";

const store = mkdtempSync(join(tmpdir(), "thread-phase-pagination-test-"));
process.env.PI_THREAD_PHASE_STORE_DIR = store;
process.on("exit", () => rmSync(store, { recursive: true, force: true }));

test("window scrolling clamps to content bounds and keeps the selected line visible", () => {
  assert.equal(clampWindowScroll(-10, 30, 8), 0);
  assert.equal(clampWindowScroll(99, 30, 8), 22);
  assert.equal(clampWindowScroll(4, 3, 8), 0);
  assert.deepEqual(windowLineRange(30, 8, 0, 12), { start: 5, end: 13, height: 8 });
  assert.deepEqual(windowLineRange(30, 8, 15, 4), { start: 4, end: 12, height: 8 });
});

test("expanding phase details preserves the selected viewport position", () => {
  const before = windowLineRange(30, 12, 8, 14);
  const afterExpansion = windowLineRange(40, 12, before.start, 14);
  assert.equal(afterExpansion.start, before.start);
  assert.ok(afterExpansion.start <= 14 && 14 < afterExpansion.end);
});

test("window calculations remain valid for zero and narrow widths", () => {
  assert.equal(detailViewportHeight(0), 12);
  assert.equal(detailViewportHeight(24), 12);
  assert.equal(detailViewportHeight(40), 16);
  assert.equal(detailViewportHeight(64), 20);
  assert.equal(detailViewportHeight(120), 24);
  assert.deepEqual(windowLineRange(2, 0, 20), { start: 1, end: 2, height: 1 });
});

test("fanout pages expose every item and clamp page navigation", () => {
  const items = Array.from({ length: 23 }, (_, index) => ({ itemId: `item-${index + 1}` }));
  const first = pageItems(items, 0, FANOUT_PAGE_SIZE);
  const second = pageItems(items, 1, FANOUT_PAGE_SIZE);
  const last = pageItems(items, 99, FANOUT_PAGE_SIZE);
  assert.deepEqual([first.start, first.end, first.pageCount], [0, 10, 3]);
  assert.deepEqual([second.start, second.end], [10, 20]);
  assert.deepEqual([last.page, last.start, last.end], [2, 20, 23]);
  assert.deepEqual([...first.items, ...second.items, ...last.items], items);
});

test("changing width recalculates the responsive detail viewport", () => {
  const wide = detailViewportHeight(100);
  const narrow = detailViewportHeight(32);
  assert.equal(wide, 24);
  assert.equal(narrow, 16);
  assert.notEqual(wide, narrow);
});
