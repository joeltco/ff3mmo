// Emit the eight summon creatures from the full-slot capture.
//
//   node summon-emit.cjs
//
// Writes src/data/summon-anim-captured.js. That module is NOT imported by
// spell-anim.js: summons are specified to play as a sequence — the roster fades
// out, the creature enters the player box, casts, the roster fades back — and
// none of that exists yet. Registering them into CAPTURED_SPELL_ANIMS would
// draw a creature on top of an un-faded roster, which is not the effect. The
// data lands here; wiring is one import away once the sequence is built.
//
// Isolation is provenance in two layers, no geometry:
//
//   1. The creature is the DOMINANT contiguous ROM region for that summon —
//      one ~51-55 tile block each, in a band from $19810 to $1a4e0. $55810 is
//      loaded by all eight (the shared spark burst) and $55cd0 is shared with
//      the Bolt spells, so neither can be a creature.
//   2. Each block's frame WINDOW is honoured. Matching slots across the whole
//      run instead pulls in party-portrait sprites occupying the same slots
//      before the art loads, which is what produced full-screen bounding boxes
//      spanning every frame on the first two attempts.
//
// Coordinates are absolute and the source rect matches the screen-anchored
// spells ($02/$07/$09/$16), so these can ride the existing 'screen-strip' path
// unchanged if that turns out to be the right home for them.

const { readFileSync, writeFileSync } = require('fs');

const REPO = '/home/joeltco/projects/ff3mmo';
const rom = readFileSync(REPO + '/FF3-English.nes');
const cap = JSON.parse(readFileSync(__dirname + '/spell-summon.json', 'utf8'));
const OUT = REPO + '/src/data/summon-anim-captured.js';
const NES_FRAME_MS = 1000 / 60.0988;
const NES_SRC_W = 256, NES_SRC_H = 152;

// CREATURE names, from the ROM's own STRING_SUMMONS table ($0607), where each
// appears three times — once per job tier. An earlier version of this file used
// the STRING_SPELLS names (Catas / Hyper / Heatra / Spark / Icen / Escape),
// which label the per-level SPELL, not the creature, and made it look as though
// SPELL_NAMES_SHRINES were wrong. It is not: it already carries these names.
const NAMES = {
  0x06: 'Bahamut', 0x0d: 'Leviathan', 0x14: 'Odin', 0x1b: 'Titan',
  0x22: 'Ifrit', 0x29: 'Ramuh', 0x30: 'Shiva', 0x37: 'Chocobo',
};

// $55810 is loaded by all eight — the shared "call" spark burst that plays for
// every summon, so it belongs to no one creature.
const SHARED_CALL = 0x55810;

/** Sprites drawn from `regions`, honouring each block's frame window. */
function sequence(rec, regions) {
  const win = new Map(), srcOff = new Map();
  for (const a of rec.art) {
    if (!regions.some((g) => a.off >= g.start && a.off <= g.end)) continue;
    for (const s of a.slots) {
      const w = win.get(s);
      win.set(s, w ? [Math.min(w[0], a.first), Math.max(w[1], a.last)] : [a.first, a.last]);
      if (!srcOff.has(s)) srcOff.set(s, a.off);
    }
  }
  const frames = rec.frames
    .map((f) => ({ f: f.f, pal: f.pal, spr: f.spr.filter((s) => {
      const w = win.get(s.tile);
      return w && f.f >= w[0] && f.f <= w[1];
    }) }))
    .filter((f) => f.spr.length >= 3);
  return { frames, srcOff };
}

function pack(seq, rom) {
  const { frames, srcOff } = seq;
  if (!frames.length) return null;
  const states = [];
  const key = (spr) => spr.map((s) => `${s.tile},${s.x},${s.y},${s.pal},${s.h ? 1 : 0}${s.v ? 1 : 0}`).sort().join('|');
  for (const fr of frames) {
    const k = key(fr.spr);
    const last = states[states.length - 1];
    if (last && last.key === k) { last.hold++; continue; }
    states.push({ key: k, hold: 1, spr: fr.spr, pal: fr.pal });
  }
  const tiles = [], tileIdx = new Map(), pals = [], palIdx = new Map();
  const hexOf = (s) => { const off = srcOff.get(s.tile); return rom.slice(off, off + 16).toString('hex'); };
  const palOf = (s, st) => {
    const row = st.pal.slice(16 + s.pal * 4, 16 + s.pal * 4 + 4);
    const k = row.join(',');
    if (!palIdx.has(k)) { palIdx.set(k, pals.length); pals.push(row); }
    return palIdx.get(k);
  };
  for (const st of states) for (const s of st.spr) {
    const hex = hexOf(s);
    if (!tileIdx.has(hex)) { tileIdx.set(hex, tiles.length); tiles.push(hex); }
  }
  const layouts = states.map((st) => st.spr.map((s) => [
    tileIdx.get(hexOf(s)), s.x, s.y, s.h ? 1 : 0, s.v ? 1 : 0, palOf(s, st),
  ]));
  const xs = states.flatMap((st) => st.spr.map((s) => s.x));
  const ys = states.flatMap((st) => st.spr.map((s) => s.y));
  return {
    pals, tiles, layouts,
    holds: states.map((s) => Math.round(s.hold * NES_FRAME_MS)),
    box: { x0: Math.min(...xs), x1: Math.max(...xs) + 8, y0: Math.min(...ys), y1: Math.max(...ys) + 8 },
  };
}

function build(rec) {
  const big = rec.regions.slice().sort((a, b) => b.tiles - a.tiles)[0];
  if (!big) return null;
  const creature = pack(sequence(rec, [big]), rom);
  if (!creature) return null;
  // The MAGIC the summon performs. Everything the cast loads that is neither
  // the creature nor the shared call burst: Bahamut $571d0, Leviathan $57170,
  // Ifrit $57050, Ramuh $55cd0 (the same bolt Bolt/Bolt2/Bolt3 use) + $56750,
  // Shiva $57430, Chocobo $57470. Odin and Titan load none — their only extra
  // region IS the shared burst.
  const fxRegions = rec.regions.filter((g) => g.start !== big.start && g.start !== SHARED_CALL);
  const effect = fxRegions.length ? pack(sequence(rec, fxRegions), rom) : null;
  return {
    ...creature, creature, effect,
    states: creature.layouts.length,
    region: big,
    fxRegions,
    fadeFrames: rec.fadeFrames,
  };
}

const hx = (v) => '0x' + v.toString(16).padStart(2, '0');
const bytesOf = (hex) => hex.match(/../g).map((h) => '0x' + h).join(',');
const built = new Map();
for (const rec of cap.results) {
  const b = build(rec);
  if (!b) { console.log(`  skipped $${rec.id.toString(16)} — no creature block`); continue; }
  built.set(rec.id, b);
}

const lines = [
  '// Summon creatures captured off the PPU. GENERATED — do not hand-edit.',
  '//',
  '//   node tools/monscan/summon-emit.cjs',
  '//',
  '// NOT wired into spell-anim.js. Summons play as a sequence — roster fades',
  '// out, creature enters the player box, casts, roster fades back — and that',
  '// sequence does not exist yet. Registering these into CAPTURED_SPELL_ANIMS',
  '// would draw a creature over an un-faded roster.',
  '//',
  '// Coordinates are ABSOLUTE NES screen positions against a 256x152 source',
  '// rect, matching the screen-anchored spells, so these can ride the existing',
  "// 'screen-strip' path unchanged.",
  '//',
  '// `layouts` entries are [tileIndex, x, y, hflip, vflip, paletteIndex], played',
  '// ONCE in order — `holds[i]` is how long state i is shown, in ms. These are',
  '// NOT cycling effects: most are a short entrance then a long standing hold.',
  '// `fadeFrames` is how many frames of the capture showed the roster fading',
  '// (>120 changed nametable cells or a >4-entry palette shift).',
  '',
  `export const SUMMON_SRC_W = ${NES_SRC_W};`,
  `export const SUMMON_SRC_H = ${NES_SRC_H};`,
  '',
  'export const CAPTURED_SUMMONS = new Map([',
];
for (const [id, b] of [...built.entries()].sort((a, c) => a[0] - c[0])) {
  lines.push(`  [${hx(id)}, {   // ${NAMES[id] || '?'} — creature block $${b.region.start.toString(16)} (${b.region.tiles} tiles)`);
  lines.push(`    pals: [${b.pals.map((p) => `[${p.map(hx).join(',')}]`).join(', ')}],`);
  lines.push(`    holds: [${b.holds.join(', ')}],   // ms per state, played in order once`);
  lines.push(`    fadeFrames: ${b.fadeFrames},`);
  lines.push(`    box: { x0: ${b.box.x0}, x1: ${b.box.x1}, y0: ${b.box.y0}, y1: ${b.box.y1} },`);
  lines.push('    tiles: [');
  for (const t of b.tiles) lines.push(`      new Uint8Array([${bytesOf(t)}]),`);
  lines.push('    ],');
  lines.push('    layouts: [');
  for (const l of b.layouts) lines.push(`      [${l.map((e) => `[${e.join(',')}]`).join(',')}],`);
  lines.push('    ],');
  if (b.effect) {
    lines.push(`    effect: {   // ${b.fxRegions.map((g) => '$' + g.start.toString(16) + '(' + g.tiles + 't)').join(' ')}`);
    lines.push(`      pals: [${b.effect.pals.map((p) => `[${p.map(hx).join(',')}]`).join(', ')}],`);
    lines.push(`      holds: [${b.effect.holds.join(', ')}],`);
    lines.push(`      box: { x0: ${b.effect.box.x0}, x1: ${b.effect.box.x1}, y0: ${b.effect.box.y0}, y1: ${b.effect.box.y1} },`);
    lines.push('      tiles: [');
    for (const t of b.effect.tiles) lines.push(`        new Uint8Array([${bytesOf(t)}]),`);
    lines.push('      ],');
    lines.push('      layouts: [');
    for (const l of b.effect.layouts) lines.push(`        [${l.map((e) => `[${e.join(',')}]`).join(',')}],`);
    lines.push('      ],');
    lines.push('    },');
  }
  lines.push('  }],');
}
lines.push(']);', '');
writeFileSync(OUT, lines.join('\n'));
console.log(`emitted ${built.size} summons -> ${OUT}`);
for (const [id, b] of [...built.entries()].sort((a, c) => a[0] - c[0])) {
  console.log(`  $${id.toString(16).padStart(2, '0')} ${(NAMES[id] || '?').padEnd(9)}` +
    `${b.states} states, ${b.tiles.length} tiles, ${b.pals.length} palette(s), ` +
    `${b.holds.reduce((a, c) => a + c, 0)}ms, ` +
    `effect ${b.effect ? b.effect.layouts.length + ' states' : 'none'}, ` +
    `box x${b.box.x0}-${b.box.x1} y${b.box.y0}-${b.box.y1}, fade ${b.fadeFrames}f`);
}
