// Monster Catalog — Pixel Remaster stats, keyed by ROM bestiary ID
//
// Names come from ROM text decoder at runtime (string $0520 + id)
// Stats source: FF3 Pixel Remaster (3D version)
// ROM IDs from disassembly encounter tables (bank 2E)
// Start: Altar Cave + world map near Ur

export const MONSTERS = new Map([
  // --- Altar Cave (floors 1-4) ---
  [0x00, { // text $0520: Goblin
    level: 1, hp: 7,
    atk: 6, def: 6,
    exp: 1, gil: 10,
    weakness: null,
    type: null,
    steal: 0xA6,      // Potion
    drops: [0xA6],     // Potion
    location: ['altar_cave', 'grasslands'],
  }],
  [0x01, { // text $0521: Carbuncle
    level: 1, hp: 10,
    atk: 6, def: 6,
    exp: 2, gil: 5,
    weakness: null,
    type: null,
    steal: 0xA6,
    drops: [0xA6],
    location: ['altar_cave'],
  }],
  [0x02, { // text $0522: Eye Fang
    level: 1, hp: 11,
    atk: 7, def: 6,
    exp: 3, gil: 7,
    weakness: null,
    type: null,
    steal: 0xA6,
    drops: [0xA6],
    location: ['altar_cave'],
  }],
  [0x03, { // text $0523: Blue Wisp
    level: 1, hp: 14,
    atk: 7, def: 6,
    exp: 4, gil: 10,
    weakness: null,
    type: null,
    steal: 0xA6,
    drops: [0xA6],
    location: ['altar_cave'],
  }],

  // --- Altar Cave boss ---
  [0xCC, { // text $05EC: Land Turtle
    level: 4, hp: 111,
    atk: 8, def: 6,
    exp: 20, gil: 500,
    weakness: null,
    type: 'boss',
    steal: 0xA6,
    drops: [0xA6, 0xB2], // item $A6, $B2
    location: ['altar_cave_boss'],
  }],
]);
