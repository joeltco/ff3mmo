// world-harness.cjs — boot FF3 straight onto the WORLD MAP, headless.
//
// ⭐ WHY THIS EXISTS: nothing else could get there. The monscan choreography
// reaches an Altar Cave battle it cannot reliably flee; both TAS movies in
// tools/movies/ stay in Altar Cave; and the world map is NOT a `$0700` map id —
// warping to all 256 ids never produces it. Every world-map probe (tile
// passability, vehicle sprites, launch animations) was blocked on this.
//
// The way in is two ROM patches, both lifted from tools that already prove them:
//
//   1. build-field-rom.cjs's 1-HP harmless goblin, so the intro battle ends on
//      the first hit instead of the flee loop failing forever.
//   2. world-sfx-sweep.cjs's SPAWN trick — copy map 115's props over ALL 512 map
//      slots with the entrance moved to (16,25), one tile ABOVE Altar Cave's exit
//      tile at (16,26). Whatever map the intro picks is then Altar Cave with the
//      party standing on the doorstep, and the first step down exits to the world.
//
// ⛔ DO NOT try to poke the party onto the exit tile instead. $29/$2a/$68/$69 hold
// the tile coords and can be written, but the engine's position state does not
// follow: the party freezes and never moves again. Holding a value is not being it.
//
//   const { bootToWorldMap, MODE_ADDR } = require('./world-harness.cjs');
//   const nes = bootToWorldMap();            // on the overworld, ready to walk
//
const { readFileSync, writeFileSync, mkdtempSync } = require('fs');
const os = require('os'), path = require('path');
const { Nes, BTN } = require('./nes.cjs');

const BASE_ROM = '/home/joeltco/projects/ff3mmo/FF3-English.nes';
const ENCOUNTER_SET = 0x05C010, ENCOUNTER_MON = 0x05C410, ENCOUNTER_STR = 0x05CA10;
const MONSTER_PROPS = 0x060010;
const MAP_PROPS_BASE = 0x004010, TILEMAP_ID_BASE = 0x000A10, GFX_SUBSET_ID_BASE = 0x000C10;
const ALTAR_MAP = 115, EXIT_X = 16, EXIT_Y = 26;   // exit tile; we spawn one ABOVE it
// Where a map DROPS YOU on the world, indexed by entrance-trigger id (64 each).
// Patching all 64 makes the landing spot arbitrary, which is the only working way
// to place the party — writing $27/$28 holds the value but FREEZES movement,
// because the engine keeps its own position/scroll state alongside them.
const EXIT_X_TABLE = 0x000890, EXIT_Y_TABLE = 0x0008D0;

/** Zero-page address holding the MOVEMENT MODE that indexes the mask table at $C6CD. */
const MODE_ADDR = 0x42;
/** Where the engine copies the 128x2 world tile-property table at map load. */
const PROPS_RAM = 0x0400;

function buildWorldRom(outPath, opts = {}) {
  const rom = readFileSync(BASE_ROM), p = Buffer.from(rom);
  // 1) every encounter = one 1-HP harmless goblin
  let list = null;
  for (let m = 0; m < 256 && list === null; m++) {
    const o = ENCOUNTER_MON + m * 6;
    for (let s = 0; s < 4; s++) if (rom[o + 2 + s] === 0x00) { list = m; break; }
  }
  if (list === null) throw new Error('no formation contains species 0x00 — table layout changed');
  const mo = ENCOUNTER_MON + list * 6;
  p[mo + 2] = 0x00; p[mo + 3] = 0xFF; p[mo + 4] = 0xFF; p[mo + 5] = 0xFF;
  const pr = MONSTER_PROPS;
  p[pr + 1] = 0x01; p[pr + 2] = 0x00; p[pr + 9] = p[pr + 9] & 0xC0; p[pr + 13] = 0x00;
  p[ENCOUNTER_STR] = 1; p[ENCOUNTER_STR + 1] = 0; p[ENCOUNTER_STR + 2] = 0; p[ENCOUNTER_STR + 3] = 0;
  for (let e = 0; e < 256; e++) { p[ENCOUNTER_SET + e * 2] = list; p[ENCOUNTER_SET + e * 2 + 1] &= 0xC0; }
  // 2) map 115 everywhere, spawning one tile above its exit
  const sx = opts.spawnX !== undefined ? opts.spawnX : EXIT_X;
  const sy = opts.spawnY !== undefined ? opts.spawnY : EXIT_Y - 1;
  const props = Buffer.from(p.slice(MAP_PROPS_BASE + ALTAR_MAP * 16, MAP_PROPS_BASE + ALTAR_MAP * 16 + 16));
  props[0] = (props[0] & 0xE0) | (sx & 0x1F);      // top 3 bits are the TILESET — never clobber
  props[1] = (props[1] & 0xE0) | (sy & 0x1F);
  // 3) optional: land at an arbitrary world coordinate on exit
  if (opts.worldX !== undefined && opts.worldY !== undefined) {
    for (let t = 0; t < 64; t++) {
      p[EXIT_X_TABLE + t] = opts.worldX & 0xFF;
      p[EXIT_Y_TABLE + t] = opts.worldY & 0xFF;
    }
  }
  // 4) ⭐ position + VEHICLE at boot, patched into the code that reads the save.
  //
  //    C0CD  AD 09 60  LDA $6009 / STA $27    ; world X
  //    C0D2  AD 0A 60  LDA $600A / STA $28    ; world Y
  //    C0D7  AD 0F 60  LDA $600F / STA $46 / STA $42   ; <- THE VEHICLE
  //
  // $6000-$7FFF is battery-backed save RAM, so the vehicle you are riding and
  // where you stand are SAVE fields. Rewriting each 3-byte absolute load as
  // `LDA #imm ; NOP` pins them at boot. This is the only placement that works —
  // writing $27/$28 directly holds the value but freezes movement, and the
  // 0x890/0x8D0 exit tables do not drive the landing spot.
  const FIXED_BASE = 0x7C010;               // CPU $C000 for this 512KB ROM
  const at = (cpuAddr) => FIXED_BASE + (cpuAddr - 0xC000);
  const pinLoad = (cpuAddr, value, expectLo, expectHi) => {
    const o = at(cpuAddr);
    if (p[o] !== 0xAD || p[o + 1] !== expectLo || p[o + 2] !== expectHi) {
      throw new Error(`expected LDA $${expectHi.toString(16)}${expectLo.toString(16)} at $${cpuAddr.toString(16)} — ROM layout changed`);
    }
    p[o] = 0xA9; p[o + 1] = value & 0xFF; p[o + 2] = 0xEA;   // LDA #imm ; NOP
  };
  if (opts.worldX !== undefined) pinLoad(0xC0CD, opts.worldX, 0x09, 0x60);
  if (opts.worldY !== undefined) pinLoad(0xC0D2, opts.worldY, 0x0A, 0x60);
  if (opts.vehicle !== undefined) pinLoad(0xC0D7, opts.vehicle, 0x0F, 0x60);

  // 5) ⭐ overwrite the movement-mode MASK TABLE at $C6CD (8 bytes, stock
  //    01 03 02 04 10 10 10 10). The passability check is
  //    `AND mask ; CMP mask` -> blocked iff every mask bit is set in byte1, so
  //    mask $00 blocks EVERYTHING and mask $80 blocks almost nothing. Changing
  //    it and watching behaviour change is the only clean way to prove this
  //    table is what actually gates movement.
  if (opts.maskTable) {
    const o = at(0xC6CD);
    const stock = [0x01, 0x03, 0x02, 0x04, 0x10, 0x10, 0x10, 0x10];
    for (let i = 0; i < 8; i++) {
      if (p[o + i] !== stock[i]) throw new Error(`mask table at $C6CD is not stock at +${i} — ROM layout changed`);
    }
    for (let i = 0; i < 8; i++) if (opts.maskTable[i] !== undefined) p[o + i] = opts.maskTable[i] & 0xFF;
  }

  const tid = p[TILEMAP_ID_BASE + ALTAR_MAP], gid = p[GFX_SUBSET_ID_BASE + ALTAR_MAP];
  for (let m = 0; m < 512; m++) {
    props.copy(p, MAP_PROPS_BASE + m * 16);
    p[TILEMAP_ID_BASE + m] = tid; p[GFX_SUBSET_ID_BASE + m] = gid;
  }
  // the world tile-property table must survive — every probe downstream reads it
  if (!rom.slice(0x510, 0x610).equals(p.slice(0x510, 0x610))) {
    throw new Error('patch disturbed the tile-props table at 0x510');
  }
  writeFileSync(outPath, p);
  return outPath;
}

function run(nes, n) { for (let i = 0; i < n; i++) nes.nes.frame(); }
function press(nes, b, hold = 8, after = 24) {
  nes.nes.buttonDown(1, BTN[b]); run(nes, hold); nes.nes.buttonUp(1, BTN[b]); run(nes, after);
}
function hold(nes, b, n) { nes.nes.buttonDown(1, BTN[b]); run(nes, n); nes.nes.buttonUp(1, BTN[b]); run(nes, 10); }
function spriteCount(nes) {
  let n = 0; const o = nes.nes.ppu.spriteMem;
  for (let i = 0; i < 256; i += 4) if (o[i] < 0xEF) n++;
  return n;
}

/** Boot to a party standing on the overworld. Throws if it does not get there. */
function bootToWorldMap(opts = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'world-'));
  const romPath = buildWorldRom(path.join(dir, 'ff3-world.nes'), opts);
  // ⭐ opts.onBatteryRamWrite must be wired at CONSTRUCTION. FF3 fires sound by
  // writing $7F49 and music by writing $7F43, and BOARDING happens during this
  // boot — a hook installed after bootToWorldMap() returns misses every boarding
  // cue and makes a vehicle look silent when it is not.
  const nes = new Nes(romPath, { onBatteryRamWrite: opts.onBatteryRamWrite });
  nes.romPath = romPath;
  run(nes, 300);
  for (let i = 0; i < 25; i++) press(nes, 'start', 6, 45);
  for (let b = 0; b < 10; b++) { for (let k = 0; k < 6; k++) press(nes, 'a', 8, 25); press(nes, 'down', 8, 40); }
  run(nes, 400);
  for (let r = 0; r < 25 && spriteCount(nes) > 12; r++) { for (let k = 0; k < 8; k++) press(nes, 'a', 6, 18); run(nes, 120); }
  for (let i = 0; i < 10; i++) press(nes, 'a', 6, 20);
  run(nes, 200);
  // ⭐ VERIFY we are actually on the world map rather than trusting the choreography:
  // the engine only populates $0400 with the WORLD tile-property table there.
  const rom = readFileSync(romPath);
  const mem = nes.nes.cpu.mem;
  let match = 0;
  for (let k = 0; k < 256; k++) if (mem[PROPS_RAM + k] === rom[0x510 + k]) match++;
  if (match !== 256) throw new Error(`not on the world map — $0400 matches world props only ${match}/256`);
  return nes;
}

/** Save-RAM fields the boot path reads at $C0CD. */
const SAVE_WORLD_X = 0x6009, SAVE_WORLD_Y = 0x600A, SAVE_VEHICLE = 0x600F;
const PARTY_X = 0x27, PARTY_Y = 0x28;

module.exports = { bootToWorldMap, buildWorldRom, run, press, hold, spriteCount,
  MODE_ADDR, PROPS_RAM, BTN, PARTY_X, PARTY_Y, SAVE_WORLD_X, SAVE_WORLD_Y, SAVE_VEHICLE };
