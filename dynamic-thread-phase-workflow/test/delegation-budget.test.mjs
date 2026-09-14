import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetState, reserveRoots, reserveChildren, chargeLaunchIntent, joinAllocation, allocationCounters,
  assertBudgetInvariants, calculateJournalHeadroom, assertJournalCapacity } from '../lib/delegation-budget.mjs';
const policy = (totalAgentBudget = 128, maxDepth = 4) => ({ totalAgentBudget, maxDepth, directoryScope: { read: ['.'], write: [] }, context: { objective: 'x', constraints: [] } });
const settled = { terminal: true, groupsInactive: true, structuralJoin: true };
const grant = (nodeId, agentBudget = 1) => ({ nodeId, agentBudget });
const start = (budget = 128) => chargeLaunchIntent(reserveRoots(createBudgetState(policy(budget)), [grant('r', budget)], 'roots'), 'r', 'launch-root');

test('atomic roots/batches, immutable state and digest-bound transition replay', () => {
  const empty = createBudgetState(policy(8));
  assert.throws(() => reserveRoots(empty, [grant('r', 7), grant('later', 2)], 'roots'), /BUDGET/);
  assert.equal(empty.nodes.length, 0);
  const roots = [grant('r', 6), grant('later', 2)];
  const reserved = reserveRoots(empty, roots, 'roots');
  assert.equal(reserveRoots(reserved, roots, 'roots'), reserved);
  assert.throws(() => reserveRoots(reserved, [grant('other')], 'roots'), /REQUEST_CONFLICT/);
  let s = chargeLaunchIntent(reserved, 'r', 'launch');
  assert.throws(() => reserveChildren(s, 'r', [grant('a', 3), grant('b', 3)], 'batch'), /BUDGET/);
  assert.throws(() => reserveChildren(s, 'r', [grant('a'), grant('a')], 'batch'));
  assert.equal(s.nodes.length, 2);
  s = reserveChildren(s, 'r', [grant('a', 3), grant('b', 2)], 'batch');
  assert.equal(reserveChildren(s, 'r', [grant('a', 3), grant('b', 2)], 'batch'), s);
  assert.throws(() => chargeLaunchIntent(s, 'b', 'too-early'), /serial/);
  assert.throws(() => reserveChildren(s, 'r', [grant('c')], 'parallel'), /PARENT_NOT_ACTIVE/);
  assert.throws(() => { s.nodes[0].available = 999; }, TypeError);
  assert.equal(allocationCounters(s, 'later').available, 2);
});

test('launch intent irreversibly charges failed/replacement attempts; no free retry', () => {
  let s = start(5);
  for (let i = 0; i < 4; i++) {
    s = reserveChildren(s, 'r', [grant(`c${i}`)], `accept${i}`);
    s = chargeLaunchIntent(s, `c${i}`, `launch${i}`);
    assert.equal(chargeLaunchIntent(s, `c${i}`, `launch${i}`), s);
    assert.throws(() => chargeLaunchIntent(s, `c${i}`, `replacement${i}`));
    s = joinAllocation(s, `c${i}`, settled, `join${i}`);
    assert.equal(joinAllocation(s, `c${i}`, settled, `join${i}`), s);
    assert.throws(() => joinAllocation(s, `c${i}`, settled, `join-again${i}`));
  }
  assert.equal(s.spent, 5); assert.equal(allocationCounters(s, 'r').available, 0);
  assert.throws(() => reserveChildren(s, 'r', [grant('excess')], 'excess'), /BUDGET/);
  s = joinAllocation(s, 'r', settled, 'close'); assert.equal(s.freeWorkflow, 0);
});

test('cancellation before/after launch returns only unused; ambiguity holds allocations', () => {
  let s = start(8);
  s = reserveChildren(s, 'r', [grant('a', 3), grant('b', 3)], 'batch');
  for (const change of [{ terminal: false }, { groupsInactive: false }, { structuralJoin: false }]) assert.throws(() => joinAllocation(s, 'a', { ...settled, ...change }, 'join'), /OWNERSHIP_UNKNOWN/);
  assert.equal(allocationCounters(s, 'r').reservedForChildren, 6);
  assert.throws(() => joinAllocation(s, 'r', settled, 'close'));
  s = joinAllocation(s, 'a', settled, 'join-a');
  s = chargeLaunchIntent(s, 'b', 'launch-b');
  s = joinAllocation(s, 'b', settled, 'join-b');
  assert.equal(s.spent, 2); assert.equal(allocationCounters(s, 'r').available, 6);
  s = joinAllocation(s, 'r', settled, 'close'); assert.equal(s.freeWorkflow, 6);
});

test('cumulative admission is not refunded by repeated prelaunch expiry', () => {
  let s = start(5);
  for (let i = 0; i < 127; i++) {
    s = reserveChildren(s, 'r', [grant(`expired${i}`)], `accept${i}`);
    s = joinAllocation(s, `expired${i}`, settled, `join${i}`);
  }
  assert.equal(s.spent, 1); assert.equal(s.acceptedNodes, 128);
  assert.equal(allocationCounters(s, 'r').available, 4);
  assert.throws(() => reserveChildren(s, 'r', [grant('overflow')], 'overflow'), /ADMISSION_LIMIT/);
  assert.equal(s.nodes[0].children.length, 127);
});

test('fixed later-root allocations cannot borrow closed-root surplus', () => {
  let s = reserveRoots(createBudgetState(policy(128)), [grant('first', 100), grant('last', 2)], 'roots');
  s = chargeLaunchIntent(s, 'first', 'first'); s = joinAllocation(s, 'first', settled, 'close-first');
  s = chargeLaunchIntent(s, 'last', 'last');
  assert.equal(s.freeWorkflow, 125);
  assert.throws(() => reserveChildren(s, 'last', [grant('c', 2)], 'borrow'), /BUDGET/);
  assert.equal(allocationCounters(s, 'last').available, 1);
});

test('maximum depth plus branch width with 128 credits, and depth-zero 128 sequential roots', () => {
  let s = start(); let parent = 'r'; const path = [];
  for (let depth = 1; depth <= 4; depth++) {
    const name = `d${depth}`;
    const available = allocationCounters(s, parent).available;
    s = reserveChildren(s, parent, [grant(name, available - 3), grant(`${name}b`), grant(`${name}c`), grant(`${name}d`)], `batch${depth}`);
    s = chargeLaunchIntent(s, name, `launch${depth}`); path.push(name); parent = name;
  }
  assert.equal(s.nodes.find(n => n.nodeId === parent).depth, 4);
  assert.throws(() => reserveChildren(s, parent, [grant('too-deep')], 'deep'), /DEPTH_LIMIT/);
  for (const name of path.reverse()) {
    s = joinAllocation(s, name, settled, `join-${name}`);
    for (const suffix of ['b', 'c', 'd']) {
      s = chargeLaunchIntent(s, name + suffix, `launch-${name}${suffix}`);
      s = joinAllocation(s, name + suffix, settled, `join-${name}${suffix}`);
    }
  }
  s = joinAllocation(s, 'r', settled, 'close'); assert.equal(s.spent, 17); assert.equal(s.freeWorkflow, 111);
  let zero = reserveRoots(createBudgetState(policy(128, 0)), Array.from({ length: 128 }, (_, i) => grant(`r${i}`)), 'roots');
  for (let i = 0; i < 128; i++) { zero = chargeLaunchIntent(zero, `r${i}`, `l${i}`); zero = joinAllocation(zero, `r${i}`, settled, `j${i}`); }
  assert.equal(zero.spent, 128); assert.equal(zero.freeWorkflow, 0);
  assert.throws(() => reserveRoots(createBudgetState(policy(2, 0)), [grant('r', 2)], 'roots'), /DEPTH_LIMIT/);
});

test('full 128 charged-node forest at max depth and four-child batches exhausts exactly the fixed root quota', () => {
  let s = start(); let serial = 0;
  function drain(nodeId, depth) {
    while (depth < 4 && allocationCounters(s, nodeId).available) {
      const available = allocationCounters(s, nodeId).available;
      const count = Math.min(4, available);
      const children = Array.from({ length: count }, (_, i) => grant(`full${++serial}`, Math.floor(available / count) + Number(i < available % count)));
      s = reserveChildren(s, nodeId, children, `accept-${children[0].nodeId}`);
      for (const c of children) {
        s = chargeLaunchIntent(s, c.nodeId, `launch-${c.nodeId}`);
        drain(c.nodeId, depth + 1);
        s = joinAllocation(s, c.nodeId, settled, `join-${c.nodeId}`);
      }
    }
  }
  drain('r', 0); s = joinAllocation(s, 'r', settled, 'close');
  assert.equal(s.spent, 128); assert.equal(s.acceptedNodes, 128); assert.equal(s.freeWorkflow, 0);
  assert.equal(Math.max(...s.nodes.map(n => n.depth)), 4);
});

test('deterministic adversarial operation sequences conserve quotas and never decrease spent', () => {
  for (let seed = 1; seed <= 12; seed++) {
    let rng = seed; const random = n => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng % n; };
    let s = start(32);
    for (let i = 0; i < 60; i++) {
      const previous = s; const parent = s.nodes[random(s.nodes.length)];
      try {
        if (random(3) === 0) s = reserveChildren(s, parent.nodeId, Array.from({ length: 1 + random(4) }, (_, j) => grant(`n${i}-${j}`, 1 + random(5))), `a${i}`);
        else if (random(2) === 0) s = chargeLaunchIntent(s, parent.nodeId, `l${i}`);
        else s = joinAllocation(s, parent.nodeId, random(4) ? settled : { ...settled, groupsInactive: false }, `j${i}`);
      } catch (error) { assert.match(error.message, /BUDGET|ADMISSION|DEPTH|PARENT|INVALID|OWNERSHIP/); assert.equal(s, previous); }
      assertBudgetInvariants(s); assert.ok(s.spent >= previous.spent);
    }
  }
});

test('journal headroom includes unlaunched obligations; ordinary records cannot consume closure reserves', () => {
  const obligations = { outstandingNodes: 128, outstandingBatches: 128, outstandingCommands: 16, workflowOpen: true };
  const headroom = calculateJournalHeadroom(obligations);
  assert.equal(headroom, (384 + 128 + 48 + 1) * 4096);
  const max = 16 * 1024 * 1024;
  assert.equal(assertJournalCapacity({ ...obligations, usedBytes: max - headroom - 65536, nextRecordBytes: 65536 }), headroom);
  assert.throws(() => assertJournalCapacity({ ...obligations, usedBytes: max - headroom - 65535, nextRecordBytes: 65536 }), /JOURNAL_LIMIT/);
  for (const change of [{ outstandingNodes: -1 }, { outstandingBatches: '1' }, { outstandingCommands: 129 }, { workflowOpen: 1 }]) assert.throws(() => calculateJournalHeadroom({ ...obligations, ...change }));
});
