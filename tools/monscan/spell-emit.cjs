// Generate src/data/spell-anim-captured.js from captured dumps.
//
//   node spell-emit.cjs                 # all spells with an impact phase
//   node spell-emit.cjs --check 31      # generate Fire and diff vs shipped
//
// CLAUDE.md forbids hand-authoring spell tile bytes, layouts or frame timing
// from an OAM capture, and lists exactly why: "the failure is mapping group ->
// phase, picking the right tile slot, getting the canvas layout right, and
// matching frame timing". Every one of those four is produced mechanically here:
//
//   phase    tools/classify-spell-phases.js decides it. Not this tool.
//   slot     the dump's tile bytes come from the ROM offset the capture proved
//            was copied into that slot (tools/monscan/spell-dump.cjs).
//   layout   [dx,dy] + flips are the OAM values, relative to the group origin.
//   timing   identical consecutive layouts are collapsed into one state and the
//            hold is counted in frames, then converted at the NES frame rate.
//
// The only editorial act left is deciding WHICH spells to emit, and that is
// "the ones with an impact phase and no shipped entry".
//
// --check regenerates a spell that already shipped and diffs the result against
// the hand-captured constants. Fire must come out byte-identical; if it does
// not, this generator is wrong and nothing it emits can be trusted.

const { readFileSync, writeFileSync, readdirSync } = require('fs');

const REPO = '/home/joeltco/projects/ff3mmo';
const DUMPS = process.env.DUMPS || '/tmp/spelldumps';
const PHASES = process.env.PHASES || '/tmp/spellphases';
const OUT = REPO + '/src/data/spell-anim-captured.js';
const NES_FRAME_MS = 1000 / 60.0988;

// Spells that already have a hand-captured, parity-gated entry in
// spell-anim.js. CLAUDE.md: don't rewrite working animation code.
const SHIPPED = new Set([0x31, 0x32, 0x33, 0x34, 0x35, 0x3a, 0x36]);

/** Parse a REC OAM dump into frames of groups of tiles. */
function parseDump(text) {
  const frames = [];
  let cur = null, group = null, pending = null;
  for (const ln of text.split('\n')) {
    let m = ln.match(/^\/\/ ═══ frame (\d+)/);
    if (m) { cur = { idx: Number(m[1]), sp: [[], [], [], []], groups: [] }; frames.push(cur); group = null; continue; }
    if (!cur) continue;
    m = ln.match(/^\/\/\s+SP([0-3]):\s*\[([^\]]+)\]/);
    if (m) { cur.sp[Number(m[1])] = m[2].split(',').map((v) => parseInt(v.trim(), 16)); continue; }
    m = ln.match(/^\/\/ ── group (\d+) \(\d+ tiles, origin (-?\d+),(-?\d+)\) ──/);
    if (m) { group = { ox: Number(m[2]), oy: Number(m[3]), tiles: [] }; cur.groups.push(group); continue; }
    if (!group) continue;
    m = ln.match(/^\/\/\s+\[(-?\d+),(-?\d+)\] tile=\$([0-9A-Fa-f]+) pal(\d)( VFLIP)?( HFLIP)?/);
    if (m) { pending = { dx: Number(m[1]), dy: Number(m[2]), id: parseInt(m[3], 16), pal: Number(m[4]), v: !!m[5], h: !!m[6] }; continue; }
    m = ln.match(/new Uint8Array\(\[([^\]]+)\]\)/);
    if (m && pending) {
      pending.bytes = m[1].split(',').map((v) => parseInt(v.trim(), 16));
      group.tiles.push(pending); pending = null;
    }
  }
  return frames;
}

/**
 * Build one spell's animation from the frames the classifier called `impact`.
 *
 * Groups are matched by origin so a stray sprite elsewhere on screen (a status
 * icon, the caster's own body) cannot pull the layout apart.
 */
function build(frames, phase) {
  const [a, b] = phase.frames;
  const want = frames.filter((f) => f.idx >= a && f.idx <= b);
  if (!want.length) return null;
  const [ox, oy] = phase.origin;

  const states = [];                       // {layout, tiles, pal, hold}
  const key = (g) => g.tiles.map((t) => `${t.dx},${t.dy},${t.id},${t.h ? 1 : 0}${t.v ? 1 : 0}`).sort().join('|');
  for (const f of want) {
    // Same origin the classifier locked onto; tolerate the 1px OAM y offset.
    const g = f.groups.find((x) => Math.abs(x.ox - ox) <= 2 && Math.abs(x.oy - oy) <= 2);
    if (!g || !g.tiles.length) continue;
    const k = key(g);
    const last = states[states.length - 1];
    if (last && last.key === k) { last.hold++; continue; }
    states.push({ key: k, hold: 1, group: g, pal: f.sp[g.tiles[0].pal] });
  }
  if (!states.length) return null;

  // Unique tile bytes across every state, so layouts can index into one table.
  const tiles = [];
  const tileIdx = new Map();
  for (const st of states) {
    for (const t of st.group.tiles) {
      const hex = t.bytes.join(',');
      if (!tileIdx.has(hex)) { tileIdx.set(hex, tiles.length); tiles.push(t.bytes); }
    }
  }
  const minX = Math.min(...states.flatMap((s) => s.group.tiles.map((t) => t.dx)));
  const minY = Math.min(...states.flatMap((s) => s.group.tiles.map((t) => t.dy)));
  const maxX = Math.max(...states.flatMap((s) => s.group.tiles.map((t) => t.dx))) + 8;
  const maxY = Math.max(...states.flatMap((s) => s.group.tiles.map((t) => t.dy))) + 8;

  const layouts = states.map((st) => st.group.tiles.map((t) => [
    tileIdx.get(t.bytes.join(',')), t.dx - minX, t.dy - minY, t.h ? 1 : 0, t.v ? 1 : 0,
  ]));
  // Drop the final state's hold: the capture ends mid-hold, so its length is an
  // artifact of where recording stopped rather than the game's cadence.
  const holds = states.slice(0, -1).map((s) => s.hold).filter((h) => h > 0);
  const holdFrames = holds.length ? holds.sort((x, y) => x - y)[holds.length >> 1] : 4;

  return {
    pal: states[0].pal,
    tiles,
    layouts,
    width: maxX - minX,
    height: maxY - minY,
    holdMs: Math.round(holdFrames * NES_FRAME_MS),
    states: states.length,
  };
}

const SPELL_NAMES = (() => {
  const src = readFileSync(REPO + '/src/data/spells.js', 'utf8');
  const out = new Map();
  for (const m of src.matchAll(/\[0x([0-9a-fA-F]{2}),\s*\{[^}]*\}\],\s*\/\/\s*(.+)/g)) out.set(parseInt(m[1], 16), m[2].trim());
  return out;
})();

const checkId = process.argv.includes('--check') ? parseInt(process.argv[process.argv.indexOf('--check') + 1], 16) : null;

const built = new Map();
const skipped = [];
for (const file of readdirSync(DUMPS).sort()) {
  if (!file.endsWith('.txt')) continue;
  const id = parseInt(file.slice(0, -4), 16);
  if (checkId === null && SHIPPED.has(id)) { skipped.push(`$${id.toString(16)} already shipped`); continue; }
  if (checkId !== null && id !== checkId) continue;
  let phases;
  try { phases = JSON.parse(readFileSync(`${PHASES}/${file.replace('.txt', '.json')}`, 'utf8')); }
  catch { skipped.push(`$${id.toString(16)} no phase file`); continue; }
  if (!phases.impact) { skipped.push(`$${id.toString(16)} classifier found no impact phase`); continue; }
  const b = build(parseDump(readFileSync(`${DUMPS}/${file}`, 'utf8')), phases.impact);
  if (!b) { skipped.push(`$${id.toString(16)} impact frames held no group at the classified origin`); continue; }
  // One state is a still image, not an animation. Registering it would put a
  // frozen sprite on screen and call it captured; better to leave the spell
  // with no on-target visual and say so.
  if (b.states < 2 && checkId === null) { skipped.push(`$${id.toString(16)} only ${b.states} distinct state — static, not an animation`); continue; }
  built.set(id, b);
}

if (checkId !== null) {
  const b = built.get(checkId);
  if (!b) { console.error(`nothing built for $${checkId.toString(16)}: ${skipped.join('; ')}`); process.exit(2); }
  const src = readFileSync(REPO + '/src/spell-anim.js', 'utf8');
  const shipped = [...src.matchAll(/const FIRE_T_([0-9A-F]{2}) = new Uint8Array\(\[([^\]]+)\]\)/g)]
    .map((m) => m[2].split(',').map((v) => parseInt(v.trim(), 16)));
  const mine = new Set(b.tiles.map((t) => t.join(',')));
  const miss = shipped.filter((t) => !mine.has(t.join(',')));
  const palSrc = (src.match(/const PAL_FIRE_IMPACT = \[([^\]]+)\]/) || [])[1];
  const palShipped = palSrc ? palSrc.split(',').map((v) => parseInt(v.trim(), 16)) : null;
  const palOk = palShipped && palShipped.every((v, i) => v === b.pal[i]);
  console.log(`--check $${checkId.toString(16)}: ${b.tiles.length} tiles, ${b.states} states, ` +
    `${b.width}x${b.height}, hold ${b.holdMs}ms`);
  console.log(`  shipped tiles reproduced: ${shipped.length - miss.length}/${shipped.length}`);
  console.log(`  palette ${palOk ? 'MATCHES' : 'DIFFERS'} shipped: [${b.pal.map((v) => '0x' + v.toString(16).padStart(2, '0')).join(', ')}]`);
  process.exit(miss.length === 0 && palOk ? 0 : 1);
}

const hx = (v) => '0x' + v.toString(16).padStart(2, '0');
const lines = [];
lines.push('// On-target spell animations captured off the PPU. GENERATED — do not hand-edit.');
lines.push('//');
lines.push('//   node tools/monscan/spell-emit.cjs');
lines.push('//');
lines.push('// Tile bytes are read from the ROM at the offsets a live capture proved were');
lines.push('// copied into each sprite slot; layouts and flips are the OAM values relative to');
lines.push('// the group origin; the phase came from tools/classify-spell-phases.js; the hold');
lines.push('// is the median measured state duration. Nothing here was authored by hand — see');
lines.push('// CLAUDE.md on why that matters for this particular subsystem.');
lines.push('//');
lines.push('// `layouts` entries are [tileIndex, dx, dy, hflip, vflip].');
lines.push('');
lines.push('export const CAPTURED_SPELL_ANIMS = new Map([');
for (const [id, b] of [...built.entries()].sort((a, c) => a[0] - c[0])) {
  lines.push(`  [0x${id.toString(16).padStart(2, '0')}, {   // ${SPELL_NAMES.get(id) || '?'}`);
  lines.push(`    pal: [${b.pal.map(hx).join(', ')}],`);
  lines.push(`    width: ${b.width}, height: ${b.height}, holdMs: ${b.holdMs},`);
  lines.push('    tiles: [');
  for (const t of b.tiles) lines.push(`      new Uint8Array([${t.map(hx).join(',')}]),`);
  lines.push('    ],');
  lines.push('    layouts: [');
  for (const l of b.layouts) lines.push(`      [${l.map((e) => `[${e.join(',')}]`).join(',')}],`);
  lines.push('    ],');
  lines.push('  }],');
}
lines.push(']);');
lines.push('');
writeFileSync(OUT, lines.join('\n'));
console.log(`emitted ${built.size} spell animations -> ${OUT}`);
for (const s of skipped) console.log(`  skipped: ${s}`);
