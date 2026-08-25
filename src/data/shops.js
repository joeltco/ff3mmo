// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
//
// A ROM record has N FIELDS. If you use fewer than N, YOU HAVE NOT READ IT —
// you have guessed while holding the answer. This banner exists because that
// happened over and over in one day:
//
//   * FF3's NPC record is {id, x, y, FLAGS}. The flags byte was DISASSEMBLED
//     (bits 2-3 = FACING, bits 4-7 = MOVEMENT) and then DROPPED on the floor,
//     so ten Ur townsfolk shipped frozen in "random spots" facing wrong.
//   * Cid took THREE releases and Joel pointing at the tile — while
//     `npc-dump.mjs 12` had printed `id $2c @(6,23) ... DRAWN` the whole time.
//   * `$67` was called the "black magic sign" without checking its ATTRIBUTE
//     palette. It is the same star on pal1, the TREE/WOOD palette. Green
//     corners shipped.
//   * Characters were identified from `npcId + 0x202` instead of by RENDERING
//     THE SPRITE — which put Cid's line on the Castle Sasune gate guard.
//   * `check-shops` asked `findShopAtCounter` for the shop's OWN coords, so it
//     agreed with itself wherever the counter pointed.
//   * "0 of 28 bundles match" was a `+0x10` applied twice. SELF-TEST THE
//     INSTRUMENT BEFORE BELIEVING A NEGATIVE.
//
// BEFORE YOU SAY "DONE", ANSWER THIS OUT LOUD:
//   List every field/byte/column of the record you just read. Point at the line
//   of code that CONSUMES each one. If any field is unconsumed, you are NOT
//   done — wire it or say plainly which one you dropped and why.
//
// AND: RENDER IT AND LOOK. `map-png --grid --box`, `tileset-sheet.mjs`,
// `npc-sheet-ff3.mjs`, `npc-cast.cjs`. "The code looks right" is not a check.
// ═══════════════════════════════════════════════════════════════════════════
// Shop Catalog — store inventories, keyed by shop ID
//
// Item IDs reference ROM item table; names + prices come from items.js / text
// decoder at runtime.
// `mapId` + `counter` identify the tile that opens this shop on Z-press.
// `type` ('weapon'|'armor'|'item'|'magic') drives the FF1-style shopkeeper
// sprite lookup in `data/shop-sprites.js` — render path no-ops when sprite
// data hasn't been captured yet for a given type.

export const SHOPS = new Map([
  // --- Town of Ur ---
  ['ur_weapon', {
    type: 'weapon',
    // Counter on the ROM's marker tile (id231 @(3,23)) — see town-npcs.js.
    mapId: 5, counter: { x: 3, y: 23 },
    items: [0x1F, 0x24, 0x0E, 0x06, 0x4A, 0x4F, 0x50, 0x51],
    // Dagger, Longsword, Staff, Nunchuck, Bow, Wooden/Holy/Iron arrows.
    // The bow tier stocked here is the one an Onion Knight can actually hold:
    // Bow $4A and arrows $4F/$50/$51 all include job bit 0, while the later
    // bows ($4C+) are Ranger/Ninja only and Ranger is unreachable at MAX_LEVEL 5.
    // Three arrow types so the ammo choice is real — Holy carries its element.
  }],
  ['ur_armor', {
    type: 'armor',
    mapId: 4, counter: { x: 3, y: 5 },
    items: [0x73, 0x58, 0x62, 0x8B],
    // Leather Armor, Leather Shield, Leather Cap, Bronze Bracers
  }],
  ['ur_item', {
    type: 'item',
    mapId: 8, counter: { x: 8, y: 15 },
    items: [0xA6, 0xAE, 0xAF],
    // Potion, Eye Drops, Antidote
  }],
  // --- Town of Kazus ---
  //
  // Catalogs CAPTURED from the running game: `POKE=0x609d node
  // tools/monscan/shop-probe.cjs 16` opens the real shop (Kazus is cursed and
  // its shops stay shut until $609D is set — docs/KAZUS.md) and the stock reads
  // off the screen with prices. Item ids resolved by decoding the name bytes,
  // which share a "Mythril" prefix, NOT by matching price alone.
  //
  // Counters mirror Ur's because the rooms are byte-identical layouts — map
  // 16's column x=3 matches map 5 tile for tile, counter tile $1d at y=15
  // included. MEASURED: the ROM's shop-marker NPC sits at (3,23) on map 16,
  // which is bare floor.
  // ⭐ THE PUB'S ITEM COUNTER (v1.10.73). There is a keeper standing behind the
  // bar in Kazus's pub — ROM record $2e @(9,23) — and nothing opened when you
  // faced him. He is the inn item shopkeeper, wired here.
  //
  // Geometry is Ur's inn item shop, tile for tile: keeper BEHIND the counter,
  // counter tile SOLID between them, player in front.
  //     ur_item     keeper (8,14)  counter (8,15)  player (8,16)
  //     kazus_item  keeper (9,23)  counter (9,24)  player (9,25)
  // (9,24) is the bar slab itself and (9,25) is the stool in front of it.
  //
  // ⚠ CHOSEN, not captured — like `kazus_magic` and for the same reason: the
  // cartridge has NO item shop in Kazus at all (its shop maps are 15 magic, 16
  // weapon, 17 armor), so `shop-probe.cjs` has nothing to open and read. This
  // is ff3mmo's own counter. The ITEM IDS are real and decoded off the ROM's
  // name table, not invented: 0xA6 Potion, 0xAF Antidote, 0xAE Eyedrop,
  // 0xAC EchoHerb, 0xAB MaidKiss.
  //
  // Stocked a tier ABOVE Ur in BREADTH, not power — Ur sells Potion / Eyedrop /
  // Antidote, and Kazus adds the two cheap status cures Ur has no answer for.
  // No HiPotion (1200g): that would outclass every weapon on sale in the town.
  ['kazus_item', {
    type: 'item',
    mapId: 12, counter: { x: 9, y: 24 },
    items: [0xA6, 0xAF, 0xAE, 0xAC, 0xAB],
    // Potion 150, Antidote 80, Eyedrop 40, EchoHerb 100, MaidKiss 100
  }],
  ['kazus_weapon', {
    type: 'weapon',
    // Counter on the ROM's marker tile (id232 @(3,23)), mirroring Ur map 5.
    mapId: 16, counter: { x: 3, y: 23 },
    items: [0x09, 0x20, 0x27],
    // MythrilRod 400, MythrilKnife 500, MythrilSwrd 500 — captured stock, in
    // captured order. A tier above Ur, whose dearest is a 100 gil Longsword.
  }],
  ['kazus_armor', {
    type: 'armor',
    mapId: 17, counter: { x: 3, y: 5 },
    items: [0x75, 0x5a, 0x64, 0x8d, 0x8e],
    // MythrilArmor 350, MythrilShield 180, MythrilHelm 180, MythrilGlv 120,
    // MythrilBrc 120. Our ITEMS price for the helm (0x64) is 130 where the ROM
    // shop asks 180; the catalog is the id list, prices come from ITEMS.
  }],
  ['kazus_magic', {
    type: 'magic',
    school: 'black',
    mapId: 15, counter: { x: 4, y: 4 },
    // ⭐ KAZUS IS THE BLACK MAGIC SHOP (v1.10.74) — all three level-1 BLACK
    // spells: 0xE0 -> 49 Fire, 0xE1 -> 50 Ice, 0xE2 -> 51 Sleep.
    // Ice2 (0xE6, spell 58, 700 gil) is GONE. It was the "reach purchase" of a
    // catalog that was already flagged as chosen-not-captured, and it is a
    // level-0 spell — a tier the town has no business selling.
    items: [0xE0, 0xE1, 0xE2],
    // ⚠ CHOSEN, not captured — the only Kazus catalog that is. Map 15 is a
    // round chamber with spell orbs on pedestals rather than a counter room,
    // which is how FF3 sells magic (walk to an ORB, buy that one spell), so
    // shop-probe's walk-to-the-counter cannot reach a trigger that isn't there.
    // Picked one tier above Ur's lone Pure scroll: Fire, Bzzard, and Ice2 (700
    // gil) as the reach purchase. Replace once a per-orb probe lands.
    //
    // The KEEPER is placed by map-loading.js via addBlackMageShopkeeper(4,4,
    // 'kazus_magic'), exactly as Ur's is — on the counter tile, carrying the
    // shopId that opens this menu.
  }],
  ['ur_magic', {
    type: 'magic',
    // ⭐ SCHOOL drives BOTH the keeper's job sprite and the shop-menu keeper
    // art. Without it `FF3MMO_TO_FF1` sent every magic shop to the
    // 'white-magic' picture, so Kazus sold black magic under a White Mage.
    school: 'white',
    mapId: 3, counter: { x: 4, y: 4 },
    // ⭐ UR IS THE WHITE MAGIC SHOP (v1.10.74) — all three level-1 WHITE
    // spells, where it used to sell the single Pure scroll.
    //   0xE3 -> spell 52 Cure   0xE4 -> 53 Pure   0xE5 -> 54 Sight
    // Schools are not guessed: `getSpellSchool()` in data/spells.js reports
    // 52/53/54 white and 49/50/51 black, and the scroll->spell mapping is each
    // item's own `learnedSpell`. Sells the SCROLL; the player learns by using
    // it from the bag (`pause-menu.js#_applyScrollLearn`). Type stays 'magic'
    // for the keeper-sprite lookup; the catalog routes through the normal
    // item-shop buy/sell flow.
    items: [0xE3, 0xE4, 0xE5],
  }],
]);

// Derive shop type from a shopId. Falls back to inferring from the data
// shape so legacy callers without an explicit `type` still resolve.
export function getShopType(shopId) {
  const shop = SHOPS.get(shopId);
  if (!shop) return null;
  if (shop.type) return shop.type;
  return shop.spells ? 'magic' : 'item';
}

// Reverse lookup: which shop sits at this counter tile?
// Returns shopId string or null.
export function findShopAtCounter(mapId, x, y) {
  for (const [id, shop] of SHOPS) {
    if (shop.mapId === mapId && shop.counter && shop.counter.x === x && shop.counter.y === y) return id;
  }
  return null;
}
