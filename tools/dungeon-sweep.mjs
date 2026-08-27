#!/usr/bin/env node
// dungeon-sweep.mjs — asserts dungeon-generation invariants across many seeds.
//
// `floor-view.mjs` RENDERS one floor so you can look at it. This one CHECKS
// hundreds and reports counts, which is the half CLAUDE.md's "validate across
// many seeds — incl. timestamp-style, since the game seeds with Date.now()"
// actually asks for. Both share `reachableFrom` below so the picture you look
// at and the numbers you trust can never disagree.
//
// It covers EVERY generated surface the player can stand on, not just the five
// floors: `sweepSideMaps` walks the secret teleport room and the two standalone
// locked rooms (1010 / 1011), which had no gate of any kind before v1.10.15.
//
// Usage:
//   node tools/dungeon-sweep.mjs [seeds] [base]     # default 150, timestamp base
//
// Exit code is 1 if a HARD invariant fails (see `sweepFloors` / `sweepSideMaps`).

import fs from 'node:fs';
import { generateFloor, generateSecretRoomMap } from '../src/dungeon-generator.js';
import { generateLockedRoomMap } from '../src/dungeon-locked-room.js';
import { DUNGEONS, isBossFloor, layoutForFloor } from '../src/data/dungeons.js';

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
const CHEST = 0x7c;

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
 * Is every chest on this map OPENABLE?
 *
 * ⛔ A chest tile is NOT walkable — you stand beside it and face it. Flooding
 * and asking `seen[chestIndex]` therefore reports EVERY chest in the game as
 * unreachable; the first version of this check did exactly that and called
 * 300/300 locked-room chests broken. Openable = some orthogonal neighbour is
 * reachable.
 */
export function chestAudit(tm, seen) {
  let total = 0; const sealed = [];
  for (let i = 0; i < 1024; i++) {
    if (tm[i] !== CHEST) continue;
    total++;
    const x = i % 32, y = (i - x) / 32;
    const ok = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx > 31 || ny < 0 || ny > 31) return false;
      return !!seen[ny * 32 + nx];
    });
    if (!ok) sealed.push(`${x},${y}`);
  }
  return { total, sealed };
}

/**
 * Passable tiles that nothing can reach, excluding rows >= 22 — the secret
 * teleport room is an INTENTIONAL separate island.
 */
export function strandedTiles(tm, seen) {
  const out = [];
  for (let i = 0; i < 1024; i++) {
    if (!PASS.has(tm[i]) || seen[i]) continue;
    if (((i - (i % 32)) / 32) >= 22) continue;
    out.push(`${i % 32},${(i - (i % 32)) / 32}`);
  }
  return out;
}

/**
 * Apply the rock-switch result exactly as the game does — `handleRockPuzzle`
 * in `map-triggers.js` runs `_consumeTile(wt.x, wt.y, wt.newTile)` per wall
 * tile. Use `newTile`, NOT a blanket floor fill: the list mixes WALL_ROCKY
 * (0x01) with FLOOR (0x30), so blanket-filling models the puzzle as opening
 * MORE than pulling the switch actually opens.
 */
export function applyRockSwitch(tm, rockSwitch) {
  const out = tm.slice();
  for (const wt of rockSwitch?.wallTiles || []) out[wt.y * 32 + wt.x] = wt.newTile;
  return out;
}

/**
 * Audit a floor's EXITS as the game wires them, not as a tile guess.
 *
 * ⛔ The old check was `find the first 0x73 STAIRS tile, assert it is reachable`.
 * That is wrong three ways and shipped wrong in v1.10.15:
 *   - floors 1 / 2 / 4 have no $73 at all (trap holes, a rock-switch passage, a
 *     boss chamber), so they counted as "noStairs" and were never checked;
 *   - floor 3's exit is a DOOR ($70 at the top of the map), not a staircase;
 *   - the only $73 on floor 3 is the ENTRANCE, so the check asserted that the
 *     tile the flood starts from is reachable. It did real work on floor 0 only.
 *
 * `dungeonDestinations` is the engine's own answer to "where does this tile
 * take me" (`_checkDynType1` / `_checkDynType4` read exactly this map), so the
 * audit walks it. A destination tile counts as reachable if it or an orthogonal
 * neighbour is — door and passage tiles are passable in the game but are not in
 * the conservative `PASS` set, same as chests.
 *
 * Returns { onward, unreachable[], entranceWiredForward }.
 */
export function exitAudit(r, seen) {
  const out = { onward: 0, unreachable: [], entranceWiredForward: null };
  if (!r.dungeonDestinations || !r.triggerMap) return out;
  const entKey = `${r.entranceX},${r.entranceY}`;
  for (const [coord, trig] of r.triggerMap) {
    const dest = r.dungeonDestinations.get(`${trig.type}:${trig.trigId}`);
    if (!dest) continue;
    const [x, y] = coord.split(',').map(Number);
    const ok = !!seen[y * 32 + x] || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx > 31 || ny < 0 || ny > 31) return false;
      return !!seen[ny * 32 + nx];
    });
    if (!ok) out.unreachable.push(`${coord}->${dest.goBack ? 'goBack' : dest.mapId}`);
    if (!dest.goBack) out.onward++;
    // ⛔ The staircase the player ARRIVES on must never lead further in.
    // `disabledTrigger` suppresses it only until they step off (movement.js
    // clears it on the first move), so a forward-wired entrance is a one-step
    // sequence break — on floor 3 it skipped the entire floor into the boss.
    if (coord === entKey && !dest.goBack) out.entranceWiredForward = `${coord}->${dest.mapId}`;
  }
  return out;
}

/**
 * Sweep every floor over `n` seeds. Returns `{ hard, soft, rows }`.
 *
 * HARD failures are unambiguous breakage:
 *   - a floor that throws, or with no reachable space at all;
 *   - an exit staircase the player cannot walk to;
 *   - a CHEST no reachable tile is adjacent to;
 *   - a SEALED POCKET — passable floor nothing can reach. Hard since v1.10.15,
 *     when `sealTinyPockets` closed the last two sources (floor 3's branch
 *     chest landing on the dead-end tile, and floor 0's organic outline
 *     closing a 2-tile hole). It was 26 tiles across 24 seeds; it is now 0,
 *     so anything above 0 is a regression rather than a known wart.
 *
 * Floor 2 is the ONE exception and it is checked, not excused. Its rock-switch
 * puzzle room is sealed BY DESIGN — ~21 tiles and one chest per seed. Rather
 * than skipping the floor, the sweep pulls the switch (`applyRockSwitch`) and
 * asserts the room opens completely: stranded 0, every chest openable. If a
 * floor-2 tile is stranded AFTER the switch, that is a real fault and fails.
 * Before v1.10.15 this floor just printed "150/150 seeds strand 3187 tiles" as
 * a soft count with a comment claiming it was the puzzle — nothing tested it.
 *
 * Still counted rather than failed: floors 1 / 2 / 4 have no `0x73` staircase
 * (trap holes, a rock-switch passage, and the boss chamber respectively).
 */
/**
 * WHAT A BOULDER PUZZLE GATES, per dungeon+layout.
 *
 * ⛔ THE TWO CAVES FOLLOW DIFFERENT RULES AND BOTH ARE DELIBERATE.
 *
 * `gates: 'exit'` — the false wall is on the critical path; the boulder is how
 * you leave the floor. Altar Cave's `rock-switch` has always worked this way.
 * `walkaroundCap` is how often the wall may fail to be the only route: measured
 * at 69/400 (17%) on the pre-catalogue tree and pinned just above, so the
 * standing wart does not fail the build but growth does.
 *
 * `gates: 'treasure'` — Joel, 2026-08-27: *"Boulder puzzles will only be to open
 * treasure chambers. not an exit."* The rule inverts every assertion: the way
 * onward must be reachable WITHOUT touching the boulder on EVERY seed (otherwise
 * the puzzle is back on the critical path), and the sealed region must actually
 * hold treasure (otherwise solving it pays nothing). Both are exact, so neither
 * needs a sample-size guard.
 */
const PUZZLE_ROLE = new Map([
  ['altar/rock-switch',     { gates: 'exit', walkaroundCap: 0.20 }],
  ['seals/rock-switch',     { gates: 'exit', walkaroundCap: 0 }],
  ['seals/boulder-chamber', { gates: 'treasure' }],
]);

export function sweepFloors(rom, n = 150, base = 1754900000000) {
  const rows = []; const hard = []; const soft = [];
  // ⛔ EVERY DUNGEON, not the default one. This walked `[0,1,2,3,4]` through
  // `generateFloor(rom, f, seed)` with no dungeon argument, so it swept Altar
  // Cave five times and the Cave of Seals never — including the floor whose way
  // onward is sealed behind a boulder.
  for (const dg of DUNGEONS) {
  for (let f = 0; f < dg.floors; f++) {
    const label = `${dg.id} floor ${f}`;
    const t = { floor: label, seeds: 0, exits: 0, stranded: 0, strandedSeeds: 0, chests: 0, puzzleTiles: 0, exitOpenUnpuzzled: 0, sealedNoTreasure: 0 };
    for (let k = 0; k < n; k++) {
      const seed = base + k * 7919;
      let r;
      try { r = generateFloor(rom, f, seed, dg); }
      catch (e) { hard.push(`${label} seed ${seed} threw: ${e.message}`); continue; }
      t.seeds++;
      const tm = r.tilemap;
      const seen = reachableFrom(tm, r.entranceX, r.entranceY);
      let reach = 0;
      for (let i = 0; i < 1024; i++) if (seen[i]) reach++;
      if (reach < 20) { hard.push(`${label} seed ${seed}: only ${reach} reachable tiles`); continue; }

      // Exits, from the engine's own wiring. On a rock-puzzle floor the way
      // onward is behind the switch by design, so audit the OPENED map.
      const exSeen = r.rockSwitch
        ? reachableFrom(applyRockSwitch(tm, r.rockSwitch), r.entranceX, r.entranceY)
        : seen;
      const ex = exitAudit(r, exSeen);
      if (!isBossFloor(dg, f) && ex.onward === 0) hard.push(`${label} seed ${seed}: no way onward — nothing wired to map ${dg.base + f + 1}`);
      if (ex.unreachable.length) hard.push(`${label} seed ${seed}: unreachable exit ${ex.unreachable.join(' ')}`);
      if (ex.entranceWiredForward) hard.push(`${label} seed ${seed}: ENTRANCE wired as a forward exit (${ex.entranceWiredForward}) — step off and back on skips the floor`);
      t.exits += ex.onward;

      const stranded = strandedTiles(tm, seen);
      const chests = chestAudit(tm, seen);
      t.chests += chests.total;

      if (r.rockSwitch) {
        // ⛔ THE BOULDER MUST BE REACHABLE WITH THE WALL STILL SHUT. It is the
        // only thing that opens the wall, so a boulder you cannot walk up to is
        // a floor with no way onward — and NOTHING else here sees it: the
        // chamber is fully connected, every chest opens, and the sealed half
        // reads as sealed-by-design. It happened on 69 of 2000 seeds of the
        // Cave of Seals' floor 1, from a chest landing on the boulder's one
        // approach tile.
        //
        // A boulder tile is impassable, so "reachable" means an orthogonal
        // neighbour is — the same rule `chestAudit` uses, for the same reason.
        //
        // ⛔ AT LEAST ONE, NOT EVERY ONE. `rock-switch` deliberately places a
        // SECOND boulder inside the sealed room so the wall can be opened from
        // the far side on the way back; that one is unreachable until the puzzle
        // is solved, and it is supposed to be. Asserting every boulder failed 633
        // of 2000 Altar Cave seeds on the first run of this check — the gate was
        // wrong, not the floor.
        const reachableRocks = r.rockSwitch.rocks.filter((rk) =>
          [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
            const nx = rk.x + dx, ny = rk.y + dy;
            if (nx < 0 || nx > 31 || ny < 0 || ny > 31) return false;
            return !!seen[ny * 32 + nx];
          }));
        if (reachableRocks.length === 0) {
          hard.push(`${label} seed ${seed}: NO boulder is reachable (${r.rockSwitch.rocks.map((rk) => `${rk.x},${rk.y}`).join(' ')}) — the wall can never be opened and the floor has no way onward`);
        }
        // Is the way onward actually SEALED before the boulder is touched? A
        // boulder that opens a wall you could already walk around is decoration.
        // Counted, not failed: the shipped `rock-switch` layout leaves the exit
        // reachable on ~18% of seeds and that predates this check.
        if (exitAudit(r, seen).unreachable.length === 0) t.exitOpenUnpuzzled++;
        // Does the region the boulder opens actually contain treasure? A chest
        // counts as sealed when it is unreachable now and reachable after.
        {
          const openTm2 = applyRockSwitch(tm, r.rockSwitch);
          const openSeen2 = reachableFrom(openTm2, r.entranceX, r.entranceY);
          let sealedChests = 0;
          for (let i = 0; i < 1024; i++) {
            if (tm[i] !== CHEST) continue;
            const x = i % 32, y = (i - x) / 32;
            const adj = (m) => [[1,0],[-1,0],[0,1],[0,-1]].some(([dx, dy]) => {
              const nx = x + dx, ny = y + dy;
              return nx >= 0 && nx < 32 && ny >= 0 && ny < 32 && !!m[ny * 32 + nx];
            });
            if (!adj(seen) && adj(openSeen2)) sealedChests++;
          }
          if (!sealedChests) t.sealedNoTreasure++;
        }
        // Sealed-by-design puzzle room: count it, then PROVE the switch opens it.
        t.puzzleTiles += stranded.length;
        const openTm = applyRockSwitch(tm, r.rockSwitch);
        const openSeen = reachableFrom(openTm, r.entranceX, r.entranceY);
        const left = strandedTiles(openTm, openSeen);
        const lockedChests = chestAudit(openTm, openSeen).sealed;
        if (left.length) hard.push(`${label} seed ${seed}: ${left.length} tiles STILL stranded after the rock switch (${left.slice(0, 6).join(' ')})`);
        if (lockedChests.length) hard.push(`${label} seed ${seed}: chest at ${lockedChests.join(' ')} unopenable even after the rock switch`);
      } else {
        if (stranded.length) {
          t.stranded += stranded.length; t.strandedSeeds++;
          hard.push(`${label} seed ${seed}: ${stranded.length} sealed pocket tiles (${stranded.slice(0, 6).join(' ')})`);
        }
        if (chests.sealed.length) hard.push(`${label} seed ${seed}: chest at ${chests.sealed.join(' ')} has no reachable neighbour`);
      }
    }
    if (t.puzzleTiles) soft.push(`${label}: ${t.puzzleTiles} tiles sealed behind the rock switch — all ${t.seeds} seeds open fully when it is pulled`);
    if (t.exitOpenUnpuzzled) soft.push(`${label}: ${t.exitOpenUnpuzzled}/${t.seeds} seeds let you reach the way onward WITHOUT touching the boulder — the false wall is not on the only route`);
    // ⛔ PINNED PER DUNGEON+LAYOUT, BECAUSE THE TWO CAVES GENUINELY DIFFER.
    // A boulder that opens a wall you could already walk around is decoration,
    // and this is how the Cave of Seals' floor 2 read on 69 of 400 seeds until
    // its corridors were lengthened — long runs push the rooms far enough apart
    // that the false wall becomes the only link. Altar Cave keeps its short
    // corridors and therefore keeps the defect; its ceiling records that, so the
    // number cannot quietly grow, and the day its corridors change this is the
    // gate that says whether it fixed anything.
    const lay = layoutForFloor(dg, f);
    const role = PUZZLE_ROLE.get(`${dg.id}/${lay}`);
    if (role && role.gates === 'exit') {
      // ⛔ A RATE NEEDS A SAMPLE. `encounter-sim` calls this sweep with 60 seeds,
      // where a floor sitting at a true 17.8% comes out at 15/60 = 25% often
      // enough to fail a 20% ceiling on noise alone — which it did, on a build
      // where nothing about that floor had regressed. Ceilings above zero are
      // only meaningful once there are enough seeds to tell them apart; a ZERO
      // ceiling is exact at any n, so it stays enforced always.
      const cap = role.walkaroundCap;
      const enoughSeeds = cap === 0 || t.seeds >= 200;
      if (enoughSeeds && t.seeds && t.exitOpenUnpuzzled / t.seeds > cap) {
        hard.push(`${label}: the way onward is reachable without the boulder on ${t.exitOpenUnpuzzled}/${t.seeds} seeds (ceiling ${Math.round(cap * 100)}%) — the false wall has stopped being the only route`);
      }
    } else if (role && role.gates === 'treasure') {
      if (t.seeds && t.exitOpenUnpuzzled !== t.seeds) {
        hard.push(`${label}: the way onward is BEHIND THE BOULDER on ${t.seeds - t.exitOpenUnpuzzled}/${t.seeds} seeds — a boulder puzzle opens treasure, never an exit`);
      }
      if (t.sealedNoTreasure) {
        hard.push(`${label}: the sealed chamber holds NO chest on ${t.sealedNoTreasure}/${t.seeds} seeds — the puzzle pays nothing`);
      }
    }
    rows.push(t);
  }
  }
  return { hard, soft, rows };
}

/**
 * The generated maps that are NOT one of the five floors: the secret teleport
 * room (two variants, `goLeft` true/false) and the standalone locked rooms
 * 1010 / 1011. `map-loading.js` builds all three through the same
 * `_loadDungeonFloor` path the floors use, so a break here strands the player
 * exactly as badly — yet none of them was swept at all before v1.10.15.
 *
 * The seed the game feeds a locked room is `(dungeonSeed ^ mapId) | 0`
 * (`map-loading.js`), so the sweep uses that expression rather than a bare
 * counter — a room keyed off a differently-derived seed is a different sample.
 */
export function sweepSideMaps(rom, n = 150, base = 1754900000000) {
  const hard = []; const rows = [];
  const audit = (label, r) => {
    const seen = reachableFrom(r.tilemap, r.entranceX, r.entranceY);
    let reach = 0; for (let i = 0; i < 1024; i++) if (seen[i]) reach++;
    const stranded = strandedTiles(r.tilemap, seen);
    const chests = chestAudit(r.tilemap, seen);
    if (reach < 4) hard.push(`${label}: only ${reach} reachable tiles`);
    if (stranded.length) hard.push(`${label}: ${stranded.length} sealed pocket tiles (${stranded.slice(0, 6).join(' ')})`);
    if (chests.sealed.length) hard.push(`${label}: chest at ${chests.sealed.join(' ')} has no reachable neighbour`);
    return { reach, stranded: stranded.length, chests: chests.total };
  };

  for (const goLeft of [true, false]) {
    let r;
    try { r = generateSecretRoomMap(rom, goLeft); }
    catch (e) { hard.push(`secret room goLeft=${goLeft} threw: ${e.message}`); continue; }
    const a = audit(`secret room goLeft=${goLeft}`, r);
    rows.push({ map: `secret goLeft=${goLeft}`, seeds: 1, minReach: a.reach, stranded: a.stranded, chests: a.chests });
  }

  for (const mapId of [1010, 1011]) {
    const t = { map: `locked ${mapId}`, seeds: 0, minReach: Infinity, stranded: 0, chests: 0 };
    for (let k = 0; k < n; k++) {
      const seed = ((base + k * 7919) | 0) ^ mapId | 0;   // exactly map-loading.js
      let r;
      try { r = generateLockedRoomMap(rom, seed); }
      catch (e) { hard.push(`locked room ${mapId} seed ${seed} threw: ${e.message}`); continue; }
      t.seeds++;
      const a = audit(`locked room ${mapId} seed ${seed}`, r);
      t.minReach = Math.min(t.minReach, a.reach);
      t.stranded += a.stranded; t.chests += a.chests;
    }
    rows.push(t);
  }
  return { hard, rows };
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const romPath = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
  const rom = new Uint8Array(fs.readFileSync(romPath));
  const n = parseInt(process.argv[2] || '150', 10);
  const base = parseInt(process.argv[3] || '1754900000000', 10);

  const { hard, soft, rows } = sweepFloors(rom, n, base);
  console.log(`dungeon-sweep — ${n} timestamp-style seeds per floor (base ${base})\n`);
  console.log('floor             seeds  exitsWired  strandedSeeds  strandedTiles  chests');
  for (const r of rows) {
    console.log(String(r.floor).padEnd(18) + String(r.seeds).padStart(5) + String(r.exits).padStart(12)
      + String(r.strandedSeeds).padStart(15) + String(r.stranded).padStart(15) + String(r.chests).padStart(8));
  }

  const side = sweepSideMaps(rom, n, base);
  console.log('\nside maps (secret teleport room + standalone locked rooms)');
  console.log('map                    seeds  minReach  stranded  chests');
  for (const r of side.rows) {
    console.log(String(r.map).padEnd(23) + String(r.seeds).padStart(5)
      + String(r.minReach).padStart(10) + String(r.stranded).padStart(10) + String(r.chests).padStart(8));
  }

  if (soft.length) { console.log('\nby design (checked, not excused):'); for (const s2 of soft) console.log('  ' + s2); }

  const allHard = [...hard, ...side.hard];
  if (allHard.length) {
    console.log(`\nHARD FAILURES (${allHard.length}):`);
    for (const h of allHard.slice(0, 40)) console.log('  ' + h);
    if (allHard.length > 40) console.log(`  ... and ${allHard.length - 40} more`);
    process.exit(1);
  }
  console.log('\nno hard invariant violations');
}
