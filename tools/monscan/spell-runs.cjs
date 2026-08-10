// Turn the raw sweep into per-spell CHR runs, and check them against every
// animation the codebase already has verified bytes for.
//
//   node spell-runs.cjs
//
// A cast loads more than one thing: the caster's per-job cast animation (BM
// halo / WM stars) and the on-target effect are separate 24-tile copies into
// $49-$60 at different times. Taking the lowest owned offset therefore labels
// some spells with their cast block instead of their impact. Grouping the owned
// offsets into CONTIGUOUS runs separates them without guessing which is which —
// the frame windows say which came first.
//
// Every known constant in the tree is used as a check. Fire / Blizzard / Sleep
// / Cure / Poisona were captured by hand in earlier sessions and gated by
// tools/parity-check-spell.js, so if this sweep disagrees with any of them the
// sweep is wrong, not the shipped data.

const { readFileSync } = require('fs');

const REPO = '/home/joeltco/projects/ff3mmo';
const rom = readFileSync(REPO + '/FF3-English.nes');
const sweep = JSON.parse(readFileSync(__dirname + '/spell-sweep.json', 'utf8'));

// ── where every verified constant lives in the ROM ─────────────────
const anchors = new Map();                       // romOffset -> constant name
for (const f of ['src/spell-anim.js', 'src/cast-anim.js', 'src/projectile-anim.js', 'src/cure-anim.js']) {
  let src;
  try { src = readFileSync(REPO + '/' + f, 'utf8'); } catch { continue; }
  for (const m of src.matchAll(/const ([A-Z0-9_]+) = new Uint8Array\(\[([^\]]+)\]\)/g)) {
    const b = m[2].split(',').map((s) => parseInt(s.trim(), 16));
    if (b.length !== 16) continue;
    const off = rom.indexOf(Buffer.from(b), sweep.region[0]);
    if (off >= 0 && off < sweep.region[1]) anchors.set(off, m[1]);
  }
}

const SPELL_NAMES = (() => {
  const src = readFileSync(REPO + '/src/data/spells.js', 'utf8');
  const out = new Map();
  for (const m of src.matchAll(/\[0x([0-9a-fA-F]{2}),\s*\{[^}]*\}\],\s*\/\/\s*(.+)/g)) {
    out.set(parseInt(m[1], 16), m[2].trim());
  }
  return out;
})();

/** Owned offsets → contiguous runs of 16-byte-adjacent blocks. */
function runs(blocks) {
  const out = [];
  for (const b of blocks.slice().sort((x, y) => x.off - y.off)) {
    const last = out[out.length - 1];
    if (last && b.off === last.end + 16) {
      last.end = b.off; last.n++;
      last.slots.push(...b.slots);
      last.first = Math.min(last.first, b.first);
      last.last = Math.max(last.last, b.last);
    } else {
      out.push({ start: b.off, end: b.off, n: 1, slots: [...b.slots], first: b.first, last: b.last });
    }
  }
  for (const r of out) {
    r.slots = [...new Set(r.slots)].sort((a, b) => a - b);
    r.named = [];
    for (let o = r.start; o <= r.end; o += 16) if (anchors.has(o)) r.named.push(anchors.get(o));
  }
  return out;
}

const hx = (v) => '$' + v.toString(16);
let withRuns = 0, empty = [];
const table = [];

for (const r of sweep.results) {
  const label = `$${r.id.toString(16).padStart(2, '0')} ${(SPELL_NAMES.get(r.id) || '?').padEnd(12)}`;
  if (!r.blocks || !r.blocks.length) { empty.push(r); continue; }
  withRuns++;
  const rs = runs(r.blocks).sort((a, b) => a.first - b.first);
  console.log(`${label} ${r.school} L${8 - r.row}c${r.col}  ${r.frames.length} drawn frames`);
  for (const run of rs) {
    const tag = run.named.length ? `  <- ${[...new Set(run.named.map((n) => n.replace(/_T_.*|_.*$/, '')))].join(',')}` : '';
    console.log(`    ${hx(run.start)}-${hx(run.end)}  ${String(run.n).padStart(2)} tiles  slots ${hx(run.slots[0])}-${hx(run.slots[run.slots.length - 1])}  frames ${run.first}-${run.last}${tag}`);
  }
  table.push({ id: r.id, runs: rs });
}

console.log(`\n${withRuns} spells with CHR runs, ${empty.length} empty`);
if (empty.length) console.log('  empty: ' + empty.map((r) => `$${r.id.toString(16)} (${r.school} L${8 - r.row}c${r.col})`).join(', '));

// ── the gate: agreement with already-verified captures ─────────────
const EXPECT = {
  0x31: 'FIRE', 0x32: 'BLIZZARD', 0x33: 'SLEEP', 0x34: 'CURE', 0x35: 'POISONA',
};
console.log('\nagreement with previously-verified captures:');
let pass = 0, checked = 0;
for (const [idStr, name] of Object.entries(EXPECT)) {
  const id = Number(idStr);
  const row = table.find((t) => t.id === id);
  if (!row) { console.log(`  $${id.toString(16)} ${name}: NOT SWEPT`); continue; }
  checked++;
  const hit = row.runs.find((run) => run.named.some((n) => n.startsWith(name)));
  if (hit) { pass++; console.log(`  $${id.toString(16)} ${name}: MATCH — run ${hx(hit.start)}-${hx(hit.end)} carries ${hit.named.filter((n) => n.startsWith(name)).length} of its shipped tiles`); }
  else console.log(`  $${id.toString(16)} ${name}: NO MATCH — runs ${row.runs.map((r) => hx(r.start)).join(',')}`);
}
console.log(`\n${pass}/${checked} verified spells reproduced by the sweep`);
