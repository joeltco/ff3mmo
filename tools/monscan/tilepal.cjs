// Read a monster's REAL per-tile palette split by putting exactly one of it on
// screen, then reading the attribute table under it.
//
//   node tilepal.cjs 10 0c 0d          # specific ids
//   node tilepal.cjs                   # every id in MONSTER_REGISTRY
//
// Why not sweep.cjs's captureByPalette: that slides a monster-sized window over
// the whole palette-0/1 region and PREFERS a window covering both palettes, on
// the theory that a real monster uses both. When a single-palette monster
// stands next to one using the other palette, that preference picks a window
// straddling the two and invents a 50/50 split belonging to neither. It
// reported 0000000011111111 for CursdCopper (really all pal0) and Larva (really
// all pal1) — identical to the buggy default those two were already rendering
// with, so it confirmed the bug instead of catching it.
//
// The fix is to remove the ambiguity rather than guess around it: we control
// the ROM, so rewrite the donor's monster list to `[id, FF, FF, FF]` and its
// structure to spawn ONE of group 0. FF3 paints the monster with BG palettes 0
// and 1 and everything else with 2 and 3, so with a single monster on screen
// every 0/1 cell is that monster and the split needs no inference at all.

const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');

const REPO = '/home/joeltco/projects/ff3mmo';
const BASE_ROM = REPO + '/FF3-English.nes';
const OUT = __dirname + '/tilepal.json';

const ENCOUNTER_SET = 0x05C010;
const ENCOUNTER_MON = 0x05C410;
const ENCOUNTER_STR = 0x05CA10;

/** Encounters whose list is goblins-only — what the starting area rolls. */
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

/**
 * Any monster list containing `id`, for its authentic pal0/pal1 bytes.
 *
 * Unlike sweep.cjs this does NOT require the list's structure to actually spawn
 * the monster — we overwrite the structure anyway. That is what makes the 39
 * "no encounter spawns it" monsters reachable: they still sit in a list, with
 * the palette pair the game would have used.
 */
function listContaining(rom, id) {
  for (let m = 0; m < 256; m++) {
    const o = ENCOUNTER_MON + m * 6;
    for (let slot = 0; slot < 4; slot++) {
      if (rom[o + 2 + slot] === id) return { m, pal0: rom[o], pal1: rom[o + 1], slot };
    }
  }
  return null;
}

/** Bounding box of every cell using BG palette 0 or 1, plus the split inside it. */
function readMonster(n) {
  let minC = 32, maxC = -1, minR = 30, maxR = -1;
  for (let r = 0; r < 30; r++) {
    for (let c = 0; c < 32; c++) {
      const p = n.paletteAt(c, r);
      if (p !== 0 && p !== 1) continue;
      if (c < minC) minC = c; if (c > maxC) maxC = c;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
    }
  }
  if (maxC < 0) return null;
  const cols = maxC - minC + 1, rows = maxR - minR + 1;
  const tilePal = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) tilePal.push(n.paletteAt(minC + c, minR + r));
  return { col: minC, row: minR, cols, rows, tilePal };
}

// ── worker ─────────────────────────────────────────────────────────
if (!isMainThread) {
  const { Nes } = require('./nes.cjs');
  const { catalogEntry } = require('./capture.cjs');
  const baseRom = readFileSync(BASE_ROM);
  const gob = goblinEncounters(baseRom);
  const dir = mkdtempSync(join(tmpdir(), 'tilepal-'));

  for (const id of workerData.ids) {
    const result = { id, ok: false };
    try {
      const entry = catalogEntry(id);
      const src = listContaining(baseRom, id);
      if (!entry) { result.reason = 'no catalog entry'; parentPort.postMessage(result); continue; }
      if (!src) { result.reason = 'in no monster list'; parentPort.postMessage(result); continue; }

      const patched = Buffer.from(baseRom);
      const mo = ENCOUNTER_MON + src.m * 6;
      // Keep bytes 0-1 (the palette pair); make the target the only species.
      patched[mo + 2] = id;
      patched[mo + 3] = 0xFF; patched[mo + 4] = 0xFF; patched[mo + 5] = 0xFF;
      // Struct 0 spawns one of group 0 and none of the rest.
      patched[ENCOUNTER_STR + 0] = 1;
      patched[ENCOUNTER_STR + 1] = 0;
      patched[ENCOUNTER_STR + 2] = 0;
      patched[ENCOUNTER_STR + 3] = 0;
      for (const g of gob) {
        patched[ENCOUNTER_SET + g * 2] = src.m;
        patched[ENCOUNTER_SET + g * 2 + 1] &= 0xC0;   // structIdx 0, keep the upper flag bits
      }
      const romPath = join(dir, `m${id}.nes`);
      writeFileSync(romPath, patched);

      const n = new Nes(romPath);
      n.run(300);
      for (let i = 0; i < 25; i++) n.press('start', 6, 45);

      // Probe during the walk phase — monsters strong enough to wipe a level-1
      // party end their own fight before a post-drive poll would start.
      let res = null;
      // Bound the box to monster proportions. The title and name-entry screens
      // also paint with BG palettes 0/1, so an unconstrained read locks onto the
      // first static menu it sees — all six validation monsters first came back
      // as the same 16x30 name grid. Demanding an EXACT match to the catalog's
      // cols/rows overcorrects: a monster's drawn footprint does not always
      // equal its stored sprite dimensions, and that rejected 5 of 6. The
      // largest registry sprite is 18x12, so anything within that is plausibly a
      // monster and anything taller is a menu. `sizeMatch` in the output records
      // whether it agreed with the catalog instead of gating on it.
      const fits = (b) => b && b.cols <= 18 && b.rows <= 12;
      const settled = () => {
        const a = readMonster(n);
        if (!fits(a)) return null;
        const palA = n.palette().join(',');
        n.run(15);
        const b = readMonster(n);
        if (!fits(b) || b.col !== a.col || b.row !== a.row) return null;
        if (JSON.stringify(a.tilePal) !== JSON.stringify(b.tilePal)) return null;
        if (n.palette().join(',') !== palA) return null;
        return b;
      };
      for (let blk = 0; blk < 10 && !res; blk++) {
        for (let k = 0; k < 6 && !res; k++) { n.press('a', 8, 25); res = settled(); }
        if (!res) { n.press('down', 8, 40); res = settled(); }
      }
      if (!res) { n.run(300); for (let t = 0; t < 60 && !res; t++) { res = settled(); if (!res) n.run(30); } }
      rmSync(romPath, { force: true });
      if (!res) { result.reason = 'monster not found on screen'; parentPort.postMessage(result); continue; }

      const pal = n.palette();
      Object.assign(result, {
        ok: true,
        monList: src.m,
        pal0Idx: src.pal0, pal1Idx: src.pal1,
        bg: [0, 1, 2, 3].map((p) => pal.slice(p * 4, p * 4 + 4)),
        cols: res.cols, rows: res.rows,
        expectCols: entry.cols, expectRows: entry.rows,
        sizeMatch: res.cols === entry.cols && res.rows === entry.rows,
        tilePal: res.tilePal,
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
const src = readFileSync(REPO + '/src/data/monster-sprites-rom.js', 'utf8');
const regBlock = src.slice(src.indexOf('MONSTER_REGISTRY'));
const allIds = [...regBlock.matchAll(/\[0x([0-9a-fA-F]{2}),\s*\{/g)].map((m) => parseInt(m[1], 16));
const argIds = process.argv.slice(2).map((s) => parseInt(s, 16)).filter((n) => !isNaN(n));
const ids = argIds.length ? argIds : allIds;

const WORKERS = Math.max(1, Math.min(parseInt(process.env.SWEEP_WORKERS || '0', 10)
                                     || Math.max(1, os.cpus().length - 2), ids.length));
const chunks = Array.from({ length: WORKERS }, () => []);
ids.forEach((id, i) => chunks[i % WORKERS].push(id));
console.log(`tilepal: ${ids.length} monsters across ${WORKERS} workers`);

const results = {};
let finished = 0, live = WORKERS;
for (const chunk of chunks) {
  const w = new Worker(__filename, { workerData: { ids: chunk } });
  w.on('message', (m) => {
    if (m.done) { if (--live === 0) finish(); return; }
    results[m.id] = m;
    finished++;
    const tag = m.ok
      ? `${m.cols}x${m.rows}${m.sizeMatch ? '' : ` (WANT ${m.expectCols}x${m.expectRows})`} ${m.tilePal.join('')}`
      : `MISS(${m.reason})`;
    console.log(`[${finished}/${ids.length}] 0x${m.id.toString(16).padStart(2, '0')} ${tag}`);
    writeFileSync(OUT, JSON.stringify(results, null, 1));
  });
  w.on('error', (e) => { console.log('worker error:', e.message); if (--live === 0) finish(); });
}
function finish() {
  const ok = Object.values(results).filter((r) => r.ok);
  writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log(`\n${ok.length}/${ids.length} captured, ${ok.filter((r) => r.sizeMatch).length} size-matched -> ${OUT}`);
}
