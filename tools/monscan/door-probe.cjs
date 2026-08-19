// door-probe.cjs — where every door goes, measured with CERTAINTY.
//
// The routing prober (`door-graph.cjs`) walks the party across a map to reach a
// door, and that walk is the whole problem: it can be blocked (all seven of
// Kazus's doors came back "unreachable on foot"), and it can cross ANOTHER
// trigger on the way, which fires the wrong transition and reads exactly like a
// table mismatch (it produced a full false "Ur door 0 is wrong").
//
// ⭐ SO DON'T WALK. PATCH THE ROM. Each map's entrance is 5 bits of byte 0 and 5
// bits of byte 1 of its 16-byte property record. Rewrite them to the door's
// DOORSTEP — the tile you stand on to step into it — and the party spawns one
// step away. One button press, no route, nothing to cross, nothing to
// misattribute. Lifted from `world-harness.cjs`, which uses the same patch to
// place the party for the world-map probes.
//
//   node tools/monscan/door-probe.cjs --selftest            # prove it first
//   node tools/monscan/door-probe.cjs doormap.json out.json
//   MAPS=10,18 node tools/monscan/door-probe.cjs doormap.json out.json
//
// ⭐ $48 IS THE CURRENT MAP ID — calibrated by warping to three maps in three
// separate boots and intersecting RAM. $0700 is NOT usable: after a door it read
// 27 while the map that had loaded was 25 (it is a $0700,X array, per 3F/C2B7
// `LDA $0700,X / STA $48`).
//
// ⛔ ONE WARP PER BOOT. A second warp in the same session never clears $AB again
// and the probe then reports the first map forever. The intro costs ~3000 frames,
// so it is run ONCE and snapshotted; each door restores that savestate into a
// freshly-patched ROM. The savestate carries RAM/PPU/mapper state, not ROM bytes,
// which is exactly why re-patching between restores is sound — and the position
// assertion below would catch it if it were not.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Nes, BTN } = require('./nes.cjs');

const BASE_ROM = process.env.ROM || '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const MAP_PROPS_BASE = 0x004010;          // 512 maps x 16 bytes, header-inclusive
const MAP_ID = 0x48, TILE_X = 0x68, TILE_Y = 0x69;
const CACHE = path.join(os.tmpdir(), 'ff3-door-probe-boot.json');

function run(nes, n) { for (let i = 0; i < n; i++) nes.nes.frame(); }
function press(nes, b, h = 8, a = 24) { nes.nes.buttonDown(1, BTN[b]); run(nes, h); nes.nes.buttonUp(1, BTN[b]); run(nes, a); }
function spriteCount(nes) { let c = 0; for (let i = 0; i < 64; i++) if (nes.nes.ppu.sprY[i] < 0xEF) c++; return c; }

function bootToField(nes) {
  run(nes, 300);
  for (let i = 0; i < 25; i++) press(nes, 'start', 6, 45);
  for (let b = 0; b < 10; b++) { for (let k = 0; k < 6; k++) press(nes, 'a', 8, 25); press(nes, 'down', 8, 40); }
  run(nes, 400);
  for (let t = 0; t < 40 && spriteCount(nes) > 12; t++) {
    for (let c = 0; c < 4; c++) { press(nes, 'down', 8, 20); press(nes, 'down', 8, 20); press(nes, 'a', 8, 24); }
    run(nes, 240);
  }
  for (let i = 0; i < 12; i++) press(nes, 'a', 6, 20);
  press(nes, 'down', 20, 30); run(nes, 180);
}

function warp(nes, mapId, hf = 400) {
  const cpu = nes.nes.cpu;
  for (let f = 0; f < hf; f++) {
    cpu.mem[0x0700] = mapId & 0xFF; cpu.mem[0x00AB] = 0x80; nes.nes.frame();
    if (cpu.mem[0x00AB] !== 0x80) { run(nes, 90); return true; }
  }
  return false;
}

/** A ROM whose map `mapId` spawns the party on (sx, sy). */
function romWithEntrance(mapId, sx, sy) {
  const rom = Buffer.from(fs.readFileSync(BASE_ROM));
  const o = MAP_PROPS_BASE + mapId * 16;
  // ⛔ Top 3 bits of byte 0 are the TILESET and of byte 1 are not ours either —
  // clobbering them loads the map with the wrong graphics and the probe measures
  // a different place than it thinks.
  rom[o] = (rom[o] & 0xE0) | (sx & 0x1F);
  rom[o + 1] = (rom[o + 1] & 0xE0) | (sy & 0x1F);
  if ((rom[o] & 0x1F) !== (sx & 0x1F) || (rom[o + 1] & 0x1F) !== (sy & 0x1F)) throw new Error('entrance patch did not land');
  const p = path.join(os.tmpdir(), `ff3-door-${mapId}-${sx}-${sy}.nes`);
  fs.writeFileSync(p, rom);
  return p;
}

let BOOT_STATE = null;
function bootState() {
  if (BOOT_STATE) return BOOT_STATE;
  if (fs.existsSync(CACHE)) { BOOT_STATE = JSON.parse(fs.readFileSync(CACHE, 'utf8')); return BOOT_STATE; }
  const nes = new Nes(BASE_ROM, {});
  bootToField(nes);
  BOOT_STATE = nes.save();
  fs.writeFileSync(CACHE, JSON.stringify(BOOT_STATE));
  return BOOT_STATE;
}

/**
 * Walk one step into a door and report where the game put us.
 * Returns { dest, land } or { error } — never a guess.
 */
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

/**
 * Spawn on the DOORSTEP and step in. The everyday case.
 *
 * ⛔ Cannot be the only strategy: it needs a doorstep the party can stand on AND
 * a door tile enterable from it, and 33 of 102 doors fail one of those.
 */
function fromDoorstep(mapId, door, [sx, sy], walk) {
  const romPath = romWithEntrance(mapId, sx, sy);
  const nes = new Nes(romPath, {});
  nes.load(bootState());
  try {
    if (!warp(nes, mapId)) return { error: 'warp did not take' };
    const m = nes.nes.cpu.mem;
    if (m[MAP_ID] !== mapId) return { error: `warped to ${mapId} but $48 reads ${m[MAP_ID]}` };
    // The engine shifts a spawn when the entrance tile's collision says to.
    // Measuring past that would be measuring a different tile.
    if (m[TILE_X] !== sx || m[TILE_Y] !== sy) return { error: `spawned at (${m[TILE_X]},${m[TILE_Y]}), wanted the doorstep (${sx},${sy})` };
    let stoodOnDoor = false;
    for (let t = 0; t < 10 && m[MAP_ID] === mapId; t++) {
      press(nes, walk, 16, 8);
      if (m[TILE_X] === door.x && m[TILE_Y] === door.y) { stoodOnDoor = true; run(nes, 40); }
    }
    if (m[MAP_ID] !== mapId) return { dest: m[MAP_ID], land: [m[TILE_X], m[TILE_Y]], via: `doorstep (${sx},${sy}) going ${walk}` };
    return { error: stoodOnDoor ? `stood on the door from (${sx},${sy}) and nothing fired`
                                : `could not step onto the door from (${sx},${sy}) going ${walk}` };
  } finally { try { fs.unlinkSync(romPath); } catch { /* temp file */ } }
}

/**
 * Spawn ON the door, step off, step back on.
 *
 * ⭐ This is what settles a door the doorstep strategy could not enter: if NO
 * direction moves, the tile is walled in on all four sides and no player can
 * ever reach it. `sealed` is a fact about the map.
 *
 * ⛔ It cannot replace the doorstep strategy. FF3 disarms the trigger you arrive
 * on, and stepping off and back does not re-arm it — which is why every trigId 0
 * (the door nearest a map's own entrance) comes back "nothing fired" here while
 * the doorstep run measures it fine. Two strategies, and where both answer they
 * agreed on all 56 doors.
 */
function fromDoorTile(mapId, door) {
  const romPath = romWithEntrance(mapId, door.x, door.y);
  const nes = new Nes(romPath, {});
  nes.load(bootState());
  try {
    if (!warp(nes, mapId)) return { error: 'warp did not take' };
    const m = nes.nes.cpu.mem;
    if (m[MAP_ID] !== mapId) return { error: `warped to ${mapId} but $48 reads ${m[MAP_ID]}` };
    if (m[TILE_X] !== door.x || m[TILE_Y] !== door.y) return { error: `spawned at (${m[TILE_X]},${m[TILE_Y]}), wanted the door tile` };
    for (const d of ['down', 'up', 'left', 'right']) {
      const bm = m[MAP_ID];
      press(nes, d, 16, 8);
      if (m[MAP_ID] !== bm) return { dest: m[MAP_ID], land: [m[TILE_X], m[TILE_Y]], via: `stepping ${d} off the door` };
      if (m[TILE_X] === door.x && m[TILE_Y] === door.y) continue;    // walled that way
      const off = [m[TILE_X], m[TILE_Y]];
      press(nes, OPPOSITE[d], 16, 8);
      for (let t = 0; t < 6 && m[MAP_ID] === mapId; t++) run(nes, 30);
      if (m[MAP_ID] !== mapId) return { dest: m[MAP_ID], land: [m[TILE_X], m[TILE_Y]], via: `off to (${off}) and back` };
      return { error: `stepped back onto the door from (${off}) and nothing fired — the arrival trigger is disarmed`, disarmed: true };
    }
    return { sealed: true };
  } finally { try { fs.unlinkSync(romPath); } catch { /* temp file */ } }
}

/** Where one door goes. { dest, land } | { sealed } | { error }. Never a guess. */
function probe(mapId, door) {
  const steps = door.approaches && door.approaches.length
    ? door.approaches
    : (door.approach ? [{ at: door.approach, walk: door.walk }] : []);
  let last = null;
  for (const a of steps) {
    const r = fromDoorstep(mapId, door, a.at, a.walk);
    if (r.dest != null) return r;
    last = r;
  }
  const r2 = fromDoorTile(mapId, door);
  if (r2.dest != null || r2.sealed) return r2;
  return last || r2;
}

// ── self-test ─────────────────────────────────────────────────────────────
// ⛔ A prober that cannot reach something reports a HARNESS fact, not a game
// fact. Before believing any new answer, reproduce doors already measured by
// hand with a completely different method (a controlled step-by-step walk).
const KNOWN = [
  { map: 114, trigId: 1, dest: 3 },
  { map: 114, trigId: 4, dest: 6 },
  { map: 114, trigId: 6, dest: 147 },
  { map: 18, trigId: 1, dest: 174 },
  { map: 18, trigId: 2, dest: 25 },
];

/**
 * ⭐ THE CONTROL FOR `sealed`.
 *
 * "The party could not move in any direction" is only evidence about the map if
 * the party CAN move after a patched spawn at all. `world-harness.cjs` documents
 * the near-miss version of this: poking $27/$28 holds the coordinates and
 * FREEZES movement, so a harness doing that would report every tile in the game
 * as sealed. Spawn on ordinary floor and require that it moves.
 */
function movementControl(mapsData) {
  const FLOOR = { map: 18, x: 15, y: 20 };      // Castle Sasune courtyard
  const romPath = romWithEntrance(FLOOR.map, FLOOR.x, FLOOR.y);
  const nes = new Nes(romPath, {});
  nes.load(bootState());
  try {
    if (!warp(nes, FLOOR.map)) return 'warp did not take';
    const m = nes.nes.cpu.mem;
    if (m[TILE_X] !== FLOOR.x || m[TILE_Y] !== FLOOR.y) return `spawned at (${m[TILE_X]},${m[TILE_Y]})`;
    let moved = 0;
    for (const d of ['down', 'left', 'right', 'up']) {
      const bx = m[TILE_X], by = m[TILE_Y];
      press(nes, d, 16, 8);
      if (m[TILE_X] !== bx || m[TILE_Y] !== by) { moved++; press(nes, OPPOSITE[d], 16, 8); }
    }
    return moved >= 2 ? null : `only ${moved} of 4 directions moved — movement after a patched spawn is not trustworthy`;
  } finally { try { fs.unlinkSync(romPath); } catch { /* temp file */ } }
}

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const MAPS = JSON.parse(fs.readFileSync(args[0] || 'door-map.json', 'utf8'));

if (process.argv.includes('--selftest')) {
  let bad = 0;
  const ctl = movementControl(MAPS);
  if (ctl) { console.log(`  movement control  ⛔ ${ctl}`); bad++; }
  else console.log('  movement control  ✓ the party moves freely after a patched spawn (so `sealed` means sealed)');
  for (const k of KNOWN) {
    const door = MAPS[k.map].doors.find(d => d.trigId === k.trigId);
    const r = probe(k.map, door);
    const got = r.dest != null ? r.dest : `ERROR: ${r.error}`;
    const pass = r.dest === k.dest;
    if (!pass) bad++;
    console.log(`  map ${String(k.map).padStart(3)} door ${k.trigId} -> ${String(got).padStart(3)}  (hand-measured ${k.dest}) ${pass ? '✓' : '⛔'}`);
  }
  console.log(bad ? `\nself-test: ${bad} FAILURE(S) — do not trust this tool` : '\nself-test: OK');
  process.exit(bad ? 1 : 0);
}

const only = process.env.MAPS ? new Set(process.env.MAPS.split(',').map(Number)) : null;
const results = {};
let n = 0, mismatch = 0, unmeasured = 0, sealed = 0;
for (const md of Object.values(MAPS)) {
  if (only && !only.has(md.mapId)) continue;
  for (const d of md.doors) {
    const r = probe(md.mapId, d);
    n++;
    const rec = { from: md.mapId, trigId: d.trigId, at: [d.x, d.y], ourDest: d.ourDest, ...r };
    if (r.dest != null) { rec.match = r.dest === d.ourDest; if (!rec.match) mismatch++; }
    else if (r.sealed) sealed++;
    else unmeasured++;
    results[`${md.mapId}:${d.trigId}`] = rec;
    const tail = r.dest != null
      ? `ROM ${String(r.dest).padStart(3)} @(${r.land}) | ours ${String(d.ourDest).padStart(3)} ${rec.match ? '✓' : '⛔ MISMATCH'}`
      : r.sealed ? `SEALED — walled in on all four sides, no player can reach it | ours ${d.ourDest}`
      : `NOT MEASURED — ${r.error}`;
    console.log(`  map ${String(md.mapId).padStart(3)} door ${d.trigId} @(${d.x},${d.y}) -> ${tail}`);
    fs.writeFileSync(args[1] || 'door-probe.json', JSON.stringify(results, null, 1));
  }
}
console.log(`\n${n} door(s): ${n - unmeasured - sealed} measured, ${sealed} sealed, ${unmeasured} unaccounted, ${mismatch} mismatch(es)`);
fs.writeFileSync(args[1] || 'door-probe.json', JSON.stringify(results, null, 1));
