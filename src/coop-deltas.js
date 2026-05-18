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
