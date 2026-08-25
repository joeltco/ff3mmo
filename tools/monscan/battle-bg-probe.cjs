// battle-bg-probe.cjs — drive FF3 into a real battle and read the backdrop the
// PPU actually drew, optionally with the map->bg table hex-patched first.
//
// ⛔ THE POINT: nothing here trusts a comment. The battle background is read
// back out of the live PPU (palette RAM + nametable + attribute table), so a
// claim like "bgId = table[map] & 0x1F" is settled by changing the table byte
// and watching the screen change — not by reading the constant back.
//
//   node battle-bg-probe.cjs                       # unpatched baseline
//   node battle-bg-probe.cjs 0x73c10:0x05,...      # patch ROM bytes first
//
// Prints: BG palette rows, the 4 nametable rows the backdrop occupies, the
// attribute palette it selects, and writes a PNG next to the run.
const { readFileSync, writeFileSync } = require('fs');
const { Nes } = require('./nes.cjs');

const ROM = '/home/joeltco/projects/ff3mmo/Final Fantasy III (Japan).nes';
const OUT = process.env.BG_OUT || '/tmp/bg-probe.png';

const patches = (process.argv[2] || '').split(',').filter(Boolean).map((p) => {
  const [o, v] = p.split(':');
  return [parseInt(o, 16), parseInt(v, 16)];
});

let romPath = ROM;
if (patches.length) {
  const rom = new Uint8Array(readFileSync(ROM));
  for (const [o, v] of patches) rom[o] = v;
  romPath = OUT.replace(/\.png$/, '.nes');
  writeFileSync(romPath, Buffer.from(rom));
}

// Joel's intro sequence (see reach-battle.cjs): six A presses then DOWN, x10,
// names the whole party; the game then walks itself into the Altar Cave and a
// random encounter fires on its own.
const n = new Nes(romPath);
n.run(300);
for (let i = 0; i < 25; i++) n.press('start', 6, 45);
for (let block = 0; block < 10; block++) {
  for (let k = 0; k < 6; k++) n.press('a', 8, 25);
  n.press('down', 8, 40);
}
n.run(900);

const hx = (v) => v.toString(16).padStart(2, '0');
const pal = n.palette();
const nt = n.nametable();
const at = n.attributes();

// Which palette does the backdrop band use? Rows 1-4 of the nametable, read
// through the attribute table rather than assumed.
const bandPals = new Set();
for (let row = 1; row <= 4; row++) for (let col = 0; col < 32; col++) bandPals.add(n.paletteAt(col, row));

console.log('frames:', n.frames);
console.log('BG palettes:');
for (let p = 0; p < 4; p++) console.log('  BG' + p, pal.slice(p * 4, p * 4 + 4).map(hx).join(' '));
console.log('backdrop band attr palettes:', [...bandPals].join(','));
for (let r = 0; r <= 5; r++) console.log('NT row' + r + ':', nt.slice(r * 32, r * 32 + 32).map(hx).join(' '));
console.log('ATTR row0:', at.slice(0, 8).map(hx).join(' '));
console.log('zp $53:', hx(n.ram[0x53]), ' zp $6B:', hx(n.ram[0x6b]), ' $48:', hx(n.ram[0x48]), ' $78:', hx(n.ram[0x78]));
n.screenshot(OUT);
console.log('png:', OUT);
