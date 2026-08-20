// capture-tilemaps.cjs — the tilemap the ENGINE walks, straight out of RAM.
//
// The trigger routine at 3A/9197 walks $7400-$77FF ($80/$81 = $7400), so that
// 1024-byte block IS the live 32x32 tilemap. Capturing it gives a ground truth
// for `map-loader.js#decompressTilemap`, which is otherwise only checkable
// against itself.
//
// ⛔ IT WILL NOT MATCH EXACTLY, AND SOME OF THAT IS CORRECT. The ROM REWRITES
// every trigger tile in place at load (3A/91B4: the tile becomes
// `base[tileId] + nth-of-that-tile-id`), so $60-$7C tiles legitimately differ.
// The comparison tool accounts for those and reports the rest.
//
//   node tools/monscan/capture-tilemaps.cjs 2,5,12,16,21 out.json
//
// ⛔ ONE WARP PER BOOT — a second warp never clears $AB again. The intro is
// snapshotted once and restored per map.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Nes, BTN } = require('./nes.cjs');

const BASE_ROM = process.env.ROM || '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const CACHE = path.join(os.tmpdir(), 'ff3-door-probe-boot.json');
const TILEMAP_RAM = 0x7400, MAP_ID = 0x48;

function run(nes, n) { for (let i = 0; i < n; i++) nes.nes.frame(); }
function press(nes, b, h = 8, a = 24) { nes.nes.buttonDown(1, BTN[b]); run(nes, h); nes.nes.buttonUp(1, BTN[b]); run(nes, a); }
function spriteCount(nes) { let c = 0; for (let i = 0; i < 64; i++) if (nes.nes.ppu.sprY[i] < 0xEF) c++; return c; }
function bootToField(nes) {
  run(nes, 300);
  for (let i = 0; i < 25; i++) press(nes, 'start', 6, 45);
  for (let b = 0; b < 10; b++) { for (let k = 0; k < 6; k++) press(nes, 'a', 8, 25); press(nes, 'down', 8, 40); }
  run(nes, 400);
  for (let t = 0; t < 40 && spriteCount(nes) > 12; t++) {
    for (let c = 0; c < 4; c++) { press(nes, 'down', 8, 20); press(nes, 'down', 8, 20); press(nes, 'a', 8, 24); }
    run(nes, 240);
  }
  for (let i = 0; i < 12; i++) press(nes, 'a', 6, 20);
  press(nes, 'down', 20, 30); run(nes, 180);
}
function warp(nes, mapId, hf = 400) {
  const cpu = nes.nes.cpu;
  for (let f = 0; f < hf; f++) {
    cpu.mem[0x0700] = mapId & 0xFF; cpu.mem[0x00AB] = 0x80; nes.nes.frame();
    if (cpu.mem[0x00AB] !== 0x80) { run(nes, 90); return true; }
  }
  return false;
}
let BOOT = null;
function bootState() {
  if (BOOT) return BOOT;
  if (fs.existsSync(CACHE)) { BOOT = JSON.parse(fs.readFileSync(CACHE, 'utf8')); return BOOT; }
  const nes = new Nes(BASE_ROM, {});
  bootToField(nes);
  BOOT = nes.save();
  fs.writeFileSync(CACHE, JSON.stringify(BOOT));
  return BOOT;
}

const ids = (process.argv[2] || '2').split(',').map(n => parseInt(n, 10));
const out = { _measured: 'live $7400-$77FF read after the ROM\'s own go-to-map warp', maps: {} };
for (const id of ids) {
  const nes = new Nes(BASE_ROM, {});
  nes.load(bootState());
  if (!warp(nes, id)) { console.log(`map ${id}: warp did not take`); continue; }
  const m = nes.nes.cpu.mem;
  if (m[MAP_ID] !== id) { console.log(`map ${id}: $48 reads ${m[MAP_ID]} — refusing to record someone else's tilemap`); continue; }
  out.maps[id] = Array.from(m.slice(TILEMAP_RAM, TILEMAP_RAM + 1024));
  console.log(`map ${String(id).padStart(3)}: captured`);
}
fs.writeFileSync(process.argv[3] || 'live-tilemaps.json', JSON.stringify(out));
console.log(`${Object.keys(out.maps).length} map(s) -> ${process.argv[3] || 'live-tilemaps.json'}`);
