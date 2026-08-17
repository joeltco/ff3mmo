#!/usr/bin/env node
// audit-rom-decodes.mjs — the FF1/FF2 ROM decode gates, run by hand.
//
// ⛔ WHY THESE ARE NOT IN `deploy.sh`. Every one drives a real emulator through
// battles or map loads, and together they cost minutes on EVERY deploy — while
// protecting constants that NO shipped game code reads. Verified: nothing under
// `src/` imports `lib/ff1-monsters`, `lib/ff1-map`, `lib/ff2-locations` or
// `lib/ff2-encounters`. They are a reference library, not a production contract.
//
// ⭐ They are still real and still revert-proven. Run this after touching any of:
//   tools/lib/ff1-monsters.mjs   tools/lib/ff1-map.mjs
//   tools/lib/ff2-locations.mjs  tools/lib/ff2-encounters.mjs
//
//   node tools/audit-rom-decodes.mjs
//   node tools/audit-rom-decodes.mjs --only ff2
//
// Same arrangement as `check-ff3-monster-fields.mjs`, which is manual for the
// same reason. ⛔ The two FAST decode gates stay in `deploy.sh` because they cost
// nothing: `check-ff1-palette` and `check-ff2-locations` (both under a second).

import { spawnSync } from 'node:child_process';

const only = (() => { const i = process.argv.indexOf('--only'); return i < 0 ? null : process.argv[i + 1]; })();

const GATES = [
  ['ff1', 'check-ff1-encounters.mjs', []],
  ['ff1', 'check-ff1-formation-gfx.mjs', ['--prove-revert']],
  ['ff1', 'check-ff1-ambush.mjs', ['--prove-revert']],
  ['ff1', 'check-ff1-formation-pattern.mjs', ['--prove-revert']],
  ['ff1', 'check-ff1-palette-select.mjs', ['--prove-revert']],
  ['ff1', 'check-ff1-encounter-rate.mjs', []],
  ['ff2', 'check-ff2-encounters.mjs', []],
  ['ff2', 'check-ff2-formations.mjs', []],
];

let failed = 0, ran = 0;
const t0 = Date.now();
for (const [tag, script, args] of GATES) {
  if (only && tag !== only) continue;
  const s = Date.now();
  const r = spawnSync('node', [`tools/${script}`, ...args], { encoding: 'utf8' });
  const secs = ((Date.now() - s) / 1000).toFixed(0);
  const last = (r.stdout || '').trim().split('\n').pop() || '(no output)';
  ran++;
  if (r.status !== 0) { failed++; console.log(`  FAIL  ${script.padEnd(34)} ${secs}s  ${last}`); }
  else console.log(`  ok    ${script.padEnd(34)} ${secs}s  ${last}`);
}
console.log(`\n${ran - failed}/${ran} decode gates passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(failed ? 1 : 0);
