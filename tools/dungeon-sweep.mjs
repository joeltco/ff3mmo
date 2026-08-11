#!/usr/bin/env node
// dungeon-sweep.mjs — asserts dungeon-generation invariants across many seeds.
//
// `floor-view.mjs` RENDERS one floor so you can look at it. This one CHECKS
// hundreds and reports counts, which is the half CLAUDE.md's "validate across
// many seeds — incl. timestamp-style, since the game seeds with Date.now()"
// actually asks for. Both share `reachableFrom` below so the picture you look
// at and the numbers you trust can never disagree.
//
// Usage:
//   node tools/dungeon-sweep.mjs [seeds] [base]     # default 150, timestamp base
//
// Exit code is 1 if a HARD invariant fails (see `sweepFloors`).

import fs from 'node:fs';
import { generateFloor } from '../src/dungeon-generator.js';

/**
 * Tiles treated as walkable when flooding a generated floor.
 *
 * This is a deliberate APPROXIMATION of the game's `MapRenderer.isPassable`,
 * which needs a DOM (canvas work in its constructor) and so cannot run in a
 * plain node tool. Measured against the real predicate over 125 floors
 * (v1.7.866): it is **conservative in the safe direction** — there is no tile
 * it calls passable that the game blocks, so a reachability conclusion drawn
 * from it can never be falsely optimistic. That is the property the deploy gate
 * in `encounter-sim.js` asserts, and it is why "the exit is reachable" here is
 * trustworthy.
 *
 * It is stricter than the game on 9 ids the game does allow — 0x70 (chamber
 * door), 0x04 (water), 0x61, and 0x3a-0x3f — so `stranded` counts here are
 * upper bounds. Anything this flags as stranded is worth confirming against
 * `MapRenderer.isPassable` before calling it a bug.
 */
export const PASS = new Set([0x30, 0x09, 0x41, 0x49, 0x44, 0x73, 0x42, 0x68, 0x6a, 0x60]);
const CHEST = 0x7c, STAIRS = 0x73;

/**
 * Passable tiles reachable on foot from the entrance.
 *
 * Seeds the entrance tile AND its four neighbours. v1.7.865 — the original
 * seeded the entrance plus the four tiles BELOW it, which assumes the walkable
 * side of an entrance is downward. True for the top-entry floors, false for
 * floor 4, whose entrance sits at the bottom with the boss chamber above: the
 * flood never started, so `floor-view` painted that whole floor `!` and
 * reported its exit unreachable on every seed. A validator that cries wolf
 * trains you to ignore it.
 */
export function reachableFrom(tm, ex, ey) {
  const seen = new Uint8Array(1024); const q = [];
  const push = (x, y) => {
    if (x < 0 || x > 31 || y < 0 || y > 31) return;
    const i = y * 32 + x;
    if (!seen[i] && PASS.has(tm[i])) { seen[i] = 1; q.push(i); }
  };
  push(ex, ey); push(ex + 1, ey); push(ex - 1, ey); push(ex, ey + 1); push(ex, ey - 1);
  while (q.length) {
    const i = q.pop(); const x = i % 32, y = (i - x) / 32;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  return seen;
}

/**
 * Sweep every floor over `n` seeds. Returns `{ hard, soft, rows }`.
 *
 * HARD failures are unambiguous breakage: a floor that throws, a floor with no
 * reachable space at all, or an exit staircase the player cannot walk to.
 *
 * Everything else is counted, not failed, because the generator has documented
 * intentional exceptions that a naive checker reads as bugs:
 *   - floors 1 / 2 / 4 have no `0x73` staircase (trap holes, a rock-switch
 *     passage, and the boss chamber respectively);
 *   - floor 2 seals a rock-switch puzzle room — its tiles and one chest are
 *     unreachable until `rockSwitch.wallTiles` turn to floor;
 *   - floor 0's entrance frame is rocky-with-void-above by original design;
 *   - floor 3's alcove chests sit at fat-stretch ends, not 2x2 corners.
 */
export function sweepFloors(rom, n = 150, base = 1754900000000) {
  const rows = []; const hard = []; const soft = [];
  for (const f of [0, 1, 2, 3, 4]) {
    const t = { floor: f, seeds: 0, noStairs: 0, stranded: 0, strandedSeeds: 0, chests: 0 };
    for (let k = 0; k < n; k++) {
      const seed = base + k * 7919;
      let r;
      try { r = generateFloor(rom, f, seed); }
      catch (e) { hard.push(`floor ${f} seed ${seed} threw: ${e.message}`); continue; }
      t.seeds++;
      const tm = r.tilemap;
      const seen = reachableFrom(tm, r.entranceX, r.entranceY);
      let reach = 0;
      for (let i = 0; i < 1024; i++) if (seen[i]) reach++;
      if (reach < 20) { hard.push(`floor ${f} seed ${seed}: only ${reach} reachable tiles`); continue; }

      let stairs = -1;
      for (let i = 0; i < 1024; i++) if (tm[i] === STAIRS) { stairs = i; break; }
      if (stairs < 0) t.noStairs++;
      else if (!seen[stairs]) hard.push(`floor ${f} seed ${seed}: exit staircase unreachable`);

      let stranded = 0;
      for (let i = 0; i < 1024; i++) {
        if (!PASS.has(tm[i]) || seen[i]) continue;
        if (((i - (i % 32)) / 32) >= 22) continue;      // secret teleport room
        stranded++;
      }
      if (stranded) { t.stranded += stranded; t.strandedSeeds++; }
      for (let i = 0; i < 1024; i++) if (tm[i] === CHEST) t.chests++;
    }
    if (t.strandedSeeds) soft.push(`floor ${f}: ${t.strandedSeeds}/${t.seeds} seeds strand ${t.stranded} tiles`);
    rows.push(t);
  }
  return { hard, soft, rows };
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const romPath = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
  const rom = new Uint8Array(fs.readFileSync(romPath));
  const n = parseInt(process.argv[2] || '150', 10);
  const base = parseInt(process.argv[3] || '1754900000000', 10);
  const { hard, soft, rows } = sweepFloors(rom, n, base);
  console.log(`dungeon-sweep — ${n} timestamp-style seeds per floor (base ${base})\n`);
  console.log('floor   seeds  noStairs  strandedSeeds  strandedTiles  chests');
  for (const r of rows) {
    console.log(String(r.floor).padEnd(8) + String(r.seeds).padStart(5) + String(r.noStairs).padStart(10)
      + String(r.strandedSeeds).padStart(15) + String(r.stranded).padStart(15) + String(r.chests).padStart(8));
  }
  if (soft.length) { console.log('\nsoft (counted, not failed):'); for (const s of soft) console.log('  ' + s); }
  if (hard.length) {
    console.log('\nHARD FAILURES:');
    for (const h of hard) console.log('  ' + h);
    process.exit(1);
  }
  console.log('\nno hard invariant violations');
}
