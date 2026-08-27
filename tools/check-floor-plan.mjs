#!/usr/bin/env node
// check-floor-plan.mjs — a floor's PLAN must describe the floor that got built.
//
// `dungeon/plan.js` records chambers and links as they are carved. A record that
// drifts from the tilemap is worse than no record: it reads as authoritative.
// So this checks the plan against the map it came from.
//
// ⛔ It does NOT check that the recorded coordinate is itself walkable. For a
// jittered room the origin column can be jittered away — `carveChamber` writes
// `x + dx*dir` for `dx` from `jl`, and `jl` may be 1. The honest assertion is
// that the chamber's declared FOOTPRINT contains walkable floor, which catches a
// chamber recorded at the wrong place or never carved at all.
//
//   node tools/check-floor-plan.mjs [seeds]

import fs from 'node:fs';

const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname));
const { generateFloor } = await import('../src/dungeon-generator.js');
const { PASS, reachableFrom } = await import('./dungeon-sweep.mjs');
const { DUNGEONS, layoutForFloor } = await import('../src/data/dungeons.js');

const SEEDS = parseInt(process.argv[2] || '150', 10);
const BASE = 1754900000000;
const fails = [];

// Which LAYOUTS record EVERY chamber. Pinned so a coverage change is deliberate
// and shows up here rather than silently turning a partial plan into a claim.
//
// ⛔ KEYED BY LAYOUT, AND WALKED PER DUNGEON. This was `new Map([[0,false],
// [1,true],...])` over floor indices, run against the default dungeon only — so
// the Cave of Seals' floors were checked by nothing, and a floor's completeness
// was pinned to WHERE it sits rather than WHAT it is. `boulder-chamber` is floor
// 1 in one cave and could be floor 2 in the next.
const COMPLETE = new Map([
  ['snake',           false],   // a traced ceiling boundary, not a chamber list
  ['trap-chamber',    true],
  ['boulder-chamber', true],
  ['rock-switch',     true],
  ['spine',           true],
  [null,              false],   // the boss chamber — authored, no layout
]);

function footprint(c) {
  if (c.kind === 'room') {
    const dir = c.dir ?? 1, w = (c.w ?? 5) - 1, h = c.h ?? 7;
    const x1 = c.x, x2 = c.x + w * dir;
    return { x0: Math.min(x1, x2), x1: Math.max(x1, x2), y0: c.y + 2 - (h - 1), y1: c.y + 2 };
  }
  if (c.kind === 'wide') {
    const hw = c.halfW ?? 3;
    return { x0: c.x - hw, x1: c.x + hw, y0: c.y + c.dyMin, y1: c.y + c.dyMax };
  }
  if (c.kind === 'box') {
    return { x0: c.x, x1: c.x + c.w, y0: c.y + (c.dyMin ?? -4), y1: c.y + (c.dyMax ?? 0) };
  }
  if (c.kind === 'organic') {
    return { x0: c.left, x1: c.right, y0: c.top, y1: c.bot };
  }
  return null;   // inline note — nothing to check
}

let checkedChambers = 0, checkedLinks = 0;
const seenLayouts = new Set();
for (const dg of DUNGEONS) {
 for (let f = 0; f < dg.floors; f++) {
  const lay = layoutForFloor(dg, f);
  if (!COMPLETE.has(lay)) { fails.push(`${dg.id} floor ${f}: layout '${lay}' has no completeness expectation — add one on purpose`); continue; }
  const shouldBeComplete = COMPLETE.get(lay);
  seenLayouts.add(lay);
  for (let k = 0; k < SEEDS; k++) {
    const seed = BASE + k * 7919;
    const r = generateFloor(rom, f, seed, dg);
    const plan = r.plan;
    if (!plan) { fails.push(`${dg.id} floor ${f} seed ${seed}: no plan on the returned mapData`); continue; }

    if (plan.complete !== shouldBeComplete) {
      fails.push(`${dg.id} floor ${f} (${lay}): plan.complete is ${plan.complete}, expected ${shouldBeComplete} — coverage changed, update this check on purpose`);
      break;
    }
    // A complete plan must not be carrying "some of this is still inline" notes.
    if (plan.complete && plan.chambers.some(c => c.kind === 'inline')) {
      fails.push(`${dg.id} floor ${f} seed ${seed}: plan claims complete but records an inline note`);
    }
    for (const c of plan.chambers) {
      const fp = footprint(c);
      if (!fp) continue;
      checkedChambers++;
      let walkable = 0;
      for (let y = Math.max(0, fp.y0); y <= Math.min(31, fp.y1); y++)
        for (let x = Math.max(0, fp.x0); x <= Math.min(31, fp.x1); x++)
          if (PASS.has(r.tilemap[y * 32 + x])) walkable++;
      if (walkable === 0) fails.push(`${dg.id} floor ${f} seed ${seed}: chamber '${c.role}' (${c.kind}) at ${c.x},${c.y} has NO walkable tile in its footprint — the plan describes a room that was not carved`);
    }
    for (const l of plan.links) {
      checkedLinks++;
      const xs = [l.x0, l.x, l.endX].filter(v => v != null);
      const ys = [l.y, l.y0, l.endY, l.yFrom, l.yTo].filter(v => v != null);
      if (xs.some(v => v < 0 || v > 31) || ys.some(v => v < 0 || v > 31))
        fails.push(`${dg.id} floor ${f} seed ${seed}: link '${l.kind}' has an off-map endpoint (${xs.join(',')} / ${ys.join(',')})`);
    }
  }
 }
}
// ⛔ EVERY DECLARED LAYOUT MUST ACTUALLY GET GENERATED. A layout named in
// `LAYOUTS` that no dungeon row uses is dead code this gate would silently skip.
for (const lay of COMPLETE.keys()) {
  if (lay !== null && !seenLayouts.has(lay)) fails.push(`layout '${lay}' is expected here but no dungeon row uses it — dead layout, or a row lost it`);
}
// ── Floor 0's ceiling must be ONE perimeter ───────────────────────────────
// Floor 0's shape is a single traced boundary — the "snake" — and everything
// about how it looks depends on that perimeter staying whole. It is also the
// easiest thing in the generator to break silently: nothing about a split snake
// makes a floor unplayable, so no correctness gate sees it.
//
// ⛔ COUNT $44 FALSE_CEILING AS A CONNECTOR. It is the disguised secret tile and
// renders identically; a $00-only flood reports the snake as broken when it is
// not, and that phantom has cost a long session before.
//
// It caught a real one: `roughenOverhang` (v1.10.34) promotes ceiling to rock,
// and its "three ceiling rows above" guard was supposed to keep it out of floor
// 0's single-tile lip. Floor 0 has spots that satisfy the guard, and it shipped
// with the perimeter split on 197 of 200 seeds.
{
  const CONNECT = new Set([0x00, 0x44]);
  let intact = 0;
  for (let k = 0; k < SEEDS; k++) {
    const tm = generateFloor(rom, 0, BASE + k * 7919).tilemap;
    const seen = new Uint8Array(1024); let comps = 0;
    for (let i = 0; i < 1024; i++) {
      if (seen[i] || !CONNECT.has(tm[i])) continue;
      comps++; const q = [i]; seen[i] = 1;
      while (q.length) {
        const j = q.pop(); const x = j % 32, y = (j - x) / 32;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx > 31 || ny < 0 || ny > 31) continue;
          const kk = ny * 32 + nx;
          if (!seen[kk] && CONNECT.has(tm[kk])) { seen[kk] = 1; q.push(kk); }
        }
      }
    }
    if (comps === 1) intact++;
    else if (intact + (SEEDS - k) < SEEDS) fails.push(`floor 0 seed ${BASE + k * 7919}: ceiling is ${comps} separate perimeters, not one snake`);
  }
  console.log(`floor 0 ceiling snake: ${intact}/${SEEDS} seeds are ONE perimeter`);
}

// ── A `loop` topology must be a genuine CIRCUIT ───────────────────────────
// "There is an extra link" is not "you can go around". If cutting the link
// strands anything, it was the only path to that area and the floor is still a
// tree — the topology name would be a lie. Cut it and re-flood.
let loopSeeds = 0, circuits = 0;
for (let k = 0; k < SEEDS; k++) {
  const r = generateFloor(rom, 3, BASE + k * 7919);
  if (r.plan?.topology !== 'loop') continue;
  loopSeeds++;
  const v = r.plan.links.find(l => l.kind === 'v');
  if (!v) { fails.push(`floor 3 seed ${BASE + k * 7919}: topology 'loop' but no closing link recorded`); continue; }
  const before = reachableFrom(r.tilemap, r.entranceX, r.entranceY);
  const tm = r.tilemap.slice();
  for (let step = 1; step <= v.steps; step++) {
    const y = v.y0 + v.dir * step;
    if (y >= 0 && y < 32) tm[y * 32 + v.x] = 0x00;
  }
  const after = reachableFrom(tm, r.entranceX, r.entranceY);
  // ⛔ A SECRET TUNNEL IS A DEAD END BY DESIGN, so it does not count against the
  // circuit. One dug off a tile that is only reachable THROUGH the loop will of
  // course be stranded when the loop is cut — that says nothing about whether
  // the floor's rooms form a ring, which is the claim being tested.
  const secretTiles = new Set();
  for (const l of r.plan.links.filter(x => x.kind === 'secret')) {
    for (let d = 0; d <= l.len; d++) secretTiles.add(l.y * 32 + (l.x + l.dir * d));
  }
  let lost = 0;
  for (let i = 0; i < 1024; i++) {
    if (secretTiles.has(i)) continue;
    if (before[i] && !after[i] && PASS.has(tm[i])) lost++;
  }
  if (lost === 0) circuits++;
  else fails.push(`floor 3 seed ${BASE + k * 7919}: cutting the 'loop' link strands ${lost} tiles — it is the only path, not a circuit`);
}
console.log(`loop topology: ${circuits}/${loopSeeds} seeds are a genuine circuit (cutting the link strands nothing)`);

console.log(`checked ${checkedChambers} chamber records and ${checkedLinks} link records across ${SEEDS} seeds/floor`);
console.log(`complete plans: ${[...COMPLETE].filter(([, v]) => v).map(([f]) => f).join(', ')}   partial: ${[...COMPLETE].filter(([, v]) => !v).map(([f]) => f).join(', ')}`);

if (fails.length) {
  console.log(`\nFAIL (${fails.length}):`);
  for (const f of fails.slice(0, 20)) console.log('  ' + f);
  process.exit(1);
}
console.log('\nevery floor plan matches the floor it built');
