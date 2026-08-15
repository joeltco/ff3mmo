#!/usr/bin/env node
// check-ff3-shops.mjs — FF3's shop tables stay decoded.
//
// Each constant in `lib/ff3-shops.mjs` is a claim about a specific instruction,
// so this compares it against the bytes at the address it cites. Then it opens
// four real shops and checks the names and prices the game DRAWS.
//
//   node tools/check-ff3-shops.mjs
//
// ⛔ Expectations are literal opcodes written out by hand from the listing.
// ⛔ The set of shop-opening ids is MEASURED, not derived — four ids with
// well-formed records open nothing, and that is re-checked live here.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';

const { glyph } = await import('./lib/ff3-text.mjs');
const S = await import('./lib/ff3-shops.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROMP = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
const rom = new Uint8Array(fs.readFileSync(ROMP));
const SNAP = zlib.gunzipSync(
  fs.readFileSync(path.join(HERE, 'states', 'ff3-freeroam.state.gz'))).toString('utf8');

// MMC3: 8KB banks. file = bank*0x2000 + 0x10 + (addr - window base)
const at = (bank, addr, winBase) => bank * 0x2000 + 0x10 + (addr - winBase);

let fails = 0, checks = 0;
function eq(what, got, want) {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fails++; console.log(`  FAIL  ${what}\n          got ${g}  want ${w}`); }
  else console.log(`  ok    ${what}`);
}
const instr = (bank, addr, winBase, want, what) =>
  eq(`${bank.toString(16).toUpperCase()}/${addr.toString(16).toUpperCase()}  ${what}`,
     [...rom.slice(at(bank, addr, winBase), at(bank, addr, winBase) + want.length)], want);

console.log('FF3 shop tables — the constants vs the instructions they claim\n');

console.log('the record load (3F, the fixed high bank)');
instr(0x3F, 0xEA1B, 0xE000, [0xA0, S.SHOP_COPY_LEN - 1], 'LDY #$3F        — SHOP_COPY_LEN');
instr(0x3F, 0xEA1D, 0xE000, [0xB1, 0x82, 0x99, 0x00, 0x7B], 'LDA ($82),Y / STA $7B00,Y');
eq('SHOP_RAM is $7B00', S.SHOP_RAM, 0x7B00);
instr(0x3F, 0xEA0B, 0xE000, [0xA9, 0x00, 0x85, 0x80], 'LDA #$00 / STA $80 — the table is PAGE-ALIGNED');

console.log('\nthe item slots (3D)');
instr(0x3D, 0xB220, 0xA000, [0xA2, S.SHOP_ITEMS_MAX - 1], 'LDX #$07        — SHOP_ITEMS_MAX');
instr(0x3D, 0xB222, 0xA000, [0xBD, 0x01, 0x7B, 0x9D, 0x80, 0x7B], 'LDA $7B01,X / STA $7B80,X');
instr(0x3D, 0xB230, 0xA000, [0x20, 0xD4, 0xF5], 'JSR $F5D4       — item id -> price');

console.log('\nthe price table (3F/F5D4)');
instr(0x3F, 0xF5D4, 0xE000, [0xA9, 0x10], 'LDA #$10        — the price bank');
instr(0x3F, 0xF5D9, 0xE000, [0x8A, 0x0A, 0xAA], 'TXA / ASL A / TAX — two bytes per item');
instr(0x3F, 0xF5DC, 0xE000, [0xB0, 0x0B], 'BCS +           — ids >= $80 continue');
instr(0x3F, 0xF5DE, 0xE000, [0xBD, 0x00, 0x9E], 'LDA $9E00,X     — PRICE_TABLE');
instr(0x3F, 0xF5E9, 0xE000, [0xBD, 0x00, 0x9F], 'LDA $9F00,X     — ...its second page');
eq('PRICE_TABLE is $9E00 in bank 16', S.PRICE_TABLE, at(16, 0x9E00, 0x8000));
eq('the two price pages are contiguous', at(16, 0x9F00, 0x8000) - at(16, 0x9E00, 0x8000), 0x100);
instr(0x3F, 0xF5F3, 0xE000, [0xA9, 0x00, 0x85, 0x82], 'LDA #$00 / STA $82 — so a price is 16-bit');

console.log('\nthe tables resolve to the right data');
eq('SHOP_PTR_TABLE is $8200 in bank 44', S.SHOP_PTR_TABLE, at(44, 0x8200, 0x8000));
eq('NAME_PTR_TABLE is $8800 in bank 24', S.NAME_PTR_TABLE, at(24, 0x8800, 0x8000));
eq('Knife (0x1E) costs 20 G', S.priceForItem(rom, 0x1E), 20);
// ⛔ 0x93 is DiamndBrc, not DiamondMa — this expectation was written from a
// guess at the id and the gate caught it. Both are pinned now, from the id
// order in shop 241's record.
eq('DiamondMa (0x84) costs 33000 G', S.priceForItem(rom, 0x84), 33000);
eq('DiamndBrc (0x93) costs 10000 G', S.priceForItem(rom, 0x93), 10000);
eq('item 0x1E is named Knife', S.itemName(rom, 0x1E, glyph), 'Knife');
const s231 = S.shopAt(rom, 231, glyph);
eq('shop 231 is a Weapons shop', [s231.kindByte, s231.kind], [7, 'Weapons']);
eq('shop 231 stocks 5 items', s231.items.map(i => i.id), [0x1E, 0x1F, 0x24, 0x0E, 0x06]);
// ⛔ a record with all 8 slots used has NO terminator; the reader must stop on
// count, not only on the zero.
eq('shop 228 fills all 8 slots', S.shopAt(rom, 228, glyph).items.length, S.SHOP_ITEMS_MAX);
eq('21 shops', S.SHOP_NPC_IDS.length, 21);

// ── live ────────────────────────────────────────────────────────────────────
const D = { up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
            left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT, a: Controller.BUTTON_A };
const SHOPKEEPER_ID_OFF = 0x595F2, SHOP_MAP = 5, STAND = [3, 24];

function openShop(id) {
  const p = Uint8Array.from(rom); p[SHOPKEEPER_ID_OFF] = id;
  const nes = new NES({ onFrame: () => {}, onAudioSample: () => {} });
  nes.loadROM(Buffer.from(p).toString('binary'));
  nes.fromJSON(JSON.parse(SNAP));
  const run = (n) => { for (let i = 0; i < n; i++) nes.frame(); };
  const press = (k, h = 16, a = 16) => {
    nes.buttonDown(1, D[k]); run(h); nes.buttonUp(1, D[k]); run(a);
  };
  run(8);
  for (let f = 0; f < 240; f++) {
    nes.cpu.mem[0x0700] = SHOP_MAP; nes.cpu.mem[0x00AB] = 0x80;
    nes.frame();
    if (nes.cpu.mem[0x00AB] !== 0x80) break;
  }
  run(180);
  for (let i = 0; i < 10; i++) {
    const x = nes.cpu.mem[0x68], y = nes.cpu.mem[0x69];
    if (x === STAND[0] && y === STAND[1]) break;
    if (y > STAND[1]) press('up'); else if (y < STAND[1]) press('down');
    else if (x > STAND[0]) press('left'); else if (x < STAND[0]) press('right');
    else break;
  }
  press('up'); press('a', 8, 90); press('a', 8, 90);
  const v = nes.ppu.vramMem, lines = [];
  for (let r = 0; r < 30; r++) {
    let s = '';
    for (let c = 0; c < 32; c++) { const g = glyph(v[0x2000 + r * 32 + c]); s += (g === null ? ' ' : g); }
    if (s.trim()) lines.push(s.replace(/\s+/g, ' ').trim());
  }
  const rows = [];
  for (const l of lines) {
    const m = l.match(/^(.*?[A-Za-z?].*?)\s+(\d+)$/);
    if (m && !/you buy|How many|^1 4 10/.test(l)) rows.push({ name: m[1].replace(/\s+/g, ''), price: Number(m[2]) });
  }
  const kl = lines.find(l => /you buy,/.test(l));
  return { rows, lines,
           kind: kl ? kl.replace(/\s*you buy,.*/, '').replace(/^What will\s*/, '').trim() : null,
           ram: [...nes.cpu.mem.slice(S.SHOP_RAM, S.SHOP_RAM + 10)] };
}

console.log('\nfour shops, opened for real');
for (const id of [227, 231, 238, 251]) {
  const e = S.shopAt(rom, id, glyph);
  const got = openShop(id);
  eq(`shop ${id} draws "${e.kind}"`, got.kind, e.kind);
  eq(`shop ${id} loads its record into $7B00`,
     got.ram.slice(0, 1 + e.items.length), [e.kindByte, ...e.items.map(i => i.id)]);
  eq(`shop ${id} draws the table's prices`, got.rows.map(r => r.price), e.items.map(i => i.price));
  // ⛔ some glyph bytes are unmapped ("Blizzard" draws as "B zzard"), so names
  // are compared with spaces removed. Prices above are exact.
  eq(`shop ${id} draws the table's names`,
     got.rows.map(r => r.name), e.items.map(i => i.name.replace(/\s/g, '')));
}

console.log('\nthe ids that have a record but open NOTHING');
for (const id of [232, 239, 244, 250]) {
  eq(`id ${id} has a record...`, S.shopAt(rom, id).items.length > 0, true);
  eq(`...but opens no shop, and is not in SHOP_NPC_IDS`,
     [openShop(id).kind, S.SHOP_NPC_IDS.includes(id)], [null, false]);
}

// ── FF3's monster tables, checked against the game rather than a wiki ───────
// ⛔ `gen-monsters-js.js` takes its layout from the Data Crystal ROM map. This
// puts the parts that CAN be checked in front of the running game, and leaves
// the rest labelled inherited.
console.log('\nmonster tables — measured, not cited');
{
  const M3 = await import('./lib/ff3-monsters.mjs');
  const D = [Controller.BUTTON_LEFT, Controller.BUTTON_RIGHT,
             Controller.BUTTON_UP, Controller.BUTTON_DOWN];
  const fight = (patch, rounds) => {
    const p2 = Uint8Array.from(rom);
    for (const [o, v] of Object.entries(patch)) p2[Number(o)] = v;
    const n = new NES({ onFrame: () => {}, onAudioSample: () => {} });
    n.loadROM(Buffer.from(p2).toString('binary'));
    n.fromJSON(JSON.parse(SNAP));
    const r = (k) => { for (let i = 0; i < k; i++) n.frame(); };
    r(30);
    const tx = () => {
      const v2 = n.ppu.vramMem, o = [];
      for (let row = 0; row < 30; row++) {
        let x = '';
        for (let c = 0; c < 32; c++) { const g = glyph(v2[0x2000 + row * 32 + c]); x += (g === null ? ' ' : g); }
        if (x.trim()) o.push(x.replace(/\s+/g, ' ').trim());
      }
      return o;
    };
    let inB = false;
    for (let st = 0; st < 400 && !inB; st++) {
      const b2 = D[Math.floor(st / 8) % 4];
      n.buttonDown(1, b2); r(10); n.buttonUp(1, b2); r(12);
      if (tx().some(l => /Guard|Item/i.test(l))) inB = true;
    }
    const php = () => { let t = 0; for (const l of tx()) for (const m of l.matchAll(/(\d+)\/\s*(\d+)/g)) t += Number(m[1]); return t; };
    const p0 = php();
    const ehp = n.cpu.mem[M3.ENEMY_RAM] | (n.cpu.mem[M3.ENEMY_RAM + 1] << 8);
    for (let k = 0; k < rounds; k++) {
      n.buttonDown(1, Controller.BUTTON_A); r(8); n.buttonUp(1, Controller.BUTTON_A); r(18);
    }
    const holding = [];
    for (let ad = 0x6000; ad < 0x8000 - 1; ad++) {
      if ((n.cpu.mem[ad] | (n.cpu.mem[ad + 1] << 8)) === ehp) holding.push(ad);
    }
    return { inB, enemyHP: ehp, taken: p0 - php(), holding };
  };

  // HP: patch it and the battle must load exactly that number
  const hp300 = fight({ [M3.MONSTER_PROPS + 1]: 0x2C, [M3.MONSTER_PROPS + 2]: 0x01 }, 0);
  eq('an encounter starts at all', hp300.inB, true);
  eq('patching props +1/+2 sets the HP the battle loads', hp300.enemyHP, 300);
  // ⛔ ENEMY_RAM cannot be pinned by "some address holds 300" — the second enemy
  // slot at +0x40 holds it too, and moving the base by one stride passed. Pin it
  // as the LOWEST address that does.
  eq('ENEMY_RAM is the first slot, not the second',
     Math.min(...hp300.holding), M3.ENEMY_RAM);
  eq('...and the next slot is one stride on',
     hp300.holding.includes(M3.ENEMY_RAM + M3.ENEMY_RAM_STRIDE), true);
  const hp400 = fight({ [M3.MONSTER_PROPS + 1]: 0x90, [M3.MONSTER_PROPS + 2]: 0x01 }, 0);
  eq('...and again at a different value', hp400.enemyHP, 400);
  eq('the table agrees with the ROM for id 0', M3.monsterHP(rom, 0), 5);

  // ATTACK: props +9 indexes the stat table; byte 2 of that entry is the damage
  const atkIdx = rom[M3.MONSTER_PROPS + M3.VERIFIED_FIELDS.atkHitIdx];
  const atkByteAddr = M3.STAT_TABLE + atkIdx * M3.STAT_ENTRY + M3.STAT_ATK_OFF;
  const bigHP = { [M3.MONSTER_PROPS + 1]: 0xFF, [M3.MONSTER_PROPS + 2]: 0x0F };
  const base = fight({ ...bigHP }, 90);
  const weak = fight({ ...bigHP, [atkByteAddr]: 0 }, 90);
  const strong = fight({ ...bigHP, [atkByteAddr]: 255 }, 90);
  // ⛔ "raising it raises the damage" is NOT enough to pick byte 2 out of the
  // entry — byte 0 raises it too, and the revert to STAT_ATK_OFF = 0 passed.
  // What separates byte 2: zeroing it drops the damage BELOW baseline, while
  // zeroing byte 0 pushes it ABOVE. Both halves are asserted.
  eq('zeroing the ATTACK byte drops the damage BELOW baseline', weak.taken < base.taken, true);
  eq('...and maxing it pushes it above', strong.taken > base.taken, true);
  const rollAddr = M3.STAT_TABLE + atkIdx * M3.STAT_ENTRY + M3.STAT_ROLL_OFF;
  eq('zeroing the ROLL byte does NOT drop it below baseline — that is what makes it a different field',
     fight({ ...bigHP, [rollAddr]: 0 }, 90).taken >= base.taken, true);

  // ⛔ defence and evade are NOT verified — the party cannot damage a Goblin, so
  // there is no signal for them to move. Pinned as inherited so nobody reads the
  // module as claiming more than was measured.
  eq('defEvdIdx is still labelled inherited, not verified',
     [M3.INHERITED_FIELDS.defEvdIdx, M3.VERIFIED_FIELDS.defEvdIdx], [12, undefined]);
}

console.log(`\n${checks - fails}/${checks} checks passed`);
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
