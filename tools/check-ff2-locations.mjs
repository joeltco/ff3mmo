#!/usr/bin/env node
// check-ff2-locations.mjs — FF2's location table and the warp stay working.
//
// This is the gate on the thing that unblocked FF2 after three dead ends. What
// can silently break:
//
//   ⛔ the table offset — `LOC_TILEMAP_TABLE` moving makes every warp load the
//      wrong map while still "working";
//   ⛔ the NMI stub — if `$0100` is not the vector, or the stub is not restored,
//      the warp either never fires or reloads the map every frame forever;
//   ⛔ hashing $7400 too late. `$D083` writes per-location data into that region
//      after the loader returns, so a late hash makes two locations with the SAME
//      tilemap differ, and the patch proof fails for an unrelated reason.
//
//   node tools/check-ff2-locations.mjs
//
// ⭐ THE PROOF IS A PATCH, NOT A READ. "$48 holds the location id" proves nothing.
// Repointing one location's table entry at another's tilemap must make it
// decompress to the OTHER location's map byte for byte — in BOTH directions —
// while the unpatched runs still differ, so the check can fail.

import * as L2 from './lib/ff2-locations.mjs';

const { rom, snapshot } = L2.loadFixtures();
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const go = (loc, opts) => L2.warp(rom, snapshot, loc, opts);

let bad = 0, n = 0;
const ok = (label, cond, detail) => {
  n++; if (!cond) bad++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('FF2 location table + NMI-stub warp\n');
const [A, B] = L2.TCRF_ANCHORS;
const a = go(A.loc), b = go(B.loc);
for (const r of [a, b])
  console.log(`  loc ${hx(r.loc)} -> tilemap ${hx(r.tilemap)} (CPU loaded ${hx(r.tilemapLive ?? 0)})  ` +
              `map ${r.hash} (${r.nonzero} nonzero)`);
console.log('');

ok('the warp fires and is caught at the loader\'s return', a.capturedAtReturn && b.capturedAtReturn);
ok('the CPU really executed the table read', a.readTable && b.readTable);
ok('the byte the CPU loaded is the byte at the table offset',
   a.tilemapLive === a.tilemap && b.tilemapLive === b.tilemap);
ok('the loader actually decompressed something', a.nonzero > 64 && b.nonzero > 64);
ok('two different locations give two different maps', a.hash !== b.hash);
ok('the table still matches the anchors',
   a.tilemap === A.tilemap && b.tilemap === B.tilemap,
   `${hx(a.tilemap)} / ${hx(b.tilemap)}`);

// ⭐ the patch proof, both directions
const fwd = go(A.loc, { patch: { [L2.LOC_TILEMAP_TABLE + A.loc]: b.tilemap } });
ok(`repointing loc ${hx(A.loc)} at tilemap ${hx(b.tilemap)} loads loc ${hx(B.loc)}'s map EXACTLY`,
   fwd.hash === b.hash, `${a.hash} -> ${fwd.hash}`);
const rev = go(B.loc, { patch: { [L2.LOC_TILEMAP_TABLE + B.loc]: a.tilemap } });
ok(`...and the reverse`, rev.hash === a.hash, `${b.hash} -> ${rev.hash}`);
// ⛔ without this the two above could both pass on identical maps
ok('the unpatched runs still differ (the proof can fail)', a.hash !== b.hash);

// TCRF's claim, checked against the ROM rather than believed
const used = [];
for (let i = 0; i < 0x100; i++) if (L2.tilemapOf(rom, i) === L2.UNREFERENCED_TILEMAP) used.push(i);
ok(`tilemap ${hx(L2.UNREFERENCED_TILEMAP)} is referenced by no location`, used.length === 0,
   used.length ? `used by ${used.map(v => hx(v)).join(',')}` : 'unreferenced');

// ── ⭐ the WARP TABLE: $B000 = destination X, $B100 = destination Y ─────────
// ⛔ Proven by PATCHING, not by reading: change the destination-X entry and the
// party must land on the new X. A read would only show the table holds a number.
{
  const DEST = 0x05;
  const e = L2.enterLocation(rom, snapshot, DEST);
  ok('a full entry places the party where the tables say',
     e.x === L2.destX(rom, DEST) && e.y === L2.destY(rom, DEST),
     `at ${e.x},${e.y}`);
  ok('...and the screen actually redrew (not the pre-warp scene)',
     new Set(e.nt).size > 24, `${new Set(e.nt).size} distinct nametable tiles`);

  const want = (rom[L2.DEST_X_TABLE + DEST] & ~L2.DEST_X_MASK) | 0x11;   // keep the top 3 bits
  const moved = L2.enterLocation(rom, snapshot, DEST, { patch: { [L2.DEST_X_TABLE + DEST]: want } });
  ok('patching $B000 MOVES where the party lands',
     moved.x === ((0x11 - L2.DEST_BIAS) & L2.DEST_WRAP) && moved.x !== e.x,
     `${e.x} -> ${moved.x}`);
  const movedY = L2.enterLocation(rom, snapshot, DEST, { patch: { [L2.DEST_Y_TABLE + DEST]: 0x19 } });
  ok('patching $B100 MOVES the party Y', movedY.y === ((0x19 - L2.DEST_BIAS) & L2.DEST_WRAP) && movedY.y !== e.y,
     `${e.y} -> ${movedY.y}`);
  // ⛔ two different destinations must give two different screens, or the
  // "it redrew" check above could pass on one static scene.
  const other = L2.enterLocation(rom, snapshot, 0x1E);
  ok('two destinations give two different screens',
     JSON.stringify(other.nt) !== JSON.stringify(e.nt));
}

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad ? 1 : 0);
