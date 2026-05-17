#!/usr/bin/env node
// atb-fsm-sim.js — battle FSM timing simulator.
//
// Boots a minimal headless environment, imports the real updateBattle()
// from battle-update.js, drives it at simulated 60fps, and logs every
// state transition. Catches the class of bug that atb-sim (pure math)
// and battle-sim (pure combat math) miss: gauge-driven dispatch
// oscillating, stuck states, or actors dispatched in tight loops.
//
// Per memory `feedback_ff3mmo_pvp_wire_sim` — passing wire-sim doesn't
// mean live FSM works. Same applies here.

// ── 1. Stub browser globals so node-side imports don't blow up ────────────
const _stubCanvas = {
  width: 256, height: 240,
  getContext: () => _stubCtx,
};
const _stubCtx = new Proxy({}, {
  get: (_, prop) => {
    // canvas calls: return self for chainables, return stub fns for everything else
    if (prop === 'canvas') return _stubCanvas;
    if (prop === 'fillStyle' || prop === 'strokeStyle' || prop === 'globalAlpha' ||
        prop === 'globalCompositeOperation' || prop === 'imageSmoothingEnabled') return undefined;
    return () => {};
  },
  set: () => true,
});
globalThis.document = {
  createElement: () => _stubCanvas,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  visibilityState: 'visible',
  addEventListener: () => {},
  body: { appendChild: () => {} },
};
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  innerWidth: 1024, innerHeight: 768,
  __atbDebug: false,
};
globalThis.Image = function () { return { onload: null, onerror: null, src: '' }; };
globalThis.Audio = function () { return { play: () => {}, pause: () => {}, currentTime: 0, volume: 1 }; };
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) });
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] || null; },
  setItem(k, v) { this._store[k] = String(v); },
  removeItem(k) { delete this._store[k]; },
  clear() { this._store = {}; },
};
globalThis.sessionStorage = { ...globalThis.localStorage, _store: {} };

// ── 2. Import the engine + boot ROM-backed text decoder ──────────────────
let battleSt, ps, pvpSt, updateBattle, startRandomEncounter, inputSt;
let MONSTERS;
try {
  // Load ROM bytes + init the text decoder so monster-name lookups don't
  // throw when an action queues a battle message.
  const { readFileSync } = await import('node:fs');
  const { initTextDecoder } = await import('../src/text-decoder.js');
  initTextDecoder(readFileSync('FF3-English.nes'));

  ({ battleSt } = await import('../src/battle-state.js'));
  ({ ps } = await import('../src/player-stats.js'));
  ({ pvpSt } = await import('../src/pvp.js'));

  // Slice 4a — wire the ATB module's clock to our simulated time so wall-
  // clock-based gauge math advances in lockstep with sim ticks. Without
  // this, gauges would compute against real Date.now() and barely move
  // while the sim runs at light-speed through 1500 ticks.
  const atbMod = await import('../src/atb.js');
  atbMod._setNow(() => _simMs);

  const bu = await import('../src/battle-update.js');
  updateBattle = bu.updateBattle;
  ({ startRandomEncounter } = await import('../src/battle-encounter.js'));
  ({ inputSt } = await import('../src/input-handler.js'));
  ({ MONSTERS } = await import('../src/data/monsters.js'));

  // Production main.js wires these at boot. Without them, the per-module
  // _processNextTurn / _isTeamWiped / _resetBattleVars fall back to no-ops
  // and the FSM hangs on the first dispatch that needs to advance.
  const { initBattleAlly } = await import('../src/battle-ally.js');
  const { initBattleEnemy } = await import('../src/battle-enemy.js');
  const { initBattleEncounter } = await import('../src/battle-encounter.js');
  const { buildTurnOrder, processNextTurn } = await import('../src/battle-turn.js');
  const { resetBattleVars, isTeamWiped } = bu;
  initBattleEncounter({ resetBattleVars });
  initBattleAlly({ buildTurnOrder, processNextTurn, isTeamWiped });
  initBattleEnemy({ processNextTurn, isTeamWiped });
} catch (e) {
  console.error('atb-fsm-sim: import failed —', e.message);
  console.error(e.stack);
  process.exit(2);
}

// ── 3. Track state transitions ───────────────────────────────────────────
const _log = [];
let _lastState = null;
let _simMs = 0;

function _tick(dt = 16.67) {
  _simMs += dt;
  const before = battleSt.battleState;
  try {
    updateBattle(dt);
  } catch (e) {
    _log.push({ t: _simMs, kind: 'exception', msg: e.message });
    throw e;
  }
  const after = battleSt.battleState;
  if (after !== _lastState) {
    _log.push({ t: _simMs.toFixed(0), kind: 'state', from: _lastState, to: after });
    _lastState = after;
  }
}

// ── 4. Test helpers ──────────────────────────────────────────────────────
function _reset() {
  ps.hp = 100;
  ps.stats = { agi: 10, str: 10, vit: 10, int: 5, mnd: 5, maxHP: 100, level: 5 };
  ps.atk = 20; ps.def = 5; ps.hitRate = 80;
  ps.weaponR = 0x1E; ps.weaponL = null;
  ps.jobIdx = 0; ps.knownSpells = [];
  ps.status = null;
  battleSt.battleState = 'none';
  battleSt.battleAllies = [];
  battleSt.encounterMonsters = null;
  battleSt.turnQueue = [];
  battleSt.battleTimer = 0;
  battleSt.isDefending = false;
  battleSt.isRandomEncounter = false;
  battleSt.isWireEncounter = false;
  pvpSt.isPVPBattle = false;
  inputSt.playerActionPending = null;
  inputSt.targetIndex = 0;
  _lastState = null;
  _log.length = 0;
  _simMs = 0;
}

function _confirmAttackOnce() {
  // Simulate the player picking Fight on the first living monster.
  const targetIdx = battleSt.encounterMonsters.findIndex(m => m.hp > 0);
  if (targetIdx < 0) return;
  inputSt.playerActionPending = {
    command: 'fight',
    targetIndex: targetIdx,
    hitResults: [{ hit: true, dmg: 10, crit: false, miss: false, evaded: false }],
    slashFrames: [],
    slashOffX: 0, slashOffY: 0,
    slashX: 0, slashY: 0,
  };
  battleSt.battleState = 'confirm-pause';
  battleSt.battleTimer = 0;
}

// ── 5. Scenario: solo battle, idle (no input) ────────────────────────────
function _scenarioIdle() {
  console.log('\n═══ scenario: solo battle, no input (sit on full gauge) ═══');
  _reset();
  startRandomEncounter();
  battleSt.battleState = 'flash-strobe';
  for (let i = 0; i < 600; i++) _tick();
  _printLog();
}

// ── 6. Scenario: solo battle, attack once and observe full cycle ─────────
function _scenarioAttackOnce() {
  console.log('\n═══ scenario: solo battle, one attack cycle ═══');
  _reset();
  startRandomEncounter();
  battleSt.battleState = 'flash-strobe';
  let confirmed = false;
  for (let i = 0; i < 1800; i++) {  // 30 seconds
    _tick();
    if (!confirmed && battleSt.battleState === 'menu-open') {
      _confirmAttackOnce();
      confirmed = true;
    }
    if (battleSt.battleState === 'none') break;  // battle ended
  }
  _printLog();
}

// ── 7. Glitch detector — back-to-back identical transitions ──────────────
function _detectOscillation() {
  console.log('\n═══ checking for oscillation patterns ═══');
  // Look for A→B→A within ≤6 frames (≤100ms) — flicker.
  let flickers = 0;
  for (let i = 2; i < _log.length; i++) {
    if (_log[i].kind !== 'state') continue;
    const a = _log[i - 2], b = _log[i - 1], c = _log[i];
    if (a.kind !== 'state' || b.kind !== 'state') continue;
    if (a.from === c.to && a.to === c.from) {
      const dt = parseFloat(c.t) - parseFloat(a.t);
      if (dt < 100) {
        console.log(`  FLICKER: ${a.from}↔${a.to} within ${dt.toFixed(0)}ms @ t=${a.t}`);
        flickers++;
      }
    }
  }
  console.log(`  flickers detected: ${flickers}`);
}

function _printLog() {
  console.log(`  ticks: 600 | sim time: ${(_simMs/1000).toFixed(1)}s`);
  console.log(`  unique states visited: ${new Set(_log.filter(e => e.kind === 'state').map(e => e.to)).size}`);
  console.log(`  state transitions: ${_log.length}`);
  // Show first 40 + last 10 transitions for shape.
  const shown = _log.slice(0, 40);
  for (const e of shown) console.log(`  [${e.t}ms] ${e.from} → ${e.to}`);
  if (_log.length > 50) console.log(`  ... (${_log.length - 50} elided) ...`);
  for (const e of _log.slice(-10)) console.log(`  [${e.t}ms] ${e.from} → ${e.to}`);
}

// ── 9. Scenario: sit on full gauge, expect monster to attack ─────────────
function _scenarioMonsterActsWhileMenuOpen() {
  console.log('\n═══ scenario: sit on menu, monster should attack ═══');
  _reset();
  startRandomEncounter();
  battleSt.battleState = 'flash-strobe';
  let menuFirstSeenAt = -1;
  let monsterAttacked = false;
  let dumpedAt5s = false, dumpedAt10s = false;
  for (let i = 0; i < 1500; i++) {  // 25 seconds
    _tick();
    if (menuFirstSeenAt < 0 && battleSt.battleState === 'menu-open') {
      menuFirstSeenAt = _simMs;
    }
    if (battleSt.battleState === 'enemy-attack' ||
        battleSt.battleState === 'enemy-damage-show' ||
        battleSt.battleState === 'player-hit-show') {
      monsterAttacked = true;
    }
    // Diagnostic dumps
    if (!dumpedAt5s && _simMs >= 5000) {
      dumpedAt5s = true;
      _dumpGauges('5s');
    }
    if (!dumpedAt10s && _simMs >= 10000) {
      dumpedAt10s = true;
      _dumpGauges('10s');
    }
  }
  console.log(`  menu first opened: ${menuFirstSeenAt}ms`);
  console.log(`  monster attacked while idle: ${monsterAttacked ? 'YES' : 'NO'}`);
  if (!monsterAttacked) {
    console.log('  FAIL: monster never acted in 25 simulated seconds with player idle in menu');
  } else {
    console.log('  PASS');
  }
  _printLog();
}

function _dumpGauges(label) {
  console.log(`  [${label}] state=${battleSt.battleState}`);
  console.log(`    ps._atb = ${JSON.stringify(ps._atb)}`);
  for (let i = 0; i < (battleSt.encounterMonsters || []).length; i++) {
    const m = battleSt.encounterMonsters[i];
    console.log(`    mon[${i}] hp=${m.hp} _atb=${JSON.stringify(m._atb)}`);
  }
}

// ── 10. Run ──────────────────────────────────────────────────────────────
_scenarioIdle();
_detectOscillation();
_scenarioAttackOnce();
_detectOscillation();
_scenarioMonsterActsWhileMenuOpen();
_detectOscillation();
