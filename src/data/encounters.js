// Encounter Catalog — zone-based with NES ROM formations
// AUTO-GENERATED from FF3 NES ROM via tools/gen-encounters-js.js
// Each formation has groups: [{ monsterId, min, max }, ...]
// Formation data from ROM $5C010 (settings), $5C410 (monster lists), $5CA10 (structures)

// Encounter cadence per zone `rate`. Threshold = how many steps until the next
// encounter roll fires; lower = more frequent. Resolved per current zone in
// battle-encounter.js#tickRandomEncounter, so a zone's rate is its rate
// everywhere it's reached. Steps drawn uniformly from [base, base + spread).
export const RATE_STEPS = {
  high:   { base: 10, spread: 10 },  // 10-19 (~14.5) — Ur bee/werewolf patch (2x grass)
  normal: { base: 15, spread: 15 },  // 15-29 (~22)   — Altar Cave floors
  low:    { base: 20, spread: 20 },  // 20-39 (~29.5) — open world-map grass
  fixed:  null,                      // scripted/boss zones — never random-rolled
};

export const ENCOUNTERS = new Map([
  // --- World map: Ur valley (currently reachable area) ---
  // 31 walkable tiles between Altar Cave (95,34) and the temporary choke
  // block (95,45). Goblins only — safe-tier encounters for a starter party.
  // Selected via bounding box check in battle-encounter.js (x=93..96, y=34..44).
  ['grasslands_valley', {
    rate: 'normal',
    formations: [
      [{ id: 0x00, min: 1, max: 3 }], // Goblin x1-3
    ],
  }],
  // --- World map: south of choke (currently unreachable, ready for when the
  // choke at world-map-renderer.js is lifted). Werewolves + Killer Bees are
  // tier-2 — capped at 3 per formation to avoid werewolf*4 wipes (200-run
  // sim showed even an L1 3-party only survives 6.5% vs werewolf*4).
  ['grasslands_wild', {
    rate: 'high',  // 2x — drives the Ur dark-tile patch (bee/werewolf)
    formations: [
      [{ id: 0x04, min: 2, max: 3 }], // Killer Bee x2-3 (statusAtk: poison)
      [{ id: 0x05, min: 2, max: 3 }], // Werewolf x2-3
    ],
  }],
  // --- Altar Cave ---
  ['altar_cave_f1', {
    rate: 'normal',
    formations: [
      [{ id: 0x00, min: 2, max: 4 }], // Goblin x2-4
      [{ id: 0x02, min: 1, max: 2 }, { id: 0x01, min: 1, max: 2 }], // Eye Fang + Carbuncle
    ],
  }],
  ['altar_cave_f2', {
    rate: 'normal',
    formations: [
      [{ id: 0x02, min: 1, max: 2 }, { id: 0x01, min: 1, max: 2 }], // Eye Fang + Carbuncle
      [{ id: 0x03, min: 1, max: 2 }, { id: 0x01, min: 2, max: 4 }], // Blue Wisp + Carbuncle
      [{ id: 0x02, min: 2, max: 2 }, { id: 0x03, min: 1, max: 3 }, { id: 0x01, min: 1, max: 3 }], // Eye Fang + Blue Wisp + Carbuncle
    ],
  }],
  ['altar_cave_f3', {
    rate: 'normal',
    formations: [
      [{ id: 0x03, min: 1, max: 2 }, { id: 0x01, min: 2, max: 4 }], // Blue Wisp + Carbuncle
      [{ id: 0x02, min: 2, max: 2 }, { id: 0x03, min: 1, max: 3 }, { id: 0x01, min: 1, max: 3 }], // Eye Fang + Blue Wisp + Carbuncle
    ],
  }],
  ['altar_cave_f4', {
    rate: 'normal',
    formations: [
      [{ id: 0x03, min: 1, max: 2 }, { id: 0x01, min: 2, max: 4 }], // Blue Wisp + Carbuncle
      [{ id: 0x02, min: 2, max: 2 }, { id: 0x03, min: 1, max: 3 }, { id: 0x01, min: 1, max: 3 }], // Eye Fang + Blue Wisp + Carbuncle
    ],
  }],
  ['altar_cave_boss', {
    rate: 'fixed',
    formations: [
      [{ id: 0xcc, min: 1, max: 1 }], // Land Turtle
    ],
  }],
]);
