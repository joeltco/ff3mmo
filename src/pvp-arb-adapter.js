// pvp-arb-adapter.js — legacy state mirror for the PvP arbiter viewer.
//
// v1.7.753 P-6b — render integration without forking pvp-drawing.js.
// Registers as the viewer's post-update callback; on every battle-start /
// pvp-turn / state-resync, mirrors `arbViewSt.combatants` into the legacy
// state bags (`pvpSt`, `ps`, `battleSt.battleAllies`) that the existing
// PvP draw code reads from. Result: opponents + player HP + ally panel
// all render correctly under the arbiter path without rewriting the
// draw layer.
//
// Animations are NOT driven from this adapter — pvpSt FSM fields (cast
// windups, slash overlays, shake timers) stay untouched. P-6c lands the
// animation queue runner that walks `drainPendingDeltas()`.
//
// Flag-gated on `PVP_ARBITER`. When false (current production), the
// post-update callback short-circuits — pvpSt + ps + battleAllies stay
// owned by the legacy lockstep path. When true (P-9 onward), this
// adapter is the sole writer of the data-shape fields during a battle.

import { PVP_ARBITER } from './net.js';
import { arbViewSt, setArbViewUpdated } from './pvp-arb-viewer.js';
import { pvpSt } from './pvp.js';
import { ps } from './player-stats.js';
import { battleSt } from './battle-state.js';
import { resetArbAnim } from './pvp-arb-anim.js';

// ── Adapter ───────────────────────────────────────────────────────────────

// Convert one arbViewSt combatant into the pvpSt.pvpEnemyAllies entry
// shape. The legacy entry shape is `generateAllyStats()` output (see
// data/players.js); the wire combatant shape is its near-superset.
// Only difference worth normalizing:
//   wire .weaponR / .weaponL → legacy .weaponId / .weaponL
//   wire .statusMask (int)   → legacy .status { mask, poisonDmgTick }
// Everything else (name, jobIdx, hp, maxHP, atk, def, ...) passes through.
function _toLegacyShape(c) {
  return {
    name:        c.name,
    palIdx:      c.palIdx | 0,
    jobIdx:      c.jobIdx | 0,
    level:       (c.level | 0) || 1,
    hp:          c.hp | 0,
    maxHP:       c.maxHP | 0,
    mp:          c.mp | 0,
    maxMP:       c.maxMP | 0,
    atk:         c.atk | 0,
    def:         c.def | 0,
    agi:         (c.agi | 0) || 1,
    int:         c.intStat | 0,
    mnd:         c.mndStat | 0,
    evade:       c.evade | 0,
    mdef:        c.mdef | 0,
    shieldEvade: c.shieldEvade | 0,
    statusResist: c.statusResist | 0,
    elemResist:  Array.isArray(c.elemResist) ? [...c.elemResist] : [],
    hitRate:     (c.hitRate | 0) || 80,
    weaponId:    c.weaponR != null ? c.weaponR : 0x1E,
    weaponL:     c.weaponL != null ? c.weaponL : null,
    knownSpells: Array.isArray(c.knownSpells) ? [...c.knownSpells] : [],
    jobLevel:    (c.jobLevel | 0) || 1,
    status:      { mask: (c.statusMask | 0), poisonDmgTick: 0 },
    buffs:       {},
  };
}

// Pure sync function. Mirrors arbViewSt → legacy bags. Unconditional —
// callers must gate on PVP_ARBITER + arbViewSt.inBattle if they want
// the production semantics. Wire-sim calls this directly (without the
// flag gate) to verify the shape conversion in isolation.
function _syncToLegacy() {
  if (!arbViewSt.inBattle) return;
  const mySide = arbViewSt.yourSide;
  if (!mySide) return;
  const oppSide = mySide === 'A' ? 'B' : 'A';
  // Opposite side main + mates → pvpSt opponent + enemy allies.
  let oppMain = null;
  const oppMates = [];
  for (const c of arbViewSt.combatants) {
    if (!c) continue;
    if (c.side !== oppSide) continue;
    if (oppMain == null) { oppMain = c; }
    else                 { oppMates.push(c); }
  }
  pvpSt.isPVPBattle = true;
  if (oppMain) {
    pvpSt.pvpOpponent = pvpSt.pvpOpponent || {
      userId: oppMain.userId,
      name:   oppMain.name,
      jobIdx: oppMain.jobIdx,
    };
    pvpSt.pvpOpponentStats = _toLegacyShape(oppMain);
  } else {
    pvpSt.pvpOpponentStats = null;
  }
  pvpSt.pvpEnemyAllies = oppMates.map(_toLegacyShape);
  // My side main → ps (hp/mp/status). Don't touch ps.stats — the base
  // stats are local-owned. Only the in-battle-mutated fields mirror.
  // My side mates → battleSt.battleAllies.
  let myMain = null;
  const myMates = [];
  for (const c of arbViewSt.combatants) {
    if (!c) continue;
    if (c.side !== mySide) continue;
    if (c.cellId === arbViewSt.yourCellId) { myMain = c; }
    else                                   { myMates.push(c); }
  }
  if (myMain) {
    // Server is authoritative on combat HP/MP/status during a PvP
    // battle. Local ps changes (eg. potion sips outside battle) don't
    // get clobbered because this adapter only fires while
    // arbViewSt.inBattle === true.
    ps.hp = myMain.hp | 0;
    ps.mp = myMain.mp | 0;
    if (!ps.status) ps.status = { mask: 0, poisonDmgTick: 0 };
    ps.status.mask = myMain.statusMask | 0;
  }
  battleSt.battleAllies = myMates.map(_toLegacyShape);
}

// Production callback — gates on PVP_ARBITER so the legacy lockstep
// path stays unaffected when the flag is off. Wire-sim bypasses this
// wrapper and calls `_syncToLegacy` directly.
let _lastBattleId = 0;
function _syncIfEnabled() {
  if (!PVP_ARBITER) return;
  // Drop any in-flight animation when the battle changes (start of a
  // new battle, or current battle teardown). Defensive — pendingDeltas
  // is queue-cleared by the viewer on start, but `_active` in the anim
  // driver outlives that and would mis-fire on the next battle's first
  // round.
  if (arbViewSt.battleId !== _lastBattleId) {
    resetArbAnim();
    _lastBattleId = arbViewSt.battleId;
  }
  _syncToLegacy();
}

// Wire the callback at module load. The viewer's _fireUpdated() invokes
// this after each handler. Idempotent set — re-importing is safe.
setArbViewUpdated(_syncIfEnabled);

// ── Test exports (wire-sim only) ──────────────────────────────────────
// Lets wire-sim drive the sync without going through the WS dispatch.
// Production code never calls these.
export { _syncToLegacy as _testSyncToLegacy, _toLegacyShape as _testToLegacyShape };
