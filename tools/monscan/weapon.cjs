// Capture the battle weapon CHR the PPU actually holds mid-swing.
//
//   node weapon.cjs            # whatever the party starts with (knife, $1E)
//   node weapon.cjs 24         # force-equip item $24 (a sword) first
//
// FF3 decompresses the equipped weapon's tiles into sprite slots $49-$60
// (PPU $1490-$1600) only while a swing is on screen — the EMU tab's WPN TILES
// button exists for exactly this, pressed by hand at the right moment. This
// does it headlessly and keeps every distinct state seen, so nothing depends on
// catching the correct frame.
//
// This is a MEASUREMENT, not an authoring step: it reports what is in the PPU
// and diffs it against what src/weapon-sprites.js ships. Deciding which tiles
// belong to which weapon pose stays out of it.

const { readFileSync, writeFileSync } = require('fs');
const { Nes } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const ROM = REPO + '/FF3-English.nes';
const WPN_LO = 0x1490;                 // PPU addr of slot $49
const WPN_HI = 0x1600;                 // one past slot $60
const WEAPON_ID = process.argv[2] ? parseInt(process.argv[2], 16) : null;
const OUT = __dirname + `/weapon-tiles${WEAPON_ID === null ? '' : '-' + WEAPON_ID.toString(16)}.json`;

// SRAM equip block: $6200 + char*0x40, byte 3 is the weapon. Located by
// dumping it rather than trusting the field order in emu.js's comment — the
// fresh party reads $1E there, which is a knife, matching what it swings.
const WPN_SLOT = (c) => 0x6200 + c * 0x40 + 3;

const n = new Nes(ROM);
n.run(300);
for (let i = 0; i < 25; i++) n.press('start', 6, 45);

// Re-poke continuously rather than once. Writing straight after the intro does
// nothing: the party does not exist yet and character creation overwrites the
// slot with the default $1E knife — all four weapons produced byte-identical
// captures until this was fixed. Battle caches equipment at start, so the write
// only has to win up to that moment.
function equip() {
  if (WEAPON_ID === null) return;
  for (let c = 0; c < 4; c++) n.ram[WPN_SLOT(c)] = WEAPON_ID;
}
equip();

/** Slots $49-$60 as raw bytes, or null while the region is empty. */
function slots() {
  const b = Buffer.from(n.vram.slice(WPN_LO, WPN_HI));
  return b.some((x) => x !== 0) ? b : null;
}

// Walk the party into a fight, then keep attacking. Snapshot every frame:
// the swing is only a handful of frames long and the decompressed CHR is
// overwritten again afterwards.
const seen = new Map();
function watch(frames) {
  for (let f = 0; f < frames; f++) {
    n.run(1);
    equip();
    const s = slots();
    if (!s) continue;
    const key = s.toString('hex');
    if (!seen.has(key)) {
      // Sprite palettes live at $3F10-$3F1F; nes.palette() returns all 32
      // entries, so indices 16-31 are SP0-SP3. Recorded alongside the tiles
      // because weapon-sprites.js hardcodes a palette per weapon and that is
      // the half worth checking — the monster work was wrong on palettes far
      // more often than on artwork.
      const pal = n.palette();
      seen.set(key, { bytes: [...s], firstFrame: n.frames, sp: [0,1,2,3].map(i => pal.slice(16+i*4, 20+i*4)) });
    }
  }
}

for (let b = 0; b < 10; b++) {
  for (let k = 0; k < 6; k++) { equip(); n.press('a', 8, 25); watch(40); }
  equip(); n.press('down', 8, 40); watch(20);
}
console.log('weapon slot at capture time: $' + n.ram[WPN_SLOT(0)].toString(16));
// Once in battle, mash A: each attack command triggers another swing.
for (let i = 0; i < 40; i++) { n.press('a', 6, 10); watch(60); }

const states = [...seen.values()];
console.log(`distinct non-empty $49-$60 states: ${states.length}`);
for (const s of states.slice(0, 12)) {
  const nz = s.bytes.filter((x) => x).length;
  console.log(`  frame ${s.firstFrame}: ${nz}/${s.bytes.length} nonzero bytes`);
}
writeFileSync(OUT, JSON.stringify(states));
console.log('->', OUT);
