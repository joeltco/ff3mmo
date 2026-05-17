// Random encounter spawning — extracted from game.js

import { battleSt } from './battle-state.js';
import { addBattleATBAlly } from './battle-update.js';
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
         sendNetEncounterAssistSnapshot,
         setNetEncounterAssistIncomingHandler,
         setNetEncounterAssistSnapshotHandler,
         setNetEncounterAllyJoinHandler,
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
    // Side-channel fade-in (v1.7.423+) — fade from `ROSTER_FADE_STEPS`
    // down to 0 over `ROSTER_FADE_STEPS * FADE_IN_PER_STEP_MS` ms.
    // Independent of battleState; drives via the tick in battle-ally.js.
    stats.fadeInStartMs = Date.now();
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

// ── Battle Assist (v1.7.422+) ──────────────────────────────────────────────
//
// Target side — an overworld player picked Assist on us. Auto-accept: build
// the current battle snapshot (monsters with live HP, peers, seed,
// turnIndex) and emit it for the server to forward to the joiner. If we're
// in a solo battle, convert to host-of-co-op on the fly: pick a fresh
// seed, set wire flags, start emitting actions from this point. Then
// instant-add the joiner to our local battleAllies as a wire-driven entry
// (no fade animation — assist is mid-battle and the FSM has no safe
// fade-in window).
setNetEncounterAssistIncomingHandler((msg) => {
  if (!msg || !msg.fromUserId || !msg.fromProfile) return;
  if (battleSt.battleState === 'none' || pvpSt.isPVPBattle) return;
  if (battleSt.battleAllies.length >= 3) return;  // no slot
  const myUid = getMyUserId();
  if (!myUid) return;
  // Target-side dedup (v1.7.424) — joiner double-tapped Assist → server
  // relayed both incomings → we'd push two identical ally entries +
  // emit two snapshots, breaking canonical turn-order. Drop the second.
  const joinerUid = msg.fromUserId | 0;
  if (battleSt.battleAllies.some(a => a && a.userId === joinerUid)) return;
  // Convert solo → host-of-coop if not already a wire encounter.
  if (!battleSt.isWireEncounter) {
    const seed32 = (Math.random() * 0xffffffff) >>> 0;
    battleSt.isWireEncounter = true;
    battleSt.encounterIsHost = true;
    battleSt.encounterHostUserId = myUid;
    battleSt.encounterSeed = seed32;
    battleSt.encounterTurnIndex = 0;
    seedRng(seed32);
  }
  // Add joiner to local battleAllies. Side-channel fade-in (v1.7.423+)
  // animates the portrait from invisible → visible over ~400 ms without
  // interrupting whatever battleState we're in.
  const joinerStats = generateAllyStats(msg.fromProfile);
  joinerStats.userId = msg.fromUserId | 0;
  joinerStats.isWireDriven = true;
  joinerStats.fadeInStartMs = Date.now();
  battleSt.battleAllies.push(joinerStats);
  // Build the snapshot. Peers = self + existing battleAllies that have
  // a userId (skip any AI-driven fakes). Monsters carry live HP.
  const peers = [{
    userId: myUid,
    name:   msg.fromProfile.targetName || '',
    // Server doesn't ship our profile back to us; use the snapshot ally
    // shape — joiner runs generateAllyStats again receiver-side via the
    // identical static data path. Include the same fields generateAllyStats
    // reads: name + jobIdx + level + palIdx + loc + weapon/armor + knownSpells.
  }];
  // Re-fetch host's own profile fields from battleSt + ps if we can. To
  // keep this MVP simple, we ship a minimal entry; receiver mostly cares
  // about userId + display fields. battleAllies entries already carry
  // generateAllyStats output so we can ship those directly.
  for (const a of battleSt.battleAllies) {
    if (!a || !a.userId) continue;
    if (a.userId === (msg.fromUserId | 0)) continue;  // joiner gets snapshot themselves
    peers.push({
      userId: a.userId | 0,
      name:   a.name,
      jobIdx: a.jobIdx | 0,
      level:  a.level | 0,
      palIdx: a.palIdx | 0,
      hp:     a.hp | 0,
      maxHP:  a.maxHP | 0,
      atk:    a.atk | 0,
      def:    a.def | 0,
      agi:    a.agi | 0,
      weaponR:a.weaponId,
      weaponL:a.weaponL,
      knownSpells: Array.isArray(a.knownSpells) ? a.knownSpells.slice() : [],
      jobLevel: a.jobLevel | 0,
    });
  }
  const monsters = (battleSt.encounterMonsters || []).map(m => ({
    monsterId: m.monsterId | 0,
    hp:        m.hp | 0,
    // Status state — wire-ship the mask + poison tick so the joiner's
    // monster has the same affliction. Without this, a poisoned monster
    // on host's side ticks damage each round while the joiner's view
    // doesn't, → HP divergence over time. v1.7.423.
    status: m.status ? {
      mask: m.status.mask | 0,
      poisonDmgTick: m.status.poisonDmgTick | 0,
    } : null,
  }));
  sendNetEncounterAssistSnapshot(msg.fromUserId, {
    seed:       battleSt.encounterSeed >>> 0,
    turnIndex:  battleSt.encounterTurnIndex | 0,
    monsters,
    peers,
    hostUserId: battleSt.encounterHostUserId | 0,
  });
  try { addChatMessage('* ' + (msg.fromName || 'Player') + ' joined your battle!', 'system'); } catch { /* chat optional */ }
});

// Joiner side — target accepted our assist. Spawn the battle locally with
// the wire-supplied state. Mid-battle spawn: encounterMonsters HPs come
// from the snapshot (NOT the MONSTERS.get defaults). Same RNG seed so
// subsequent rolls land identically. Peers list excludes self.
setNetEncounterAssistSnapshotHandler((msg) => {
  if (!msg || !Array.isArray(msg.monsters) || msg.monsters.length === 0) return;
  if (battleSt.battleState !== 'none' || pvpSt.isPVPBattle) return;
  const monsters = [];
  for (const m of msg.monsters) {
    const id = m && (m.monsterId | 0);
    if (id == null) continue;
    const mData = MONSTERS.get(id) || MONSTERS.get(0x00);
    if (!mData) continue;
    // Rebuild status state from wire payload (v1.7.423+). Fall back to
    // a clean state if the snapshot didn't carry it (legacy or no
    // affliction).
    const status = createStatusState();
    if (m.status) {
      status.mask = (m.status.mask | 0);
      status.poisonDmgTick = (m.status.poisonDmgTick | 0);
    }
    monsters.push({
      monsterId: id,
      hp: m.hp | 0,  // CURRENT hp from snapshot, not initial
      maxHP: mData.hp,
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
      status,
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
  const seed32 = (msg.seed | 0) >>> 0;
  battleSt.preBattleTrack = TRACKS.CRYSTAL_CAVE;
  _resetBattleVars();
  // Re-set encounter state after `_resetBattleVars` wipes it (it clears
  // battleAllies + the wire flags so the next solo battle starts clean).
  battleSt.isWireEncounter = true;
  battleSt.encounterIsHost = false;
  battleSt.encounterHostUserId = msg.hostUserId | 0;
  battleSt.encounterSeed = seed32;
  battleSt.encounterTurnIndex = msg.turnIndex | 0;
  battleSt.encounterMonsters = monsters;
  battleSt.isRandomEncounter = true;
  seedRng(((seed32 >>> 0) + (msg.turnIndex | 0)) >>> 0);
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
    stats.fadeInStartMs = Date.now();
    battleSt.battleAllies.push(stats);
    addBattleATBAlly(stats);
  }
  const hostName = (peerList[0] && peerList[0].name) || 'Party';
  try { addChatMessage('* Assisted ' + hostName + "'s battle!", 'system'); } catch { /* chat optional */ }
  battleSt.battleState = 'flash-strobe';
  battleSt.battleTimer = 0;
  playSFX(SFX.BATTLE_SWIPE);
});

// Existing-peer side — a new ally joined an encounter we're already in.
// Just add them to battleAllies as wire-driven; no fade since the FSM
// is mid-flight and there's no safe animation slot. Joiner spawns the
// same battle on their own client via the snapshot path.
setNetEncounterAllyJoinHandler((msg) => {
  if (!msg || !msg.profile || !msg.profile.userId) return;
  if (!battleSt.isWireEncounter || battleSt.battleState === 'none') return;
  if (battleSt.battleAllies.length >= 3) return;
  // Dedup — could happen if server double-forwards.
  if (battleSt.battleAllies.some(a => a.userId === msg.profile.userId)) return;
  const stats = generateAllyStats(msg.profile);
  stats.userId = msg.profile.userId | 0;
  stats.isWireDriven = true;
  stats.fadeInStartMs = Date.now();
  battleSt.battleAllies.push(stats);
  addBattleATBAlly(stats);
  try { addChatMessage('* ' + (msg.profile.name || 'Player') + ' joined the battle!', 'system'); } catch { /* chat optional */ }
});
