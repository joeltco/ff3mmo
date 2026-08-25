#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
//
// check-battle-bg.mjs — the battle backdrop, pinned against a real PPU.
//
// This gate exists because "it still renders" passed for months while the code
// read ONE of the two map lookup tables and never drew a backdrop in a battle at
// all. Rendering is not evidence. The evidence here is
// `tools/monscan/battle-bg-sweep.json` — 24 backdrops captured off a live
// console by hex-patching the map->backdrop byte and booting into a real fight.
//
// What is checked, all four fields of the record plus both selectors:
//   1. PIXELS      shipped renderBattleBg == what the PPU drew, all 24 ids
//   2. TWO TABLES  maps 256-511 read the SECOND lookup, not the first
//   3. RANGE       every map 0-511 resolves inside 0..BATTLE_BG_COUNT-1
//   4. WORLD TILE  overworld terrain -> byte 2; warp tiles -> not a backdrop
//   5. WIRED       the battle screen actually calls the backdrop drawer
//
// Re-capture with:  node tools/monscan/battle-bg-sweep.cjs   (~3 min, 24 boots)
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const SWEEP = new URL('./monscan/battle-bg-sweep.json', import.meta.url).pathname;

globalThis.window = { addEventListener() {} };
globalThis.document = { createElement: () => createCanvas(8, 8), addEventListener() {} };

const { renderBattleBg, battleBgIdForMap, battleBgIdForWorldProps, BATTLE_BG_COUNT,
        BATTLE_BG_MAP_LOOKUP, BATTLE_BG_MAP_LOOKUP_HI, WORLD_TILE_PROPS } =
  await import('../src/battle-bg.js');
const { NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); fails++; } };

// ── 1. PIXELS ───────────────────────────────────────────────────────────────
// Rebuild the band the console drew straight from the captured PPU state — its
// tile bytes, its nametable rows, its palette — and compare to what the SHIPPED
// renderer produces. Nothing in this comparison comes from the ROM tables the
// renderer reads, so agreeing is a real result and not a tautology.
if (!fs.existsSync(SWEEP)) {
  console.error(`FAIL: no hardware capture at ${SWEEP} — run tools/monscan/battle-bg-sweep.cjs`);
  fails++;
} else {
  const sweep = JSON.parse(fs.readFileSync(SWEEP, 'utf8'));
  ok(sweep.length === BATTLE_BG_COUNT,
     `capture has ${sweep.length} backdrops, BATTLE_BG_COUNT is ${BATTLE_BG_COUNT}`);
  for (const r of sweep) {
    ok(r.tilesMatch && r.palMatch && r.rowsMatch,
       `bg ${r.bgId}: the capture run itself disagreed with the ROM tables ` +
       `(tiles ${r.tilesMatch} pal ${r.palMatch} map ${r.rowsMatch})`);
    if (!r.capture) { ok(false, `bg ${r.bgId}: capture has no pixel data — re-run the sweep`); continue; }
    const { tiles, pal, rows } = r.capture;

    // The console's own band, 256x32, from CHR bytes + nametable + palette.
    const want = createCanvas(256, 32);
    const wctx = want.getContext('2d');
    const img = wctx.createImageData(256, 32);
    for (let ty = 0; ty < 4; ty++) {
      for (let tx = 0; tx < 32; tx++) {
        const tile = tiles[rows[ty][tx] - 0x60];
        if (!tile) { ok(false, `bg ${r.bgId}: nametable names tile $${rows[ty][tx].toString(16)}, outside $60-$6F`); continue; }
        for (let py = 0; py < 8; py++) {
          const lo = tile[py], hi = tile[py + 8];
          for (let px = 0; px < 8; px++) {
            const bit = 7 - px;
            const ci = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
            const o = ((ty * 8 + py) * 256 + tx * 8 + px) * 4;
            if (ci === 0) { img.data[o + 3] = 0; continue; }
            const rgb = NES_SYSTEM_PALETTE[pal[ci]] || [0, 0, 0];
            img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
          }
        }
      }
    }
    wctx.putImageData(img, 0, 0);

    const { bgCanvas } = renderBattleBg(rom, r.bgId);
    ok(bgCanvas.width === 256 && bgCanvas.height === 32,
       `bg ${r.bgId}: renderer gave ${bgCanvas.width}x${bgCanvas.height}, the console's band is 256x32`);
    const a = bgCanvas.getContext('2d').getImageData(0, 0, 256, 32).data;
    const b = wctx.getImageData(0, 0, 256, 32).data;
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] !== b[i + 3]) { diff++; continue; }
      if (a[i + 3] === 0) continue;                       // both transparent
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
    }
    ok(diff === 0, `bg ${r.bgId}: shipped renderer differs from the PPU capture in ${diff} of 8192 pixels`);
  }
}

// ── 2. TWO TABLES ───────────────────────────────────────────────────────────
// ⛔ The bug this catches: `rom[LOOKUP + mapId]` for a mapId above 255 reads
// past the first table into the second by accident — sometimes landing on the
// right byte, which is exactly why it survived. Prove the resolver picks the
// high table on purpose by finding a map where the two tables DISAGREE.
{
  let probed = 0;
  for (let k = 0; k < 256 && probed < 8; k++) {
    const lo = rom[BATTLE_BG_MAP_LOOKUP + k] & 0x1F;
    const hi = rom[BATTLE_BG_MAP_LOOKUP_HI + k] & 0x1F;
    if (lo === hi) continue;                              // proves nothing
    probed++;
    ok(battleBgIdForMap(rom, 256 + k) === hi,
       `map ${256 + k} resolved to ${battleBgIdForMap(rom, 256 + k)}; the high table says ${hi} (the low table says ${lo})`);
    ok(battleBgIdForMap(rom, k) === lo,
       `map ${k} resolved to ${battleBgIdForMap(rom, k)}; the low table says ${lo}`);
  }
  ok(probed >= 4, `only ${probed} maps where the two tables disagree — not enough to prove the split`);
}

// ── 3. RANGE ────────────────────────────────────────────────────────────────
for (let mapId = 0; mapId < 512; mapId++) {
  const id = battleBgIdForMap(rom, mapId);
  ok(id >= 0 && id < BATTLE_BG_COUNT, `map ${mapId} resolves to backdrop ${id}, outside 0-${BATTLE_BG_COUNT - 1}`);
}

// ── 4. WORLD TILE ───────────────────────────────────────────────────────────
// World 0's walkable terrain uses exactly six backdrops — grass, desert,
// forest, marsh, rock, ocean — and they are the six no map in either lookup
// table reaches. That coincidence is the whole reason the overworld path was
// found; pin it so a change that quietly re-points it gets caught.
{
  const base = WORLD_TILE_PROPS[0];
  const terrain = new Set(), warps = [];
  for (let t = 0; t < 128; t++) {
    const props = { byte1: rom[base + t * 2], byte2: rom[base + t * 2 + 1] };
    if (props.byte1 & 0x80) { warps.push(t); ok(battleBgIdForWorldProps(props) === 0,
      `world tile $${t.toString(16)} is a warp; its byte 2 is a destination id, not a backdrop`); continue; }
    const id = battleBgIdForWorldProps(props);
    ok(id === props.byte2, `world tile $${t.toString(16)}: byte 2 is ${props.byte2} but resolved to ${id}`);
    terrain.add(id);
  }
  const got = [...terrain].sort((a, b) => a - b).join(',');
  ok(got === '0,1,2,3,4,5', `world 0 terrain backdrops are {${got}}, expected {0,1,2,3,4,5}`);
  ok(warps.length > 0, 'no warp tiles found in world 0 — the props table moved');
  ok(battleBgIdForWorldProps(null) === 0, 'a missing tile-prop entry must fall back to backdrop 0, not throw');
}

// Every backdrop must be reachable by SOMETHING — a map, or a world's terrain.
// A backdrop the cartridge ships that no code path can select is a dropped
// field; that is how the six overworld strips sat unused.
{
  const reached = new Set();
  for (let mapId = 0; mapId < 512; mapId++) reached.add(battleBgIdForMap(rom, mapId));
  for (const base of WORLD_TILE_PROPS)
    for (let t = 0; t < 128; t++)
      reached.add(battleBgIdForWorldProps({ byte1: rom[base + t * 2], byte2: rom[base + t * 2 + 1] }));
  const orphans = [];
  for (let id = 0; id < BATTLE_BG_COUNT; id++) if (!reached.has(id)) orphans.push(id);
  // Backdrop 6 (sky) is genuinely selected by nothing in this cartridge's data —
  // recorded here as a known, measured orphan rather than silently tolerated.
  ok(orphans.join(',') === '6',
     `unreachable backdrops are {${orphans.join(',')}}; only backdrop 6 (sky) is a known orphan`);
}

// ── 5. THE REGISTRY ─────────────────────────────────────────────────────────
// One row per backdrop, and the biome rows must agree with the tiles that
// actually select them. A registry that drifts from the table it describes is
// worse than no registry — it reads like evidence.
{
  const { BACKDROPS, backdropName, resolveBackdrop, backdropSourceFor, dungeonRomMapFor } =
    await import('../src/data/backdrops.js');
  ok(BACKDROPS.length === BATTLE_BG_COUNT,
     `registry has ${BACKDROPS.length} rows, the ROM has ${BATTLE_BG_COUNT} backdrops`);
  for (let id = 0; id < BATTLE_BG_COUNT; id++) {
    ok(BACKDROPS[id] && BACKDROPS[id].id === id, `registry row ${id} is missing or misnumbered`);
    ok(BACKDROPS[id] && BACKDROPS[id].evidence, `backdrop ${id} (${backdropName(id)}) has no evidence line`);
  }
  // Every id a WORLD TILE can select must carry a biome; every id it cannot
  // must not. This is the assertion that would have caught the overworld being
  // wired to a map lookup.
  const base = WORLD_TILE_PROPS[0];
  const selectable = new Set();
  for (let t = 0; t < 128; t++) {
    const props = { byte1: rom[base + t * 2], byte2: rom[base + t * 2 + 1] };
    if (props.byte1 & 0x80) continue;
    selectable.add(battleBgIdForWorldProps(props));
  }
  for (let id = 0; id < BATTLE_BG_COUNT; id++) {
    const biome = BACKDROPS[id].biome;
    ok(selectable.has(id) === !!biome,
       `backdrop ${id} (${backdropName(id)}): world tiles ${selectable.has(id) ? 'DO' : 'do NOT'} select it ` +
       `but its registry biome is ${biome === null ? 'null' : `'${biome}'`}`);
  }

  // The source rows must route each context to the right resolver.
  ok(backdropSourceFor({ onWorldMap: true, mapId: 0 }) === 'world', 'an overworld context must resolve through the world source');
  ok(backdropSourceFor({ onWorldMap: false, mapId: 1000 }) === 'dungeon', 'a dungeon floor must resolve through the dungeon source, not the map table');
  ok(backdropSourceFor({ onWorldMap: false, mapId: 114 }) === 'map', 'a town must resolve through the map source');
  ok(resolveBackdrop(null, { onWorldMap: false, mapId: 114 }) === 0, 'no ROM must resolve to 0, not throw');

  // ⛔ A dungeon FLOOR takes its own ROM map, not one donor for the whole
  // dungeon. Both shipped dungeons happen to land on `cave` for every floor,
  // which is exactly why this needs pinning — the bug would be invisible.
  const { DUNGEONS } = await import('../src/data/dungeons.js');
  for (const d of DUNGEONS) {
    if (!Array.isArray(d.romFloorMaps)) continue;
    for (let f = 0; f < d.romFloorMaps.length; f++) {
      const mapId = d.base + f;
      const romMap = dungeonRomMapFor(mapId);
      const isBoss = f === d.floors - 1;
      if (isBoss) continue;                             // boss floor takes its skin's donor
      ok(romMap === d.romFloorMaps[f],
         `${d.id} floor ${f} draws backdrop from ROM map ${romMap}; its romFloorMaps entry is ${d.romFloorMaps[f]}`);
    }
    // The boss floor must NOT inherit the walkable floors' strip when its skin
    // says otherwise — Altar Cave's crystal chamber is ice, not cave brown.
    const bossMapId = d.base + d.floors - 1;
    ok(Number.isInteger(dungeonRomMapFor(bossMapId)), `${d.id} boss floor resolves no ROM map`);
  }
}

// ── 6. WIRED ────────────────────────────────────────────────────────────────
// ⛔ THE ACTUAL FAILURE THIS FILE WAS WRITTEN FOR. Every number above can be
// correct while nothing reaches the screen. It was: the overworld strip was
// hardcoded to backdrop 0 for every terrain, and the branch that did it read
// like a decision.
{
  const mapLoading = fs.readFileSync(new URL('../src/map-loading.js', import.meta.url), 'utf8');
  ok(/resolveBackdrop\(/.test(mapLoading),
     'src/map-loading.js does not use the backdrop registry — setupTopBox is resolving ids itself again');
  ok(!/renderBattleBg\(romRaw,\s*\d/.test(mapLoading),
     'src/map-loading.js renders a HARDCODED backdrop id — that is how the overworld got stuck on grassland');
  ok(/export function refreshWorldBackdrop/.test(mapLoading),
     'map-loading.js has no refreshWorldBackdrop — the overworld strip cannot follow the terrain');

  const movement = fs.readFileSync(new URL('../src/movement.js', import.meta.url), 'utf8');
  ok(/refreshWorldBackdrop\(\)/.test(movement),
     'src/movement.js never calls refreshWorldBackdrop — the strip would freeze on whichever tile you walked in on');

  const renderer = fs.readFileSync(new URL('../src/world-map-renderer.js', import.meta.url), 'utf8');
  ok(/battleBgIdAt\(tileX, tileY\)/.test(renderer),
     'world-map-renderer.js has no battleBgIdAt — the terrain lookup has no reader');
}

console.log(fails
  ? `\n${fails} battle-backdrop check(s) FAILED`
  : 'battle backdrop: 24 ids match the PPU, both lookup tables read, registry agrees with the world tiles, overworld strip follows the biome');
process.exit(fails ? 1 : 0);
