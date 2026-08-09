// Capture a monster's REAL tile bytes off the PPU.
//
//   node art.cjs 68 75 46 ...      # capture these ids -> art.json
//
// Every 18x12 entry in MONSTER_REGISTRY decodes to noise: the extractor read
// contiguous ROM at an offset, but ROM bytes are not PPU bytes — MMC3 swaps CHR
// banks mid-frame, which is exactly what CLAUDE.md warns about. So read what the
// PPU actually draws instead: spawn one monster, take the nametable tile id for
// each cell of its box, and resolve that id against the CHR bank that was mapped
// on the scanline the cell is drawn on.
//
// Sharing matters here. Several monsters reference the same RAW constant (FF3
// reuses artwork across recolors — C6_G9_RAW backs 0x35, 0x68 and 0x75), so
// capturing from any spawnable member fixes the whole group, including members
// that no encounter can spawn. Capture more than one member and compare: if the
// bytes match, the sharing in the registry is real.

const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');

const REPO = '/home/joeltco/projects/ff3mmo';
const BASE_ROM = REPO + '/FF3-English.nes';
const OUT = __dirname + '/art.json';
const ENCOUNTER_SET = 0x05C010, ENCOUNTER_MON = 0x05C410, ENCOUNTER_STR = 0x05CA10;

function goblinEncounters(rom) {
  const out = [];
  for (let e = 0; e < 256; e++) {
    const m = rom[ENCOUNTER_SET + e * 2], o = ENCOUNTER_MON + m * 6;
    const ids = [rom[o + 2], rom[o + 3], rom[o + 4], rom[o + 5]].filter((v) => v !== 0xFF);
    if (ids.length && ids.every((id) => id === 0x00)) out.push(e);
  }
  return out;
}
function listContaining(rom, id) {
  for (let m = 0; m < 256; m++) {
    const o = ENCOUNTER_MON + m * 6;
    for (let s = 0; s < 4; s++) if (rom[o + 2 + s] === id) return { m, pal0: rom[o], pal1: rom[o + 1] };
  }
  return null;
}

if (!isMainThread) {
  const { Nes } = require('./nes.cjs');
  const baseRom = readFileSync(BASE_ROM);
  const gob = goblinEncounters(baseRom);
  const dir = mkdtempSync(join(tmpdir(), 'art-'));

  for (const id of workerData.ids) {
    const result = { id, ok: false };
    try {
      const src = listContaining(baseRom, id);
      if (!src) { result.reason = 'in no monster list'; parentPort.postMessage(result); continue; }
      const patched = Buffer.from(baseRom);
      const mo = ENCOUNTER_MON + src.m * 6;
      patched[mo + 2] = id; patched[mo + 3] = 0xFF; patched[mo + 4] = 0xFF; patched[mo + 5] = 0xFF;
      patched[ENCOUNTER_STR] = 1;
      patched[ENCOUNTER_STR + 1] = 0; patched[ENCOUNTER_STR + 2] = 0; patched[ENCOUNTER_STR + 3] = 0;
      for (const g of gob) {
        patched[ENCOUNTER_SET + g * 2] = src.m;
        patched[ENCOUNTER_SET + g * 2 + 1] &= 0xC0;
      }
      const romPath = join(dir, `m${id}.nes`);
      writeFileSync(romPath, patched);

      const n = new Nes(romPath);
      n.run(300);
      for (let i = 0; i < 25; i++) n.press('start', 6, 45);

      const box = () => {
        let minC = 32, maxC = -1, minR = 30, maxR = -1;
        for (let r = 0; r < 30; r++) for (let c = 0; c < 32; c++) {
          const p = n.paletteAt(c, r);
          if (p !== 0 && p !== 1) continue;
          if (c < minC) minC = c; if (c > maxC) maxC = c;
          if (r < minR) minR = r; if (r > maxR) maxR = r;
        }
        if (maxC < 0) return null;
        const cols = maxC - minC + 1, rows = maxR - minR + 1;
        return (cols <= 18 && rows <= 12) ? { col: minC, row: minR, cols, rows } : null;
      };
      let b = null;
      for (let blk = 0; blk < 10 && !b; blk++) {
        for (let k = 0; k < 6 && !b; k++) { n.press('a', 8, 25); b = box(); }
        if (!b) { n.press('down', 8, 40); b = box(); }
      }
      if (!b) { n.run(300); for (let t = 0; t < 60 && !b; t++) { b = box(); if (!b) n.run(30); } }
      if (!b) { result.reason = 'monster not found on screen'; parentPort.postMessage(result); continue; }

      // One frame, snapshotting the pattern table at every scanline, so each
      // row of cells can be resolved against the bank live when it was drawn.
      const ppu = n.nes.ppu;
      const banks = new Map();
      const orig = ppu.endScanline.bind(ppu);
      ppu.endScanline = () => { orig(); banks.set(ppu.scanline, Buffer.from(n.vram.slice(0, 0x2000))); };
      try { n.nes.frame(); } finally { ppu.endScanline = orig; }
      const nt = n.nametable();

      const bytes = [];
      const tileIds = [];
      for (let r = 0; r < b.rows; r++) {
        const scan = (b.row + r) * 8 + 4;
        let bank = null;
        for (let s = scan; s < scan + 24 && !bank; s++) bank = banks.get(s) || null;
        if (!bank) bank = banks.values().next().value;
        for (let c = 0; c < b.cols; c++) {
          const tile = nt[(b.row + r) * 32 + (b.col + c)];
          tileIds.push(tile);
          for (let i = 0; i < 16; i++) bytes.push(bank[tile * 16 + i]);
        }
      }
      rmSync(romPath, { force: true });
      Object.assign(result, { ok: true, cols: b.cols, rows: b.rows, tileIds, bytes });
    } catch (e) {
      result.reason = (e && e.message) || String(e);
    }
    parentPort.postMessage(result);
  }
  rmSync(dir, { recursive: true, force: true });
  parentPort.postMessage({ done: true });
  return;
}

const ids = process.argv.slice(2).map((s) => parseInt(s, 16)).filter((n) => !isNaN(n));
if (!ids.length) { console.log('usage: node art.cjs <hex id> ...'); process.exit(1); }
const WORKERS = Math.max(1, Math.min(Math.max(1, os.cpus().length - 2), ids.length));
const chunks = Array.from({ length: WORKERS }, () => []);
ids.forEach((id, i) => chunks[i % WORKERS].push(id));
console.log(`art: ${ids.length} monsters across ${WORKERS} workers`);

const results = {};
let done = 0, live = WORKERS;
for (const chunk of chunks) {
  const w = new Worker(__filename, { workerData: { ids: chunk } });
  w.on('message', (m) => {
    if (m.done) { if (--live === 0) finish(); return; }
    results[m.id] = m;
    done++;
    console.log(`[${done}/${ids.length}] 0x${m.id.toString(16).padStart(2, '0')} ` +
      (m.ok ? `${m.cols}x${m.rows} ${m.bytes.length}B` : `MISS(${m.reason})`));
    if (done === ids.length) writeFileSync(OUT, JSON.stringify(results));
  });
  w.on('error', (e) => { console.log('worker error:', e.message); if (--live === 0) finish(); });
}
function finish() {
  writeFileSync(OUT, JSON.stringify(results));
  console.log(`\n${Object.values(results).filter((r) => r.ok).length}/${ids.length} captured -> ${OUT}`);
}
