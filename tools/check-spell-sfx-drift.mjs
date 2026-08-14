#!/usr/bin/env node
// check-spell-sfx-drift.mjs — a level-8 spell must not be wearing the sound of
// the level-7 spell below it.
//
// The magic menu is 3 columns x 8 rows. Black and White Mage both cap at magic
// level 7, so a level-8 pick is REFUSED and the cursor drifts one row down —
// the sweep casts the LEVEL 7 spell in the same column and files its sound
// under the level-8 id. That is how Meteo (0x02) came to play Drain's (0x09)
// sound, and it survived a full 48/48 "independent re-verification" because the
// re-run repeated the same mistake.
//
// Fixed in v1.7.998 by hex-patching byte 7 of the spell record (the castability
// gate) so the spell can actually be cast. This gate pins the result.
//
//   node tools/check-spell-sfx-drift.mjs

await import('./lib/browser-shim.mjs');
const { CAPTURED_SPELL_SFX } = await import('../src/data/spell-sfx-captured.js');
const { SPELL_NAMES_SHRINES: NAMES, getSpellLevel } = await import('../src/data/spells.js');

let fails = 0;
const fail = (m) => { console.error('  FAIL  ' + m); fails++; };
const ok = (m) => console.log('  ok    ' + m);

// Menu geometry: ids step by 7 down a column, so the level-7 spell directly
// below a level-8 spell is id + 7. Black = cols 0-2 (0x00-0x02), white = 0x03-0x05.
const L8 = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05];

// Values measured on a ROM-unlocked cast against the unkillable goblin, each
// reproduced on a second run. Pinned literally so a regenerated table that
// silently reverts to the drifted numbers fails here.
const MEASURED = new Map([
  [0x00, 125],   // Flare  ($bc)
  [0x01,  82],   // Death  ($91)
  [0x02,  67],   // Meteo  ($82)
  [0x03,  74],   // WWind  ($89) — genuinely shares with Cure4 below it
  [0x05,  90],   // ($99)  — genuinely shares with Wall below it
]);

console.log('\nlevel-8 spells carry their OWN measured sound');
for (const id of L8) {
  const got = CAPTURED_SPELL_SFX.get(id);
  const want = MEASURED.get(id);
  const name = NAMES.get(id) || '?';
  if (want == null) { ok(`0x0${id} ${name} — no pinned value (revive, silent without a dead target)`); continue; }
  if (got !== want) fail(`0x0${id} ${name}: sfx ${got}, measured ${want}`);
  else ok(`0x0${id} ${name.padEnd(8)} -> ${want}`);
}

// The drift signature itself, for the three that were actually wrong. 0x03 and
// 0x05 are deliberately NOT checked this way: they really do share a sound with
// the spell below, so "must differ" would fail on correct data.
console.log('\ndrift signature — these must NOT equal the level-7 spell below');
for (const id of [0x00, 0x01, 0x02]) {
  const below = id + 7;
  const a = CAPTURED_SPELL_SFX.get(id), b = CAPTURED_SPELL_SFX.get(below);
  const name = NAMES.get(id) || '?', bname = NAMES.get(below) || '?';
  if (getSpellLevel(id) !== 8 || getSpellLevel(below) !== 7) {
    fail(`menu geometry changed: 0x0${id} is L${getSpellLevel(id)}, 0x0${below.toString(16)} is L${getSpellLevel(below)}`);
    continue;
  }
  if (a === b) fail(`0x0${id} ${name} (${a}) == 0x0${below.toString(16)} ${bname} (${b}) — cursor drift is back`);
  else ok(`0x0${id} ${name.padEnd(8)} ${a} != ${bname} ${b}`);
}

// ── summons ──────────────────────────────────────────────────────────────
// ALL EIGHT verified (v1.8.2) by the call-school sweep:
//   SLOT_LO=0x0F SLOT_HI=0x48 FRAMES=2200 node tools/monscan/spell-sweep.cjs call
// Pinned literally so a regenerated table cannot quietly move them.
console.log('\nsummons (all 8 verified via the call-school sweep)');
const SUMMONS = new Map([
  [0x06, 125],   // Baham  @f652
  [0x0d, 115],   // Levia  @f686
  [0x14, 118],   // Odin   @f607
  [0x1b, 131],   // Titan  @f608
  [0x22, 130],   // Ifrit  @f714
  [0x29, 132],   // Ramuh  @f629
  [0x30,  67],   // Shiva  @f591
  [0x37,  75],   // Chocb  @f597
]);
for (const [id, want] of SUMMONS) {
  const got = CAPTURED_SPELL_SFX.get(id);
  const name = NAMES.get(id) || '?';
  if (got !== want) fail(`summon 0x${id.toString(16).padStart(2, '0')} ${name}: sfx ${got}, measured ${want}`);
  else ok(`0x${id.toString(16).padStart(2, '0')} ${name.padEnd(8)} -> ${want}`);
}
// $9f (96) fires at f270 in EVERY summon run, including one where the summon
// never cast — it belongs to the round, not to a summon. If it ever shows up as
// a summon's impact, the capture window was read wrong.
for (const [id] of SUMMONS) {
  if (CAPTURED_SPELL_SFX.get(id) === 96) {
    fail(`summon 0x${id.toString(16)} is recorded as track 96, which is the round's own f270 sound, not an impact`);
  }
}
// 0x14 was the last unverified value in the whole catalogue. It is now measured
// (118 @f607) by the call-school sweep — the harness built for summons, with the
// wider $0F-$48 sprite-slot window they draw from. The single-spell probe could
// never drive its menu row; that was a PROBE limit, not a silent spell.
if (CAPTURED_SPELL_SFX.get(0x14) !== 118) {
  fail('0x14 moved from its measured 118');
}

console.log(fails ? `\ncheck-spell-sfx-drift: ${fails} FAILED` : '\ncheck-spell-sfx-drift: all checks passed');
process.exit(fails ? 1 : 0);
