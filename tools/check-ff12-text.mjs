#!/usr/bin/env node
// check-ff12-text.mjs — FF1's and FF2's scripts stay decoded.
//
// Both decoders are anchored on text read off a RUNNING game, not on the
// decoder agreeing with itself:
//
//   FF1 — a Coneria Castle guard displayed "The King is looking for the LIGHT
//         WARRIORS. You do not happen to be them, do you?" That box IS
//         string 49, and object type 49 is on map 0, which is what fixes
//         `dialogueId == objType`.
//   FF2 — Altair's verb menu displayed たずねる / おぼえる / アイテム as tile
//         indices 99 96 a1 b2 / 8e a7 8d b2 / ca cb dc ea, which fixes
//         hiragana at 0x8A and katakana at 0xCA.
//
//   node tools/check-ff12-text.mjs
//
// Skips cleanly when the reference ROMs are not present.

import fs from 'node:fs';

const FF1 = process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes';
const FF2 = process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes';
if (!fs.existsSync(FF1) || !fs.existsSync(FF2)) {
  console.log('check-ff12-text: SKIP (reference ROMs not present)');
  process.exit(0);
}

const F1 = await import('./lib/ff1-text.mjs');
const F2 = await import('./lib/ff2-text.mjs');

let failed = 0, mark = 0;
const bad = (m) => { console.error('  ✗ ' + m); failed++; };
const since = () => { const c = failed === mark; mark = failed; return c; };
const ok = (m) => console.log('  ✓ ' + m);

// ══ FF1 ═══════════════════════════════════════════════════════════════════
{
  const rom = F1.loadRom(FF1);
  since();

  // 1. the DTE table — reversed halves, which every naive search misses
  const dte = F1.buildDte(rom);
  const want = { 0: 'e ', 2: 'th', 5: 'in', 12: 'ou', 39: 'ha' };
  for (const [i, v] of Object.entries(want)) {
    if (dte[i] !== v) bad(`FF1 DTE entry ${i} is "${dte[i]}", expected "${v}"`);
  }
  if (dte.filter(p => p.includes('?')).length > 2) {
    bad('FF1 DTE table has unreadable entries — the two halves have drifted apart');
  }
  if (since()) ok(`FF1 DTE decodes (${F1.DTE_COUNT} entries, seconds @0x3F060 / firsts @0x3F0B0)`);

  // 2. the exact line the running game displayed
  const line = F1.decodeString(rom, 49, { nl: ' ' });
  if (!/^The King is looking for the LIGHT WARRIORS\. You do not happen to be them/.test(line)) {
    bad(`FF1 string 49 decodes to "${line.slice(0, 70)}…" — not the box the game displayed`);
  } else ok('FF1 string 49 matches the line read off the running game');
  since();

  // 3. the map object table, and dialogueId == objType
  let objs = 0, badY = 0, maps = 0;
  for (let m = 0; m < 64; m++) {
    const o = F1.mapObjects(rom, m);
    if (!o.length) continue;
    if (o.some(e => e.y > 63)) { badY++; continue; }
    maps++; objs += o.length;
  }
  if (badY > 0) bad(`FF1 map object table: ${badY} maps have objects with Y>63 — the table has moved`);
  if (objs < 250) bad(`FF1 map object table yields only ${objs} objects, expected ~290`);
  const m0 = F1.mapObjects(rom, 0);
  if (!m0.some(o => o.type === 49)) bad('FF1 map 0 has no object type 49 — the guard that was measured');
  if (since()) ok(`FF1 map objects: ${objs} across ${maps} maps, all Y<=63; map 0 carries type 49`);

  // 4. the named cast still names itself
  const NAMED = [[59, /^I am Jane, Queen of/], [160, /^I am Lukahn/],
                 [139, /^I am Jim\./], [71, /^I am Arylon/], [177, /^My name is Kope/]];
  for (const [id, re] of NAMED) {
    if (!re.test(F1.decodeString(rom, id))) bad(`FF1 object ${id} no longer names itself`);
  }
  if (since()) ok(`FF1 named cast intact: Jane, Lukahn, Jim, Arylon, Kope`);
}

// ══ FF2 ═══════════════════════════════════════════════════════════════════
{
  const rom = F2.loadRom(FF2);
  since();

  // 1. the verb menu read off the screen in Altair
  const MENU = [[[0x99, 0x96, 0xa1, 0xb2], 'たずねる'], // dakuten not stored per-glyph
                [[0x8e, 0xa7, 0x8d, 0xb2], 'おぼえる'],
                [[0xca, 0xcb, 0xdc, 0xea], 'アイテム']];
  for (const [bytes, label] of MENU) {
    const got = bytes.map(b => F2.glyph(b)).join('');
    // the dakuten marks are not part of the glyph byte, so compare bare kana
    const bare = label.replace(/[゙゚]/g, '')
      .replace(/ず/, 'す').replace(/ぼ/, 'ほ');
    if (got !== bare) bad(`FF2 menu word ${label} decodes as "${got}", expected "${bare}"`);
  }
  if (since()) ok('FF2 kana tables reproduce the verb menu read off the screen');

  // 2. ん lives at 0xB6 — the run is 45 kana, not 46
  if (F2.glyph(0xB6) !== 'ん') {
    bad(`FF2 0xB6 decodes as "${F2.glyph(0xB6)}", not ん — the を-less 45-kana run has drifted`);
  } else if (F2.HIRAGANA.includes('を')) {
    bad('FF2 hiragana run contains を — it must not; that shifts every kana past わ');
  } else ok('FF2 0xB6 is ん (45-kana run, no を)');

  // 3. the script actually decodes
  let good = 0, total = 0;
  for (let id = 0; id < 400; id++) {
    const r = F2.literalRatio(rom, id);
    if (r > 0) { total++; if (r >= 0.6) good++; }
  }
  if (!total) bad('FF2 string table decodes nothing — the pointer table has moved');
  else if (good / total < 0.6) {
    bad(`only ${good}/${total} FF2 strings are >=60% kana — the encoding has drifted`);
  } else ok(`FF2 script decodes: ${good}/${total} strings >=60% literal kana`);

  // 4. the map object table + dialogueId == objType
  //
  // MEASURED: standing in the throne room and talking produced
  // 【ヒルダ】「あいことばは【のばら】です。よく おぼえておくのよ。」 — string 1
  // of the 0x18010 table — and that map's object list starts with type 1.
  {
    let objs = 0, maps = 0;
    for (const { base, maps: n } of F2.MAPOBJ_BLOCKS) {
      for (let m = 0; m < n; m++) {
        const o = F2.mapObjects(rom, base, m);
        if (o.length) { maps++; objs += o.length; }
        if (o.some(e => e.y > 63)) bad(`FF2 block 0x${base.toString(16)} map ${m} has Y>63 — the table has moved`);
      }
    }
    if (objs < 280) bad(`FF2 map objects yield only ${objs}, expected ~311`);
    // read the base from the CONSTANT, not a literal — otherwise shifting
    // MAPOBJ_BLOCKS silently still passes.
    const hilda = F2.mapObjects(rom, F2.MAPOBJ_BLOCKS[0].base, 4);
    if (!hilda.length || hilda[0].type !== 1) {
      bad('FF2 0x3510 map 4 does not start with object type 1 — the block base has drifted');
    }
    // ...and anchor the SECOND block too, or shifting it passes unnoticed.
    const b2 = F2.mapObjects(rom, F2.MAPOBJ_BLOCKS[1].base, 0);
    if (!b2.length || b2[0].type !== 62) {
      bad(`FF2 second block map 0 starts with type ${b2[0]?.type} — expected 62`);
    } else if (!/ミスリル/.test(F2.decodeLine(rom, 62))) {
      bad('FF2 object 62 no longer mentions ミスリル — the second block has drifted');
    }
    const line = F2.decodeLine(rom, 1);
    if (!/あいこと/.test(line)) {
      bad(`FF2 dialogue 1 is "${line.slice(0, 40)}…" — not the line the running game displayed`);
    }
    // ⛔ Pointer validity does NOT identify the bank: both blocks validate
    // "100%" against table 0x4010 too, which decodes them to garbage.
    // Content is the discriminator.
    const wrong = F2.decodeLine(rom, 1, { table: 0x4010 });
    if (/あいこと/.test(wrong)) bad('FF2 table 0x4010 also yields the Hilda line — the bank test is meaningless');
    if (since()) ok(`FF2 map objects: ${objs} across ${maps} maps; type 1 is Hilda, matching the running game`);
  }

  // 5. the 0x18 N name/keyword insert
  {
    const line = F2.decodeLine(rom, 1);
    if (!/^【/.test(line)) bad('FF2 dialogue 1 does not begin with a name insert — 0x18 N is not expanding');
    if (!/【のら】|【のばら】/.test(line)) bad('FF2 dialogue 1 lost its keyword insert (0x1F1, のばら)');
    if (since()) ok('FF2 0x18 N expands to string 0x100+N (ヒルダ and のばら both insert)');
  }

  // 6. specific ids carry specific text.
  // ⛔ "some string somewhere contains アルテア" is SHIFT-INVARIANT — moving the
  // pointer table by one entry still satisfies it, and that revert passed. Pin
  // the id, so a shifted table fails.
  const PINNED = [
    [0x001, 'しんしつ'],           // "this is the King's bedchamber"
    [0x002, 'はんらん'],           // "the rebel army's strategy room"
    [0x005, 'アルテア'],           // "the rebel army's hideout in Altair"
  ];
  for (const [id, frag] of PINNED) {
    if (!F2.decodeString(rom, id).includes(frag)) {
      bad(`FF2 string 0x${id.toString(16)} no longer contains "${frag}" — the pointer table has shifted`);
    }
  }
  if (since()) ok('FF2 pinned strings resolve at their own ids (shift-sensitive)');
}

if (failed) { console.error(`\ncheck-ff12-text: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-ff12-text: OK');
