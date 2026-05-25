// Phoenix Down revive.
//
// When the player would die in battle AND holds a FenixDown (item 0xA9), the
// death pose plays, then a "Use FenixDown? A:Yes B:No" box. On YES the item is
// consumed and the revive runs; on NO it's game-over as normal.
//
// Phases (battleState === 'fenix-revive'):
//   death-anim → confirm → angel → rise → healnum
//   death-anim: existing death animation plays out (~1s).
//   confirm:    Yes/No box (input handled in input-handler _battleInputHoldStates).
//   angel:      revive jingle + the FF3 spirit flaps beside the body (rises).
//   rise:       HP restored to ~1/3 max, body fades, portrait slides up, "Revived".
//   healnum:    heal number pops on the returned portrait, then resume battle.
//
// This owns a self-contained sub-FSM. Because `updateBattleTimers` (which detects
// death) runs before every state handler in `updateBattle`, seizing `battleState`
// the frame death is detected means the normal turn/box-close handlers — which key
// off their own specific states — all no-op for the duration. Death visuals render
// off `hudSt.playerDeathTimer` (independent of battleState). The item is NOT
// consumed until YES.

import { battleSt, DEATH_TOTAL_MS } from './battle-state.js';
import { ps } from './player-stats.js';
import { hudSt } from './hud-state.js';
import { hasItem, removeItem } from './inventory.js';
import { queueBattleMsg } from './battle-msg.js';
import { showMsgBoxPrompt, forceCloseMsgBox } from './message-box.js';
import { _nameToBytes } from './text-utils.js';
import { playSFX, SFX } from './music.js';
import { clearAll as clearAllStatus } from './status-effects.js';
import { setPlayerHealNum, getAllyDamageNums, getPlayerDamageNum, tickHealNums, clearHealNums, DMG_SHOW_MS } from './damage-numbers.js';
import { processNextTurn } from './battle-turn.js';

export const FENIX_ITEM_ID = 0xA9;

// Phase durations (ms), each measured from the start of its own phase.
export const FENIX_ANGEL_MS = 1400;  // the revive angel flaps beside the body
export const FENIX_RISE_MS  = 450;   // death pose fades + live portrait rises
const ANGEL_FLAP_MS         = 133;   // per-flap-frame cadence (8 NES frames)

// "Use FenixDown? A:Yes B:No" — wraps to 2 lines at 16 chars (drawMsgBox). A/B
// match the mobile deck (A→z, B→x; index.html) and keyboard (Z/X). Routed via
// `showMsgBoxPrompt` (v1.7.687) so the universal modal msgbox handler in
// movement.js#handleInput drives Yes/No → fenixConfirmYes/No directly — the
// older path through `_battleInputHoldStates` stopped reaching us in v1.7.643
// when the msgbox handler was promoted above handleBattleInput.
const CONFIRM_TEXT = _nameToBytes('Use FenixDown? A:Yes B:No');

// null = not reviving. Phases: 'dmg-hold' | 'death-anim' | 'confirm' | 'angel' | 'rise' | 'healnum'.
//   dmg-hold: wait for the hit's damage number to finish BEFORE the portrait falls.
let _phase = null;
let _t = 0;
let _reviveHeal = 0;   // HP restored — shown as a heal number after the portrait returns
let _allyIndex = null; // null = player's own on-death revive; number = ally being revived (manual item)

export function isFenixReviving()  { return _phase != null; }
export function fenixRevivePhase() { return _phase; }
// null when reviving the player (renders in battle-draw-player); else the ally
// row index (renders in battle-draw-allies).
export function fenixReviveAllyIndex() { return _allyIndex; }
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
  if (!hasItem(FENIX_ITEM_ID)) return false;  // no item → normal death/respawn
  // NOTE: the item is NOT consumed here — only on a "Yes" at the confirm box.
  // Seize NOW (blocks game-over routing) but hold the portrait fall until the
  // hit's damage number finishes — start in 'dmg-hold', not 'death-anim'.
  _allyIndex = null;   // player's own revive
  _phase = 'dmg-hold';
  _t = 0;
  // Round ends here; a fresh round opens on the player's turn after the revive.
  battleSt.turnQueue = [];
  battleSt.isDefending = false;
  battleSt.battleState = 'fenix-revive';
  battleSt.battleTimer = 0;
  return true;
}

// Player chose YES at the confirm box: consume the item and run the revive.
export function fenixConfirmYes() {
  if (_phase !== 'confirm') return;
  if (!hasItem(FENIX_ITEM_ID)) { fenixConfirmNo(); return; }  // safety
  removeItem(FENIX_ITEM_ID, 1);
  forceCloseMsgBox();
  _phase = 'angel';
  _t = 0;
  playSFX(SFX.REVIVE);
}

// Player chose NO (or has no item): decline the revive → normal game-over.
export function fenixConfirmNo() {
  forceCloseMsgBox();
  _phase = null;
  _t = 0;
  // ps.hp is still 0 + playerDeathTimer set → box-close routes to respawn.
  battleSt.battleState = battleSt.isRandomEncounter ? 'encounter-box-close' : 'enemy-box-close';
  battleSt.battleTimer = 0;
}

// Manual FenixDown used on a DOWNED ally (from the battle Item menu). The item
// is already consumed by _playerTurnItem and the revive SFX played by
// _playerTurnConsumable; this just runs the angel → rise → healnum sequence on
// that ally (no confirm — selecting the item IS the confirm), then advances the
// turn. The ally's death pose is already showing (ally.deathTimer set).
export function startAllyRevive(allyIndex) {
  if (_phase != null) return;
  _allyIndex = allyIndex;
  _phase = 'angel';
  _t = 0;
  battleSt.isDefending = false;
  battleSt.battleState = 'fenix-revive';
  battleSt.battleTimer = 0;
}

// Sub-FSM tick. Returns true while a revive is active so `updateBattle` stops
// dispatching the normal handlers this frame.
export function updateFenixRevive(dt) {
  if (_phase == null) return false;
  _t += dt;
  if (_phase === 'dmg-hold') {
    // Hold on the hit (shake + damage number still showing) — the portrait does
    // NOT fall yet. Once the damage number finishes, start the death animation.
    if (getPlayerDamageNum() == null) {
      _phase = 'death-anim';
      _t = 0;
      hudSt.playerDeathTimer = 0;   // now the kneel-slide / death pose plays
    }
  } else if (_phase === 'death-anim') {
    // Let the existing death animation (kneel slide → text fade → pose fade-in)
    // finish — the death pose holds ~1s — then ask before reviving.
    if (hudSt.playerDeathTimer != null && hudSt.playerDeathTimer >= DEATH_TOTAL_MS) {
      _phase = 'confirm';
      _t = 0;
      // Modal msgbox handler (movement.js#handleInput) routes Z → fenixConfirmYes
      // and X → fenixConfirmNo once the prompt is in 'hold'. Single source for
      // every yes/no prompt in the game — matches party-invite / trade /
      // inventory-delete / locked-door.
      showMsgBoxPrompt(CONFIRM_TEXT, fenixConfirmYes, fenixConfirmNo);
    }
  } else if (_phase === 'confirm') {
    // Idle — waits for fenixConfirmYes() / fenixConfirmNo() from input.
  } else if (_phase === 'angel') {
    // Angel flaps beside the body, then the character is brought back.
    if (_t >= FENIX_ANGEL_MS) {
      _phase = 'rise';
      _t = 0;
      // Restore at the start of the rise so the HP bar + portrait read alive.
      // (revived from 0, so HP received == _reviveHeal). The death pose keeps
      // rendering during the rise via the death timer, which clears at rise end.
      if (_allyIndex == null) {
        const maxHP = ps.stats ? ps.stats.maxHP : 28;
        _reviveHeal = Math.max(1, Math.floor(maxHP / 3));
        ps.hp = _reviveHeal;
        // Revive = clean state (NES canon; mirrors _respawnAtLastTown).
        if (ps.status) clearAllStatus(ps.status);
      } else {
        const a = (battleSt.battleAllies || [])[_allyIndex];
        const maxHP = a ? a.maxHP : 28;
        _reviveHeal = Math.max(1, Math.floor(maxHP / 3));
        if (a) a.hp = _reviveHeal;
      }
      // "Revived" message shows as the portrait slides up into the HUD.
      queueBattleMsg(_nameToBytes('Revived'));
    }
  } else if (_phase === 'rise') {
    if (_t >= FENIX_RISE_MS) {
      _phase = 'healnum';
      _t = 0;
      // Death pose has fully faded / portrait returned → pop the heal number.
      if (_allyIndex == null) {
        hudSt.playerDeathTimer = null;
        setPlayerHealNum({ value: _reviveHeal, timer: 0 });
      } else {
        const a = (battleSt.battleAllies || [])[_allyIndex];
        if (a) a.deathTimer = null;
        // Ally heal numbers ride allyDamageNums (ticked by tickDmgNums each frame).
        getAllyDamageNums()[_allyIndex] = { value: _reviveHeal, timer: 0, heal: true };
      }
    }
  } else if (_phase === 'healnum') {
    tickHealNums(dt);   // bounce + age the number (not ticked elsewhere this state)
    if (_t >= DMG_SHOW_MS) {
      clearHealNums();
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
  _reviveHeal = 0;
  _allyIndex = null;
}
