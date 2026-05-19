#!/usr/bin/env node
// tools/coop-viewer-sim.js — co-op viewer regression harness (P8+).
//
// Tests `src/coop-viewer.js` end-to-end:
//   - Queue management (ordering, dup, gaps, depth cap)
//   - applyViewEvent → finalState writing
//   - Anim dispatch per kind
//   - Encounter lifecycle (start → turns → end → viewer exit)
//   - Host promotion handoff via `leaveViewerForPromotion`
//
// The viewer module pulls in browser-coupled imports through
// `battle-state.js`. Before importing the viewer we install enough
// `globalThis` shims to satisfy module-init reads of window/document/etc.
// This is similar to what jsdom would do but lighter — we don't need
// real DOM, just permissive stubs.
//
// Each scenario asserts post-state on battleSt / ps / coopViewSt
// directly. The viewer's `_testHooks.invokeAnim(kind, event, animState, dt)`
// is the entry point for direct anim invocation; queue/dispatch tests
// use `ingestViewEventPacket` + `updateCoopView(dt)`.
//
// Run:
//   node tools/coop-viewer-sim.js
//   node tools/coop-viewer-sim.js --filter=queue
//
// Spec: docs/COOP-VIEWER-PLAN.md#phases#P8.

// ── Browser shims (must run BEFORE module imports) ───────────────────────

const _stubEl = () => ({
  getContext: () => ({
    canvas: null,
    save: () => {}, restore: () => {},
    fillRect: () => {}, drawImage: () => {},
    createImageData: () => ({ data: [] }),
    getImageData:    () => ({ data: [] }),
    clearRect: () => {}, beginPath: () => {}, closePath: () => {},
    moveTo: () => {}, lineTo: () => {}, stroke: () => {},
    arc: () => {}, fill: () => {},
    setTransform: () => {}, translate: () => {}, scale: () => {},
    rotate: () => {}, font: '', textAlign: 'left',
    fillText: () => {}, strokeText: () => {},
    measureText: () => ({ width: 0 }),
  }),
  width: 256, height: 240,
  style: {},
  addEventListener: () => {}, removeEventListener: () => {},
  classList: { add: () => {}, remove: () => {}, contains: () => false },
  querySelector: () => null,
  appendChild: () => {}, removeChild: () => {},
  setAttribute: () => {}, getAttribute: () => null,
  parentNode: null,
});

globalThis.window = {
  addEventListener:    () => {},
  removeEventListener: () => {},
  location:            { href: '' },
  devicePixelRatio:    1,
  innerWidth:          800,
  innerHeight:         600,
};
globalThis.document = {
  createElement:   _stubEl,
  getElementById:  _stubEl,
  querySelector:   _stubEl,
  querySelectorAll: () => [],
  addEventListener: () => {},
  body:            { appendChild: () => {}, querySelector: () => null },
  head:            { appendChild: () => {} },
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame  = () => {};
globalThis.Image = class { constructor() { this.onload = null; } };
globalThis.Audio = class { constructor() {} play() {} pause() {} };
globalThis.AudioContext = class {
  constructor() {}
  createGain() { return { gain: { value: 0 }, connect: () => {} }; }
  createBufferSource() { return { buffer: null, connect: () => {}, start: () => {} }; }
  decodeAudioData() { return Promise.resolve({}); }
  get destination() { return {}; }
};
globalThis.Worker = class {
  constructor() {}
  postMessage() {}
  addEventListener() {}
  terminate() {}
};
globalThis.localStorage = {
  _kv: new Map(),
  getItem(k)        { return this._kv.has(k) ? this._kv.get(k) : null; },
  setItem(k, v)     { this._kv.set(k, String(v)); },
  removeItem(k)     { this._kv.delete(k); },
  clear()           { this._kv.clear(); },
};
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
globalThis.WebSocket = class {
  constructor() { this.readyState = 0; }
  send() {} close() {}
  addEventListener() {} removeEventListener() {}
};

// ── Imports (after shims) ───────────────────────────────────────────────

const { battleSt } = await import('../src/battle-state.js');
const { ps } = await import('../src/player-stats.js');
const {
  buildAttackViewEvent, buildMagicViewEvent, buildMonsterAttackViewEvent,
  buildPoisonTickViewEvent, buildMonsterDeathViewEvent, buildPlayerDeathViewEvent,
  buildEncounterStartViewEvent, buildEncounterEndViewEvent, buildTurnBeginViewEvent,
  buildItemViewEvent, buildFinalState, wrapViewEventForWire,
} = await import('../src/coop-deltas.js');
const {
  coopViewSt, enterViewerMode, exitViewerMode, leaveViewerForPromotion,
  ingestViewEventPacket, updateCoopView, _testHooks,
} = await import('../src/coop-viewer.js');
const { getSwDmgNums, getAllyDamageNums } = await import('../src/damage-numbers.js');


// ── Test runner ─────────────────────────────────────────────────────────

const ONLY_FILTER = (() => {
  const a = process.argv.find(x => x.startsWith('--filter='));
  return a ? a.split('=')[1] : null;
})();

let _passed = 0, _failed = 0;
const _failures = [];

function test(name, fn) {
  if (ONLY_FILTER && !name.toLowerCase().includes(ONLY_FILTER.toLowerCase())) return;
  let err = null;
  try { fn(); }
  catch (e) { err = e; }
  if (err) {
    _failed++;
    _failures.push({ name, err });
    console.log('  ✗ ' + name);
    console.log('    ' + err.message.split('\n')[0]);
  } else {
    _passed++;
    console.log('  ✓ ' + name);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'assertEqual fail') + `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg || 'assertTrue fail');
}
function assertDeep(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || 'assertDeep fail') + `: expected ${b}, got ${a}`);
}

function resetState() {
  // Wipe coopViewSt
  exitViewerMode();
  // Reset battleSt / ps to a known minimal shape
  battleSt.encounterMonsters = null;
  battleSt.battleAllies = [];
  battleSt.isWireEncounter = false;
  battleSt.encounterIsHost = false;
  battleSt.encounterHostUserId = 0;
  battleSt.battleState = 'none';
  battleSt.battleTimer = 0;
  battleSt.dyingMonsterIndices = new Map();
  ps.hp = 100; ps.mp = 50;
  ps.status = { mask: 0, poisonDmgTick: 0 };
}

// Stub getMyUserId — the viewer reads it via net.js export. We can't
// easily override it (module-loaded), but we can rely on the fact that
// the viewer's actor resolution uses the value at call time. Since
// tests don't initialize ws-presence, getMyUserId returns 0. For tests
// that need a specific uid, we use that uid in ActorRefs but skip the
// "is this me" branch by setting target userId != 0.
//
// To control myUid we can attempt a re-import shim. For v1 the harness
// runs with myUid=0 and ActorRefs use peer uids; finalState writes go
// to battleAllies (matched by userId).

// ── Scenarios ───────────────────────────────────────────────────────────

console.log('═══ coop-viewer-sim ═══');

// ── 1. Queue management ──────────────────────────────────────────────────

console.log('\n── queue management ──');

test('enterViewerMode + exitViewerMode toggle active state', () => {
  resetState();
  // Build-time flag affects whether enterViewerMode flips active. Either
  // way exitViewerMode unconditionally sets it false.
  enterViewerMode();
  // Under flag-on (P9+) active becomes true. Under flag-off no-op.
  // We don't bind to either since the flag is the variable under test;
  // assert exitViewerMode tears it back down deterministically.
  exitViewerMode();
  assertEqual(coopViewSt.active, false, 'exitViewerMode clears active');
  assertEqual(coopViewSt.cueQueue.length, 0, 'exitViewerMode clears queue');
});

test('injectEvent queues by turnIdx', () => {
  resetState();
  _testHooks.forceActive();
  coopViewSt.lastAppliedTurnIdx = 0;
  _testHooks.injectEvent({ eventKind: 'attack', animMs: 100, finalState: { actors: [], monsters: [] } }, 3);
  _testHooks.injectEvent({ eventKind: 'attack', animMs: 100, finalState: { actors: [], monsters: [] } }, 1);
  _testHooks.injectEvent({ eventKind: 'attack', animMs: 100, finalState: { actors: [], monsters: [] } }, 2);
  assertEqual(coopViewSt.cueQueue.length, 3);
  assertEqual(coopViewSt.cueQueue[0].turnIdx, 1, 'turnIdx 1 first');
  assertEqual(coopViewSt.cueQueue[1].turnIdx, 2, 'turnIdx 2 second');
  assertEqual(coopViewSt.cueQueue[2].turnIdx, 3, 'turnIdx 3 last');
  _testHooks.forceInactive();
});

test('injectEvent drops dup turnIdx', () => {
  resetState();
  _testHooks.forceActive();
  coopViewSt.lastAppliedTurnIdx = 5;
  _testHooks.injectEvent({ eventKind: 'attack' }, 5);
  _testHooks.injectEvent({ eventKind: 'attack' }, 3);
  _testHooks.injectEvent({ eventKind: 'attack', animMs: 100, finalState: { actors: [], monsters: [] } }, 6);
  assertEqual(coopViewSt.cueQueue.length, 1, 'only turnIdx 6 queued');
  assertEqual(coopViewSt.cueQueue[0].turnIdx, 6);
  _testHooks.forceInactive();
});

test('queue caps at 32 entries', () => {
  resetState();
  _testHooks.forceActive();
  coopViewSt.lastAppliedTurnIdx = 0;
  for (let i = 1; i <= 40; i++) {
    _testHooks.injectEvent({ eventKind: 'attack', animMs: 100, finalState: { actors: [], monsters: [] } }, i);
  }
  assertEqual(coopViewSt.cueQueue.length, 32, 'capped at 32');
  // Oldest dropped — first remaining is 9 (we dropped 8)
  assertEqual(coopViewSt.cueQueue[0].turnIdx, 9);
  assertEqual(coopViewSt.cueQueue[31].turnIdx, 40);
  _testHooks.forceInactive();
});

test('ingestViewEventPacket is no-op without flag (default build)', () => {
  resetState();
  // No forceActive — flag is build-time false
  ingestViewEventPacket({ turnIdx: 1, viewEvent: { eventKind: 'attack' } });
  assertEqual(coopViewSt.cueQueue.length, 0);
});

// ── 2. Direct anim invocation ────────────────────────────────────────────

console.log('\n── direct anim invocation ──');

test('attack anim — animMs elapsed → done=true', () => {
  resetState();
  const event = buildAttackViewEvent({
    actor:  { kind: 'player', userId: 100 },
    target: { kind: 'monster', idx: 0 },
    hits:   [{ damage: 10, miss: false, crit: false, shieldBlock: false }],
    finalState: buildFinalState({ monsters: [{ idx: 0, hp: 90, statusMask: 0, alive: true }] }),
  });
  // Need a monster slot to dispatch damage-num
  battleSt.encounterMonsters = [{ monsterId: 0, hp: 100, maxHP: 100, status: { mask: 0 } }];
  const animState = { elapsedMs: 0, kind: 'attack' };
  let r = _testHooks.invokeAnim('attack', event, animState, 100);
  assertEqual(r.done, false, 'not done at 100ms');
  r = _testHooks.invokeAnim('attack', event, animState, 500);
  assertEqual(r.done, true, 'done at 600ms total');
});

test('attack anim sets swDmgNum on first frame', () => {
  resetState();
  battleSt.encounterMonsters = [{ monsterId: 0, hp: 100, maxHP: 100, status: { mask: 0 } }];
  const event = buildAttackViewEvent({
    actor:  { kind: 'player', userId: 100 },
    target: { kind: 'monster', idx: 0 },
    hits:   [{ damage: 25, miss: false, crit: false, shieldBlock: false }],
    finalState: buildFinalState({ monsters: [{ idx: 0, hp: 75, statusMask: 0, alive: true }] }),
  });
  const animState = { elapsedMs: 0, kind: 'attack' };
  _testHooks.invokeAnim('attack', event, animState, 16);
  
  const num = getSwDmgNums()[0];
  assertTrue(num != null, 'damage-num set');
  assertEqual(num.value, 25);
});

test('magic anim — multi-target damage cues', () => {
  resetState();
  battleSt.encounterMonsters = [
    { monsterId: 0, hp: 100, maxHP: 100, status: { mask: 0 } },
    { monsterId: 0, hp: 100, maxHP: 100, status: { mask: 0 } },
  ];
  const event = buildMagicViewEvent({
    actor:   { kind: 'player', userId: 100 },
    spellId: 0x21,
    targets: [
      { ref: { kind: 'monster', idx: 0 }, result: 'hit', dmg: 30 },
      { ref: { kind: 'monster', idx: 1 }, result: 'hit', dmg: 28 },
    ],
    finalState: buildFinalState({ monsters: [
      { idx: 0, hp: 70, statusMask: 0, alive: true },
      { idx: 1, hp: 72, statusMask: 0, alive: true },
    ] }),
  });
  const animState = { elapsedMs: 0, kind: 'magic' };
  _testHooks.invokeAnim('magic', event, animState, 16);
  
  assertEqual(getSwDmgNums()[0].value, 30);
  assertEqual(getSwDmgNums()[1].value, 28);
});

test('monster-death anim sets dyingMonsterIndices, clears at end', () => {
  resetState();
  battleSt.encounterMonsters = [{ monsterId: 0, hp: 0, maxHP: 100, status: { mask: 0 } }];
  const event = buildMonsterDeathViewEvent({
    monsterIdx: 0,
    finalState: buildFinalState({ monsters: [{ idx: 0, hp: 0, statusMask: 0, alive: false }] }),
  });
  const animState = { elapsedMs: 0, kind: 'monster-death' };
  _testHooks.invokeAnim('monster-death', event, animState, 16);
  assertTrue(battleSt.dyingMonsterIndices.has(0), 'idx 0 marked dying');
  // tick to completion
  _testHooks.invokeAnim('monster-death', event, animState, 800);
  assertTrue(!battleSt.dyingMonsterIndices.has(0), 'idx 0 cleared at end');
});

test('poison-tick anim writes damage-nums for each affected', () => {
  resetState();
  battleSt.encounterMonsters = [{ monsterId: 0, hp: 100, maxHP: 100, status: { mask: 2 } }];
  battleSt.battleAllies = [{ userId: 200, name: 'A', hp: 50, maxHP: 60, status: { mask: 2 } }];
  const event = buildPoisonTickViewEvent({
    ticks: [
      { ref: { kind: 'monster', idx: 0 }, dmg: 5, kills: false },
      { ref: { kind: 'player', userId: 200 }, dmg: 1, kills: false },
    ],
    finalState: buildFinalState({
      actors: [{ ref: { kind: 'player', userId: 200 }, hp: 49, statusMask: 2, alive: true }],
      monsters: [{ idx: 0, hp: 95, statusMask: 2, alive: true }],
    }),
  });
  const animState = { elapsedMs: 0, kind: 'poison-tick' };
  _testHooks.invokeAnim('poison-tick', event, animState, 16);
  
  assertEqual(getSwDmgNums()[0].value, 5, 'monster poison dmg');
  assertEqual(getAllyDamageNums()[0].value, 1, 'ally poison dmg');
});

// ── 3. Full dispatch loop ────────────────────────────────────────────────

console.log('\n── dispatch loop ──');

test('updateCoopView consumes one event per anim cycle', () => {
  resetState();
  _testHooks.forceActive();
  coopViewSt.lastAppliedTurnIdx = 0;
  battleSt.encounterMonsters = [{ monsterId: 0, hp: 100, maxHP: 100, status: { mask: 0 } }];

  const event = buildAttackViewEvent({
    actor:  { kind: 'player', userId: 100 },
    target: { kind: 'monster', idx: 0 },
    hits:   [{ damage: 50, miss: false, crit: false, shieldBlock: false }],
    finalState: buildFinalState({ monsters: [{ idx: 0, hp: 50, statusMask: 0, alive: true }] }),
  });
  _testHooks.injectEvent(event, 1);

  updateCoopView(16);
  assertTrue(coopViewSt.currentAnim != null, 'anim started');
  // run anim to completion (animMs = 600)
  updateCoopView(700);
  assertEqual(battleSt.encounterMonsters[0].hp, 50, 'finalState applied');
  assertEqual(coopViewSt.lastAppliedTurnIdx, 1, 'turnIdx advanced');
  assertEqual(coopViewSt.currentAnim, null, 'anim cleared');
  _testHooks.forceInactive();
});

test('updateCoopView chains multiple events sequentially', () => {
  resetState();
  _testHooks.forceActive();
  coopViewSt.lastAppliedTurnIdx = 0;
  battleSt.encounterMonsters = [{ monsterId: 0, hp: 100, maxHP: 100, status: { mask: 0 } }];

  for (let i = 1; i <= 3; i++) {
    _testHooks.injectEvent(buildAttackViewEvent({
      actor:  { kind: 'player', userId: 100 },
      target: { kind: 'monster', idx: 0 },
      hits:   [{ damage: 10, miss: false, crit: false, shieldBlock: false }],
      finalState: buildFinalState({ monsters: [{ idx: 0, hp: 100 - i*10, statusMask: 0, alive: true }] }),
    }), i);
  }
  // Drive enough ticks to finish all 3 (600ms each + epsilon)
  for (let i = 0; i < 5; i++) updateCoopView(700);
  assertEqual(coopViewSt.lastAppliedTurnIdx, 3);
  assertEqual(battleSt.encounterMonsters[0].hp, 70, 'final hp = 100 - 30');
  assertEqual(coopViewSt.cueQueue.length, 0);
  _testHooks.forceInactive();
});

test('unknown eventKind → warn + finalState applied immediately', () => {
  resetState();
  _testHooks.forceActive();
  coopViewSt.lastAppliedTurnIdx = 0;
  battleSt.encounterMonsters = [{ monsterId: 0, hp: 100, maxHP: 100, status: { mask: 0 } }];

  // Silence console.warn for this test
  const origWarn = console.warn;
  console.warn = () => {};
  _testHooks.injectEvent({
    eventKind: 'unicorn-attack-future-feature',
    animMs: 100,
    finalState: buildFinalState({ monsters: [{ idx: 0, hp: 42, statusMask: 0, alive: true }] }),
  }, 1);
  updateCoopView(16);
  console.warn = origWarn;
  assertEqual(battleSt.encounterMonsters[0].hp, 42, 'unknown event still applies finalState');
  assertEqual(coopViewSt.lastAppliedTurnIdx, 1);
  _testHooks.forceInactive();
});

// ── 4. Encounter lifecycle ───────────────────────────────────────────────

console.log('\n── encounter lifecycle ──');

test('encounter-start event bootstraps battleSt', () => {
  resetState();
  _testHooks.forceActive();
  coopViewSt.lastAppliedTurnIdx = 0;
  // Pre-state: empty battle
  battleSt.encounterMonsters = null;
  battleSt.battleAllies = [];

  const event = buildEncounterStartViewEvent({
    monsters: [{ monsterId: 1, hp: 50, maxHP: 50, statusMask: 0 }],
    combatants: [
      { userId: 100, name: 'Host', hp: 80, maxHP: 100, jobIdx: 0, level: 5, palIdx: 0, atk: 20, def: 10, agi: 8 },
      { userId: 200, name: 'Guest', hp: 70, maxHP: 90, jobIdx: 1, level: 4, palIdx: 1, atk: 18, def: 12, agi: 7 },
    ],
    hostUserId: 100,
    midBattle: false,
    finalState: { actors: [], monsters: [] },
  });
  _testHooks.injectEvent(event, 1);
  // First frame — anim sets monsters + allies
  updateCoopView(16);
  assertEqual(battleSt.encounterMonsters.length, 1);
  assertEqual(battleSt.encounterMonsters[0].monsterId, 1);
  assertEqual(battleSt.encounterMonsters[0].hp, 50);
  // myUid=0 in tests → both combatants are non-self → both end up in battleAllies
  assertEqual(battleSt.battleAllies.length, 2);
  assertEqual(battleSt.battleAllies[0].userId, 100);
  assertEqual(battleSt.battleAllies[1].userId, 200);
  assertEqual(battleSt.isWireEncounter, true);
  assertEqual(battleSt.encounterHostUserId, 100);
  assertEqual(battleSt.battleState, 'flash-strobe');
  _testHooks.forceInactive();
});

test('encounter-end event exits viewer mode', () => {
  resetState();
  _testHooks.forceActive();
  coopViewSt.lastAppliedTurnIdx = 0;

  const event = buildEncounterEndViewEvent({
    outcome: 'victory',
    rewards: { exp: 100, gil: 50, drops: [] },
    finalState: { actors: [], monsters: [] },
  });
  _testHooks.injectEvent(event, 1);
  // Drive past animMs (2000)
  updateCoopView(16);
  updateCoopView(2100);
  assertEqual(coopViewSt.active, false, 'viewer exited after encounter-end');
  assertEqual(battleSt.battleState, 'victory-name-out', 'transitioned to victory flow');
});

// ── 5. Host promotion handoff ────────────────────────────────────────────

console.log('\n── host promotion ──');

test('leaveViewerForPromotion returns lastAppliedTurnIdx + tears down', () => {
  resetState();
  coopViewSt.active = true;
  coopViewSt.cueQueue.length = 0;
  coopViewSt.lastAppliedTurnIdx = 7;

  const lastIdx = leaveViewerForPromotion();
  assertEqual(lastIdx, 7);
  assertEqual(coopViewSt.active, false);
  assertEqual(coopViewSt.lastAppliedTurnIdx, 0);
});

// ── 6. ViewEvent wire envelope ───────────────────────────────────────────

console.log('\n── wire envelope ──');

test('wrapViewEventForWire produces full envelope with turnIdx', () => {
  const ev = buildAttackViewEvent({
    actor:  { kind: 'player', userId: 100 },
    target: { kind: 'monster', idx: 0 },
    hits:   [],
    finalState: buildFinalState(),
  });
  const wire = wrapViewEventForWire(ev, 42);
  assertEqual(wire.turnIdx, 42);
  assertEqual(wire.action.kind, 'attack');
  assertTrue(wire.viewEvent != null, 'viewEvent attached');
  assertEqual(wire.viewEvent.eventKind, 'attack');
});

test('wrapViewEventForWire encounter-end flips meta.encounterEnd', () => {
  const ev = buildEncounterEndViewEvent({ outcome: 'victory' });
  const wire = wrapViewEventForWire(ev, 99);
  assertEqual(wire.meta.encounterEnd, true);
  assertEqual(wire.meta.outcome, 'victory');
});

// ── 7. finalState writer ─────────────────────────────────────────────────

console.log('\n── finalState writer ──');

test('finalState writes actor hp + statusMask to battleAllies', () => {
  resetState();
  _testHooks.forceActive();
  coopViewSt.lastAppliedTurnIdx = 0;
  battleSt.battleAllies = [{ userId: 200, name: 'A', hp: 100, maxHP: 100, status: { mask: 0 } }];

  const event = buildMonsterAttackViewEvent({
    monsterIdx: 0,
    target: { kind: 'player', userId: 200 },
    dmg: 30,
    finalState: buildFinalState({ actors: [{ ref: { kind: 'player', userId: 200 }, hp: 70, statusMask: 4, alive: true }] }),
  });
  battleSt.encounterMonsters = [{ monsterId: 0, hp: 50, maxHP: 50, status: { mask: 0 } }];
  _testHooks.injectEvent(event, 1);
  updateCoopView(16);
  updateCoopView(800);  // anim done
  assertEqual(battleSt.battleAllies[0].hp, 70);
  assertEqual(battleSt.battleAllies[0].status.mask, 4);
  _testHooks.forceInactive();
});

test('finalState writes monster hp', () => {
  resetState();
  _testHooks.forceActive();
  coopViewSt.lastAppliedTurnIdx = 0;
  battleSt.encounterMonsters = [{ monsterId: 0, hp: 100, maxHP: 100, status: { mask: 0 } }];

  const event = buildAttackViewEvent({
    actor:  { kind: 'player', userId: 100 },
    target: { kind: 'monster', idx: 0 },
    hits:   [{ damage: 35, miss: false, crit: false, shieldBlock: false }],
    finalState: buildFinalState({ monsters: [{ idx: 0, hp: 65, statusMask: 0, alive: true }] }),
  });
  _testHooks.injectEvent(event, 1);
  updateCoopView(16);
  updateCoopView(700);
  assertEqual(battleSt.encounterMonsters[0].hp, 65);
  _testHooks.forceInactive();
});

test('finalState ignores unresolvable refs (stale peer)', () => {
  resetState();
  _testHooks.forceActive();
  coopViewSt.lastAppliedTurnIdx = 0;
  battleSt.battleAllies = [];  // no allies

  const event = buildMonsterAttackViewEvent({
    monsterIdx: 0,
    target: { kind: 'player', userId: 999 },  // doesn't exist
    dmg: 30,
    finalState: buildFinalState({ actors: [{ ref: { kind: 'player', userId: 999 }, hp: 70, statusMask: 0, alive: true }] }),
  });
  battleSt.encounterMonsters = [{ monsterId: 0, hp: 50, maxHP: 50, status: { mask: 0 } }];
  _testHooks.injectEvent(event, 1);
  updateCoopView(16);
  updateCoopView(800);
  // No crash — just silently no-op the unresolved write
  assertEqual(coopViewSt.lastAppliedTurnIdx, 1, 'turnIdx advanced');
  _testHooks.forceInactive();
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n═══ summary ═══`);
console.log(`  passed: ${_passed}`);
console.log(`  failed: ${_failed}`);
if (_failed > 0) {
  for (const f of _failures) console.log(`  - ${f.name}: ${f.err.message.split('\n')[0]}`);
  process.exit(1);
}
