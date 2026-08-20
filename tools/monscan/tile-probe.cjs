// tile-probe.cjs — stand on a tile and report what each direction does.
//
// Answers "is this tile a wall, a door, or an in-map warp, and where does it
// go?" without any model of collision. The map's ROM entrance is patched to the
// tile (5 bits of byte 0 / byte 1 of its property record), so the party spawns
// exactly there; then one press per direction, reading $48/$68/$69 back.
//
//   node tools/monscan/tile-probe.cjs 12:3,21 12:3,20 5:3,27
//
// ⛔ A tile the party spawns on has its arrival trigger DISARMED (measured while
// building door-probe.cjs), so a door under the party reads as "nothing fired".
// Stepping OFF and back on is what re-arms it — that is what `off+back` reports.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Nes, BTN } = require('./nes.cjs');

const BASE_ROM = process.env.ROM || '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const MAP_PROPS_BASE = 0x004010, MAP_ID = 0x48, TX = 0x68, TY = 0x69;
const CACHE = path.join(os.tmpdir(), 'ff3-door-probe-boot.json');
const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };

function run(nes, n) { for (let i = 0; i < n; i++) nes.nes.frame(); }
function press(nes, b, h = 16, a = 8) { nes.nes.buttonDown(1, BTN[b]); run(nes, h); nes.nes.buttonUp(1, BTN[b]); run(nes, a); }
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
function romAt(mapId, sx, sy) {
  const rom = Buffer.from(fs.readFileSync(BASE_ROM));
  const o = MAP_PROPS_BASE + mapId * 16;
  rom[o] = (rom[o] & 0xE0) | (sx & 0x1F);      // top 3 bits are the TILESET
  rom[o + 1] = (rom[o + 1] & 0xE0) | (sy & 0x1F);
  const p = path.join(os.tmpdir(), `ff3-tp-${mapId}-${sx}-${sy}.nes`);
  fs.writeFileSync(p, rom);
  return p;
}

for (const spec of process.argv.slice(2)) {
  const [mapPart, tilePart] = spec.split(':');
  const mapId = parseInt(mapPart, 10);
  const [tx, ty] = tilePart.split(',').map(Number);
  const romPath = romAt(mapId, tx, ty);
  const nes = new Nes(romPath, {});
  nes.load(bootState());
  const m = nes.nes.cpu.mem;
  if (!warp(nes, mapId)) { console.log(`${spec}: warp did not take`); fs.unlinkSync(romPath); continue; }
  if (m[TX] !== tx || m[TY] !== ty) { console.log(`${spec}: spawned (${m[TX]},${m[TY]}) not the tile asked for — skipped`); fs.unlinkSync(romPath); continue; }
  const out = [];
  for (const d of ['up', 'down', 'left', 'right']) {
    const bx = m[TX], by = m[TY], bm = m[MAP_ID];
    press(nes, d);
    const dist = Math.abs(m[TX] - bx) + Math.abs(m[TY] - by);
    if (m[MAP_ID] !== bm) { out.push(`${d}: DOOR -> map ${m[MAP_ID]} @(${m[TX]},${m[TY]})`); break; }
    if (dist > 1) { out.push(`${d}: WARP -> (${m[TX]},${m[TY]})`); break; }
    if (dist === 1) {
      // step back so every direction is judged from the same tile
      const off = [m[TX], m[TY]];
      press(nes, OPP[d]);
      if (m[MAP_ID] !== bm) { out.push(`${d}: moved to (${off}), returning fired a DOOR -> map ${m[MAP_ID]}`); break; }
      if (m[TX] !== bx || m[TY] !== by) { out.push(`${d}: moved to (${off}), returning WARPED -> (${m[TX]},${m[TY]})`); break; }
      out.push(`${d}: ok`);
    } else out.push(`${d}: wall`);
  }
  console.log(`map ${String(mapId).padStart(3)} (${tx},${ty})  ${out.join('   ')}`);
  fs.unlinkSync(romPath);
}
