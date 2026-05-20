// Random encounter spawning — extracted from game.js

import { battleSt } from './battle-state.js';
import { forceCloseMsgBox } from './message-box.js';
import { MONSTERS } from './data/monsters.js';
import { ENCOUNTERS } from './data/encounters.js';
import { GOBLIN_HIT_RATE } from './battle-math.js';
import { SFX, playSFX } from './music.js';
import { TRACKS } from './music.js';
import { createStatusState } from './status-effects.js';
import { mapSt } from './map-state.js';
import { inputSt } from './input-handler.js';
import { getMonsterCanvas } from './monster-sprites.js';
import { sendNetPVPEncounter, setNetPVPEncounterNoneHandler } from './net.js';

const TILE_SIZE = 16;

// Injected at boot
let _resetBattleVars = () => {};
export function initBattleEncounter({ resetBattleVars }) { _resetBattleVars = resetBattleVars; }

// ── Random encounter step counter ──────────────────────────────────────────
export function tickRandomEncounter() {
  if (battleSt.battleState !== 'none') return false;
  const tileX = Math.floor(mapSt.worldX / TILE_SIZE);
  const tileY = Math.floor(mapSt.worldY / TILE_SIZE);
  const inDungeon = mapSt.dungeonFloor >= 0 && mapSt.dungeonFloor < 4;
  const onGrass = mapSt.onWorldMap && mapSt.worldMapRenderer && !mapSt.worldMapRenderer.getTriggerAt(tileX, tileY);
  const inPatch = mapSt.encounterPatch && mapSt.encounterPatch.has(tileY * 32 + tileX);
  if (!inDungeon && !onGrass && !inPatch) return false;
  mapSt.encounterSteps++;
  const threshold = (onGrass || inPatch)
    ? 20 + Math.floor(Math.random() * 20)
    : 15 + Math.floor(Math.random() * 15);
  if (mapSt.encounterSteps >= threshold) {
    mapSt.encounterSteps = 0;
    _triggerEncounterWithPVPCheck();
    return true;
  }
  return false;
}

// MP Step 3 — when an encounter would normally start, first ask the server
// if anyone is searching for us. The server rolls hook chance against each
// pending challenger; on a hit it broadcasts `pvp-match` (handled in
// `pvp-search.js`) which routes the player into PvP via `_startPVPBattle`.
// On miss / no challengers, the server replies `pvp-encounter-none` and we
// proceed with the regular monster encounter. The fallback below only covers
// a server reply that's fully DROPPED — both hit (`pvp-match`) and miss
// (`pvp-encounter-none`) resolve via explicit messages well before it.
//
// It must be longer than the PvP match's "Connecting..." hold
// (`CONNECTING_HOLD_MS`, 1000 ms in pvp-search.js): when a hook HITS, the
// target's match handler shows "Connecting..." for that hold while
// `battleState` is still 'none'. A short fallback would fire
// `startRandomEncounter()` mid-hold and drop the target into a monster fight
// while the challenger sits in a PvP battle alone (the v1.7.501 desync). The
// match handler also calls `cancelPendingPVPCheck()` to neutralise the
// fallback immediately on resolve; the long timeout is just dropped-packet
// insurance on top of that.
let _pendingPVPCheck = false;
export function isEncounterCheckPending() { return _pendingPVPCheck; }
// Called by pvp-search.js the instant a `pvp-match` resolves on this client,
// so the optimistic monster-encounter fallback can't pre-empt the PvP battle.
export function cancelPendingPVPCheck() { _pendingPVPCheck = false; }
function _triggerEncounterWithPVPCheck() {
  if (!sendNetPVPEncounter()) {
    startRandomEncounter();
    return;
  }
  _pendingPVPCheck = true;
  setTimeout(() => {
    if (!_pendingPVPCheck) return;
    _pendingPVPCheck = false;
    if (battleSt.battleState === 'none') startRandomEncounter();
  }, 2500);
}

setNetPVPEncounterNoneHandler(() => {
  if (!_pendingPVPCheck) return;
  _pendingPVPCheck = false;
  if (battleSt.battleState === 'none') startRandomEncounter();
});

// ── Spawn encounter monsters ───────────────────────────────────────────────
export function startRandomEncounter() {
  battleSt.isRandomEncounter = true;
  inputSt.battleActionCount = 0;
  // v1.7.446 — drop any in-flight overworld msg box ("Found Potion!" from a
  // chest, NPC dialogue, etc.) so it doesn't bleed through the battle wipe.
  forceCloseMsgBox();

  // World-map encounter zone is split by region:
  //   - Ur valley (x=93..96, y=34..44, ~31 walkable tiles between Altar Cave
  //     and the temporary choke at 95,45) → 'grasslands_valley' (Goblins only)
  //   - Anywhere else on the world map → 'grasslands_wild' (Werewolves + Bees)
  // When the choke is removed the wild zone becomes reachable; until then only
  // the valley sees encounters because that's the only place the player can walk.
  let zoneKey;
  if (mapSt.onWorldMap) {
    const tileX = Math.floor(mapSt.worldX / TILE_SIZE);
    const tileY = Math.floor(mapSt.worldY / TILE_SIZE);
    const inValley = tileX >= 93 && tileX <= 96 && tileY >= 34 && tileY <= 44;
    zoneKey = inValley ? 'grasslands_valley' : 'grasslands_wild';
  } else if (mapSt.encounterPatch && mapSt.encounterPatchZone) {
    // Indoor map flood-filled encounter patch (e.g. Ur dark-tile patch).
    zoneKey = mapSt.encounterPatchZone;
  } else {
    zoneKey = ['altar_cave_f1','altar_cave_f2','altar_cave_f3','altar_cave_f4'][mapSt.dungeonFloor] || 'altar_cave_f1';
  }
  const zone = ENCOUNTERS.get(zoneKey);
  const formations = zone ? zone.formations : [[{ id: 0x00, min: 1, max: 3 }]];
  const formation = formations[Math.floor(Math.random() * formations.length)];

  // INVARIANT: this array is built once per battle and NEVER shrinks — dead
  // monsters keep their slot with hp=0; it's only reset to `null` at battle
  // end (battle-update.js). Every combat index (targetIndex, allyTargetIndex,
  // currentAttacker, confused pick.index) is derived from a hp>0 filter on
  // this array within the same synchronous turn, so `encounterMonsters[idx]`
  // is always a defined object for the life of the battle. If you ever splice
  // or remove dead monsters here, re-audit every `encounterMonsters[idx]`
  // dereference — they assume stable indices and would then need bounds guards.
  battleSt.encounterMonsters = [];
  for (const group of formation) {
    const count = group.min + Math.floor(Math.random() * (group.max - group.min + 1));
    for (let i = 0; i < count; i++) {
      if (battleSt.encounterMonsters.length >= 4) break;
      const mData = MONSTERS.get(group.id) || MONSTERS.get(0x00);
      battleSt.encounterMonsters.push({
        monsterId: group.id,
        hp: mData.hp, maxHP: mData.hp,
        atk: mData.atk, attackRoll: mData.attackRoll || 1,
        def: mData.def, evade: mData.evade || 0,
        mdef: mData.mdef || 0,
        exp: mData.exp, gil: mData.gil || 0,
        hitRate: mData.hitRate || GOBLIN_HIT_RATE,
        spAtkRate: mData.spAtkRate || 0,
        attacks: mData.attacks || null,
        level: mData.level || 1,
        agi: mData.level || 1,
        statusAtk: mData.statusAtk || null,
        atkElem: mData.atkElem || null,
        weakness: mData.weakness || null,
        resist: mData.resist || null,
        statusResist: mData.statusResist || null,
        spiritInt: mData.spiritInt || 0,
        status: createStatusState(),
      });
    }
    if (battleSt.encounterMonsters.length >= 4) break;
  }
  // Sort tallest first for top-row grid placement
  battleSt.encounterMonsters.sort((a, b) => {
    const ha = getMonsterCanvas(a.monsterId, battleSt.goblinBattleCanvas)?.height || 32;
    const hb = getMonsterCanvas(b.monsterId, battleSt.goblinBattleCanvas)?.height || 32;
    return hb - ha;
  });
  battleSt.preBattleTrack = TRACKS.CRYSTAL_CAVE;
  _resetBattleVars();
  battleSt.battleState = 'flash-strobe';
  battleSt.battleTimer = 0;
  playSFX(SFX.BATTLE_SWIPE);
}

