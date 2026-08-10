// Emit on-target spell animations using ROM-BLOCK PROVENANCE for the phase.
//
//   node spell-emit-rom.cjs --check     # reproduce the shipped spells, emit nothing
//   node spell-emit-rom.cjs             # write src/data/spell-anim-captured.js
//
// spell-emit.cjs selects the impact by matching a fixed group ORIGIN, which is
// fine for a point burst like Fire and wrong for anything that moves or
// expands — which is most of the catalogue. This one selects by SLOT: the
// sprites drawn from the spell's own ROM block while that block is live. No
// screen position enters the decision, so a screen-wide or ally-side effect is
// no harder than a point impact.
//
// Phase assignment is spell-phases-rom.cjs's: a run loaded by an entire school
// (24 spells) is that school's cast animation, and what is left is the spell's
// own art. That rule reproduces Fire, Bzzard, Sleep and Cure — every shipped
// spell whose effect actually renders. (Pure/$35 never renders on a healthy
// target, and its art already ships and is shared with Antidote.)
//
// Everything emitted is measured: tile bytes from the ROM at the offsets the
// capture proved were copied into each slot, layouts and flips from OAM,
// palette from PPU palette RAM, hold from the median measured state duration.

const { readFileSync, writeFileSync } = require('fs');

const REPO = '/home/joeltco/projects/ff3mmo';
const rom = readFileSync(REPO + '/FF3-English.nes');
const sweep = JSON.parse(readFileSync(__dirname + '/spell-sweep.json', 'utf8'));
const OUT = REPO + '/src/data/spell-anim-captured.js';
const NES_FRAME_MS = 1000 / 60.0988;
// Source rect for screen-anchored effects: the NES battle scene above the
// message boxes. Captured sprites span y1-147, so 152 covers it.
const NES_SRC_W = 256, NES_SRC_H = 152;

// Spells with a hand-captured, parity-gated entry in spell-anim.js.
// CLAUDE.md: don't rewrite working animation code.
const SHIPPED = new Set([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x3a]);
const SHARED_MIN = 12;                     // a run an entire school loads is a cast animation

function runsOf(blocks) {
  const out = [];
  for (const b of blocks.slice().sort((x, y) => x.off - y.off)) {
    const last = out[out.length - 1];
    if (last && b.off === last.end + 16) { last.end = b.off; last.n++; last.blocks.push(b); }
    else out.push({ start: b.off, end: b.off, n: 1, blocks: [b] });
  }
  return out;
}

const shareCount = new Map();
const perSpell = new Map();
for (const r of sweep.results) {
  const rs = runsOf(r.blocks || []);
  perSpell.set(r.id, rs);
  for (const start of new Set(rs.map((x) => x.start))) shareCount.set(start, (shareCount.get(start) || 0) + 1);
}

/** Frames where sprites are drawn from `run`, honouring each block's window. */
function drawnFrames(rec, run, minSprites = 1) {
  const win = new Map();                   // slot -> [first,last,off]
  for (const b of run.blocks) for (const s of b.slots) win.set(s, [b.first, b.last, b.off]);
  const out = [];
  for (const fr of rec.frames || []) {
    const spr = fr.spr.filter((s) => {
      const w = win.get(s.tile);
      return w && fr.f >= w[0] && fr.f <= w[1];
    });
    if (spr.length >= minSprites) out.push({ f: fr.f, spr, pal: fr.pal, win });
  }
  return out;
}

function impactRun(rec) {
  const own = (perSpell.get(rec.id) || []).filter((r) => (shareCount.get(r.start) || 0) < SHARED_MIN);
  // Rank by multi-sprite frames: the projectile rides the same 24-tile copy and
  // would otherwise win on frame count alone.
  const ranked = own.map((r) => ({ r, n: drawnFrames(rec, r, 3).length })).filter((x) => x.n > 0);
  ranked.sort((a, b) => b.n - a.n);
  return ranked.length ? ranked[0].r : null;
}

function build(rec) {
  const run = impactRun(rec);
  if (!run) return null;
  const frames = drawnFrames(rec, run, 3);
  if (!frames.length) return null;

  const states = [];
  const key = (spr) => spr.map((s) => `${s.tile},${s.x},${s.y},${s.pal},${s.h ? 1 : 0}${s.v ? 1 : 0}`).sort().join('|');
  for (const fr of frames) {
    const k = key(fr.spr);
    const last = states[states.length - 1];
    if (last && last.key === k) { last.hold++; continue; }
    states.push({ key: k, hold: 1, spr: fr.spr, pal: fr.pal, win: fr.win });
  }
  if (states.length < 2) return { states: states.length, tooStatic: true };

  const tiles = [];
  const tileIdx = new Map();
  const hexOf = (s, st) => {
    const off = st.win.get(s.tile)[2];
    return rom.slice(off, off + 16).toString('hex');
  };
  for (const st of states) {
    for (const s of st.spr) {
      const hex = hexOf(s, st);
      if (!tileIdx.has(hex)) { tileIdx.set(hex, tiles.length); tiles.push(hex); }
    }
  }
  const xs = states.flatMap((st) => st.spr.map((s) => s.x));
  const ys = states.flatMap((st) => st.spr.map((s) => s.y));
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const width = Math.max(...xs) + 8 - minX, height = Math.max(...ys) + 8 - minY;

  // Both forms are emitted from the same source; `screen` decides which is
  // used, and is set by the caller once the size is known.
  const rel = states.map((st) => st.spr.map((s) => [
    tileIdx.get(hexOf(s, st)), s.x - minX, s.y - minY, s.h ? 1 : 0, s.v ? 1 : 0,
  ]));
  const abs = states.map((st) => st.spr.map((s) => [
    tileIdx.get(hexOf(s, st)), s.x, s.y, s.h ? 1 : 0, s.v ? 1 : 0,
  ]));
  const layouts = rel;
  // The palette the effect's own sprites actually use. Sub-palette index comes
  // from OAM, the entries from PPU palette RAM at that frame.
  const palIdx = states[0].spr[0].pal;
  const pal = states[0].pal.slice(palIdx * 4, palIdx * 4 + 4);

  const holds = states.slice(0, -1).map((s) => s.hold).filter((h) => h > 0).sort((a, b) => a - b);
  const holdMs = Math.round((holds.length ? holds[holds.length >> 1] : 4) * NES_FRAME_MS);

  return { run, pal, tiles, layouts, abs, width, height, holdMs, states: states.length };
}

// Target side, straight out of spells.js. `anchor` is metadata — the render
// paths dispatch on `kind`, and drawSpellEffectAtTargets centres the canvas on
// whichever target it is handed — but emitting 'enemy-center' for a heal would
// be a lie sitting in the data for the next reader.
const SPELL_TARGET = (() => {
  const src = readFileSync(REPO + '/src/data/spells.js', 'utf8');
  const out = new Map();
  for (const m of src.matchAll(/\[0x([0-9a-fA-F]{2}),\s*\{([^}]*)\}\]/g)) {
    const t = (m[2].match(/target: '([^']+)'/) || [])[1];
    out.set(parseInt(m[1], 16), t || 'enemy');
  }
  return out;
})();
const ALLY_SIDE = new Set(['ally', 'revive', 'cure_status', 'haste', 'protect', 'restore', 'reflect', 'elixir']);
const anchorFor = (id) => (ALLY_SIDE.has(SPELL_TARGET.get(id)) ? 'portrait-center' : 'enemy-center');

const SPELL_NAMES = (() => {
  const src = readFileSync(REPO + '/src/data/spells.js', 'utf8');
  const shrines = new Map();
  const blk = src.slice(src.indexOf('SPELL_NAMES_SHRINES'));
  for (const m of blk.matchAll(/\[0x([0-9a-fA-F]{2}),\s*'([^']+)'\]/g)) shrines.set(parseInt(m[1], 16), m[2]);
  for (const m of src.matchAll(/\[0x([0-9a-fA-F]{2}),\s*\{[^}]*\}\],\s*\/\/\s*(.+)/g)) {
    const id = parseInt(m[1], 16);
    if (!shrines.has(id)) shrines.set(id, m[2].trim());
  }
  return shrines;
})();

// ── self-check against the shipped, parity-gated captures ──────────
if (process.argv.includes('--check')) {
  const anim = readFileSync(REPO + '/src/spell-anim.js', 'utf8');
  const shippedTiles = (p) => [...anim.matchAll(new RegExp(`const ${p}[0-9A-Z_]* = new Uint8Array\\(\\[([^\\]]+)\\]\\)`, 'g'))]
    .map((m) => m[1].split(',').map((v) => parseInt(v.trim(), 16).toString(16).padStart(2, '0')).join(''));
  let pass = 0, n = 0;
  for (const [id, prefix] of [[0x31, 'FIRE_T_'], [0x32, 'BLIZZARD_T_'], [0x33, 'SLEEP_T_'], [0x34, 'CURE_T_']]) {
    n++;
    const b = build(sweep.results.find((r) => r.id === id));
    if (!b || b.tooStatic) { console.log(`  $${id.toString(16)} ${SPELL_NAMES.get(id)}: nothing built`); continue; }
    const want = shippedTiles(prefix);
    const mine = new Set(b.tiles);
    const hit = want.filter((t) => mine.has(t)).length;
    const ok = hit === want.length;
    if (ok) pass++;
    console.log(`  $${id.toString(16)} ${(SPELL_NAMES.get(id) || '').padEnd(8)} ${ok ? 'MATCH' : 'MISS '} ` +
      `${hit}/${want.length} shipped tiles · ${b.states} states · ${b.width}x${b.height} · ${b.holdMs}ms`);
  }
  console.log(`\n${pass}/${n} shipped spells reproduced`);
  process.exit(pass === n ? 0 : 1);
}

// ── emit ───────────────────────────────────────────────────────────
const built = new Map(), skipped = [];
for (const rec of sweep.results) {
  if (SHIPPED.has(rec.id)) { skipped.push(`$${rec.id.toString(16)} already shipped`); continue; }
  const b = build(rec);
  if (!b) { skipped.push(`$${rec.id.toString(16)} no impact run with drawn sprites`); continue; }
  if (b.tooStatic) { skipped.push(`$${rec.id.toString(16)} only ${b.states} state — static, not an animation`); continue; }
  // The registry's 'burst-strip-2frame' kind is "cycle these frames at toggleMs,
  // anchored on the target". An effect that TRAVERSES the screen is not that
  // shape: it comes out as a near-full-screen canvas whose states each last a
  // single frame, and centring that on the enemy would put it in the wrong
  // place entirely. Hold those back rather than register a misrepresentation —
  // they need a travelling-effect kind that does not exist yet.
  // Effects that traverse the screen are not target-anchored bursts: Meteo
  // spans x8-240 y7-139 with 30-odd sprites at once, Drain starts spread and
  // collapses onto the target, Kill sweeps from the caster past the enemy to
  // the bottom-left. Centring a canvas that size on a target would be nonsense.
  // They are emitted SCREEN-ANCHORED instead — absolute captured coordinates,
  // replayed across the whole map-HUD band.
  if (b.width > 64 || b.height > 64 || b.holdMs < 33) {
    b.screen = true;
    b.width = NES_SRC_W; b.height = NES_SRC_H;
  }
  built.set(rec.id, b);
}

const hx = (v) => '0x' + v.toString(16).padStart(2, '0');
const bytesOf = (hex) => hex.match(/../g).map((h) => '0x' + h).join(',');
const lines = [
  '// On-target spell animations captured off the PPU. GENERATED — do not hand-edit.',
  '//',
  '//   node tools/monscan/spell-emit-rom.cjs',
  '//',
  '// Tile bytes are read from the ROM at the offsets a live capture proved were',
  '// copied into each sprite slot; layouts and flips are OAM values; the palette is',
  '// PPU palette RAM; the hold is the median measured state duration. The phase',
  '// comes from ROM-block provenance — a block an entire school loads is that',
  '// school\'s cast animation, the rest is the spell\'s own art — which reproduces',
  '// every shipped spell whose effect renders. Nothing here was authored by hand;',
  '// see CLAUDE.md on why that matters for this subsystem.',
  '//',
  '// `layouts` entries are [tileIndex, dx, dy, hflip, vflip].',
  '',
  'export const CAPTURED_SPELL_ANIMS = new Map([',
];
for (const [id, b] of [...built.entries()].sort((a, c) => a[0] - c[0])) {
  lines.push(`  [${hx(id)}, {   // ${SPELL_NAMES.get(id) || '?'} — impact block $${b.run.start.toString(16)}`);
  lines.push(`    pal: [${b.pal.map(hx).join(', ')}],`);
  lines.push(`    width: ${b.width}, height: ${b.height}, holdMs: ${b.holdMs},`);
  lines.push(`    anchor: '${b.screen ? 'screen' : anchorFor(id)}',`);
  lines.push('    tiles: [');
  for (const t of b.tiles) lines.push(`      new Uint8Array([${bytesOf(t)}]),`);
  lines.push('    ],');
  lines.push('    layouts: [');
  for (const l of (b.screen ? b.abs : b.layouts)) lines.push(`      [${l.map((e) => `[${e.join(',')}]`).join(',')}],`);
  lines.push('    ],');
  lines.push('  }],');
}
lines.push(']);', '');
writeFileSync(OUT, lines.join('\n'));
console.log(`emitted ${built.size} spell animations -> ${OUT}`);
for (const s of skipped) console.log(`  skipped: ${s}`);
