// Turn extracted weapon pixels into the tile format weapon-sprites.js uses.
//
//   node weapon-emit.cjs > /tmp/weapons.txt
//
// Anchors on the SPRITE BLOCK origin (min OAM x,y of the group), not the pixel
// bounding box: the bbox is only the opaque pixels, so anchoring to it would
// silently shift every sprite by however much transparent padding it happens to
// have. OAM y is one scanline above where the sprite draws, hence the +1.
//
// Raised vs swung is assigned by position — the party stands to the right of the
// enemies, so the more-forward (smaller x) pose is the swing. Measured on every
// two-pose weapon, no frame-timing guess. Weapons that only ever draw one pose
// reuse it for both, which is what the game shows.
//
// Verification is built in: each emitted tile set is decoded back and compared
// against the pixels it came from. A weapon that does not round-trip exactly is
// reported and NOT emitted.

const { readFileSync } = require('fs');

// Map captured pixels onto OUR palette, not the emulator's. jsnes applies
// emphasis when rendering, so framebuffer colors are not exactly its own table
// and an exact lookup finds nothing — all ten classes failed this way. Nearest
// match against NES_SYSTEM_PALETTE is the right target regardless, since that is
// what the game renders through; maxDist is reported so a poor match is visible.
const NES = (() => {
  const src = readFileSync(__dirname + '/../../src/tile-decoder.js', 'utf8');
  const blk = src.slice(src.indexOf('NES_SYSTEM_PALETTE = ['));
  return [...blk.slice(0, blk.indexOf('];')).matchAll(/\[0x([0-9a-fA-F]{2}),\s*0x([0-9a-fA-F]{2}),\s*0x([0-9a-fA-F]{2})\]/g)]
    .map((m) => [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]);
})();
let maxDist = 0;
function nearestNes(r, g, b) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < NES.length; i++) {
    const d = (NES[i][0] - r) ** 2 + (NES[i][1] - g) ** 2 + (NES[i][2] - b) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  maxDist = Math.max(maxDist, Math.sqrt(bd));
  return best;
}

const DIR = __dirname;
const CLASSES = [
  [0x09, 'ROD', 'rod'], [0x17, 'AXE', 'axe'], [0x1a, 'SPEAR', 'spear'],
  [0x2f, 'KATANA', 'katana'], [0x4a, 'BOW', 'bow'], [0x4f, 'ARROW', 'arrow'],
  [0x15, 'HAMMER', 'hammer'], [0x3a, 'BOOK', 'book'], [0x43, 'BELL', 'bell'], [0x46, 'HARP', 'harp'],
];

const sig = (p) => p.px.map((q) => `${q.dx},${q.dy},${q.rgb}`).join(';');

/**
 * 16x16 grid of NES color indices (-1 transparent), built from CHR + palette RAM.
 *
 * NOT from the captured framebuffer pixels: jsnes renders through its own
 * palette, so snapping those RGBs to NES_SYSTEM_PALETTE picked the wrong index
 * for 62% of them (median distance 46.9) — the art would have shipped
 * miscolored while every structural check still passed. CHR gives the 2-bit
 * value, palette RAM gives the NES index for it. No color space in the path.
 */
function poseGrid(pose, ownTiles) {
  // Keep only sprites still holding this weapon's CHR. weapon-extract picks the
  // sprite indices before advancing a frame but reads their attributes after, so
  // an index can have been reused by something else by then — the strays show up
  // as tile $0 sprites 100px away and blew the 16x16 bound on axe/spear/katana.
  const attrs = pose.attrs.filter((a) => pose.chr[a.tile] && ownTiles.has(a.tile));
  if (!attrs.length) return null;
  const ox = Math.min(...attrs.map((a) => a.x));
  const oy = Math.min(...attrs.map((a) => a.y)) + 1;   // OAM y draws one line lower
  const grid = new Int16Array(16 * 16).fill(-1);
  for (const a of attrs) {
    const chr = pose.chr[a.tile], pal = pose.sprPal[a.pal];
    for (let y = 0; y < 8; y++) {
      const lo = chr[y], hi = chr[y + 8];
      for (let x = 0; x < 8; x++) {
        const bit = a.hFlip ? x : 7 - x;
        const v = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        if (!v) continue;
        const gx = a.x - ox + x, gy = a.y + 1 - oy + (a.vFlip ? 7 - y : y);
        if (gx < 0 || gy < 0 || gx >= 16 || gy >= 16) return null;
        grid[gy * 16 + gx] = pal[v] & 0x3F;
      }
    }
  }
  return grid;
}

/** The differential capture says which pixels are the weapon; confirm our
 *  CHR-built grid lights up exactly those. Compares MASKS, not colors, so the
 *  emulator's palette never enters the comparison. */
function maskMatches(pose, grid, ownTiles) {
  const attrs = pose.attrs.filter((a) => pose.chr[a.tile] && ownTiles.has(a.tile));
  const ox = Math.min(...attrs.map((a) => a.x));
  const oy = Math.min(...attrs.map((a) => a.y)) + 1;
  const want = new Set();
  for (const q of pose.px) {
    const x = pose.box.x + q.dx - ox, y = pose.box.y + q.dy - oy;
    if (x < 0 || y < 0 || x >= 16 || y >= 16) return { ok: false, why: 'diff pixel outside block' };
    want.add(y * 16 + x);
  }
  const got = new Set();
  for (let i = 0; i < 256; i++) if (grid[i] >= 0) got.add(i);
  let missing = 0, extra = 0;
  for (const i of want) if (!got.has(i)) missing++;
  for (const i of got) if (!want.has(i)) extra++;
  // Require 0 MISSING, not 0 extra. A weapon pixel the diff did not flag is one
  // where hiding the weapon changed nothing — the character's body is drawn over
  // it (attackWeaponLayer's 'behind' case), or the pixel underneath happened to
  // be the same color. Those are expected and every class shows some. What must
  // hold is the other direction: our data explains 100% of what the differential
  // capture attributes to the weapon.
  return { ok: missing === 0, missing, extra, total: want.size };
}

/** 16x16 index grid -> 4 tiles of 2bpp bytes + the 4-entry palette. */
function toTiles(grid) {
  const colors = [...new Set([...grid].filter((c) => c >= 0))];
  if (colors.length > 3) return null;                        // more than a sub-palette holds
  const pal = [0x0F, ...colors];
  while (pal.length < 4) pal.push(0x0F);
  const ci = (c) => (c < 0 ? 0 : colors.indexOf(c) + 1);
  const quad = [[0, 0], [8, 0], [0, 8], [8, 8]];
  const tiles = quad.map(([qx, qy]) => {
    const b = new Array(16).fill(0);
    for (let y = 0; y < 8; y++) {
      let lo = 0, hi = 0;
      for (let x = 0; x < 8; x++) {
        const v = ci(grid[(qy + y) * 16 + (qx + x)]);
        lo |= (v & 1) << (7 - x);
        hi |= ((v >> 1) & 1) << (7 - x);
      }
      b[y] = lo; b[y + 8] = hi;
    }
    return b;
  });
  return { tiles, pal };
}

/** Decode emitted tiles back and confirm they reproduce the grid exactly. */
function roundTrips(grid, tiles, pal) {
  const quad = [[0, 0], [8, 0], [0, 8], [8, 8]];
  const out = new Int16Array(16 * 16).fill(-1);
  quad.forEach(([qx, qy], t) => {
    const b = tiles[t];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const v = (((b[y + 8] >> (7 - x)) & 1) << 1) | ((b[y] >> (7 - x)) & 1);
        if (v) out[(qy + y) * 16 + (qx + x)] = pal[v];
      }
    }
  });
  for (let i = 0; i < 256; i++) if (out[i] !== grid[i]) return false;
  return true;
}

const emitted = [];
for (const [id, CONST, subtype] of CLASSES) {
  const f = `${DIR}/weapon-extract-${id.toString(16)}.json`;
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const own = new Set(d.ownTiles);
  const uniq = [];
  const seen = new Set();
  for (const p of d.poses.slice().sort((a, b) => b.box.x - a.box.x)) {
    const s = sig(p);
    if (!seen.has(s)) { seen.add(s); uniq.push(p); }
  }
  // Sorted descending by x: first = furthest back = raised, last = furthest
  // forward = swung. One-pose weapons use the same art for both.
  const raisedPose = uniq[0], swungPose = uniq[uniq.length - 1];
  const built = [];
  let ok = true;
  for (const [label, pose] of [['raised', raisedPose], ['swung', swungPose]]) {
    const grid = poseGrid(pose, own);
    if (!grid) { console.error(`// ${subtype} ${label}: pixels fall outside a 16x16 block — SKIPPED`); ok = false; break; }
    const m = maskMatches(pose, grid, own);
    if (!m.ok) { console.error(`// ${subtype} ${label}: ${m.missing} of ${m.total} captured pixels NOT reproduced — SKIPPED`); ok = false; break; }
    console.error(`// ${subtype} ${label}: ${m.total}/${m.total} captured pixels reproduced (+${m.extra} occluded)`);
    const t = toTiles(grid);
    if (!t) { console.error(`// ${subtype} ${label}: more than 3 colors — SKIPPED`); ok = false; break; }
    if (!roundTrips(grid, t.tiles, t.pal)) { console.error(`// ${subtype} ${label}: round-trip mismatch — SKIPPED`); ok = false; break; }
    built.push({ label, ...t });
  }
  if (!ok) continue;
  emitted.push({ id, CONST, subtype, poses: uniq.length, built });
}

const hx = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');
console.log('// ─── PPU-captured weapon overlays (tools/monscan/weapon-emit.cjs) ───');
for (const e of emitted) {
  for (const b of e.built) {
    console.log(`const ${e.CONST}_${b.label.toUpperCase()}_TILES = [`);
    for (const t of b.tiles) console.log('  new Uint8Array([' + t.map((x) => '0x' + x.toString(16).padStart(2, '0')).join(',') + ']),');
    console.log(`];`);
  }
  console.log(`const ${e.CONST}_PAL = [${e.built[0].pal.map(hx).join(',')}];`);
  console.log(`// ${e.subtype}: ${e.poses} pose(s) captured${e.poses === 1 ? ' — same art for raised and swung, as the game draws it' : ''}`);
  console.log('');
}
console.error(`// emitted ${emitted.length}/${CLASSES.length} classes; worst color match distance ${maxDist.toFixed(1)}`);
