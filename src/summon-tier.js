// Resolve which of a summon's three effects fires, from the caster's job.
//
// Kept apart from summon-anim.js on purpose: that module owns the PRESENTATION
// (creature, cast burst, fades) and this one owns the MECHANIC. The capture
// showed Conjurer and Sage loading byte-identical art across varied RNG, so the
// tier changes what the summon DOES, not what it looks like — mixing the two
// would imply a relationship that is not there.

import { SUMMON_TIERS, summonTierForJob } from './data/summon-tiers.js';
import { SPELLS } from './data/spells.js';

export function isTieredSummon(spellId) {
  return spellId != null && SUMMON_TIERS.has(spellId);
}

/**
 * Pick the effect for this cast.
 *
 * The Evoker rolls between effects 1 and 2 — that roll is the whole character
 * of the job, so it is a real roll each cast, not a fixed pick.
 *
 * `rng` is injectable so the battle sim can drive it deterministically.
 */
export function resolveSummonEffect(spellId, jobIdx, rng = Math.random) {
  const entry = SUMMON_TIERS.get(spellId);
  if (!entry) return null;
  const tier = summonTierForJob(jobIdx);
  if (tier === 'summoner') return { ...entry.summoner, tier };
  const pick = entry.evoker[rng() < 0.5 ? 0 : 1];
  return { ...pick, tier };
}

/**
 * The chosen effect as a SPELLS-shaped object, so it can stand in for the base
 * spell everywhere downstream without touching the damage path.
 *
 * Only the fields the effect actually redefines are overridden; everything else
 * falls through to the catalogue entry, so a summon still behaves like a spell
 * in every respect this table says nothing about.
 */
export function summonEffectAsSpell(spellId, effect) {
  const base = SPELLS.get(spellId);
  if (!base || !effect) return base || null;
  const out = { ...base, power: effect.power };
  if (effect.element !== undefined) out.element = effect.element;
  if (effect.kind === 'damage') out.type = 'damage';
  else if (effect.kind === 'instakill') out.type = 'death';
  else if (effect.kind === 'heal') { out.type = 'damage'; out.element = 'recovery'; out.target = 'ally'; }
  else if (effect.kind === 'status' && effect.status) out.type = effect.status;
  if (effect.hit !== undefined) out.hit = effect.hit;
  return out;
}
