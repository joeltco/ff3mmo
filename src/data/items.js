// Item Catalog — keyed by ROM item ID (0x00–0xC7)
// Names come from ROM text decoder at runtime (string $0400 + id)
// Stats source: shrines.rpgclassics.com/nes/ff3/
// Job equip data source: shrines.rpgclassics.com/nes/ff3/weapons.shtml & armor.shtml
// ROM IDs verified from tools/text-decode.js item dump

// Job bitmask constants — bit N = job index N can equip
const On = 1 << 0;   // Onion Knight
const Fi = 1 << 1;   // Fighter
const Mo = 1 << 2;   // Monk
const Ww = 1 << 3;   // White Mage
const Bw = 1 << 4;   // Black Mage
const Rw = 1 << 5;   // Red Mage
const Hu = 1 << 6;   // Hunter/Ranger
const Kn = 1 << 7;   // Knight
const Th = 1 << 8;   // Thief
const Sc = 1 << 9;   // Scholar
const Ge = 1 << 10;  // Geomancer
const Dr = 1 << 11;  // Dragoon
const Vi = 1 << 12;  // Viking
const Ka = 1 << 13;  // Karateka/Black Belt
const Mk = 1 << 14;  // Magic Knight
const Co = 1 << 15;  // Conjurer
const Ba = 1 << 16;  // Bard
const Su = 1 << 17;  // Summoner
const Sh = 1 << 18;  // Shaman/Devout
const Wa = 1 << 19;  // Warlock/Magus
const Sa = 1 << 20;  // Sage
const Ni = 1 << 21;  // Ninja
const ALL_BUT_MK = On|Fi|Mo|Ww|Bw|Rw|Hu|Kn|Th|Sc|Ge|Dr|Vi|Ka|Co|Ba|Su|Sh|Wa|Sa|Ni;
const ALL = ALL_BUT_MK | Mk;

// --- Claws (0x01–0x05) ---
const CLAWS = [
  [0x01, { type: 'weapon', subtype: 'claw', atk: 36, hit: 100, price:  3500, jobs: Ka|Ni }],  // Kaiser
  [0x02, { type: 'weapon', subtype: 'claw', atk: 42, hit: 100, price:  7000, jobs: Ka|Ni }],  // Cat Claws
  [0x03, { type: 'weapon', subtype: 'claw', atk: 48, hit: 100, price:  9000, jobs: Vi|Ni }],  // Wyvern (Dragon Claw)
  [0x04, { type: 'weapon', subtype: 'claw', atk: 37, hit: 100, price:  9000, effect: 'confuse', jobs: Ka|Ni }],  // Faerie Claws (Elven)
  [0x05, { type: 'weapon', subtype: 'claw', atk: 60, hit: 100, price: 20000, effect: 'poison', jobs: Ka|Ni }],  // Hell Claws
];

// --- Nunchaku (0x06–0x08) ---
const NUNCHAKU = [
  [0x06, { type: 'weapon', subtype: 'nunchaku', atk: 12, hit: 70, price:    30, jobs: Mo|Ni }],  // Nunchuck
  [0x07, { type: 'weapon', subtype: 'nunchaku', atk: 20, hit: 80, price:   250, jobs: Mo|Ni }],  // Tonfa
  [0x08, { type: 'weapon', subtype: 'nunchaku', atk: 25, hit: 70, price:  1500, jobs: Mo|Ni }],  // Sanjiegun (3-Part)
];

// --- Rods (0x09–0x0D) ---
const RODS = [
  [0x09, { type: 'weapon', subtype: 'rod', atk:  5, hit: 60, price:   200, jobs: Ww|Bw|Rw|Co|Su|Sh|Wa|Sa|Ni }],  // Mythril Rod
  [0x0A, { type: 'weapon', subtype: 'rod', atk: 12, hit: 70, price:  1500, element: 'fire', jobs: Bw|Rw|Co|Su|Wa|Sa|Ni }],  // Flame Rod
  [0x0B, { type: 'weapon', subtype: 'rod', atk: 12, hit: 70, price:  1500, element: 'ice',  jobs: Bw|Rw|Co|Su|Wa|Sa|Ni }],  // Ice Rod
  [0x0C, { type: 'weapon', subtype: 'rod', atk: 12, hit: 70, price:  1500, element: 'bolt', jobs: Bw|Rw|Co|Su|Wa|Sa|Ni }],  // Light Rod
  [0x0D, { type: 'weapon', subtype: 'rod', atk: 20, hit: 80, price: 15000, effect: 'cast_break', jobs: Wa|Su|Sa|Ni }],  // Omnirod (Ultimate)
];

// --- Staves (0x0E–0x14) ---
const STAVES = [
  [0x0E, { type: 'weapon', subtype: 'staff', atk:  3, hit: 50, price:    20, jobs: Ww|Rw|Sh|Sa|Ni }],  // Staff
  [0x0F, { type: 'weapon', subtype: 'staff', atk: 15, hit: 50, price:  1250, element: 'fire', jobs: Ww|Rw|Sh|Sa|Ni }],  // Flame Staff (Burning)
  [0x10, { type: 'weapon', subtype: 'staff', atk: 15, hit: 50, price:  1250, element: 'ice',  jobs: Ww|Rw|Sh|Sa|Ni }],  // Ice Staff (Freezing)
  [0x11, { type: 'weapon', subtype: 'staff', atk: 15, hit: 50, price:  1250, element: 'bolt', jobs: Ww|Rw|Sh|Sa|Ni }],  // Light Staff (Shining)
  [0x12, { type: 'weapon', subtype: 'staff', atk:  8, hit: 70, price:  6750, effect: 'cast_break', strBonus: 5, jobs: Ww|Rw|Sh|Sa|Ni }],  // Golem Staff
  [0x13, { type: 'weapon', subtype: 'staff', atk: 28, hit: 80, price:  9000, jobs: Ww|Rw|Sh|Sa|Ni }],  // Rune Staff
  [0x14, { type: 'weapon', subtype: 'staff', atk: 20, hit: 90, price: 32500, intBonus: 5, mndBonus: 5, jobs: Sh|Sa|Ni }],  // Elder Staff (Eldest)
];

// --- Hammers & Axes (0x15–0x19, 0x2D, 0x32) ---
const HAMMERS_AXES = [
  [0x15, { type: 'weapon', subtype: 'hammer', atk: 25, hit: 60, price:   250, jobs: Vi|Ni }],  // Hammer (basic)
  [0x16, { type: 'weapon', subtype: 'hammer', atk: 30, hit: 70, price:  7000, element: 'bolt', jobs: Vi|Ni }],  // Mjolnir (Thor)
  [0x17, { type: 'weapon', subtype: 'axe',    atk: 45, hit: 60, price:  2750, jobs: Vi|Ni }],  // Battleaxe
  [0x18, { type: 'weapon', subtype: 'axe',    atk: 50, hit: 70, price:  4000, jobs: Vi|Ni }],  // Dual Haken (M.Star)
  [0x19, { type: 'weapon', subtype: 'axe',    atk: 75, hit: 80, price:  7000, jobs: Vi|Ni }],  // Sharur (GreatAxe)
  [0x2D, { type: 'weapon', subtype: 'axe',    atk: 60, hit: 80, price: 10000, jobs: Vi|Ni }],  // Dual Tomahawk (Tomohawk)
  [0x32, { type: 'weapon', subtype: 'hammer', atk: 85, hit: 80, price: 10000, jobs: Vi|Ni }],  // Triton
];

// --- Spears (0x1A–0x1D) ---
const SPEARS = [
  [0x1A, { type: 'weapon', subtype: 'spear', atk:  35, hit: 80, price:  4000, element: 'bolt', jobs: Dr|Ni }],  // Thunder Spear
  [0x1B, { type: 'weapon', subtype: 'spear', atk:  50, hit: 80, price:  5000, element: 'air',  jobs: Dr|Ni }],  // Wind Spear
  [0x1C, { type: 'weapon', subtype: 'spear', atk:  70, hit: 80, price: 10000, effect: 'drain_hp', jobs: Dr|Ni }],  // Blood Lance
  [0x1D, { type: 'weapon', subtype: 'spear', atk: 100, hit: 80, price: 22500, element: 'holy', jobs: Dr|Ni }],  // Holy Lance
];

// --- Knives (0x1E–0x23) ---
const KNIVES = [
  [0x1E, { type: 'weapon', subtype: 'knife', atk:  6, hit:  85, price:    10, jobs: On|Fi|Bw|Rw|Kn|Th|Ni }],  // Knife
  [0x1F, { type: 'weapon', subtype: 'knife', atk:  8, hit:  85, price:    30, jobs: On|Fi|Bw|Rw|Kn|Th|Ni }],  // Dagger
  [0x20, { type: 'weapon', subtype: 'knife', atk: 10, hit:  85, price:   250, jobs: On|Fi|Bw|Rw|Kn|Th|Ni }],  // Mythril Knife (Mithril)
  [0x21, { type: 'weapon', subtype: 'knife', atk: 30, hit: 100, price:  3500, jobs: Th|Ni }],  // Main Gauche (M.Gauche)
  [0x22, { type: 'weapon', subtype: 'knife', atk: 45, hit: 100, price:  6000, effect: 'drain_hp', jobs: Th|Ni }],  // Orichalcum (Orialcon)
  [0x23, { type: 'weapon', subtype: 'knife', atk: 60, hit: 100, price:  5000, element: 'air', jobs: Th|Ni }],  // Air Knife
];

// --- Swords (0x24–0x39, excluding katanas) ---
const SWORDS = [
  [0x24, { type: 'weapon', subtype: 'sword', atk:  10, hit:  80, price:    50, jobs: On|Fi|Kn|Ni }],  // Longsword (Long)
  [0x25, { type: 'weapon', subtype: 'sword', atk:  15, hit:  80, price:   500, element: 'holy', jobs: Rw|Ni }],  // Wind Slayer (W.Slayer)
  [0x26, { type: 'weapon', subtype: 'sword', atk:   5, hit:  20, price:  2500, jobs: Fi|Kn|Ni }],  // Gold Sword (Shiny)
  [0x27, { type: 'weapon', subtype: 'sword', atk:  15, hit:  85, price:   250, jobs: On|Fi|Kn|Ni }],  // Mythril Sword (Mithril)
  [0x28, { type: 'weapon', subtype: 'sword', atk:  25, hit:  80, price:   750, jobs: Fi|Kn|Ni }],  // Serpent Sword (Serpent)
  [0x29, { type: 'weapon', subtype: 'sword', atk:  40, hit:  80, price:  1500, element: 'ice', jobs: Fi|Kn|Ni }],  // Ice Blade
  [0x2A, { type: 'weapon', subtype: 'sword', atk:  29, hit:  75, price:  1000, jobs: Rw|Ni }],  // Tyrfing (Tyrving)
  [0x2B, { type: 'weapon', subtype: 'sword', atk:  32, hit:  80, price:  1500, element: 'fire', jobs: Fi|Kn|Ni }],  // Salamand
  [0x2C, { type: 'weapon', subtype: 'sword', atk:  50, hit:  80, price:  2500, jobs: Fi|Kn|Ni }],  // Royal Sword (King)
  [0x2E, { type: 'weapon', subtype: 'sword', atk:   5, hit:  80, price:  8250, effect: 'paralyze', jobs: Fi|Kn|Ni }],  // Ancient Sword (Ancient)
  [0x30, { type: 'weapon', subtype: 'sword', atk:  35, hit:  80, price:  8250, effect: 'drain_hp', jobs: Fi|Kn|Ni }],  // Blood Sword (Blood)
  [0x31, { type: 'weapon', subtype: 'sword', atk:  95, hit:  80, price:  8250, vitBonus: 5, jobs: Kn|Ni }],  // Defender
  [0x35, { type: 'weapon', subtype: 'sword', atk: 120, hit:  80, price: 15000, effect: 'cast_break', jobs: Kn|Ni }],  // Break Blade (Break)
  [0x36, { type: 'weapon', subtype: 'sword', atk: 160, hit:  80, price: 32500, element: 'holy', strBonus: 5, jobs: Kn|Ni }],  // Excalibur
  [0x38, { type: 'weapon', subtype: 'sword', atk: 180, hit: 100, price: 32750, strBonus: 5, vitBonus: 5, agiBonus: 5, jobs: Kn|Mk|Ni }],  // Ragnarok
  [0x39, { type: 'weapon', subtype: 'sword', atk: 200, hit: 100, price: 32500, strBonus: 5, agiBonus: 5, vitBonus: 5, jobs: On }],  // Onion Sword
];

// --- Katanas (0x2F, 0x33, 0x34, 0x37) ---
const KATANAS = [
  [0x2F, { type: 'weapon', subtype: 'katana', atk:  65, hit: 100, price: 10000, jobs: Mk|Ni }],  // Ashura
  [0x33, { type: 'weapon', subtype: 'katana', atk: 105, hit:  90, price: 10500, jobs: Mk|Ni }],  // Kotesu (Kotetsu)
  [0x34, { type: 'weapon', subtype: 'katana', atk: 125, hit: 100, price: 11000, jobs: Mk|Ni }],  // Chrysanth (Kiku)
  [0x37, { type: 'weapon', subtype: 'katana', atk: 160, hit:  90, price: 32500, agiBonus: 5, vitBonus: 5, jobs: Mk|Ni }],  // Masamune
];

// --- Books (0x3A–0x3E, 0x42) ---
const BOOKS = [
  [0x3A, { type: 'weapon', subtype: 'book', atk: 32, hit: 70, price:  1650, element: 'fire', jobs: Sc|Sa|Ni }],  // Fire Book (Flame)
  [0x3B, { type: 'weapon', subtype: 'book', atk: 32, hit: 70, price:  1650, element: 'ice',  jobs: Sc|Sa|Ni }],  // Ice Book
  [0x3C, { type: 'weapon', subtype: 'book', atk: 65, hit: 80, price:  7500, element: 'fire', jobs: Sc|Sa|Ni }],  // Fire Tome (Inferno)
  [0x3D, { type: 'weapon', subtype: 'book', atk: 32, hit: 70, price:  1650, element: 'bolt', jobs: Sc|Sa|Ni }],  // Light Book
  [0x3E, { type: 'weapon', subtype: 'book', atk: 65, hit: 80, price:  7500, element: 'bolt', jobs: Sc|Sa|Ni }],  // Light Tome (Illumina)
  [0x42, { type: 'weapon', subtype: 'book', atk: 65, hit: 80, price:  7500, element: 'ice',  jobs: Sc|Sa|Ni }],  // Ice Tome (Blizzard)
];

// --- Boomerangs (0x3F–0x40) ---
const BOOMERANGS = [
  [0x3F, { type: 'weapon', subtype: 'boomerang', atk:  35, hit:  70, price:  4500, jobs: Th|Ni }],  // Boomerang
  [0x40, { type: 'weapon', subtype: 'boomerang', atk: 160, hit:  90, price: 31000, jobs: Kn|Mk|Ni }],  // Moonring (FullMoon)
];

// --- Shuriken (0x41) ---
const SHURIKEN = [
  [0x41, { type: 'weapon', subtype: 'shuriken', atk: 200, hit: 100, price: 32750, jobs: Ni }],  // Shuriken
];

// --- Bells (0x43–0x45) ---
const BELLS = [
  [0x43, { type: 'weapon', subtype: 'bell', atk: 30, hit:  80, price: 2250, jobs: Ge|Ni }],  // Diamond Bell (Giyaman)
  [0x44, { type: 'weapon', subtype: 'bell', atk: 25, hit:  80, price: 2750, element: 'earth', effect: 'cast_break', jobs: Ge|Ni }],  // Earthen Bell (Earth)
  [0x45, { type: 'weapon', subtype: 'bell', atk: 40, hit: 100, price: 2750, jobs: Ge|Ni }],  // Rune Bell
];

// --- Harps (0x46, 0x48–0x49) ---
const HARPS = [
  [0x46, { type: 'weapon', subtype: 'harp', atk: 40, hit:  70, price:  4000, jobs: Ba|Ni }],  // Madhra Harp (Madora)
  [0x48, { type: 'weapon', subtype: 'harp', atk:  0, hit:  80, price: 10750, effect: 'confuse', jobs: Ba|Ni }],  // Lamia Harp
  [0x49, { type: 'weapon', subtype: 'harp', atk: 60, hit: 100, price: 20000, jobs: Ba|Ni }],  // Loki Harp
];

// --- Bows (0x4A–0x4E) ---
const BOWS = [
  [0x4A, { type: 'weapon', subtype: 'bow', atk:  5, hit:  90, price:    50, jobs: On|Fi|Rw|Hu|Ni }],  // Bow
  [0x4B, { type: 'weapon', subtype: 'bow', atk:  8, hit:  85, price:   600, jobs: On|Fi|Rw|Hu|Ni }],  // Great Bow
  [0x4C, { type: 'weapon', subtype: 'bow', atk: 15, hit:  85, price:  1000, jobs: Hu|Ni }],  // Killer Bow
  [0x4D, { type: 'weapon', subtype: 'bow', atk: 25, hit:  90, price:  1500, jobs: Hu|Ni }],  // Rune Bow
  [0x4E, { type: 'weapon', subtype: 'bow', atk: 50, hit: 100, price: 21000, jobs: Hu|Ni }],  // Yoichi Bow
];

// --- Arrows (0x4F–0x56) ---
const ARROWS = [
  [0x4F, { type: 'weapon', subtype: 'arrow', atk:  6, hit:  90, price:   2, jobs: On|Fi|Rw|Hu|Ni }],  // Wood Arrow
  [0x50, { type: 'weapon', subtype: 'arrow', atk: 13, hit:  85, price:   5, element: 'holy', jobs: On|Fi|Rw|Hu|Ni }],  // Holy Arrow
  [0x51, { type: 'weapon', subtype: 'arrow', atk: 17, hit:  85, price:   0, jobs: On|Fi|Rw|Hu|Ni }],  // Iron Arrow
  [0x52, { type: 'weapon', subtype: 'arrow', atk: 30, hit:  90, price:   5, element: 'bolt', jobs: Hu|Ni }],  // Bolt Arrow
  [0x53, { type: 'weapon', subtype: 'arrow', atk: 30, hit:  90, price:   5, element: 'fire', jobs: Hu|Ni }],  // Fire Arrow
  [0x54, { type: 'weapon', subtype: 'arrow', atk: 30, hit:  90, price:   5, element: 'ice',  jobs: Hu|Ni }],  // Ice Arrow
  [0x55, { type: 'weapon', subtype: 'arrow', atk: 20, hit: 100, price:  50, effect: 'cast_break', jobs: Hu|Ni }],  // Medusa Arrow
  [0x56, { type: 'weapon', subtype: 'arrow', atk: 70, hit: 100, price: 100, jobs: Hu|Ni }],  // Yoichi Arrow
];

// --- Shields (0x58–0x61) ---
const SHIELDS = [
  [0x58, { type: 'armor', subtype: 'shield', def:  3, evade:  3, mdef:  2, price:    20, jobs: On|Fi|Rw|Kn|Th|Dr|Vi|Ni }],  // Leather Shield
  [0x59, { type: 'armor', subtype: 'shield', def: 48, evade: 48, mdef: 48, price: 32500, jobs: On }],  // Onion Shield
  [0x5A, { type: 'armor', subtype: 'shield', def:  5, evade:  7, mdef:  7, price:    90, jobs: Rw|Kn|Th|Dr|Vi|Ni }],  // Mythril Shield
  [0x5B, { type: 'armor', subtype: 'shield', def:  8, evade:  9, mdef:  8, price:   900, resist: 'fire', jobs: On|Fi|Rw|Kn|Dr|Vi|Ni }],  // Ice Shield
  [0x5C, { type: 'armor', subtype: 'shield', def: 10, evade: 12, mdef: 12, price:  1750, jobs: Kn|Dr|Vi|Ni }],  // Heroic Shield
  [0x5D, { type: 'armor', subtype: 'shield', def: 12, evade: 24, mdef: 18, price: 25000, jobs: Mk|Ni }],  // Demon Shield
  [0x5E, { type: 'armor', subtype: 'shield', def: 13, evade: 14, mdef: 15, price:  9000, resist: 'bolt', jobs: Kn|Dr|Vi|Ni }],  // Diamond Shield
  [0x5F, { type: 'armor', subtype: 'shield', def: 16, evade: 17, mdef: 25, price: 14000, agiBonus: 5, jobs: Kn|Dr|Vi|Ni }],  // Aegis Shield
  [0x60, { type: 'armor', subtype: 'shield', def: 20, evade: 19, mdef: 35, price: 19000, strBonus: 5, agiBonus: 5, jobs: Mk|Ni }],  // Genji Shield
  [0x61, { type: 'armor', subtype: 'shield', def: 23, evade: 19, mdef: 30, price: 25000, strBonus: 5, agiBonus: 5, vitBonus: 5, jobs: On|Fi|Rw|Kn|Dr|Vi|Mk|Ni }],  // Crystal Shield
];

// --- Helmets (0x62–0x71) ---
const HELMETS = [
  [0x62, { type: 'armor', subtype: 'helmet', def:  1, evade:  1, mdef:  1, price:    15, jobs: ALL_BUT_MK }],  // Leather Cap
  [0x63, { type: 'armor', subtype: 'helmet', def: 48, evade: 48, mdef: 48, price: 32500, jobs: On }],  // Onion Helm
  [0x64, { type: 'armor', subtype: 'helmet', def:  3, evade:  3, mdef:  3, price:   175, jobs: On|Fi|Rw|Kn|Th|Dr|Vi|Ni }],  // Mythril Helm
  [0x65, { type: 'armor', subtype: 'helmet', def:  4, evade:  4, mdef:  4, price:   625, jobs: On|Fi|Kn|Dr|Vi|Ni }],  // Shell Helm (Carapace)
  [0x66, { type: 'armor', subtype: 'helmet', def:  5, evade:  6, mdef:  4, price:  1200, resist: 'fire', weak: 'ice', jobs: Fi|Rw|Hu|Kn|Th|Dr|Vi|Ni }],  // Ice Helm
  [0x67, { type: 'armor', subtype: 'helmet', def:  4, evade:  6, mdef:  4, price:   600, jobs: Mo|Ka|Ni }],  // Headband
  [0x68, { type: 'armor', subtype: 'helmet', def:  5, evade: 10, mdef:  6, price:  3750, jobs: Ww|Bw|Sc|Sh|Wa|Sa|Ni }],  // Scholar Hat
  [0x69, { type: 'armor', subtype: 'helmet', def:  5, evade:  8, mdef:  5, price:  1000, strBonus: 5, jobs: Th|Ni }],  // Black Cowl (DarkHood)
  [0x6A, { type: 'armor', subtype: 'helmet', def:  5, evade: 10, mdef:  6, price:  1000, strBonus: 5, vitBonus: 5, jobs: Mo|Ka|Ni }],  // Chakra Band
  [0x6B, { type: 'armor', subtype: 'helmet', def: 10, evade:  8, mdef:  7, price:  2000, jobs: Vi|Ni }],  // Viking Helm
  [0x6C, { type: 'armor', subtype: 'helmet', def: 15, evade: 10, mdef:  7, price:  4000, jobs: Dr|Ni }],  // Dragon Helm
  [0x6D, { type: 'armor', subtype: 'helmet', def:  7, evade:  9, mdef:  8, price:  4000, agiBonus: 5, jobs: Hu|Sc|Ge|Co|Ba|Su|Sh|Wa|Sa|Ni }],  // Feather Hat
  [0x6E, { type: 'armor', subtype: 'helmet', def: 18, evade: 10, mdef: 10, price: 16500, resist: 'bolt', jobs: Kn|Dr|Vi|Ni }],  // Diamond Helm
  [0x6F, { type: 'armor', subtype: 'helmet', def: 24, evade: 20, mdef: 15, price: 20000, jobs: Mk|Ni }],  // Genji Helm
  [0x70, { type: 'armor', subtype: 'helmet', def: 28, evade: 20, mdef: 18, price: 32500, jobs: On|Fi|Rw|Kn|Dr|Vi|Mk|Ni }],  // Crystal Helm
  [0x71, { type: 'armor', subtype: 'helmet', def:  9, evade: 10, mdef: 10, price:     5, effect: 'all_status', jobs: ALL }],  // Ribbon
];

// --- Body Armor (0x72–0x8A) ---
const BODY_ARMOR = [
  [0x72, { type: 'armor', subtype: 'body', def:  1, evade:  0, mdef:  0, price:   25, jobs: ALL_BUT_MK }],  // Vest (Cloth)
  [0x73, { type: 'armor', subtype: 'body', def:  2, evade:  1, mdef:  1, price:    7, jobs: ALL_BUT_MK }],  // Leather Armor
  [0x74, { type: 'armor', subtype: 'body', def: 48, evade: 48, mdef: 48, price: 32750, jobs: On }],  // Onion Armor
  [0x75, { type: 'armor', subtype: 'body', def:  2, evade:  4, mdef:  4, price:   65, jobs: On|Fi|Rw|Hu|Kn|Dr|Vi|Ni }],  // Mythril Armor
  [0x76, { type: 'armor', subtype: 'body', def:  3, evade:  5, mdef:  3, price:  225, jobs: Fi|Hu|Kn|Dr|Vi|Ni }],  // Shell Armor (Carapace)
  [0x77, { type: 'armor', subtype: 'body', def:  4, evade:  6, mdef:  6, price:  600, resist: 'ice', jobs: Fi|Hu|Kn|Dr|Vi|Ni }],  // Ice Armor
  [0x78, { type: 'armor', subtype: 'body', def:  5, evade:  6, mdef:  4, price: 1200, element: 'fire', jobs: Fi|Hu|Kn|Dr|Vi|Ni }],  // Flame Mail
  [0x79, { type: 'armor', subtype: 'body', def:  6, evade:  8, mdef:  3, price:  600, jobs: Mo|Ka|Ni }],  // Kenpo Gi
  [0x7A, { type: 'armor', subtype: 'body', def:  8, evade: 70, mdef:  5, price: 1900, agiBonus: 5, jobs: Th|Ni }],  // Black Garb (DarkSuit)
  [0x7B, { type: 'armor', subtype: 'body', def:  9, evade:  7, mdef:  7, price: 1000, jobs: Ww|Bw|Rw|Co|Su|Sh|Wa|Sa|Ni }],  // Mage Robe (Wizard)
  [0x7C, { type: 'armor', subtype: 'body', def:  7, evade: 10, mdef:  7, price: 1500, jobs: Vi|Ni }],  // Viking Mail
  [0x7D, { type: 'armor', subtype: 'body', def: 12, evade: 11, mdef:  5, price: 1900, agiBonus: 5, jobs: Mo|Ka|Ni }],  // Black Belt (robe)
  [0x7E, { type: 'armor', subtype: 'body', def: 12, evade:  9, mdef:  7, price: 3750, jobs: Kn|Ni }],  // Knight Armor
  [0x7F, { type: 'armor', subtype: 'body', def:  7, evade: 10, mdef:  7, price: 14000, jobs: Dr|Ni }],  // Dragon Mail
  [0x80, { type: 'armor', subtype: 'body', def: 15, evade: 12, mdef:  7, price: 2750, atkPenalty: 6, jobs: Ba|Ni }],  // Bard Vest
  [0x81, { type: 'armor', subtype: 'body', def: 15, evade: 12, mdef:  7, price: 2500, jobs: Ww|Bw|Sc|Sh|Wa|Sa|Ni }],  // Scholar Robe
  [0x82, { type: 'armor', subtype: 'body', def: 16, evade: 12, mdef:  8, price: 2100, jobs: Ge|Ni }],  // Gaia Vest
  [0x83, { type: 'armor', subtype: 'body', def: 17, evade: 15, mdef:  9, price: 12500, jobs: Mk|Ni }],  // Demon Mail
  [0x84, { type: 'armor', subtype: 'body', def:  8, evade: 12, mdef:  9, price: 10000, resist: 'bolt', jobs: Kn|Dr|Vi|Ni }],  // Diamond Mail
  [0x85, { type: 'armor', subtype: 'body', def: 20, evade: 12, mdef: 12, price: 12500, jobs: Kn|Dr|Vi|Ni }],  // Reflect Mail
  [0x86, { type: 'armor', subtype: 'body', def: 20, evade: 12, mdef: 14, price:  3500, mndBonus: 5, jobs: Ww|Rw|Co|Su|Sh|Sa|Ni }],  // White Robe
  [0x87, { type: 'armor', subtype: 'body', def: 20, evade: 12, mdef: 14, price:  3500, intBonus: 5, jobs: Bw|Rw|Co|Su|Wa|Sa|Ni }],  // Black Robe
  [0x88, { type: 'armor', subtype: 'body', def: 10, evade: 12, mdef: 11, price: 16000, jobs: Mk|Ni }],  // Genji Armor
  [0x89, { type: 'armor', subtype: 'body', def: 12, evade: 15, mdef: 12, price: 25000, jobs: On|Fi|Rw|Kn|Dr|Vi|Mk|Ni }],  // Crystal Mail
  [0x8A, { type: 'armor', subtype: 'body', def:  0, evade:  0, mdef:  0, price:   50, effect: 'unequippable', jobs: 0 }],  // Rusty Mail
];

// --- Arms: Bracers, Gloves & Rings (0x8B–0x97) ---
const ARMS = [
  [0x8B, { type: 'armor', subtype: 'arms', def:  1, evade:  5, mdef:  2, price:    80, jobs: Ww|Bw|Rw|Sc|Ge|Co|Su|Sh|Wa|Sa|Ni }],  // Bronze Bracers (Copper Ring)
  [0x8C, { type: 'armor', subtype: 'arms', def: 32, evade: 32, mdef: 32, price: 32500, strBonus: 5, agiBonus: 5, vitBonus: 5, jobs: On }],  // Onion Gloves
  [0x8D, { type: 'armor', subtype: 'arms', def:  2, evade:  7, mdef:  3, price:    60, jobs: On|Fi|Rw|Kn|Dr|Vi|Ni }],  // Mythril Gloves
  [0x8E, { type: 'armor', subtype: 'arms', def:  2, evade:  7, mdef:  3, price:    60, jobs: Ww|Bw|Rw|Sc|Ge|Co|Su|Sh|Wa|Sa|Ni }],  // Mythril Bracers (Mithril Ring)
  [0x8F, { type: 'armor', subtype: 'arms', def:  3, evade:  9, mdef:  4, price:  1250, strBonus: 5, jobs: Th|Ni }],  // Thief Gloves
  [0x90, { type: 'armor', subtype: 'arms', def:  2, evade:  8, mdef:  3, price:  1250, jobs: Kn|Dr|Vi|Ni }],  // Gauntlets
  [0x91, { type: 'armor', subtype: 'arms', def:  4, evade: 11, mdef:  1, price:  1250, strBonus: 5, jobs: Fi|Mo|Rw|Hu|Kn|Th|Sc|Ge|Dr|Vi|Ka|Ba|Ni }],  // Power Bracers (Power Ring)
  [0x92, { type: 'armor', subtype: 'arms', def:  5, evade: 10, mdef:  6, price:  2500, jobs: Ww|Bw|Rw|Sc|Ge|Co|Su|Sh|Wa|Sa|Ni }],  // Rune Bracers
  [0x93, { type: 'armor', subtype: 'arms', def:  6, evade: 12, mdef:  6, price:  5000, resist: 'bolt', jobs: Ww|Bw|Rw|Sc|Ge|Co|Su|Sh|Wa|Sa|Ni }],  // Diamond Bracers (Diamond Ring)
  [0x94, { type: 'armor', subtype: 'arms', def:  6, evade: 10, mdef:  6, price:  7500, resist: 'bolt', jobs: Kn|Dr|Vi|Ni }],  // Diamond Gloves
  [0x95, { type: 'armor', subtype: 'arms', def:  9, evade: 15, mdef:  7, price: 15000, vitBonus: 5, jobs: ALL_BUT_MK }],  // Protect Ring
  [0x96, { type: 'armor', subtype: 'arms', def:  9, evade: 15, mdef:  7, price: 15000, jobs: Mk|Ni }],  // Genji Gloves
  [0x97, { type: 'armor', subtype: 'arms', def: 10, evade: 15, mdef: 10, price: 25000, jobs: On|Fi|Rw|Kn|Dr|Vi|Mk|Ni }],  // Crystal Gloves
];

// --- Story / Key Items (0x98–0xA4) ---
const KEY_ITEMS = [
  [0x98, { type: 'key', effect: 'open_lock',        price:  50 }],  // Magic Key
  [0x99, { type: 'key', effect: 'summon_chocobo',   price:  75 }],  // Gysahl Greens (Carrot)
  [0x9A, { type: 'key', effect: 'story',            price:   0 }],  // Dwarf Horn
  [0x9B, { type: 'key', effect: 'story',            price:   0 }],  // Nepto Eye
  [0x9C, { type: 'key', effect: 'story',            price:   0 }],  // Time Wheel
  [0x9D, { type: 'key', effect: 'story',            price:   0 }],  // Eureka Key
  [0x9E, { type: 'key', effect: 'story',            price:   0 }],  // Wind Fang
  [0x9F, { type: 'key', effect: 'story',            price:   0 }],  // Fire Fang
  [0xA0, { type: 'key', effect: 'story',            price:   0 }],  // Water Fang
  [0xA1, { type: 'key', effect: 'story',            price:   0 }],  // Earth Fang
  [0xA2, { type: 'key', effect: 'story',            price:   0 }],  // Noah's Lute
  [0xA3, { type: 'key', effect: 'story',            price:   0 }],  // Syrcus Key
  [0xA4, { type: 'key', effect: 'story',            price:   0 }],  // Gnome Bread
];

// --- Consumables (0xA6–0xC7) ---
const CONSUMABLES = [
  [0xA6, { type: 'consumable', effect: 'restore_hp',   value:  300, price:   75 }],  // Potion
  [0xA7, { type: 'consumable', effect: 'restore_hp',   value:  500, price:  600 }],  // Hi-Potion
  [0xA8, { type: 'consumable', effect: 'restore_all',  value:    0, price: 1500 }],  // Elixir
  [0xA9, { type: 'consumable', effect: 'revive',       value:    0, price: 1500 }],  // Phoenix Down (FenixDown)
  [0xAA, { type: 'consumable', effect: 'cure_petrify', value:    0, price:  200 }],  // Gold Needle
  [0xAB, { type: 'consumable', effect: 'cure_toad',    value:    0, price:   50 }],  // Maiden Kiss (MaidenKiss)
  [0xAC, { type: 'consumable', effect: 'cure_silence', value:    0, price:   50 }],  // Echo Herbs
  [0xAD, { type: 'consumable', effect: 'toggle_mini',  value:    0, price:   50 }],  // Mallet (LuckMallet)
  [0xAE, { type: 'consumable', effect: 'cure_blind',   value:    0, price:   20 }],  // Eye Drops
  [0xAF, { type: 'consumable', effect: 'cure_poison',  value:    0, price:   40 }],  // Antidote
  [0xB1, { type: 'battle_item', subtype: 'fire',   effect: 'damage_enemies', value: 1, price:  500 }],  // Bomb Shard
  [0xB2, { type: 'battle_item', subtype: 'ice',    effect: 'damage_enemies', value: 1, price:  500 }],  // South Wind
  [0xB3, { type: 'battle_item', subtype: 'bolt',   effect: 'damage_enemies', value: 1, price:  500 }],  // Zeus' Wrath
  [0xB4, { type: 'battle_item', subtype: 'fire',   effect: 'damage_enemies', value: 2, price:  750 }],  // Bomb Arm
  [0xB5, { type: 'battle_item', subtype: 'ice',    effect: 'damage_enemies', value: 2, price:  750 }],  // Arctic Wind (NorthWind)
  [0xB6, { type: 'battle_item', subtype: 'bolt',   effect: 'damage_enemies', value: 2, price:  750 }],  // God's Wrath
  [0xB7, { type: 'battle_item', subtype: 'earth',  effect: 'damage_all',     value: 2, price: 1250 }],  // Earth Drum
  [0xB8, { type: 'battle_item', subtype: 'confuse',effect: 'status_enemy',   value: 0, price: 1500 }],  // Lamia Scale
  [0xB9, { type: 'battle_item', subtype: 'haste',  effect: 'status_ally',    value: 0, price: 1500 }],  // Bachus Wine (Gods'Wine)
  [0xBA, { type: 'battle_item', subtype: 'defense',effect: 'status_ally',    value: 0, price: 1500 }],  // Turtle Shell
  [0xBB, { type: 'battle_item', subtype: 'kill',   effect: 'damage_all',     value: 0, price: 1500 }],  // Devil Note (Devil'sSigh)
  [0xBC, { type: 'battle_item', subtype: 'erase',  effect: 'status_enemy',   value: 0, price: 2000 }],  // Black Hole
  [0xBD, { type: 'battle_item', subtype: 'death',  effect: 'status_enemy',   value: 0, price: 2500 }],  // Black Musk (DarkScent)
  [0xBE, { type: 'battle_item', subtype: 'drain',  effect: 'damage_enemies', value: 0, price: 1500 }],  // Lilith Kiss (LilithKiss)
  [0xBF, { type: 'battle_item', subtype: 'sleep',  effect: 'status_enemy',   value: 0, price: 1000 }],  // Raven's Yawn
  [0xC1, { type: 'battle_item', subtype: 'paralyze',effect: 'status_enemy',  value: 0, price: 1500 }],  // Tranquilizer (Paralyzer)
  [0xC3, { type: 'battle_item', subtype: 'sleep',  effect: 'status_enemy',   value: 0, price: 1000 }],  // Sheep Pillow (Pillow)
  [0xC5, { type: 'battle_item', subtype: 'reflect',effect: 'status_ally',    value: 0, price: 2500 }],  // Curtain (Barrier)
  [0xC6, { type: 'battle_item', subtype: 'nonelem',effect: 'damage_enemies', value: 3, price: 2500 }],  // Chocobo Rage
  [0xC7, { type: 'battle_item', subtype: 'holy',   effect: 'damage_enemies', value: 3, price: 2500 }],  // White Musk (WhiteScent)
];

export const ITEMS = new Map([
  ...CLAWS, ...NUNCHAKU, ...RODS, ...STAVES,
  ...HAMMERS_AXES, ...SPEARS, ...KNIVES, ...SWORDS, ...KATANAS,
  ...BOOKS, ...BOOMERANGS, ...SHURIKEN, ...BELLS, ...HARPS,
  ...BOWS, ...ARROWS,
  ...SHIELDS, ...HELMETS, ...BODY_ARMOR, ...ARMS,
  ...KEY_ITEMS, ...CONSUMABLES,
]);

export function isHandEquippable(itemData) {
  return itemData && (itemData.type === 'weapon' || (itemData.type === 'armor' && itemData.subtype === 'shield'));
}
export function isWeapon(id) {
  const item = ITEMS.get(id);
  return !!(item && item.type === 'weapon');
}
export function weaponSubtype(id) {
  const item = ITEMS.get(id);
  return (item && item.type === 'weapon') ? item.subtype : null;
}
export function isBladedWeapon(id) {
  const st = weaponSubtype(id);
  return st === 'knife' || st === 'sword';
}
