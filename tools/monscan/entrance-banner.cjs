// entrance-banner.cjs — NAME a dungeon by entering it and reading the banner.
//
// ⛔ THE ROM DOES NOT HAND YOU THIS. There is no map -> name table I could find;
// six candidate byte tables all turned out to be coincidences, and one of them
// cheerfully claimed four different maps were "Cid's Airship". Inferring a name
// from an area byte and a palette is what put a wrong "SEALS" label in the debug
// panel. The only honest source is the game printing it.
//
// ⛔ A `$0700` WARP DOES NOT SHOW THE BANNER — that is the internal door
// mechanism, and the nametable stays full of map tiles. The banner is drawn when
// you walk in from the WORLD MAP, so this spawns the party one tile below a
// world entrance (coords straight out of the ROM's entrance table) and steps in.
//
// The banner is nametable TEXT, and FF3's nametable tile index IS the character
// code — A-Z $8A, a-z $A4, space $FF — so it reads straight out of PPU memory.
//
//   node tools/monscan/entrance-banner.cjs 95,34        # one world coord
//   node tools/monscan/entrance-banner.cjs --caves      # every cave-tileset mouth

const fs = require('fs');
const path = require('path');
const { bootToWorldMap, run, press } = require('./world-harness.cjs');

const ROM = path.join(__dirname, '..', '..', 'FF3-English.nes');
const rom = fs.readFileSync(ROM);

function decode(c) {
  if (c >= 0x8A && c <= 0xA3) return String.fromCharCode(65 + c - 0x8A);
  if (c >= 0xA4 && c <= 0xBD) return String.fromCharCode(97 + c - 0xA4);
  if (c >= 0x80 && c <= 0x89) return String.fromCharCode(48 + c - 0x80);
  if (c === 0xFF) return ' ';
  if (c === 0xC8) return ':';
  if (c === 0xC2) return '-';
  if (c === 0xBF) return "'";
  return null;
}
function readText(nes) {
  const v = nes.nes.ppu.vramMem; const out = [];
  for (const base of [0x2000, 0x2400]) {
    for (let row = 0; row < 30; row++) {
      let cur = '';
      for (let col = 0; col < 32; col++) {
        const ch = decode(v[base + row * 32 + col]);
        if (ch === null) { if (cur.trim().length >= 3) out.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      if (cur.trim().length >= 3) out.push(cur.trim());
    }
  }
  return out;
}

function nameAt(x, y) {
  // Spawn one tile SOUTH of the mouth and walk north onto it.
  const nes = bootToWorldMap({ worldX: x, worldY: y + 1 });
  const seen = new Set();
  press(nes, 'up', 10, 30);
  for (let f = 0; f < 320; f++) { nes.nes.frame(); for (const t of readText(nes)) seen.add(t); }
  const live = nes.nes.cpu.mem[0x48];
  return { live, texts: [...seen] };
}

const args = process.argv.slice(2);
let spots;
if (args.includes('--caves')) {
  // world entrance table, restricted to cave-tileset destinations
  const wm = require('child_process');
  spots = JSON.parse(wm.execSync('node -e "' +
    'const fs=require(\'fs\');' +
    'import(\'/home/joeltco/projects/ff3mmo/src/world-map-loader.js\').then(m=>{' +
    'const r=new Uint8Array(fs.readFileSync(\'/home/joeltco/projects/ff3mmo/FF3-English.nes\'));' +
    'const w=m.loadWorldMap(r);const o=[];' +
    'for(const [t,p] of w.triggerPositions){const d=w.entranceTable[t];' +
    'if(d===undefined)continue;if(((r[0x004010+d*16]>>5)&7)!==0)continue;' +
    'o.push({x:p.x??p[0],y:p.y??p[1],dest:d});}' +
    'console.log(JSON.stringify(o));});"', { encoding: 'utf8' }).trim());
} else {
  spots = args.map((a) => { const [x, y] = a.split(',').map(Number); return { x, y }; });
}

console.log(`probing ${spots.length} world entrance(s)\n`);
for (const s of spots) {
  let r;
  try { r = nameAt(s.x, s.y); }
  catch (e) { console.log(`(${s.x},${s.y}) -> boot failed: ${e.message}`); continue; }
  const label = r.texts.find((t) => /^[A-Z]/.test(t) && t.length >= 3) || '(no banner)';
  console.log(`world (${String(s.x).padStart(3)},${String(s.y).padStart(3)})  expect map ${s.dest ?? '?'}  $48=${r.live}   ${label}`);
  if (r.texts.length > 1) console.log(`      all text: ${r.texts.join(' | ')}`);
}
