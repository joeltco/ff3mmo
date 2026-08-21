#!/usr/bin/env node
// check-dungeon-ending.mjs — the crystal belongs to the CRYSTAL dungeon only.
//
// `_updateBossDissolve` is the generic boss-death handler: battle-update.js,
// battle-ally.js and spell-cast.js all route any non-random, non-PVP kill into
// 'boss-dissolve'. It used to call `startCrystalReveal()` and grant the Wind
// Crystal jobs unconditionally, so a second dungeon's boss would have dissolved
// into a Wind Crystal and re-unlocked five jobs. Altar Cave is the crystal
// dungeon; the Cave of Seals is not.
//
// ⛔ The DISSOLVE is generic and must stay that way — every boss dissolves, that
// is the death animation. Only the reveal, the standing crystal NPC and the job
// unlock are crystal-ending.
//
// Two halves:
//   1. BEHAVIOURAL — `endingKindFor` says crystal for Altar Cave's chamber and
//      boss for everything else, and DEFAULTS to boss for maps it has never
//      heard of. The default is the whole point: the old code defaulted the
//      other way.
//   2. TEXTUAL — the job mask and the reveal are not invoked from anywhere that
//      bypasses the gate. A grep is the right instrument for "is this called
//      somewhere else too".

import fs from 'node:fs';
import path from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const fails = [];
const { endingKindFor, isCrystalChamber, ENDING_CRYSTAL, ENDING_BOSS, WIND_CRYSTAL_JOBS } =
  await import('../src/data/dungeons.js');

// ── 1. what each dungeon map's ending is ───────────────────────────────────
const crystal = [];
const plain = [];
for (const id of [1000, 1001, 1002, 1003, 1004, 1010, 1011, 1020, 1021, 2000, 2003]) {
  (endingKindFor(id) === ENDING_CRYSTAL ? crystal : plain).push(id);
}
console.log(`crystal endings: ${crystal.join(', ') || '(none)'}`);
console.log(`plain endings:   ${plain.join(', ')}`);
if (!isCrystalChamber(1004)) fails.push('map 1004 (Altar Cave crystal room) is not a crystal ending — the Wind Crystal would never be granted');
for (const id of [1000, 1001, 1002, 1003]) {
  if (isCrystalChamber(id)) fails.push(`map ${id} is an Altar Cave FLOOR, not its crystal chamber — it must not grant a crystal`);
}
// An unknown dungeon must default to a plain boss ending.
if (endingKindFor(9999) !== ENDING_BOSS) fails.push('an unknown map does not default to a plain boss ending — a new dungeon would inherit the crystal');
console.log(`unknown map defaults to: ${endingKindFor(9999)}`);

// ── 2. nothing bypasses the gate ───────────────────────────────────────────
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const files = walk(SRC).filter(f => f.endsWith('.js') && !f.endsWith('data/dungeons.js'));
const isComment = (l) => { const t = l.trim(); return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'); };
const mask = '0x' + WIND_CRYSTAL_JOBS.toString(16).toUpperCase();
let revealCalls = 0, maskLiterals = 0;
for (const f of files) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (isComment(line)) return;
    // ⛔ Exclude the DECLARATION — `export function startCrystalReveal(` matches
    // a naive call pattern, and the first version of this check failed on
    // npc.js, where the function is defined. Same class of false positive as a
    // grep matching its own explanatory comment.
    if (/\bstartCrystalReveal\s*\(/.test(line) && !/function\s+startCrystalReveal/.test(line)) {
      revealCalls++; console.log(`  startCrystalReveal call: ${path.relative(SRC, f)}:${i + 1}`);
    }
    if (/unlockedJobs\s*\|=\s*0x3[eE]\b/.test(line)) { maskLiterals++; fails.push(`${path.relative(SRC, f)}:${i + 1} grants the Wind Crystal jobs from a literal — use WIND_CRYSTAL_JOBS behind the ending gate`); }
  });
}
if (revealCalls !== 1) fails.push(`expected exactly ONE startCrystalReveal call site (the gated one), found ${revealCalls}`);
console.log(`startCrystalReveal call sites: ${revealCalls}, stray ${mask} job-mask literals: ${maskLiterals}`);

if (fails.length) { console.log('\nFAIL:'); for (const f of fails) console.log('  ' + f); process.exit(1); }
console.log('\ncrystal ending is Altar Cave only');
