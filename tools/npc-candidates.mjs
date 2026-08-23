#!/usr/bin/env node
// npc-candidates.mjs — which of the ROM's own NPC records for a map are
// actually PLACEABLE, and on which sprite bundle.
//
// Placing town NPCs has four independent constraints, and each one has shipped
// broken on its own:
//
//   1. the coordinate must be in the room the PLAYER walks into — FF3 packs
//      several interiors into one tilemap (`check-npc-room.mjs`)
//   2. the player must be able to stand somewhere and TALK to it — beside it,
//      or across a counter in a straight line (`tools/lib/talkable.mjs`)
//   3. a wanderer must start where it can move — `npc.js` only steps onto
//      tiles with >= MIN_OPEN_NEIGHBOURS, so a doorway freezes it forever
//   4. the map must LOAD that person's walk bundle, and no two people on a map
//      may share one, or they render as the same face twice
//
// This answers all four per record, so a placement is chosen from data instead
// of from a coordinate that "looks like floor".
//
// ⛔ (4) needs the PPU — FF3 is CHR-RAM and a bundle only exists on screen if
// the map decompressed it. Pass the measured set with --bundles, or run
// `node tools/monscan/map-bundles.cjs <map>` and paste it in. Offsets that tool
// prints are HEADER-LESS; add 0x10 (this tool does it for you).
//
//   node tools/npc-candidates.mjs 25 26 27
//   node tools/npc-candidates.mjs 29 --bundles 0x1ED00,0x1EE00,0x1EF00

import fs from 'node:fs';

const _ctx = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, fillRect() {}, clearRect() {},
  save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, clip() {},
};
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => _ctx }) };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { TOWN_NPCS, STORY_SPRITE_BUNDLES } = await import('../src/data/town-npcs.js');
const { calcSpawnY } = await import('./lib/spawn.mjs');
const { playerRegion, isTalkable, isTransitionTile } = await import('./lib/talkable.mjs');
const { isOpenAreaTile, MIN_OPEN_NEIGHBOURS } = await import('../src/data/npc-walk-area.js');
const { gfxForNpcId, kindForGfx, bundleForNpcId } = await import('../src/data/npc-gfx.js');

const argv = process.argv.slice(2);
const bi = argv.indexOf('--bundles');
let allowed = null;
if (bi >= 0) {
  allowed = new Set(argv[bi + 1].split(',').map((s) => {
    const v = parseInt(s.trim(), 16 | 0) || Number(s.trim());
    // map-bundles.cjs prints header-less offsets; the game's specs carry +0x10.
    return (v & 0xFF) === 0 ? v + 0x10 : v;
  }));
  argv.splice(bi, 2);
}

const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname));
const W = 32;

for (const mapId of argv.map(Number)) {
  const md = loadMap(rom, mapId);
  const { stand, sx, sy, passable } = playerRegion(md, MapRenderer, calcSpawnY);
  const placed = TOWN_NPCS.get(mapId) || [];
  console.log(`\n=== map ${mapId} — player enters (${sx},${sy}), room is ${stand.size} standable tiles, ` +
    `${md.npcs.length} ROM record(s), we place ${placed.length} ===`);
  if (!md.npcs.length) { console.log('  the ROM lists nobody here'); continue; }

  const openN = (x, y) => {
    let n = 0;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= W) continue;
      if (isOpenAreaTile(md, nx, ny)) n++;
    }
    return n;
  };

  const usable = [];
  md.npcs.forEach((n, i) => {
    const gfx = gfxForNpcId(rom, n.id);
    const kind = kindForGfx(gfx);
    const bundle = bundleForNpcId(rom, n.id);
    const talk = isTalkable(md, stand, n.x, n.y);
    const solid = !passable(n.x, n.y);
    const door = isTransitionTile(md, n.x, n.y);
    const nb = openN(n.x, n.y);
    const story = bundle != null && STORY_SPRITE_BUNDLES.get(bundle);
    const loaded = allowed ? (bundle != null && allowed.has(bundle)) : null;
    const why = [];
    if (kind === 'undrawn') why.push('INVISIBLE MARKER');
    else if (kind === 'object') why.push('object, not a person');
    else if (kind === 'job') why.push('player job sprite');
    if (!talk) why.push('not talkable from the entrance room');
    if (door) why.push('on a door tile');
    if (story) why.push(`story character (${story})`);
    if (loaded === false) why.push('bundle not loaded by this map');
    const ok = why.length === 0;
    if (ok) usable.push({ ...n, gfx, bundle, nb });
    console.log(
      `  #${String(i).padStart(2)} id $${n.id.toString(16).padStart(2, '0')} gfx ${String(gfx).padStart(3)} ` +
      `(${kind.padEnd(7)}) at (${String(n.x).padStart(2)},${String(n.y).padStart(2)})` +
      `${solid ? ' [solid]' : ''} nb=${nb}${nb >= MIN_OPEN_NEIGHBOURS ? '' : ' [static only]'} ` +
      `bundle ${bundle == null ? '   —   ' : '0x' + bundle.toString(16).toUpperCase()} ` +
      `${ok ? '✓ USABLE' : '✗ ' + why.join('; ')}`);
  });

  // ⚠ FIDELITY, not a failure: who we put on the cartridge's own tile, versus who
  // the cartridge puts there. Twelve placements across Ur and Kazus wear a
  // different sprite than the record they stand on — the specs were assigned by
  // slot index, not by the record on the tile. Sometimes that is DELIBERATE (the
  // Kazus inn records wear 0x1ED10, which is banned), so this reports rather than
  // gates. It is how the two Castle Sasune guards were found wearing each
  // other's bundle.
  for (const e of placed) {
    const here = md.npcs.filter((n) => n.x === e.x && n.y === e.y);
    if (!here.length) continue;
    const off = e.spec && e.spec.romOffset;
    const wants = [...new Set(here.map((n) => bundleForNpcId(rom, n.id)).filter((b) => b != null))];
    if (!wants.length || wants.includes(off)) continue;
    console.log(`  ⚠ ${e.key} stands on the ROM's (${e.x},${e.y}) wearing ` +
      `0x${off.toString(16).toUpperCase()}; the record there wears ` +
      wants.map((b) => '0x' + b.toString(16).toUpperCase()).join(' / '));
  }

  const byBundle = new Map();
  for (const u of usable) if (!byBundle.has(u.bundle)) byBundle.set(u.bundle, u);
  console.log(`  -> ${usable.length} usable record(s) across ${byBundle.size} distinct bundle(s):`);
  for (const [b, u] of byBundle) {
    console.log(`     0x${b.toString(16).toUpperCase()}  first at (${u.x},${u.y})  ` +
      `${u.nb >= MIN_OPEN_NEIGHBOURS ? 'can wander' : 'static (idle-march)'}`);
  }
}
