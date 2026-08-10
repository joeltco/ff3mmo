// Does spell-effect CHR live in a dedicated slot range?
//
//   node spell-chr.cjs 1c            # caster vs the goblin baseline
//
// Weapons were solvable because their art decompresses into sprite slots
// $49-$60, so "a sprite whose tile is in that range holding bytes the knife
// never puts there" is an exact, measured discriminator. Spell animations have
// no such handle yet: 24-49 sprites are on screen at all times and nothing in
// OAM says which ones are the spell. This probe looks for the equivalent range.
//
// Two independent measurements, deliberately not one:
//
//   1. CROSS-RUN. Fight a monster that casts, and fight goblins, with identical
//      party and identical input. Party CHR, weapon CHR and damage digits are
//      the same in both. A slot holding bytes only the caster run ever puts
//      there is spell CHR.
//
//   2. WITHIN-RUN. Enemy monsters are drawn as BACKGROUND tiles in FF3 battle
//      (that is what tilepal.cjs reads the attribute table for), so the sprite
//      pattern table is party + weapons + digits + effects and nothing else.
//      Tile indices that appear in OAM only while the sprite count spikes are
//      the same candidates arrived at from the other direction.
//
// Sampling is per-scanline, not per-frame: MMC3 swaps CHR banks mid-screen, so
// reading the pattern table after frame() returns whatever was mapped last.

const { readFileSync, writeFileSync, mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { Nes } = require('./nes.cjs');

const REPO = '/home/joeltco/projects/ff3mmo';
const BASE_ROM = REPO + '/FF3-English.nes';
const ENCOUNTER_SET = 0x05C010;
const ENCOUNTER_MON = 0x05C410;
const ENCOUNTER_STR = 0x05CA10;
const FRAMES = parseInt(process.env.FRAMES || '2400', 10);

const baseRom = readFileSync(BASE_ROM);
const dir = mkdtempSync(join(tmpdir(), 'spellchr-'));

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
function listContaining(rom, id) {
  for (let m = 0; m < 256; m++) {
    const o = ENCOUNTER_MON + m * 6;
    for (let s = 0; s < 4; s++) if (rom[o + 2 + s] === id) return m;
  }
  return null;
}

/** Throwaway ROM where every starting-area encounter spawns exactly one `id`. */
function patchedRom(id) {
  const m = listContaining(baseRom, id);
  if (m == null) throw new Error(`$${id.toString(16)} is in no monster list`);
  const p = Buffer.from(baseRom);
  const mo = ENCOUNTER_MON + m * 6;
  p[mo + 2] = id; p[mo + 3] = 0xFF; p[mo + 4] = 0xFF; p[mo + 5] = 0xFF;
  p[ENCOUNTER_STR] = 1; p[ENCOUNTER_STR + 1] = 0; p[ENCOUNTER_STR + 2] = 0; p[ENCOUNTER_STR + 3] = 0;
  for (const g of goblinEncounters(baseRom)) {
    p[ENCOUNTER_SET + g * 2] = m;
    p[ENCOUNTER_SET + g * 2 + 1] &= 0xC0;
  }
  const path = join(dir, `m${id.toString(16)}.nes`);
  writeFileSync(path, p);
  return path;
}

const fnv = (v, o) => {
  let h = 0x811c9dc5;
  for (let k = 0; k < 16; k++) { h ^= v[o + k]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};

/**
 * Run one fight, recording every distinct byte-pattern each sprite slot holds,
 * and the OAM tile indices live on each frame.
 */
function probe(id, label) {
  const n = new Nes(patchedRom(id));
  const ppu = n.nes.ppu;

  // slot -> Map(contentHash -> first frame seen). Empty tiles are skipped: an
  // all-zero slot is "nothing loaded here", not a distinct piece of art.
  const slots = Array.from({ length: 256 }, () => new Map());
  const frames = [];
  let frameNo = 0, sampling = false;

  const origEnd = ppu.endScanline.bind(ppu);
  ppu.endScanline = () => {
    origEnd();
    if (!sampling || ppu.scanline % 8 !== 0) return;
    const base = ppu.f_spPatternTable ? 0x1000 : 0x0000;
    const v = n.vram;
    for (let t = 0; t < 256; t++) {
      const o = base + t * 16;
      let empty = true;
      for (let k = 0; k < 16; k++) if (v[o + k]) { empty = false; break; }
      if (empty) continue;
      const h = fnv(v, o);
      if (!slots[t].has(h)) slots[t].set(h, frameNo);
    }
  };

  // Boot past the intro, then the fight loop weapon-extract uses.
  n.run(300);
  for (let i = 0; i < 25; i++) n.press('start', 6, 45);
  for (let b = 0; b < 10; b++) {
    for (let k = 0; k < 6; k++) n.press('a', 8, 25);
    n.press('down', 8, 40);
  }

  sampling = true;
  for (let f = 0; f < FRAMES; f++) {
    frameNo = f;
    n.run(1);
    if (f % 3 === 0) n.press('a', 2, 2);
    const tiles = [];
    for (let i = 0; i < 64; i++) if (ppu.sprY[i] < 0xEF) tiles.push(ppu.sprTile[i]);
    frames.push({ f, n: tiles.length, tiles: [...new Set(tiles)] });
  }
  ppu.endScanline = origEnd;

  const used = new Set();
  for (const fr of frames) for (const t of fr.tiles) used.add(t);
  console.error(`${label} $${id.toString(16)}: ${frames.length} frames, ` +
    `${[...slots.entries()].filter(([, m]) => m.size).length} slots ever loaded, ` +
    `${used.size} distinct tile indices in OAM`);
  return { id, slots: slots.map((m) => [...m.entries()]), frames };
}

const TARGET = parseInt(process.argv[2] || '1c', 16);
const caster = probe(TARGET, 'caster ');
const basel = probe(0x00, 'baseline');

// ── 1. cross-run CHR provenance ────────────────────────────────────
const own = [];
for (let t = 0; t < 256; t++) {
  const b = new Set(basel.slots[t].map(([h]) => h));
  const extra = caster.slots[t].filter(([h]) => !b.has(h));
  if (extra.length) own.push({ t, extra: extra.length, total: caster.slots[t].length, first: Math.min(...extra.map(([, f]) => f)) });
}

// ── 2. within-run OAM occupancy ────────────────────────────────────
const counts = caster.frames.map((f) => f.n).sort((a, b) => a - b);
const median = counts[counts.length >> 1];
const quiet = new Set(), busy = new Set();
for (const fr of caster.frames) for (const t of fr.tiles) (fr.n > median + 3 ? busy : quiet).add(t);
const burstOnly = [...busy].filter((t) => !quiet.has(t)).sort((a, b) => a - b);

const runs = (xs) => {
  const out = [];
  for (const x of xs) {
    const last = out[out.length - 1];
    if (last && x === last[1] + 1) last[1] = x; else out.push([x, x]);
  }
  return out.map(([a, b]) => (a === b ? `$${a.toString(16)}` : `$${a.toString(16)}-$${b.toString(16)}`));
};

console.log(`\nmedian sprite count ${median}; ${caster.frames.filter((f) => f.n > median + 3).length} burst frames`);
console.log(`\n[1] slots holding CHR the goblin run never loads (${own.length}):`);
console.log('    ' + (runs(own.map((o) => o.t)).join(' ') || '(none)'));
for (const o of own.slice(0, 40)) console.log(`      $${o.t.toString(16).padStart(2, '0')}  ${o.extra} caster-only pattern(s) of ${o.total}, first at frame ${o.first}`);
console.log(`\n[2] tile indices in OAM only during sprite-count bursts (${burstOnly.length}):`);
console.log('    ' + (runs(burstOnly).join(' ') || '(none)'));

const both = own.map((o) => o.t).filter((t) => burstOnly.includes(t)).sort((a, b) => a - b);
console.log(`\n[3] BOTH measurements agree on (${both.length}):`);
console.log('    ' + (runs(both).join(' ') || '(none)'));

writeFileSync(__dirname + '/spell-chr.json', JSON.stringify({ target: TARGET, own, burstOnly, both, median }));
console.log('\n-> spell-chr.json');
