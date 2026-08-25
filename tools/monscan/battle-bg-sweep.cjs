// battle-bg-sweep.cjs — capture EVERY battle backdrop off real hardware.
//
// ═══════════════════════════════════════════════════════════════════════════
// ⛔⛔⛔  DO NOT HALF-ASS THE DATA PULL.  ⛔⛔⛔
// The backdrop record has FOUR parts and every one of them is checked here:
//   tiles (16 x 16 bytes)  ·  palette (3 colours)  ·  tilemap id  ·  metatiles
// A run that compares only the palette proves only the palette. The whole
// point of driving the emulator 24 times is that "0x018010 + bgId * 0x100" is
// an ASSUMED STRIDE until the PPU agrees with it for every id.
// ═══════════════════════════════════════════════════════════════════════════
//
// Method: hex-patch the map->backdrop byte for map 181 (the opening cave, the
// map the boot sequence reaches on its own — proven by watching $48 become 181
// at frame 2937 and $6B become table[181]&0x1F at frame 3609), boot into the
// scripted first encounter, and read back what the PPU drew.
//
//   node battle-bg-sweep.cjs            # all 24 ids -> battle-bg-sweep.json
//   node battle-bg-sweep.cjs 8          # one id, verbose
const { readFileSync, writeFileSync } = require('fs');
const { Nes } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const ROM = REPO + '/Final Fantasy III (Japan).nes';
const LOOKUP = 0x073C10;         // map -> backdrop byte, 256 entries
const PROBE_MAP = 181;           // the map the boot sequence lands a battle on
const TILES = 0x018010;          // + bgId * 0x100, 16 tiles of 16 bytes
const PAL_C1 = 0x001110, PAL_C2 = 0x001210, PAL_C3 = 0x001310;
const TMID = 0x05E512, METAS = 0x05E52A, TILEMAPS = 0x05E53A;
const BG_COUNT = 24;             // TMID table length; ids 24+ are the metatile table

const rom = new Uint8Array(readFileSync(ROM));

/** Drive the game into its scripted first encounter with one patched byte. */
function runBattle(bgByte) {
  const patched = Uint8Array.from(rom);
  patched[LOOKUP + PROBE_MAP] = bgByte;
  const tmp = '/tmp/ff3-bgsweep.nes';
  writeFileSync(tmp, Buffer.from(patched));
  const n = new Nes(tmp);
  n.run(300);
  for (let i = 0; i < 25; i++) n.press('start', 6, 45);
  for (let b = 0; b < 10; b++) {
    for (let k = 0; k < 6; k++) n.press('a', 8, 25);
    n.press('down', 8, 40);
  }
  n.run(900);
  return n;
}

/** What the PPU actually holds: tiles, palette, the 4 nametable rows, attrs. */
function readBackdrop(n) {
  const nt = n.nametable();
  // The backdrop band is nametable rows 1-4 (y = 8..39). Row 0 and row 5 are
  // blank in every capture; taken from the data, not assumed.
  const rows = [1, 2, 3, 4].map((r) => nt.slice(r * 32, r * 32 + 32));
  const pals = new Set();
  for (let r = 1; r <= 4; r++) for (let c = 0; c < 32; c++) pals.add(n.paletteAt(c, r));
  const attrPal = [...pals];
  const pal = n.palette();
  // Tiles $60-$6F, from whichever pattern-table snapshot actually holds them.
  let tiles = null;
  for (const bank of n.patternSnapshots()) {
    const cand = [];
    for (let t = 0; t < 16; t++) cand.push([...bank.slice((0x60 + t) * 16, (0x60 + t) * 16 + 16)]);
    if (cand.some((tl) => tl.some((b) => b !== 0))) { tiles = cand; break; }
  }
  return {
    tiles,
    bgPal: attrPal.length === 1 ? pal.slice(attrPal[0] * 4, attrPal[0] * 4 + 4) : null,
    attrPal,
    rows: rows.map((r) => [...r]),
    zp6B: n.ram[0x6b],
  };
}

/** The same backdrop built straight out of the ROM tables. */
function modelBackdrop(bgId) {
  const tiles = [];
  for (let t = 0; t < 16; t++)
    tiles.push([...rom.slice(TILES + bgId * 0x100 + t * 16, TILES + bgId * 0x100 + t * 16 + 16)]);
  const metas = [];
  for (let m = 0; m < 4; m++) metas.push([...rom.slice(METAS + m * 4, METAS + m * 4 + 4)]);
  const tmid = rom[TMID + bgId];
  const tilemap = [...rom.slice(TILEMAPS + tmid * 32, TILEMAPS + tmid * 32 + 32)];
  // Expand to the four 32-tile nametable rows the console would write.
  const rows = [[], [], [], []];
  for (let half = 0; half < 2; half++)
    for (let col = 0; col < 16; col++) {
      const [tl, tr, bl, br] = metas[tilemap[half * 16 + col]];
      rows[half * 2].push(tl, tr);
      rows[half * 2 + 1].push(bl, br);
    }
  return {
    tiles,
    pal: [0x0f, rom[PAL_C1 + bgId], rom[PAL_C2 + bgId], rom[PAL_C3 + bgId]],
    tmid, tilemap, metas, rows,
  };
}

const only = process.argv[2] !== undefined ? parseInt(process.argv[2], 10) : null;
const ids = only !== null ? [only] : [...Array(BG_COUNT).keys()];
const out = [];
let fails = 0;
for (const bgId of ids) {
  const n = runBattle(bgId);
  const got = readBackdrop(n);
  const want = modelBackdrop(bgId);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // ⛔ The CAPTURE is checked in, not just the verdict. A gate that stores only
  // `tilesMatch: true` proves nothing later — it agrees with whatever the model
  // says next time. `tools/check-battle-bg.mjs` re-derives the model from src
  // and compares it to THESE BYTES, which came off a PPU.
  const r = {
    bgId,
    zp6B: got.zp6B,
    attrPal: got.attrPal,
    tilesMatch: eq(got.tiles, want.tiles),
    palMatch: eq(got.bgPal, want.pal),
    rowsMatch: eq(got.rows, want.rows),
    tmid: want.tmid,
    livePal: got.bgPal, modelPal: want.pal,
    capture: { tiles: got.tiles, pal: got.bgPal, rows: got.rows },
  };
  if (!r.tilesMatch || !r.palMatch || !r.rowsMatch) fails++;
  out.push(r);
  console.log(
    `bg ${String(bgId).padStart(2)}  $6B=${got.zp6B.toString(16).padStart(2, '0')}` +
    `  tmid=${want.tmid}  tiles:${r.tilesMatch ? 'OK ' : 'DIFF'}` +
    `  pal:${r.palMatch ? 'OK ' : 'DIFF'}  map:${r.rowsMatch ? 'OK ' : 'DIFF'}` +
    `  live=${(got.bgPal || []).map((v) => v.toString(16).padStart(2, '0')).join(' ')}`);
  if (only !== null) {
    console.log('  model pal :', want.pal.map((v) => v.toString(16).padStart(2, '0')).join(' '));
    console.log('  tilemap   :', want.tilemap.join(' '));
    console.log('  metatiles :', want.metas.map((m) => m.map((v) => v.toString(16)).join(',')).join(' | '));
  }
}
writeFileSync(__dirname + '/battle-bg-sweep.json', JSON.stringify(out, null, 1));
console.log(fails ? `\n${fails} of ${ids.length} DISAGREE with the ROM model` : `\nall ${ids.length} ids agree with the ROM model`);
