#!/usr/bin/env node
// check-ff12-text.mjs — FF1's and FF2's scripts stay decoded.
//
// Both decoders are anchored on text read off a RUNNING game, not on the
// decoder agreeing with itself:
//
//   FF1 — a Coneria Castle guard displayed "The King is looking for the LIGHT
//         WARRIORS. You do not happen to be them, do you?" That box IS
//         string 49, and the guard's object type is 32 — which is what fixes
//         the four-byte record at 0x395E5, byte 1.
//   FF2 — Minwu, object type 8 in the Altair throne room, displays string 49.
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

  // 3. the map object table — 15 slots of 3 bytes, stride 48, from the
  // disassembly ($E7F3 LDA #$0F, $E82C ADC #$03, mapId*48 + $B400 in bank 0)
  let objs = 0, maps = 0;
  for (let m = 0; m < 64; m++) {
    const o = F1.mapObjects(rom, m);
    if (!o.length) continue;
    maps++; objs += o.length;
    if (o.some(e => e.x > 63 || e.y > 63)) bad(`FF1 map ${m} has an unmasked coord — both bytes take #$3F`);
  }
  if (objs !== 287) bad(`FF1 map object table yields ${objs} objects, expected 287`);
  if (F1.MAPOBJ_PER_MAP !== 15) bad(`FF1 MAPOBJ_PER_MAP is ${F1.MAPOBJ_PER_MAP}; the loader reads 15 (LDA #$0F)`);
  if (since()) ok(`FF1 map objects: ${objs} across ${maps} maps, 15 slots each`);

  // 4. objType -> sprite. MEASURED by patching every object on Coneria Castle
  // (map 8) to one type and reading which single sprite the PPU loaded.
  {
    const PROBED = [[49, 25], [32, 25], [63, 28], [100, 34], [150, 23], [200, 32]];
    for (const [t, e] of PROBED) {
      const got = F1.spriteEntryForType(rom, t);
      if (got !== e) bad(`FF1 objType ${t} resolves to sprite entry ${got}, the PPU measured ${e}`);
    }
    // ...and it must reproduce the unpatched map 8, in order
    const M8 = [25, 25, 19, 26, 25, 19, 18, 18, 29, 29];
    const o8 = F1.mapObjects(rom, 8);
    for (let i = 0; i < M8.length; i++) {
      if (o8[i].sprite !== M8[i]) bad(`FF1 map 8 slot ${i} predicts sprite ${o8[i].sprite}, the PPU showed ${M8[i]}`);
    }
    // the OFFSET too, not just the index — otherwise SPRITE_BASE can drift
    const o8a = F1.mapObjects(rom, 8)[0];
    if (o8a.spriteOffset !== 0xA910) {
      bad(`FF1 map 8 slot 0 resolves to 0x${o8a.spriteOffset.toString(16)}, the PPU traced 0xA910`);
    }
    // the X mask is observable (108 objects carry flag bits); the Y mask is
    // NOT — no object in this ROM sets bits 6-7 of byte 2 — so it is not tested.
    let flagged = 0;
    for (let m = 0; m < 64; m++) for (const o of F1.mapObjects(rom, m)) if (o.inRoom || o.still) flagged++;
    if (flagged < 90) bad(`only ${flagged} FF1 objects carry X flag bits, expected ~108 — the mask is off`);
    // every placed type must land in the NPC half of the 48-entry bank
    let outside = 0;
    for (let m = 0; m < 64; m++) for (const o of F1.mapObjects(rom, m))
      if (o.sprite < 18 || o.sprite > 47) outside++;
    if (outside) bad(`${outside} FF1 objects resolve outside sprite entries 18-47`);
    if (since()) ok('FF1 objType -> sprite: 6 probes + map 8 10/10, all types land in entries 18-47');
  }

  // 5. objType -> dialogue: a FOUR-BYTE record at 0x395E5, byte 1 is the
  // default line. Traced from the talk path ($DB71 <- $D4B1 <- $CA03 <- $902B).
  {
    // MEASURED: a Coneria Castle guard displayed string 49; its type is 32.
    if (F1.dialogueForType(rom, 32) !== 49) {
      bad(`FF1 objType 32 says string ${F1.dialogueForType(rom, 32)}, the game displayed 49`);
    }
    const rec = F1.dialogueRecordForType(rom, 32);
    if (rec.join(',') !== '18,49,50,0') bad(`FF1 type 32 record is [${rec}], expected [18,49,50,0]`);
    // ⛔ and it must NOT be the old objType==dialogueId rule
    if (F1.dialogueForType(rom, 100) === 100) bad('FF1 dialogue still resolves as objType — the retracted rule is back');
    // map 8 is Coneria Castle: every line must fall in that block
    for (const o of F1.mapObjects(rom, 8)) {
      if (o.dialogueId < 49 || o.dialogueId > 66) {
        bad(`FF1 map 8 type ${o.type} says string ${o.dialogueId}, outside the Coneria Castle block 49-66`);
      }
    }
    if (since()) ok('FF1 objType -> dialogue: type 32 = string 49 as displayed; map 8 all within 49-66');
  }

  // 6. named characters land on the RIGHT objects
  // Jane is Queen of Coneria and must be inside Coneria Castle (map 8). Under
  // the retracted rule she landed on map 12, which is how it looked plausible.
  {
    const WHO = [[8, /^I am Jane, Queen of/, 'Jane in Coneria Castle'],
                 [39, /^I am BAHAMUT/, 'Bahamut in his cave']];
    for (const [mapId, re, what] of WHO) {
      const hit = F1.mapObjects(rom, mapId).some(o => re.test(F1.decodeString(rom, o.dialogueId)));
      if (!hit) bad(`FF1: ${what} — no object on map ${mapId} speaks that line`);
    }
    if (since()) ok('FF1 named characters sit on the right maps (Jane in Coneria Castle, Bahamut in his cave)');
  }
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

  // 4. the map object table.
  //
  // ⛔ This section used to also assert `dialogueId == objType`. That rule is
  // RETRACTED (v1.8.31) — `tools/ff2-talk-probe.mjs` walked to Minwu in the
  // Altair throne room (object type 8) and measured the string he displays as
  // id 49, not 8. The object table itself is unaffected and still measured:
  // the coordinates below were confirmed by WALKING to them in the emulator
  // and finding an NPC there.
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
    // string 1 IS the line the running game displayed when talking to Hilda —
    // that measurement stands; only the id==type generalisation was wrong.
    const line = F2.decodeLine(rom, 1);
    if (!/あいこと/.test(line)) {
      bad(`FF2 string 1 is "${line.slice(0, 40)}…" — not the line the running game displayed`);
    }
    // ⛔ and the RETRACTED rule must stay retracted. Minwu is object type 8 in
    // the throne room and displays string 49 (measured by talking to him); if
    // anything ever makes type 8 resolve to string 8 again, the coincidence
    // has been re-adopted as a rule.
    const minwu = F2.decodeLine(rom, 49);
    if (!/ミンウ/.test(minwu)) {
      bad(`FF2 string 49 is "${minwu.slice(0, 40)}…" — expected Minwu's line, as measured on screen`);
    }
    if (/ミンウ/.test(F2.decodeLine(rom, 8))) {
      bad('FF2 string 8 now reads as Minwu — the retracted dialogueId==objType rule is back');
    }
    if (F2.mapObjects(rom, F2.MAPOBJ_BLOCKS[0].base, 4).some(o => o.dialogueId !== undefined)) {
      bad('FF2 mapObjects exposes a dialogueId again — there is no measured objType->dialogue link');
    }
    // ⛔ Pointer validity does NOT identify the bank: both blocks validate
    // "100%" against table 0x4010 too, which decodes them to garbage.
    // Content is the discriminator.
    const wrong = F2.decodeLine(rom, 1, { table: 0x4010 });
    if (/あいこと/.test(wrong)) bad('FF2 table 0x4010 also yields the Hilda line — the bank test is meaningless');
    if (since()) ok(`FF2 map objects: ${objs} across ${maps} maps; objType->dialogue stays RETRACTED`);
  }

  // 4b. objType -> sprite. MEASURED the same way as FF1's: patch every object
  // on the Altair throne room to ONE type, boot in, read which single sprite
  // the PPU loads. Five clean probes leave exactly one table in the ROM.
  {
    const PROBED = [[1, 20], [8, 14], [13, 16], [97, 37], [150, 30]];
    for (const [t, e] of PROBED) {
      const got = F2.spriteEntryForType(rom, t);
      if (got !== e) bad(`FF2 objType ${t} resolves to sprite entry ${got}, the PPU measured ${e}`);
    }
    // ...and it must reproduce the unpatched throne room, in order — a trace
    // captured BEFORE the table was known.
    const M4 = [20, 14, 16, 37, 37, 41, 37];
    const o4 = F2.mapObjects(rom, F2.MAPOBJ_BLOCKS[0].base, 4);
    for (let i = 0; i < M4.length; i++) {
      if (o4[i]?.sprite !== M4[i]) bad(`FF2 map 4 slot ${i} predicts sprite ${o4[i]?.sprite}, the PPU showed ${M4[i]}`);
    }
    // the OFFSET too, not just the biased index, or SPRITE_BASE can drift
    if (o4[0]?.spriteOffset !== 0x9B10 + 9 * 0x100) {
      bad(`FF2 map 4 slot 0 resolves to 0x${o4[0]?.spriteOffset.toString(16)}, expected 0x${(0x9B10 + 9 * 0x100).toString(16)}`);
    }
    if (F2.SPRITE_TABLE !== 0xD10) bad(`FF2 SPRITE_TABLE is 0x${F2.SPRITE_TABLE.toString(16)}, measured 0xD10`);
    if (since()) ok('FF2 objType -> sprite: 5 probes + throne room 7/7');
  }

  // 5. the 0x18 N name/keyword insert
  {
    const line = F2.decodeLine(rom, 1);
    // Inserts render PLAIN — the script supplies its own 【 】 (0x78/0x79)
    // around keywords, so wrapping them here double-bracketed every one.
    if (!/^ヒルダ「/.test(line)) {
      bad(`FF2 dialogue 1 starts "${line.slice(0, 16)}" — expected the ヒルダ name insert`);
    }
    if (!/のばら/.test(line)) bad('FF2 dialogue 1 lost its keyword insert (0x1F1, のばら)');
    if (since()) ok('FF2 0x18 N expands to string 0x100+N (ヒルダ speaks, のばら inserts)');
  }

  // 6. the dakuten blocks — there is NO dictionary, these are characters
  //
  // Seven of these were derived from context independently, before the layout
  // was known (0x3D=ぎ, 0x3E=ぐ, 0x49=で, 0x4B=ば, 0x5A=ダ, 0x5D=デ, 0x69=パ);
  // the four-block layout reproduces all seven. If a block base drifts, the
  // whole script starts printing the wrong kana.
  {
    const WANT = { 0x3D: 'ぎ', 0x3E: 'ぐ', 0x49: 'で', 0x4B: 'ば',
                   0x5A: 'ダ', 0x5D: 'デ', 0x69: 'パ', 0xBD: 'ャ', 0x7C: 'っ' };
    for (const [b, c] of Object.entries(WANT)) {
      if (F2.glyph(+b) !== c) bad(`FF2 0x${(+b).toString(16)} decodes as "${F2.glyph(+b)}", expected "${c}"`);
    }
    if (since()) ok('FF2 dakuten/handakuten blocks decode (9 context-derived codes)');
  }

  // 7. names render in FULL — this is what the dakuten buy
  {
    const NAMES = [[0x1EF, 'ヒルダ'], [0x1EE, 'ダークナイト'], [0x1F4, 'パラメキア'],
                   [0x1EB, 'ゴードン'], [0x1F8, 'ミシディア'], [0x1F2, 'ミスリル']];
    for (const [id, want] of NAMES) {
      const got = F2.decodeString(rom, id);
      if (got !== want) bad(`FF2 keyword 0x${id.toString(16)} is "${got}", expected "${want}"`);
    }
    if (since()) ok('FF2 names render in full: ヒルダ, ダークナイト, パラメキア, ゴードン, ミシディア');
  }

  // 8. coverage — the dakuten took this from 78% to ~95%
  {
    let lit = 0, n = 0;
    for (let id = 0; id < 600; id++) { const r = F2.literalRatio(rom, id); if (r > 0) { lit += r; n++; } }
    const pct = 100 * lit / n;
    if (pct < 90) bad(`FF2 mean literal coverage is ${pct.toFixed(1)}%, expected ~95% — the tables have drifted`);
    else ok(`FF2 mean literal coverage ${pct.toFixed(1)}% over ${n} strings`);
  }

  // 9. specific ids carry specific text.
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
