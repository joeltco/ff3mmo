// THE CHAMBER CATALOGUE — what a room can BE, as data.
//
// A hand-maintained leaf: **imports nothing**, so the generator, the tools and
// the gates can all read it without an import cycle. Same rule as
// `data/dungeons.js`, for the same reason.
//
// ⛔ WHY THIS EXISTS. A chamber used to be an `if` branch. `floorIndex === 1`
// carved the trap room, `floorIndex === 2` carved the boulder room, floor 3 owned
// the only pond and the only branch alcove, and floor 0 owned the only secret.
// v1.10.96 renamed those conditions from a floor index to a layout name, which
// is better plumbing for the same structure: every interesting chamber still
// belonged to exactly one place and appeared there every single time.
//
// Joel, 2026-08-20: *"we gotta treat this like a real dungeon generator, and not
// a same floor cloner... i want this to be a roguelike."* The missing piece was
// never more chamber shapes — it was **the pool**. A floor should ROLL its rooms
// from a weighted set under constraints, not have them written into a branch.
//
// ⛔ A CHAMBER IS A SLOT FILLER, NOT A FLOOR. The layout still decides the
// floor's skeleton — how many rooms, where they sit, what joins them. The
// catalogue decides WHAT EACH ROOM IS. Keeping those separate is what lets a
// pond appear on a floor that has never had one without moving a single wall.

/** Where in a floor's skeleton a chamber can sit. */
export const SLOTS = {
  ENTRANCE: 'entrance',   // where the player arrives — never rolled, never hostile
  MID:      'mid',        // the room between the entrance and the floor's feature
  SIDE:     'side',       // a room hanging off the main run (the spine's wings)
  BIG:      'big',        // the floor's large feature room
  EXIT:     'exit',       // the room holding the way onward
};

/**
 * One chamber type.
 *
 * `weight`      relative odds within its slot. 0 means "never rolled" — a fixed
 *               chamber that the layout places directly (entrance, exit, big).
 * `minDepth`    earliest floor index it may appear on. Depth 0 is the entry floor.
 * `maxPerFloor` how many of this type one floor may hold.
 * `requires`    dungeon capabilities that must be present (see `dungeonCaps`).
 * `feature`     what the generator DOES to the room once carved. `null` = a plain
 *               room. Every feature id must have a case in `applyChamberFeature`;
 *               `check-chambers` fails the build on one that does not.
 */
export const CHAMBERS = [
  // ── Fixed structure. Weight 0: the layout places these, they are never rolled.
  { id: 'entrance', slot: SLOTS.ENTRANCE, role: 'entrance', weight: 0, feature: null,
    note: 'the arrival room — kept plain on purpose, nothing hostile where you land' },
  { id: 'exit',     slot: SLOTS.EXIT,     role: 'exit',     weight: 0, feature: null,
    note: 'holds the way onward' },
  { id: 'trap-hall',    slot: SLOTS.BIG, role: 'trap',   weight: 0, feature: 'traps',
    note: 'the 7x7 whose trap holes ARE the descent — Altar Cave floor 1' },
  { id: 'boulder-hall', slot: SLOTS.BIG, role: 'puzzle', weight: 0, feature: null,
    note: 'the hall holding the boulder that opens the false wall' },
  { id: 'sealed-hoard', slot: SLOTS.BIG, role: 'treasure', weight: 0, feature: 'hoard',
    note: 'the chamber behind a boulder-opened wall. ⛔ A BOULDER PUZZLE OPENS '
        + 'TREASURE, NEVER AN EXIT (Joel, 2026-08-27) — so nothing the player '
        + 'needs to finish the dungeon may ever be placed in here. That is what '
        + 'makes the puzzle optional and the reward worth solving it for.' },

  // ── Rolled. This is the catalogue proper.
  { id: 'junction', slot: SLOTS.MID, role: 'junction', weight: 10, minDepth: 0,
    maxPerFloor: 2, feature: null,
    note: 'a plain room. The baseline, and deliberately the commonest.' },

  { id: 'bone-pit', slot: SLOTS.MID, role: 'bones', weight: 5, minDepth: 0,
    maxPerFloor: 1, feature: 'bones',
    note: 'a room thick with bones. Pure dressing — the encounter rate is per floor.' },

  { id: 'vault', slot: SLOTS.MID, role: 'vault', weight: 4, minDepth: 1,
    maxPerFloor: 1, feature: 'vault',
    note: 'extra chests in the corners. Held off depth 0 so the first room of a '
        + 'dungeon is never the richest one.' },

  // ⛔ NO `rubble` CHAMBER. Fallen rock inside a room was drafted, built and
  // REMOVED in v1.10.99 — the cave tileset cannot express it. Scanning ROM maps
  // 111/112/113/22/115 for any tile the cartridge surrounds with floor on three
  // or more sides returns exactly ONE across all five maps, a lone trap hole.
  // `tools/tile-grammar.mjs` says the same thing from the other direction: rock
  // hangs BELOW a ceiling lip, so `FLOOR over ROCK` and `ROCK over CEIL` are
  // arrangements the cartridge never uses, and the rubble field produced 48 and
  // 12 of them. Requiring open floor above each block (to protect the two-deep
  // wall rule) is what forced the illegal pair — the two constraints cannot both
  // be satisfied, because an isolated obstacle is not in this tileset's grammar.
  //
  // Do not re-add it with a different tile without ROM evidence that the
  // cartridge draws a standalone obstacle in a room. It does not.

  { id: 'spring', slot: SLOTS.MID, role: 'pond', weight: 4, minDepth: 1,
    maxPerFloor: 1, requires: ['water'], feature: 'pond',
    note: 'a pool that restores HP/MP. `placePond` has existed and been switched '
        + 'off since the generator was written — every FLOOR_CONFIG said ponds: 0.' },

  // ── The spine's wings. Same catalogue, narrower slot.
  { id: 'side-plain', slot: SLOTS.SIDE, role: 'side', weight: 10, minDepth: 0,
    maxPerFloor: 4, feature: null, note: 'a plain wing room' },
  { id: 'side-bones', slot: SLOTS.SIDE, role: 'side-bones', weight: 5, minDepth: 0,
    maxPerFloor: 2, feature: 'bones', note: 'a wing thick with bones' },
  { id: 'side-vault', slot: SLOTS.SIDE, role: 'side-vault', weight: 4, minDepth: 1,
    maxPerFloor: 1, feature: 'vault', note: 'a wing worth the detour' },
];

const BY_ID = new Map(CHAMBERS.map((c) => [c.id, c]));

/** A chamber entry by id, or null. */
export function chamberById(id) { return BY_ID.get(id) || null; }

/** Every chamber that can be ROLLED into a slot (weight > 0). */
export function rollableFor(slot) { return CHAMBERS.filter((c) => c.slot === slot && c.weight > 0); }

/**
 * What a dungeon can support.
 *
 * ⛔ A CAPABILITY IS NOT A PREFERENCE. `water` is here because the pond tiles
 * ($04 / $08) must exist in that dungeon's tileset — a spring in a cave whose
 * donor map has no water metatile draws as garbage. Weighting lives in
 * `layout.chambers` on the dungeon row; this is about what is POSSIBLE.
 */
export function dungeonCaps(dungeon) {
  const c = (dungeon && dungeon.layout && dungeon.layout.caps) || null;
  return new Set(Array.isArray(c) ? c : []);
}

/** Per-dungeon weight multipliers, so two caves can favour different rooms. */
function weightFor(dungeon, entry) {
  const w = (dungeon && dungeon.layout && dungeon.layout.chambers) || null;
  const mult = (w && w[entry.id] != null) ? w[entry.id] : 1;
  return Math.max(0, Math.round(entry.weight * mult));
}

/**
 * Roll the chambers for one floor.
 *
 * ⛔ ONE `rng()` CALL PER SLOT, and slots are filled in the order given. The
 * generator's rng stream is a contract (see `dungeon/plan.js`); a planner that
 * draws a variable number of times would make a floor's shape depend on which
 * rooms it rolled, which is how a "cosmetic" catalogue change silently re-rolls
 * every corridor below it.
 *
 * @param {object} dungeon    the registry row
 * @param {number} depth      floor index
 * @param {string[]} slots    slot names to fill, in order
 * @param {function} rng      the floor's seeded rng
 * @returns {object[]} one chamber entry per slot, never null
 */
export function rollChambers(dungeon, depth, slots, rng) {
  const caps = dungeonCaps(dungeon);
  const taken = new Map();     // id -> count already placed on this floor
  const out = [];
  for (const slot of slots) {
    const pool = rollableFor(slot).filter((c) => {
      if (depth < (c.minDepth ?? 0)) return false;
      if (c.maxDepth != null && depth > c.maxDepth) return false;
      if ((taken.get(c.id) || 0) >= (c.maxPerFloor ?? 1)) return false;
      for (const need of c.requires || []) if (!caps.has(need)) return false;
      return true;
    });
    const weights = pool.map((c) => weightFor(dungeon, c));
    const total = weights.reduce((a, b) => a + b, 0);
    // ⛔ THE DRAW HAPPENS EVEN WHEN THE POOL IS EMPTY OR SINGULAR. Skipping it
    // when there is nothing to choose would make the number of rng calls depend
    // on the catalogue's contents, and every floor below would shift the day a
    // chamber's minDepth changed.
    const r = rng();
    if (total <= 0) { out.push(chamberById('junction')); continue; }
    let acc = 0, chosen = pool[pool.length - 1];
    const target = r * total;
    for (let i = 0; i < pool.length; i++) { acc += weights[i]; if (target < acc) { chosen = pool[i]; break; } }
    taken.set(chosen.id, (taken.get(chosen.id) || 0) + 1);
    out.push(chosen);
  }
  return out;
}
