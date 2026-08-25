// world-bg-probe.cjs — what backdrop does an OVERWORLD battle use?
//
// ⛔ The map->backdrop lookup is indexed by map id and the overworld is not a
// map id (see world-harness.cjs). `setupTopBox` guessed `table[0]`. Seven of the
// 24 backdrops — desert, forest, marsh, rock, ocean, sky, undersea — are reached
// by NO map in either lookup table, which is the tell that the overworld picks
// its own. This walks the party on the real overworld until a random encounter
// fires and reads back what the PPU drew.
//
//   node world-bg-probe.cjs                 # stock
//   node world-bg-probe.cjs 0x0c            # force every world tile's prop
//                                           # byte 1 to this, to test the link
const { readFileSync, writeFileSync } = require('fs');
const { Nes } = require('./nes.cjs');
const { buildWorldRom, run, press, spriteCount, PROPS_RAM } = require('./world-harness.cjs');
const os = require('os'), path = require('path'), fs = require('fs');

const WORLD_PROPS_ROM = 0x510;          // 128 tiles x 2 bytes, copied to $0400
const forceProp1 = process.argv[2] ? parseInt(process.argv[2], 16) : null;
const worldX = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;
const worldY = process.argv[4] ? parseInt(process.argv[4], 10) : undefined;
const vehicle = process.argv[5] ? parseInt(process.argv[5], 10) : undefined;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worldbg-'));
const romPath = buildWorldRom(path.join(dir, 'w.nes'), { worldX, worldY, vehicle });
if (forceProp1 !== null) {
  const p = readFileSync(romPath);
  for (let t = 0; t < 128; t++) p[WORLD_PROPS_ROM + t * 2 + 1] = forceProp1;
  writeFileSync(romPath, p);
}

const nes = new Nes(romPath);
run(nes, 300);
for (let i = 0; i < 25; i++) press(nes, 'start', 6, 45);
for (let b = 0; b < 10; b++) { for (let k = 0; k < 6; k++) press(nes, 'a', 8, 25); press(nes, 'down', 8, 40); }
run(nes, 400);
for (let r = 0; r < 25 && spriteCount(nes) > 12; r++) { for (let k = 0; k < 8; k++) press(nes, 'a', 6, 18); run(nes, 120); }
for (let i = 0; i < 10; i++) press(nes, 'a', 6, 20);
run(nes, 200);

// On the world map? $0400 only holds the world tile-prop table there.
const romNow = readFileSync(romPath);
let match = 0;
for (let k = 0; k < 256; k++) if (nes.nes.cpu.mem[PROPS_RAM + k] === romNow[WORLD_PROPS_ROM + k]) match++;
console.log('on world map:', match === 256 ? 'yes' : `NO (${match}/256)`);

const hx = (v) => v.toString(16).padStart(2, '0');
const m = nes.nes.cpu.mem;
console.log('standing at $27,$28 =', m[0x27], m[0x28], ' vehicle $42/$46 =', hx(m[0x42]), hx(m[0x46]));

// Walk until a battle starts. `spriteCount() > 12` is this repo's battle
// detector (npc-cast.cjs, map-bundles.cjs, shop-flag.cjs all use it) — the
// field never puts that many sprites on screen at once.
let steps = 0;
const DIRS = ['left', 'right', 'up', 'down'];
while (spriteCount(nes) <= 12 && steps < 400) {
  press(nes, DIRS[(steps >> 2) % 4], 10, 6);
  steps++;
}
const fought = spriteCount(nes) > 12;
console.log('steps to encounter:', steps, fought ? '' : '(NO BATTLE)');
if (!fought) process.exitCode = 1;
const pal = nes.palette();
const pals = new Set();
for (let r = 1; r <= 4; r++) for (let c = 0; c < 32; c++) pals.add(nes.paletteAt(c, r));
const attrPal = [...pals];
console.log('$27,$28 now =', m[0x27], m[0x28], ' $48 =', hx(m[0x48]), ' $78 =', hx(m[0x78]),
            ' $6B =', hx(m[0x6b]), ' $53 =', hx(m[0x53]));
console.log('band attr palettes:', attrPal.join(','));
for (const p of attrPal) console.log('  BG' + p, pal.slice(p * 4, p * 4 + 4).map(hx).join(' '));
const out = process.env.BG_OUT || '/tmp/world-bg.png';
nes.screenshot(out);
console.log('png:', out);
