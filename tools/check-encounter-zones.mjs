#!/usr/bin/env node
// check-encounter-zones.mjs — the safe starter zone must actually cover the
// starter area.
//
// The previous rule was a hard-coded box (x 93-96, y 34-44) sized for the world
// as it existed before v1.7.903 lifted the choke. Nothing failed when the world
// grew; the box just silently stopped covering it, and 236 of 267 reachable
// tiles started rolling Killer Bees and Werewolves at rate 'high'. The
// encounters table itself notes an L1 party survives werewolf x4 only 6.5% of
// the time. A stale constant with no gate is how that happens quietly.
//
//   node tools/check-encounter-zones.mjs

import fs from 'node:fs';

globalThis.document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {}, drawImage() {},
    }),
  }),
};

const { loadWorldMap } = await import('../src/world-map-loader.js');
const { WorldMapRenderer } = await import('../src/world-map-renderer.js');
const { ENCOUNTERS, world0ZoneKey } = await import('../src/data/encounters.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROM));
const world = loadWorldMap(rom, 0);
const stub = { data: world };
const pass = (x, y) => WorldMapRenderer.prototype.isPassable.call(stub, x, y);
const W = world.mapWidth;

// Mirrors src/battle-encounter.js#currentEncounterZoneKey. Past the radius the
// answer is the ROM's own region grid (v1.10.56), so this calls the shipped
// `world0ZoneKey` rather than naming a zone — a hand-copied key here is exactly
// how the box this gate exists to catch went stale in the first place.
const UR_X = 95, UR_Y = 41, SAFE_RADIUS = 8;
const zoneAt = (x, y) =>
  Math.max(Math.abs(x - UR_X), Math.abs(y - UR_Y)) <= SAFE_RADIUS
    ? 'grasslands_valley' : world0ZoneKey(x, y);

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.error('  ✗ ' + m); failed++; };

// Reachable world, flooded with the real isPassable.
let seed = null;
for (const [t, p] of world.triggerPositions) if (world.entranceTable[t] === 114) { seed = p; break; }
if (!seed) { console.error('could not locate Ur'); process.exit(2); }
const seen = new Set([seed.y * W + seed.x]);
const q = [[seed.x, seed.y]];
while (q.length) {
  const [x, y] = q.pop();
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const nx = ((x + dx) % W + W) % W, ny = ((y + dy) % W + W) % W, k = ny * W + nx;
    if (seen.has(k) || !pass(nx, ny)) continue;
    seen.add(k); q.push([nx, ny]);
  }
}

// ── 1. Both zones exist in the data ───────────────────────────────────────
for (const z of ['grasslands_valley', 'grasslands_wild']) {
  if (ENCOUNTERS.has(z)) ok(`zone '${z}' is defined`);
  else bad(`zone '${z}' is missing from ENCOUNTERS`);
}

// ── 2. Ur itself is safe ──────────────────────────────────────────────────
if (zoneAt(seed.x, seed.y) === 'grasslands_valley') ok('Ur’s own tile is in the safe zone');
else bad('standing on Ur rolls the tier-2 zone');

// ── 3. Every entrance a new character can reach on the starter loop is safe.
// Altar Cave (111) is the intended early grind; if it falls outside, the walk
// there is tier-2 and the loop is unplayable at low level.
const STARTER_DESTS = new Set([114, 111]);
for (const [t, p] of world.triggerPositions) {
  const dest = world.entranceTable[t];
  if (!STARTER_DESTS.has(dest)) continue;
  if (zoneAt(p.x, p.y) === 'grasslands_valley') ok(`entrance to map ${dest} at (${p.x},${p.y}) is in the safe zone`);
  else bad(`entrance to map ${dest} at (${p.x},${p.y}) rolls ${zoneAt(p.x, p.y)} — the cartridge's tier-2 region`);
}

// ── 4. The safe zone is a real region, not a vestige ──────────────────────
let safe = 0;
for (const k of seen) {
  const x = k % W, y = (k - (k % W)) / W;
  if (zoneAt(x, y) === 'grasslands_valley') safe++;
}
const pct = Math.round((safe / seen.size) * 100);
if (safe >= 40) ok(`safe zone covers ${safe}/${seen.size} reachable tiles (${pct}%)`);
else bad(`safe zone covers only ${safe}/${seen.size} reachable tiles (${pct}%) — it has gone stale again`);

// ── 5. The safe zone is goblins only ──────────────────────────────────────
{
  const z = ENCOUNTERS.get('grasslands_valley');
  const ids = new Set((z?.formations || []).flat().map(g => g.id));
  if (ids.size && [...ids].every(id => id === 0x00)) ok('safe zone spawns Goblins only');
  else bad(`safe zone spawns non-starter monsters: ${[...ids].map(i => '0x' + i.toString(16)).join(', ')}`);
}

// ── 6. The Cave of Seals is walled off, and must not open by accident ─────
//
// ⛔ THIS IS A TRIPWIRE, NOT A PREFERENCE. `tools/zone-balance.mjs` puts a
// KN5 party's odds in the Cave of Seals at 4% (Mummy x2-4 is 48/64 of floor 1)
// against 100% on Altar Cave's deepest floor — the sharpest difficulty step in
// the game. Right now that does not reach a player: the cartridge's own mouth at
// (84,36) sits in an isolated pocket of 8 tiles with no path to Ur, so the
// dungeon is debug-only. The day someone lifts a choke and joins those regions,
// a level-5 character can walk straight into it, and NOTHING else would say so.
//
// If this fails: that is the moment to decide the Seals gate — a level check, a
// quest flag, or an intended difficulty spike. Then update this block.
{
  const SEALS_MOUTH = { x: 84, y: 36 };
  const k = SEALS_MOUTH.y * W + SEALS_MOUTH.x;
  let mouth = null;
  for (const [t, p] of world.triggerPositions) if (world.entranceTable[t] === 103) { mouth = p; break; }
  if (!mouth) bad('the Cave of Seals overworld mouth (map 103) is not on the world map at all');
  else if (mouth.x !== SEALS_MOUTH.x || mouth.y !== SEALS_MOUTH.y)
    bad(`the Cave of Seals mouth moved to (${mouth.x},${mouth.y}) — re-check this tripwire`);
  else if (seen.has(k))
    bad(`the Cave of Seals mouth (84,36) is now REACHABLE from Ur. A level-5 party wins ~4% of its floor-1 encounters — gate the dungeon or accept the spike, then update this check.`);
  else ok('the Cave of Seals mouth is still walled off from Ur (debug-only)');
}

if (failed) { console.error(`\ncheck-encounter-zones: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-encounter-zones: OK');
