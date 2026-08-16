#!/usr/bin/env node
// ff3-drop-audit.mjs — the hand-maintained steal/drop data vs what the ROM says.
//
// WHY
// `src/data/monsters.js` carries `steal:` and `drops:` fields that
// `gen-monsters-js.js` explicitly "preserves from previous manual data" — a
// secondary source that predates the table being decoded. The game reads them
// (`battle-update.js` rolls `mData.drops`), so any disagreement is a real
// behavioural difference, not a documentation nit.
//
// The ROM's answer: ONE 8-slot entry per monster, at `$9B80` in bank 16, indexed
// by record byte 15 masked with `$1F`. Steal and drop both roll a slot out of it.
//
//   node tools/ff3-drop-audit.mjs
//   node tools/ff3-drop-audit.mjs --mismatches
//
// ⛔ This REPORTS. It does not rewrite `monsters.js`: ff3mmo is its own game, so
// whether to follow ROM canon here is a design call, not a correctness one.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M3 from './lib/ff3-monsters.mjs';
import * as SH from './lib/ff3-shops.mjs';
import { glyph } from './lib/ff3-text.mjs';
import { MONSTERS } from '../src/data/monsters.js';
import { initTextDecoder, getMonsterName } from '../src/text-decoder.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ONLY_BAD = args.includes('--mismatches');
const rom = new Uint8Array(fs.readFileSync(path.join(HERE, '..', 'FF3-English.nes')));
initTextDecoder(Buffer.from(rom));

const nesText = (bytes) => {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xCA && b <= 0xE3) s += String.fromCharCode(b - 0xCA + 97);
    else if (b >= 0x8A && b <= 0xA3) s += String.fromCharCode(b - 0x8A + 65);
    else if (b >= 0x80 && b <= 0x89) s += String.fromCharCode(b - 0x80 + 48);
    else if (b === 0xFF) s += ' ';
  }
  return s.trim();
};
const mname = (id) => { try { return nesText(getMonsterName(id)); } catch { return `mon${id}`; } };
const iname = (id) => {
  if (!id) return '-';
  try { const n = SH.itemName(rom, id, glyph); return n && n.trim() ? n.trim() : `#${id.toString(16).toUpperCase()}`; }
  catch { return `#${id.toString(16).toUpperCase()}`; }
};
const hx = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;

let checked = 0, stealOk = 0, stealBad = 0, stealMissing = 0;
let dropOk = 0, dropBad = 0, dropMissing = 0, dropPartial = 0;
const bad = [];

for (const [id, m] of MONSTERS) {
  if (id >= 232) continue;
  checked++;
  const slots = M3.stealSlots(rom, id);
  const set = new Set(slots.filter(v => v));
  const rowsBad = [];

  // ── the hand `steal:` field ───────────────────────────────────────────────
  if (m.steal == null) stealMissing++;
  else if (set.has(m.steal)) stealOk++;
  else { stealBad++; rowsBad.push(`steal ${iname(m.steal)} (${hx(m.steal)}) is NOT in the entry`); }

  // ── the hand `drops:` field ───────────────────────────────────────────────
  const drops = (m.drops || []).filter(d => d != null);
  if (!drops.length) dropMissing++;
  else {
    const inTable = drops.filter(d => set.has(d));
    if (inTable.length === drops.length) {
      dropOk++;
      // ⭐ the interesting half: the ROM offers EIGHT slots, so listing one or two
      // is not wrong so much as INCOMPLETE — and the tail is the valuable part.
      const missed = [...set].filter(v => !drops.includes(v));
      if (missed.length) dropPartial++;
    } else {
      dropBad++;
      rowsBad.push(`drops ${drops.filter(d => !set.has(d)).map(d => `${iname(d)} (${hx(d)})`).join(', ')} NOT in the entry`);
    }
  }

  if (rowsBad.length) {
    bad.push({ id, name: mname(id), rowsBad, entry: [...set] });
  } else if (!ONLY_BAD) {
    const missed = [...set].filter(v => !drops.includes(v) && v !== m.steal);
    if (missed.length && drops.length) {
      // reported separately below, not as a failure
    }
  }
}

console.log('FF3 hand-maintained steal/drop data vs the decoded table\n');
console.log(`monsters in src/data/monsters.js: ${checked}\n`);
console.log('the `steal:` field');
console.log(`   in the monster's entry : ${stealOk}`);
console.log(`   NOT in the entry       : ${stealBad}`);
console.log(`   absent from the data   : ${stealMissing}`);
console.log('\nthe `drops:` field');
console.log(`   every id in the entry  : ${dropOk}`);
console.log(`   some id NOT in it      : ${dropBad}`);
console.log(`   absent from the data   : ${dropMissing}`);
console.log(`   ...of the agreeing ones, INCOMPLETE (entry offers more): ${dropPartial}`);

if (bad.length) {
  console.log(`\n⛔ ${bad.length} monsters whose hand data names an item the ROM entry does not contain:\n`);
  for (const b of bad.slice(0, 40)) {
    console.log(`   ${hx(b.id)} ${b.name}`);
    for (const r of b.rowsBad) console.log(`        ${r}`);
    console.log(`        the ROM entry: ${b.entry.map(iname).join(', ')}`);
  }
  if (bad.length > 40) console.log(`   ...and ${bad.length - 40} more`);
} else {
  console.log('\n⭐ no monster names an item outside its ROM entry.');
}

// ⭐ the part that actually matters for play: what the hand data leaves out.
console.log('\n⭐ the rare tail the hand data omits (slots 4-7 are 9.4/9.4/4.7/1.6%):');
let shown = 0;
for (const [id, m] of MONSTERS) {
  if (id >= 232 || shown >= 12) continue;
  const slots = M3.stealSlots(rom, id);
  if (!slots.some(v => v)) continue;
  const drops = new Set((m.drops || []).filter(d => d != null));
  const tail = [...new Set(slots.slice(4))].filter(v => v && !drops.has(v));
  if (!tail.length) continue;
  console.log(`   ${hx(id)} ${mname(id).padEnd(12)} misses ${tail.map(iname).join(', ')}`);
  shown++;
}
