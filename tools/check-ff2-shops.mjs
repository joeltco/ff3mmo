#!/usr/bin/env node
// check-ff2-shops.mjs — FF2's shop tables stay decoded.
//
// Each constant in `lib/ff2-shops.mjs` is a claim about a specific instruction,
// so this compares it against the bytes at the address it cites. Then it opens
// four real shops and checks the names and prices the game DRAWS.
//
//   node tools/check-ff2-shops.mjs
//
// ⛔ Expectations are literal opcodes written out by hand from the listing.
// ⛔ The shop-object range is measured, not assumed: it is re-checked live by
// talking to 192 (a shop), 191 (the last dialogue type) and 222 (the inn).

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import * as F2 from './lib/ff2-text.mjs';
import * as S from './lib/ff2-shops.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROMP = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';
const rom = new Uint8Array(fs.readFileSync(ROMP));
const romBin = fs.readFileSync(ROMP, 'binary');
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff2-outside.state.gz'))).toString('utf8');

const bankOf = (n, a) => 0x10 + n * 0x4000 + (a - 0x8000);
const fixedOf = (a) => 0x10 + ((rom.length - 0x10) / 0x4000 - 1) * 0x4000 + (a - 0xC000);

let fails = 0, checks = 0;
function eq(what, got, want) {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fails++; console.log(`  FAIL  ${what}\n          got ${g}  want ${w}`); }
  else console.log(`  ok    ${what}`);
}
const instr = (off, want, what) => eq(what, [...rom.slice(off, off + want.length)], want);
const b14 = (a, want, what) => instr(bankOf(14, a), want, `$${a.toString(16).toUpperCase()}  ${what}`);
const fixed = (a, want, what) => instr(fixedOf(a), want, `$${a.toString(16).toUpperCase()}  ${what}`);

console.log('FF2 shop tables — the constants vs the instructions they claim\n');

console.log('the shop record load ($8E9B, bank 14)');
b14(0x8E9B, [0x0A, 0x0A, 0x0A], 'ASL A x3         — index * 8 = SHOP_STRIDE');
eq('SHOP_STRIDE is 8', S.SHOP_STRIDE, 8);
b14(0x8E9E, [0x18, 0x6D, 0x80, 0x83], 'CLC / ADC $8380  — the table base pointer');
eq('SHOP_TABLE_PTR is $8380 in bank 14', S.SHOP_TABLE_PTR, bankOf(14, 0x8380));
const basePtr = rom[S.SHOP_TABLE_PTR] | (rom[S.SHOP_TABLE_PTR + 1] << 8);
eq('...and it holds $860D', basePtr, 0x860D);
eq('SHOP_TABLE is that pointer in bank 14', S.SHOP_TABLE, bankOf(14, basePtr));
b14(0x8EAB, [0xA0, S.SHOP_COPY_LEN - 1], 'LDY #$0F         — SHOP_COPY_LEN bytes');
b14(0x8EAD, [0xB1, 0x80, 0x99, 0x00, 0x7B], 'LDA ($80),Y / STA $7B00,Y');
eq('SHOP_RAM is $7B00', S.SHOP_RAM, 0x7B00);
// ⛔ the copy is longer than the stride, so a shop's window holds the NEXT
// shop's record too. Only the first SHOP_STRIDE bytes are its own.
eq('the copy overruns the stride (that is why only 4 items are the shop\'s)',
   S.SHOP_COPY_LEN > S.SHOP_STRIDE, true);
eq('4 items of 2 bytes fill the stride', S.SHOP_ITEMS * 2, S.SHOP_STRIDE);

console.log('\nthe object-type classifier ($CBD5, fixed bank)');
fixed(0xCBD5, [0xA5, 0xA0], 'LDA $A0          — the object type');
fixed(0xCBD7, [0xC9, 0x60], 'CMP #$60         — HI_TABLE_FIRST');
fixed(0xCBDB, [0xC9, S.SHOP_TYPE_FIRST], 'CMP #$C0         — SHOP_TYPE_FIRST');
eq('SHOP_TYPE_FIRST is ff2-text\'s NO_HANDLER_FIRST', S.SHOP_TYPE_FIRST, F2.NO_HANDLER_FIRST);
eq('28 shops', S.SHOP_COUNT, 28);

console.log('\nthe tables resolve');
eq('PRICE_TABLE is $8000 in bank 14', S.PRICE_TABLE, bankOf(14, 0x8000));
eq('NAME_PTR_TABLE is $8200 in bank 10', S.NAME_PTR_TABLE, bankOf(10, 0x8200));
// A price code is not a price: the SAME code must give the SAME price for two
// items that are not the same item. 0xF2 is Axe and Mace, both 500 G.
eq('code 0xF2 is 500 G', S.priceForCode(rom, 0xF2), 500);
eq('code 0xE6 is 20 G', S.priceForCode(rom, 0xE6), 20);
eq('code 0xE4 is 40000 G', S.priceForCode(rom, 0xE4), 40000);
const s0 = S.shopAt(rom, 0, F2.glyph);
eq('shop 0 stocks 4 items', s0.items.length, 4);
eq('shop 0 item 0 is 0x3A at 150 G', [s0.items[0].id, s0.items[0].price], [0x3A, 150]);

// ── live ────────────────────────────────────────────────────────────────────
const OBJ_RAM = 0x7500, O_LIVE = 0, O_X = 2, O_Y = 3, O_X2 = 4, O_Y2 = 5, O_TYPE = 0x0A;
const B = { a: Controller.BUTTON_A, b: Controller.BUTTON_B, up: Controller.BUTTON_UP };
const strip = (s) => s.normalize('NFD').replace(/[゙゚]/g, '');

function talk(type, extraA) {
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(romBin);
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  const press = (k, h = 6, a = 16) => {
    nes.buttonDown(1, B[k]); run(h); nes.buttonUp(1, B[k]); run(a);
  };
  run(8); press('b'); press('b'); run(30);
  const m = nes.cpu.mem, px = m[0x68], py = m[0x69];
  for (let s = 1; s < 12; s++) m[OBJ_RAM + s * 0x10 + O_LIVE] = 0;
  m[OBJ_RAM + O_LIVE] = type; m[OBJ_RAM + O_TYPE] = type;
  m[OBJ_RAM + O_X] = px; m[OBJ_RAM + O_X2] = px;
  m[OBJ_RAM + O_Y] = py - 1; m[OBJ_RAM + O_Y2] = py - 1;
  run(10); press('up'); press('a', 6, 60);
  if (extraA) press('a', 6, 60);
  const v = nes.ppu.vramMem, rows = [], full = [];
  for (let r = 0; r < 30; r++) {
    let panel = '', whole = '';
    for (let c = 0; c < 32; c++) {
      const g = F2.glyph(v[0x2000 + r * 32 + c]);
      const ch = (g === null || g === '\n') ? ' ' : g;
      whole += ch;
      if (c >= 14) panel += ch;
    }
    // ⛔ the item panel is rows 3-11 / columns 14+, but the かう/うる MENU is
    // bottom-left. A window that only covers the panel reports every shop as
    // "not a shop".
    if (r >= 3 && r < 12 && panel.trim()) rows.push(strip(panel).trim());
    if (whole.trim()) full.push(strip(whole).trim());
  }
  return { rows, full, ram: [...nes.cpu.mem.slice(S.SHOP_RAM, S.SHOP_RAM + S.SHOP_STRIDE)] };
}

console.log('\nfour shops, opened for real');
for (const idx of [0, 8, 16, 27]) {
  const e = S.shopAt(rom, idx, F2.glyph);
  const { rows, ram } = talk(e.objType, true);
  eq(`shop ${String(idx).padStart(2)} loads its record into $7B00`, ram, e.raw);
  const drawn = rows.map(r => r.match(/^(.*?)\s+(\d+)\s*$/)).filter(Boolean)
    .map(m => ({ name: strip(m[1]).trim(), price: Number(m[2]) }));
  eq(`shop ${String(idx).padStart(2)} draws the table's prices`,
     drawn.map(d => d.price), e.items.map(i => i.price));
  eq(`shop ${String(idx).padStart(2)} draws the table's names`,
     drawn.map(d => d.name), e.items.map(i => strip(i.name)));
}

console.log('\nthe shop range itself, re-measured');
{
  // 192 opens a shop; 191 is still dialogue; 222 is the inn, not a shop.
  const shopish = (r) => r.full.some(l => /かう/.test(l)) && r.full.some(l => /うる/.test(l));
  eq('type 192 opens a shop', shopish(talk(S.SHOP_TYPE_FIRST, false)), true);
  eq('type 191 does NOT', shopish(talk(S.SHOP_TYPE_FIRST - 1, false)), false);
  const innR = talk(0xDE, false);
  const inn = innR.full.join(' ');
  eq('type 0xDE is the inn, not a shop', /とまり/.test(inn) && !shopish(innR), true);
  eq('...and the table says so', S.SPECIAL_TYPES[0xDE], 'INN');
}

// ── FF2's monster NAME table ────────────────────────────────────────────────
// ⛔ Not pinned to an instruction (FF2's battle code is not traced). Confirmed
// instead by the four monster-GUARD object types, which name their monster and
// then start the fight — four samples spread across the table, each agreeing
// with the guard's own dialogue.
console.log('\nmonster names, confirmed by the guards that summon them');
{
  const MN = await import('./lib/ff2-monsters.mjs');
  eq('128 names decode', MN.allMonsters(rom, F2.glyph).length, MN.NAME_COUNT);
  eq('the table ends with the four final bosses',
     MN.allMonsters(rom, F2.glyph).slice(-4).map(m => m.name),
     ['ティアマット', 'ベルゼブル', 'アスタロート', 'こうてい']);
  for (const c of MN.CONFIRMED) {
    eq(`index ${c.id} is ${c.name}`, MN.monsterName(rom, c.id, F2.glyph), c.name);
    const r = talk(c.type, false);
    const hay = r.full.map(l => l.replace(/\s/g, '')).join('|');
    eq(`...and guard type ${c.type} names it in its dialogue`,
       hay.includes(strip(c.name)), true);
  }
}

// ── FF2 monster STATS ───────────────────────────────────────────────────────
// ⛔ HP is not stored as a number anywhere. Record byte 0 is an INDEX into a
// shared 16-bit pool, which is why searching the whole ROM at every stride for
// "450" returns nothing. The gate pins the indirection, then proves it by
// fighting the monster and reading the HP the battle actually loaded.
console.log('\nmonster stats — an INDEX into a value pool, not a number');
{
  const MN = await import('./lib/ff2-monsters.mjs');
  const b12 = (a2, want, what) => instr(bankOf(12, a2), want,
    `$${a2.toString(16).toUpperCase()}  ${what} (bank 12)`);
  b12(0x9962, [0xA5, 0x04, 0x69, 0xC3], 'LDA $04 / ADC #$C3 — record base $87C3');
  b12(0x9972, [0x0A, 0x18, 0x69, 0xC3], 'ASL A / ADC #$C3   — idx*2 into the pool');
  b12(0x997A, [0x69, 0x8C], 'ADC #$8C           — ...the pool is $8CC3');
  b12(0x997E, [0xA0, 0x00, 0xB1, 0x78], 'LDY #$00 / LDA ($78),Y — the 16-bit value');
  b12(0x99B4, [0x20, 0x07, 0xFD], 'JSR $FD07          — the NIBBLE split');
  b12(0x9A3C, [0xE0, MN.ENEMY_RAM_STRIDE], 'CPX #$30           — 48 bytes per enemy');
  eq('STAT_TABLE is $87C4 in bank 12', MN.STAT_TABLE, bankOf(12, 0x87C4));
  eq('VALUE_POOL is $8CC3 in bank 12', MN.VALUE_POOL, bankOf(12, 0x8CC3));
  eq('10 bytes per record', MN.STAT_STRIDE, 10);
  eq('the Emperor has 10000 HP', MN.monsterHP(rom, 127), 10000);

  // live: the boss the type-73 guard summons must load the HP the table predicts
  const fightGuard = (patch, rounds = 0) => {
    const p2 = Uint8Array.from(rom);
    for (const [o, v] of Object.entries(patch)) p2[MN.STAT_TABLE + 11 * MN.STAT_STRIDE + Number(o)] = v;
    const n = new NES({ onFrame: () => {}, onAudioSample: () => {} });
    n.loadROM(Buffer.from(p2).toString('binary'));
    n.fromJSON(JSON.parse(SNAP));
    const r = (k) => { for (let i = 0; i < k; i++) n.frame(); };
    const pr = (k, h = 6, a2 = 16) => { n.buttonDown(1, B[k]); r(h); n.buttonUp(1, B[k]); r(a2); };
    r(8); pr('b'); pr('b'); r(30);
    const mm = n.cpu.mem, px = mm[0x68], py = mm[0x69];
    for (let sl = 1; sl < 12; sl++) mm[0x7500 + sl * 0x10] = 0;
    mm[0x7500] = 73; mm[0x750A] = 73;
    mm[0x7502] = px; mm[0x7504] = px; mm[0x7503] = py - 1; mm[0x7505] = py - 1;
    r(10); pr('up'); pr('a', 6, 120);
    for (let k = 0; k < 8; k++) pr('a', 6, 60);
    const readHp = () => n.cpu.mem[MN.ENEMY_RAM + MN.RAM_HP_OFF] |
                         (n.cpu.mem[MN.ENEMY_RAM + MN.RAM_HP_OFF + 1] << 8);
    const atStart = readHp();
    if (!rounds) return atStart;
    for (let k = 0; k < rounds * 15; k++) {
      n.buttonDown(1, Controller.BUTTON_A); r(6); n.buttonUp(1, Controller.BUTTON_A); r(20);
    }
    return { atStart, after: readHp() };
  };
  eq('the guard-73 boss loads the HP the pool predicts',
     fightGuard({}), MN.monsterHP(rom, 11));
  // ⛔ index through STAT_FIELDS.hp, never a literal 0 — otherwise moving the
  // field constant would change nothing the gate looks at.
  const altIdx = rom[MN.STAT_TABLE + 79 * MN.STAT_STRIDE];      // Red Soul's HP index
  eq('repointing the HP INDEX changes the HP the battle loads',
     fightGuard({ [MN.STAT_FIELDS.hp]: altIdx }), MN.monsterHP(rom, 79));
  // ⛔ RAM_HP_OFF cannot be pinned by its VALUE: $7E48 holds the max-HP
  // duplicate, so 0x14 and 0x18 read the same number in a fresh battle. Only
  // hitting the monster separates current HP from max.
  // the four nibble tables: their SHAPE is the evidence for what they hold
  const T = MN.NIBBLE_TABLES.map(t => MN.nibbleTable(rom, t));
  eq('$8D13 is a percentage ladder 0..100 then 255', T[1],
     [0, 10, 20, 30, 40, 50, 60, 65, 70, 75, 80, 85, 90, 95, 100, 255]);
  eq('$8D03 is small counts', T[0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 255]);
  eq('$8D23 is a magnitude curve', [T[2][0], T[2][15], T[2].every((v, i, a2) => i === 0 || v > a2[i - 1])],
     [0, 210, true]);
  // a mask table is not monotonic and is full of single-bit and paired-bit values
  eq('$8D33 is bit masks, not a ladder',
     [T[3][1], T[3][2], T[3][3], T[3].every((v, i, a2) => i === 0 || v > a2[i - 1])],
     [129, 65, 17, false]);

  // the damage formula names ATTACK, DEFENCE and the weakness masks
  b12(0xB084, [0xA0, MN.RAM_ATTACK_OFF, 0xB1, 0x9F], 'LDY #$1A / LDA ($9F),Y — base damage');
  b12(0xB092, [0xA0, MN.RAM_WEAKNESS_OFFS[0], 0x31, 0xA1], 'LDY #$15 / AND ($A1),Y — mask 1');
  b12(0xB09C, [0xA0, MN.RAM_WEAKNESS_OFFS[1], 0x31, 0xA1], 'LDY #$16 / AND ($A1),Y — mask 2');
  b12(0xB0A3, [0xA5, 0x44, 0x69, MN.WEAKNESS_BONUS], 'LDA $44 / ADC #$14 — a match is worth +20');
  b12(0xB0AF, [0xA0, MN.RAM_DEFENCE_OFF, 0xB1, 0xA1], 'LDY #$02 / LDA ($A1),Y — the defender\'s DEFENCE');
  eq('the Emperor is the strongest thing in the game',
     [MN.monsterHP(rom, 127), MN.monsterAttack(rom, 127), MN.monsterDefence(rom, 127)],
     [10000, 180, 210]);
  eq('...and the Leg Eater the weakest',
     [MN.monsterHP(rom, 0), MN.monsterAttack(rom, 0), MN.monsterDefence(rom, 0)], [6, 4, 0]);

  // ⛔ live, because a byte check cannot tell ATTACK from DEFENCE — both sit in
  // the same magnitude table, one nibble apart.
  const combat = (patch, rounds) => {
    const p2 = Uint8Array.from(rom);
    for (const [o, v] of Object.entries(patch)) p2[MN.STAT_TABLE + 11 * MN.STAT_STRIDE + Number(o)] = v;
    const n = new NES({ onFrame: () => {}, onAudioSample: () => {} });
    n.loadROM(Buffer.from(p2).toString('binary'));
    n.fromJSON(JSON.parse(SNAP));
    const r = (k) => { for (let i = 0; i < k; i++) n.frame(); };
    const pr = (k, h = 6, a2 = 16) => { n.buttonDown(1, B[k]); r(h); n.buttonUp(1, B[k]); r(a2); };
    r(8); pr('b'); pr('b'); r(30);
    const mm = n.cpu.mem, px = mm[0x68], py = mm[0x69];
    for (let sl = 1; sl < 12; sl++) mm[0x7500 + sl * 0x10] = 0;
    mm[0x7500] = 73; mm[0x750A] = 73;
    mm[0x7502] = px; mm[0x7504] = px; mm[0x7503] = py - 1; mm[0x7505] = py - 1;
    r(10); pr('up'); pr('a', 6, 120);
    for (let k = 0; k < 8; k++) pr('a', 6, 60);
    const party = () => { let t = 0; for (let i = 0; i < 4; i++) { const a2 = 0x615D + i * 0x40; t += mm[a2] | (mm[a2 + 1] << 8); } return t; };
    const eh = () => mm[MN.ENEMY_RAM + MN.RAM_HP_OFF] | (mm[MN.ENEMY_RAM + MN.RAM_HP_OFF + 1] << 8);
    const p0 = party(), e0 = eh();
    for (let k = 0; k < rounds; k++) {
      n.buttonDown(1, Controller.BUTTON_A); r(6); n.buttonUp(1, Controller.BUTTON_A); r(20);
    }
    return { taken: p0 - party(), dealt: e0 - eh() };
  };
  const atkByte = rom[MN.STAT_TABLE + 11 * MN.STAT_STRIDE + MN.STAT_FIELDS.attackByte];
  const defByte = rom[MN.STAT_TABLE + 11 * MN.STAT_STRIDE + MN.STAT_FIELDS.defenceByte];
  eq('zeroing the ATTACK nibble stops the party taking damage at all',
     combat({ [MN.STAT_FIELDS.attackByte]: MN.loNibble(atkByte) }, 200).taken, 0);
  eq('zeroing the DEFENCE nibble multiplies the damage the party deals',
     combat({ [MN.STAT_FIELDS.defenceByte]: MN.loNibble(defByte) }, 200).dealt > 30, true);

  // ⛔ EVASION and DEFENCE cannot be told apart by a byte check either — the
  // signature is what separates them: evasion reaches ZERO, defence floors above
  // it. Both are asserted so the pair cannot be swapped silently.
  const evByte = rom[MN.STAT_TABLE + 11 * MN.STAT_STRIDE + MN.STAT_FIELDS.evadeByte];
  eq('maxing the EVADE nibble drives the party\'s damage to zero',
     combat({ [MN.STAT_FIELDS.evadeByte]: 0xF0 | MN.loNibble(evByte) }, 200).dealt, 0);
  eq('...while maxing DEFENCE only floors it above zero',
     combat({ [MN.STAT_FIELDS.defenceByte]: 0xF0 | MN.loNibble(defByte) }, 200).dealt > 0, true);
  eq('the EVADE nibble is the HIGH one — the low one does nothing',
     combat({ [MN.STAT_FIELDS.evadeByte]: (evByte & 0xF0) | 0x0F }, 200).dealt > 0, true);
  // ⛔ Byte 2 ALSO zeroes the party's damage when maxed, so "maxing it reaches
  // zero" cannot tell byte 4 from byte 2. What separates them: ZEROING byte 4
  // leaves the fight completely normal, while zeroing byte 2 stops the monster
  // acting at all. Without this the evadeByte constant could be moved to 2 and
  // every other check still passed.
  eq('zeroing the EVADE byte leaves the monster fighting normally',
     combat({ [MN.STAT_FIELDS.evadeByte]: 0x00 }, 200).taken > 0, true);

  // the bytes nothing consumes
  eq('byte 9 is never read', MN.UNREAD_OFFSETS, [9]);
  eq('byte 8 is loaded but its results go nowhere', MN.LOADED_BUT_UNUSED, [8]);
  const distinct = (o) => new Set([...Array(128).keys()].map(i => MN.statRecord(rom, i)[o])).size;
  // ⛔ "unused" must not be satisfiable by a table of zeroes
  eq('...and neither is empty padding', [distinct(8), distinct(9)], [44, 58]);
  eq('patching byte 9 changes nothing',
     combat({ 9: 0xFF }, 200).dealt, combat({ 9: 0x00 }, 200).dealt);

  const hit = fightGuard({}, 14);
  eq('the byte at RAM_HP_OFF goes DOWN when the monster is hit',
     hit.after < hit.atStart, true);
}

console.log(`\n${checks - fails}/${checks} checks passed`);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
