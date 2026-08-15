#!/usr/bin/env node
// check-ff1-shops.mjs — FF1's shop tables stay decoded.
//
// Every constant in `lib/ff1-shops.mjs` is a claim about a specific instruction,
// so this compares each one against the bytes at the address it cites. Then it
// opens four real shops and checks the prices the game DRAWS against the prices
// the table predicts, because a table that survives a byte check can still be
// pointing at the wrong thing.
//
//   node tools/check-ff1-shops.mjs
//
// ⛔ Expectations are literal opcodes written out by hand from the listing.
// Never derive one from the value under test.
// ⛔ INN/CLINIC prices are NOT checked against the screen — the shop does not
// draw them at that point. They are pinned to $AAA0/$AAA5 instead, and the INN
// path is additionally caught reading the record live.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { makeTracer } from './lib/nes-trace.mjs';
import * as F1 from './lib/ff1-text.mjs';
import * as M from './lib/ff1-map.mjs';
import * as S from './lib/ff1-shops.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROMP = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const rom = new Uint8Array(fs.readFileSync(ROMP));
const romBin = fs.readFileSync(ROMP, 'binary');
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff1-hall.state.gz'))).toString('utf8');

const BANKS = (rom.length - 0x10) / 0x4000;
const fixedOf = (a) => 0x10 + (BANKS - 1) * 0x4000 + (a - 0xC000);
const bankOf = (n, a) => 0x10 + n * 0x4000 + (a - 0x8000);

let fails = 0, checks = 0;
function eq(what, got, want) {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fails++; console.log(`  FAIL  ${what}\n          got ${g}  want ${w}`); }
  else console.log(`  ok    ${what}`);
}
const instr = (off, want, what) =>
  eq(what, [...rom.slice(off, off + want.length)], want);
const fixed = (a, want, what) => instr(fixedOf(a), want, `$${a.toString(16).toUpperCase()}  ${what}`);
const b14 = (a, want, what) => instr(bankOf(14, a), want, `$${a.toString(16).toUpperCase()}  ${what} (bank 14)`);

console.log('FF1 shop tables — the constants vs the instructions they claim\n');

console.log('shop id -> KIND');
fixed(0xEB47, [0xA6, M.SPECIAL_ID], 'LDX $51');
fixed(0xEB49, [0xBD, 0xB5, 0xEB], 'LDA $EBB5,X      — the kind table');
eq('KIND_TABLE is $EBB5 in the fixed bank', S.KIND_TABLE, fixedOf(0xEBB5));
fixed(0xEB4C, [0x29, S.KIND_MASK], 'AND #$07         — KIND_MASK');
eq('eight kinds fit in KIND_MASK', S.KINDS.length, S.KIND_MASK + 1);

console.log('\nshop id -> RECORD');
b14(0xA7D1, [0xA5, M.SPECIAL_ID], 'LDA $51');
b14(0xA7D3, [0x0A, 0xAA], 'ASL A / TAX      — two bytes per entry');
b14(0xA7D5, [0xBD, 0x00, 0x83], 'LDA $8300,X      — the pointer table');
eq('SHOP_PTR_TABLE is $8300 in bank 14', S.SHOP_PTR_TABLE, bankOf(14, 0x8300));
b14(0xA7DF, [0xA0, S.RECORD_MAX - 1], 'LDY #$04         — RECORD_MAX bytes copied');
b14(0xA7E9, [0xA9, 0x00, 0x8D, 0x05, 0x03], 'LDA #$00 / STA $0305 — forced terminator');
b14(0xA85F, [0xBD, 0x00, 0x03], 'LDA $0300,X      — walking the record');
b14(0xA862, [0xF0, 0x2D], 'BEQ +            — 00 ENDS the list');
b14(0xA88D, [0xC9, S.RECORD_MAX], 'CMP #$05         — RECORD_MAX');

console.log('\nitem id -> PRICE');
fixed(0xECB9, [0x0A, 0x85, 0x12], 'ASL A / STA $12  — id*2 is the low byte');
// ⛔ the base is NOT written as #$BC anywhere — it is #$5E rolled left, which is
// also how ids >= $80 reach $BD00 for free.
fixed(0xECBC, [0xA9, 0x5E], 'LDA #$5E         — half the table page');
fixed(0xECBE, [0x2A, 0x85, 0x13], 'ROL A / STA $13  — ...doubled into $BC');
eq('PRICE_TABLE is $BC00 in bank 13', S.PRICE_TABLE, bankOf(13, (0x5E << 1) << 8));
fixed(0xECC8, [0xB1, 0x12], 'LDA ($12),Y      — the price is read indirect');

console.log('\nitem id -> NAME');
fixed(0xE004, [0x0A, 0xAA], 'ASL A / TAX      — two bytes per entry');
fixed(0xE006, [0xB0, 0x0B], 'BCS +            — ids >= $80 take the other table');
fixed(0xE008, [0xBD, 0x00, 0xB7], 'LDA $B700,X      — the name pointer table');
fixed(0xE013, [0xBD, 0x00, 0xB8], 'LDA $B800,X      — ...and its second page');
eq('NAME_PTR_TABLE is $B700 in bank 10', S.NAME_PTR_TABLE, bankOf(10, 0xB700));
eq('the two name pages are contiguous', bankOf(10, 0xB800) - bankOf(10, 0xB700), 0x100);
fixed(0xDE47, [0xB1, 0x3E], 'LDA ($3E),Y      — the name printer');
fixed(0xDE49, [0xF0, 0xDE], 'BEQ -            — names are 00-terminated');

console.log('\nINN / CLINIC record is a 16-bit PRICE, not a list');
b14(0xAAA0, [0xAD, 0x00, 0x03, 0x85, 0x10], 'LDA $0300 / STA $10');
b14(0xAAA5, [0xAD, 0x01, 0x03, 0x85, 0x11], 'LDA $0301 / STA $11  — high byte');
b14(0xAAAA, [0xA9, 0x00, 0x85, 0x12], 'LDA #$00 / STA $12   — 24-bit, then printed');

console.log('\nthe kind table agrees with the bands measured by opening every id');
let bandsOk = true;
for (let id = 0; id <= M.SPECIAL_ID_MAX; id++) {
  if (S.KINDS[rom[S.KIND_TABLE + id] & S.KIND_MASK] !== M.specialKind(id)) bandsOk = false;
}
eq('every id 0..70 agrees between ff1-map and the ROM table', bandsOk, true);

// ⛔ Without these, dropping a kind from PRICE_KINDS goes unnoticed: a clinic's
// record then reads as a one-item buy list ([0x28] for id 41) and every other
// check still passes.
console.log('\nthe price kinds stock nothing');
eq('clinic 41 is a 16-bit price, not a list',
   [S.shopAt(rom, 41).price, S.shopAt(rom, 41).items.length], [40, 0]);
eq('inn 51 is a 16-bit price, not a list',
   [S.shopAt(rom, 51).price, S.shopAt(rom, 51).items.length], [30, 0]);
eq('no INN or CLINIC anywhere stocks an item',
   S.allShops(rom).filter(s => S.PRICE_KINDS.has(s.kind) && s.items.length).length, 0);
eq('...and both price kinds are still price kinds',
   [...S.PRICE_KINDS].sort(), ['CLINIC', 'INN']);

console.log('\nunused slots');
const shops = S.allShops(rom, F1.glyph);
const unused = shops.filter(s => s.unused).map(s => s.id);
eq('the unused ids are the tails of the bands', unused,
   [7, 8, 9, 10, 17, 18, 19, 20, 47, 48, 49, 50, 58, 59, 60, 67, 68, 69]);
eq('the filler record starts with 00, so its list is empty',
   rom[S.bank14(S.FILLER_PTR)], 0);
eq('52 shops are in use', shops.length - unused.length, 52);

// ── live: what the shop actually draws ───────────────────────────────────────
console.log('\nfour shops, opened for real (screen prices vs the table)');
function open(id, keys) {
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(romBin);
  nes.fromJSON(JSON.parse(SNAP));
  for (let i = 0; i < 20; i++) nes.frame();
  nes.cpu.mem[M.SPECIAL_ID] = id;
  nes.cpu.mem[M.SPECIAL_PENDING] = 1;
  for (let i = 0; i < 260; i++) nes.frame();
  for (const k of keys) {
    nes.buttonDown(1, k); for (let i = 0; i < 6; i++) nes.frame();
    nes.buttonUp(1, k); for (let i = 0; i < 90; i++) nes.frame();
  }
  return nes;
}
function pricesOnScreen(nes) {
  const v = nes.ppu.vramMem, nums = [];
  for (let r = 0; r < 30; r++) {
    let s = '';
    for (let c = 0; c < 32; c++) {
      const g = F1.glyph(v[0x2000 + r * 32 + c]);
      s += (g === null || g === '\n') ? ' ' : g;
    }
    for (const m of s.matchAll(/(?<!\d)(\d{1,5})(?!\d)/g)) nums.push(Number(m[1]));
  }
  return nums.filter(n => n !== 400);          // 400 G is the party's gil
}
for (const id of [1, 12, 63, 70]) {
  const e = S.shopAt(rom, id, F1.glyph);
  const seen = pricesOnScreen(open(id, [Controller.BUTTON_A]));
  const want = e.items.map(i => i.price);
  eq(`shop ${String(id).padStart(2)} (${e.kind}) draws ${JSON.stringify(want)}`,
     seen.slice(0, want.length), want);
}

console.log('\nthe INN reads its price out of the record, live');
{
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(romBin);
  nes.fromJSON(JSON.parse(SNAP));
  for (let i = 0; i < 20; i++) nes.frame();
  nes.cpu.mem[M.SPECIAL_ID] = 51;
  nes.cpu.mem[M.SPECIAL_PENDING] = 1;
  const t = makeTracer(nes);
  const got = [];
  t.onAnyRead = (a, v, pc) => {
    if ((pc === 0xAAA3 && a === 0x300) || (pc === 0xAAA8 && a === 0x301)) got.push(v);
  };
  t.recording = true;
  for (let i = 0; i < 260; i++) nes.frame();
  nes.buttonDown(1, Controller.BUTTON_A); for (let i = 0; i < 6; i++) nes.frame();
  nes.buttonUp(1, Controller.BUTTON_A); for (let i = 0; i < 120; i++) nes.frame();
  t.recording = false;
  eq('inn 51 reads its record bytes at $AAA3/$AAA8',
     got.slice(0, 2), S.shopAt(rom, 51).raw.slice(0, 2));
  eq('...which is the price the table reports', S.shopAt(rom, 51).price, 30);
}

// ── FF1's monster NAME table, pinned to the instruction that reads it ───────
// ⛔ Only index 0 is confirmed on screen (a live battle drew "IMP"); the rest
// are decoded but not individually verified, because the encounter FORMATION
// table is not decoded yet and a chosen monster cannot be made to appear.
console.log('\nencounters (the chain is decoded; the last hop is not)');
fixed(0xCDC3, [0xA5, 0x45, 0x10], 'LDA $45 / BPL    — prop1 bit 7 = encounter tile');
fixed(0xCDCE, [0xA5, 0x48, 0x18, 0x69, 0x40], 'LDA $48 / ADC #$40 — formation by MAP');
fixed(0xC54A, [0xA0, 0x10, 0x84, 0x11], 'LDY #$10 / STY $11 — the table page');
fixed(0xC54E, [0x0A, 0x26, 0x11], 'ASL A / ROL $11  — ...times 8');
fixed(0xC559, [0xA9, 0x0B], 'LDA #$0B         — bank 11');
fixed(0xC56B, [0xB1, 0x10, 0x85, 0x6A], 'LDA ($10),Y / STA $6A — the GROUP id');
eq('ENCOUNTER_TABLE(16) is $8280 in bank 11',
   M.ENCOUNTER_TABLE(16), 0x10 + 11 * 0x4000 + (0x8280 - 0x8000));
eq('eight groups per map', M.ENCOUNTER_SLOTS, 8);
eq('ENCOUNTER_TILE_BIT is bit 7', M.ENCOUNTER_TILE_BIT, 0x80);

console.log('\nmonster names');
{
  const MN = await import('./lib/ff1-monsters.mjs');
  fixed(0xFBD4, [0xBD, 0xC9, 0x6B], 'LDA $6BC9,X      — the battle monster slots');
  fixed(0xFBD7, [0xC9, MN.EMPTY_SLOT], 'CMP #$FF         — EMPTY_SLOT');
  fixed(0xFBDB, [0x4C, 0x7A, 0xFC], 'JMP $FC7A        — into the printer, id already in A');
  eq('MONSTER_SLOTS is $6BC9', MN.MONSTER_SLOTS, 0x6BC9);
  fixed(0xFC7B, [0xA9, 0x0B], 'LDA #$0B         — the name bank');
  fixed(0xFC83, [0xBD, 0xE0, 0x94], 'LDA $94E0,X      — NAME_PTR_TABLE');
  fixed(0xFC88, [0xBD, 0xE1, 0x94], 'LDA $94E1,X      — ...its high byte');
  eq('NAME_PTR_TABLE is $94E0 in bank 11', MN.NAME_PTR_TABLE, 0x10 + 11 * 0x4000 + (0x94E0 - 0x8000));
  fixed(0xFC94, [0xA0, 0x00, 0xB1, 0x94], 'LDY #$00 / LDA ($94),Y — 00-terminated');
  // ⭐ the formation lever: byte 2 of a 16-byte record is the monster id
  fixed(0xF2A3, [0x0A, 0x26, 0x9B], 'ASL A / ROL $9B  — index * 16');
  fixed(0xF2B2, [0xA5, 0x9B, 0x69, 0x84], 'LDA $9B / ADC #$84 — the formation page');
  fixed(0xF2B8, [0xA2, MN.FORMATION_STRIDE], 'LDX #$10         — FORMATION_STRIDE');
  eq('FORMATION_TABLE is $8400 in bank 11', MN.FORMATION_TABLE, 0x10 + 11 * 0x4000 + 0x400);
  // ⛔ $AFB6 is in the SWITCHABLE window with bank 12 mapped, not the fixed bank.
  instr(bankOf(12, 0xAFB6), [0xB1, 0x9C], '$AFB6  LDA ($9C),Y — the stat record source (bank 12)');
  eq('STAT_TABLE is $8520 in bank 12', MN.STAT_TABLE, 0x10 + 12 * 0x4000 + (0x8520 - 0x8000));
  eq('20 bytes per stat record', MN.STAT_STRIDE, 20);
  eq('id 58 sits exactly 58 records in',
     MN.STAT_TABLE + 58 * MN.STAT_STRIDE, 0x10 + 12 * 0x4000 + (0x89A8 - 0x8000));
  for (const c of MN.CONFIRMED) {
    eq(`id ${c.id} is "${c.name}"`, MN.monsterName(rom, c.id, F1.glyph), c.name);
  }
  eq('142 ids in 0..159 resolve to a name', MN.allMonsters(rom, F1.glyph, 160).length, 142);
  eq('...128 of them in the id range the battle uses', MN.allMonsters(rom, F1.glyph, 128).length, 128);
  eq('the last four are the fiends', MN.allMonsters(rom, F1.glyph, 128).slice(-4).map(m => m.name),
     ['KRAKEN', 'TIAMAT', 'TIAMAT', 'CHAOS']);

  // ⛔ FORMATION_MONSTER_OFF is the whole finding and NOTHING above catches it —
  // every byte-level check passes with it set to 3. The only thing that can tell
  // byte 2 from byte 3 is making a monster appear, so the gate fights one.
  const WORLD = zlib.gunzipSync(
    fs.readFileSync(path.join(HERE, 'states', 'ff1-world.state.gz'))).toString('utf8');
  const p2 = Uint8Array.from(rom);
  p2[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = 58;      // TIGER
  const nes2 = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes2.loadROM(Buffer.from(p2).toString('binary'));
  nes2.fromJSON(JSON.parse(WORLD));
  const run2 = (n) => { for (let i = 0; i < n; i++) nes2.frame(); };
  run2(20);
  nes2.cpu.mem[0x27] = 150; nes2.cpu.mem[0x28] = 170;    // $27/$28 ARE pokeable
  run2(20);
  const lines2 = () => {
    const v = nes2.ppu.vramMem, out = [];
    for (let r = 0; r < 30; r++) {
      let str = '';
      for (let c = 0; c < 32; c++) {
        const g = F1.glyph(v[0x2000 + r * 32 + c]);
        str += (g === null || g === '\n') ? ' ' : g;
      }
      if (str.trim()) out.push(str.trim());
    }
    return out;
  };
  let drew = null;
  const DIRS = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT];
  for (let step = 0; step < 300 && !drew; step++) {
    const btn = DIRS[Math.floor(step / 6) % 2];
    nes2.buttonDown(1, btn); run2(8); nes2.buttonUp(1, btn); run2(12);
    if (lines2().some(l => /\bRUN\b/.test(l))) drew = lines2().join(' ');
  }
  eq('patching formation byte 2 puts TIGER in a real battle',
     drew !== null && drew.includes('TIGER'), true);

  // ── the stat FIELDS ────────────────────────────────────────────────────────
  // ⛔ Every claim here is behavioural, so nothing but a real battle can pin it.
  // A byte-level check cannot tell "defense" from "evasion" — both make the
  // party's damage fall — so the two are separated by their SIGNATURE: evasion
  // drives it to zero, defense floors it above zero.
  const statFight = (patch, rounds) => {
    const pp = Uint8Array.from(rom);
    pp[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = 0;
    pp[MN.FORMATION_TABLE + 6] = 0x21;                 // exactly one enemy
    pp[MN.STAT_TABLE + 4] = 0xFF; pp[MN.STAT_TABLE + 5] = 0x0F;   // huge HP
    for (const [o, v] of Object.entries(patch)) pp[MN.STAT_TABLE + Number(o)] = v;
    const n = new NES({ onFrame: () => {}, onAudioSample: () => {} });
    n.loadROM(Buffer.from(pp).toString('binary'));
    n.fromJSON(JSON.parse(WORLD));
    const r = (k) => { for (let i = 0; i < k; i++) n.frame(); };
    r(20); n.cpu.mem[0x27] = 150; n.cpu.mem[0x28] = 170; r(20);
    const sc = () => {
      const v = n.ppu.vramMem, o = [];
      for (let row = 0; row < 30; row++) {
        let x = '';
        for (let c = 0; c < 32; c++) {
          const g = F1.glyph(v[0x2000 + row * 32 + c]);
          x += (g === null || g === '\n') ? ' ' : g;
        }
        if (x.trim()) o.push(x.trim());
      }
      return o;
    };
    for (let k = 0; k < 300; k++) {
      const b2 = DIRS[Math.floor(k / 6) % 2];
      n.buttonDown(1, b2); r(8); n.buttonUp(1, b2); r(12);
      if (sc().some(l => /\bRUN\b/.test(l))) break;
    }
    const party = () => {
      let t = 0;
      for (let i = 0; i < 4; i++) { const a2 = 0x610A + i * 0x40; t += n.cpu.mem[a2] | (n.cpu.mem[a2 + 1] << 8); }
      return t;
    };
    const hp0 = party();
    // ⛔ snapshot the enemy block BEFORE any rounds — after them the HP bytes
    // have been counted down and no longer match the record they came from.
    const ram = [...n.cpu.mem.slice(0x6BDC, 0x6BDC + 20)];
    for (let k = 0; k < rounds; k++) {
      n.buttonDown(1, Controller.BUTTON_A); r(6); n.buttonUp(1, Controller.BUTTON_A); r(20);
    }
    const enemyHp = n.cpu.mem[0x6BDC + 13] | (n.cpu.mem[0x6BDC + 14] << 8);
    return { dealt: 0x0FFF - enemyHp, taken: hp0 - party(), ram, patched: pp };
  };

  const baseStat = statFight({}, 80);
  // ⛔ compare against the PATCHED record this battle actually loaded, not the
  // stock one — statFight raises HP so the fight lasts, so bytes 4/5 differ.
  const loaded = [...baseStat.patched.slice(MN.STAT_TABLE, MN.STAT_TABLE + MN.STAT_STRIDE)];
  let permOk = true;
  for (const [romOff, ramOffs] of Object.entries(MN.ROM_TO_RAM)) {
    for (const ra of ramOffs) if (baseStat.ram[ra] !== loaded[Number(romOff)]) permOk = false;
  }
  eq('the ROM -> RAM scatter holds for every mapped byte', permOk, true);
  // ⛔ The loop above walks ROM_TO_RAM's OWN entries, so DELETING one makes it
  // check less and still pass. These pin the map's shape independently, written
  // out by hand from the measurement rather than read back off the table.
  eq('the scatter has 12 destinations across 11 source bytes',
     [Object.keys(MN.ROM_TO_RAM).length, Object.values(MN.ROM_TO_RAM).flat().length], [11, 12]);
  eq('ROM 4 lands in TWO RAM slots — max AND current HP', MN.ROM_TO_RAM[4].length, 2);
  eq('RAM 9 and RAM 13 both carry the HP low byte',
     [baseStat.ram[9], baseStat.ram[13]], [loaded[4], loaded[4]]);
  // ⛔ go through STAT_FIELDS, never a literal byte number — a gate that hardcodes
  // "12" cannot notice STAT_FIELDS.attack being changed to 11, which is exactly
  // what it is here to protect.
  eq('RAM 13 (current HP) starts at the HP field',
     baseStat.ram[13], loaded[MN.STAT_FIELDS.hp[0]]);
  eq('RAM 14 carries the HP high byte',
     baseStat.ram[14], loaded[MN.STAT_FIELDS.hp[1]]);
  eq('the party can hurt a baseline monster', baseStat.dealt > 0, true);

  // ⛔ 80 rounds is NOT enough for this one — the monster has not landed a blow
  // by then and both sides read 0, which looks like "no effect". Measured: the
  // signal appears at ~100 rounds (1 vs 35) and grows from there.
  eq('zeroing ATTACK (byte 12) reduces the damage the party takes',
     statFight({ [MN.STAT_FIELDS.attack]: 0 }, 110).taken <
     statFight({ [MN.STAT_FIELDS.attack]: 200 }, 110).taken, true);
  // evasion drives the party's damage to ZERO...
  eq('maxing EVADE (byte 8) drives the party\'s damage to zero',
     statFight({ [MN.STAT_FIELDS.evade]: 255 }, 80).dealt, 0);
  // ...while defense only floors it. This is the check that keeps the two apart.
  eq('maxing DEFENSE (byte 9) floors the party\'s damage ABOVE zero',
     statFight({ [MN.STAT_FIELDS.defense]: 255 }, 80).dealt > 0, true);

  // ── the rest of the record ────────────────────────────────────────────────
  // ⛔ these live in the SWITCHABLE window with bank 12 mapped, not the fixed bank
  const b12 = (a2, w, what) => instr(bankOf(12, a2), w, `$${a2.toString(16).toUpperCase()}  ${what} (bank 12)`);
  b12(0xA6C0, [0xAD, 0x6D, 0x68, 0x2D, 0x76, 0x68], 'LDA $686D / AND $6876 — mask 1 vs the defender');
  b12(0xA6C9, [0xAD, 0x6E, 0x68, 0x2D, 0x77, 0x68], 'LDA $686E / AND $6877 — mask 2');
  b12(0xA6D2, [0xAD, 0x5C, 0x68, 0x0D, 0x5E, 0x68, 0xF0], 'ORA / BEQ — either match takes the bonus');
  b12(0xA6DC, [0xA2, 0x28], 'LDX #$28         — ...worth x40');
  b12(0xA761, [0xAD, 0x71, 0x68, 0xAE, 0x70, 0x68, 0x20], 'LDA $6871 / LDX $6870 / JSR — the HITS multiply');
  b12(0xA85F, [0xAD, 0x73, 0x68, 0xF0], 'LDA $6873 / BEQ  — the STATUS gate');
  instr(bankOf(12, 0xB2A6), [0xA0, MN.STAT_FIELDS.special, 0xB1, 0x9C, 0xC9, MN.NO_SPECIAL],
        '$B2A6  LDY #$07 / LDA ($9C),Y / CMP #$FF — the SPECIAL byte (bank 12)');
  const sp = MN.specialsOf(rom);
  eq('46 monsters carry a special attack', sp.length, 46);
  eq('their ids run 0x00-0x2B with no gaps',
     [Math.min(...sp.map(x => x.special)), Math.max(...sp.map(x => x.special)),
      new Set(sp.map(x => x.special)).size], [0x00, 0x2B, 0x2C]);
  eq('CHAOS and ASTOS hold the last two',
     [MN.statValue(rom, 127, 'special'), MN.statValue(rom, 113, 'special')], [0x2A, 0x2B]);
  const crits = [...Array(128).keys()].map(i => MN.statValue(rom, i, 'crit'));
  eq('the CRIT byte reads like a rate, not a magnitude',
     [Math.min(...crits), Math.max(...crits)], [0, 70]);

  // ⛔ "Critical hit!!" is the only direct evidence the CRIT byte is a rate, so
  // the gate goes and makes the game print it.
  const critWords = (v) => {
    const pp = Uint8Array.from(rom);
    pp[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = 0;
    pp[MN.FORMATION_TABLE + 6] = 0x21;
    pp[MN.STAT_TABLE + 4] = 0xFF; pp[MN.STAT_TABLE + 5] = 0x0F;
    pp[MN.STAT_TABLE + MN.STAT_FIELDS.crit] = v;
    const n = new NES({ onFrame: () => {}, onAudioSample: () => {} });
    n.loadROM(Buffer.from(pp).toString('binary'));
    n.fromJSON(JSON.parse(WORLD));
    const r = (k) => { for (let i = 0; i < k; i++) n.frame(); };
    r(20); n.cpu.mem[0x27] = 150; n.cpu.mem[0x28] = 170; r(20);
    const sc = () => {
      const v2 = n.ppu.vramMem, o = [];
      for (let row = 0; row < 30; row++) {
        let x = '';
        for (let c = 0; c < 32; c++) {
          const g = F1.glyph(v2[0x2000 + row * 32 + c]);
          x += (g === null || g === '\n') ? ' ' : g;
        }
        if (x.trim()) o.push(x.trim());
      }
      return o;
    };
    for (let k = 0; k < 300; k++) {
      const b2 = DIRS[Math.floor(k / 6) % 2];
      n.buttonDown(1, b2); r(8); n.buttonUp(1, b2); r(12);
      if (sc().some(l => /\bRUN\b/.test(l))) break;
    }
    let saw = false;
    for (let k = 0; k < 110; k++) {
      n.buttonDown(1, Controller.BUTTON_A); r(6); n.buttonUp(1, Controller.BUTTON_A); r(20);
      if (sc().some(l => /Critical/.test(l))) saw = true;
    }
    return saw;
  };
  eq('maxing the CRIT byte makes the game print "Critical hit"', critWords(255), true);
  eq('...and at 0 it never does', critWords(0), false);

  // ── the property masks, proven by GIVING the party a weakness ─────────────
  // ⛔ A stock party has 0x00 in both weakness fields, so the AND never fires and
  // patching the monster alone looks like it does nothing. That is what made
  // these code-only until now. Poke the defender and the mechanism appears.
  b12(0xA5E6, [0xA0, MN.DEFENDER_WEAK_OFFS[0], 0xB1, 0x80], 'LDY #$0D / LDA ($80),Y — defender weakness 1');
  b12(0xA5ED, [0xA0, MN.DEFENDER_WEAK_OFFS[1], 0xB1, 0x80], 'LDY #$0E / LDA ($80),Y — defender weakness 2');
  b12(0xA6DC, [0xA2, MN.MASK_BONUS_X], 'LDX #$28         — MASK_BONUS_X');

  const maskFight = (partyWeak, rounds = 140) => {
    const pp = Uint8Array.from(rom);
    pp[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = 0;
    pp[MN.FORMATION_TABLE + 6] = 0x21;
    pp[MN.STAT_TABLE + 4] = 0xFF; pp[MN.STAT_TABLE + 5] = 0x0F;
    const n = new NES({ onFrame: () => {}, onAudioSample: () => {} });
    n.loadROM(Buffer.from(pp).toString('binary'));
    n.fromJSON(JSON.parse(WORLD));
    const r = (k) => { for (let i = 0; i < k; i++) n.frame(); };
    r(20); n.cpu.mem[0x27] = 150; n.cpu.mem[0x28] = 170; r(20);
    const sc = () => {
      const v2 = n.ppu.vramMem, o = [];
      for (let row = 0; row < 30; row++) {
        let x = '';
        for (let c = 0; c < 32; c++) {
          const g = F1.glyph(v2[0x2000 + row * 32 + c]);
          x += (g === null || g === '\n') ? ' ' : g;
        }
        if (x.trim()) o.push(x.trim());
      }
      return o;
    };
    for (let k = 0; k < 300; k++) {
      const b2 = DIRS[Math.floor(k / 6) % 2];
      n.buttonDown(1, b2); r(8); n.buttonUp(1, b2); r(12);
      if (sc().some(l => /\bRUN\b/.test(l))) break;
    }
    const party = () => { let t = 0; for (let i = 0; i < 4; i++) { const a2 = 0x610A + i * 0x40; t += n.cpu.mem[a2] | (n.cpu.mem[a2 + 1] << 8); } return t; };
    // ⛔ hold it — the game refreshes the defender block between rounds
    const poke = () => {
      for (let i = 0; i < 4; i++) for (const off of MN.DEFENDER_WEAK_OFFS) {
        n.cpu.mem[MN.DEFENDER_BASE + i * MN.DEFENDER_STRIDE + off] = partyWeak;
      }
    };
    poke();
    const h0 = party();
    for (let k = 0; k < rounds; k++) {
      poke(); n.buttonDown(1, Controller.BUTTON_A); r(6);
      poke(); n.buttonUp(1, Controller.BUTTON_A); r(20);
    }
    return h0 - party();
  };
  // IMP's byte 16 is 0x04. Only that bit should matter — in BOTH directions.
  const natural = MN.statValue(rom, 0, 'mask1');
  eq('IMP\'s mask is a single bit', [natural, natural & (natural - 1)], [0x04, 0]);
  const withBit = maskFight(natural);
  const withoutBit = maskFight((~natural) & 0xFF);
  eq('the party takes MORE damage carrying exactly the matching bit',
     withBit > withoutBit, true);
  eq('...and carrying every OTHER bit changes nothing',
     withoutBit, maskFight(0x00));

  // ── morale, and the three bytes nothing reads ─────────────────────────────
  b12(0xB23C, [0xA0, 0x09, 0xB1, 0x9A], 'LDY #$09 / LDA ($9A),Y — the morale byte');
  b12(0xB253, [0xC9, MN.MORALE_THRESHOLD], 'CMP #$50         — MORALE_THRESHOLD');
  eq('every monster is braver than the threshold',
     [...Array(128).keys()].every(i => MN.statValue(rom, i, 'morale') > MN.MORALE_THRESHOLD), true);

  // ⛔ the only proof morale is morale is the game SAYING so
  const ranAway = (v) => {
    const pp = Uint8Array.from(rom);
    pp[MN.FORMATION_TABLE + MN.FORMATION_MONSTER_OFF] = 0;
    pp[MN.FORMATION_TABLE + 6] = 0x21;
    pp[MN.STAT_TABLE + 4] = 0xFF; pp[MN.STAT_TABLE + 5] = 0x0F;
    pp[MN.STAT_TABLE + MN.STAT_FIELDS.morale] = v;
    const n = new NES({ onFrame: () => {}, onAudioSample: () => {} });
    n.loadROM(Buffer.from(pp).toString('binary'));
    n.fromJSON(JSON.parse(WORLD));
    const r = (k) => { for (let i = 0; i < k; i++) n.frame(); };
    r(20); n.cpu.mem[0x27] = 150; n.cpu.mem[0x28] = 170; r(20);
    const sc = () => {
      const v2 = n.ppu.vramMem, o = [];
      for (let row = 0; row < 30; row++) {
        let x = '';
        for (let c = 0; c < 32; c++) {
          const g = F1.glyph(v2[0x2000 + row * 32 + c]);
          x += (g === null || g === '\n') ? ' ' : g;
        }
        if (x.trim()) o.push(x.trim());
      }
      return o;
    };
    for (let k = 0; k < 300; k++) {
      const b2 = DIRS[Math.floor(k / 6) % 2];
      n.buttonDown(1, b2); r(8); n.buttonUp(1, b2); r(12);
      if (sc().some(l => /\bRUN\b/.test(l))) break;
    }
    let saw = false;
    for (let k = 0; k < 160; k++) {
      n.buttonDown(1, Controller.BUTTON_A); r(6); n.buttonUp(1, Controller.BUTTON_A); r(20);
      if (sc().some(l => /Run away/.test(l))) saw = true;
    }
    return saw;
  };
  eq('a monster below the threshold RUNS AWAY, and the game says so', ranAway(0), true);
  eq('...at its natural morale it stands and fights',
     ranAway(MN.statValue(rom, 0, 'morale')), false);

  // ⛔ "never read" is a claim about the ROM, so pin that these bytes still hold
  // real data — otherwise a table of zeroes would satisfy it just as well.
  eq('the unread offsets are 14, 17 and 19', MN.UNREAD_OFFSETS, [14, 17, 19]);
  const distinct = MN.UNREAD_OFFSETS.map(o =>
    new Set([...Array(128).keys()].map(i => MN.statRecord(rom, i)[o])).size);
  eq('...and they are NOT empty padding', distinct, [3, 62, 24]);
}

console.log(`\n${checks - fails}/${checks} checks passed`);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
