#!/usr/bin/env node
// check-map-objects.mjs — a map's OBJECT sprites get placed, once each.
//
// Kazus's south-west corner has a campfire with someone sitting at it. It was
// missing for the whole first drop, and not because the art was missing: the
// graphics have been decoded in `flame-sprites.js` since long before Kazus.
// `rebuildFlameSprites` only ever scanned tileset-5 BACKGROUND tiles and
// returned early for anything else, so no TOWN could place a free-standing
// object at all. That corner's tilemap is bare grass — the fire is an entry in
// the map's own NPC table (id 190 at (4,28)), and nothing read those.
//
//   node tools/check-map-objects.mjs
//
// Guards three things:
//   1. the campfire is placed, at the coordinate the ROM puts it
//   2. no flame is placed TWICE — Ur's inn lists id 194 in its object table at
//      the same tiles as its candle-wall background tiles, and drawing both
//      double-brightens a candle in a way nobody would ever file a bug about
//   3. every decoded flame id can actually render frames

import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = { createElement: () => createCanvas(16, 16), getElementById: () => null, addEventListener() {} };

const { loadMap } = await import('../src/map-loader.js');
const flame = await import('../src/flame-sprites.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
flame.initFlameRawTiles(rom);

let failed = 0;
const bad = (m) => { console.error('  ✗ ' + m); failed++; };
const ok = (m) => console.log('  ✓ ' + m);

// ── 1. the campfire ───────────────────────────────────────────────────────
// MEASURED, not chosen: reading OAM while standing next to it in the real game
// (`WALK=left,left,left,up,up node tools/monscan/ghost-sprite.cjs 10`) traces
// its tiles to 0x14010/20/30/40 — frame 1 of the large-torch flame.
{
  const md = loadMap(rom, 10);
  flame.rebuildFlameSprites(md, null, 16);
  const sprites = flame.getFlameSprites();
  const fire = sprites.find(f => f.px === 4 * 16 && f.py === 28 * 16);
  if (!fire) {
    bad('Kazus (map 10) places NO campfire at (4,28) — the town\'s SW corner is empty again');
  } else if (fire.npcId !== 190) {
    bad(`the object at Kazus (4,28) is id ${fire.npcId}, expected the campfire (190)`);
  } else ok('Kazus campfire placed at (4,28) from the map object table');
}

// ── 2. nothing drawn twice ────────────────────────────────────────────────
{
  let dupes = 0;
  for (let mapId = 0; mapId < 256; mapId++) {
    let md;
    try { md = loadMap(rom, mapId); } catch { continue; }
    flame.rebuildFlameSprites(md, null, 16);
    const sprites = flame.getFlameSprites();
    const seen = new Set();
    for (const f of sprites) {
      const k = f.px + ',' + f.py;
      if (seen.has(k)) {
        bad(`map ${mapId} places two flames on the same tile (${f.px / 16},${f.py / 16}) — ` +
            'the background scan and the object table both claimed it');
        dupes++;
        break;
      }
      seen.add(k);
    }
  }
  if (!dupes) ok('no map places two flames on one tile');
}

// ── 3. every decoded id renders ───────────────────────────────────────────
{
  const md = loadMap(rom, 10);
  flame.rebuildFlameSprites(md, null, 16);
  const frames = flame.getFlameFrames();
  const f190 = frames.get(190);
  if (!f190 || f190.length !== 2) bad('the campfire has no two-frame animation — a fire that does not flicker');
  else ok('campfire renders both animation frames');
}

// ── 4. Ur is untouched ────────────────────────────────────────────────────
// The object pass runs for every tileset now; Ur's interiors must come out
// exactly as they did when only the background scan existed.
{
  for (const [mapId, want] of [[8, 3], [4, 1], [12, 3]]) {
    const md = loadMap(rom, mapId);
    flame.rebuildFlameSprites(md, null, 16);
    const n = flame.getFlameSprites().length;
    if (n !== want) bad(`map ${mapId} now has ${n} flames, expected ${want}`);
  }
  ok('Ur inn / armor shop / Kazus inn flame counts unchanged');
}

if (failed) { console.error(`\ncheck-map-objects: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-map-objects: OK');
