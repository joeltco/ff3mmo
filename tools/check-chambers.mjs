#!/usr/bin/env node
// check-chambers.mjs — the chamber catalogue must be real, not a table.
//
// `data/chambers.js` declares what a room can BE. A catalogue is the easiest
// thing in this codebase to fake: an entry with a typo'd `feature`, a `minDepth`
// no floor reaches, or a weight so low it never rolls all LOOK identical to a
// working one from the outside — the entry is there, the tools print it, and the
// chamber never appears in anyone's game.
//
// So every assertion here is about what got GENERATED, not what was declared.
//
//   node tools/check-chambers.mjs [seeds]

import fs from 'node:fs';

const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname));
const { generateFloor } = await import('../src/dungeon-generator.js');
const { DUNGEONS, layoutForFloor } = await import('../src/data/dungeons.js');
const { CHAMBERS, rollableFor, chamberById } = await import('../src/data/chambers.js');

const SEEDS = parseInt(process.argv[2] || '300', 10);
const BASE = 1754900000000;
const fails = [];

// ── Walk every dungeon's every walkable floor, recording what rolled ────────
const seen = new Map();            // id -> total count
const perFloor = [];               // { dungeon, floor, depth, counts, whats }
const dungeonsWith = new Map();    // id -> Set(dungeon id)

for (const dg of DUNGEONS) {
  for (let f = 0; f < dg.floors; f++) {
    if (layoutForFloor(dg, f) === null) continue;
    const counts = new Map(); const whats = new Map(); let floorsWithAny = 0;
    for (let k = 0; k < SEEDS; k++) {
      const r = generateFloor(rom, f, BASE + k * 7919, dg);
      const chs = r.chambers || [];
      if (chs.length) floorsWithAny++;
      const perSeed = new Map();
      for (const c of chs) {
        counts.set(c.id, (counts.get(c.id) || 0) + 1);
        seen.set(c.id, (seen.get(c.id) || 0) + 1);
        if (!dungeonsWith.has(c.id)) dungeonsWith.set(c.id, new Set());
        dungeonsWith.get(c.id).add(dg.id);
        whats.set(c.id, c.what);
        perSeed.set(c.id, (perSeed.get(c.id) || 0) + 1);

        const entry = chamberById(c.id);
        if (!entry) { fails.push(`${dg.id} f${f}: rolled unknown chamber id '${c.id}'`); continue; }
        // ⛔ CONSTRAINTS ARE CHECKED AGAINST WHAT ROLLED, not against the table.
        if (f < (entry.minDepth ?? 0)) fails.push(`${dg.id} f${f}: '${c.id}' rolled below its minDepth ${entry.minDepth}`);
        if (entry.maxDepth != null && f > entry.maxDepth) fails.push(`${dg.id} f${f}: '${c.id}' rolled above its maxDepth ${entry.maxDepth}`);
      }
      for (const [id, n] of perSeed) {
        const entry = chamberById(id);
        if (entry && n > (entry.maxPerFloor ?? 1)) {
          fails.push(`${dg.id} f${f} seed ${BASE + k * 7919}: ${n}x '${id}' on one floor (maxPerFloor ${entry.maxPerFloor ?? 1})`);
        }
      }
    }
    perFloor.push({ dg: dg.id, f, counts, whats, floorsWithAny });
  }
}

console.log(`chamber catalogue — ${CHAMBERS.length} entries, ${SEEDS} seeds per floor\n`);
for (const row of perFloor) {
  const list = [...row.counts].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ${n}`).join('  ');
  console.log(`${(row.dg + ' f' + row.f).padEnd(12)} ${list || '(no rolled chambers — layout does not use a slot)'}`);
}

// ── 1. Every feature id must have an implementation ────────────────────────
// A chamber whose feature throws or silently does nothing is the expensive
// failure: it rolls, it records, it prints, and the room is unchanged.
const FEATURE_EVIDENCE = {
  bones:  /bones x[1-9]/,
  vault:  /chests x[1-9]/,
  traps:  /traps/,
  null:   /plain/,
};
for (const c of CHAMBERS) {
  if (c.weight === 0) continue;                       // fixed chambers are placed by the layout
  const key = c.feature === null || c.feature === undefined ? 'null' : c.feature;
  if (!(key in FEATURE_EVIDENCE)) {
    fails.push(`chamber '${c.id}' declares feature '${key}', which this gate has no evidence pattern for — add one deliberately`);
    continue;
  }
  const anyWhat = perFloor.map((r) => r.whats.get(c.id)).filter(Boolean);
  if (anyWhat.length && !anyWhat.some((w) => FEATURE_EVIDENCE[key].test(w))) {
    fails.push(`chamber '${c.id}' (feature '${key}') rolled ${seen.get(c.id)} times but NEVER did anything — every result was "${anyWhat[0]}"`);
  }
}

// ── 1b. WATER ONLY WHERE THE DUNGEON IS SUPPOSED TO HAVE IT ───────────────
//
// ⛔ Joel, 2026-08-27: "ALTAR SHOULD ONLY HAVE A POND ON F3". v1.10.99 granted
// BOTH caves the `water` capability and made `spring` a rollable mid chamber,
// which put ponds on Altar Cave's floors 1 and 2 on 15-17% of seeds. Nobody
// asked for that — I granted the capability because the TILESET could draw it,
// and "the tileset can draw it" is not a reason to put a pond in a cave.
//
// Pinned per dungeon and exact in both directions: a floor outside the set must
// have NO water, and a floor inside it must actually produce some, so the rule
// cannot be satisfied by deleting ponds everywhere.
// ⭐ BOTH CAVES: FLOOR 3, AND NOWHERE ELSE. Joel, 2026-08-27, twice: "ALTAR
// SHOULD ONLY HAVE A POND ON F3" and "ponds need to be on f3."
//
// It is the same pond in both — the hand-carved pool in the `spine` branch,
// which is floor 3 of each cave now that the Cave of Seals has Altar Cave's
// five-floor shape. Before that clone the Seals had no walkable floor 3 at all,
// so it had nowhere to put one; that was the shape being wrong, not the rule.
const WATER_FLOORS = new Map([
  ['altar', new Set([3])],
  ['seals', new Set([3])],
]);
const WATER = 0x04, WATER_EDGE_N = 0x23;
for (const dg of DUNGEONS) {
  const allowed = WATER_FLOORS.get(dg.id);
  if (!allowed) { fails.push(`dungeon '${dg.id}' has no pinned water-floor set — add one deliberately`); continue; }
  for (let f = 0; f < dg.floors; f++) {
    let wet = 0;
    for (let k = 0; k < SEEDS; k++) {
      const tm = generateFloor(rom, f, BASE + k * 7919, dg).tilemap;
      for (let i = 0; i < 1024; i++) if (tm[i] === WATER || tm[i] === WATER_EDGE_N) { wet++; break; }
    }
    if (wet && !allowed.has(f)) fails.push(`${dg.id} f${f}: water on ${wet}/${SEEDS} seeds — this floor is not supposed to have any`);
    if (!wet && allowed.has(f)) fails.push(`${dg.id} f${f}: pinned as a water floor but produced NONE in ${SEEDS} seeds`);
    if (wet) console.log(`  water: ${dg.id} f${f} ${wet}/${SEEDS} seeds`);
  }
}

// ── 2. Every rollable chamber must actually appear ─────────────────────────
for (const slot of new Set(CHAMBERS.map((c) => c.slot))) {
  for (const c of rollableFor(slot)) {
    if (!seen.get(c.id)) fails.push(`chamber '${c.id}' (slot ${slot}, weight ${c.weight}) NEVER rolled across every dungeon and floor — it is a table entry, not a chamber`);
  }
}

// ── 3. Both dungeons must draw from the catalogue ──────────────────────────
// The whole point is that a chamber is not owned by one dungeon or one floor.
const caveIds = new Set(DUNGEONS.map((d) => d.id));
for (const dgId of caveIds) {
  const got = [...dungeonsWith.entries()].filter(([, set]) => set.has(dgId)).map(([id]) => id);
  if (got.length < 3) fails.push(`dungeon '${dgId}' only ever rolls ${got.length} chamber type(s) (${got.join(', ')}) — it is not really using the catalogue`);
  console.log(`\n${dgId}: rolls ${got.length} chamber types — ${got.sort().join(', ')}`);
}

// ── 4. Weights must be honoured, not just declared ─────────────────────────
// A weight nothing observes is a comment. Checked per dungeon on the deepest
// floor that uses the mid slot, with a wide tolerance — this is a sanity band on
// the sampler, not a chi-squared test.
for (const dg of DUNGEONS) {
  const row = perFloor.filter((r) => r.dg === dg.id && r.counts.size).pop();
  if (!row) continue;
  const total = [...row.counts.values()].reduce((a, b) => a + b, 0);
  const mult = (dg.layout && dg.layout.chambers) || {};
  const pool = rollableFor('mid').filter((c) => row.f >= (c.minDepth ?? 0));
  if (!pool.length || !row.counts.has('junction')) continue;
  const wsum = pool.reduce((a, c) => a + c.weight * (mult[c.id] ?? 1), 0);
  for (const c of pool) {
    const expect = (c.weight * (mult[c.id] ?? 1)) / wsum;
    const got = (row.counts.get(c.id) || 0) / total;
    if (Math.abs(got - expect) > 0.12) {
      fails.push(`${dg.id} f${row.f}: '${c.id}' rolled ${(got * 100).toFixed(0)}% of the time, weights say ${(expect * 100).toFixed(0)}% — the sampler is not honouring the catalogue`);
    }
  }
}

if (fails.length) {
  console.log(`\nFAIL (${fails.length}):`);
  for (const f of fails.slice(0, 20)) console.log('  ' + f);
  process.exit(1);
}
console.log('\nthe catalogue is real: every chamber rolls, every feature does something, both caves use it');
