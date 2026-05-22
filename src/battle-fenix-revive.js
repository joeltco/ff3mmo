// Phoenix Down auto-revive.
//
// When the player would die in battle AND holds a FenixDown (item 0xA9), the
// item is consumed automatically instead of routing to game-over: the full
// death animation plays, then a "FenixDown!" message + revive sparkle, the
// death pose fades, and the player portrait rises from the bottom as the player
// returns at ~1/3 max HP.
//
// This owns a self-contained sub-FSM driven through `battleState ===
// 'fenix-revive'`. Because `updateBattleTimers` (which detects death) runs
// before every state handler in `updateBattle`, seizing `battleState` here the
// frame death is detected means the normal turn/box-close handlers — which key
// off their own specific states — all no-op for the duration. The death visuals
// render off `hudSt.playerDeathTimer` (independent of battleState), so they keep
// playing while we own the FSM.
//
// The revive sparkle reuses the legacy Cure sparkle (the same fallback every
// un-captured item animation uses) until the dedicated revive OAM capture
// lands — see `_itemSparkleFrames` in battle-drawing.js.

import { battleSt, DEATH_TOTAL_MS } from './battle-state.js';
import { ps } from './player-stats.js';
import { hudSt } from './hud-state.js';
import { hasItem, removeItem } from './inventory.js';
import { queueBattleMsg } from './battle-msg.js';
import { _nameToBytes } from './text-utils.js';
import { playSFX, SFX } from './music.js';
import { clearAll as clearAllStatus } from './status-effects.js';
import { processNextTurn } from './battle-turn.js';

export const FENIX_ITEM_ID = 0xA9;

// Phase durations (ms), each measured from the start of its own phase.
export const FENIX_ANGEL_MS = 1400;  // the revive angel flaps beside the body
export const FENIX_RISE_MS  = 450;   // death pose fades + live portrait rises
const ANGEL_FLAP_MS         = 133;   // per-flap-frame cadence (8 NES frames)

// null = not reviving. Otherwise one of: 'death-anim' | 'angel' | 'rise'.
let _phase = null;
let _t = 0;

export function isFenixReviving()  { return _phase != null; }
export function fenixRevivePhase() { return _phase; }
// 0→1 progress through the portrait-rise phase (0 outside it).
export function fenixRiseProgress() { return _phase === 'rise' ? Math.min(_t / FENIX_RISE_MS, 1) : 0; }
// 0→1 progress through the angel phase (drives the angel's upward drift).
export function fenixAngelProgress() { return _phase === 'angel' ? Math.min(_t / FENIX_ANGEL_MS, 1) : 0; }
// Angel flap frame index (0/1/2) — cycles through the 3 captured frames.
export function fenixAngelFrame() { return Math.floor(_t / ANGEL_FLAP_MS) % 3; }

// Called the frame the player's HP first hits 0 in battle. If a FenixDown is
// held, consume one and seize the battle into the revive sub-FSM. Returns true
// when a revive has started (the death is intercepted), false to let the normal
// death/respawn flow proceed.
export function tryStartFenixRevive() {
  if (_phase != null) return true;            // already reviving
  if (!hasItem(FENIX_ITEM_ID)) return false;
  removeItem(FENIX_ITEM_ID, 1);
  _phase = 'death-anim';
  _t = 0;
  // Round ends here; a fresh round opens on the player's turn after the revive.
  battleSt.turnQueue = [];
  battleSt.isDefending = false;
  battleSt.battleState = 'fenix-revive';
  battleSt.battleTimer = 0;
  return true;
}

// Sub-FSM tick. Returns true while a revive is active so `updateBattle` stops
// dispatching the normal handlers this frame.
export function updateFenixRevive(dt) {
  if (_phase == null) return false;
  _t += dt;
  if (_phase === 'death-anim') {
    // Let the existing death animation (kneel slide → text fade → pose fade-in)
    // finish — that's the "death pose held for ~1s" before the angel appears.
    if (hudSt.playerDeathTimer != null && hudSt.playerDeathTimer >= DEATH_TOTAL_MS) {
      _phase = 'angel';
      _t = 0;
      // Revive jingle — fires as the angel appears, matching the FF3 capture
      // (REC OAM @ f311: `$7F49=$D1` → NSF track $92). See SFX.REVIVE.
      playSFX(SFX.REVIVE);
    }
  } else if (_phase === 'angel') {
    // Angel flaps beside the body, then the character is brought back.
    if (_t >= FENIX_ANGEL_MS) {
      _phase = 'rise';
      _t = 0;
      // Restore at the start of the rise so the HP bar + portrait read alive.
      const maxHP = ps.stats ? ps.stats.maxHP : 28;
      ps.hp = Math.max(1, Math.floor(maxHP / 3));
      // Revive = clean state (NES canon; mirrors _respawnAtLastTown).
      if (ps.status) clearAllStatus(ps.status);
      // "Revived" message shows as the portrait slides up into the HUD.
      queueBattleMsg(_nameToBytes('Revived'));
    }
  } else if (_phase === 'rise') {
    if (_t >= FENIX_RISE_MS) {
      hudSt.playerDeathTimer = null;
      _phase = null;
      _t = 0;
      battleSt.turnTimer = 0;
      // Simultaneous-death edge: if the player died the same beat the last enemy
      // did (e.g. shared end-of-round poison), revive into the won-fight path
      // rather than an empty menu. battleTimer past the threshold makes
      // _updateMonsterDeath process the victory immediately.
      const enemiesLeft = Array.isArray(battleSt.encounterMonsters) &&
        battleSt.encounterMonsters.some(m => m.hp > 0);
      if (Array.isArray(battleSt.encounterMonsters) && !enemiesLeft) {
        battleSt.dyingMonsterIndices = new Map();
        battleSt.battleState = 'monster-death';
        battleSt.battleTimer = 1e9;
      } else {
        // Empty queue + alive player → processNextTurn falls through to menu-open
        // (a fresh round). Mirrors the normal end-of-round entry.
        processNextTurn();
      }
    }
  }
  return true;
}

// Hard reset — called when a battle tears down so a revive can't leak across
// encounters.
export function resetFenixRevive() {
  _phase = null;
  _t = 0;
}
