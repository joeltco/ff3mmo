// Dialogue variants — what somebody says depends on the state of the world.
//
// ⛔ IMPORT-FREE LEAF. Gates and tools resolve pages with the very same function
// the game does; a tool with its own copy of the rule keeps agreeing with itself
// after the rule changes. That has happened four times with `calcSpawnY` alone.
//
// ── THE SHAPE ─────────────────────────────────────────────────────────────
//
// A `dialogue` / `answers[term]` value is EITHER the plain form:
//
//     dialogue: ['The curse caught me here.']
//
// or a list of variants, first match wins, the unguarded one last:
//
//     dialogue: [
//       { when: 'curse_lifted', pages: ['The curse let go.', 'I am myself again.'] },
//       { pages: ['The curse caught me here.'] },
//     ]
//
// `when` is a story-flag id from data/flags.js, optionally negated with `!`.
// It is a STRING and not a predicate function on purpose: a string can be
// grepped, listed, and checked against the flag table by a gate, which is how
// `check-quest-stages.mjs` can prove that no line is keyed to a flag nothing
// ever sets. A function would make every one of those questions unanswerable
// without running the game.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// Before this, an NPC's lines were frozen for the life of the save and the ONLY
// way to change what somebody said was to swap the whole person — a second
// TOWN_NPCS row on the same tile with an opposing `when:`. That is why Cid is
// two NPCs standing on one square.
//
// It does not scale: the cursed-town inversion needs 37 people in two towns to
// speak differently once the Djinn is sealed, and the row-swap pattern turns
// those 37 into 74 rows carrying two sprites, two palettes and two placements
// each, when 36 of them are the SAME PERSON in a different mood. Swapping a
// person is the right tool when the SPRITE changes (Cid's ghost really is a
// different face); swapping their lines is the right tool when it does not.

/** Does a variant's `when` hold, given a flag test? */
function _holds(when, hasFlag) {
  if (!when) return true;                       // unguarded — the default
  if (when[0] === '!') return !hasFlag(when.slice(1));
  return !!hasFlag(when);
}

/** Is this value the variant form rather than a plain page list? */
export function isVariantList(value) {
  return Array.isArray(value) && value.length > 0 &&
         value.every((v) => v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.pages));
}

/**
 * The pages to actually show. `hasFlag(id) -> boolean` supplies the world state.
 *
 * Returns null when nothing matches — a variant list whose every entry is
 * guarded and none hold. That is a real authoring mistake (somebody forgot the
 * default), and returning null lets the caller fall through to silence rather
 * than render `undefined`.
 */
export function resolvePages(value, hasFlag) {
  if (!value) return null;
  if (!isVariantList(value)) return value;      // plain array of strings
  for (const v of value) if (_holds(v.when, hasFlag)) return v.pages;
  return null;
}

/**
 * EVERY page set a value can ever produce, for gates that must check all of
 * them — `check-dialogue-fit` has to wrap the widest variant, not whichever one
 * happens to be showing.
 */
export function allPageSets(value) {
  if (!value) return [];
  if (!isVariantList(value)) return [value];
  return value.map((v) => v.pages);
}

/** Every flag id any variant in `value` is keyed to, negation stripped. */
export function variantFlags(value) {
  if (!isVariantList(value)) return [];
  return value.filter((v) => v.when).map((v) => (v.when[0] === '!' ? v.when.slice(1) : v.when));
}

/**
 * Does this value have a reachable default — an unguarded variant?
 *
 * A variant list with no default is silence for every player who has not hit
 * the right flag, which is almost never what was meant.
 */
export function hasDefault(value) {
  if (!isVariantList(value)) return true;
  return value.some((v) => !v.when);
}
