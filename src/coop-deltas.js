// Pure host-arb delta logic — no singleton coupling, no wire coupling, no
// browser dependencies. Used by `coop-resolver.js` to build packets and by
// `coop-applier.js` to apply them. Also imported directly by the arbiter
// sim (`tools/coop-arbiter-sim.js`) for convergence tests, since this
// module loads cleanly in Node while `battle-state.js` does not (it
// transitively pulls in `pvp.js` which references `window`).
//
// Wire shape (host → guests):
//   { turnIdx, actor, action, deltas: [<Delta>], fx: [<FXCue>], meta }
// See docs/COOP-REWRITE-PLAN.md#wire-contract for the full schema.
//
// Phase 2 covers physical attacks (player/ally striking a monster) and
// monster attacks (against player/ally). Magic / item / poison-tick / KO
// expand the surface in Phases 3-4.

// ── Packet builders ────────────────────────────────────────────────────────

// Player or ally attacks a monster (or PvP target).
// Inputs are pre-rolled by the host's local FSM (rollHits already ran);
// this fn doesn't touch the RNG.
//
// `hits` shape: array of `{ miss, shieldBlock, damage, crit }` —
// the same shape `rollHits()` returns.
export function buildPhysicalAttackPacket({ actor, target, hits, weaponId, hand }) {
  const hitArr = Array.isArray(hits) ? hits : [];
  let totalDmg = 0;
  let anyCrit = false;
  let allMiss = hitArr.length > 0;
  for (const h of hitArr) {
    if (!h) continue;
    if (h.miss || h.shieldBlock) continue;
    allMiss = false;
    totalDmg += h.damage | 0;
    if (h.crit) anyCrit = true;
  }
  return {
    actor,
    action: { kind: 'attack', target },
    deltas: [{ target, hp: -totalDmg }],
    fx: [
      { kind: 'slash', attacker: actor, target,
        weaponId: weaponId | 0, hand: hand || 'R',
        crit: anyCrit, miss: allMiss },
      { kind: 'damage-num', target,
        value: allMiss ? 0 : totalDmg,
        variant: allMiss ? 'miss' : (anyCrit ? 'crit' : 'dmg') },
    ],
    meta: { encounterEnd: false },
  };
}

// Monster attacks a player or ally. Host has already applied the local
// damage when this is called (so `dmg` is the final-after-defend, after-
// protect, after-elemResist value); we capture it for the wire so guests
// apply the SAME value rather than re-deriving it from divergent stat
// paths. This is the single biggest convergence win in Phase 2.
//
// `statusAdd` is the STATUS bitmask the host's `tryInflictStatus` set
// during this attack — guest applies the same bits so afflictions match.
export function buildMonsterAttackPacket({ monsterIdx, target, dmg, miss, statusAdd = 0 }) {
  const dmgFinal = miss ? 0 : (dmg | 0);
  const delta = {
    target,
    hp: miss ? 0 : -dmgFinal,
  };
  if (statusAdd) {
    delta.status = { add: statusAdd | 0, remove: 0 };
  }
  return {
    actor: { kind: 'monster', idx: monsterIdx | 0 },
    action: { kind: 'monster-attack', target },
    deltas: [delta],
    fx: [
      { kind: 'damage-num', target, value: dmgFinal,
        variant: miss ? 'miss' : 'dmg' },
    ],
    meta: { encounterEnd: false },
  };
}

// ── Delta application ─────────────────────────────────────────────────────

// Apply a single delta to a resolved actor. The actor is whatever
// `coop-applier.js#resolveActorRef` returns — either `ps`, an entry in
// `battleSt.battleAllies`, or an entry in `battleSt.encounterMonsters`.
// Mutates `actor` in place. Caller decides death routing based on
// post-state `actor.hp <= 0`.
//
// All deltas are clamped to a non-negative HP floor. Heal deltas (positive
// hp) clamp to `actor.maxHP` or `actor.stats.maxHP` when available so we
// don't over-heal from a stale snapshot.
export function applyDeltaToActor(actor, delta) {
  if (!actor || !delta) return;
  if (typeof delta.hp === 'number' && delta.hp !== 0) {
    const maxHP = (actor.maxHP || (actor.stats && actor.stats.maxHP) || (actor.hp + Math.abs(delta.hp))) | 0;
    const next = Math.max(0, Math.min(maxHP, (actor.hp | 0) + (delta.hp | 0)));
    actor.hp = next;
  }
  if (typeof delta.mp === 'number' && delta.mp !== 0 && typeof actor.mp === 'number') {
    const maxMP = (actor.maxMP || (actor.stats && actor.stats.maxMP) || (actor.mp + Math.abs(delta.mp))) | 0;
    const next = Math.max(0, Math.min(maxMP, (actor.mp | 0) + (delta.mp | 0)));
    actor.mp = next;
  }
  if (delta.status && actor.status) {
    const cur = actor.status.mask | 0;
    const add = (delta.status.add | 0);
    const remove = (delta.status.remove | 0);
    actor.status.mask = (cur | add) & ~remove;
    if (typeof delta.poisonDmgTick === 'number') {
      actor.status.poisonDmgTick = delta.poisonDmgTick | 0;
    }
  }
}

// Convenience — apply every delta in a packet to a per-userId pool of
// actors. `actorLookup` is a function `(actorRef) → actor | null` provided
// by the caller (production: closes over `battleSt` + `ps`; sim: closes
// over a Phone snapshot).
export function applyPacketDeltas(packet, actorLookup) {
  if (!packet || !Array.isArray(packet.deltas)) return;
  for (const d of packet.deltas) {
    const actor = actorLookup(d.target);
    if (actor) applyDeltaToActor(actor, d);
  }
}

// ── Spell packet builder (Phase 3) ────────────────────────────────────────
//
// Host runs `applySpell` locally and the per-target outcomes are then
// shipped to guests as deltas. This unifies every spell kind in
// `src/data/spells.js`: damage (Fire, Bolt, Bahamur), heal (Cure, Curaga),
// status-inflict (Sleep, Stop), cure-status (Poisona, Esuna), drain
// (Drain), revive (Raise), instakill (Death, Warp), erase, sight, recovery.
//
// `input` shape:
//   {
//     actor:   <ActorRef>,
//     spellId: <int>,
//     results: [<TargetResult>, ...],   // one per logical target
//   }
//
// `<TargetResult>` shape (only fields needed for this target's outcome
// need to be set; the builder skips no-op fields):
//   {
//     target:        <ActorRef>,
//     dmg?:          <int>,             // positive damage value
//     heal?:         <int>,              // positive heal value
//     miss?:         <bool>,             // host's hit-check missed
//     statusAdd?:    <int>,              // STATUS bitmask to OR in
//     statusRemove?: <int>,              // STATUS bitmask to clear
//     death?:        <bool>,             // host computed target.hp <= 0
//   }
//
// Multi-target spells (Curaja, Aeroga, etc.) pack N TargetResults into
// one packet — guests apply all in one frame and animate each impact
// from the matching fx cue. Single-target spells just pass `results`
// with one entry.
//
// Production wiring (Phase 3.5 cut-over): host's `applySpell` callsite
// (in `spell-cast.js` for player casts, `battle-ally.js` for ally casts,
// `pvp.js` for pvp-enemy casts under co-op pvp eventually) wraps its
// per-target outcomes into TargetResult shape and passes to
// `coop-resolver.js#resolveSpellCast`.
export function buildMagicPacket({ actor, spellId, results }) {
  const sid = spellId | 0;
  const resArr = Array.isArray(results) ? results : [];
  const deltas = [];
  const fx = [{ kind: 'magic-cast', caster: actor, spellId: sid }];

  for (const r of resArr) {
    if (!r || !r.target) continue;
    const target = r.target;

    // Build the delta. Omit if there's no state change (pure miss).
    const delta = { target };
    let hasChange = false;
    if (!r.miss) {
      if (typeof r.dmg === 'number' && r.dmg > 0) {
        delta.hp = -(r.dmg | 0);
        hasChange = true;
      } else if (typeof r.heal === 'number' && r.heal > 0) {
        delta.hp = r.heal | 0;
        hasChange = true;
      }
      const add = (r.statusAdd | 0) >>> 0;
      const rem = (r.statusRemove | 0) >>> 0;
      if (add || rem) {
        delta.status = { add, remove: rem };
        hasChange = true;
      }
      if (r.death) {
        delta.death = true;
        hasChange = true;
      }
    }
    if (hasChange) deltas.push(delta);

    // FX cues per target — impact + damage/heal/miss number.
    fx.push({ kind: 'magic-impact', target, spellId: sid, miss: !!r.miss });
    if (r.miss) {
      fx.push({ kind: 'damage-num', target, value: 0, variant: 'miss' });
    } else if (typeof r.dmg === 'number' && r.dmg > 0) {
      fx.push({ kind: 'damage-num', target, value: r.dmg | 0, variant: 'dmg' });
    } else if (typeof r.heal === 'number' && r.heal > 0) {
      fx.push({ kind: 'damage-num', target, value: r.heal | 0, variant: 'heal' });
    }
    if (r.death) {
      fx.push({ kind: 'death', target });
    }
  }

  return {
    actor,
    action: {
      kind:    'magic',
      spellId: sid,
      targets: resArr.map(r => r && r.target).filter(Boolean),
    },
    deltas,
    fx,
    meta: { encounterEnd: false },
  };
}

// ── Item-use packet builder (Phase 4) ─────────────────────────────────────
//
// Battle item use — Potion / Hi-Potion / Elixir / Antidote / Eye Drops /
// Phoenix Down / Cabin / battle-thrown weapons. Same TargetResult shape
// as magic; the only structural difference is `action.kind = 'item'` and
// the action carries `itemId` instead of `spellId`. Items don't roll RNG
// for power (item.power is a flat value), so `miss` is always false for
// healing/cure items — but we keep the field for parity with magic and
// in case future items add a roll (e.g., "30% chance to also stun").
export function buildItemUsePacket({ actor, itemId, results }) {
  const iid = itemId | 0;
  const resArr = Array.isArray(results) ? results : [];
  const deltas = [];
  // No cast-windup cue for items (item-use anim is a quick consume).
  // Live FSM will render the item-use anim from the action kind itself.
  const fx = [{ kind: 'item-use', user: actor, itemId: iid }];

  for (const r of resArr) {
    if (!r || !r.target) continue;
    const target = r.target;
    const delta = { target };
    let hasChange = false;
    if (!r.miss) {
      if (typeof r.dmg === 'number' && r.dmg > 0) {
        delta.hp = -(r.dmg | 0);
        hasChange = true;
      } else if (typeof r.heal === 'number' && r.heal > 0) {
        delta.hp = r.heal | 0;
        hasChange = true;
      }
      const add = (r.statusAdd | 0) >>> 0;
      const rem = (r.statusRemove | 0) >>> 0;
      if (add || rem) {
        delta.status = { add, remove: rem };
        hasChange = true;
      }
      if (r.death) {
        delta.death = true;
        hasChange = true;
      }
    }
    if (hasChange) deltas.push(delta);

    fx.push({ kind: 'item-impact', target, itemId: iid, miss: !!r.miss });
    if (r.miss) {
      fx.push({ kind: 'damage-num', target, value: 0, variant: 'miss' });
    } else if (typeof r.dmg === 'number' && r.dmg > 0) {
      fx.push({ kind: 'damage-num', target, value: r.dmg | 0, variant: 'dmg' });
    } else if (typeof r.heal === 'number' && r.heal > 0) {
      fx.push({ kind: 'damage-num', target, value: r.heal | 0, variant: 'heal' });
    }
    if (r.death) {
      fx.push({ kind: 'death', target });
    }
  }

  return {
    actor,
    action: {
      kind:    'item',
      itemId:  iid,
      targets: resArr.map(r => r && r.target).filter(Boolean),
    },
    deltas,
    fx,
    meta: { encounterEnd: false },
  };
}

// ── End-of-round poison tick (Phase 4) ────────────────────────────────────
//
// Host's `_applyEndOfRoundPoison` runs once per round and accumulates
// damage on every poisoned actor. Player + allies clamp to HP=1 (NES
// rule — poison never kills from full); monsters can die. Host applies
// the rule locally, so the delta carries the already-clamped value —
// guests don't need to know the clamp rule.
//
// `results` shape: array of `{ target, dmg, death }` — one entry per
// actor that ticked. Caller (`coop-resolver.js`) filters out the
// non-poisoned ones; this builder packages whatever it's given.
//
// Why a separate action kind: animation is different from spell/item
// (consolidated end-of-round damage-num pop, no impact burst), so the
// guest FSM dispatches on `action.kind === 'poison-tick'` to drive its
// `poison-end-tick` battleState.
export function buildPoisonTickPacket({ results }) {
  const resArr = Array.isArray(results) ? results : [];
  const deltas = [];
  const fx = [{ kind: 'poison-tick-start' }];

  for (const r of resArr) {
    if (!r || !r.target) continue;
    if (!(typeof r.dmg === 'number' && r.dmg > 0)) continue;
    const delta = { target: r.target, hp: -(r.dmg | 0) };
    if (r.death) delta.death = true;
    deltas.push(delta);
    fx.push({ kind: 'damage-num', target: r.target,
              value: r.dmg | 0, variant: 'dmg' });
    if (r.death) fx.push({ kind: 'death', target: r.target });
  }

  return {
    actor:  { kind: 'system' },
    action: { kind: 'poison-tick' },
    deltas,
    fx,
    meta: { encounterEnd: false },
  };
}

// ── Encounter snapshot for mid-battle joiners (Phase 5) ───────────────────
//
// Joiner picked Assist on a roster target who's in an encounter. Host
// auto-accepts and ships their CURRENT battle state to the joiner so
// the joiner spawns their local FSM mid-fight with matching HP/status/
// turn position. From this point forward the joiner receives normal
// `encounter-resolution` packets and applies them like any other guest.
//
// Crucial design point: combatants ship REALIZED STATS rather than
// profile fields. Pre-host-arb the snapshot shipped profile-like fields
// and the joiner ran `generateAllyStats(profile)` to derive `atk/def/agi`;
// this produced different values than the host's `recalcStats` because
// `generateAllyStats` ignores `strBonus/vitBonus` from gear. Two stat
// computation paths → silent HP-damage drift over time. Under host-arb
// the joiner never recomputes — host's authoritative values ride the
// wire and the joiner consumes them directly.
//
// `input` shape (host-side):
//   {
//     hostUserId: <int>,
//     turnIdx:    <int>,              // host's current resolution counter
//     battleState: <string>,           // FSM state to seed joiner with
//     monsters: [
//       { monsterId, hp, maxHP, status: { mask, poisonDmgTick } }
//     ],
//     combatants: [
//       // Excludes the joiner; includes host + every existing peer
//       {
//         userId, name,
//         hp, mp, maxHP, maxMP,
//         jobIdx, level, palIdx,
//         atk, def, agi, evade, mdef, hitRate, shieldEvade,
//         weaponR, weaponL, armorId, helmId, shieldId,
//         knownSpells, jobLevel,
//         status: { mask, poisonDmgTick },
//       }
//     ],
//   }
//
// Wire shape (after server forwards to joiner — server prepends
// `hostUserId` from the sender; see `ws-presence.js#encounter-snapshot`):
//   { type: 'encounter-snapshot', hostUserId, turnIdx, battleState,
//     monsters, combatants }
//
// The builder is a pass-through over the input — its job is to enforce
// the schema (drop unknown fields, ensure numbers are integers, etc.).
export function buildEncounterSnapshot(input) {
  if (!input) return null;
  const monsters = Array.isArray(input.monsters) ? input.monsters.map(m => ({
    monsterId: m.monsterId | 0,
    hp:        m.hp | 0,
    maxHP:     m.maxHP | 0,
    status: {
      mask:          (m.status && m.status.mask) | 0,
      poisonDmgTick: (m.status && m.status.poisonDmgTick) | 0,
    },
  })) : [];
  const combatants = Array.isArray(input.combatants) ? input.combatants.map(c => ({
    userId:      c.userId | 0,
    name:        String(c.name || ''),
    hp:          c.hp | 0,
    mp:          c.mp | 0,
    maxHP:       c.maxHP | 0,
    maxMP:       c.maxMP | 0,
    jobIdx:      c.jobIdx | 0,
    level:       (c.level | 0) || 1,
    palIdx:      c.palIdx | 0,
    atk:         c.atk | 0,
    def:         c.def | 0,
    agi:         (c.agi | 0) || 1,
    evade:       c.evade | 0,
    mdef:        c.mdef | 0,
    hitRate:     (c.hitRate | 0) || 80,
    shieldEvade: c.shieldEvade | 0,
    weaponR:     c.weaponR ?? null,
    weaponL:     c.weaponL ?? null,
    armorId:     c.armorId ?? null,
    helmId:      c.helmId ?? null,
    shieldId:    c.shieldId ?? null,
    knownSpells: Array.isArray(c.knownSpells) ? c.knownSpells.slice() : [],
    jobLevel:    (c.jobLevel | 0) || 1,
    status: {
      mask:          (c.status && c.status.mask) | 0,
      poisonDmgTick: (c.status && c.status.poisonDmgTick) | 0,
    },
  })) : [];
  return {
    hostUserId:  input.hostUserId | 0,
    turnIdx:     input.turnIdx | 0,
    battleState: String(input.battleState || 'menu-open'),
    monsters,
    combatants,
  };
}

// Apply an `encounter-snapshot` payload to a joiner's local state. The
// `target` object is the joiner's own state container with the fields
// the production applier writes to (battleSt-shape on production;
// Phone-shape in the sim).
//
// `target` shape (callsite-supplied; mutate-in-place):
//   {
//     battleAllies: [],   // will be populated from combatants (excluding self)
//     monsters:     [],   // will be populated from snapshot monsters
//     battleState:  string,
//     encounterHostUserId: int,
//     turnIdx:      int,  // sets `_lastAppliedTurnIdx` on production applier
//   }
//
// `selfUserId` — the joiner's own userId. Combatants matching this id
// are excluded from `battleAllies` (joiner's `ps` represents self).
//
// Mutates `target` in place. Returns `target` for chaining.
export function applyEncounterSnapshot(snapshot, target, selfUserId) {
  if (!snapshot || !target) return target;
  const myUid = selfUserId | 0;

  target.battleState = snapshot.battleState;
  target.encounterHostUserId = snapshot.hostUserId | 0;
  target.turnIdx = snapshot.turnIdx | 0;

  // Monsters — replace wholesale (snapshot is authoritative for mid-fight
  // state including current HP + poison ticks).
  target.monsters = snapshot.monsters.map(m => ({
    monsterId: m.monsterId | 0,
    hp:        m.hp | 0,
    maxHP:     m.maxHP | 0,
    status: {
      mask:          (m.status && m.status.mask) | 0,
      poisonDmgTick: (m.status && m.status.poisonDmgTick) | 0,
    },
  }));

  // Combatants — populate battleAllies from non-self entries. Each ally
  // carries realized stats so the joiner never re-runs generateAllyStats.
  target.battleAllies = [];
  for (const c of snapshot.combatants) {
    const uid = c.userId | 0;
    if (uid === myUid) continue;
    target.battleAllies.push({
      userId:      uid,
      name:        c.name,
      hp:          c.hp | 0,
      mp:          c.mp | 0,
      maxHP:       c.maxHP | 0,
      maxMP:       c.maxMP | 0,
      jobIdx:      c.jobIdx | 0,
      level:       c.level | 0,
      palIdx:      c.palIdx | 0,
      atk:         c.atk | 0,
      def:         c.def | 0,
      agi:         c.agi | 0,
      evade:       c.evade | 0,
      mdef:        c.mdef | 0,
      hitRate:     c.hitRate | 0,
      shieldEvade: c.shieldEvade | 0,
      weaponR:     c.weaponR ?? null,
      weaponL:     c.weaponL ?? null,
      armorId:     c.armorId ?? null,
      helmId:      c.helmId ?? null,
      shieldId:    c.shieldId ?? null,
      knownSpells: Array.isArray(c.knownSpells) ? c.knownSpells.slice() : [],
      jobLevel:    c.jobLevel | 0,
      status: {
        mask:          (c.status && c.status.mask) | 0,
        poisonDmgTick: (c.status && c.status.poisonDmgTick) | 0,
      },
      isWireDriven: true,
    });
  }

  return target;
}

// ── Encounter-end signal (Phase 4) ────────────────────────────────────────
//
// Host detected end-of-battle (all monsters dead → victory; all players
// dead → defeat; player picked run + succeeded → fled). Emit a
// resolution packet whose `meta.encounterEnd: true` tells guests to
// transition to `encounter-box-close` and run the appropriate
// post-battle flow. Deltas may be empty (if all needed state changes
// already shipped in the resolution that caused the end) or carry the
// killing blow that triggered the transition.
//
// `outcome`: 'victory' | 'defeat' | 'fled' — guest FSM picks the
// post-battle path from this. Defaults to 'victory' if omitted.
export function buildEncounterEndPacket({ outcome = 'victory', deltas = [], fx = [] } = {}) {
  return {
    actor:  { kind: 'system' },
    action: { kind: 'encounter-end', outcome },
    deltas: Array.isArray(deltas) ? deltas : [],
    fx:     Array.isArray(fx)     ? fx     : [],
    meta:   { encounterEnd: true, outcome },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// ViewEvent builders (P1+, docs/COOP-VIEWER-PLAN.md)
//
// ViewEvents are self-contained packets the guest's `coop-viewer.js`
// consumes as a pure animation player. Each event carries:
//
//   - `eventKind`       — discriminator for the viewer's anim registry
//   - `turnIdx`         — monotonic per encounter; viewer enforces order
//   - `animMs`          — host's animation duration in ms (viewer scales)
//   - `finalState`      — authoritative actor/monster state AFTER anim
//   - kind-specific    — actor, target(s), hits, dmg, etc.
//
// Builders are pure (no singleton coupling) so they're called identically
// by `coop-resolver.js` (host) and by `tools/coop-viewer-sim.js` (test).
//
// The `finalState` field is the load-bearing piece — it's what lets a
// guest reconcile state on every event. Lost packets are recoverable;
// receiving any event with finalState restores correct HP/status without
// replay. This is the card-game property: every move is self-describing.
//
// During the P1–P8 ramp, ViewEvent packets ride alongside the legacy
// host-arb encounter-resolution shape. They're built but not consumed
// until P3 lands `src/coop-viewer.js` and P4 wires it into the main loop.

// Animation duration constants — match the on-host FSM timing so the
// viewer's anim wall-clock stays loosely synced with host. Centralized
// here so both sides read the same numbers. If host timings drift these
// must be updated together.
export const VIEW_ANIM_MS = {
  attack:         600,   // slash + damage-num bounce
  magic:          1400,  // cast windup + throw + impact + damage-show
  item:           900,   // sparkle + effect + damage-num
  'monster-attack': 700, // monster step-fwd + shake + damage-num
  'poison-tick':  500,   // green flash per affected
  'monster-death': 800,  // dissolve sequence
  'player-death':  600,  // portrait fade
  'turn-begin':   100,   // cosmetic name flash
  'encounter-start': 1200, // flash-strobe + reveal
  'encounter-end':  2000,  // victory fanfare / defeat fade
};

// Build a ViewEvent's `finalState` block from a list of affected actors
// and monsters. Each entry must carry `ref` (ActorRef) + current `hp` +
// `statusMask` + `alive` flag. This is the authoritative snapshot the
// viewer writes after the anim completes.
//
// Callers populate this from their POST-resolve singleton state — by the
// time the resolver fires, the host has already mutated HP/status, so
// we just read it back.
export function buildFinalState({ actors = [], monsters = [] } = {}) {
  return {
    actors:   Array.isArray(actors)   ? actors   : [],
    monsters: Array.isArray(monsters) ? monsters : [],
  };
}

// AttackEvent — physical multi-hit, all hands. Wraps `buildPhysicalAttackPacket`
// with the additional ViewEvent fields. `hits` shape unchanged from the
// host-arb packet.
export function buildAttackViewEvent({ actor, target, hits, weaponId, hand, killsTarget = false, finalState = null }) {
  return {
    eventKind: 'attack',
    actor,
    target,
    hits: Array.isArray(hits) ? hits : [],
    weaponId:    weaponId | 0,
    hand:        hand || 'R',
    killsTarget: !!killsTarget,
    animMs:      VIEW_ANIM_MS.attack,
    finalState:  finalState || buildFinalState(),
  };
}

// MagicEvent — full cast → impact → damage sequence for one spell.
// `targets` is an array of { ref, result, dmg?, heal?, statusAdded?,
// statusRemoved?, revives?, kills? }. Single packet covers AOE.
export function buildMagicViewEvent({ actor, spellId, targets, isItemUse = false, finalState = null }) {
  return {
    eventKind:  'magic',
    actor,
    spellId:    spellId | 0,
    targets:    Array.isArray(targets) ? targets : [],
    isItemUse:  !!isItemUse,
    animMs:     VIEW_ANIM_MS.magic,
    finalState: finalState || buildFinalState(),
  };
}

// ItemEvent — item use on a target. Item-only path (potion / antidote /
// elixir / phoenix down). Spell-scroll items route through the magic
// pipeline above; this is for non-spell consumables.
export function buildItemViewEvent({ actor, itemId, target, dmg, heal, revives, statusRemoved, finalState = null }) {
  return {
    eventKind:     'item',
    actor,
    itemId:        itemId | 0,
    target,
    dmg:           dmg  | 0,
    heal:          heal | 0,
    revives:       !!revives,
    statusRemoved: statusRemoved | 0,
    animMs:        VIEW_ANIM_MS.item,
    finalState:    finalState || buildFinalState(),
  };
}

// MonsterAttackEvent — monster swings at a player/ally.
export function buildMonsterAttackViewEvent({ monsterIdx, target, dmg, miss = false, statusAdded = 0, killsTarget = false, finalState = null }) {
  return {
    eventKind:    'monster-attack',
    monsterIdx:   monsterIdx | 0,
    target,
    dmg:          dmg | 0,
    miss:         !!miss,
    statusAdded:  statusAdded | 0,
    killsTarget:  !!killsTarget,
    animMs:       VIEW_ANIM_MS['monster-attack'],
    finalState:   finalState || buildFinalState(),
  };
}

// PoisonTickEvent — end-of-round batch. Per-actor dmg + kill flag.
// `ticks` shape: [{ ref, dmg, kills }, ...].
export function buildPoisonTickViewEvent({ ticks, finalState = null }) {
  return {
    eventKind:  'poison-tick',
    ticks:      Array.isArray(ticks) ? ticks : [],
    animMs:     VIEW_ANIM_MS['poison-tick'],
    finalState: finalState || buildFinalState(),
  };
}

// MonsterDeathEvent — dissolve animation trigger. Usually emitted
// immediately after the killing attack/magic event so the viewer chains
// them. Could be folded into the killing event's `killsTarget=true`
// flag, but a dedicated event simplifies the anim registry.
export function buildMonsterDeathViewEvent({ monsterIdx, finalState = null }) {
  return {
    eventKind:  'monster-death',
    monsterIdx: monsterIdx | 0,
    animMs:     VIEW_ANIM_MS['monster-death'],
    finalState: finalState || buildFinalState(),
  };
}

// EncounterStartViewEvent — replaces the guest's local "spawn from
// invite" path. Host emits this when their FSM enters flash-strobe.
// Carries realized stats for every combatant so the guest never runs
// generateAllyStats. `myUserId` is per-recipient (server stamps it).
export function buildEncounterStartViewEvent({ monsters, combatants, hostUserId, midBattle = false, finalState = null }) {
  return {
    eventKind:  'encounter-start',
    monsters:   Array.isArray(monsters)   ? monsters   : [],
    combatants: Array.isArray(combatants) ? combatants : [],
    hostUserId: hostUserId | 0,
    midBattle:  !!midBattle,
    animMs:     midBattle ? 0 : VIEW_ANIM_MS['encounter-start'],
    finalState: finalState || buildFinalState(),
  };
}

// EncounterEndViewEvent — victory / defeat / fled with rewards baked in.
// `rewards` is { exp, gil, drops: [{itemId, qty}, ...] }; omitted on
// defeat / fled.
export function buildEncounterEndViewEvent({ outcome = 'victory', rewards = null, finalState = null }) {
  return {
    eventKind:  'encounter-end',
    outcome:    outcome || 'victory',
    rewards:    rewards || null,
    animMs:     VIEW_ANIM_MS['encounter-end'],
    finalState: finalState || buildFinalState(),
  };
}

// TurnBeginViewEvent — optional cosmetic. Names the active actor for a
// brief flash on screen + (when actor is `myUserId`) signals the viewer
// to surface the menu. Host emits before resolving each turn.
export function buildTurnBeginViewEvent({ actor, prompt = false, finalState = null }) {
  return {
    eventKind:  'turn-begin',
    actor,
    prompt:     !!prompt,        // true → guest should show input menu
    animMs:     VIEW_ANIM_MS['turn-begin'],
    finalState: finalState || buildFinalState(),
  };
}

// PlayerDeathViewEvent — covers both `ps` and ally deaths so the viewer
// can fold the portrait to a black-fade. Host emits when the killing
// blow's `killsTarget` is set; could be derived from the attack/magic
// event's `finalState`, but a dedicated event keeps the anim registry
// uniform.
export function buildPlayerDeathViewEvent({ target, finalState = null }) {
  return {
    eventKind:  'player-death',
    target,
    animMs:     VIEW_ANIM_MS['player-death'],
    finalState: finalState || buildFinalState(),
  };
}

// ── Wire envelope for ViewEvent packets ───────────────────────────────────
//
// Wraps a ViewEvent in the same outer shape as host-arb's
// `encounter-resolution` so the existing wire path carries them with no
// server changes. `turnIdx` is the monotonic counter from the resolver.
// Guest applies these via `coop-viewer.js` (P3+) under
// `COOP_VIEWER_MODE`; under flag-off the field is set but never read.
export function wrapViewEventForWire(viewEvent, turnIdx) {
  return {
    turnIdx:   turnIdx | 0,
    actor:     viewEvent.actor || null,
    action:    { kind: viewEvent.eventKind },
    // Legacy shape passthrough for backwards-compat clients (Phase 6.9
    // applier ignores these in flag-on/viewer-mode; host-arb-only
    // clients still consume them as if the rewrite hadn't happened).
    deltas:    [],
    fx:        [],
    meta:      { encounterEnd: viewEvent.eventKind === 'encounter-end',
                 outcome:      viewEvent.outcome || null },
    // ViewEvent payload — guest's coop-viewer reads only this block.
    viewEvent,
  };
}
