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
const { PASS } = await import('./dungeon-sweep.mjs');

const SEEDS = parseInt(process.argv[2] || '150', 10);
const BASE = 1754900000000;
const fails = [];

// Which floors record EVERY chamber. Pinned so a coverage change is deliberate
// and shows up here rather than silently turning a partial plan into a claim.
const COMPLETE = new Map([[0, false], [1, true], [2, true], [3, true], [4, false]]);

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
for (const [f, shouldBeComplete] of COMPLETE) {
  for (let k = 0; k < SEEDS; k++) {
    const seed = BASE + k * 7919;
    const r = generateFloor(rom, f, seed);
    const plan = r.plan;
    if (!plan) { fails.push(`floor ${f} seed ${seed}: no plan on the returned mapData`); continue; }

    if (plan.complete !== shouldBeComplete) {
      fails.push(`floor ${f}: plan.complete is ${plan.complete}, expected ${shouldBeComplete} — coverage changed, update this check on purpose`);
      break;
    }
    // A complete plan must not be carrying "some of this is still inline" notes.
    if (plan.complete && plan.chambers.some(c => c.kind === 'inline')) {
      fails.push(`floor ${f} seed ${seed}: plan claims complete but records an inline note`);
    }
    for (const c of plan.chambers) {
      const fp = footprint(c);
      if (!fp) continue;
      checkedChambers++;
      let walkable = 0;
      for (let y = Math.max(0, fp.y0); y <= Math.min(31, fp.y1); y++)
        for (let x = Math.max(0, fp.x0); x <= Math.min(31, fp.x1); x++)
          if (PASS.has(r.tilemap[y * 32 + x])) walkable++;
      if (walkable === 0) fails.push(`floor ${f} seed ${seed}: chamber '${c.role}' (${c.kind}) at ${c.x},${c.y} has NO walkable tile in its footprint — the plan describes a room that was not carved`);
    }
    for (const l of plan.links) {
      checkedLinks++;
      const xs = [l.x0, l.x, l.endX].filter(v => v != null);
      const ys = [l.y, l.y0, l.endY, l.yFrom, l.yTo].filter(v => v != null);
      if (xs.some(v => v < 0 || v > 31) || ys.some(v => v < 0 || v > 31))
        fails.push(`floor ${f} seed ${seed}: link '${l.kind}' has an off-map endpoint (${xs.join(',')} / ${ys.join(',')})`);
    }
  }
}
console.log(`checked ${checkedChambers} chamber records and ${checkedLinks} link records across ${SEEDS} seeds/floor`);
console.log(`complete plans: ${[...COMPLETE].filter(([, v]) => v).map(([f]) => f).join(', ')}   partial: ${[...COMPLETE].filter(([, v]) => !v).map(([f]) => f).join(', ')}`);

if (fails.length) {
  console.log(`\nFAIL (${fails.length}):`);
  for (const f of fails.slice(0, 20)) console.log('  ' + f);
  process.exit(1);
}
console.log('\nevery floor plan matches the floor it built');
