#!/usr/bin/env node
// sara-in-cave.mjs — draw the princess where the player actually finds her.
//
// The Cave of Seals' first floor is GENERATED, so there is no fixed tile to
// look at: `npc.js#placeSaraInExitChamber` finds her a spot at load time from
// the `PASSAGE_ENTRY` marker. That means "is she standing somewhere sensible"
// is a question about a distribution, not a coordinate — so render several
// seeds and look at all of them.
//
// ⛔ Everything here is the REAL path: `generateFloor` makes the floor,
// `findExitChamberSpot` picks her tile (the same function the game calls), and
// the `Sprite` class draws her. Nothing is re-implemented.
//
//   node tools/sara-in-cave.mjs [--seeds 4] [--scale 2]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createCanvas, loadImage } from '@napi-rs/canvas';

globalThis.document = { createElement: () => createCanvas(16, 16), addEventListener() {} };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const { generateFloor } = await import('../src/dungeon-generator.js');
const { DUNGEONS } = await import('../src/data/dungeons.js');
const { findExitChamberSpot } = await import('../src/data/npc-walk-area.js');
const { Sprite, DIR_DOWN } = await import('../src/sprite.js');
const { mapPalettesForSpec } = await import('../src/data/npc-palette.js');
const { SARA } = await import('../src/data/town-npcs.js');
const { QUESTS } = await import('../src/data/quests.js');

const rom = new Uint8Array(fs.readFileSync(new URL('../FF3-English.nes', import.meta.url).pathname));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const N = parseInt(arg('seeds', '4'), 10);
const Z = parseInt(arg('scale', '2'), 10);

const dg = DUNGEONS.find((d) => d.id === 'seals');
// ⛔ READ THE FLOOR OFF THE QUEST, not a literal — the map she is on and the
// map the quest sends you to are the same fact. `map-loading.js` derives
// SARA_MAP_ID the same way.
const stage = QUESTS.sasune_missing_daughter.stages.find((s) => s.id === 'found');
const FLOOR = stage.at.map - dg.base;

// Timestamp-shaped seeds: the game seeds with Date.now(), and small integers
// exercise a different corner of the RNG than the values players actually get.
const SEEDS = Array.from({ length: N }, (_, i) => 1787600000000 + i * 977);

const TILE = 16, W = 32, PX = W * TILE;
const shots = [];
for (const seed of SEEDS) {
  const md = generateFloor(rom, FLOOR, seed, dg);
  const spot = findExitChamberSpot(md);
  const tmp = `/tmp/_sara_floor_${seed}.png`;
  execFileSync('node', ['tools/floor-png.mjs', String(FLOOR), String(seed), tmp,
                        '--scale', '1', '--dungeon', 'seals'], { stdio: 'pipe' });
  shots.push({ seed, spot, img: await loadImage(tmp), md });
  fs.unlinkSync(tmp);
}

const COLS = 2, ROWS = Math.ceil(shots.length / COLS), PAD = 12, HDR = 34;
const cv = createCanvas(COLS * (PX * Z + PAD) + PAD, ROWS * (PX * Z + HDR + PAD) + 34);
const g = cv.getContext('2d');
g.imageSmoothingEnabled = false;
g.fillStyle = '#101018'; g.fillRect(0, 0, cv.width, cv.height);
g.font = 'bold 14px monospace'; g.fillStyle = '#e8e8f0';
g.fillText(`Princess Sara, Cave of Seals floor ${FLOOR} (map ${stage.at.map}) — ${shots.length} seeds`, 12, 22);

shots.forEach((s, i) => {
  const ox = PAD + (i % COLS) * (PX * Z + PAD);
  const oy = 34 + Math.floor(i / COLS) * (PX * Z + HDR + PAD);
  g.drawImage(s.img, ox, oy + HDR, PX * Z, PX * Z);

  if (s.spot) {
    // Her sprite, through the real class, in this floor's own palettes.
    const spec = mapPalettesForSpec(SARA, s.md);
    const sp = new Sprite(rom, spec.palTop, spec.palBtm);
    sp.setPalette(spec.palTop, spec.palBtm);
    sp.gfxBase = spec.romOffset;
    sp.setDirection(DIR_DOWN);
    sp.resetFrame();
    const t = createCanvas(16, 16);
    sp.draw(t.getContext('2d'), 0, 0);
    g.drawImage(t, ox + s.spot.x * TILE * Z, oy + HDR + s.spot.y * TILE * Z, 16 * Z, 16 * Z);
    // Ring her so she is findable in a 32x32 cave.
    g.strokeStyle = '#ffd77a'; g.lineWidth = 2;
    g.strokeRect(ox + s.spot.x * TILE * Z - 3, oy + HDR + s.spot.y * TILE * Z - 3, 16 * Z + 6, 16 * Z + 6);
    // And the entrance, so the walk to her reads.
    g.strokeStyle = '#66d9ff';
    g.strokeRect(ox + s.md.entranceX * TILE * Z - 2, oy + HDR + s.md.entranceY * TILE * Z - 2, 16 * Z + 4, 16 * Z + 4);
  }
  // ⭐ THE PUZZLE. Boulders and the wall they open are ENTITIES, not tilemap
  // tiles, so `floor-png` cannot draw them — a render without them looks like
  // she is standing in an open room, which is the opposite of the design.
  const rs = s.md.rockSwitch;
  if (rs) {
    g.lineWidth = 2;
    for (const r of rs.rocks || []) {
      g.fillStyle = 'rgba(255,120,60,0.55)';
      g.fillRect(ox + r.x * TILE * Z, oy + HDR + r.y * TILE * Z, 16 * Z, 16 * Z);
      g.strokeStyle = '#ff7a3c';
      g.strokeRect(ox + r.x * TILE * Z, oy + HDR + r.y * TILE * Z, 16 * Z, 16 * Z);
    }
    for (const w of rs.wallTiles || []) {
      g.fillStyle = 'rgba(120,160,255,0.40)';
      g.fillRect(ox + w.x * TILE * Z, oy + HDR + w.y * TILE * Z, 16 * Z, 16 * Z);
    }
  }
  g.font = 'bold 11px monospace';
  g.fillStyle = s.spot ? '#9fe8a0' : '#ff6666';
  g.fillText(s.spot ? `seed ${s.seed}  —  Sara at (${s.spot.x},${s.spot.y})  [gold]`
                    : `seed ${s.seed}  —  NO SPOT FOUND`, ox, oy + 14);
  g.font = '10px monospace'; g.fillStyle = '#66d9ff';
  const nr = (s.md.rockSwitch && s.md.rockSwitch.rocks || []).length;
  g.fillText(`entrance (${s.md.entranceX},${s.md.entranceY}) [cyan]   ` +
             `${nr} boulder(s) [orange]   the wall they open [pale blue]`, ox, oy + 28);
});

const out = new URL('../docs/sprites/sara-in-cave.png', import.meta.url).pathname;
fs.writeFileSync(out, cv.toBuffer('image/png'));
console.log(`floor ${FLOOR} of '${dg.id}' (map ${stage.at.map}) -> ${out}`);
for (const s of shots) console.log(`  seed ${s.seed}: ${s.spot ? `(${s.spot.x},${s.spot.y})` : 'NO SPOT'}`);
