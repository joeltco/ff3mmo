// Encounter Catalog — zone-based with NES ROM formations
// AUTO-GENERATED from FF3 NES ROM via tools/gen-encounters-js.js
// Each formation has groups: [{ monsterId, min, max }, ...]
// Formation data from ROM $5C010 (settings), $5C410 (monster lists), $5CA10 (structures)

export const ENCOUNTERS = new Map([
  // --- World map (grasslands near Ur) ---
  ['grasslands', {
    rate: 'low',
    formations: [
      [{ id: 0x00, min: 2, max: 4 }], // Goblin x2-4
      [{ id: 0x04, min: 2, max: 4 }], // Killer Bee x2-4
      [{ id: 0x05, min: 2, max: 4 }], // Werewolf x2-4
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
