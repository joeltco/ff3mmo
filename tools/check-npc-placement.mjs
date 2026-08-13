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

// ── every NPC must use a sprite bundle its MAP ACTUALLY LOADS ──────────────
// FF3 is CHR-RAM: a walk bundle only exists on screen if the map copied it into
// sprite memory. Picking a bundle that looks like a villager on a contact sheet
// puts a sprite in the town that the real game never loads there — v1.7.973
// dressed Ur in seven bundles from other towns' casts.
//
// The verified sets below come from the PPU itself:
//   node tools/nes-run.mjs --warp <id> --chrmap --bundles
// which traces live sprite memory back to ROM offsets and groups them into
// 16-tile bundles. Re-run it if a map's cast changes; do not edit by hand.
const LOADED_BUNDLES = new Map([
  [114, new Set([0x01DF10, 0x01E010, 0x01E210, 0x01E310, 0x01E510])],  // town
  [9,   new Set([0x01DF10, 0x01E010, 0x01E110, 0x01E610, 0x01E710])],  // tavern
  [8,   new Set([0x01E010, 0x01E210])],                                // inn
  [7,   new Set([0x01E010, 0x01E210, 0x01EC10])],                      // elder, upper
  [6,   new Set([0x01EC10])],                                          // elder, ground
  [5,   new Set([0x01E610])],                                          // weapon shop
  [4,   new Set([0x01E610])],                                          // armor shop
  [2,   new Set([0x01E210])],                                          // house
]);

{
  let bundleBad = 0;
  for (const [mapId, allowed] of LOADED_BUNDLES) {
    const list = TOWN_NPCS.get(mapId) || [];
    for (const e of list) {
      const off = e.spec && e.spec.romOffset;
      if (off == null || allowed.has(off)) continue;
      console.error(`  ✗ ${e.key} (map ${mapId}) uses bundle 0x${off.toString(16).toUpperCase()}, ` +
        `which map ${mapId} never loads into sprite memory`);
      bundleBad++;
    }
  }
  if (bundleBad) failed += bundleBad;
  else console.log(`  ✓ every NPC uses a bundle its map actually loads`);

  // No two NPCs on a map may share a sprite bundle. A map only ever holds a
  // handful of walk bundles, so placing more people than bundles means the same
  // face appears twice on screen — reported as "SEEING DOUBLE NPCS". Place at
  // most one person per bundle.
  let twins = 0;
  for (const [mapId, list] of TOWN_NPCS) {
    const seen = new Map();
    for (const e of list) {
      const off = e.spec && e.spec.romOffset;
      if (off == null) continue;
      if (seen.has(off)) {
        console.error(`  ✗ map ${mapId}: ${e.key} and ${seen.get(off)} both use bundle ` +
          `0x${off.toString(16).toUpperCase()} — they render as the same person`);
        twins++;
      } else seen.set(off, e.key);
    }
  }
  if (twins) failed += twins;
  else console.log(`  ✓ no two NPCs on a map share a sprite bundle`);
}

if (failed) { console.error(`\ncheck-npc-placement: FAIL (${failed} of ${checked})`); process.exit(1); }
console.log(`\ncheck-npc-placement: OK (${checked} NPCs)`);
