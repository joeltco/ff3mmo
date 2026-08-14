// ghost-sprite.cjs — what sprite is a Kazus ghost actually made of?
//
// Diffing which BUNDLES a map loads cursed-vs-living answers nothing here: both
// loads are identical, because a bundle can be resident without being drawn.
// The question is which TILES the ghost on screen is built from, so read OAM
// while looking at one and trace those tiles back to the ROM.
//
//   node tools/monscan/ghost-sprite.cjs 16        # cursed (default)
//   POKE=0x609d node tools/monscan/ghost-sprite.cjs 16   # living, for the diff
//
// Prints every OAM sprite grouped into clusters, with the ROM offset each tile
// comes from — so a ghost's 2x2 can be read straight off as a bundle + slot.

const { Nes, BTN } = require('./nes.cjs');
const { readFileSync, mkdirSync } = require('fs');

const ROM_PATH = process.env.ROM || '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const SHOTS = process.env.SHOT || '/tmp/claude-1000/-home-joeltco/72d75d82-4b24-4ec2-9ca9-88978d5cb2d3/scratchpad/ghost';
mkdirSync(SHOTS, { recursive: true });
const MAP = parseInt(process.argv[2] || '16', 10);
const rom = readFileSync(ROM_PATH);

const POKE = (() => {
  if (!process.env.POKE) return null;
  const [a, v] = String(process.env.POKE).split(':');
  return { addr: parseInt(a, 16), value: v ? parseInt(v, 16) : 0xFF };
})();

function run(n, nes) { for (let i = 0; i < n; i++) nes.nes.frame(); }
function press(nes, b, hold = 8, after = 22) {
  nes.nes.buttonDown(1, BTN[b]); run(hold, nes);
  nes.nes.buttonUp(1, BTN[b]); run(after, nes);
}
const inBattle = (nes) => {
  let c = 0;
  for (let i = 0; i < 64; i++) if (nes.nes.ppu.sprY[i] < 0xEF) c++;
  return c > 12;
};
function bootToField(nes) {
  run(300, nes);
  for (let i = 0; i < 25; i++) press(nes, 'start', 6, 45);
  for (let b = 0; b < 10; b++) { for (let k = 0; k < 6; k++) press(nes, 'a', 8, 25); press(nes, 'down', 8, 40); }
  run(400, nes);
  for (let t = 0; t < 40 && inBattle(nes); t++) {
    for (let c = 0; c < 4; c++) { press(nes, 'down', 8, 20); press(nes, 'down', 8, 20); press(nes, 'a', 8, 24); }
    run(240, nes);
  }
  for (let i = 0; i < 12; i++) press(nes, 'a', 6, 20);
  press(nes, 'down', 20, 30);
  run(180, nes);
}
function warp(nes, mapId, holdFrames = 300) {
  const cpu = nes.nes.cpu;
  if (POKE) cpu.mem[POKE.addr] = POKE.value;
  for (let f = 0; f < holdFrames; f++) {
    if (POKE) cpu.mem[POKE.addr] = POKE.value;
    cpu.mem[0x0700] = mapId & 0xFF;
    cpu.mem[0x00AB] = 0x80;
    nes.nes.frame();
    if (cpu.mem[0x00AB] !== 0x80) {
      for (let k = 0; k < 90; k++) { if (POKE) cpu.mem[POKE.addr] = POKE.value; nes.nes.frame(); }
      return true;
    }
  }
  return false;
}

// Index every 16-byte tile in the ROM so a PPU tile can be traced home.
const INDEX = (() => {
  const m = new Map();
  for (let off = 16; off + 16 <= rom.length; off += 16) {
    const k = rom.subarray(off, off + 16).toString('binary');
    if (!m.has(k)) m.set(k, []);
    const a = m.get(k);
    if (a.length < 32) a.push(off);
  }
  return m;
})();

function tileOrigin(nes, tileIdx) {
  const vram = nes.nes.ppu.vramMem;
  const base = (0x1000 + tileIdx * 16);
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) buf[i] = vram[base + i] & 0xFF;
  if (buf.every(v => v === 0)) return null;
  const offs = INDEX.get(buf.toString('binary'));
  return offs && offs.length ? offs : null;
}

const nes = new Nes(ROM_PATH);
bootToField(nes);
if (inBattle(nes)) { console.error('stuck in a battle'); process.exit(1); }
if (!warp(nes, MAP)) { console.error('warp not accepted'); process.exit(1); }
run(150, nes);
// WALK=left,left,up drives the party to whatever is being looked at. The
// default walks north to a shop counter; Kazus's campfire needs a different
// path, and hard-coding "4 x up" made this tool single-purpose.
const WALK = (process.env.WALK || 'up,up,up,up').split(',').map(s => s.trim()).filter(Boolean);
for (const step of WALK) { press(nes, step, 14, 26); run(20, nes); }
run(60, nes);
const tag = (process.env.TAG || (POKE ? 'living' : 'cursed'));
nes.screenshot(`${SHOTS}/ghost-${MAP}-${tag}.png`);

const ppu = nes.nes.ppu;
const rows = [];
for (let i = 0; i < 64; i++) {
  const y = ppu.sprY[i];
  if (y >= 0xEF) continue;
  const tile = ppu.sprTile[i];
  const x = ppu.sprX[i];
  const pal = ppu.sprPalette ? ppu.sprPalette[i] : (ppu.sprCol ? ppu.sprCol[i] : '?');
  rows.push({ i, x, y, tile, pal });
}
console.log(`map ${MAP} (${tag}): ${rows.length} visible sprites`);
// Cluster by proximity so a 2x2 character reads as one thing.
rows.sort((a, b) => a.y - b.y || a.x - b.x);
const used = new Set();
for (const r of rows) {
  if (used.has(r.i)) continue;
  const near = rows.filter(o => !used.has(o.i) && Math.abs(o.x - r.x) <= 8 && Math.abs(o.y - r.y) <= 8);
  near.forEach(o => used.add(o.i));
  const tiles = near.map(o => o.tile);
  const origins = [...new Set(tiles.map(t => {
    const o = tileOrigin(nes, t);
    return o ? '0x' + o[0].toString(16).toUpperCase() : '?';
  }))];
  console.log(`  cluster @(${r.x},${r.y})  pal ${near[0].pal}  tiles ${tiles.join(',')}  -> bundle(s) ${origins.join(' ')}`);
}
console.log('shot -> ' + `${SHOTS}/ghost-${MAP}-${tag}.png`);
