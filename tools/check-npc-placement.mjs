#!/usr/bin/env node
// check-npc-placement.mjs — no town NPC may stand in tree canopy.
//
// A player filed bug #4, "person in tree": `ur_villager_red` was at (27,25) in
// Ur, which is solid forest. The placement had passed an "openArea (walkable +
// >=3 walkable neighbours)" review — and that review cannot catch this, because
// tree tiles ARE walkable in tileset 4. Walkability says nothing about what a
// tile depicts, so the check has to name the canopy tiles.
//
// CANOPY_TILES is visually derived: rendered with tools/map-png.mjs and read
// off the image. It is per-tileset because metatile ids mean different things
// in different tilesets — do not generalise it without looking at a render.
//
//   node tools/check-npc-placement.mjs

import fs from 'node:fs';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));

const { loadMap } = await import('../src/map-loader.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');

// tileset -> metatile ids that draw as tree canopy.
const CANOPY_TILES = new Map([
  [4, new Set([0x20, 0x21, 0x22])],   // Ur overworld — verified from a render
]);

const W = 32;
let failed = 0, checked = 0;

for (const [mapId, list] of TOWN_NPCS) {
  let md;
  try { md = loadMap(rom, mapId); } catch (e) {
    console.error(`  ✗ map ${mapId}: failed to load (${e.message})`);
    failed++; continue;
  }
  const canopy = CANOPY_TILES.get(md.tileset);
  for (const npc of list) {
    checked++;
    const { x, y, key } = npc;
    if (x < 0 || x >= W || y < 0 || y >= W) {
      console.error(`  ✗ ${key} on map ${mapId} is off-map at (${x},${y})`);
      failed++; continue;
    }
    const raw = md.tilemap[y * W + x];
    const m = raw < 128 ? raw : raw & 0x7F;
    if (canopy && canopy.has(m)) {
      console.error(`  ✗ ${key} on map ${mapId} stands in tree canopy at (${x},${y}) — tile $${m.toString(16)}`);
      failed++; continue;
    }
    // Also reject a placement that is fully sealed in. The bar is 1, not 2:
    // shop keepers stand BEHIND counters and are enclosed on three sides by
    // design (see the DIR_DOWN counter rule in design-notes#town-keepers), so
    // requiring 2 flags correct placements like `weapon_keeper` on map 5.
    let open = 0;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= W) continue;
      const nraw = md.tilemap[ny * W + nx];
      const nm = nraw < 128 ? nraw : nraw & 0x7F;
      if ((md.collision[nm] & 0x07) !== 3 && !(md.collision[nm] & 0x80)) open++;
    }
    if (open < 1) {
      console.error(`  ✗ ${key} on map ${mapId} at (${x},${y}) is sealed in — no open neighbours`);
      failed++; continue;
    }
    console.log(`  ✓ ${key} — map ${mapId} (${x},${y}) tile $${m.toString(16)}, ${open} open neighbours`);
  }
}

if (!checked) { console.error('check-npc-placement: no NPCs found — has TOWN_NPCS moved?'); process.exit(2); }
if (failed) { console.error(`\ncheck-npc-placement: FAIL (${failed} of ${checked})`); process.exit(1); }
console.log(`\ncheck-npc-placement: OK (${checked} NPCs)`);
