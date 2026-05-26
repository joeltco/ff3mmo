// PvP server-arbitrated battle FSM. v1.7.747 P-1 scaffold.
//
// This module owns the per-battle state for PvP matches. The wire
// protocol + phased rollout plan lives in `docs/PVP-REWRITE-PLAN.md`.
//
// P-1 deliverable (this file): the scaffold + roundtrip plumbing.
// Battle creation, intent validation, end-of-battle teardown — but no
// real combat math, no AI, no stat generation. A P-1 battle starts and
// immediately ends with `victor: 'draw'` after one no-op turn. Proves
// the wire shapes work and ws-presence can host the FSM.
//
// Future phases (P-2 onward) fill in the gaps:
//   P-2 — `buildCombatantFromUser` (server-side `generateAllyStats`
//         equivalent reading from mirror + saves)
//   P-3 — port `battle-math.js` to be Node-clean + import here
//   P-4 — turn resolution (AGI sort, intent execution, end-of-round
//         status ticks)
//   P-5 — server-side AI (`pickAiIntent`)
//   P-6 — client viewer module consumes deltas
//   P-7 — input rewire to emit `pvp-intent`
//   P-8 — name strip → attacker/target only
//   P-9 — FLAG FLIP (`PVP_ARBITER = true`, `PVP_ENABLED = true`)
//   P-10 — cleanup (rip lockstep code)

// ── Configuration ──────────────────────────────────────────────────────────

// Idle TTL for ended-or-stalled battles. P-1 ships with 5min — once the
// watchdog timer in P-4 lands, this becomes a backstop for the case
// where the watchdog itself fails to fire.
const BATTLE_IDLE_TTL_MS = 5 * 60 * 1000;

// Per-intent timeout. After P-4 lands the turn loop, if a human cell
// doesn't emit an intent within this window the FSM picks 'defend' as
// a fallback so the battle progresses. 15s matches the existing battle
// pacing — long enough for a player to think, short enough that an idle
// player doesn't grief the opponent.
// const INTENT_TIMEOUT_MS = 15 * 1000;   // unused in P-1, lands in P-4

// ── State ──────────────────────────────────────────────────────────────────

// Active battles, keyed by battleId. Each entry is a Battle object (see
// `createBattle`). When a battle ends, the entry is GC'd after a delay so
// late `pvp-intent` frames from a slow client get a clean error response
// instead of "no such battle".
const _battles = new Map();

// userId → battleId. Lookup for incoming `pvp-intent` frames. A user can
// only be in one battle at a time; trying to start a second one rejects.
const _userBattle = new Map();

let _nextBattleId = 1;

// ── Battle factory ─────────────────────────────────────────────────────────

// Create a new battle. P-1 takes a minimal shape — just userId-A + userId-B.
// P-2 will expand to read mirror/saves and generate full combatant lists
// from each player's party. P-1 stubs the combatants array as empty.
//
// Returns the new Battle. Throws if either user is already in a battle.
function createBattle(userIdA, userIdB) {
  if (_userBattle.has(userIdA)) throw new Error('user-A in battle: ' + userIdA);
  if (_userBattle.has(userIdB)) throw new Error('user-B in battle: ' + userIdB);
  const battleId = _nextBattleId++;
  const battle = {
    battleId,
    createdAt: Date.now(),
    turnIdx: 0,
    rngState: ((Date.now() ^ battleId) >>> 0),
    status: 'awaiting-intent',     // 'awaiting-intent' | 'resolving' | 'ended'
    pendingIntents: new Map(),     // userId → intent
    combatants: [],                // P-2 will populate
    sideA: { userId: userIdA },    // P-2 expands
    sideB: { userId: userIdB },
    endedAt: 0,
  };
  _battles.set(battleId, battle);
  _userBattle.set(userIdA, battleId);
  _userBattle.set(userIdB, battleId);
  return battle;
}

// Build the `pvp-battle-start` wire frame for a specific recipient.
// P-1 returns a near-empty frame with the IDs + an empty sides shape;
// P-2 fills in the combatants list with realized stats.
function buildStartFrame(battle, forUserId) {
  const yourSide = (battle.sideA.userId === forUserId) ? 'A'
                 : (battle.sideB.userId === forUserId) ? 'B'
                 : null;
  if (!yourSide) return null;
  return {
    type:       'pvp-battle-start',
    battleId:   battle.battleId,
    yourSide,
    yourCellId: 0,                  // P-2 — pulled from combatant table
    sides: {
      A: [],                        // P-2 populates
      B: [],
    },
    rngSeed:    battle.rngState,    // animation-only on the client
  };
}

// End a battle with the given victor. Sends `pvp-turn` with a single
// `kind: 'end'` delta to both sides, then schedules teardown.
//
// P-1 immediately ends battles with `victor: 'draw'` after creation —
// the scaffold can roundtrip but does no real combat. Sending the
// end frame is done by the caller (ws-presence) since this module
// doesn't hold the WS references.
function endBattle(battle, victor) {
  if (battle.status === 'ended') return;
  battle.status = 'ended';
  battle.endedAt = Date.now();
  // Defer GC so late intents from either client land on a battle that
  // still exists (returns a clear error) instead of one that's vanished.
  setTimeout(() => {
    _battles.delete(battle.battleId);
    if (_userBattle.get(battle.sideA.userId) === battle.battleId) _userBattle.delete(battle.sideA.userId);
    if (_userBattle.get(battle.sideB.userId) === battle.battleId) _userBattle.delete(battle.sideB.userId);
  }, 5000);
  return {
    type:     'pvp-turn',
    battleId: battle.battleId,
    turnIdx:  battle.turnIdx + 1,
    deltas:   [ { kind: 'end', victor } ],
    nextActor: null,
  };
}

// ── Intent handling ────────────────────────────────────────────────────────

// Validate + accept a `pvp-intent` frame. Returns:
//   { ok: false, reason: 'no-battle' | 'wrong-battle' | 'stale-turn' | 'bad-kind' }
//   { ok: true, battle, intent }
//
// P-1 only validates the envelope (battleId match, turnIdx match, kind in
// the allowlist). P-4 will validate target alive, MP cost, item ownership,
// etc., once the FSM holds real combatant state.
function handleIntent(userId, parsed) {
  const battleId = parsed.battleId | 0;
  const claimedTurn = parsed.turnIdx | 0;
  const kind = String(parsed.kind || '');
  const myBattleId = _userBattle.get(userId);
  if (!myBattleId) return { ok: false, reason: 'no-battle' };
  if (myBattleId !== battleId) return { ok: false, reason: 'wrong-battle' };
  const battle = _battles.get(battleId);
  if (!battle) return { ok: false, reason: 'no-battle' };
  if (battle.status === 'ended') return { ok: false, reason: 'battle-ended' };
  if (claimedTurn !== battle.turnIdx) return { ok: false, reason: 'stale-turn' };
  const allowed = ['attack', 'magic', 'item', 'defend', 'flee'];
  if (!allowed.includes(kind)) return { ok: false, reason: 'bad-kind' };
  const intent = {
    kind,
    targetCellId: parsed.targetCellId != null ? (parsed.targetCellId | 0) : null,
    spellId:      parsed.spellId      != null ? (parsed.spellId      | 0) : null,
    itemId:       parsed.itemId       != null ? (parsed.itemId       | 0) : null,
    submittedAt:  Date.now(),
  };
  battle.pendingIntents.set(userId, intent);
  return { ok: true, battle, intent };
}

// ── Disconnect handling ────────────────────────────────────────────────────

// Called from ws-presence when a player disconnects. If they were in a
// battle, the battle ends with `pvp-cancel reason: 'opponent-disconnect'`
// sent to the survivor. Returns the cancel frame + the surviving userId
// (so ws-presence can dispatch); null if no active battle.
function handleDisconnect(userId) {
  const battleId = _userBattle.get(userId);
  if (!battleId) return null;
  const battle = _battles.get(battleId);
  if (!battle) return null;
  if (battle.status === 'ended') return null;
  battle.status = 'ended';
  battle.endedAt = Date.now();
  const survivorId = (battle.sideA.userId === userId) ? battle.sideB.userId : battle.sideA.userId;
  setTimeout(() => {
    _battles.delete(battleId);
    _userBattle.delete(battle.sideA.userId);
    _userBattle.delete(battle.sideB.userId);
  }, 5000);
  return {
    survivorId,
    frame: { type: 'pvp-cancel', battleId, reason: 'opponent-disconnect' },
  };
}

// ── Idle GC ───────────────────────────────────────────────────────────────

// Sweep stalled battles. Called from ws-presence's existing reaper timer.
// P-1: just culls battles older than BATTLE_IDLE_TTL_MS regardless of
// status. P-4+ will be smarter (separate "active but slow" vs "stuck").
function reapStalled() {
  const now = Date.now();
  const cutoff = now - BATTLE_IDLE_TTL_MS;
  let n = 0;
  for (const [bid, b] of _battles) {
    if (b.createdAt < cutoff) {
      _battles.delete(bid);
      _userBattle.delete(b.sideA.userId);
      _userBattle.delete(b.sideB.userId);
      n++;
    }
  }
  return n;
}

// ── Diagnostics ────────────────────────────────────────────────────────────

function getActiveCount() { return _battles.size; }
function getBattleForUser(userId) {
  const bid = _userBattle.get(userId);
  return bid ? _battles.get(bid) : null;
}

// Test helpers (wire-sim consumers only).
function _testReset() {
  _battles.clear();
  _userBattle.clear();
  _nextBattleId = 1;
}

export {
  createBattle,
  buildStartFrame,
  endBattle,
  handleIntent,
  handleDisconnect,
  reapStalled,
  getActiveCount,
  getBattleForUser,
  _testReset,
};
