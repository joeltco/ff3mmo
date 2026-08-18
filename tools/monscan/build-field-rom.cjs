// build-field-rom.cjs — a ROM whose every encounter dies to one hit.
//
// ⭐ WHY: the monscan boot choreography (`bootToWorld` in map-bundles.cjs) drops
// the party into an Altar Cave battle and then tries to FLEE it — down,down,a
// per character, 40 times. Flee can simply keep failing, and when it does the
// harness sits in the battle forever while every downstream probe reports
// success against the wrong subject: the $AB warp "is accepted" every frame
// because the engine rewrites $AB while a menu is open, so a warp sweep returns
// "accepted" for every map id and renders the same battle screen 8 times.
//
// Fixing the choreography is guesswork. Patching the ROM is not: give every
// formation a single goblin with 1 HP and no attack, mash A, and the fight is
// over in one round. Measured: sprites 48 -> 4, $AB back to 0, warps then
// actually change the screen.
//
// This is build-capture-rom.cjs's goblin patch with the HP inverted — that one
// wants an UNKILLABLE goblin so a spell's sound can be captured without a death
// cue; this one wants the opposite, a goblin that cannot survive being looked at.
//
//   node tools/monscan/build-field-rom.cjs out.nes
//
// NEVER writes over FF3-English.nes.
const { readFileSync, writeFileSync } = require('fs');
const BASE = '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const ENCOUNTER_SET = 0x05C010, ENCOUNTER_MON = 0x05C410, ENCOUNTER_STR = 0x05CA10;
const MONSTER_PROPS = 0x060010;
const out = process.argv[2];
if (!out) { console.error('usage: build-field-rom.cjs <out.nes>'); process.exit(2); }
const rom = readFileSync(BASE), p = Buffer.from(rom);
let list = null;
for (let m = 0; m < 256 && list === null; m++) {
  const o = ENCOUNTER_MON + m * 6;
  for (let s = 0; s < 4; s++) if (rom[o + 2 + s] === 0x00) { list = m; break; }
}
if (list === null) { console.error('⛔ no formation contains species 0x00 — table layout changed'); process.exit(1); }
const mo = ENCOUNTER_MON + list * 6;
p[mo + 2] = 0x00; p[mo + 3] = 0xFF; p[mo + 4] = 0xFF; p[mo + 5] = 0xFF;
const props = MONSTER_PROPS + 0x00 * 16;
p[props + 1] = 0x01; p[props + 2] = 0x00;          // 1 HP
p[props + 9] = p[props + 9] & 0xC0;                // harmless
p[props + 13] = 0x00;                              // no status resist
p[ENCOUNTER_STR] = 1; p[ENCOUNTER_STR + 1] = 0; p[ENCOUNTER_STR + 2] = 0; p[ENCOUNTER_STR + 3] = 0;
for (let e = 0; e < 256; e++) { p[ENCOUNTER_SET + e * 2] = list; p[ENCOUNTER_SET + e * 2 + 1] &= 0xC0; }
// The world tile-property table must survive untouched — probes read it.
if (!rom.slice(0x510, 0x610).equals(p.slice(0x510, 0x610))) {
  console.error('⛔ patch touched the tile-props table at 0x510 — refusing to write'); process.exit(1);
}
writeFileSync(out, p);
console.log(`wrote ${out} — every encounter = 1 goblin, 1 HP, harmless (formation list ${list})`);
