#!/usr/bin/env node
// check-boot-order.mjs — guard the declaration order inside index.html's inline
// script.
//
// v1.7.939 shipped a fix for a temporal-dead-zone bug that cost real user time:
// `unlockGate()` runs SYNCHRONOUSLY from the `sessionStorage.ff3_auth === '1'`
// branch and calls showROMPicker() -> loadCachedROMs() -> getCachedROM() ->
// openDB(). `openDB` reads DB_NAME / DB_VERSION, which were declared with
// `const` ~100 lines LOWER in the same script — still in the temporal dead zone
// at call time, so it threw `ReferenceError` and the entire ROM cache read was
// lost. An affected player was asked to re-supply three ROMs she already had.
//
// It never showed up in testing because it only fires on the RETURNING-tab
// path: a fresh login calls showROMPicker from `doAuth`, a user event long
// after the script finished, when the consts are initialized. Smoke-loading the
// page does not reproduce it either, for the same reason.
//
// So: assert statically that everything the synchronous gate path can reach is
// declared before the gate runs.
//
//   node tools/check-boot-order.mjs

import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url).pathname, 'utf-8');

const gateMarker = '--- Password gate ---';
const gateIdx = html.indexOf(gateMarker);
if (gateIdx < 0) {
  console.error('check-boot-order: could not find the password-gate section — has index.html been restructured?');
  process.exit(2);
}
// The synchronous call into showROMPicker.
const triggerIdx = html.indexOf("if (sessionStorage.getItem('ff3_auth') === '1')", gateIdx);
if (triggerIdx < 0) {
  console.error('check-boot-order: could not find the synchronous unlockGate() trigger.');
  process.exit(2);
}

// Everything `openDB` / `getCachedROM` / `_pickerBeacon` touch at call time.
// A `const`/`let` here that sits BELOW the trigger is a live TDZ bug.
const MUST_PRECEDE = [
  'const DB_NAME',
  'const DB_VERSION',
  'const STORE',
  'function openDB()',
  'let ff3Buffer',
  'let ff1Buffer',
  'let ff2Buffer',
];

let failed = 0;
for (const needle of MUST_PRECEDE) {
  const at = html.indexOf(needle);
  if (at < 0) {
    console.error(`  ✗ ${needle} — not found at all`);
    failed++;
    continue;
  }
  if (at > triggerIdx) {
    console.error(`  ✗ ${needle} is declared AFTER the synchronous gate path (${at} > ${triggerIdx}) — TDZ ReferenceError at boot for returning tabs`);
    failed++;
  } else {
    console.log(`  ✓ ${needle}`);
  }
}

if (failed) {
  console.error(`\ncheck-boot-order: FAIL — ${failed} declaration(s) below the gate trigger.`);
  process.exit(1);
}
console.log('\ncheck-boot-order: OK — every gate-path dependency is declared before the gate runs.');
