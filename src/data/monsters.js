// Monster Catalog — keyed by ROM bestiary ID
//
// Names come from ROM text decoder at runtime (string $0520 + id)
// HP/Level/EXP/Gil: GameFAQs Andrew Testa FAQ + RPGClassics NES shrine
// ATK/DEF: estimates — atk = level+4, def = max(1,floor(level/4))
//   (GamerCorner per-page data needed for exact NES values)
// ROM IDs: regular #001-195 = 0x00-0xC2 (sequential); bosses start 0xCC
// Weakness values: 'fire','ice','bolt','air','holy' (or array for 2+)
// Undead enemies are weak to both 'fire' and 'holy'

export const MONSTERS = new Map([

  // --- Altar Cave (floors 1-4) ---
  [0x00, { level: 1, hp:   5, atk:  5, def: 1, exp:  16, gil:   3, weakness: null,             type: null, steal: 0xA6, drops: [0xA6],          location: ['altar_cave','grasslands'] }], // Goblin
  [0x01, { level: 1, hp:   7, atk:  5, def: 1, exp:  16, gil:   5, weakness: null,             type: null, steal: 0xA6, drops: [0xA6],          location: ['altar_cave'] }],              // Carbuncle
  [0x02, { level: 1, hp:   8, atk:  7, def: 1, exp:  16, gil:   7, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['altar_cave'] }],              // Eye Fang
  [0x03, { level: 2, hp:  10, atk:  7, def: 1, exp:  20, gil:  10, weakness: null,             type: null, steal: 0xA6, drops: [0xA6],          location: ['altar_cave'] }],              // Blue Wisp
  [0x04, { level: 2, hp:  20, atk:  6, def: 1, exp:  20, gil:  12, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['altar_cave'] }],              // Killer Bee
  [0x05, { level: 2, hp:  24, atk:  6, def: 1, exp:  20, gil:  14, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['altar_cave'] }],              // Werewolf

  // --- Ur area / Kazus outskirts ---
  [0x06, { level: 3, hp:  30, atk:  7, def: 1, exp:  32, gil:  16, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['kazus_area'] }],              // Berserker
  [0x07, { level: 3, hp:  34, atk:  7, def: 1, exp:  32, gil:  18, weakness: ['fire','holy'],  type: null, steal: 0xA6, drops: [],              location: ['sasoon_castle'] }],           // Red Wisp
  [0x08, { level: 3, hp:  38, atk:  7, def: 1, exp:  32, gil:  20, weakness: ['fire','holy'],  type: null, steal: 0xA6, drops: [],              location: ['sasoon_castle'] }],           // Dark Eye
  [0x09, { level: 4, hp:  42, atk:  8, def: 1, exp:  40, gil:  22, weakness: ['fire','holy'],  type: null, steal: 0xA6, drops: [],              location: ['cave_seal'] }],               // Zombie
  [0x0A, { level: 4, hp:  48, atk:  8, def: 1, exp:  40, gil:  24, weakness: ['fire','holy'],  type: null, steal: 0xA6, drops: [],              location: ['cave_seal','mythril_mines'] }], // Mummy
  [0x0B, { level: 4, hp:  54, atk:  8, def: 1, exp:  40, gil:  26, weakness: ['fire','holy'],  type: null, steal: 0xA6, drops: [],              location: ['cave_seal','mythril_mines'] }], // Skeleton
  [0x0C, { level: 5, hp:  35, atk:  9, def: 1, exp:  48, gil:  28, weakness: ['fire','holy'],  type: null, steal: 0xA6, drops: [],              location: ['cave_seal','mythril_mines'] }], // Cursed Coin
  [0x0D, { level: 5, hp:  38, atk:  9, def: 1, exp:  48, gil:  30, weakness: ['fire','holy'],  type: null, steal: 0xAF, drops: [0xAF, 0xAE],   location: ['cave_seal','mythril_mines'] }], // Laruwai
  [0x0E, { level: 5, hp:  65, atk:  9, def: 1, exp:  48, gil:  32, weakness: ['fire','holy'],  type: null, steal: 0xAF, drops: [0xAF, 0xAE],   location: ['cave_seal','mythril_mines'] }], // Shadow
  [0x0F, { level: 6, hp:  70, atk: 10, def: 1, exp:  52, gil:  34, weakness: ['fire','holy'],  type: null, steal: 0xAF, drops: [0xAF, 0xAE],   location: ['cave_seal'] }],               // Revenant

  // --- Road to the Summit ---
  [0x10, { level: 3, hp:  72, atk:  7, def: 1, exp:  52, gil:  36, weakness: ['ice','air'],    type: null, steal: 0xA6, drops: [],              location: ['summit_road'] }],             // Firefly
  [0x11, { level: 6, hp:  85, atk: 10, def: 1, exp:  52, gil:  38, weakness: 'air',            type: null, steal: 0xAA, drops: [0xAA],          location: ['summit_road'] }],             // Dive Eagle
  [0x12, { level: 4, hp:  92, atk:  8, def: 1, exp:  60, gil:  40, weakness: 'air',            type: null, steal: 0xA6, drops: [],              location: ['summit_road'] }],             // Rust Bird
  [0x13, { level: 7, hp: 120, atk: 11, def: 1, exp:  60, gil:  42, weakness: 'air',            type: null, steal: 0xA6, drops: [0xA6],          location: ['summit_road'] }],             // Rukh
  [0x14, { level: 7, hp: 100, atk: 11, def: 1, exp:  60, gil:  44, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['kazus_desert'] }],            // Basilisk
  [0x15, { level: 8, hp: 110, atk: 12, def: 2, exp:  72, gil:  46, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['kazus_forest'] }],            // Bugbear
  [0x16, { level: 5, hp: 120, atk:  9, def: 1, exp:  72, gil:  48, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dummied'] }],                 // Mandrake (unused)

  // --- Hidden Road / Nepto Shrine ---
  [0x17, { level:10, hp:  36, atk: 14, def: 2, exp:  80, gil:  52, weakness: null,             type: null, steal: 0xA6, drops: [0xA6, 0xC3, 0xB1], location: ['hidden_road'] }],         // Leprechaun
  [0x18, { level:10, hp:  55, atk: 14, def: 2, exp:  80, gil:  53, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['hidden_road'] }],             // Dark Face
  [0x19, { level: 3, hp:  45, atk:  7, def: 1, exp:  80, gil:  54, weakness: null,             type: null, steal: 0xB1, drops: [0xB1, 0xB3, 0xB2], location: ['nepto_shrine'] }],        // Puti
  [0x1A, { level:10, hp:  60, atk: 14, def: 2, exp:  88, gil:  56, weakness: 'air',            type: null, steal: 0xA6, drops: [],              location: ['nepto_shrine'] }],            // Poison Bat
  [0x1B, { level: 2, hp:  58, atk:  6, def: 1, exp:  88, gil:  58, weakness: null,             type: null, steal: 0xA6, drops: [0xA6],          location: ['nepto_shrine'] }],            // Liliput
  [0x1C, { level:10, hp:  72, atk: 14, def: 2, exp:  88, gil:  60, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['nepto_shrine'] }],            // Were-rat
  [0x1D, { level:11, hp:  98, atk: 15, def: 2, exp:  96, gil:  62, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['nepto_shrine'] }],            // Blood Worm

  // --- Sea (surface) ---
  [0x1E, { level:11, hp:  85, atk: 15, def: 2, exp:  96, gil:  64, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['sea'] }],                     // Killer Fish
  [0x1F, { level:11, hp: 105, atk: 15, def: 2, exp:  96, gil:  66, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['sea'] }],                     // Hermit
  [0x20, { level:12, hp: 123, atk: 16, def: 3, exp: 100, gil:  67, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['sea'] }],                     // Sea Elemental
  [0x21, { level: 6, hp: 125, atk: 10, def: 1, exp: 100, gil:  68, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['sea'] }],                     // Tangi
  [0x22, { level:12, hp: 140, atk: 16, def: 3, exp: 100, gil:  70, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['sea'] }],                     // Sahuagin

  // --- South of Floating Continent / Sasoon West Tower ---
  [0x23, { level: 6, hp: 145, atk: 10, def: 1, exp: 108, gil:  72, weakness: null,             type: null, steal: null, drops: [null, null, null, null], location: ['south_float'] }],    // Paralyma (arrow drops)
  [0x24, { level:13, hp: 150, atk: 17, def: 3, exp: 108, gil:  74, weakness: null,             type: null, steal: 0xB1, drops: [0xB1, 0xB2, 0xB3], location: ['sasoon_west'] }],         // Griffon
  [0x25, { level:13, hp: 165, atk: 17, def: 3, exp: 108, gil:  76, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['south_float'] }],             // Lynx
  [0x26, { level:14, hp: 160, atk: 18, def: 3, exp: 120, gil:  78, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['south_float'] }],             // Hornet

  // --- Castle Argus / Dwarven Hollows ---
  [0x27, { level:14, hp: 185, atk: 18, def: 3, exp: 120, gil:  80, weakness: null,             type: null, steal: 0xA6, drops: [0xA6, 0xB3, 0xBB], location: ['castle_argus','dwarven_hollows'] }], // Knocker
  [0x28, { level: 7, hp: 190, atk: 11, def: 1, exp: 120, gil:  82, weakness: 'air',            type: null, steal: 0xA6, drops: [],              location: ['castle_argus','dwarven_hollows'] }], // Flyer
  [0x29, { level:15, hp: 200, atk: 19, def: 3, exp: 128, gil:  84, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['castle_argus','dwarven_hollows'] }], // Lizard Man
  [0x2A, { level:15, hp: 200, atk: 19, def: 3, exp: 128, gil:  86, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['castle_argus','dwarven_hollows'] }], // Gorgone

  // --- Floating Continent ---
  [0x2B, { level: 8, hp: 210, atk: 12, def: 2, exp: 128, gil:  87, weakness: null,             type: null, steal: 0xA6, drops: [0xA6, 0xB3, 0xBB], location: ['floating_continent'] }], // Red Cap
  [0x2C, { level: 8, hp: 220, atk: 12, def: 2, exp: 132, gil:  88, weakness: null,             type: null, steal: null, drops: [],              location: ['floating_continent_forest'] }], // Barometz
  [0x2D, { level: 8, hp: 200, atk: 12, def: 2, exp: 132, gil:  90, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['float_nw'] }],                // Slime
  [0x2E, { level: 8, hp: 200, atk: 12, def: 2, exp: 132, gil:  92, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['float_nw'] }],                // Tarantula
  [0x2F, { level: 8, hp: 200, atk: 12, def: 2, exp: 144, gil:  94, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['float_desert'] }],            // Cafjel

  // --- Tower of Owen ---
  [0x30, { level: 5, hp: 109, atk:  9, def: 1, exp: 144, gil:  96, weakness: null,             type: null, steal: 0xAC, drops: [0xAC, 0xAB, 0xAD], location: ['tower_owen'] }],          // Pygman
  [0x31, { level: 5, hp: 111, atk:  9, def: 1, exp: 144, gil:  98, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['tower_owen'] }],              // Farjalug
  [0x32, { level:19, hp: 114, atk: 23, def: 4, exp: 152, gil: 100, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['tower_owen'] }],              // Blood Bat
  [0x33, { level: 4, hp: 118, atk:  8, def: 1, exp: 152, gil: 101, weakness: null,             type: null, steal: 0xAC, drops: [0xAC, 0xAB, 0xAD], location: ['tower_owen'] }],          // Puti Mage
  [0x34, { level:11, hp: 120, atk: 15, def: 2, exp: 152, gil: 102, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dummied'] }],                 // Fury Eye (unused)
  [0x35, { level:19, hp: 122, atk: 23, def: 4, exp: 160, gil: 105, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['tower_owen'] }],              // Ohishuki

  // --- Underground Dwarves' Cave ---
  [0x36, { level: 9, hp: 125, atk: 13, def: 2, exp: 160, gil: 110, weakness: null,             type: null, steal: 0xA7, drops: [],              location: ['dwarven_cave'] }],            // Bomb
  [0x37, { level:18, hp: 128, atk: 22, def: 4, exp: 160, gil: 112, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dwarven_cave'] }],            // Manticore
  [0x38, { level: 9, hp: 130, atk: 13, def: 2, exp: 160, gil: 115, weakness: null,             type: null, steal: 0xAA, drops: [0xAA],          location: ['dwarven_cave'] }],            // Boulder
  [0x39, { level:20, hp: 133, atk: 24, def: 5, exp: 180, gil: 116, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['dwarven_cave'] }],            // Sea Devil
  [0x3A, { level:20, hp: 136, atk: 24, def: 5, exp: 180, gil: 118, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['dwarven_cave'] }],            // Merman
  [0x3B, { level:10, hp: 140, atk: 14, def: 2, exp: 189, gil: 120, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['dwarven_cave'] }],            // Ruin Wave

  // --- Flame Cave ---
  [0x3C, { level:10, hp: 143, atk: 14, def: 2, exp: 180, gil: 125, weakness: 'fire',           type: null, steal: 0xA6, drops: [0xA6, 0xC3, 0xB1], location: ['flame_cave'] }],          // Balloon
  [0x3D, { level:21, hp: 147, atk: 25, def: 5, exp: 200, gil: 130, weakness: 'ice',            type: null, steal: 0xA6, drops: [],              location: ['flame_cave'] }],              // Milmecoreo
  [0x3E, { level:22, hp: 150, atk: 26, def: 5, exp: 200, gil: 135, weakness: 'ice',            type: null, steal: 0xA6, drops: [],              location: ['flame_cave'] }],              // Crocotta
  [0x3F, { level:11, hp: 153, atk: 15, def: 2, exp: 200, gil: 135, weakness: 'ice',            type: null, steal: 0xAA, drops: [0xA6, 0xB2, null], location: ['flame_cave'] }],          // Adamantai (Midget Bread unknown)
  [0x40, { level:22, hp: 155, atk: 26, def: 5, exp: 200, gil: 140, weakness: 'fire',           type: null, steal: 0xA6, drops: [],              location: ['flame_cave'] }],              // Red Mallow

  // --- Castle Hyne ---
  [0x41, { level:11, hp: 160, atk: 15, def: 2, exp: 240, gil: 145, weakness: ['fire','holy'],  type: null, steal: 0xAF, drops: [0xAF, 0xAE],   location: ['hynes_castle'] }],            // Pharaoh
  [0x42, { level:23, hp: 164, atk: 27, def: 5, exp: 240, gil: 150, weakness: ['fire','holy'],  type: null, steal: 0xA6, drops: [],              location: ['hynes_castle'] }],            // Lemwraith
  [0x43, { level:12, hp: 168, atk: 16, def: 3, exp: 240, gil: 155, weakness: null,             type: null, steal: 0xB2, drops: [0xB2, 0xB1, 0xB3], location: ['hynes_castle'] }],        // Lamia
  [0x44, { level:24, hp: 171, atk: 28, def: 6, exp: 288, gil: 158, weakness: null,             type: null, steal: null, drops: [null, null, null, null], location: ['hynes_castle'] }],   // Daemon (arrow drops)
  [0x45, { level:24, hp: 350, atk: 28, def: 6, exp: 288, gil: 160, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['hynes_castle'] }],            // Dullahan

  // --- Outer Sea ---
  [0x46, { level:24, hp: 179, atk: 28, def: 6, exp: 288, gil: 165, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['outer_sea'] }],               // Anetto
  [0x47, { level:25, hp: 182, atk: 29, def: 6, exp: 288, gil: 170, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['outer_sea'] }],               // Mermaid
  [0x48, { level:25, hp: 185, atk: 29, def: 6, exp: 320, gil: 175, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['outer_sea'] }],               // Seahorse
  [0x49, { level:25, hp: 190, atk: 29, def: 6, exp: 320, gil: 180, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['ancient_ruins_rivers'] }],    // Sea Serpent

  // --- Water Cave ---
  [0x4A, { level:26, hp: 195, atk: 30, def: 6, exp: 320, gil: 185, weakness: null,             type: null, steal: 0xAA, drops: [0xAA],          location: ['water_cave'] }],              // Cockatrice
  [0x4B, { level:26, hp: 200, atk: 30, def: 6, exp: 360, gil: 190, weakness: 'fire',           type: null, steal: 0xA6, drops: [],              location: ['water_cave'] }],              // Venom Toad
  [0x4C, { level:26, hp: 205, atk: 30, def: 6, exp: 360, gil: 195, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['water_cave'] }],              // Twin Head
  [0x4D, { level:27, hp: 210, atk: 31, def: 6, exp: 360, gil: 200, weakness: 'bolt',           type: null, steal: 0xB4, drops: [0xB4, 0xB6, 0xB5], location: ['water_cave'] }],          // Roper
  [0x4E, { level:27, hp: 215, atk: 31, def: 6, exp: 400, gil: 210, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['water_cave'] }],              // Agaria

  // --- Amur Sewer ---
  [0x4F, { level:27, hp: 220, atk: 31, def: 6, exp: 400, gil: 220, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['amur_sewer'] }],              // Dark Foot
  [0x50, { level:28, hp: 225, atk: 32, def: 7, exp: 400, gil: 230, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['amur_sewer'] }],              // Gigan Toad
  [0x51, { level:28, hp: 230, atk: 32, def: 7, exp: 440, gil: 240, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['amur_sewer'] }],              // Twin Liger
  [0x52, { level:28, hp: 400, atk: 32, def: 7, exp: 440, gil: 250, weakness: 'bolt',           type: null, steal: 0xA7, drops: [0xA7, 0xC1, 0xB6], location: ['amur_sewer'] }],          // Storoper

  // --- Amur area / Surface World ---
  [0x53, { level:29, hp: 240, atk: 33, def: 7, exp: 440, gil: 260, weakness: 'air',            type: null, steal: 0xB4, drops: [0xB4, 0xB6, 0xB5], location: ['amur_forest'] }],         // Pudding
  [0x54, { level:29, hp: 245, atk: 33, def: 7, exp: 500, gil: 270, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['amur_area'] }],               // Helcan
  [0x55, { level:29, hp: 250, atk: 33, def: 7, exp: 500, gil: 280, weakness: 'ice',            type: null, steal: 0xA7, drops: [0xA7, 0xC1, 0xB4], location: ['surface_desert'] }],      // Vulcan
  [0x56, { level:30, hp: 255, atk: 34, def: 7, exp: 500, gil: 290, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['surface_desert'] }],          // Leucrotta
  [0x57, { level:12, hp: 260, atk: 16, def: 3, exp: 560, gil: 300, weakness: null,             type: null, steal: 0xB4, drops: [0xB4, 0xA7, 0xC1, 0xB6], location: ['surface_forest'] }], // Magician
  [0x58, { level:30, hp: 265, atk: 34, def: 7, exp: 560, gil: 310, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['surface_world'] }],           // Roaming Gold Coin

  // --- Goldor's Mansion / Salonia ---
  [0x59, { level:31, hp: 270, atk: 35, def: 7, exp: 560, gil: 320, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['goldors_mansion'] }],         // Gold Eagle
  [0x5A, { level:31, hp: 275, atk: 35, def: 7, exp: 600, gil: 330, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['goldors_mansion'] }],         // Gold Warrior
  [0x5B, { level:31, hp: 280, atk: 35, def: 7, exp: 600, gil: 340, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['goldors_mansion'] }],         // Gold Bear
  [0x5C, { level:32, hp: 285, atk: 36, def: 8, exp: 600, gil: 350, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['goldors_mansion','salonia'] }], // Gold Knight
  [0x5D, { level:32, hp: 290, atk: 36, def: 8, exp: 700, gil: 360, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['goldors_mansion'] }],         // Nightmare

  // --- Dragon Tower ---
  [0x5E, { level:32, hp: 295, atk: 36, def: 8, exp: 700, gil: 370, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dragon_tower'] }],            // M.Helcan
  [0x5F, { level:33, hp: 300, atk: 37, def: 8, exp: 700, gil: 380, weakness: null,             type: null, steal: 0xA7, drops: [0xA7, 0xBC, 0xBE], location: ['dragon_tower'] }],        // Needler
  [0x60, { level:33, hp: 305, atk: 37, def: 8, exp: 800, gil: 390, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dragon_tower'] }],            // Catoblepas
  [0x61, { level:22, hp: 310, atk: 26, def: 5, exp: 800, gil: 400, weakness: null,             type: null, steal: 0xA7, drops: [0xA7, 0xB5, 0xBA], location: ['dragon_tower'] }],        // Sorcerer
  [0x62, { level:34, hp: 320, atk: 38, def: 8, exp: 960, gil: 420, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dragon_tower'] }],            // Sand Worm

  // --- Sky (near Doga's Manor) ---
  [0x63, { level:34, hp: 325, atk: 38, def: 8, exp: 960, gil: 430, weakness: 'fire',           type: null, steal: 0xA6, drops: [],              location: ['sky'] }],                     // Ice Fry
  [0x64, { level:35, hp: 335, atk: 39, def: 8, exp:1040, gil: 450, weakness: 'air',            type: null, steal: 0xA6, drops: [],              location: ['sky'] }],                     // Simurgh
  [0x65, { level:35, hp:1000, atk: 39, def: 8, exp:1040, gil: 460, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['sky'] }],                     // Harpy
  [0x66, { level:36, hp: 345, atk: 40, def: 9, exp:1200, gil: 470, weakness: 'air',            type: null, steal: 0xA6, drops: [],              location: ['sky'] }],                     // Gargoyle
  [0x67, { level:36, hp: 350, atk: 40, def: 9, exp:1200, gil: 475, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['sky'] }],                     // Chimera

  // --- Magic Circle Cave ---
  [0x68, { level:36, hp: 355, atk: 40, def: 9, exp:1320, gil: 480, weakness: null,             type: null, steal: 0xA7, drops: [0xA7],          location: ['magic_circle_cave'] }],       // Devil Horse
  [0x69, { level:36, hp: 360, atk: 40, def: 9, exp:1320, gil: 490, weakness: null,             type: null, steal: 0xA7, drops: [0xA7, 0xC1, 0xB4], location: ['magic_circle_cave'] }],   // Rock Gargoyle
  [0x6A, { level:37, hp: 365, atk: 41, def: 9, exp:1320, gil: 500, weakness: null,             type: null, steal: 0xA7, drops: [0xA7],          location: ['magic_circle_cave'] }],       // Bull Man
  [0x6B, { level:37, hp: 370, atk: 41, def: 9, exp:1440, gil: 510, weakness: null,             type: null, steal: 0xB5, drops: [0xB5, 0xB6, 0xB4], location: ['magic_circle_cave'] }],   // Dark Knight
  [0x6C, { level:18, hp: 555, atk: 22, def: 4, exp:1440, gil: 520, weakness: 'air',            type: null, steal: 0xA6, drops: [],              location: ['magic_circle_cave'] }],       // Mage Flyer

  // --- Surface World Underwater ---
  [0x6D, { level:38, hp: 380, atk: 42, def: 9, exp:1440, gil: 540, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['underwater'] }],              // Neegle
  [0x6E, { level:60, hp: 385, atk: 64, def:15, exp:1440, gil: 550, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['underwater'] }],              // Abotu
  [0x6F, { level:39, hp: 470, atk: 43, def: 9, exp: 450, gil: 680, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['underwater'] }],              // Sea King
  [0x70, { level:39, hp: 395, atk: 43, def: 9, exp:1560, gil: 580, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['underwater'] }],              // Khargra
  [0x71, { level:39, hp: 650, atk: 43, def: 9, exp:1560, gil: 600, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['underwater'] }],              // Charybdis

  // --- Saronia Catacombs ---
  [0x72, { level:42, hp: 490, atk: 46, def:10, exp:2000, gil: 720, weakness: null,             type: null, steal: 0xA7, drops: [0xA7, 0xC1, 0xB6], location: ['saronia_catacombs'] }],   // Kyklops
  [0x73, { level:43, hp: 500, atk: 47, def:10, exp:2000, gil: 740, weakness: null,             type: null, steal: 0xA7, drops: [0xA7, 0xB5, 0xBA], location: ['saronia_catacombs'] }],   // Boss Troll
  [0x74, { level:43, hp: 510, atk: 47, def:10, exp:2800, gil: 745, weakness: null,             type: null, steal: 0xA7, drops: [0xA7, 0xC1, 0xB4], location: ['saronia_catacombs'] }],   // Fahan
  [0x75, { level:45, hp:1120, atk: 49, def:11, exp:2200, gil: 750, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['saronia_catacombs'] }],       // Kenkos
  [0x76, { level:44, hp: 530, atk: 48, def:11, exp:2200, gil: 760, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['saronia_catacombs'] }],       // Valar

  // --- Temple of Time ---
  [0x77, { level:40, hp:1250, atk: 44, def:10, exp:1640, gil: 610, weakness: 'air',            type: null, steal: 0xA6, drops: [],              location: ['temple_of_time'] }],          // Dirai
  [0x78, { level:40, hp: 420, atk: 44, def:10, exp:1640, gil: 615, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['temple_of_time'] }],          // M.Chimera
  [0x79, { level:40, hp: 430, atk: 44, def:10, exp:1640, gil: 620, weakness: null,             type: null, steal: 0xA7, drops: [0xA7],          location: ['temple_of_time'] }],          // K.Lizard
  [0x7A, { level:41, hp: 440, atk: 45, def:10, exp:1640, gil: 640, weakness: 'air',            type: null, steal: 0xA6, drops: [],              location: ['temple_of_time'] }],          // Pteragon
  [0x7B, { level:41, hp: 450, atk: 45, def:10, exp:1800, gil: 650, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['temple_of_time'] }],          // Wyvern
  [0x7C, { level:41, hp:1550, atk: 45, def:10, exp:1800, gil: 660, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['temple_of_time'] }],          // Behemoth
  [0x7D, { level:42, hp: 470, atk: 46, def:10, exp:1800, gil: 680, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['temple_of_time'] }],          // Seaking
  [0x7E, { level:42, hp: 480, atk: 46, def:10, exp:2000, gil: 700, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['temple_of_time'] }],          // Dragon

  // --- Undersea Cave ---
  [0x7F, { level:44, hp: 540, atk: 48, def:11, exp:2200, gil: 780, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['undersea_cave'] }],           // Dosmea
  [0x80, { level:44, hp: 550, atk: 48, def:11, exp:2400, gil: 800, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['undersea_cave'] }],           // Sea Witch
  [0x81, { level:45, hp: 560, atk: 49, def:11, exp:2400, gil: 820, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['undersea_cave'] }],           // Killer Snail
  [0x82, { level:55, hp: 570, atk: 59, def:13, exp:2400, gil: 840, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['undersea_cave'] }],           // Olog-Hai
  [0x83, { level:45, hp: 580, atk: 49, def:11, exp:2800, gil: 850, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['undersea_cave'] }],           // Kelpie
  [0x84, { level:46, hp: 590, atk: 50, def:11, exp:2800, gil: 860, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['undersea_cave'] }],           // Aegil

  // --- Ancient Ruins ---
  [0x85, { level:46, hp:1500, atk: 50, def:11, exp:4800, gil: 880, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['ancient_ruins'] }],           // Pyralis
  [0x86, { level:36, hp: 910, atk: 40, def: 9, exp: 320, gil: 920, weakness: 'dark',           type: null, steal: 0xA6, drops: [],              location: ['ancient_ruins'] }],           // Sirenos (splits)
  [0x87, { level:37, hp:1000, atk: 41, def: 9, exp: 320, gil: 940, weakness: 'dark',           type: null, steal: 0xA7, drops: [0xA7],          location: ['ancient_ruins'] }],           // Garb (splits)
  [0x88, { level:37, hp:1100, atk: 41, def: 9, exp: 320, gil: 945, weakness: 'dark',           type: null, steal: 0xA6, drops: [0xA6, 0xB5, 0xB6], location: ['ancient_ruins'] }],       // Azrael (splits)
  [0x89, { level:47, hp:1150, atk: 51, def:11, exp: 320, gil: 950, weakness: 'dark',           type: null, steal: 0xA6, drops: [],              location: ['ancient_ruins'] }],           // Eater (splits)
  [0x8A, { level:48, hp:2000, atk: 52, def:12, exp:5000, gil: 960, weakness: ['fire','holy'],  type: null, steal: 0xA6, drops: [],              location: ['ancient_ruins'] }],           // D.Zombie

  // --- Lake Dol ---
  [0x8B, { level:54, hp: 830, atk: 58, def:13, exp:3600, gil:1680, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['lake_dol'] }],                // Ouroboros
  [0x8C, { level:54, hp: 840, atk: 58, def:13, exp:3600, gil:1700, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['lake_dol'] }],                // Plancti
  [0x8D, { level:54, hp: 850, atk: 58, def:13, exp:3800, gil:1750, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['lake_dol'] }],                // Sea Lion
  [0x8E, { level:55, hp: 860, atk: 59, def:13, exp:3800, gil:1800, weakness: 'bolt',           type: null, steal: 0xA6, drops: [],              location: ['lake_dol'] }],                // Remora

  // --- Bahamut Cave ---
  [0x8F, { level:55, hp: 870, atk: 59, def:13, exp:3800, gil:1900, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['bahamut_cave'] }],            // Grenade
  [0x90, { level:55, hp: 880, atk: 59, def:13, exp:3800, gil:1950, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['bahamut_cave'] }],            // Pterosaur
  [0x91, { level:56, hp: 890, atk: 60, def:14, exp:3800, gil:2000, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['bahamut_cave'] }],            // Gt.Boros
  [0x92, { level:56, hp: 900, atk: 60, def:14, exp:3800, gil:2100, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['bahamut_cave'] }],            // Liger S.
  [0x93, { level:56, hp:1280, atk: 60, def:14, exp:4000, gil:2200, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['bahamut_cave'] }],            // Q.Lamia

  // --- Cave of Darkness ---
  [0x94, { level:48, hp:1400, atk: 52, def:12, exp: 320, gil: 980, weakness: null,             type: null, steal: 0xA7, drops: [0xA7, 0xBC, 0xBF], location: ['cave_of_darkness'] }],    // Death Claw (splits)
  [0x95, { level:49, hp: 680, atk: 53, def:12, exp:5000, gil: 990, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['cave_of_darkness'] }],        // Hell Horse
  [0x96, { level:49, hp:1550, atk: 53, def:12, exp: 320, gil:1000, weakness: 'dark',           type: null, steal: 0xA6, drops: [],              location: ['cave_of_darkness'] }],        // Cronos (splits)
  [0x97, { level:49, hp:1620, atk: 53, def:12, exp: 320, gil:1050, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['cave_of_darkness'] }],        // Balfrey (splits)
  [0x98, { level:50, hp:1600, atk: 54, def:12, exp: 320, gil:1100, weakness: 'dark',           type: null, steal: 0xA6, drops: [],              location: ['cave_of_darkness'] }],        // Haniel (splits)
  [0x99, { level:50, hp: 720, atk: 54, def:12, exp: 320, gil:1150, weakness: 'dark',           type: null, steal: 0xA7, drops: [0xA7],          location: ['cave_of_darkness'] }],        // Vassago (splits)

  // --- Dorga's Cave ---
  [0x9A, { level:50, hp: 730, atk: 54, def:12, exp:3200, gil:1200, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dorgas_cave'] }],             // Peryton
  [0x9B, { level:51, hp: 740, atk: 55, def:12, exp:3400, gil:1250, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dorgas_cave'] }],             // Ogre
  [0x9C, { level:51, hp: 750, atk: 55, def:12, exp:3400, gil:1300, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dorgas_cave'] }],             // Cyclops
  [0x9D, { level:51, hp: 760, atk: 55, def:12, exp:3400, gil:1350, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dorgas_cave'] }],             // Nemesis
  [0x9E, { level:52, hp: 770, atk: 56, def:13, exp:3400, gil:1400, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dorgas_cave'] }],             // Humbaba

  // --- Outside Syrcus Tower ---
  [0x9F, { level:52, hp: 780, atk: 56, def:13, exp:3200, gil:1450, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['syrcus_tower_outer'] }],      // Death Needle
  [0xA0, { level:52, hp: 790, atk: 56, def:13, exp: 800, gil:1500, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['syrcus_tower_outer'] }],      // Liger
  [0xA1, { level:52, hp:1200, atk: 56, def:13, exp:3400, gil:1600, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['syrcus_tower_outer'] }],      // Ion

  // --- Ancient's Labyrinth ---
  [0xA2, { level:54, hp: 820, atk: 58, def:13, exp:3400, gil:1640, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['ancients_labyrinth'] }],      // Minotaur
  [0xA3, { level:57, hp: 920, atk: 61, def:14, exp:3800, gil:2300, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['ancients_labyrinth'] }],      // Iron Claw
  [0xA4, { level:57, hp:2250, atk: 61, def:14, exp:3800, gil:2400, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['ancients_labyrinth'] }],      // Gt.Daemon
  [0xA5, { level:30, hp:1500, atk: 34, def: 7, exp:  72, gil:  50, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['ancients_labyrinth'] }],      // Unne Clone (special)
  [0xA6, { level:57, hp:2200, atk: 61, def:14, exp:2800, gil:2500, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['ancients_labyrinth'] }],      // Thanatos
  [0xA7, { level:58, hp:2500, atk: 62, def:14, exp:3800, gil:2600, weakness: ['fire','holy'],  type: null, steal: 0xA6, drops: [],              location: ['ancients_labyrinth'] }],      // Bone Dragon
  [0xA8, { level:58, hp:3000, atk: 62, def:14, exp:3800, gil:2700, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['ancients_labyrinth'] }],      // King Behemoth

  // --- Eureka (Forbidden Land) ---
  [0xA9, { level:59, hp: 990, atk: 63, def:14, exp:4000, gil:3000, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['eureka'] }],                  // Abai
  [0xAA, { level:59, hp:1000, atk: 63, def:14, exp:4000, gil:3100, weakness: null,             type: null, steal: 0xA7, drops: [0xA7],          location: ['eureka'] }],                  // Sleipnir
  [0xAB, { level:60, hp:1010, atk: 64, def:15, exp:4000, gil:3200, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['eureka'] }],                  // Haokah
  [0xAC, { level:38, hp:1020, atk: 42, def: 9, exp:4000, gil:3300, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['eureka'] }],                  // Acheron
  [0xAD, { level:60, hp:1030, atk: 64, def:15, exp:4200, gil:3400, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['eureka'] }],                  // Oceanos

  // --- Syrcus Tower ---
  [0xAE, { level:62, hp:4050, atk: 66, def:15, exp:4200, gil:3500, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['syrcus_tower'] }],            // Gomoree
  [0xAF, { level:61, hp:1750, atk: 65, def:15, exp:4200, gil:3600, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['syrcus_tower'] }],            // Bluk
  [0xB0, { level:46, hp:1500, atk: 50, def:11, exp:4000, gil:2800, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['syrcus_tower'] }],            // Dorga Clone
  [0xB1, { level:62, hp:1570, atk: 66, def:15, exp:4400, gil:3700, weakness: 'ice',            type: null, steal: 0xA6, drops: [],              location: ['syrcus_tower'] }],            // Flame Devil
  [0xB2, { level:62, hp:4580, atk: 66, def:15, exp:4400, gil:3800, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['syrcus_tower'] }],            // Platinal
  [0xB3, { level:62, hp:2090, atk: 66, def:15, exp:4400, gil:3900, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['syrcus_tower'] }],            // Qumqum
  [0xB4, { level:63, hp:1100, atk: 67, def:15, exp:4400, gil:4000, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['syrcus_tower'] }],            // Shinobi

  // --- Dark World ---
  [0xB5, { level:63, hp:2110, atk: 67, def:15, exp:4400, gil:4100, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dark_world'] }],              // Leader
  [0xB6, { level:63, hp:2520, atk: 67, def:15, exp:4600, gil:4200, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dark_world'] }],              // Kage
  [0xB7, { level:64, hp:1130, atk: 68, def:16, exp:4600, gil:4300, weakness: null,             type: null, steal: 0xA7, drops: [0xA7],          location: ['syrcus_tower'] }],            // D.General
  [0xB8, { level:85, hp:10000, atk: 89, def:21, exp:5000, gil:5400, weakness: null,            type: null, steal: 0xA8, drops: [0xA8, null],    location: ['syrcus_tower'] }],            // Yellow Dragon (Onion Equip drop)
  [0xB9, { level:85, hp:10000, atk: 89, def:21, exp:4000, gil:2900, weakness: null,            type: null, steal: 0xA8, drops: [0xA8, null],    location: ['syrcus_tower'] }],            // Green Dragon
  [0xBA, { level:85, hp:15000, atk: 89, def:21, exp:5600, gil:5800, weakness: null,            type: null, steal: 0xA8, drops: [0xA8, null],    location: ['syrcus_tower'] }],            // Red Dragon
  [0xBB, { level:65, hp:2160, atk: 69, def:16, exp:4600, gil:4600, weakness: null,             type: null, steal: 0xA7, drops: [0xA7, 0xBC, 0xBF], location: ['syrcus_tower'] }],        // Grashara
  [0xBC, { level:65, hp:2570, atk: 69, def:16, exp:4600, gil:4700, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dark_world'] }],              // Jormungand
  [0xBD, { level:65, hp:2180, atk: 69, def:16, exp:4800, gil:4800, weakness: null,             type: null, steal: 0xA7, drops: [0xA7, 0xC1, 0xB6], location: ['dark_world'] }],          // Thor
  [0xBE, { level:64, hp:6500, atk: 68, def:16, exp:4800, gil:4900, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['cave_of_darkness'] }],        // Hekaton
  [0xBF, { level:66, hp:3600, atk: 70, def:16, exp:4800, gil:5000, weakness: null,             type: null, steal: 0xA7, drops: [0xA7, 0xB5, 0xBA], location: ['dark_world'] }],          // Hydra
  [0xC0, { level:66, hp:6220, atk: 70, def:16, exp:4800, gil:5100, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dark_world'] }],              // Q.Scylla
  [0xC1, { level:67, hp:4240, atk: 71, def:16, exp:4800, gil:5200, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dark_world'] }],              // Garm
  [0xC2, { level:67, hp:4960, atk: 71, def:16, exp:5000, gil:5300, weakness: null,             type: null, steal: 0xA6, drops: [],              location: ['dark_world'] }],              // Double Dragon

  // --- IDs 0xC3–0xCB: unused/dummied slots ---

  // --- Bosses (starting at 0xCC) ---
  [0xCC, { level:  8, hp:   120, atk:  8, def:  1, exp:  132, gil:   500, weakness: null,            type: 'boss', steal: 0xA6, drops: [0xA6, 0xB2],    location: ['altar_cave_boss'] }],         // Land Turtle
  [0xCD, { level: 13, hp:   480, atk: 17, def:  3, exp:  160, gil:   700, weakness: 'ice',           type: 'boss', steal: 0xA6, drops: [],              location: ['cave_seal_boss'] }],           // Jinn
  [0xCE, { level: 39, hp: 60000, atk: 43, def:  9, exp: 1560, gil:   560, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['guards_bay_boss'] }],          // Nepto Dragon
  [0xCF, { level:  2, hp:   450, atk:  6, def:  1, exp:  240, gil:  1000, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['nepto_shrine_boss'] }],        // Big Rat
  [0xD0, { level: 42, hp:   980, atk: 46, def: 10, exp:  360, gil:  1200, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['tower_owen_boss'] }],          // Medusa
  [0xD1, { level: 12, hp:  1400, atk: 16, def:  3, exp:  500, gil:  1500, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['underground_lake_boss'] }],    // Guzco
  [0xD2, { level: 19, hp:  2100, atk: 23, def:  4, exp:  700, gil:  1800, weakness: 'ice',           type: 'boss', steal: 0xA6, drops: [],              location: ['flame_cave_boss'] }],          // Salamander
  [0xD3, { level: 12, hp:  1600, atk: 16, def:  3, exp: 1040, gil:  2100, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['hynes_castle_boss'] }],        // Hyne
  [0xD4, { level: 22, hp:  1950, atk: 26, def:  5, exp: 1320, gil:  2500, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['water_cave_boss'] }],          // Kraken
  [0xD5, { level: 30, hp:  2250, atk: 34, def:  7, exp: 1640, gil:  3300, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['goldors_mansion_boss'] }],     // Goldor
  [0xD6, { level: 30, hp:  5000, atk: 34, def:  7, exp: 2200, gil:  3400, weakness: 'air',           type: 'boss', steal: 0xA6, drops: [],              location: ['salonia_boss'] }],             // Garuda
  [0xD7, { level: 68, hp:  7000, atk: 72, def: 17, exp: 5000, gil:  5600, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['salonia_catacombs_boss'] }],   // Odin
  [0xD8, { level: 68, hp:  7000, atk: 72, def: 17, exp: 5000, gil:  5700, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['lake_dol_boss'] }],            // Leviathan
  [0xD9, { level: 50, hp:  7500, atk: 54, def: 12, exp: 2800, gil:  3500, weakness: 'air',           type: 'boss', steal: 0xA6, drops: [],              location: ['bahamut_lair_boss'] }],        // Bahamut
  [0xDA, { level: 30, hp:  4500, atk: 34, def:  7, exp: 3400, gil:  4000, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['dorgas_cave_boss'] }],         // Dorga
  [0xDB, { level: 30, hp:  4500, atk: 34, def:  7, exp: 4000, gil:  4200, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['dorgas_cave_boss'] }],         // Unne
  [0xDC, { level: 55, hp:  7800, atk: 59, def: 13, exp: 4400, gil:  4500, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['ancients_labyrinth_boss'] }],  // Titan
  [0xDD, { level: 60, hp:  5500, atk: 64, def: 15, exp: 4600, gil:  4800, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['eureka_boss'] }],              // Ninja
  [0xDE, { level: 61, hp:  7040, atk: 65, def: 15, exp: 4200, gil:  3450, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['eureka_boss'] }],              // Amon
  [0xDF, { level: 68, hp:  9000, atk: 72, def: 17, exp: 4800, gil:  5000, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['eureka_boss'] }],              // Kunoichi
  [0xE0, { level: 70, hp: 12000, atk: 74, def: 17, exp: 5000, gil:  5200, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['eureka_boss'] }],              // General
  [0xE1, { level: 80, hp: 12000, atk: 84, def: 20, exp: 5400, gil:  5600, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['eureka_boss'] }],              // Guardian
  [0xE2, { level: 75, hp: 10000, atk: 79, def: 18, exp: 5200, gil:  5400, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['eureka_boss'] }],              // Scylla
  [0xE3, { level:112, hp: 21000, atk:116, def: 28, exp:    0, gil:     0, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['syrcus_tower_boss'] }],        // Zande (final boss)
  [0xE4, { level: 96, hp: 10000, atk:100, def: 24, exp: 3400, gil:  1550, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['dark_world'] }],              // Zande Clone
  [0xE5, { level: 85, hp: 23000, atk: 89, def: 21, exp: 6000, gil:  6400, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['dark_world_boss'] }],          // Cerberus
  [0xE6, { level: 88, hp: 29000, atk: 92, def: 22, exp: 7000, gil:  6800, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['dark_world_boss'] }],          // Two-Headed Dragon
  [0xE7, { level: 89, hp: 32000, atk: 93, def: 22, exp: 8000, gil:  7000, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['dark_world_boss'] }],          // Echidna
  [0xE8, { level: 98, hp: 35000, atk:102, def: 24, exp: 9000, gil:  7200, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['dark_world_boss'] }],          // Ahriman
  [0xE9, { level: 99, hp: 65000, atk:103, def: 24, exp:    0, gil:     0, weakness: null,            type: 'boss', steal: 0xA6, drops: [],              location: ['dark_world_boss'] }],          // Cloud of Darkness
]);
