// Random encounter spawning — extracted from game.js

import { battleSt } from './battle-state.js';
import { forceCloseMsgBox } from './message-box.js';
import { MONSTERS } from './data/monsters.js';
import { ENCOUNTERS, RATE_STEPS } from './data/encounters.js';
import { GOBLIN_HIT_RATE } from './battle-math.js';
import { SFX, playSFX } from './music.js';
import { TRACKS } from './music.js';
import { createStatusState } from './status-effects.js';
import { mapSt } from './map-state.js';
import { inputSt } from './input-handler.js';
import { getMonsterCanvas } from './monster-sprites.js';
import { sendNetPVPEncounter, setNetPVPEncounterNoneHandler } from './net.js';
import { reseedFromEntropy } from './rng.js';

const TILE_SIZE = 16;

// Injected at boot
let _resetBattleVars = () => {};
let _tryJoinPlayerAlly = () => false;
export function initBattleEncounter({ resetBattleVars, tryJoinPlayerAlly }) {
  _resetBattleVars = resetBattleVars;
  _tryJoinPlayerAlly = tryJoinPlayerAlly;
}

// Resolve the encounter zone for the player's current position. Single source
// for both the step-threshold (zone.rate) in tickRandomEncounter and the
// formation pick when an encounter fires. Matches the gate in
// tickRandomEncounter: world-map grass splits into valley/wild by bounding
// box; an indoor flood-fill patch uses its own zone (e.g. the Ur dark-tile
// patch); otherwise the current Altar Cave floor.
function currentEncounterZoneKey() {
  if (mapSt.onWorldMap) {
    const tileX = Math.floor(mapSt.worldX / TILE_SIZE);
    const tileY = Math.floor(mapSt.worldY / TILE_SIZE);
    const inValley = tileX >= 93 && tileX <= 96 && tileY >= 34 && tileY <= 44;
    return inValley ? 'grasslands_valley' : 'grasslands_wild';
  }
  if (mapSt.encounterPatch && mapSt.encounterPatchZone) return mapSt.encounterPatchZone;
  return ['altar_cave_f1', 'altar_cave_f2', 'altar_cave_f3', 'altar_cave_f4'][mapSt.dungeonFloor] || 'altar_cave_f1';
}

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
  // Cadence is data-driven: each zone's `rate` maps to a step range via
  // RATE_STEPS. Lower threshold = more frequent (e.g. the Ur patch's
  // grasslands_wild is rate 'high' = 2x the open-grass rate).
  const zone = ENCOUNTERS.get(currentEncounterZoneKey());
  const r = (zone && RATE_STEPS[zone.rate]) || RATE_STEPS.normal;
  const threshold = r.base + Math.floor(Math.random() * r.spread);
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
// Build one encounter-monster object from a monster id. Shared by random
// encounters and the chest mimic so the combat-stat shape stays in one place.
function _makeEncounterMonster(id) {
  const mData = MONSTERS.get(id) || MONSTERS.get(0x00);
  return {
    monsterId: id,
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
  };
}

// Chest mimic — one random monster from the current floor's encounter pool,
// using the normal battle flash. Called by map-triggers when a chest rolls the
// `monster` loot tier.
export function startChestMimic() {
  battleSt.isRandomEncounter = true;
  inputSt.battleActionCount = 0;
  forceCloseMsgBox();
  // v1.7.771 P-1 — every battle reseeds so the seeded RNG sequence is
  // bounded by the battle (boss path already did this; mimics/encounters
  // didn't). Required for the PvE arbiter's replay-validate to converge.
  reseedFromEntropy();
  const zone = ENCOUNTERS.get(currentEncounterZoneKey());
  const formations = zone ? zone.formations : [[{ id: 0x00, min: 1, max: 1 }]];
  const ids = [];
  for (const f of formations) for (const g of f) if (!ids.includes(g.id)) ids.push(g.id);
  const id = ids.length ? ids[Math.floor(Math.random() * ids.length)] : 0x00;
  battleSt.encounterMonsters = [_makeEncounterMonster(id)];
  battleSt.preBattleTrack = TRACKS.CRYSTAL_CAVE;
  _resetBattleVars();
  battleSt.battleState = 'flash-strobe';
  battleSt.battleTimer = 0;
  playSFX(SFX.BATTLE_SWIPE);
  // Seed party + room allies AT battle inception — see startBattle()
  // in battle-update.js for the rationale. v1.7.686.
  _tryJoinPlayerAlly({ initial: true });
}

export function startRandomEncounter() {
  battleSt.isRandomEncounter = true;
  inputSt.battleActionCount = 0;
  // v1.7.446 — drop any in-flight overworld msg box ("Found Potion!" from a
  // chest, NPC dialogue, etc.) so it doesn't bleed through the battle wipe.
  forceCloseMsgBox();
  // v1.7.771 P-1 — see startChestMimic note. Reseed at battle inception.
  reseedFromEntropy();

  // Zone selection (valley vs wild by bounding box, indoor patch, or cave
  // floor) is shared with the rate lookup — see currentEncounterZoneKey.
  const zoneKey = currentEncounterZoneKey();
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
      battleSt.encounterMonsters.push(_makeEncounterMonster(group.id));
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
  // Same as startChestMimic — seed party + room allies at inception so they
  // appear on-field during the intro instead of fading in after the first
  // action. v1.7.686 (party-system audit).
  _tryJoinPlayerAlly({ initial: true });
}

