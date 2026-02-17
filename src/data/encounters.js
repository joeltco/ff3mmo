// Encounter Catalog — which monsters appear in which areas
//
// Monster IDs reference ROM bestiary (names from text decoder at runtime)
// Formation data from ROM encounter tables (bank 2E)
// Start: Altar Cave + world map near Ur

export const ENCOUNTERS = new Map([
  // --- World map (grasslands near Ur) ---
  ['grasslands', {
    monsters: [0x00],                     // bestiary #$00
    rate: 'low',
    minGroup: 1, maxGroup: 3,
  }],

  // --- Altar Cave ---
  ['altar_cave_f1', {
    monsters: [0x00, 0x01],              // bestiary #$00, #$01
    rate: 'normal',
    minGroup: 1, maxGroup: 3,
  }],
  ['altar_cave_f2', {
    monsters: [0x00, 0x01, 0x02, 0x03], // bestiary #$00-$03
    rate: 'normal',
    minGroup: 1, maxGroup: 4,
  }],
  ['altar_cave_f3', {
    monsters: [0x01, 0x02, 0x03],        // bestiary #$01-$03
    rate: 'normal',
    minGroup: 2, maxGroup: 4,
  }],
  ['altar_cave_f4', {
    monsters: [0x02, 0x03],              // bestiary #$02, #$03
    rate: 'normal',
    minGroup: 2, maxGroup: 4,
  }],
  ['altar_cave_boss', {
    monsters: [0xCC],                     // bestiary #$CC (boss)
    rate: 'fixed',
    minGroup: 1, maxGroup: 1,
  }],
]);
