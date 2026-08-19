// door-graph.cjs — where every door ACTUALLY goes, measured in the real ROM.
//
// Our engine resolves a door as `mapData.entranceData[trigId]`, with `trigId` a
// per-type counter assigned in tilemap scan order. That matches the ROM routine
// at 3A/91C8 on paper, but "matches on paper" is how Castle Sasune got a report
// of warps landing all over the game. This walks the party into each door in a
// real emulator and reads the map id back.
//
//   node tools/monscan/door-graph.cjs doormap.json out.json
//   MAPS=18,25 node tools/monscan/door-graph.cjs doormap.json out.json
//
// ⛔ ONE WARP PER BOOT. Warping a second time in the same session never clears
// $AB again, so the probe silently reports the FIRST map forever and every
// address "agrees" with it. The loop below therefore boots fresh per attempt and
// chains as far as it can on foot before paying for another boot.
//
// ⭐ $48 IS THE CURRENT MAP ID. Calibrated by warping to 18 / 25 / 114 in three
// separate boots and intersecting RAM: $48 and $0700 were the only bytes holding
// the id in all three. $0700 is NOT usable here — after walking through a door it
// held 27 while the map that had actually loaded was 25.
const fs = require('fs');
const { Nes, BTN } = require('./nes.cjs');

const ROM = process.env.ROM || '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const IN = process.argv[2], OUT = process.argv[3];
if (!IN || !OUT) { console.error('usage: door-graph.cjs <door-map.json> <out.json>'); process.exit(1); }
const MAPS = JSON.parse(fs.readFileSync(IN, 'utf8'));

const MAP_ID = 0x48, TILE_X = 0x68, TILE_Y = 0x69;

function run(nes, n) { for (let i = 0; i < n; i++) nes.nes.frame(); }
function press(nes, b, h = 8, a = 24) { nes.nes.buttonDown(1, BTN[b]); run(nes, h); nes.nes.buttonUp(1, BTN[b]); run(nes, a); }
function spriteCount(nes) { let c = 0; for (let i = 0; i < 64; i++) if (nes.nes.ppu.sprY[i] < 0xEF) c++; return c; }

function bootToWorld(nes) {
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

/** BFS over the map's walkable grid to the door tile. Returns a direction list. */
function route(grid, from, to, avoid) {
  const key = (x, y) => y * 32 + x;
  const blocked = new Set((avoid || []).filter(([x, y]) => !(x === to[0] && y === to[1])).map(([x, y]) => key(x, y)));
  const prev = new Map([[key(...from), null]]);
  const q = [from];
  const DIRS = [['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0]];
  while (q.length) {
    const [x, y] = q.shift();
    if (x === to[0] && y === to[1]) {
      const path = [];
      let k = key(x, y);
      while (prev.get(k)) { const [d, pk] = prev.get(k); path.push(d); k = pk; }
      return path.reverse();
    }
    for (const [d, dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx > 31 || ny > 31) continue;
      const nk = key(nx, ny);
      if (prev.has(nk)) continue;
      // the destination door tile itself is the goal even if the grid is unsure
      if (blocked.has(nk)) continue;
      if (!grid[ny][nx] && !(nx === to[0] && ny === to[1])) continue;
      prev.set(nk, [d, key(x, y)]);
      q.push([nx, ny]);
    }
  }
  return null;
}

// ⛔ WHERE THE PARTY WAS STANDING WHEN THE MAP CHANGED. A route to a far door
// can cross ANOTHER door on the way, and the first version credited whatever
// transition happened next to the door it was aiming at — a silent
// misattribution that is indistinguishable from a real table mismatch. Every
// result is now discarded unless the transition fired from the intended tile.
let lastTileBefore = null;

/** One step. Retries — a single press is sometimes eaten mid-animation. */
function step(nes, dir) {
  const m = nes.nes.cpu.mem;
  const bx = m[TILE_X], by = m[TILE_Y], bm = m[MAP_ID];
  for (let t = 0; t < 4; t++) {
    lastTileBefore = [m[TILE_X], m[TILE_Y]];
    nes.nes.buttonDown(1, BTN[dir]); run(nes, 16); nes.nes.buttonUp(1, BTN[dir]); run(nes, 6);
    if (m[MAP_ID] !== bm) return 'transition';
    if (m[TILE_X] !== bx || m[TILE_Y] !== by) return 'moved';
  }
  return 'blocked';
}

const results = {};
const want = new Set();
const only = process.env.MAPS ? new Set(process.env.MAPS.split(',').map(Number)) : null;
for (const m of Object.values(MAPS)) {
  if (only && !only.has(m.mapId)) continue;
  for (const d of m.doors) want.add(`${m.mapId}:${d.trigId}`);
}
console.log(`${want.size} door(s) to measure`);

let boots = 0;
while (want.size) {
  const next = [...want][0];
  const startMap = Number(next.split(':')[0]);
  boots++;
  const nes = new Nes(ROM, {});
  bootToWorld(nes);
  if (!warp(nes, startMap)) { console.log(`  map ${startMap}: WARP FAILED`); for (const k of [...want]) if (k.startsWith(startMap + ':')) { results[k] = { error: 'warp failed' }; want.delete(k); } continue; }
  const m = nes.nes.cpu.mem;
  let cur = m[MAP_ID];
  if (cur !== startMap) console.log(`  ⚠ warped to ${startMap} but $48 reads ${cur}`);
  // chain through as many doors as this boot can reach
  for (let hop = 0; hop < 12; hop++) {
    const md = MAPS[cur];
    if (!md) { console.log(`  landed on map ${cur} — not in the door map, stopping this boot`); break; }
    const todo = md.doors.filter(d => want.has(`${cur}:${d.trigId}`));
    if (!todo.length) break;
    const here = [m[TILE_X], m[TILE_Y]];
    let done = false, progressed = false;
    for (const d of todo) {
      const path = route(md.walk, here, [d.x, d.y], md.avoid);
      if (!path) {
        // ⛔ A door with no route MUST leave the queue. The first version just
        // `continue`d, so a map whose doors were all unroutable re-entered the
        // while-loop on the same key and booted the emulator forever — three
        // minutes at 100% CPU with not one line of output.
        results[`${cur}:${d.trigId}`] = { from: cur, trigId: d.trigId, at: [d.x, d.y], ourDest: d.ourDest, romDest: null, note: 'no walkable route from the spawn' };
        want.delete(`${cur}:${d.trigId}`); progressed = true;
        console.log(`  map ${String(cur).padStart(3)} door ${d.trigId} @(${d.x},${d.y}) -> unreachable on foot | ours ${d.ourDest}`);
        continue;
      }
      let out = null;
      for (const dir of path) { const r = step(nes, dir); if (r === 'transition') { out = 'transition'; break; } if (r === 'blocked') { out = 'blocked'; break; } }
      const restX = m[TILE_X], restY = m[TILE_Y];
      if (out === 'blocked') { results[`${cur}:${d.trigId}`] = { from: cur, trigId: d.trigId, at: [d.x, d.y], ourDest: d.ourDest, romDest: null, note: 'route blocked' }; want.delete(`${cur}:${d.trigId}`); progressed = true; continue; }
      const approach = path[path.length - 1] || 'up';
      if (out !== 'transition') {
        // Standing on the door tile. Some fire on arrival after a beat, some
        // want another push in the approach direction. Idle FIRST — re-pressing
        // straight away walks the party off the tile and the door never fires.
        for (let t = 0; t < 8 && m[MAP_ID] === cur && m[TILE_X] === restX && m[TILE_Y] === restY; t++) {
          run(nes, 30);
          if (t >= 3) { lastTileBefore = [m[TILE_X], m[TILE_Y]]; press(nes, approach, 16, 6); }
        }
      }
      const landed = m[MAP_ID];
      // ⛔ "the map id did not change" is NOT "the door goes to itself". A door
      // that never fires leaves the party standing exactly where it was, and
      // recording that as `romDest = cur` invents a self-loop and reports a
      // MISMATCH against a table that is probably fine (map 6's stair door read
      // as "-> 6" that way). A same-map warp is real and looks different: the
      // position jumps.
      const moved = m[TILE_X] !== restX || m[TILE_Y] !== restY;
      if (landed === cur && !moved) {
        results[`${cur}:${d.trigId}`] = { from: cur, trigId: d.trigId, at: [d.x, d.y], ourDest: d.ourDest,
          romDest: null, note: 'stood on the door and nothing fired' };
        want.delete(`${cur}:${d.trigId}`); progressed = true;
        console.log(`  map ${String(cur).padStart(3)} door ${d.trigId} @(${d.x},${d.y}) -> did not fire | ours ${d.ourDest}`);
        continue;
      }
      const firedAt = lastTileBefore || [-1, -1];
      // On-target means: the party was STANDING ON the door tile when it fired.
      // Two ways to get there, and they need different evidence.
      //   * `out === 'transition'` — it fired during the walk, before we ever
      //     arrived. Only trust it if the last tile stood on was the door.
      //   * otherwise we reached the door (restX/restY is the door tile) and it
      //     fired while idling there. `lastTileBefore` is then still the
      //     APPROACH tile, which is correct and must not be read as a miss —
      //     reading it that way threw away two doors that were measured fine.
      const reachedDoor = restX === d.x && restY === d.y;
      const onTarget = reachedDoor || (firedAt[0] === d.x && firedAt[1] === d.y);
      if (landed !== cur && !onTarget) {
        results[`${cur}:${d.trigId}`] = { from: cur, trigId: d.trigId, at: [d.x, d.y], ourDest: d.ourDest,
          romDest: null, note: `route crossed another trigger at (${firedAt}) before reaching this door` };
        want.delete(`${cur}:${d.trigId}`); progressed = true;
        console.log(`  map ${String(cur).padStart(3)} door ${d.trigId} @(${d.x},${d.y}) -> crossed a trigger at (${firedAt}), NOT measured`);
        cur = landed; done = true; break;
      }
      const rec = { from: cur, trigId: d.trigId, at: [d.x, d.y], ourDest: d.ourDest, firedAt,
                    romDest: landed, land: [m[TILE_X], m[TILE_Y]], match: landed === d.ourDest };
      results[`${cur}:${d.trigId}`] = rec;
      want.delete(`${cur}:${d.trigId}`);
      console.log(`  map ${String(cur).padStart(3)} door ${d.trigId} @(${d.x},${d.y}) -> ROM ${String(landed).padStart(3)} @(${rec.land}) | ours ${String(d.ourDest).padStart(3)} ${rec.match ? '✓' : '⛔ MISMATCH'}`);
      progressed = true;
      if (landed !== cur) { cur = landed; done = true; }
      break;
    }
    if (!done) { if (!progressed) break; continue; }
  }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
}
const all = Object.values(results);
const bad = all.filter(r => r.romDest != null && !r.match);
console.log(`\n${boots} boot(s); measured ${all.filter(r => r.romDest != null).length}/${all.length}; ${bad.length} mismatch(es)`);
fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
