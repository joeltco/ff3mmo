// Assign spell animation phases by ROM-BLOCK PROVENANCE instead of geometry.
//
//   node spell-phases-rom.cjs            # validate against the shipped 5
//   node spell-phases-rom.cjs --emit DIR # write phase JSONs for spell-emit.cjs
//
// tools/classify-spell-phases.js picks the impact by where it sits on screen:
// a static, multi-tile, enemy-side group with under 8px of origin drift. That
// describes Fire and misses moving, expanding, screen-wide and ally-targeted
// effects, so it classifies 11 of 48 spells and leaves 39 unregistered.
//
// The capture already carries a better signal, measured rather than inferred:
//
//   CAST        the caster's halo is the SAME ROM block for every spell of a
//               school — $55610 for all black, $55710 for all white. A block
//               that many different spells load cannot be any one spell's art.
//   IMPACT      the block only this spell loads.
//   PROJECTILE  a single travelling tile, which the sweep sees as a one-slot
//               run whose sprite x moves monotonically.
//
// "Shared across spells" is counted from the data, not asserted. Nothing here
// looks at screen position, so ally-targeted and screen-wide effects classify
// exactly as readily as Fire does.
//
// The gate: run it against the five spells that already have hand-captured,
// parity-gated tile bytes in spell-anim.js. If provenance does not reproduce
// all five, it is not good enough to register the other 39 with.

const { readFileSync, writeFileSync, mkdirSync } = require('fs');

const REPO = '/home/joeltco/projects/ff3mmo';
const rom = readFileSync(REPO + '/FF3-English.nes');
const sweep = JSON.parse(readFileSync(__dirname + '/spell-sweep.json', 'utf8'));

/** Contiguous 16-byte-adjacent blocks, grouped into runs. */
function runsOf(blocks) {
  const out = [];
  for (const b of blocks.slice().sort((x, y) => x.off - y.off)) {
    const last = out[out.length - 1];
    if (last && b.off === last.end + 16) {
      last.end = b.off; last.n++;
      last.slots.push(...b.slots);
      last.first = Math.min(last.first, b.first);
      last.last = Math.max(last.last, b.last);
      last.blocks.push(b);
    } else {
      out.push({ start: b.off, end: b.off, n: 1, slots: [...b.slots], first: b.first, last: b.last, blocks: [b] });
    }
  }
  for (const r of out) r.slots = [...new Set(r.slots)].sort((a, b) => a - b);
  return out;
}

// How many DIFFERENT spells load each run start. The cast halo shows up in
// every spell of its school; a spell's own impact shows up once.
const shareCount = new Map();
const perSpell = new Map();
for (const r of sweep.results) {
  const rs = runsOf(r.blocks || []);
  perSpell.set(r.id, rs);
  for (const run of new Map(rs.map((x) => [x.start, x])).values()) {
    shareCount.set(run.start, (shareCount.get(run.start) || 0) + 1);
  }
}
// A cast animation is loaded by an ENTIRE SCHOOL. The counts come out 24, 24,
// then 8 and below — $55610 for all 24 black spells and $55710 for all 24
// white, which are exactly the two already-verified cast blocks (BM_T_* and
// WM/FLAME_T_*). The gap is structural, not a tuned cutoff.
//
// Anything below that is real per-spell or per-FAMILY art: FF3 reuses impact
// graphics between related spells, so Sleep's $55e40 is loaded by 6 spells and
// Cure's $562c0 by 4. Treating "shared" as "cast" swallowed both and is why a
// threshold of 4 reproduced only 2 of the 5 known spells.
const SHARED_MIN = 12;

/** Sprites drawn from a run's slots, per frame, honouring each block's window. */
function runFrames(rec, run, minSprites = 1) {
  const slotWindow = new Map();            // slot -> [first,last]
  for (const b of run.blocks) for (const s of b.slots) slotWindow.set(s, [b.first, b.last]);
  const out = [];
  for (const fr of rec.frames || []) {
    const spr = fr.spr.filter((s) => {
      const w = slotWindow.get(s.tile);
      return w && fr.f >= w[0] && fr.f <= w[1];
    });
    if (spr.length >= minSprites) out.push({ f: fr.f, spr, pal: fr.pal });
  }
  return out;
}

const classify = (rec) => {
  const rs = perSpell.get(rec.id) || [];
  const cast = [], own = [];
  for (const run of rs) ((shareCount.get(run.start) || 0) >= SHARED_MIN ? cast : own).push(run);

  // A projectile is one tile that travels. Measured as: the run's drawn sprites
  // span more than 32px of x over its life and never exceed 2 tiles at once.
  const isProjectile = (run) => {
    const fr = runFrames(rec, run);
    if (!fr.length) return false;
    if (Math.max(...fr.map((f) => f.spr.length)) > 2) return false;
    const xs = fr.flatMap((f) => f.spr.map((s) => s.x));
    return xs.length > 1 && (Math.max(...xs) - Math.min(...xs)) > 32;
  };
  // NOTE: for most spells the projectile tile is inside the same 24-tile copy
  // as the impact, so it is NOT separable as its own run. Kept only for the
  // cases where it is; phase output does not depend on it.
  const projectile = own.find(isProjectile) || null;
  const impacts = own.filter((r) => r !== projectile);
  // Largest by drawn-frame count — the impact is what stays on screen; a
  // trailing scorch or leftover is briefer.
  // Count only multi-sprite frames: the projectile rides the same block range
  // and would otherwise stretch both the frame window and the origin.
  impacts.sort((a, b) => runFrames(rec, b, 3).length - runFrames(rec, a, 3).length);
  return { cast, projectile, impact: impacts[0] || null, others: impacts.slice(1) };
};

// ── the gate: reproduce the five hand-captured spells ──────────────
const anim = readFileSync(REPO + '/src/spell-anim.js', 'utf8');
const shippedTiles = (prefix) => [...anim.matchAll(new RegExp(`const ${prefix}[0-9A-Z_]* = new Uint8Array\\(\\[([^\\]]+)\\]\\)`, 'g'))]
  .map((m) => m[1].split(',').map((v) => parseInt(v.trim(), 16).toString(16).padStart(2, '0')).join(''));

const EXPECT = [
  [0x31, 'FIRE_T_', 'Fire'],
  [0x32, 'BLIZZARD_T_', 'Bzzard'],
  [0x33, 'SLEEP_T_', 'Sleep'],
  [0x34, 'CURE_T_', 'Cure'],
  [0x35, 'POISONA_T_', 'Poisona'],
];

console.log(`shared-run threshold: a run loaded by >= ${SHARED_MIN} spells is a cast animation`);
const shared = [...shareCount.entries()].filter(([, c]) => c >= SHARED_MIN).sort((a, b) => b[1] - a[1]);
for (const [off, c] of shared) console.log(`  $${off.toString(16)} loaded by ${c} spells`);

let pass = 0;
console.log('\ngate — provenance vs the hand-captured, parity-gated tile bytes:');
for (const [id, prefix, name] of EXPECT) {
  const rec = sweep.results.find((r) => r.id === id);
  const c = classify(rec);
  if (!c.impact) { console.log(`  $${id.toString(16)} ${name}: NO IMPACT RUN`); continue; }
  // Bytes at the offsets the impact run's drawn sprites actually reference.
  const slotOff = new Map();
  for (const b of c.impact.blocks) for (const s of b.slots) slotOff.set(s, b.off);
  const drawn = new Set();
  for (const fr of runFrames(rec, c.impact, 3)) for (const s of fr.spr) drawn.add(slotOff.get(s.tile));
  const mine = new Set([...drawn].filter((o) => o != null).map((o) => rom.slice(o, o + 16).toString('hex')));
  const want = shippedTiles(prefix);
  const hit = want.filter((t) => mine.has(t)).length;
  const ok = hit === want.length && want.length > 0;
  if (ok) pass++;
  console.log(`  $${id.toString(16)} ${name.padEnd(8)} ${ok ? 'MATCH' : 'MISS '} ${hit}/${want.length} shipped tiles` +
    `  impact run $${c.impact.start.toString(16)}-$${c.impact.end.toString(16)}` +
    `  cast ${c.cast.map((r) => '$' + r.start.toString(16)).join(',') || 'none'}` +
    `  projectile ${c.projectile ? '$' + c.projectile.start.toString(16) : 'none'}`);
}
console.log(`\n${pass}/${EXPECT.length} shipped spells reproduced by ROM-block provenance`);

// ── optional: write phase files spell-emit.cjs can consume ─────────
const emitIdx = process.argv.indexOf('--emit');
if (emitIdx >= 0) {
  const dir = process.argv[emitIdx + 1];
  mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const rec of sweep.results) {
    const c = classify(rec);
    if (!c.impact) continue;
    const fr = runFrames(rec, c.impact, 3);
    if (!fr.length) continue;
    // Origin = top-left of the impact's drawn sprites, the anchor spell-emit
    // matches groups against. +1 on y because OAM draws one scanline lower.
    const ox = Math.min(...fr.flatMap((f) => f.spr.map((s) => s.x)));
    const oy = Math.min(...fr.flatMap((f) => f.spr.map((s) => s.y))) + 1;
    const castFr = c.cast.flatMap((r) => runFrames(rec, r));
    writeFileSync(`${dir}/${rec.id.toString(16).padStart(2, '0')}.json`, JSON.stringify({
      totalFrames: (rec.frames || []).length,
      cast: castFr.length ? { frames: [castFr[0].f, castFr[castFr.length - 1].f], casterOrigin: [0, 0] } : null,
      projectile: c.projectile ? { detectedInOam: true, frameRange: (() => {
        const p = runFrames(rec, c.projectile); return [p[0].f, p[p.length - 1].f];
      })(), sampleTrace: [] } : { detectedInOam: false },
      impact: { frames: [fr[0].f, fr[fr.length - 1].f], origin: [ox, oy], tileCount: c.impact.n },
      scorch: [],
      source: 'rom-block-provenance',
    }));
    n++;
  }
  console.log(`wrote ${n} phase files -> ${dir}`);
}
