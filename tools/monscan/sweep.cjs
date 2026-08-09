// SUPERSEDED — use tilepal.cjs. Kept for the drive logic and history only.
//
// captureByPalette() here PREFERS a window using both palettes, on the theory
// that a real monster uses both of its. For a single-palette monster standing
// beside one that uses the other palette, that preference deliberately selects a
// window straddling the two and invents a 50/50 split belonging to neither. It
// reported exactly the buggy rows<2 default for CursdCopper and Larva, so
// consulting it CONFIRMED the bug it should have caught (see v1.7.812).
//
// Capture every monster's real battle palettes + per-tile palette layout.
//
// The trick that makes this possible: FF3 picks encounters out of a 6-byte
// formation record ($2E:$8400 + idx*6 = pal0, pal1, four monster ids). Copy any
// formation's record over the one the starting-area encounter uses, and that
// encounter spawns those monsters with their own palettes. No RAM poking, no
// 6502 tracing — one 6-byte ROM edit per monster.
//
// Each worker boots its own patched ROM, drives the intro, walks into the
// encounter, then locates the monster by matching its ROM tile bytes against
// the PPU and reads the attribute table for the per-tile palette split.
//
//   node sweep.cjs               # all monsters, all cores
//   node sweep.cjs 0x00 0x08     # just these
//   SWEEP_WORKERS=4 node sweep.cjs

const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { execFileSync } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');

const REPO = '/home/joeltco/projects/ff3mmo';
const BASE_ROM = REPO + '/FF3-English.nes';
const OUT = __dirname + '/monster-palettes.json';

// An encounter is TWO lookups, not one (per tools/gen-encounters-js.js):
//   ENCOUNTER_SET[e] = [monListIdx, flags]   flags & 0x3F = structIdx
//   ENCOUNTER_MON[m] = [pal0, pal1, id x4]
//   ENCOUNTER_STR[s] = 4 bytes of per-group min/max counts
//
// The first sweep copied only the monster list and kept the goblin encounter's
// structure. That structure spawns group 0 and zero of everything else, so any
// donor monster living in group 1-3 was spawned zero times — which is exactly
// the 149 "not found on screen" misses. Repointing the SET entry at the donor's
// own list AND structure makes the game build the fight natively.
const ENCOUNTER_SET = 0x05C010;
const ENCOUNTER_MON = 0x05C410;
const ENCOUNTER_STR = 0x05CA10;
const SET_OFF = ENCOUNTER_MON;   // kept: readFormations still walks the mon list

// ── shared: formation table ────────────────────────────────────────
function readFormations(rom) {
  const out = [];
  for (let i = 0; i < 256; i++) {
    const o = SET_OFF + i * 6;
    out.push({
      idx: i, pal0: rom[o], pal1: rom[o + 1],
      ids: [rom[o + 2], rom[o + 3], rom[o + 4], rom[o + 5]].filter((v) => v !== 0xFF),
    });
  }
  return out;
}

/** Encounter indices whose monster list is goblins-only — what the starting
 *  area rolls, and therefore the entries we repoint. */
function goblinEncounters(rom) {
  const out = [];
  for (let e = 0; e < 256; e++) {
    const m = rom[ENCOUNTER_SET + e * 2];
    const o = ENCOUNTER_MON + m * 6;
    const ids = [rom[o + 2], rom[o + 3], rom[o + 4], rom[o + 5]].filter((v) => v !== 0xFF);
    if (ids.length && ids.every((id) => id === 0x00)) out.push(e);
  }
  return out;
}

/** Best donor ENCOUNTER for a monster. Prefer a non-boss encounter where it's
 *  the only species and its group actually spawns (max count > 0) — otherwise
 *  the structure can silently spawn none of it. */
function donorEncounterFor(rom, id) {
  let fallback = null;
  for (let e = 0; e < 256; e++) {
    const m = rom[ENCOUNTER_SET + e * 2];
    const flags = rom[ENCOUNTER_SET + e * 2 + 1];
    const s = flags & 0x3F;
    const mo = ENCOUNTER_MON + m * 6;
    const ids = [rom[mo + 2], rom[mo + 3], rom[mo + 4], rom[mo + 5]];
    const spawns = [];
    for (let g = 0; g < 4; g++) {
      const b = rom[ENCOUNTER_STR + s * 4 + g];
      if ((b & 0xF) > 0 && ids[g] !== 0xFF) spawns.push(ids[g]);
    }
    if (!spawns.includes(id)) continue;
    if (spawns.every((x) => x === id)) return { e, m, flags, monList: m };
    fallback = fallback || { e, m, flags, monList: m };
  }
  return fallback;
}

// ── worker ─────────────────────────────────────────────────────────
if (!isMainThread) {
  const { Nes } = require('./nes.cjs');
  const { catalogEntry, capture, captureByPalette } = require('./capture.cjs');
  const baseRom = readFileSync(BASE_ROM);
  const gob = goblinEncounters(baseRom);
  const dir = mkdtempSync(join(tmpdir(), 'monscan-'));

  /** One capture attempt, rejected unless it holds still.
   *
   *  Probing mid-fight means landing on a hit-flash or a fade frame is a real
   *  possibility, and either one yields a correct-looking grid with the wrong
   *  colors. Requiring the geometry AND the palette RAM to be byte-identical 15
   *  frames apart throws those away; a settled battle screen passes on the
   *  first try. */
  function probe(n, want) {
    const a = captureByPalette(n, want);
    if (!a) return null;
    const palA = n.palette().join(',');
    n.run(15);
    const b = captureByPalette(n, want);
    if (!b || b.col !== a.col || b.row !== a.row) return null;
    if (JSON.stringify(a.tilePal) !== JSON.stringify(b.tilePal)) return null;
    if (n.palette().join(',') !== palA) return null;
    return b;
  }

  /** Drive the intro into a fight, capturing the moment the monster is drawn.
   *
   *  Capturing only AFTER the whole input drive costs the four monsters strong
   *  enough to wipe a level-1 party: their fight runs frames ~2757-3990 and the
   *  old poll loop didn't start until 4335, by which point the party is dead and
   *  the game is back on the title screen. The fight is on screen throughout the
   *  walk phase, so probe between presses and stop as soon as it's captured.
   *  The post-drive poll stays as a fallback for anything that appears late. */
  function driveAndCapture(n, want) {
    n.run(300);
    // Title/menu screens also use BG palettes 0 and 1, so probing before the
    // party is walking around would happily "capture" the New Game box.
    for (let i = 0; i < 25; i++) n.press('start', 6, 45);

    let res = null;
    for (let b = 0; b < 10 && !res; b++) {
      for (let k = 0; k < 6 && !res; k++) { n.press('a', 8, 25); res = probe(n, want); }
      if (!res) { n.press('down', 8, 40); res = probe(n, want); }
    }
    if (res) return res;

    // Don't guess when the battle is drawn — poll for it.
    //
    // The first sweep captured at a fixed 900 frames and got 46/195: fine for
    // small monsters, near-total failure for big ones, because a larger sprite
    // takes longer to reach the screen and the encounter itself doesn't start
    // on a fixed frame. Stepping until the monster's own tiles show up removes
    // the guess entirely, and costs nothing when it appears early.
    // Locate by palette, not by artwork. Tile-byte matching only ever found
    // 46/195 because the catalog's stored sprites don't match what the game
    // draws for the rest; the monster's own BG palettes are unambiguous.
    n.run(300);
    for (let tries = 0; tries < 60 && !res; tries++) {
      res = probe(n, want);
      if (!res) n.run(30);
    }
    return res;
  }

  for (const id of workerData.ids) {
    const result = { id, ok: false };
    try {
      const entry = catalogEntry(id);
      const donor = donorEncounterFor(baseRom, id);
      if (!entry) { result.reason = 'no catalog entry'; parentPort.postMessage(result); continue; }
      if (!donor) { result.reason = 'no encounter spawns it'; parentPort.postMessage(result); continue; }

      // Repoint every goblin encounter at the donor's list AND structure.
      const patched = Buffer.from(baseRom);
      for (const g of gob) {
        patched[ENCOUNTER_SET + g * 2] = donor.m;
        patched[ENCOUNTER_SET + g * 2 + 1] = donor.flags;
      }
      const mo = ENCOUNTER_MON + donor.m * 6;
      result.pal0Src = baseRom[mo]; result.pal1Src = baseRom[mo + 1];
      const romPath = join(dir, `m${id}.nes`);
      writeFileSync(romPath, patched);

      const n = new Nes(romPath);
      const res = driveAndCapture(n, { cols: entry.cols, rows: entry.rows });
      rmSync(romPath, { force: true });
      if (!res) { result.reason = 'monster not found on screen'; parentPort.postMessage(result); continue; }

      const pal = n.palette();
      Object.assign(result, {
        ok: true,
        encounter: donor.e, monList: donor.m,
        pal0Idx: result.pal0Src, pal1Idx: result.pal1Src,
        bg: [0, 1, 2, 3].map((p) => pal.slice(p * 4, p * 4 + 4)),
        tilePal: res.tilePal,
        cols: res.cols, rows: res.rows,
        // captureByPalette returns col/row, not an `origin` object — reading
        // res.origin wrote undefined into every entry, and without the screen
        // position a capture can't be validated: attribute quadrants align to
        // the screen, so a window starting on an odd column splits its 2x2
        // blocks legitimately.
        origin: { col: res.col, row: res.row },
      });
    } catch (e) {
      result.reason = (e && e.message) || String(e);
    }
    parentPort.postMessage(result);
  }
  rmSync(dir, { recursive: true, force: true });
  parentPort.postMessage({ done: true });
  return;
}

// ── main ───────────────────────────────────────────────────────────
// Only the full run talks to Joel. A partial/test run (node sweep.cjs 6E 7A)
// stays silent — pushing "4 monsters, 4 workers" from a debug run reads on his
// phone exactly like real progress, which is worse than saying nothing.
// Everything that does go out is prefixed so an unprompted push is
// distinguishable from a reply to something he asked.
const FULL_RUN = process.argv.slice(2).length === 0;
function notify(msg) {
  if (!FULL_RUN) return;
  try { execFileSync('/home/joeltco/bin/vira-notify', ['[monscan] ' + msg], { timeout: 120000 }); }
  catch { /* never fatal */ }
}

const src = readFileSync(REPO + '/src/data/monster-sprites-rom.js', 'utf8');
const regBlock = src.slice(src.indexOf('MONSTER_REGISTRY'));
const allIds = [...regBlock.matchAll(/\[0x([0-9a-fA-F]{2}),\s*\{/g)].map((m) => parseInt(m[1], 16));

const argIds = process.argv.slice(2).map((s) => parseInt(s, 16)).filter((n) => !isNaN(n));
const ids = argIds.length ? argIds : allIds;

const WORKERS = Math.max(1, Math.min(parseInt(process.env.SWEEP_WORKERS || '0', 10)
                                     || Math.max(1, os.cpus().length - 2), ids.length));
const chunks = Array.from({ length: WORKERS }, () => []);
ids.forEach((id, i) => chunks[i % WORKERS].push(id));

console.log(`sweeping ${ids.length} monsters across ${WORKERS} workers`);
notify(`Monster sweep started: ${ids.length} monsters, ${WORKERS} workers.`);

// Merge into whatever's already captured. A partial run (say, retrying three
// monsters) previously overwrote the whole file and threw away 46 good
// captures — results are expensive, a stale entry is not.
let results = {};
try { results = JSON.parse(readFileSync(OUT, 'utf8')); } catch { /* first run */ }

let finished = 0, live = WORKERS, lastPing = Date.now();
const started = Date.now();

for (const chunk of chunks) {
  const w = new Worker(__filename, { workerData: { ids: chunk } });
  w.on('message', (m) => {
    if (m.done) { if (--live === 0) finish(); return; }
    results[m.id] = m;
    finished++;
    const tag = m.ok ? 'ok' : 'MISS(' + m.reason + ')';
    console.log(`[${finished}/${ids.length}] 0x${m.id.toString(16).padStart(2, '0')} ${tag}`);
    writeFileSync(OUT, JSON.stringify(results, null, 1));
    if (Date.now() - lastPing > 15 * 60 * 1000) {
      lastPing = Date.now();
      const good = Object.values(results).filter((r) => r.ok).length;
      notify(`Sweep progress: ${finished}/${ids.length} done, ${good} captured.`);
    }
  });
  w.on('error', (e) => { console.log('worker error:', e.message); if (--live === 0) finish(); });
}

function finish() {
  const good = Object.values(results).filter((r) => r.ok);
  const mins = Math.round((Date.now() - started) / 60000);
  writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log(`\ndone in ${mins}m — ${good.length}/${ids.length} captured -> ${OUT}`);
  notify(`Monster sweep finished: ${good.length} of ${ids.length} captured in ${mins} minutes.`);
}
