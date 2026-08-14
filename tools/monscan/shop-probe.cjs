// shop-probe.cjs — open a shop in the real game and read what it stocks.
//
// FF3's shop inventories are not in any table we have decoded, and guessing a
// ROM offset for them is the mistake this project has a standing rule against.
// So ask the game: warp into the shop map, walk the party to the counter, open
// the shop, and screenshot the list. What is on screen IS the inventory.
//
// The counter is found from the map's own data, not hard-coded: every shop map
// carries a "shop marker" NPC whose id encodes (type, town) — 227 Ur inn, 231
// Ur weapon, 238 Ur armor, 243 Ur magic, and Kazus is each of those +1. The
// player spawns at the map's entranceX/Y and the marker sits straight up from
// it, so the walk is "north until you are standing at the counter".
//
//   node tools/monscan/shop-probe.cjs 5          # Ur weapon shop
//   MAPS=3,4,5,8 node tools/monscan/shop-probe.cjs
//   SHOT=/tmp/out MAPS=15,16,17 node tools/monscan/shop-probe.cjs
//
// Also dumps the RAM window that changes when the shop opens, so the loaded
// item ids can be traced back to a ROM table later.

const { Nes, BTN } = require('./nes.cjs');
const { readFileSync, mkdirSync } = require('fs');

const ROM_PATH = process.env.ROM || '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const SHOTS = process.env.SHOT || '/tmp/claude-1000/-home-joeltco/72d75d82-4b24-4ec2-9ca9-88978d5cb2d3/scratchpad/shops';
mkdirSync(SHOTS, { recursive: true });
const MAPS = (process.env.MAPS || process.argv[2] || '5')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

function run(n, nes) { for (let i = 0; i < n; i++) nes.nes.frame(); }
function press(nes, b, hold = 8, after = 22) {
  nes.nes.buttonDown(1, BTN[b]); run(hold, nes);
  nes.nes.buttonUp(1, BTN[b]); run(after, nes);
}
function inBattle(nes) {
  let c = 0;
  for (let i = 0; i < 64; i++) if (nes.nes.ppu.sprY[i] < 0xEF) c++;
  return c > 12;
}

// Same boot the bundle probe uses: the monscan choreography reaches the field,
// then flee the battle it lands in (warping out of one hits an invalid opcode)
// and clear the post-battle box (the engine eats $AB while a box is open).
function bootToField(nes) {
  run(300, nes);
  for (let i = 0; i < 25; i++) press(nes, 'start', 6, 45);
  for (let block = 0; block < 10; block++) {
    for (let k = 0; k < 6; k++) press(nes, 'a', 8, 25);
    press(nes, 'down', 8, 40);
  }
  run(400, nes);
  for (let t = 0; t < 40 && inBattle(nes); t++) {
    for (let c = 0; c < 4; c++) { press(nes, 'down', 8, 20); press(nes, 'down', 8, 20); press(nes, 'a', 8, 24); }
    run(240, nes);
  }
  for (let i = 0; i < 12; i++) press(nes, 'a', 6, 20);
  press(nes, 'down', 20, 30);
  run(180, nes);
}

// POKE=0x609d[:value] holds a byte across the warp and the map load.
//
// $609D is the KAZUS CURSE FLAG, found by tracing which addresses the game
// reads while LOADING a cursed map that it does not read loading Ur's
// equivalent, then poking each (tools/monscan/shop-flag.cjs). Kazus's shops do
// not open on a fresh game — a ghost stands behind every counter — and setting
// this byte before the map loads makes the town live, so its stock can be read.
//
// It has to be held ACROSS the load: a cursed town decides ghosts-or-people
// while the map loads, so a value set afterwards changes nothing.
const POKE = (() => {
  if (!process.env.POKE) return null;
  const [a, v] = String(process.env.POKE).split(':');
  return { addr: parseInt(a, 16), value: v ? parseInt(v, 16) : 0xFF };
})();

function warp(nes, mapId, holdFrames = 300) {
  const cpu = nes.nes.cpu;
  if (POKE) {
    cpu.mem[POKE.addr] = POKE.value;
    if (cpu.load(POKE.addr) !== POKE.value) {
      console.log(`  !! poke $${POKE.addr.toString(16)} did not land — result is meaningless`);
    }
  }
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

const ramSnapshot = (nes) => Buffer.from(nes.nes.cpu.mem.slice(0, 0x800));

// Is the SHOP open (as opposed to a dialogue box, which is also a big blue
// panel)? MEASURED on known frames: the strip BETWEEN the two top boxes is dark
// in a shop's two-box header and blue in a single wide message box.
//   shop 0.43 top / 0.25 gap   message 0.46 / 0.69   map 0.00 / 0.00
function shopIsOpen(nes) {
  const fb = nes.nes.ppu.buffer;
  if (!fb) return false;
  const W = 256;
  const frac = (x0, y0, x1, y1) => {
    let n = 0, t = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const p = fb[y * W + x];
      const r = p & 255, g = (p >> 8) & 255, b = (p >> 16) & 255;
      t++; if (b > 100 && b > r + 50 && b > g + 40) n++;
    }
    return t ? n / t : 0;
  };
  return frac(0, 8, 256, 40) > 0.2 && frac(72, 16, 88, 32) < 0.45;
}

for (const mapId of MAPS) {
  const nes = new Nes(ROM_PATH);
  bootToField(nes);
  if (inBattle(nes)) { console.log(`map ${mapId}: stuck in a battle — skipped`); continue; }
  let took = false;
  try { took = warp(nes, mapId); } catch (e) { console.log(`map ${mapId}: warp crashed (${e.message})`); continue; }
  if (!took) { console.log(`map ${mapId}: warp NOT accepted — skipped`); continue; }
  run(150, nes);
  nes.screenshot(`${SHOTS}/shop-${mapId}-arrive.png`);
  const before = ramSnapshot(nes);

  // Walk north to the counter, pressing A each step. Stepping onto a shop
  // counter is what opens FF3's shop, but talking works too — doing both means
  // the probe does not need to know which mechanism a given shop uses.
  // ⛔ STOP as soon as the shop is up. Walking on and mashing A past that point
  // drives the root menu — the cursor slides Buy -> Sell -> Exit and the stock
  // list never opens, which is exactly what the first Kazus capture produced.
  const STEPS = parseInt(process.env.STEPS || '6', 10);
  let opened = false;
  for (let i = 0; i < STEPS && !opened; i++) {
    press(nes, 'up', 14, 26);
    press(nes, 'a', 8, 30);
    run(30, nes);
    nes.screenshot(`${SHOTS}/shop-${mapId}-step${i}.png`);
    opened = shopIsOpen(nes);
  }
  run(90, nes);
  if (!opened && !shopIsOpen(nes)) {
    console.log(`map ${mapId}: shop never opened after ${STEPS} steps — nothing to read`);
  }
  nes.screenshot(`${SHOTS}/shop-${mapId}-open.png`);

  // The root menu is Buy / Sell / Exit with the cursor already on Buy, so one A
  // opens the stock list — which is the thing this tool exists to read. Shoot
  // it, then page DOWN in case the list is longer than the window.
  press(nes, 'a', 10, 90);
  run(90, nes);
  nes.screenshot(`${SHOTS}/shop-${mapId}-buy.png`);

  // Everything in zero page + stack + RAM that moved once the shop was open.
  const after = ramSnapshot(nes);
  const moved = [];
  for (let a = 0; a < 0x800; a++) if (before[a] !== after[a]) moved.push(a);
  console.log(`map ${mapId}: warp ok, ${moved.length} RAM bytes changed while opening the shop`);
  // A shop list is a RUN of plausible item ids; report the longest such run so
  // the ROM search has something specific to look for.
  let best = { start: -1, len: 0 };
  let s = -1;
  for (let a = 0; a < 0x800; a++) {
    const v = after[a];
    const plausible = v > 0 && v < 0xF0;
    if (plausible) { if (s < 0) s = a; }
    else { if (s >= 0 && a - s > best.len) best = { start: s, len: a - s }; s = -1; }
  }
  if (best.len >= 4) {
    const bytes = [...after.slice(best.start, best.start + Math.min(best.len, 16))]
      .map(v => '0x' + v.toString(16).padStart(2, '0')).join(' ');
    console.log(`  longest plausible id run: $${best.start.toString(16)} (${best.len}) ${bytes}`);
  }
  console.log(`  shots -> ${SHOTS}/shop-${mapId}-*.png`);
}
