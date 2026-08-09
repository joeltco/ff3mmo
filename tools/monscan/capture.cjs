// Capture a monster's real per-tile palette assignment from a live battle.
//
// The catalog already has correct palette *indices* (verified against a running
// battle: Goblin's baked pal0/pal1 match live BG0/BG1 byte for byte). What it
// lacks is which 16x16 block of each monster uses BG0 versus BG1 — that lives
// in the PPU attribute table and only exists while the battle is on screen.
//
// Locating the monster on screen is done by content, not by guessing coords:
// its tile bytes are known from the ROM extract, so we find those exact
// patterns in the PPU pattern table, then find those pattern indices in the
// nametable. No hardcoded rectangles, no assumptions about layout.

const { readFileSync } = require('fs');
const { Nes } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';

/** Pull a monster's raw tile bytes + grid size out of the generated catalog. */
function catalogEntry(monsterId) {
  const src = readFileSync(REPO + '/src/data/monster-sprites-rom.js', 'utf8');
  const reg = src.slice(src.indexOf('MONSTER_REGISTRY'));
  const hex = monsterId.toString(16).padStart(2, '0');
  const row = new RegExp(`\\[0x${hex},\\s*\\{([^}]*)\\}`, 'i').exec(reg);
  if (!row) return null;
  const varName = /raw:\s*(\w+)_RAW/.exec(row[1])[1];
  const grab = (suffix) =>
    parseInt(new RegExp(`${varName}_${suffix}\\s*=\\s*(\\d+)`).exec(src)[1], 10);
  const rawBlock = new RegExp(`${varName}_RAW = new Uint8Array\\(\\[(.*?)\\]\\)`, 's').exec(src)[1];
  const bytes = rawBlock.match(/0x[0-9a-f]{2}/gi).map((b) => parseInt(b, 16));
  return { cols: grab('COLS'), rows: grab('ROWS'), raw: bytes };
}

/** Index every 16-byte tile seen in the pattern tables across one whole frame.
 *
 *  Reading only the post-frame state misses any monster whose CHR bank is
 *  swapped out before vblank, which on FF3 is most of them. */
function patternIndex(nes) {
  const map = new Map();                       // 16-byte key -> tile index
  const banks = typeof nes.patternSnapshots === 'function'
    ? nes.patternSnapshots()
    : [Buffer.from(nes.vram.slice(0, 0x2000))];
  for (const bank of banks) {
    for (let t = 0; t < 512; t++) {
      const off = t * 16;
      let key = '';
      for (let i = 0; i < 16; i++) key += bank[off + i].toString(16).padStart(2, '0');
      if (!map.has(key)) map.set(key, t);
    }
  }
  return map;
}

/**
 * Work out the monster's on-screen tile grid and read its palette per tile.
 * Returns { tilePal, origin, matched } or null when the monster isn't on screen.
 */
function capture(nes, entry) {
  const patterns = patternIndex(nes);
  const nt = nes.nametable();
  const { cols, rows, raw } = entry;

  // Which pattern index holds each of the monster's tiles?
  // A monster's all-zero tiles are transparent: the game never writes them to
  // the nametable, so the battle backdrop shows through at that cell. Verifying
  // them is what made the first version reject every correct match.
  const blank = [];
  const wanted = [];
  for (let t = 0; t < cols * rows; t++) {
    const slice = raw.slice(t * 16, t * 16 + 16);
    blank.push(!slice.some((b) => b !== 0));
    let key = '';
    for (let i = 0; i < 16; i++) key += (raw[t * 16 + i] || 0).toString(16).padStart(2, '0');
    wanted.push(patterns.has(key) ? patterns.get(key) : null);
  }

  const anchorTile = wanted.findIndex((p, i) => p !== null && !blank[i]);
  if (anchorTile < 0) return null;

  const anchorPattern = wanted[anchorTile] & 0xFF;
  const ax = anchorTile % cols, ay = (anchorTile / cols) | 0;

  for (let idx = 0; idx < nt.length; idx++) {
    if (nt[idx] !== anchorPattern) continue;
    const col = (idx % 32) - ax, row = ((idx / 32) | 0) - ay;
    if (col < 0 || row < 0 || col + cols > 32 || row + rows > 30) continue;

    // Verify the whole grid lines up before trusting the anchor.
    let matched = 0, mismatched = 0;
    for (let t = 0; t < cols * rows; t++) {
      if (wanted[t] === null || blank[t]) continue;
      const nx = col + (t % cols), ny = row + ((t / cols) | 0);
      if (nt[ny * 32 + nx] === (wanted[t] & 0xFF)) matched++; else mismatched++;
    }
    if (mismatched > 0 || matched < 3) continue;

    const tilePal = [];
    for (let t = 0; t < cols * rows; t++)
      tilePal.push(nes.paletteAt(col + (t % cols), row + ((t / cols) | 0)));
    return { tilePal, origin: { col, row }, matched, cols, rows };
  }
  return null;
}

/**
 * Find the monster by its palettes rather than its artwork.
 *
 * This replaces tile-byte matching, which only worked for 46 of 195 monsters
 * because the catalog's stored tiles don't match what the game actually draws
 * for the rest. It also sidesteps CHR bank switching entirely.
 *
 * FF3 gives the monster BG palettes 0 and 1 and paints the backdrop and UI with
 * 2 and 3, so the cells using 0/1 ARE the monster — no identification needed,
 * since we chose which monster spawns. Verified on 0x6E: the 0/1 cells form
 * exactly the 4x6 block its size category predicts.
 *
 * Returns { col, row, cols, rows, tilePal, tileIds } or null.
 */
function captureByPalette(nes, want) {
  let minC = 32, maxC = -1, minR = 30, maxR = -1;
  for (let r = 0; r < 30; r++) {
    for (let c = 0; c < 32; c++) {
      const p = nes.paletteAt(c, r);
      if (p !== 0 && p !== 1) continue;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }
  if (maxC < 0) return null;

  let cols = maxC - minC + 1, rows = maxR - minR + 1;
  // Attributes cover 16x16 pixels, so a lone monster always lands on an even
  // 2x2 cell grid. Anything wildly large means we caught UI or a fade frame.
  if (cols > 24 || rows > 24) return null;

  // An encounter usually spawns two or three of the species, so the bounding
  // box covers the whole group — measuring it gave 8x12 for a 4x4 goblin. When
  // the caller knows the monster's real size (from the ROM's size-category
  // table), slide that window over the region and take the first placement
  // where every cell belongs to the monster's palettes. That isolates one
  // individual instead of the crowd.
  if (want && want.cols && want.rows) {
    const { cols: wc, rows: wr } = want;
    if (wc > cols || wr > rows) return null;
    // "Every cell is 0 or 1" alone is too weak — inside a group of three
    // goblins plenty of misaligned windows satisfy it, and one of them returned
    // an all-palette-0 block for a monster that really is split. A genuine
    // monster occupies a window that uses BOTH of its palettes, so prefer those
    // and only fall back to a single-palette window if none exists (some
    // monsters genuinely use one).
    let found = null, fallback = null;
    for (let r = minR; r + wr - 1 <= maxR; r++) {
      for (let c = minC; c + wc - 1 <= maxC; c++) {
        let all = true;
        const used = new Set();
        for (let dr = 0; dr < wr && all; dr++)
          for (let dc = 0; dc < wc; dc++) {
            const p = nes.paletteAt(c + dc, r + dr);
            if (p !== 0 && p !== 1) { all = false; break; }
            used.add(p);
          }
        if (!all) continue;
        if (used.size > 1) { found = { c, r }; break; }
        fallback = fallback || { c, r };
      }
      if (found) break;
    }
    found = found || fallback;
    if (!found) return null;
    minC = found.c; minR = found.r; cols = wc; rows = wr;
  }

  const nt = nes.nametable();
  const tilePal = [], tileIds = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tilePal.push(nes.paletteAt(minC + c, minR + r));
      tileIds.push(nt[(minR + r) * 32 + (minC + c)]);
    }
  }
  return { col: minC, row: minR, cols, rows, tilePal, tileIds };
}

module.exports = { catalogEntry, capture, captureByPalette, patternIndex };

// ── CLI: capture whatever monster is on screen in the saved battle ─────
if (require.main === module) {
  const id = parseInt(process.argv[2] || '0x00', 16);
  const nes = new Nes(REPO + '/FF3-English.nes');
  nes.load(JSON.parse(readFileSync(__dirname + '/battle-state.json', 'utf8')));
  nes.run(2);
  const entry = catalogEntry(id);
  if (!entry) { console.log('no catalog entry for 0x' + id.toString(16)); process.exit(1); }
  console.log(`monster 0x${id.toString(16).padStart(2, '0')}  grid ${entry.cols}x${entry.rows}`);
  const res = capture(nes, entry);
  if (!res) { console.log('NOT FOUND on screen'); process.exit(2); }
  console.log('found at nametable col', res.origin.col, 'row', res.origin.row,
              `(${res.matched} tiles matched)`);
  console.log('tilePal:', JSON.stringify(res.tilePal));
  const uniq = [...new Set(res.tilePal)];
  console.log('palettes used:', uniq.join(', '),
              uniq.length === 1 ? '(single-palette monster)' : '(split)');
}
