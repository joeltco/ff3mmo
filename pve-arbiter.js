// PvE server-validated battle FSM. v1.7.772 P-2 skeleton.
//
// Single-player encounter arbiter using the replay-validate model
// (NOT a full server FSM like pvp-arbiter.js). Server picks monsters +
// RNG seed + records pre-state. Client runs the battle locally with
// that seed; intents are buffered + submitted at end. Server replays
// from seed+intents and accepts the outcome only on match. Wire shapes
// + phased rollout: docs/PVE-REWRITE-PLAN.md.
//
// P-2 deliverable (this file): the scaffold. Encounter generation +
// pre-state snapshot + battle tracking. No replay engine, no validation —
// `endPveBattle` always accepts the client's claim. P-5 (replay engine)
// + P-6 (end-of-battle validation) finish the contract.

import { createRng } from './src/rng.js';
import { MONSTERS } from './src/data/monsters.js';
import { ENCOUNTERS } from './src/data/encounters.js';
import { readSaveSlot, mirrorReadFullState } from './api.js';
import { validateBattleOutcome } from './pve-replay.js';

// ── Configuration ──────────────────────────────────────────────────────────

const BATTLE_IDLE_TTL_MS = 5 * 60 * 1000;
const GOBLIN_HIT_RATE = 60;                 // matches src/battle-math.js#GOBLIN_HIT_RATE

// ── State ──────────────────────────────────────────────────────────────────

const _battles = new Map();                 // battleId → Battle
const _userBattle = new Map();              // userId → battleId
let _nextBattleId = 1;

// ── Helpers ────────────────────────────────────────────────────────────────

// Build one encounter monster instance from a monster id. Mirrors
// `_makeEncounterMonster` in src/battle-encounter.js so both client and
// server (replay) produce identical fields for the same monster.
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
    // status: createStatusState() lives in src/status-effects.js — that
    // module is Node-clean and gets imported by pve-replay.js (P-5).
    // Wire shape for clients uses a flat byte (statusMask=0) until then.
    statusMask: 0,
  };
}

// Pick a formation + monster counts using the given RNG. Mirrors
// `startRandomEncounter` in src/battle-encounter.js. Returns the
// `encounterMonsters` array. Caller's RNG advances deterministically.
function _pickFormation(zoneKey, rng) {
  const zone = ENCOUNTERS.get(zoneKey);
  const formations = zone ? zone.formations : [[{ id: 0x00, min: 1, max: 3 }]];
  const formation = formations[Math.floor(rng() * formations.length)];
  const out = [];
  for (const group of formation) {
    const count = group.min + Math.floor(rng() * (group.max - group.min + 1));
    for (let i = 0; i < count; i++) {
      if (out.length >= 4) break;
      out.push(_makeEncounterMonster(group.id));
    }
    if (out.length >= 4) break;
  }
  // The client sorts by sprite height (cosmetic — affects render order
  // only). Replay engine doesn't sort; battle math doesn't care about
  // monster order, just hp>0 filter on stable indices.
  return out;
}

// Snapshot the user's full pre-state needed for replay: save row + mirror
// (gil + equipped + inventory). Single source for P-2 + P-6.
function _snapshotPreState(userId, slot) {
  const save = readSaveSlot(userId, slot);
  if (!save) return null;
  const mirror = mirrorReadFullState(userId, slot);
  return {
    userId, slot,
    save,                                    // stats, jobIdx, jobLevels, spells, status, etc.
    gil:       mirror.gil,
    inventory: mirror.inventory,             // {itemId: qty}
    equipped:  mirror.equipped,              // {weaponR, weaponL, body, ...}
    // No allies snapshot in P-2. P-5 expands this to include party-member
    // saves so the replay engine can spawn AI allies with realized stats.
  };
}

function _gcStaleBattles() {
  const now = Date.now();
  for (const [id, b] of _battles) {
    if (now - (b.lastTouchedAt || b.createdAt) > BATTLE_IDLE_TTL_MS) {
      _battles.delete(id);
      if (_userBattle.get(b.userId) === id) _userBattle.delete(b.userId);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

// Create a new PvE battle for `userId` in slot `slot`. Picks monsters,
// snapshots pre-state, returns the battle-start payload the wire handler
// emits to the client. Caller (ws-presence.js) handles emit + error reply.
//
// Returns:
//   { battleId, rngSeed, monsters }       on success
//   { error: 'no-save' | 'unknown-zone' | 'already-in-battle' | 'no-monsters' }
//                                         on rejection
export function createPveBattle(userId, opts) {
  _gcStaleBattles();
  const { slot, zoneKey, mapId } = opts || {};
  if (_userBattle.has(userId)) {
    // Idempotency: if a client reconnects mid-battle, return the existing
    // battle's start frame so it can re-attach. Stable battleId.
    const existingId = _userBattle.get(userId);
    const existing = _battles.get(existingId);
    if (existing) {
      return { battleId: existing.battleId, rngSeed: existing.rngSeed, monsters: existing.monsters };
    }
    _userBattle.delete(userId);
  }
  const preState = _snapshotPreState(userId, slot);
  if (!preState) return { error: 'no-save' };
  if (!ENCOUNTERS.has(zoneKey)) return { error: 'unknown-zone' };

  const rngSeed = ((Date.now() ^ (Math.random() * 0x7fffffff | 0)) >>> 0) || 1;
  const rng = createRng(rngSeed).rand;
  const monsters = _pickFormation(zoneKey, rng);
  if (!monsters.length) return { error: 'no-monsters' };

  const battleId = _nextBattleId++;
  const battle = {
    battleId, userId, slot,
    zoneKey, mapId,
    rngSeed,
    monsters,
    preState,
    intents: [],
    status: 'in-progress',
    createdAt: Date.now(),
    lastTouchedAt: Date.now(),
  };
  _battles.set(battleId, battle);
  _userBattle.set(userId, battleId);

  return { battleId, rngSeed, monsters };
}

// Record an intent for a battle's per-turn log. Tolerates duplicates
// (same turnIdx) by overwriting — clients may resend on reconnect.
// Returns true on success, false on unknown battle or out-of-range turn.
//
// `turnIdx` is bounded to keep `battle.intents` from growing unbounded
// when a misbehaving client sends `0x7FFFFFFF` — `| 0` would accept it
// and V8 would hold the sparse array in dictionary mode for the life of
// the battle. Real battles never exceed ~30 turns; MAX_TURN_IDX leaves
// 30× headroom and still bounds per-battle memory.
const MAX_TURN_IDX = 999;
export function recordIntent(userId, intent) {
  const battleId = intent?.battleId;
  const battle = _battles.get(battleId);
  if (!battle) return false;
  if (battle.userId !== userId) return false;
  if (battle.status !== 'in-progress') return false;
  const turnIdx = intent.turnIdx | 0;
  if (turnIdx < 0 || turnIdx > MAX_TURN_IDX) return false;
  battle.lastTouchedAt = Date.now();
  battle.intents[turnIdx] = intent;
  return true;
}

// End-of-battle handler. P-2 stub: always accepts the client's claim
// (no replay, no validation). The CALLER (ws-presence.js) is responsible
// for actually applying the deltas to the save/mirror — for P-2 the
// client continues to write its own save and the server's `applied`
// response is informational. P-6 moves the delta-apply into this function
// once the replay engine (P-5) lands.
//
// Returns:
//   { status: 'applied', canonical }       success path (P-2 echoes claim)
//   { status: 'rejected', reason }         failure path
export function endPveBattle(userId, payload) {
  const battleId = payload?.battleId;
  const battle = _battles.get(battleId);
  if (!battle) return { status: 'rejected', reason: 'no-battle' };
  if (battle.userId !== userId) return { status: 'rejected', reason: 'not-owner' };

  battle.intents = payload.intents || battle.intents;
  battle.claimedOutcome = payload.claimedOutcome || null;
  battle.status = 'ended';
  battle.endedAt = Date.now();

  // v1.7.775 P-5 — outcome-validate against the server-canonical monster
  // list. Catches forged exp / gil / cp / drop. Per-action replay
  // (full HP / status validation) deferred to P-5b. Caller (P-6) applies
  // the canonical deltas to the save row when accepted.
  const result = validateBattleOutcome(battle, payload.claimedOutcome);

  _battles.delete(battleId);
  if (_userBattle.get(userId) === battleId) _userBattle.delete(userId);

  if (!result.accepted) {
    console.log('[pve-divergence] battle=' + battleId + ' user=' + userId +
      ' reason=' + result.reason +
      ' claim=' + JSON.stringify(payload.claimedOutcome));
    return { status: 'rejected', reason: result.reason };
  }
  return { status: 'applied', canonical: result.canonical };
}

// Disconnect / explicit cancel. Cleans up tracking. Used by the WS
// close handler so a dropped client doesn't leak a battle slot.
export function cancelPveBattle(userId) {
  const battleId = _userBattle.get(userId);
  if (!battleId) return false;
  const battle = _battles.get(battleId);
  if (battle) battle.status = 'ended';
  _battles.delete(battleId);
  _userBattle.delete(userId);
  return true;
}

// Test-only — drain the maps between unit tests so per-test state stays
// isolated. NOT used in production.
export function _testReset() {
  _battles.clear();
  _userBattle.clear();
  _nextBattleId = 1;
}
