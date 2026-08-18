#!/usr/bin/env node
// ff1-rng-stride-analyze.mjs — read ff1-rng-stride.mjs's JSONL and judge the rolls.
//
//   node tools/ff1-rng-stride-analyze.mjs rolls20.jsonl
//
// ⭐ WHY A SEPARATE ANALYZER: the emulation run costs ~an hour, so the judging
// must be re-runnable against saved data without paying for it again.
//
// ⛔ ROLLS WITHIN ONE BATTLE ARE NOT INDEPENDENT. Measured: per-battle fire
// counts came out 7, 2, 7, 1 out of ~12 rolls each, which binomial variance at
// p=0.25 cannot produce. A battle's rolls walk one RNG stream, so treating every
// roll as an independent sample understates the error bar. The headline number
// here is therefore the BATTLE-CLUSTERED mean: each battle contributes one rate,
// and the spread across battles gives the standard error.

import fs from 'node:fs';

const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!files.length) { console.error('usage: ff1-rng-stride-analyze.mjs <rolls.jsonl>'); process.exit(1); }

const recs = [];
for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (line.trim()) recs.push(JSON.parse(line));
  }
}
if (!recs.length) { console.error('no records'); process.exit(1); }

const rom = new Uint8Array(fs.readFileSync(process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes'));
const PRG = rom[4] * 16384, FIXED = 16 + PRG - 16384;
const TABLE = [];
for (let i = 0; i < 256; i++) TABLE.push(rom[FIXED + (0xFCF1 - 0xC000) + i]);
const rollValue = (v) => Math.floor(v * 129 / 256);
const hx = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

const CH = recs[0].chance;
if (recs.some(r => r.chance !== CH)) console.error('⚠ mixed chance values in input — rates are not comparable');

const flat = recs.flatMap(r => r.rolls);           // [idx, byte, fired]
const n = flat.length;
const fires = flat.filter(r => r[2]).length;
const nominal = CH / 128;
const exact = TABLE.filter(v => rollValue(v) < CH).length / 256;

console.log(`id $${hx(recs[0].id)} pool $${hx(recs[0].pool)} list ${recs[0].list} chance $${hx(CH)}`);
console.log(`battles=${recs.length} rounds=${recs.reduce((a, r) => a + r.rounds, 0)} rolls=${n} fires=${fires}`);

// --- integrity: every fire must be exactly the rows the table predicts --------
const predicted = flat.filter(r => rollValue(r[1]) < CH).length;
const disagree = flat.filter(r => (rollValue(r[1]) < CH) !== !!r[2]).length;
const badByte = flat.filter(r => TABLE[r[0]] !== r[1]).length;
console.log(`\n=== integrity ===`);
console.log(`  logged byte == ROM table[idx]          : ${n - badByte}/${n} ${badByte ? '⛔' : '✅'}`);
console.log(`  fired == (floor(v*129/256) < chance)   : ${n - disagree}/${n} ${disagree ? '⛔' : '✅'}`);
console.log(`  (predicted ${predicted}, observed ${fires})`);

// --- the rate, clustered by battle -------------------------------------------
const perBattle = recs.filter(r => r.rolls.length).map(r => r.rolls.filter(x => x[2]).length / r.rolls.length);
const B = perBattle.length;
const mean = perBattle.reduce((a, b) => a + b, 0) / B;
const varB = B > 1 ? perBattle.reduce((a, b) => a + (b - mean) ** 2, 0) / (B - 1) : 0;
const se = Math.sqrt(varB / B);
const naiveSe = Math.sqrt(nominal * (1 - nominal) / n);
console.log(`\n=== rate ===`);
console.log(`  pooled                 ${(100 * fires / n).toFixed(1)}%  (${fires}/${n})`);
console.log(`  battle-clustered mean  ${(100 * mean).toFixed(1)}% ± ${(100 * se).toFixed(1)}pp (1 SE, n=${B} battles)`);
console.log(`  per-battle rates       ${perBattle.map(p => (100 * p).toFixed(0) + '%').join(' ')}`);
console.log(`  chance/128 (nominal)   ${(100 * nominal).toFixed(2)}%`);
console.log(`  exact whole-table      ${(100 * exact).toFixed(2)}%`);
const z = se > 0 ? (mean - exact) / se : NaN;
console.log(`  z vs exact             ${isNaN(z) ? 'n/a' : z.toFixed(2)}  ${Math.abs(z) < 2 ? '✅ consistent' : '⛔ discrepant'}`);
console.log(`  ⚠ naive per-roll SE would be ±${(100 * naiveSe).toFixed(1)}pp — clustering makes the real bar ` +
            `${se > naiveSe ? (se / naiveSe).toFixed(1) + 'x WIDER' : 'narrower'}`);

// --- is the visited index sequence uniform? ----------------------------------
console.log(`\n=== visited index distribution (the only free variable) ===`);
const distinct = new Set(flat.map(r => r[0]));
console.log(`  distinct indices ${distinct.size}/256 over ${n} rolls`);
const BINS = 8, binw = 256 / BINS, bins = Array(BINS).fill(0);
for (const r of flat) bins[Math.floor(r[0] / binw)]++;
const expB = n / BINS;
const chi2 = bins.reduce((a, o) => a + (o - expB) ** 2 / expB, 0);
console.log(`  octile counts ${bins.join(' ')}  (expect ${expB.toFixed(1)} each)`);
console.log(`  chi2=${chi2.toFixed(1)} df=${BINS - 1}  ${chi2 < 14.07 ? '✅ uniform at p>0.05' : '⛔ non-uniform at p<0.05'}`);
for (const k of [2, 3, 4, 5, 6, 7, 8]) {
  const c = Array(k).fill(0);
  for (const r of flat) c[r[0] % k]++;
  console.log(`  mod ${k}: ${c.join(' ')}`);
}
const gaps = [];
for (const r of recs) for (let i = 1; i < r.rolls.length; i++) gaps.push((r.rolls[i][0] - r.rolls[i - 1][0] + 256) % 256);
const uniqGaps = new Set(gaps);
console.log(`  consecutive-index gaps: ${gaps.length} gaps, ${uniqGaps.size} distinct, mean ` +
            `${gaps.length ? (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : 'n/a'}` +
            `  ${uniqGaps.size > gaps.length * 0.8 ? '✅ no fixed stride' : '⛔ repeating gap — possible stride'}`);

// --- --table: one clustered row per chance value, across many JSONL files -----
// ⭐ This is the shape a published curve must take. Each row's error bar is the
// spread across BATTLES, not across rolls — see the clustering note above.
if (process.argv.includes('--table')) {
  const byChance = new Map();
  for (const r of recs) {
    if (!byChance.has(r.chance)) byChance.set(r.chance, []);
    byChance.get(r.chance).push(r);
  }
  console.log(`\n=== clustered curve (id $${hx(recs[0].id)} pool $${hx(recs[0].pool)} list ${recs[0].list}) ===`);
  console.log('| chance | battles | n rolls | fires | measured (battle-clustered) | exact from ROM table | z |');
  console.log('|---|---|---|---|---|---|---|');
  for (const [ch, rs] of [...byChance].sort((a, b) => a[0] - b[0])) {
    const rolls = rs.flatMap(r => r.rolls);
    const fr = rolls.filter(x => x[2]).length;
    const per = rs.filter(r => r.rolls.length).map(r => r.rolls.filter(x => x[2]).length / r.rolls.length);
    const m = per.reduce((a, b) => a + b, 0) / per.length;
    const v = per.length > 1 ? per.reduce((a, b) => a + (b - m) ** 2, 0) / (per.length - 1) : 0;
    const s = Math.sqrt(v / per.length);
    const ex = TABLE.filter(x => rollValue(x) < ch).length / 256;
    const zz = s > 0 ? (m - ex) / s : (Math.abs(m - ex) < 1e-9 ? 0 : NaN);
    console.log(`| \`$${hx(ch)}\` | ${per.length} | ${rolls.length} | ${fr} | ${(100 * m).toFixed(1)}% ± ${(100 * s).toFixed(1)}pp | ${(100 * ex).toFixed(2)}% | ${isNaN(zz) ? 'n/a' : zz.toFixed(2)} |`);
  }
}
