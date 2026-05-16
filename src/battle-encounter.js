// Random encounter spawning — extracted from game.js

import { battleSt } from './battle-state.js';
import { MONSTERS } from './data/monsters.js';
import { ENCOUNTERS } from './data/encounters.js';
import { GOBLIN_HIT_RATE } from './battle-math.js';
import { SFX, playSFX } from './music.js';
import { TRACKS } from './music.js';
import { createStatusState } from './status-effects.js';
import { mapSt } from './map-state.js';
import { inputSt } from './input-handler.js';
import { getMonsterCanvas } from './monster-sprites.js';
import { sendNetPVPEncounter, setNetPVPEncounterNoneHandler,
         sendNetEncounterStart, setNetEncounterInviteHandler,
         getMyUserId, getOnlinePlayerByName } from './net.js';
import { partyInviteSt } from './party-invite.js';
import { pvpSt } from './pvp.js';
import { generateAllyStats } from './data/players.js';
import { seed as seedRng } from './rng.js';
import { addChatMessage } from './chat.js';

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
// proceed with the regular monster encounter. A 500 ms fallback covers a
// dropped or slow server reply.
let _pendingPVPCheck = false;
export function isEncounterCheckPending() { return _pendingPVPCheck; }
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
  }, 500);
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
  // Co-op random encounter (v1.7.418+) — if we're in a party AND any
  // members are online, host a wire-driven battle. Server validates each
  // candidate; rejected peers fall through to local AI ally fallback.
  // Runs AFTER `_resetBattleVars` so the reset doesn't clear our wire
  // flags. Skipped during PvP (PvP has its own ally-join flow).
  _maybeHostCoopEncounter();
  battleSt.battleState = 'flash-strobe';
  battleSt.battleTimer = 0;
  playSFX(SFX.BATTLE_SWIPE);
}

function _maybeHostCoopEncounter() {
  if (pvpSt.isPVPBattle) return;
  if (!partyInviteSt.partyMembers || partyInviteSt.partyMembers.length === 0) return;
  const myUid = getMyUserId();
  if (!myUid) return;
  const partyPeers = [];
  const partyPeerNames = [];
  for (const name of partyInviteSt.partyMembers) {
    const online = getOnlinePlayerByName(name);
    if (online && online.userId) {
      partyPeers.push(online.userId);
      partyPeerNames.push(online.name || name);
    }
  }
  if (partyPeers.length === 0) return;
  const seed32 = (Math.random() * 0xffffffff) >>> 0;
  const monsterPayload = battleSt.encounterMonsters.map(m => ({ monsterId: m.monsterId }));
  if (!sendNetEncounterStart(seed32, monsterPayload, partyPeers)) return;
  battleSt.isWireEncounter = true;
  battleSt.encounterIsHost = true;
  battleSt.encounterHostUserId = myUid;
  battleSt.encounterSeed = seed32;
  battleSt.encounterTurnIndex = 0;
  seedRng(seed32);
  // UX — chat line so the host sees who joined their fight. Mirror message
  // on guest side fires from the invite handler. v1.7.420.
  const label = partyPeerNames.length === 1
    ? partyPeerNames[0] + ' joined the battle!'
    : partyPeerNames.join(' + ') + ' joined the battle!';
  try { addChatMessage('* ' + label, 'system'); } catch { /* chat optional */ }
}

// Guest side — host's `encounter-start` was forwarded to us. Spawn the
// same battle locally with their seed + monster list so both clients
// drive identical state. The host (and any other peers) get pushed into
// `battleAllies` as wire-driven entries; their turns wait for
// `encounter-action` from the wire instead of running AI. Order: host
// first, then by ascending userId — gives all clients the same
// initiative-roll ordering against the shared rand cursor.
setNetEncounterInviteHandler((msg) => {
  if (!msg || !msg.seed || !Array.isArray(msg.monsters) || msg.monsters.length === 0) return;
  if (battleSt.battleState !== 'none' || pvpSt.isPVPBattle) return;
  const monsters = [];
  for (const m of msg.monsters) {
    const id = m && (m.monsterId | 0);
    if (id == null) continue;
    const mData = MONSTERS.get(id) || MONSTERS.get(0x00);
    if (!mData) continue;
    monsters.push({
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
    });
  }
  if (monsters.length === 0) return;
  monsters.sort((a, b) => {
    const ha = getMonsterCanvas(a.monsterId, battleSt.goblinBattleCanvas)?.height || 32;
    const hb = getMonsterCanvas(b.monsterId, battleSt.goblinBattleCanvas)?.height || 32;
    return hb - ha;
  });
  battleSt.encounterMonsters = monsters;
  battleSt.isRandomEncounter = true;
  inputSt.battleActionCount = 0;
  const seed32 = msg.seed >>> 0;
  battleSt.isWireEncounter = true;
  battleSt.encounterIsHost = false;
  battleSt.encounterHostUserId = msg.hostUserId | 0;
  battleSt.encounterSeed = seed32;
  battleSt.encounterTurnIndex = 0;
  seedRng(seed32);
  battleSt.preBattleTrack = TRACKS.CRYSTAL_CAVE;
  // _resetBattleVars wipes battleAllies; populate AFTER it runs.
  _resetBattleVars();
  const peerList = Array.isArray(msg.peers) ? msg.peers.slice() : [];
  peerList.sort((a, b) => {
    const aHost = a.userId === msg.hostUserId ? 0 : 1;
    const bHost = b.userId === msg.hostUserId ? 0 : 1;
    if (aHost !== bHost) return aHost - bHost;
    return (a.userId | 0) - (b.userId | 0);
  });
  for (const peer of peerList) {
    if (battleSt.battleAllies.length >= 3) break;
    const stats = generateAllyStats(peer);
    stats.userId = peer.userId | 0;
    stats.isWireDriven = true;
    battleSt.battleAllies.push(stats);
  }
  // UX — chat line so the guest sees whose battle they joined. Host name
  // = peers[0] (canonical sort puts host first). v1.7.420.
  const hostName = (peerList[0] && peerList[0].name) || 'Party';
  try { addChatMessage('* Joined ' + hostName + "'s battle!", 'system'); } catch { /* chat optional */ }
  battleSt.battleState = 'flash-strobe';
  battleSt.battleTimer = 0;
  playSFX(SFX.BATTLE_SWIPE);
});
