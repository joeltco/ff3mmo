// reach-flood.cjs — what the player can ACTUALLY reach, floods by walking.
//
// Every reachability answer in this repo comes from `MapRenderer.isPassable`,
// which is our model of the cartridge. That model put map 2's spawn at (8,21);
// the cartridge puts it at (8,31), a different room on the same tilemap. When
// the model is the thing in question you cannot use the model to check it.
//
// So this walks. Every step is a real button press into a real emulator and the
// party's own tile coordinates ($68/$69) say whether it worked. No passability
// rule is consulted or reimplemented.
//
//   node tools/monscan/reach-flood.cjs 2
//   node tools/monscan/reach-flood.cjs 2 --at 8,31      # force a start tile
//
// ⛔ Doors are avoided, not walked through: stepping on one ends the flood on a
// different map. They are found by touching them, so the flood is re-run with
// each newly-found door marked off until no new one turns up. `doors` in the
// output is therefore "doors this region can actually reach", which is the
// question worth asking.
//
// ⛔ ONE WARP PER BOOT — a second warp never clears $AB again. The boot is
// snapshotted (~3000 frames) and restored per run.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Nes, BTN } = require('./nes.cjs');

const BASE_ROM = process.env.ROM || '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const MAP_PROPS_BASE = 0x004010;
const MAP_ID = 0x48, TILE_X = 0x68, TILE_Y = 0x69;
const CACHE = path.join(os.tmpdir(), 'ff3-door-probe-boot.json');
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
const DIRS = ['up', 'down', 'left', 'right'];
const DELTA = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function run(nes, n) { for (let i = 0; i < n; i++) nes.nes.frame(); }
function press(nes, b, h = 16, a = 8) { nes.nes.buttonDown(1, BTN[b]); run(nes, h); nes.nes.buttonUp(1, BTN[b]); run(nes, a); }
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
let BOOT = null;
function bootState() {
  if (BOOT) return BOOT;
  if (fs.existsSync(CACHE)) { BOOT = JSON.parse(fs.readFileSync(CACHE, 'utf8')); return BOOT; }
  const nes = new Nes(BASE_ROM, {});
  bootToField(nes);
  BOOT = nes.save();
  fs.writeFileSync(CACHE, JSON.stringify(BOOT));
  return BOOT;
}
function romWithEntrance(mapId, sx, sy) {
  const rom = Buffer.from(fs.readFileSync(BASE_ROM));
  const o = MAP_PROPS_BASE + mapId * 16;
  rom[o] = (rom[o] & 0xE0) | (sx & 0x1F);          // top 3 bits are the TILESET
  rom[o + 1] = (rom[o + 1] & 0xE0) | (sy & 0x1F);
  const p = path.join(os.tmpdir(), `ff3-flood-${mapId}-${sx}-${sy}.nes`);
  fs.writeFileSync(p, rom);
  return p;
}

/** One flood pass. `avoid` = tiles not to step on (known doors). */
function floodOnce(mapId, start, avoid) {
  const romPath = start ? romWithEntrance(mapId, start[0], start[1]) : BASE_ROM;
  const nes = new Nes(romPath, {});
  nes.load(bootState());
  try {
    if (!warp(nes, mapId)) return { error: 'warp did not take' };
    const m = nes.nes.cpu.mem;
    if (m[MAP_ID] !== mapId) return { error: `warped to ${mapId} but $48 reads ${m[MAP_ID]}` };
    const origin = [m[TILE_X], m[TILE_Y]];
    if (start && (origin[0] !== start[0] || origin[1] !== start[1])) {
      return { error: `spawned at (${origin}), wanted (${start})` };
    }
    const key = (x, y) => y * 32 + x;
    const seen = new Set([key(...origin)]);
    const hitDoor = [];
    const oneWay = [];
    // Depth-first with real backtracking: the party IS the cursor, so the walk
    // has to physically retrace instead of teleporting to the next frontier.
    const stack = [{ at: origin, tried: [] }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const dir = DIRS.find(d => !top.tried.includes(d));
      if (!dir) {
        stack.pop();
        if (stack.length) {
          const back = stack[stack.length - 1];
          const d = DIRS.find(dd => back.at[0] + DELTA[dd][0] === top.at[0] && back.at[1] + DELTA[dd][1] === top.at[1]);
          // ⛔ RETRY THE BACKTRACK. A single press is sometimes eaten mid
          // walk-animation, and the first version treated that as "lost the
          // party" and threw the whole flood away — three of four maps died
          // there and looked like map facts rather than a dropped button.
          let back_ok = false;
          for (let t = 0; t < 6 && !back_ok; t++) {
            press(nes, OPPOSITE[d]);
            back_ok = m[TILE_X] === back.at[0] && m[TILE_Y] === back.at[1];
            // ⛔ A failed backtrack means the tile we are standing on is ONE-WAY
            // (walk down onto it, cannot walk back up) — measured on map 12 at
            // (3,21). It is not a warp. Record the tile so the outer loop can
            // retry with it avoided, and keep the flood alive.
            if (!back_ok && m[MAP_ID] === mapId && m[TILE_X] === top.at[0] && m[TILE_Y] === top.at[1]) {
              oneWay.push({ at: top.at, blockedGoing: OPPOSITE[d] });
              return { seen, origin, hitDoor, oneWay, incomplete: true };
            }
          }
          if (!back_ok) return { error: `lost the party backtracking to (${back.at}) — it is at (${m[TILE_X]},${m[TILE_Y]})` };
        }
        continue;
      }
      top.tried.push(dir);
      const [dx, dy] = DELTA[dir];
      const nx = top.at[0] + dx, ny = top.at[1] + dy;
      if (nx < 0 || ny < 0 || nx > 31 || ny > 31) continue;
      if (seen.has(key(nx, ny))) continue;
      if (avoid.has(key(nx, ny))) continue;
      const bm = m[MAP_ID];
      const bx = m[TILE_X], by = m[TILE_Y];
      let moved = false;
      for (let t = 0; t < 3 && !moved; t++) {
        press(nes, dir);
        if (m[MAP_ID] !== bm) { hitDoor.push([nx, ny]); return { seen, origin, hitDoor, oneWay, incomplete: true }; }
        moved = m[TILE_X] !== bx || m[TILE_Y] !== by;
      }
      if (!moved) continue;                                    // wall
      if (m[TILE_X] !== nx || m[TILE_Y] !== ny) {
        // ⛔ THIS IS ALMOST NEVER A WARP, and calling it one cost a whole
        // release. FF3 has NO in-map warp: every one of the 69 doors measured by
        // `door-probe.cjs` lands the party on the DESTINATION MAP'S RAW ROM
        // ENTRANCE, because a door record carries a map id and nothing else.
        // What actually produces a surprising position is a one-way tile (you
        // walked down onto it and cannot walk back) or a dropped button press.
        // Report it as an anomaly with the numbers; do not name it.
        return { error: `stepped ${dir} from (${bx},${by}) aiming at (${nx},${ny}) and ended on ` +
                        `(${m[TILE_X]},${m[TILE_Y]}) — one-way tile or a dropped press, NOT an in-map warp` };
      }
      seen.add(key(nx, ny));
      stack.push({ at: [nx, ny], tried: [] });
    }
    return { seen, origin, hitDoor, oneWay, incomplete: false };
  } finally { if (start) { try { fs.unlinkSync(romPath); } catch { /* temp */ } } }
}

function flood(mapId, start) {
  const avoid = new Set();
  const doorsTouched = [];
  const oneWayFound = [];
  for (let pass = 0; pass < 40; pass++) {
    const r = floodOnce(mapId, start, avoid);
    if (r.error) return r;
    if (!r.incomplete) return { ...r, doorsTouched, oneWayFound };
    for (const [x, y] of r.hitDoor) { avoid.add(y * 32 + x); doorsTouched.push([x, y]); }
    for (const w of (r.oneWay || [])) {
      avoid.add(w.at[1] * 32 + w.at[0]);
      if (!oneWayFound.some(v => v.at[0] === w.at[0] && v.at[1] === w.at[1])) oneWayFound.push(w);
    }
  }
  return { error: 'did not converge — too many doors/warps' };
}

const mapId = parseInt(process.argv[2], 10);
if (!Number.isFinite(mapId)) { console.error('usage: reach-flood.cjs <mapId> [--at x,y]'); process.exit(1); }
const atArg = process.argv.indexOf('--at');
const start = atArg > 0 ? process.argv[atArg + 1].split(',').map(Number) : null;

const r = flood(mapId, start);
if (r.error) { console.log(`map ${mapId}: ${r.error}`); process.exit(1); }
const tiles = [...r.seen].map(k => [k % 32, (k - (k % 32)) / 32]);
console.log(`map ${mapId}: spawned (${r.origin}) — ${r.seen.size} tiles reachable BY WALKING`);
console.log(`  doors touched: ${r.doorsTouched.length ? r.doorsTouched.map(d => `(${d})`).join(' ') : 'none'}`);
console.log(`  one-way tiles: ${r.oneWayFound.length ? r.oneWayFound.map(w => `(${w.at}) cannot go ${w.blockedGoing}`).join('  ') : 'none'}`);
const minX = Math.min(...tiles.map(t => t[0])), maxX = Math.max(...tiles.map(t => t[0]));
const minY = Math.min(...tiles.map(t => t[1])), maxY = Math.max(...tiles.map(t => t[1]));
console.log(`  bounding box x ${minX}..${maxX}, y ${minY}..${maxY}`);
for (let y = minY; y <= maxY; y++) {
  let row = '  ' + String(y).padStart(2) + ' ';
  for (let x = minX; x <= maxX; x++) {
    row += r.doorsTouched.some(d => d[0] === x && d[1] === y) ? 'D'
         : (x === r.origin[0] && y === r.origin[1]) ? '@'
         : r.oneWayFound.some(w => w.at[0] === x && w.at[1] === y) ? '1'
         : r.seen.has(y * 32 + x) ? '.' : ' ';
  }
  console.log(row);
}
