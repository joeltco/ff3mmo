// combatant-ai.js — shared decision logic for AI-controlled combatants
// (today: roster allies on the player team, fake PvP-enemies). Pure pick +
// roll functions: take a `team` / `enemies` array of opaque entries from the
// caller, return the chosen entry (or null) along with the rolled amount /
// spell ID. The caller decides WHERE in state to write the result, since
// ally and PvP-enemy keep parallel state bags (battleSt.allyMagic* vs
// pvpSt.pvpMagic*) until step 5 unifies them.
//
// Why this module exists: pre-v1.7.360, `_tryAllyCure` /  `_tryAllyPoisona`
// / `_tryAllyOffensiveCast` / `_tryAllyItem` in battle-turn.js were near
// mirror-images of `_tryPVPEnemy*` in pvp.js — same thresholds, same rolls,
// same spell-ID assumptions, but six separate implementations. Drift between
// them was a real risk. This module collapses the decision side into one
// place so both callers share the picks and the math; only the state-bag
// write (and the resulting battleState transition) stays role-specific.
//
// When real multiplayer lands, PvP-opponent decisions arrive as wire
// messages instead of AI picks — the PvP caller stops invoking decideAction
// at that point. Ally AI stays (parties with empty slots backfill from the
// roster pool).

import { rand } from './rng.js';
import { hasStatus, STATUS, canCastMagic } from './status-effects.js';

// Activation thresholds. Pulled out so the rate balance is in one place;
// each was duplicated as a magic number in both _tryAlly* and _tryPVPEnemy*.
export const AI_HEAL_THRESHOLD     = 0.6;   // teammate hp/maxHP below this → Cure
export const AI_POTION_THRESHOLD   = 0.5;   // teammate hp/maxHP below this → Potion
export const AI_OFFENSIVE_GATE     = 0.45;  // chance a mage opens with Fire/Bzzard/Sleep
export const AI_ITEM_GATE          = 0.25;  // chance the actor reaches for an item
export const AI_PVP_DEFEND_GATE    = 0.30;  // PvP-main only: chance to defend
export const AI_PVP_SW_GATE        = 0.15;  // PvP-main only: chance to SouthWind-throw

// Spell IDs the AI picks from. Centralized so adding a new mage spell to the
// roster pool is a one-line change.
export const SPELL_CURE          = 0x34;
export const SPELL_POISONA       = 0x35;
export const OFFENSIVE_SPELLS    = [0x31, 0x32, 0x33];  // Fire, Bzzard, Sleep

// `team` / `enemies` entries are opaque to this module. Callers pass entries
// shaped { ref, hp, maxHP, status?, name? } where `ref` is whatever the caller
// wants to read back (an idx, a cellIdx, a combatant pointer). The decision
// helpers fish on `hp` / `maxHP` / `status` only — they don't dereference ref.

// Silence gate. Returns true if the caster CAN cast right now.
export function canCastBasic(caster, spellId) {
  if (!caster) return false;
  if (!Array.isArray(caster.knownSpells)) return false;
  if (!caster.knownSpells.includes(spellId)) return false;
  if (caster.status && !canCastMagic(caster.status)) return false;
  return true;
}

// Same gate without a specific spell — used for offensive-cast where the
// spell ID is chosen later from the caster's offensive pool.
export function canCastAny(caster) {
  if (!caster) return false;
  if (caster.status && !canCastMagic(caster.status)) return false;
  return true;
}

// Pick the lowest-HP teammate below `threshold`. Returns the team entry or
// null if nobody is hurt enough. Caller decides the threshold (Cure uses 0.6,
// Potion uses 0.5).
export function pickHealTarget(team, threshold = AI_HEAL_THRESHOLD) {
  let best = null;
  for (const t of team) {
    if (!t || !t.maxHP) continue;
    if ((t.hp || 0) <= 0) continue;
    const pct = t.hp / t.maxHP;
    if (pct >= threshold) continue;
    if (!best || pct < best._pct) best = { ...t, _pct: pct };
  }
  return best;
}

// Pick the first poisoned teammate. Caller controls priority by passing the
// team in priority order — `_tryAllyPoisona` walks player → self → others,
// while `_tryPVPEnemyPoisona` walks self → other team members. The helper
// just returns the first match.
export function pickPoisonedTarget(team) {
  for (const t of team) {
    if (!t || (t.hp || 0) <= 0 || !t.status) continue;
    if (hasStatus(t.status, STATUS.POISON)) return t;
  }
  return null;
}

// Pick a random living target from `enemies`. Returns the entry or null.
// v1.7.751 P-5 — `opts.rand` lets the PvP arbiter inject per-battle RNG.
// Defaults to the singleton — existing client callers unchanged.
export function pickRandomLivingTarget(enemies, opts = {}) {
  const rng = opts.rand || rand;
  const living = enemies.filter(e => e && (e.hp || 0) > 0);
  if (living.length === 0) return null;
  return living[Math.floor(rng() * living.length)];
}

// Random offensive spell from the caster's known set, or null if none.
export function pickOffensiveSpell(caster, opts = {}) {
  const rng = opts.rand || rand;
  if (!Array.isArray(caster?.knownSpells)) return null;
  const pool = caster.knownSpells.filter(s => OFFENSIVE_SPELLS.includes(s));
  if (pool.length === 0) return null;
  return pool[Math.floor(rng() * pool.length)];
}

// Damage roll for offensive cast — INT-based, NES FF3 black-magic formula:
//   atk = floor(int/2) + spell.power
//   dmg = atk + rand(0..floor(atk/2))
// Sleep (power=0) returns 0; status spells have no damage roll.
export function rollOffensiveDamage(caster, spell, opts = {}) {
  const rng = opts.rand || rand;
  if (!spell || spell.power <= 0) return 0;
  const stat = (caster && caster.int) || 5;
  const baseAtk = Math.floor(stat / 2) + spell.power;
  return Math.max(1, baseAtk + Math.floor(rng() * (Math.floor(baseAtk / 2) + 1)));
}

// Heal roll for Cure — MND-based, same formula:
//   atk = floor(mnd/2) + 42 (Cure power)
//   heal = atk + rand(0..floor(atk/2))
export function rollCureAmount(caster, opts = {}) {
  const rng = opts.rand || rand;
  const mnd = (caster && caster.mnd) || 5;
  const atk = Math.floor(mnd / 2) + 42;
  return atk + Math.floor(rng() * (Math.floor(atk / 2) + 1));
}

// Activation roll — `rand() < pct`. Wraps the gates so a future "raise
// aggression in low-HP boss fight" tweak lands in one place.
export function rollActivation(pct, opts = {}) {
  const rng = opts.rand || rand;
  return rng() < pct;
}

// v1.7.751 P-5 — pick the lowest-HP alive enemy. Used for "finish the
// wounded one" smart-target heuristic on the PvP arbiter's physical
// attacks. Ties broken by `enemies` array order (stable). Returns null
// if no enemies alive.
export function pickWeakestEnemy(enemies) {
  let best = null;
  for (const e of enemies) {
    if (!e || (e.hp || 0) <= 0) continue;
    if (!best || (e.hp | 0) < (best.hp | 0)) best = e;
  }
  return best;
}
