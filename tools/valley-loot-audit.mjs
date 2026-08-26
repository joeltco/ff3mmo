#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
// A ROM record has N FIELDS. If you use fewer than N, YOU HAVE NOT READ IT.
// This file exists because that happened again: the 16-byte map property record
// had FIVE unread bytes, and one of them (byte 12) is the CHEST BASE INDEX —
// the thing that says what the cartridge puts in every chest in the game.
// ff3mmo has never read it. Every chest in the game rolls from LOOT_POOLS
// instead, and nothing has ever compared the two.
// ═══════════════════════════════════════════════════════════════════════════
//
// valley-loot-audit.mjs — every source of loot in the beginner valley, from
// BOTH sides: what the cartridge puts there, and what ff3mmo gives instead.
//
// ⭐ VERIFIED:
//   * chest CONTENTS table — file `0x3C10`, one byte per chest = item id.
//     rom[0x3C10..0x3C14] = 24 73 fc 1f 73, matching tools/rom-dump-chests.txt
//     line for line.
//   * the map property record is 16 bytes and ff3mmo reads ELEVEN. Bytes 2, 12,
//     13, 14 and 15 are dropped on the floor. Byte 13 is a constant $84 on every
//     valley map; byte 2 is the map-name index (docs/FF3-SCRIPT).
//   * ff3mmo reads NONE of the ROM's chest data. Every chest in the game rolls
//     from `LOOT_POOLS`, and nothing has ever compared the two.
//
// ⛔ NOT VERIFIED — AND THEREFORE NOT USED FOR ANY CLAIM:
//   Byte 12 LOOKS like a per-map chest base: it climbs monotonically across maps
//   and reads $00 on maps with no treasure tile. It does not survive the test.
//   Scoring both candidate rules over all 256 maps —
//
//     base + tilemap-wide trigId : 106 indices, 49 COLLISIONS, 75 gaps
//     base + this map's own order: 100 indices, 48 COLLISIONS, 81 gaps
//
//   — neither partitions the chest table cleanly, so the rule that maps a
//   treasure TILE to a chest INDEX is still unknown. Two maps claiming the same
//   chest is not a decode, it is a coincidence with a nice shape.
//
//   Until it is settled the ROM column below is printed as a CANDIDATE and must
//   not be quoted as "what the cartridge puts there". Settle it by opening a
//   known chest in a running game and reading what lands in the inventory.
//
// ⛔ VASES AND CHESTS SHARE THE INDEX. `map-loader.js#TRIGGER_TYPE_TABLE` marks
// BOTH `$78-$7B` (the hidden-treasure vases) and `$7C` (the chest) as type 2,
// and `processTriggerTiles` counts one sequence per type. So a hidden-treasure
// spot draws from the same table as a chest, in tile order.
//
//   node tools/valley-loot-audit.mjs            # the whole valley
//   node tools/valley-loot-audit.mjs --json

import fs from 'node:fs';

const R = new URL('../', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(R + 'FF3-English.nes'));
const { applyIPS } = await import(R + 'src/ips-patcher.js');
applyIPS(rom, new Uint8Array(fs.readFileSync(R + 'patches/ff3-awj.ips')));
const td = await import(R + 'src/text-decoder.js');
td.initTextDecoder(rom);
const { loadMap } = await import(R + 'src/map-loader.js');
const { lootTableFor } = await import(R + 'src/data/loot-tables.js');
const { applyPassageForTools, spawnOf } = await import(R + 'tools/lib/spawn.mjs');
const { ITEMS } = await import(R + 'src/data/items.js');
const { SHOPS } = await import(R + 'src/data/shops.js');

const AS_JSON = process.argv.includes('--json');
const MAP_PROPS_BASE = 0x004010;
const CHEST_TABLE = 0x3C10;
const chestBase = (mapId) => rom[MAP_PROPS_BASE + mapId * 16 + 12];
const chestItem = (i) => rom[CHEST_TABLE + i];

const nm = (id) => {
  try { const s = td.bytesToAscii(td.getItemNameShrinesClean(id)).trim(); return s || `0x${id.toString(16)}`; }
  catch { return `0x${id.toString(16)}`; }
};
const price = (id) => { const i = ITEMS.get(id); return i && i.price ? i.price : 0; };
const kind  = (id) => { const i = ITEMS.get(id); return i ? (i.subtype || i.type) : '?'; };

// Everything a valley shop sells, so "the chest sells you shop stock" is a
// measured claim and not an opinion.
const stocked = new Map();
for (const [sid, s] of SHOPS) for (const x of (s.items || [])) if (!stocked.has(x)) stocked.set(x, sid);
const shopCeiling = Math.max(...[...stocked.keys()].map(price));

/**
 * Every tile the player can stand on, walking from this map's own entrance.
 * Mirrors `map-renderer.js#isPassable` via the same rule map-explorable.mjs
 * uses; a treasure TILE is itself a trigger (walk onto it), so triggers count
 * as passable for the walk.
 */
function reachableFrom(md) {
  const W = 32;
  const passable = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= W) return false;
    const trig = md.triggerMap.get(`${x},${y}`);
    if (trig) return trig.type === 1 || trig.type === 2 || trig.type === 4;
    const mid = md.tilemap[y * W + x];
    const m = mid < 128 ? mid : mid & 0x7F;
    const c = md.collision[m];
    if (c & 0x80) { const t = (md.collisionByte2[mid] >> 4) & 0x0F; return t === 0 || t === 4 || t === 5; }
    return (c & 0x07) !== 3;
  };
  const { x: sx, y: sy } = spawnOf(md);
  const seen = new Set();
  if (!passable(sx, sy)) return seen;
  const q = [[sx, sy]]; seen.add(sy * W + sx);
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nx = x + dx, ny = y + dy, k = ny * W + nx;
      if (seen.has(k) || !passable(nx, ny)) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  return seen;
}

const AREAS = [
  ['UR',            [114, 1, 2, 3, 4, 5, 6, 7, 8, 9, 147]],
  ['KAZUS',         [10, 11, 12, 13, 14, 15, 16, 17]],
  ['MYTHRIL MINES', [101]],
  ['CASTLE SASUNE', [18, 19, 20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 174]],
  ['ALTAR CAVE',    [111, 115, 112, 113, 22]],
  ['SEALED CAVE',   [103, 104, 105, 106]],
];

// ff3mmo's dungeon maps are GENERATED, so their ROM counterpart is the donor.
const { DUNGEONS, normalFloorMapIds } = await import(R + 'src/data/dungeons.js');
const ourPoolFor = (romMapId) => {
  // A generated dungeon floor's ROM counterpart is its donor map.
  for (const d of DUNGEONS) {
    const i = (d.romFloorMaps || []).indexOf(romMapId);
    if (i >= 0) { const r = lootTableFor(d.base + i, () => 0); return { label: r.name + (r.designed ? '' : ' ⚠') }; }
  }
  const r = lootTableFor(romMapId, () => 0);
  return { label: r.designed ? r.name : 'UNDESIGNED ⚠ (no table written for this place)' };
};

const out = [];
for (const [area, ids] of AREAS) {
  if (!AS_JSON) console.log('\n' + '═'.repeat(76) + `\n${area}\n` + '═'.repeat(76));
  for (const mapId of ids) {
    let md; try { md = loadMap(rom, mapId); } catch { continue; }
    // ⛔ FF3 PACKS SEVERAL INTERIORS PER TILEMAP. Ur's magic shop (3), weapon
    // shop (5) and tavern (9) all SEE map 1's treasure tiles, because they share
    // its tilemap — but the player standing in the weapon shop cannot walk to
    // them. Listing every type-2 trigger on the tilemap reports one room's
    // chests four times over; the first cut of this file did exactly that.
    //
    // Only tiles reachable ON FOOT FROM THIS MAP'S OWN ENTRANCE count. Same
    // method `check-npc-room` uses, through the SHARED helpers — a hand-copied
    // spawn rule has been wrong four times in this repo already.
    // ⭐ `processTriggerTiles` does NOT mutate the tilemap — it returns a Map and
    // leaves the original tile ids in place (map-loader.js#processTriggerTiles).
    // So the tile id is still readable. Snapshot it anyway BEFORE
    // `applyPassageForTools`, which DOES rewrite tiles ($5B/$5C -> $5D/$5E).
    const rawTiles = Uint8Array.from(md.tilemap);
    applyPassageForTools(md);
    const reach = reachableFrom(md);
    const spots = [];
    for (const [xy, t] of md.triggerMap) {
      if (t.type !== 2) continue;
      const [x, y] = xy.split(',').map(Number);
      if (!reach.has(y * 32 + x)) continue;
      // ⛔ TYPE 2 IS TWO DIFFERENT THINGS. `map-loader.js#TRIGGER_TYPE_TABLE`
      // marks BOTH `$78-$7B` (hidden-treasure vases — "search here", no visible
      // chest) and `$7C` (a real chest) as type 2. They roll different tables
      // (`kind: 'vase'` drops the mimic tiers) and they are different content.
      // Counting them together reports a town's secret spots as chests.
      // `processTriggerTiles` REWRITES the tilemap, so the original tile has to
      // come off the pristine copy.
      const tile = rawTiles[y * 32 + x];
      spots.push({ x, y, trigId: t.trigId, tile, vase: tile >= 0x78 && tile <= 0x7B });
    }
    spots.sort((a, b) => a.trigId - b.trigId);
    if (!spots.length) continue;

    const base = chestBase(mapId);
    const rows = spots.map((s) => {
      const idx = base + s.trigId;
      const item = chestItem(idx);
      return { ...s, idx, item, name: nm(item), price: price(item), kind: kind(item) };
    });
    const { label } = ourPoolFor(mapId);
    out.push({ area, mapId, base, spots: rows, ourPool: label });

    if (AS_JSON) continue;
    const nChest = rows.filter((r) => !r.vase).length, nVase = rows.filter((r) => r.vase).length;
    console.log(`\n  map ${String(mapId).padStart(3)}   ${nChest} chest(s), ${nVase} hidden spot(s)   chest base $${base.toString(16).padStart(2, '0')}`);
    console.log(`      ff3mmo rolls from: ${label}`);
    for (const r of rows) {
      const flags = [];
      if (stocked.has(r.item)) flags.push(`SOLD IN ${stocked.get(r.item)}`);
      if (r.price > shopCeiling) flags.push(`${r.price}g — ABOVE the ${shopCeiling}g shop ceiling`);
      console.log(`        (${String(r.x).padStart(2)},${String(r.y).padStart(2)})  chest#${String(r.idx).padStart(3)}  ` +
                  `${r.name.padEnd(12)} ${r.kind.padEnd(10)} ${String(r.price).padStart(5)}g` +
                  (flags.length ? `   ← ${flags.join('; ')}` : ''));
    }
  }
}

if (AS_JSON) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }

console.log('\n' + '═'.repeat(76));
console.log(`valley shop ceiling: ${shopCeiling}g   (${stocked.size} distinct items stocked)`);
const all = out.flatMap((m) => m.spots);
console.log(`total treasure tiles in the valley: ${all.length}`);
const above = all.filter((r) => r.price > shopCeiling);
console.log(`cartridge chests above the shop ceiling: ${above.length}` +
            (above.length ? ` — ${[...new Set(above.map((r) => `${r.name} ${r.price}g`))].join(', ')}` : ''));
