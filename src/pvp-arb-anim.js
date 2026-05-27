// pvp-arb-anim.js — parallel animation driver for the PvP arbiter.
//
// v1.7.754 P-6c — drains `arbViewSt.pendingDeltas` one at a time, fires
// the existing visible-effect primitives (shake timer, damage numbers,
// dying map) per delta kind. Runs in parallel with the legacy
// `updatePVPBattle` FSM — never modifies its state transitions — but
// is gated on PVP_ARBITER so production behavior stays untouched
// until the P-9 flip.
//
// Hard-rule alignment (CLAUDE.md):
//   - Does NOT modify any existing animation code or FSM.
//   - Uses ONLY the existing setEnemyDmgNum / setSwDmgNum /
//     setPlayerDamageNum / pvpDyingMap primitives — same way the legacy
//     PvP path uses them, no novel state transitions invented.
//   - When PVP_ARBITER is off (production today), this driver is a
//     full no-op. Zero footprint on the existing engine.
//
// P-6c scope (minimum visible):
//   - 'attack' delta: shake target + damage number popup. Damage is
//     server-rolled (delta.damage); we just paint it.
//   - 'death' delta: stamp the dying map slot so the legacy death-wipe
//     animator picks it up.
//   - 'state defend-on' / 'sleep-skip' / 'status-tick' / 'end' / 'magic'
//     / 'item': inter-delta gap only, no extra visual yet. P-6d follows
//     up once magic + item server intents (P-4c) land.
//
// Important: the adapter (P-6b) already wrote `arbViewSt.combatants[*].hp`
// values into pvpSt at the end of the round, BEFORE this driver gets a
// chance to walk. That means the HP bar will snap to its post-round
// value while the damage numbers play out. The visual is "damage flash
// + shake while HP shows the final value" — recognizable as combat,
// not perfectly synced. P-6d would re-route HP writes through the
// driver if the snap proves jarring in live play.

import { PVP_ARBITER } from './net.js';
import { arbViewSt, drainPendingDeltas } from './pvp-arb-viewer.js';
import { pvpSt } from './pvp.js';
import { setEnemyDmgNum, setPlayerDamageNum, setSwDmgNum, createDmg, createMiss } from './damage-numbers.js';
import { BATTLE_SHAKE_MS, battleSt } from './battle-state.js';
import { queueBattleMsg } from './battle-msg.js';
import { _nameToBytes } from './text-utils.js';

// ── Per-delta dwell times ─────────────────────────────────────────────────
// Each kind plays for a fixed window before the driver pops the next
// delta. Tuned to roughly match the legacy PvP timing for the same
// visible event (shake = 300 ms; damage number = 750 ms).
const _DWELL_MS = {
  attack:       750,
  magic:        300,    // P-4c will lift this when magic intents land
  item:         300,
  'status-tick': 600,
  death:        800,
  state:        120,    // defend-on / wake / sleep-skip — short FSM flash
  end:          400,    // brief pause before teardown
};
const _DEFAULT_DWELL_MS = 250;

// ── Internal state ────────────────────────────────────────────────────────
// `_active` is the currently-playing delta + a countdown timer. `null`
// when idle (queue empty or waiting for next pvp-turn).
let _active = null;       // { delta, timer, dwellMs }

// ── Per-kind visual application ───────────────────────────────────────────
// Convert a delta's target cellId into the right damage-num slot +
// shake state. The legacy PvP renderer reads from:
//   - pvpSt.pvpOpponentShakeTimer  → shakes opponent main only
//   - setEnemyDmgNum / setSwDmgNum → opponent main / opponent allies
//   - setPlayerDamageNum / allyDmg → my main / my allies
//
// arbViewSt cellId convention (P-2): 0-3 = side A, 4-7 = side B; main
// is the lowest cellId on each side. yourSide tells us which range
// belongs to "me" vs "opponent" from this client's perspective.
function _isOppMain(cellId) {
  if (arbViewSt.yourSide === 'A') return cellId === 4;
  if (arbViewSt.yourSide === 'B') return cellId === 0;
  return false;
}
function _isOppAlly(cellId) {
  if (arbViewSt.yourSide === 'A') return cellId >= 5 && cellId <= 7;
  if (arbViewSt.yourSide === 'B') return cellId >= 1 && cellId <= 3;
  return false;
}
function _isMyMain(cellId) {
  if (arbViewSt.yourSide === 'A') return cellId === 0;
  if (arbViewSt.yourSide === 'B') return cellId === 4;
  return false;
}
function _oppAllyIdx(cellId) {
  // pvpSt.pvpEnemyAllies is indexed [0..n-1]; legacy code's
  // `setSwDmgNum(tidx, ...)` uses tidx = 1 + allyIdx (1 = first ally,
  // 2 = second, …) because slot 0 is the main opponent.
  if (arbViewSt.yourSide === 'A') return (cellId - 4);    // cell 5 → 1
  if (arbViewSt.yourSide === 'B') return cellId;          // cell 1 → 1
  return -1;
}

function _applyAttackVisual(delta) {
  const tid = delta.targetCellId | 0;
  const miss = delta.hit === false;
  const dmg = (delta.damage | 0);
  const crit = !!delta.crit;
  if (_isOppMain(tid)) {
    if (!miss) pvpSt.pvpOpponentShakeTimer = BATTLE_SHAKE_MS;
    setEnemyDmgNum(miss ? createMiss() : createDmg(dmg, crit));
  } else if (_isOppAlly(tid)) {
    // Allies don't have a dedicated shake timer in the legacy view;
    // skip shake but pop the per-cell damage number.
    setSwDmgNum(_oppAllyIdx(tid), miss ? { miss: true } : { value: dmg, crit });
  } else if (_isMyMain(tid)) {
    setPlayerDamageNum(miss ? createMiss() : createDmg(dmg, crit));
  }
  // Damage to MY allies (cellId 1-3 on side A, 5-7 on side B) — legacy
  // uses allyDamageNums keyed by ally idx. P-6d will cover that path
  // alongside the ally-shake equivalent.
}

function _applyDeathVisual(delta) {
  const tid = delta.actorCellId | 0;
  // Opponent main / ally → stamp the legacy dying map so the draw
  // path's death-wipe FSM picks it up. Map key = enemyIdx where 0 =
  // opponent main and 1+ = opponent allies. Player side death-handling
  // belongs to the legacy player engine; we just leave the HP at 0.
  if (_isOppMain(tid)) {
    pvpSt.pvpDyingMap = pvpSt.pvpDyingMap || new Map();
    pvpSt.pvpDyingMap.set(0, 0);
  } else if (_isOppAlly(tid)) {
    pvpSt.pvpDyingMap = pvpSt.pvpDyingMap || new Map();
    pvpSt.pvpDyingMap.set(_oppAllyIdx(tid), 0);
  }
  // P-6d: my-side allies + my-main death wipe.
}

// v1.7.756 P-8 — name strip set helper. The new spec says the strip
// shows only the attacker (mid-turn) and the highlighted target
// (during target-select). Per-delta hooks use this; the target-select
// hook lives in `executeBattleCommand` / `_switchPVPTarget`.
export function setArbStripName(cellId) {
  if (!PVP_ARBITER) return;
  const c = arbViewSt.combatants[cellId | 0];
  if (!c || !c.name) return;
  queueBattleMsg(_nameToBytes(c.name));
}

function _startDelta(delta) {
  _active = {
    delta,
    timer: 0,
    dwellMs: _DWELL_MS[delta.kind] || _DEFAULT_DWELL_MS,
  };
  switch (delta.kind) {
    case 'attack':
      // Name strip cuts to the attacker just before the visual fires
      // (matches the legacy lockstep pattern in pvp.js for opp casts).
      setArbStripName(delta.actorCellId);
      _applyAttackVisual(delta);
      break;
    case 'death':        _applyDeathVisual(delta); break;
    case 'state':        /* P-6d: defend pose etc. */ break;
    case 'magic':        /* P-4c + P-6d */ break;
    case 'item':         /* P-4c + P-6d */ break;
    case 'status-tick':  /* P-6d: poison-tick number popup */ break;
    case 'end':          /* P-6d: end fanfare; teardown in adapter */ break;
    default: break;
  }
}

// ── Tick ─────────────────────────────────────────────────────────────────
// Called once per game-loop frame from `game-loop.js`. Drives the
// active delta's countdown, advances to the next delta when done.
// No-ops when PVP_ARBITER is off OR no battle is active OR queue empty.
export function tickArbAnim(dt) {
  if (!PVP_ARBITER) return;
  if (!arbViewSt.inBattle && !_active) {
    // Drain any stragglers so we don't leak _active state between
    // back-to-back battles.
    if (arbViewSt.pendingDeltas.length > 0) drainPendingDeltas();
    return;
  }
  if (_active) {
    _active.timer += dt;
    if (_active.timer < _active.dwellMs) return;
    _active = null;
  }
  if (arbViewSt.pendingDeltas.length === 0) {
    // v1.7.755 P-7 — queue drained. If P-7's input rewire left
    // battleState parked in 'confirm-pause' (player just committed
    // and we wired up no local turn dispatch), and the server has
    // resolved the round (nextActor points back at us), drop the
    // player into 'menu' so they can pick again. The legacy turn
    // pump would do this via processNextTurn → battleState='menu';
    // under the arbiter we do it ourselves once the deltas finish.
    if (battleSt.battleState === 'confirm-pause'
        && arbViewSt.inBattle
        && arbViewSt.nextActor
        && arbViewSt.nextActor.cellId === arbViewSt.yourCellId) {
      // v1.7.763 — must be 'menu-open' (not 'menu'). 'menu-open' is the
      // state the input handler waits for (input-handler.js line 749);
      // 'menu' isn't a real state and silently dropped input, leaving
      // the player unable to commit a second action.
      battleSt.battleState = 'menu-open';
      battleSt.battleTimer = 0;
    }
    return;
  }
  // Drain one at a time so the next frame can play it. Don't
  // drainPendingDeltas() wholesale — that would discard the queue
  // before we play it.
  const next = arbViewSt.pendingDeltas.shift();
  _startDelta(next);
}

// Public reset — called by the adapter on battle-start / cancel so a
// stale `_active` doesn't bleed into the next battle.
export function resetArbAnim() {
  _active = null;
}

// ── Test exports (wire-sim only) ──────────────────────────────────────
// Wire-sim verifies the per-kind cellId → slot mapping via _testApply*.
// The actual visual effect (shake timer, dmg-num) isn't observable in
// Node — we just confirm the right primitives were called.
export { _isOppMain as _testIsOppMain, _isOppAlly as _testIsOppAlly, _isMyMain as _testIsMyMain };
