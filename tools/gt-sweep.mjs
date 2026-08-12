#!/usr/bin/env node
// gt-sweep.mjs — audit EVERY map against the real game, automatically.
//
// Pipeline per map:
//   1. tools/nes-run.mjs warps the real FF3 ROM to the map and screenshots it
//   2. tools/map-shot.mjs renders the same map through src/map-renderer.js
//   3. tools/gt-diff.mjs aligns the two and classifies every metatile cell
//
// The number that matters is OURS-ONLY: cells where WE draw something and the
// real game draws nothing. That is precisely the "trailing tiles outside the
// rooms" bug. `real-only` is expected and NOT a defect — our viewport is
// 144x144 (9x9 tiles) while the NES draws the full 256x224, so the real
// capture always covers more ground.
//
//   node tools/gt-sweep.mjs                 # the play-area maps
//   node tools/gt-sweep.mjs --ids 10,11,17
//   node tools/gt-sweep.mjs --keep out/     # keep the PNGs for inspection
//
// Requires a free-roam savestate; see --state (default $FF3_STATE).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };

const STATE = flag('state', process.env.FF3_STATE);
if (!STATE || !fs.existsSync(STATE)) {
  console.error('need a free-roam savestate: --state <file> or $FF3_STATE');
  console.error('make one with: node tools/nes-run.mjs --script "<intro>" --savestate free.json');
  process.exit(2);
}

const PLAY = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,25,26,27,28,29,30,
              44,45,46,47,50,52,53,54,101,102,111,112,113,114,115,122,123,147,148,160,163,164,
              165,166,168,170,174,175,176,177,178,179,182,183,186,187,188,189,190,191];
const idsFlag = flag('ids', null);
const ids = idsFlag ? idsFlag.split(',').map(Number) : PLAY;

const keep = flag('keep', null);
const dir = keep || fs.mkdtempSync(path.join(os.tmpdir(), 'gtsweep-'));
if (keep) fs.mkdirSync(keep, { recursive: true });

const sh = (cmd, a) => {
  try { return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};

const rows = [];
for (const id of ids) {
  const real = path.join(dir, `r${id}.png`);
  const ours = path.join(dir, `o${id}.png`);

  sh('node', ['tools/nes-run.mjs', '--loadstate', STATE, '--warp', String(id),
              '--warphold', '300', '--settle', '300', '--out', real, '--zoom', '1', '--frames', '40']);
  const shot = sh('node', ['tools/map-shot.mjs', String(id), ours, '--full', '--zoom', '1', '--nomark']);

  if (!fs.existsSync(real) || !fs.existsSync(ours)) {
    rows.push({ id, note: 'capture failed' });
    continue;
  }
  const out = sh('node', ['tools/gt-diff.mjs', real, ours]);
  const m = out.match(/cells: (\d+) agree, (\d+) differ, (\d+) real-only, (\d+) OURS-ONLY/);
  const ag = out.match(/agreement: ([\d.]+)%/);
  if (!m) { rows.push({ id, note: out.trim().split('\n')[0].slice(0, 60) }); continue; }
  rows.push({
    id,
    agree: +m[1], differ: +m[2], realOnly: +m[3], oursOnly: +m[4],
    pct: ag ? parseFloat(ag[1]) : 0,
    at: (shot.match(/at tile \((\d+),(\d+)\)/) || ['', '?', '?']).slice(1).join(','),
  });
  const r = rows[rows.length - 1];
  console.log(`map ${String(id).padStart(3)}  ${String(r.pct).padStart(5)}%  ` +
              `agree ${String(r.agree).padStart(3)}  differ ${String(r.differ).padStart(3)}  ` +
              `OURS-ONLY ${String(r.oursOnly).padStart(3)}${r.oursOnly ? '  <-- trailing tiles' : ''}`);
}

console.log('\n================ SUMMARY ================');
const bad = rows.filter(r => r.oursOnly > 0);
const weak = rows.filter(r => r.pct !== undefined && r.pct < 70 && !r.note);
const failed = rows.filter(r => r.note);
console.log(`${rows.length} maps compared against the real ROM`);
console.log(`trailing-tile maps (OURS-ONLY > 0): ${bad.length}${bad.length ? ' -> ' + bad.map(r => r.id).join(' ') : ''}`);
console.log(`low agreement (<70%):               ${weak.length}${weak.length ? ' -> ' + weak.map(r => `${r.id}(${r.pct}%)`).join(' ') : ''}`);
if (failed.length) console.log(`could not compare: ${failed.map(r => `${r.id}[${r.note}]`).join(' ')}`);
if (!keep) console.log(`\n(PNGs in ${dir})`);
