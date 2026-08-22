#!/usr/bin/env node
// zone-balance.mjs — can a party actually survive a zone's encounters?
//
//   node tools/zone-balance.mjs --zones=seals_cave_f1,seals_cave_f2,seals_cave_f3
//   node tools/zone-balance.mjs --zones=altar_cave_f1 --parties=KN5,KN8+WM6
//   node tools/zone-balance.mjs --seals            # the Cave of Seals, vs Altar Cave
//
// The gates prove a dungeon generates, connects, paints and rolls the
// cartridge's monsters. None of them ask whether it is FAIR. This does, by
// driving `tools/battle-sim.js` — the same math the game runs — over the
// formations a zone can actually produce.
//
// ⛔ IT SPAWNS THE WAY THE GAME SPAWNS. Each formation is expanded group by
// group with a per-group count rolled in [min,max] and a HARD STOP AT FOUR
// BODIES, exactly as `startRandomEncounter` does. Without the cap, "Skeleton x1
// + Mummy x3-5" reads as six monsters and the answer comes out far too grim.
//
// ⛔ Formations are weighted by the ROM's slot odds, so a 1-in-64 nightmare
// does not drag a zone's headline number down as if it were a coin flip. Both
// numbers are printed: the weighted average, and the worst single formation.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENCOUNTERS } from '../src/data/encounters.js';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.join(HERE, 'battle-sim.js');
const args = process.argv.slice(2);
const flag = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const RUNS = Number(flag('runs', '60'));
const TURNS = Number(flag('turns', '30'));
const SAMPLES = Number(flag('samples', '6'));   // count-rolls sampled per formation

const PARTIES = flag('parties', 'KN5,KN5+WM4,KN8+WM6,KN8+WM6+BM6,KN12+WM10+BM10')
  .split(',').map((s) => s.split('+').join(','));

let ZONES = flag('zones', '').split(',').filter(Boolean);
if (args.includes('--seals')) ZONES = ['altar_cave_f4', 'seals_cave_f1', 'seals_cave_f2', 'seals_cave_f3'];
if (!ZONES.length) { console.error('usage: --zones=a,b,c  |  --seals'); process.exit(2); }

const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM || path.join(HERE, '..', 'FF3-English.nes')));
const { initTextDecoder, getMonsterName } = await import('../src/text-decoder.js');
initTextDecoder(rom);
const hx2 = (id) => `0x${id.toString(16).padStart(2, '0')}`;
/** FF3's glyph codes -> ASCII, same mapping the other ROM tools use. */
function nesText(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xCA && b <= 0xE3) s += String.fromCharCode(b - 0xCA + 97);
    else if (b >= 0x8A && b <= 0xA3) s += String.fromCharCode(b - 0x8A + 65);
    else if (b >= 0x80 && b <= 0x89) s += String.fromCharCode(b - 0x80 + 48);
    else if (b === 0xFF) s += ' ';
  }
  return s.trim();
}
const mname = (id) => { try { return nesText(getMonsterName(id)) || hx2(id); } catch { return hx2(id); } };
/** `0x0a*3` -> `Mummy x3`, so the worst-case column reads as monsters. */
const readSpec = (spec) => spec.split(',').map((p) => {
  const [h, n] = p.split('*');
  return `${mname(Number(h))}${n ? ` x${n}` : ''}`;
}).join(' + ');

/** Expand a formation the way startRandomEncounter does, cap included. */
function spawn(formation, rnd) {
  const out = [];
  for (const g of formation) {
    const count = g.min + Math.floor(rnd() * (g.max - g.min + 1));
    for (let i = 0; i < count; i++) { if (out.length >= 4) break; out.push(g.id); }
    if (out.length >= 4) break;
  }
  return out;
}

/** `--enemies=` spec for a body list, collapsing runs into *N. */
function enemySpec(ids) {
  const parts = [];
  for (const id of ids) {
    const last = parts[parts.length - 1];
    if (last && last.id === id) last.n++;
    else parts.push({ id, n: 1 });
  }
  return parts.map((p) => `0x${p.id.toString(16).padStart(2, '0')}${p.n > 1 ? `*${p.n}` : ''}`).join(',');
}

function sim(party, enemies) {
  const out = execFileSync(process.execPath,
    [SIM, `--party=${party}`, `--enemies=${enemies}`, `--runs=${RUNS}`, `--turns=${TURNS}`, '--json'],
    { encoding: 'utf8', maxBuffer: 1 << 24 });
  return JSON.parse(out);
}

// mulberry32 — the sim's own, so a run is reproducible
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bar = (p) => '█'.repeat(Math.round(p * 24)).padEnd(24, '·');

for (const key of ZONES) {
  const zone = ENCOUNTERS.get(key);
  if (!zone) { console.log(`\n${key}: NOT A ZONE`); continue; }
  const total = zone.weights.reduce((a, b) => a + b, 0);
  console.log(`\n═══ ${key} — rate ${zone.rate}/256 (~1 per ${Math.round(256 / zone.rate)} steps) ═══`);

  for (const party of PARTIES) {
    let weighted = 0, worst = { p: 2, label: '' };
    const rows = [];
    for (let fi = 0; fi < zone.formations.length; fi++) {
      const w = zone.weights[fi] / total;
      // Sample the count roll — the same formation is a different fight at
      // min bodies and at max.
      const rnd = seeded(0x5EA15 + fi);
      const seen = new Map();
      for (let s = 0; s < SAMPLES; s++) {
        const ids = spawn(zone.formations[fi], rnd);
        const spec = enemySpec(ids);
        if (!seen.has(spec)) seen.set(spec, 0);
        seen.set(spec, seen.get(spec) + 1);
      }
      let fWin = 0; const seenTotal = [...seen.values()].reduce((a, b) => a + b, 0);
      for (const [spec, hits] of seen) {
        const r = sim(party, spec);
        const share = hits / seenTotal;
        fWin += r.winRate.party * share;
        if (r.winRate.party < worst.p) worst = { p: r.winRate.party, label: readSpec(spec) };
      }
      weighted += fWin * w;
      rows.push({ w: zone.weights[fi], fWin,
                  label: zone.formations[fi].map((g) => `${mname(g.id)} x${g.min}-${g.max}`).join(' + ') });
    }
    console.log(`  ${party.padEnd(16)} ${bar(weighted)} ${(weighted * 100).toFixed(0)}%  ` +
                `(worst formation ${(worst.p * 100).toFixed(0)}% — ${worst.label})`);
    if (args.includes('--detail'))
      for (const r of rows) console.log(`      ${String(r.w).padStart(2)}/64  ${(r.fWin * 100).toFixed(0).padStart(3)}%  ${r.label}`);
  }
}
console.log('');
