// Objective kinds — the registry.
//
// ⛔ A REGISTRY KEYED BY `kind`, NEVER A TERNARY. Adding a kind must not mean
// editing the engine: `advanceObjectives` walks this table and knows nothing
// about what any particular objective is. The old system had exactly one kind
// and expressed it as `if (obj.kind !== 'defeat') continue;` inside the runtime,
// which is why every quest in the game was "win N encounters in zone X" —
// the second kind had nowhere to go.
//
// A kind supplies:
//   count(obj)          how many events satisfy it (default 1)
//   on                  the event name it listens for, or null for talk-only
//   match(obj, payload) does this event count toward this objective?
//
// ⭐ `talk` has no event. An objective with no `on` is satisfied by TALKING to
// the stage's own `at` NPC, which is the common case for a story beat — find
// the person, the beat advances. It needs no counter and no listener.

/**
 * @typedef {{ kind: string }} Objective
 */

const KINDS = new Map();

function define(kind, spec) { KINDS.set(kind, { on: null, count: () => 1, match: () => false, ...spec }); }

// ── defeat: win N encounters whose zone key starts with `zonePrefix` ──────
//
// The zone key comes from `currentEncounterZoneKey()` — `altar_cave_f1`,
// `grasslands_valley`, `seals_cave_boss` — so one prefix covers every floor of
// a dungeon. ⛔ `grasslands` is NOT the same as `grasslands_valley`: the bare
// prefix also matches `grasslands_wild`, which is everything past the radius.
define('defeat', {
  on: 'encounter-victory',
  count: (obj) => obj.count | 0,
  match: (obj, zoneKey) => !!zoneKey && String(zoneKey).startsWith(obj.zonePrefix),
});

// ── boss: a specific boss has been beaten ────────────────────────────────
//
// Distinct from `defeat` with a count of 1: a boss is identified by its monster
// id, not by where it was fought, so this cannot be faked by clearing the
// dungeon's ordinary encounters. Needed by the Cave of Seals — Djinn `0xCD`.
define('boss', {
  on: 'boss-defeated',
  count: () => 1,
  match: (obj, bossId) => (bossId | 0) === (obj.bossId | 0),
});

// ── flag: a story flag is set ────────────────────────────────────────────
//
// For chaining a stage off a world fact rather than off an action — e.g. a beat
// that only opens once the curse is lifted, no matter which quest lifted it.
define('flag', {
  on: 'flag-set',
  count: () => 1,
  match: (obj, flagId) => flagId === obj.flag,
});

// ── talk: satisfied by talking to the stage's own `at` NPC ───────────────
//
// No event and no listener. `advanceObjectives` never sees it; `quests.js`
// treats "no `on`" as "talking is the objective". Declared here anyway so that
// `kind: 'talk'` is a real kind rather than a special case spelled as a missing
// field — a gate can then assert every objective names a DECLARED kind.
define('talk', { on: null, count: () => 1, match: () => false });

/** Is this a declared objective kind? */
export function isObjectiveKind(kind) { return KINDS.has(kind); }

/** Every declared kind, for gates. */
export function objectiveKinds() { return [...KINDS.keys()]; }

/** How many matching events satisfy this objective. */
export function objectiveCount(obj) {
  if (!obj) return 0;
  const k = KINDS.get(obj.kind);
  return k ? Math.max(1, k.count(obj) | 0) : 0;
}

/**
 * Is this objective satisfied by TALKING to the stage's `at` NPC, rather than
 * by an event? True for `talk` and for a stage with no objective at all.
 */
export function isTalkObjective(obj) {
  if (!obj) return true;
  const k = KINDS.get(obj.kind);
  return !k || k.on === null;
}

/** Does `payload` on event `event` count toward `obj`? */
export function objectiveMatches(obj, event, payload) {
  if (!obj) return false;
  const k = KINDS.get(obj.kind);
  if (!k || k.on !== event) return false;
  return !!k.match(obj, payload);
}
