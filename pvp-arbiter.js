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

import { mirrorReadFullState, readSaveSlot } from './api.js';
import { computeRealizedStats } from './src/realized-stats.js';
import { createRng } from './src/rng.js';
import { rollHits, rollInitiative, summarizeHits } from './src/battle-math.js';
import { processTurnStart } from './src/status-effects.js';
import { pickWeakestEnemy, pickRandomLivingTarget } from './src/combatant-ai.js';

// ── Helpers ────────────────────────────────────────────────────────────────

// Decode an NES-encoded name (AWJ font byte atlas) back to a plain JS
// string. Mirrors `_nesNameToString` in src/text-utils.js but Node-clean
// (no canvas imports). Tolerates string input (passes through) and
// undefined/empty (returns ''). v1.7.760 — fixes the v1.7.758 PvP arb
// regression where the client crashed in `_nameToBytes(name)` because
// the wire frame shipped raw bytes from the save row.
function _decodeNesName(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  // JSON-serialized Uint8Array shows up as a plain Array of numbers.
  if (!Array.isArray(input) && !ArrayBuffer.isView(input)) return '';
  let s = '';
  for (const b of input) {
    if (b >= 0xA4 && b <= 0xBD) s += String.fromCharCode(b - 0xA4 + 97);  // a-z
    else if (b >= 0x8A && b <= 0xA3) s += String.fromCharCode(b - 0x8A + 65); // A-Z
    else if (b >= 0x80 && b <= 0x89) s += String.fromCharCode(b - 0x80 + 48); // 0-9
    // Skip everything else — bare-letters-only names match what the
    // title-screen name-entry UI accepts. Trailing pad bytes (0xFF) drop.
  }
  return s;
}

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

// ── Combatant generation (P-2) ─────────────────────────────────────────────

// Build a single combatant from server state (saves table + mirror).
// Returns the same shape that `generateAllyStats` fast-path produces on
// the client — atk/def/agi/evade/mdef etc. are realized via the shared
// pure helper in `src/realized-stats.js` so client and server produce
// IDENTICAL numbers for the same data. Asserted by the wire-sim parity
// test.
//
// Returns null if the user has no save in the given slot (can't spawn
// a combatant without base stats). Caller in this case should either
// pick a different slot or fall back to a server-default ps shape; P-2
// just returns null and lets the start handler abort.
function buildCombatantFromUser(userId, slot) {
  const save = readSaveSlot(userId, slot);
  if (!save) return null;
  const mirror = mirrorReadFullState(userId, slot);
  // `mirrorReadFullState` always returns an object; `equipped` defaults
  // to all-zero when the user has no inv_equipped row. For P-2 we want
  // mirror's view when it exists, save's view as fallback.
  const hasMirror = (mirror.gil > 0)
                 || Object.keys(mirror.inventory || {}).length > 0
                 || mirror.equipped.weaponR !== 0
                 || mirror.equipped.body    !== 0;
  const equipped = hasMirror ? mirror.equipped : {
    weaponR: save.stats?.weaponR | 0,
    weaponL: save.stats?.weaponL | 0,
    head:    save.stats?.head    | 0,
    body:    save.stats?.body    | 0,
    arms:    save.stats?.arms    | 0,
  };
  const jobIdx = save.jobIdx | 0;
  const jobLevels = save.jobLevels || {};
  const jobLevel = (jobLevels[jobIdx]?.level | 0) || 1;
  const stats = {
    str:   save.stats?.str   | 0,
    agi:   save.stats?.agi   | 0,
    vit:   save.stats?.vit   | 0,
    int:   save.stats?.int   | 0,
    mnd:   save.stats?.mnd   | 0,
    level: (save.stats?.level | 0) || 1,
  };
  const realized = computeRealizedStats({ stats, jobIdx, jobLevel, equipped });
  // v1.7.760 — `save.name` is stored as NES-encoded bytes (Uint8Array
  // serialized as Array of numbers in JSON) by save-state.js line 84.
  // The wire frame ships strings — legacy `pvp-match` does the same via
  // `_normalizeProfileField`. Decode here so the client receives a
  // plain string and `_nameToBytes(name)` doesn't blow up at render.
  // Codec mirrors `_nesNameToString` in text-utils.js (AWJ font atlas).
  const nameStr = _decodeNesName(save.name) || ('user-' + userId);
  return {
    // Wire shape — matches the `update` profile + `generateAllyStats`
    // fast-path consumer fields exactly.
    name:    nameStr,
    userId,
    jobIdx,
    palIdx:  save.palIdx | 0,
    level:   stats.level,
    // Combat state
    hp:      save.stats?.hp    | 0 || realized.atk * 5,  // P-2 fallback; P-4 will use stats.maxHP
    maxHP:   save.stats?.maxHP | 0 || realized.atk * 5,
    mp:      save.stats?.mp    | 0,
    maxMP:   save.stats?.maxMP | 0,
    // Realized stats from the pure helper
    atk:          realized.atk,
    def:          realized.def,
    agi:          realized.effAgi || 1,
    hitRate:      realized.hitRate,
    evade:        realized.evade,
    mdef:         realized.mdef,
    shieldEvade:  realized.shieldEvade,
    elemResist:   realized.elemResist,
    statusResist: realized.statusResist,
    intStat:      realized.intStat,
    mndStat:      realized.mndStat,
    // Equipment
    weaponR:  equipped.weaponR,
    weaponL:  equipped.weaponL,
    head:     equipped.head,
    body:     equipped.body,
    arms:     equipped.arms,
    // Spells + job level for AI healer chooser
    knownSpells: Array.isArray(save.knownSpells) ? [...save.knownSpells] : [],
    jobLevel,
    // Per-combatant battle state — initialized fresh per battle
    statusMask: 0,
    defending:  false,
    asleep:     false,
  };
}

// ── AI intent picker (v1.7.751 P-5) ──────────────────────────────────────
//
// Smart targeting + panic-defend gate. Replaces P-4's random-target stub.
//
// Decision tree:
//   1. Panic defend — if self HP <= 20%, defend (the actor's incoming
//      hit gets halved; the next turn the defender may have healed).
//   2. Smart attack — pick the LOWEST-HP alive enemy ("finish the
//      wounded"). Ties broken stably by cell order.
//   3. Fallback defend — if no enemies alive (battle is about to end
//      anyway), defend.
//
// Magic + items deferred to P-5b/c (lands after P-4c implements magic
// intents on the server). Until then the AI has no `magic` / `item`
// branch — choosing them would only waste turns under P-4's no-op
// stub, so the AI stays attack-only. Doesn't make the AI worse than
// P-4 — it just defers the smart-spell flow until magic actually
// resolves.
//
// Random-target fallback still useful occasionally (anti-predictability
// for human PvP) — gated to 20% of attack picks via the per-battle RNG.
const _AI_PANIC_HP_PCT = 0.20;
const _AI_RANDOM_TARGET_PCT = 0.20;

function _pickAiIntent(actor, battle) {
  // Panic defend.
  if (actor.maxHP > 0 && actor.hp / actor.maxHP <= _AI_PANIC_HP_PCT) {
    return { kind: 'defend' };
  }
  // Smart enemy pick.
  const enemySide = actor.side === 'A' ? 'B' : 'A';
  const enemies = battle.combatants.filter(c => c.side === enemySide && c.hp > 0);
  if (enemies.length === 0) return { kind: 'defend' };
  // 20% of the time, pick a random alive enemy instead of always the
  // weakest — keeps human opponents guessing about which mate gets
  // focused. Uses the per-battle RNG so behavior is reproducible.
  const useRandom = battle.rng.rand() < _AI_RANDOM_TARGET_PCT;
  const target = useRandom
    ? pickRandomLivingTarget(enemies, { rand: battle.rng.rand })
    : pickWeakestEnemy(enemies);
  return { kind: 'attack', targetCellId: target.cellId };
}

// ── Turn resolution (P-4) ─────────────────────────────────────────────────
//
// Round model: both sides' humans submit intents simultaneously (one per
// human cell). When all alive humans have submitted, the server picks
// AI intents for non-human alive cells, sorts everyone by rolled
// initiative (AGI*2 + rand[0..256)), and walks each cell in order
// running its intent. Per-cell deltas are accumulated into one
// `pvp-turn` frame broadcast to both clients.
//
// P-4 simplifications:
//   - Single-hit attacks only (potentialHits=1). P-4b adds multi-hit
//     via `calcPotentialHits` once we wire dual-wield correctly.
//   - 'magic' / 'item' / 'flee' intents fall through to no-op (treated
//     as a wasted turn). P-4c covers those.
//   - No 15s per-intent timeout. P-4d adds the watchdog → 'defend'
//     fallback if a human goes unresponsive.
//   - Defend doubles your DEF this turn (NES half-damage); cleared at
//     end of turn. Translates to `defendHalve: true` on rollHits.

// Pick a single combatant's intent → list of deltas. Mutates target HP
// + actor.defending. Reads from the battle's per-battle RNG.
function _resolveActorIntent(actor, intent, battle) {
  const deltas = [];
  if (!intent || intent.kind === 'defend' || intent.kind === 'flee') {
    actor.defending = true;
    deltas.push({ kind: 'state', actorCellId: actor.cellId, change: 'defend-on' });
    return deltas;
  }
  if (intent.kind === 'magic' || intent.kind === 'item') {
    // P-4c will land these. Until then they no-op (logged so we notice
    // any client trying to use them during smoke).
    console.warn('[pvp-arb] kind=' + intent.kind + ' not yet implemented (P-4c); skipped actor=' + actor.cellId);
    return deltas;
  }
  if (intent.kind === 'attack') {
    let target = battle.combatants.find(c => c.cellId === intent.targetCellId);
    // Target dead before our turn → pick a random replacement on the
    // same side. Matches the existing client behavior in
    // battle-ally.js where `resolveLivingTarget` retargets to a live
    // enemy mid-round.
    if (!target || target.hp <= 0) {
      const enemySide = actor.side === 'A' ? 'B' : 'A';
      const live = battle.combatants.filter(c => c.side === enemySide && c.hp > 0);
      if (live.length === 0) return deltas;
      target = live[Math.floor(battle.rng.rand() * live.length)];
    }
    const hits = rollHits(actor.atk, target.def, actor.hitRate, 1, {
      rand:         battle.rng.rand,
      shieldEvade:  target.shieldEvade | 0,
      evade:        target.evade | 0,
      defendHalve:  !!target.defending,
      critPct:      4,                              // baseline crit; matches client's job-baseline
      critBonus:    Math.floor(actor.atk / 2),     // matches calcAttackerAtk's display formula
    });
    const summary = summarizeHits(hits);
    const dmg = summary.allMiss ? 0 : summary.totalDmg;
    target.hp = Math.max(0, target.hp - dmg);
    deltas.push({
      kind:         'attack',
      actorCellId:  actor.cellId,
      targetCellId: target.cellId,
      damage:       dmg,
      hit:          !summary.allMiss,
      crit:         summary.anyCrit,
      hand:         'R',
    });
    if (target.hp === 0) {
      deltas.push({ kind: 'death', actorCellId: target.cellId });
    }
    return deltas;
  }
  // Unknown kind — log and no-op (handleIntent validates the allowlist,
  // so this shouldn't fire in production).
  console.warn('[pvp-arb] unknown intent kind=' + intent.kind + ' actor=' + actor.cellId);
  return deltas;
}

// Returns the side ('A' | 'B' | null) that has lost the battle, or null
// if both sides have at least one combatant alive.
function _checkBattleEnd(battle) {
  const aliveA = battle.combatants.some(c => c.side === 'A' && c.hp > 0);
  const aliveB = battle.combatants.some(c => c.side === 'B' && c.hp > 0);
  if (!aliveA && !aliveB) return 'draw';
  if (!aliveA) return 'B';   // A defeated → B wins
  if (!aliveB) return 'A';
  return null;
}

// Resolve one full round into a `pvp-turn` frame. Caller guarantees
// `battle.status === 'awaiting-intent'` and all alive humans have an
// intent in `battle.pendingIntents`. Returns the wire frame.
function resolveTurn(battle) {
  battle.status = 'resolving';
  battle.turnIdx++;
  const deltas = [];
  // Clear defending flag at start of round (defend lasts ONE round per
  // the NES tradition). Then collect AI intents for non-human alive
  // cells.
  for (const c of battle.combatants) {
    c.defending = false;
    if (c.hp <= 0) continue;
    if (c.isHuman) continue;
    if (!battle.pendingIntents.has(c.cellId)) {
      battle.pendingIntents.set(c.cellId, _pickAiIntent(c, battle));
    }
  }
  // Roll initiative for every alive cell; sort descending.
  const order = battle.combatants
    .filter(c => c.hp > 0)
    .map(c => ({ c, init: rollInitiative(c.agi, { rand: battle.rng.rand }) }))
    .sort((a, b) => b.init - a.init);
  for (const { c } of order) {
    if (c.hp <= 0) continue;    // died earlier in this round
    // Sleep / paralysis check.
    if (!c.status) c.status = { mask: 0, poisonDmgTick: 0 };
    const tick = processTurnStart(c.status, c.maxHP, { rand: battle.rng.rand });
    if (!tick.canAct) {
      deltas.push({ kind: 'state', actorCellId: c.cellId, change: 'sleep-skip' });
      continue;
    }
    const intent = battle.pendingIntents.get(c.cellId);
    deltas.push(..._resolveActorIntent(c, intent, battle));
    const victor = _checkBattleEnd(battle);
    if (victor) break;
  }
  // End-of-round poison ticks. P-4 keeps this simple — applies the
  // tick to every poisoned alive combatant (no order — symmetric).
  for (const c of battle.combatants) {
    if (c.hp <= 0) continue;
    if (!c.status || !(c.status.mask & 0x08)) continue;   // 0x08 = STATUS.POISON
    const tickDmg = Math.floor(c.maxHP / 16);
    if (tickDmg > 0) {
      c.hp = Math.max(0, c.hp - tickDmg);
      deltas.push({
        kind: 'status-tick', actorCellId: c.cellId, statusKind: 'poison', damage: tickDmg,
      });
      if (c.hp === 0) {
        deltas.push({ kind: 'death', actorCellId: c.cellId });
      }
    }
  }
  // Final defeat check after status ticks.
  const victor = _checkBattleEnd(battle);
  if (victor) {
    deltas.push({ kind: 'end', victor });
    battle.status = 'ended';
    battle.endedAt = Date.now();
    setTimeout(() => {
      _battles.delete(battle.battleId);
      _userBattle.delete(battle.sideA.userId);
      _userBattle.delete(battle.sideB.userId);
    }, 5000);
  } else {
    // Round complete; next round waits on fresh human intents.
    battle.pendingIntents.clear();
    battle.status = 'awaiting-intent';
  }
  // nextActor — null when battle ended, otherwise points at the next
  // ALIVE human cell whose turn-prompt should fire on their client.
  // Both clients share the same value; each side's prompt fires only
  // when nextActor.userId matches that client's userId.
  let nextActor = null;
  if (battle.status === 'awaiting-intent') {
    const nextHuman = battle.combatants.find(c => c.isHuman && c.hp > 0);
    if (nextHuman) {
      nextActor = { cellId: nextHuman.cellId, isHuman: true, userId: nextHuman.userId };
    }
  }
  return {
    type:     'pvp-turn',
    battleId: battle.battleId,
    turnIdx:  battle.turnIdx,
    deltas,
    nextActor,
  };
}

// True if the round is ready to resolve: every alive human has an
// intent queued. AI cells don't gate — server picks for them.
function isRoundReady(battle) {
  if (battle.status !== 'awaiting-intent') return false;
  for (const c of battle.combatants) {
    if (!c.isHuman) continue;
    if (c.hp <= 0) continue;
    if (!battle.pendingIntents.has(c.cellId)) return false;
  }
  return true;
}

// ── Battle factory ─────────────────────────────────────────────────────────

// Create a new battle.
//
// P-1 took just (userIdA, userIdB) and stubbed combatants as empty.
// P-2 expands to populate combatants from each side's player + party
// mates via `buildCombatantFromUser`. Cell id assignment:
//   side A: 0 (main), 1, 2, 3 (mates in roster order)
//   side B: 4 (main), 5, 6, 7 (mates in roster order)
//
// `opts.sideAMates` / `opts.sideBMates` are arrays of partymate userIds
// (0 to 3 entries each). `opts.slot` is the save slot to read for every
// combatant (P-2 defaults to 0; P-4+ may allow per-user slot via the
// entry.slot tracked at WS hello).
//
// Throws if either main user is already in a battle. Mates already in
// battles are EXCLUDED from this battle's combatant list — they're
// busy fighting elsewhere (P-9 smoke will verify this edge holds).
function createBattle(userIdA, userIdB, opts) {
  if (_userBattle.has(userIdA)) throw new Error('user-A in battle: ' + userIdA);
  if (_userBattle.has(userIdB)) throw new Error('user-B in battle: ' + userIdB);
  opts = opts || {};
  const slot = opts.slot != null ? (opts.slot | 0) : 0;
  const matesA = (opts.sideAMates || []).filter(uid => uid !== userIdA && !_userBattle.has(uid)).slice(0, 3);
  const matesB = (opts.sideBMates || []).filter(uid => uid !== userIdB && !_userBattle.has(uid)).slice(0, 3);
  const battleId = _nextBattleId++;
  const combatants = [];
  let cellIdCounter = 0;
  function pushCombatant(uid, side) {
    const c = buildCombatantFromUser(uid, slot);
    if (!c) return null;
    c.cellId = cellIdCounter++;
    c.side = side;
    c.isHuman = (uid === userIdA || uid === userIdB);
    combatants.push(c);
    return c;
  }
  const mainA = pushCombatant(userIdA, 'A');
  if (!mainA) throw new Error('user-A has no save in slot ' + slot);
  for (const uid of matesA) pushCombatant(uid, 'A');
  // Reserve cellId 4 for side B's main even if side A had fewer than 4
  // combatants — keeps the (A: 0-3, B: 4-7) range stable so a client
  // tracking cellId for a target doesn't need to recompute on join.
  while (cellIdCounter < 4) cellIdCounter++;
  const mainB = pushCombatant(userIdB, 'B');
  if (!mainB) throw new Error('user-B has no save in slot ' + slot);
  for (const uid of matesB) pushCombatant(uid, 'B');
  // v1.7.749 P-3 — per-battle RNG instance. Server is sole roller for
  // every gameplay-affecting decision (turn order, damage variance,
  // crit, hit/miss, shield block, status inflict, AI choice). Clients
  // get the seed in `pvp-battle-start` for ANIMATION rolls only (frame
  // jitter, miss-graphic position) — never gameplay.
  const seedValue = ((Date.now() ^ battleId * 0x9E3779B1) >>> 0) || 1;
  const battle = {
    battleId,
    createdAt: Date.now(),
    turnIdx: 0,
    rngSeed: seedValue,
    rng: createRng(seedValue),
    status: 'awaiting-intent',     // 'awaiting-intent' | 'resolving' | 'ended'
    pendingIntents: new Map(),     // userId → intent
    combatants,
    sideA: { userId: userIdA, slot, mainCellId: mainA.cellId },
    sideB: { userId: userIdB, slot, mainCellId: mainB.cellId },
    endedAt: 0,
  };
  _battles.set(battleId, battle);
  _userBattle.set(userIdA, battleId);
  _userBattle.set(userIdB, battleId);
  // Mates aren't tracked in _userBattle — they're not WS participants of
  // this battle, just AI cells. If a mate's user opens a separate PvP
  // session, they spawn their OWN battle (with this user as an AI cell
  // there) — that's a known edge for P-9 smoke to validate.
  return battle;
}

// Build the `pvp-battle-start` wire frame for a specific recipient.
// v1.7.748 P-2 — sides arrays carry the full combatant table; the
// client renders + animates from this shape directly (no parallel
// `generateAllyStats` derivation on the client).
//
// `yourCellId` is the recipient's main player cell so the client knows
// which cell is "the human at this keyboard". AI mates on the same
// side are rendered + animated identically; just the input prompt is
// gated on `yourCellId`.
function buildStartFrame(battle, forUserId) {
  const yourSide = (battle.sideA.userId === forUserId) ? 'A'
                 : (battle.sideB.userId === forUserId) ? 'B'
                 : null;
  if (!yourSide) return null;
  const yourCellId = yourSide === 'A' ? battle.sideA.mainCellId : battle.sideB.mainCellId;
  // Shape per-side combatant entries for the wire — drop internal-only
  // fields (defending/asleep/statusMask all start at zero/false; the
  // client mirrors them as turn deltas land).
  const wireShape = (c) => ({
    cellId:       c.cellId,
    side:         c.side,
    isHuman:      c.isHuman,
    userId:       c.isHuman ? c.userId : undefined,
    name:         c.name,
    jobIdx:       c.jobIdx,
    palIdx:       c.palIdx,
    level:        c.level,
    hp:           c.hp,
    maxHP:        c.maxHP,
    mp:           c.mp,
    maxMP:        c.maxMP,
    atk:          c.atk,
    def:          c.def,
    agi:          c.agi,
    hitRate:      c.hitRate,
    evade:        c.evade,
    mdef:         c.mdef,
    shieldEvade:  c.shieldEvade,
    elemResist:   c.elemResist,
    statusResist: c.statusResist,
    intStat:      c.intStat,
    mndStat:      c.mndStat,
    weaponR:      c.weaponR,
    weaponL:      c.weaponL,
    head:         c.head,
    body:         c.body,
    arms:         c.arms,
    jobLevel:     c.jobLevel,
    knownSpells:  c.knownSpells,
  });
  return {
    type:       'pvp-battle-start',
    battleId:   battle.battleId,
    yourSide,
    yourCellId,
    sides: {
      A: battle.combatants.filter(c => c.side === 'A').map(wireShape),
      B: battle.combatants.filter(c => c.side === 'B').map(wireShape),
    },
    rngSeed:    battle.rngSeed,     // animation-only on the client
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
//   { ok: false, reason: 'no-battle' | 'wrong-battle' | 'stale-turn' |
//                         'bad-kind' | 'not-human' | 'dead' | 'wrong-turn' }
//   { ok: true, battle, intent, ready }
//
// `ready` is true when this intent completed the round (every alive
// human has now submitted). The caller (ws-presence) then drives the
// resolution + broadcast.
//
// P-1 only validated the envelope. v1.7.750 P-4 validates the human
// cell is alive + maps userId → cellId. Target liveness + MP cost +
// item ownership land in P-4c (when magic/item kinds activate).
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
  if (battle.status !== 'awaiting-intent') return { ok: false, reason: 'not-awaiting' };
  if (claimedTurn !== battle.turnIdx) return { ok: false, reason: 'stale-turn' };
  const allowed = ['attack', 'magic', 'item', 'defend', 'flee'];
  if (!allowed.includes(kind)) return { ok: false, reason: 'bad-kind' };
  // Resolve which combatant this user controls. P-2 sets sideX.mainCellId.
  let myCellId = null;
  if (battle.sideA.userId === userId) myCellId = battle.sideA.mainCellId;
  else if (battle.sideB.userId === userId) myCellId = battle.sideB.mainCellId;
  if (myCellId == null) return { ok: false, reason: 'not-human' };
  const myCell = battle.combatants.find(c => c.cellId === myCellId);
  if (!myCell || myCell.hp <= 0) return { ok: false, reason: 'dead' };
  const intent = {
    kind,
    targetCellId: parsed.targetCellId != null ? (parsed.targetCellId | 0) : null,
    spellId:      parsed.spellId      != null ? (parsed.spellId      | 0) : null,
    itemId:       parsed.itemId       != null ? (parsed.itemId       | 0) : null,
    submittedAt:  Date.now(),
  };
  battle.pendingIntents.set(myCellId, intent);
  return { ok: true, battle, intent, ready: isRoundReady(battle) };
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

// v1.7.749 P-3 — expose the per-battle RNG for parity tests. Wire-sim
// asserts that a client `createRng(rngSeed)` instance rolls identical
// values to the server's `battle.rng`. Production code should not call
// this — it leaks the RNG identity and would let a client predict server
// rolls (defeats the whole "server is sole roller" point).
function _testGetBattleRng(battleId) {
  const b = _battles.get(battleId);
  return b ? b.rng : null;
}

export {
  createBattle,
  buildStartFrame,
  endBattle,
  handleIntent,
  resolveTurn,
  isRoundReady,
  handleDisconnect,
  reapStalled,
  getActiveCount,
  getBattleForUser,
  _testReset,
  _testGetBattleRng,
};
