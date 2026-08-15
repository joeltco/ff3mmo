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
  // ⛔ every one of these is a line of the loader, RE-DERIVED from the CPU:
  //   $E7F3 LDA #$0F (15 slots) / $E812 16x+32x = *48 / $E819 ADC #$B4 ($B400)
  //   $E82C ADC #$03 (3 bytes) / $E836 DEC $1B BNE (no terminator)
  if (F1.MAPOBJ_PER_MAP !== 15) bad(`FF1 MAPOBJ_PER_MAP is ${F1.MAPOBJ_PER_MAP}; the loader reads 15 (LDA #$0F)`);
  if (F1.MAPOBJ_STRIDE !== 48) bad(`FF1 MAPOBJ_STRIDE is ${F1.MAPOBJ_STRIDE}; $E812 computes 16x+32x = 48`);
  if (F1.MAPOBJ_TABLE !== 0x3410) bad(`FF1 MAPOBJ_TABLE is 0x${F1.MAPOBJ_TABLE.toString(16)}; ADC #$B4 gives $B400 = 0x3410`);
  if (F1.MAPOBJ_MAPS !== 64) bad(`FF1 MAPOBJ_MAPS is ${F1.MAPOBJ_MAPS}, expected 64`);
  // the extent, two independent ways
  if (F1.MAPOBJ_TABLE + F1.MAPOBJ_MAPS * F1.MAPOBJ_STRIDE !== 0x4010) {
    bad('FF1 map object table no longer ends exactly at the bank 0 boundary (0x4010)');
  }
  {
    // raw Y stays inside the #$3F mask for every real map and leaves it for all
    // of 64-127 — a sharp boundary, not a judgement call
    const rawYok = (m) => {
      for (let i = 0; i < 15; i++) {
        const o = F1.MAPOBJ_TABLE + m * F1.MAPOBJ_STRIDE + i * 3;
        if (rom[o] && rom[o + 2] > 0x3F) return false;
      }
      return true;
    };
    let inside = 0, outside = 0;
    for (let m = 0; m < 64; m++) if (rawYok(m)) inside++;
    for (let m = 64; m < 128; m++) if (!rawYok(m)) outside++;
    if (inside !== 64) bad(`only ${inside}/64 FF1 maps keep raw Y within #$3F — the table has moved`);
    if (outside !== 64) bad(`${64 - outside}/64 maps past 63 look valid — the 64-map extent is not sharp`);
  }
  {
    // ⛔ bytes 45-47 of each map are DEAD (15*3=45, stride 48). Three maps hold
    // leftover object data there; reading 16 slots injects 3 phantom NPCs.
    let ghosts = 0;
    for (let m = 0; m < 64; m++) {
      const o = F1.MAPOBJ_TABLE + m * F1.MAPOBJ_STRIDE;
      if (rom[o + 45]) ghosts++;
    }
    if (ghosts !== 3) bad(`${ghosts} FF1 maps carry data in the dead 16th slot, expected 3 (28, 30, 31)`);
  }
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
    // ── the X/Y flag bits, read off the loader ($E851 AND #$C0, $E85C AND #$3F)
    //
    // ⛔ THE Y BYTE HAS NO FLAGS: $E866 masks it with #$3F and the high bits are
    // never stored. That is a fact about the CODE — data could set them and
    // nothing would happen — which is why no assertion about Y flags exists.
    // Only the invariant that this ROM's data agrees is checked.
    if (F1.FLAG_LAYER !== 0x80 || F1.FLAG_STILL !== 0x40 || F1.COORD_MASK !== 0x3F) {
      bad('FF1 X-byte flag masks changed; the loader uses AND #$C0 / AND #$3F');
    }
    let flag7 = 0, flag6 = 0, yHigh = 0, decodeBad = 0;
    for (let m = 0; m < F1.MAPOBJ_MAPS; m++) {
      for (const o of F1.mapObjects(rom, m)) {
        const b = F1.MAPOBJ_TABLE + m * F1.MAPOBJ_STRIDE + o.slot * 3;
        if (rom[b + 1] & 0x80) flag7++;
        if (rom[b + 1] & 0x40) flag6++;
        if (rom[b + 2] & 0xC0) yHigh++;
        // the decoded flags must be exactly the raw bits, per object
        if (o.altLayer !== !!(rom[b + 1] & 0x80) || o.still !== !!(rom[b + 1] & 0x40)) decodeBad++;
        if (o.x !== (rom[b + 1] & 0x3F) || o.y !== (rom[b + 2] & 0x3F)) decodeBad++;
      }
    }
    if (decodeBad) bad(`${decodeBad} FF1 objects decode flags/coords differently from the raw bytes`);
    if (flag7 !== 61) bad(`${flag7} FF1 objects carry X bit 7, expected 61`);
    if (flag6 !== 78) bad(`${flag6} FF1 objects carry X bit 6, expected 78`);
    // ⛔ Because yHigh is 0, MASKING Y IS A NO-OP in this ROM and dropping the
    // `& 0x3F` on y is UNOBSERVABLE — no revert test can catch it (same shape as
    // FF3's `hi | 0x80`). This assertion pins the reason: if data ever set those
    // bits the mask would become load-bearing and this fires.
    if (yHigh !== 0) bad(`${yHigh} FF1 objects set Y high bits — the y mask is now load-bearing and needs a real test`);
    // every placed type must land in the NPC half of the 48-entry bank
    let outside = 0;
    for (let m = 0; m < 64; m++) for (const o of F1.mapObjects(rom, m))
      if (o.sprite < 18 || o.sprite > 47) outside++;
    if (outside) bad(`${outside} FF1 objects resolve outside sprite entries 18-47`);
    if (since()) ok(`FF1 objType -> sprite: 6 probes + map 8 10/10; X flags ${flag7} layer / ${flag6} still, Y carries none`);
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
    // MEASURED on screen by tools/ff1-talk-probe.mjs — the rule predicted each
    // in advance and the box agreed. objType 48 is the discriminating case: the
    // retracted rule would say string 48, the game shows 49.
    const SCREEN = [[32, 49], [48, 49], [1, 1]];
    for (const [type, id] of SCREEN) {
      if (F1.dialogueForType(rom, type) !== id) {
        bad(`FF1 objType ${type} -> string ${F1.dialogueForType(rom, type)}, the game displayed ${id}`);
      }
    }
    if (since()) ok('FF1 objType -> dialogue: 3 screen-measured types (incl. 48->49, where id != type)');
  }

  // 5b. ⛔ THE INDEPENDENT CHECK — the handler jump table at 0x390E3 and the
  // record table at 0x395E5 are SEPARATE data, yet every record's SHAPE matches
  // what its handler actually reads:
  //
  //   $9492  LDA $11 / RTS                  never touches byte 0 or byte 2
  //   $941B  LDY $10 ... BCS -> LDA $12     needs BOTH a flag and an after-line
  //
  // Nothing in the dialogue rule's derivation enforces that pairing, so it
  // cannot be satisfied by construction. Shift DIALOGUE_TABLE by one record and
  // every type pairs with the wrong handler.
  {
    const placed = new Set();
    for (let m = 0; m < 64; m++) for (const o of F1.mapObjects(rom, m)) placed.add(o.type);
    let plain = 0, plainBad = 0, flagged = 0, flaggedBad = 0, outside = 0;
    for (const t of placed) {
      const h = F1.handlerForType(rom, t);
      if (h < 0x8000 || h > 0xBFFF) outside++;
      const r = F1.dialogueRecordForType(rom, t);
      if (h === F1.HANDLER_PLAIN) { plain++; if (r[0] !== 0 || r[2] !== 0) plainBad++; }
      if (h === F1.HANDLER_FLAGGED) { flagged++; if (r[0] === 0 || r[2] === 0) flaggedBad++; }
    }
    if (outside) bad(`${outside} FF1 handler addresses fall outside $8000-$BFFF — the jump table has moved`);
    if (plain < 60) bad(`only ${plain} FF1 placed types use the unconditional handler, expected ~76`);
    if (plainBad) bad(`${plainBad}/${plain} FF1 unconditional-handler types carry a stray flag or after-line — records are paired with the wrong handlers`);
    if (flagged < 8) bad(`only ${flagged} FF1 placed types use the flag-gated handler, expected ~12`);
    if (flaggedBad) bad(`${flaggedBad}/${flagged} FF1 flag-gated types are missing a flag or after-line — records are paired with the wrong handlers`);
    if (since()) ok(`FF1 record shape matches its handler: ${plain}/${plain} plain, ${flagged}/${flagged} flag-gated`);
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
    // ⛔ ONE table, stride 36, indexed by map id — CONFIRMED from the CPU
    // ($9E15: mapId*4, *32, summed = *36; ADC #$B5 -> $B500 = file 0x3510).
    // The old two-block model read maps 0-16 and 32-63 and SKIPPED 17-31.
    let objs = 0, maps = 0;
    for (let m = 0; m < F2.MAPOBJ_MAPS; m++) {
      const o = F2.mapObjects(rom, m);
      if (o.length) { maps++; objs += o.length; }
      if (o.some(e => e.y > 63)) bad(`FF2 map ${m} has Y>63 — the table has moved`);
    }
    if (objs < 380) bad(`FF2 map objects yield only ${objs}, expected ~401`);
    if (F2.MAPOBJ_STRIDE !== 36) bad(`FF2 MAPOBJ_STRIDE is ${F2.MAPOBJ_STRIDE}; $9E26 computes 32x+4x = 36`);
    if (F2.MAPOBJ_TABLE !== 0x3510) bad(`FF2 MAPOBJ_TABLE is 0x${F2.MAPOBJ_TABLE.toString(16)}; ADC #$B5 gives $B500 = 0x3510`);
    // map 4 is the Altair throne room, measured on the running game ($48 = 4)
    const hilda = F2.mapObjects(rom, 4);
    if (!hilda.length || hilda[0].type !== 1) {
      bad('FF2 map 4 does not start with object type 1 — the table base has drifted');
    }
    // ⛔ the old "second block" base is simply MAP 32; anchor it by id so the
    // contiguous reading cannot silently revert to two blocks
    const m32 = F2.mapObjects(rom, 32);
    if (!m32.length || m32[0].type !== 62) {
      bad(`FF2 map 32 starts with type ${m32[0]?.type} — expected 62 (this is the old 0x3990 "block")`);
    } else if (!/ミスリル/.test(F2.decodeLine(rom, 62))) {
      bad('FF2 object 62 no longer mentions ミスリル — the table has drifted');
    }
    // ...and the range the old model SKIPPED must carry real objects
    let skipped = 0;
    for (let m = 17; m < 32; m++) skipped += F2.mapObjects(rom, m).length;
    if (skipped < 70) bad(`maps 17-31 yield only ${skipped} objects — the two-block model may be back (they were skipped entirely)`);
    // string 1 IS the line the running game displayed when talking to Hilda.
    const line = F2.decodeLine(rom, 1);
    if (!/あいこと/.test(line)) {
      bad(`FF2 string 1 is "${line.slice(0, 40)}…" — not the line the running game displayed`);
    }
    if (since()) ok(`FF2 map objects: ${objs} across ${maps} maps (one table, stride 36; maps 17-31 recovered)`);
  }

  // 4a. objType -> dialogue. SOLVED by disassembling the talk routine
  // (tools/ff2-talk-trace.mjs): $9794 in bank 14 reads the object type from
  // RAM $7500,X, picks bank 6 or 10 on CMP #$60, indexes a record pointer at
  // $8200 + type*2, and the record's byte 0 is the string id.
  //
  // ⛔ These four pairs were READ OFF THE SCREEN by talking to each NPC in the
  // Altair throne room BEFORE the rule was known. Type 8 is the one that
  // matters: the retracted rule said string 8, the game shows string 49.
  {
    const MEASURED = [
      [1, 1, F2.DIALOGUE_TABLE],       // Hilda   — id == type, the coincidence
      [8, 49, F2.DIALOGUE_TABLE],      // Minwu   — id != type, the disproof
      [97, 2, F2.DIALOGUE_TABLE_HI],   // a different TABLE, not just a different id
      [99, 4, F2.DIALOGUE_TABLE_HI],
    ];
    for (const [type, id, table] of MEASURED) {
      const got = F2.stringIdForType(rom, type);
      if (!got) { bad(`FF2 objType ${type} resolves to no string; the game displayed ${id}`); continue; }
      if (got.id !== id) bad(`FF2 objType ${type} -> string ${got.id}, the game displayed ${id}`);
      if (got.table !== table) {
        bad(`FF2 objType ${type} reads table 0x${got.table.toString(16)}, measured 0x${table.toString(16)}`);
      }
    }
    // ⛔ and the retracted rule must stay dead: type 8 must NOT be string 8
    if (F2.stringIdForType(rom, 8)?.id === 8) bad('FF2 dialogue resolves as objType again — the retracted rule is back');
    // Minwu's line must actually name him — that is what was on screen
    const m = F2.lineForType(rom, 8);
    if (!/ミンウ/.test(m)) bad(`FF2 objType 8 says "${m.slice(0, 30)}…" — expected Minwu's line`);
    // the constants the rule rides on, pinned
    if (F2.RECORD_PTR_TABLE !== 0x38210) bad(`FF2 RECORD_PTR_TABLE is 0x${F2.RECORD_PTR_TABLE.toString(16)}, disassembly says 0x38210`);
    if (F2.HANDLER_TABLE !== 0x39933) bad(`FF2 HANDLER_TABLE is 0x${F2.HANDLER_TABLE.toString(16)}, disassembly says 0x39933`);
    if (F2.HI_TABLE_FIRST !== 0x60) bad('FF2 HI_TABLE_FIRST != 0x60 (CMP #$60)');
    if (F2.NO_HANDLER_FIRST !== 0xC0) bad('FF2 NO_HANDLER_FIRST != 0xC0 (CMP #$C0)');
    // every handler address must land inside bank 14's window, or the jump
    // table has drifted off its base
    let bogus = 0;
    for (let t = 0; t < F2.NO_HANDLER_FIRST; t++) {
      const h = F2.handlerForType(rom, t);
      if (h < 0x8000 || h > 0xBFFF) bogus++;
    }
    if (bogus) bad(`${bogus} FF2 handler addresses fall outside $8000-$BFFF — the jump table has moved`);
    // ⛔ the distribution check that CAUGHT the old rule: under it, 44 of 175
    // placed types opened with a keyword insert (a pendant "speaking"). The
    // real rule must stay far below that.
    const placed = new Set();
    for (let mi = 0; mi < F2.MAPOBJ_MAPS; mi++) for (const o of F2.mapObjects(rom, mi)) placed.add(o.type);
    let insertLed = 0, resolvable = 0;
    for (const t of placed) {
      const sid = F2.stringIdForType(rom, t);
      if (!sid) continue;
      resolvable++;
      const raw = F2.rawString(rom, sid.table, sid.id) || [];
      if (raw[0] === F2.INSERT_CODE) insertLed++;
    }
    // ⛔ Express this as a RATIO, re-derived on the CURRENT domain. It was an
    // absolute (>25) tuned to the old 175-type set, and recovering maps 17-31
    // grew the domain to 231 types — the threshold went stale, not the rule.
    // MEASURED on this domain: the real rule gives 29/174 insert-led (17%), the
    // retracted one gives 68/174 (39%). 27% sits clear of both.
    const ratio = insertLed / resolvable;
    if (ratio > 0.27) {
      bad(`${insertLed}/${resolvable} FF2 placed types open with a name insert (${(ratio * 100).toFixed(0)}%) — ` +
          `the real rule measures 17%, the retracted one 39%; this looks like the old rule is back`);
    }
    // ⛔ THE INDEPENDENT CHECK. A named speaker must wear ONE sprite across
    // every object type that speaks as them — Hilda cannot be a guard AND a
    // ninja AND a mage. The retracted rule failed this outright: it put ヒルダ
    // on ten different sprites. Nothing in the rule's derivation involves
    // sprites, so this cannot be satisfied by construction.
    const byName = new Map();
    for (const t of placed) {
      const sid = F2.stringIdForType(rom, t);
      if (!sid) continue;
      // ⛔ use the SHARED detector: FF2 writes a speaker name as a 0x18 insert
      // (Hilda) OR as literal kana (Minwu). A local insert-only copy drops half.
      const nm = F2.speakerForType(rom, t);
      if (!nm) continue;
      if (!byName.has(nm)) byName.set(nm, new Set());
      byName.get(nm).add(F2.spriteEntryForType(rom, t));
    }
    if (!byName.size) bad('FF2: no named speakers resolve at all — the insert or the rule has broken');
    for (const [nm, sprites] of byName) {
      if (sprites.size > 1) {
        bad(`FF2 speaker ${nm} wears ${sprites.size} different sprites (${[...sprites].join(',')}) — one character, one sprite`);
      }
    }
    if (since()) ok(`FF2 objType -> dialogue: 4 screen-measured pairs across BOTH tables, ${insertLed}/${resolvable} insert-led (${(100 * insertLed / resolvable).toFixed(0)}%, retracted rule = 39%)`);
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
    const o4 = F2.mapObjects(rom, 4);
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

// ══ NPC SPRITE PALETTES (FF1 + FF2) ═══════════════════════════════════════
//
// MEASURED off the PPU by `tools/nes12-npc-palette.mjs`: in BOTH games the
// player draws on sprite palettes 0/1 and every NPC on 2 (top half) and 3
// (bottom half). Confirmed by y-coordinate and in code — FF2's sprite layout
// tables hold only attribute bytes 02, 03 and 43 (= 3 + horizontal flip).
//
// FF1's palette pipeline, traced end to end:
//   $CC49  LDA $48 / ASL A x4       ; $10/$11 = mapId * 16
//   $CC55  LDX $11                  ; save the HIGH byte of mapId*16
//   $CC57  ASL $10 / ROL $11        ; $10/$11 = mapId * 32
//   $CC5C  ADC $10 / TXA / ADC $11  ; 16x + 32x = mapId * 48
//   $CC63  ORA #$A0                 ; -> $A000 + mapId*48
//   $CC69  LDA ($10),Y / STA $0780,Y  (0x30 bytes)
//   $D8AD  LDA $0780,X / STA $03C0,X  (0x20 bytes)
//   $D880  LDA $03C0,X / STA $2007    (every frame)
//
// ⛔ X is NOT a palette selector — it is the carry-high of mapId*16, held so the
// 16x and 32x halves can be summed. The set index IS THE MAP ID.
// CONFIRMED by capturing the pointer on two different map entries:
// map 8 -> $A180 and map 24 -> $A480, both = $A000 + mapId*48.
{
  const f1 = F1.loadRom(FF1);
  const hxs = (a) => a.map(v => v.toString(16).padStart(2, '0')).join(' ');
  // ⛔ Pin the SET SIZE to the code that defines it. A 0x20 stride still lands
  // on plausible-looking palette data (the region is dense), so a structural
  // "are these valid sets" test alone cannot catch a wrong stride.
  // ⛔ Use the LIBRARY's constants, not a local copy. An earlier version of this
  // gate recomputed the base and stride here — so reverting ff1-text.mjs (what
  // the sheet actually renders from) changed nothing and every revert passed.
  const SET_SIZE = F1.PALETTE_SET_SIZE;
  const CPY_OFF = 0x10 + 15 * 0x4000 + (0xCC6F - 0xC000);
  if (f1[CPY_OFF] !== 0xC0 || f1[CPY_OFF + 1] !== SET_SIZE) {
    bad(`FF1 $CC6F is not \`CPY #$${SET_SIZE.toString(16)}\` ` +
        `(found ${f1[CPY_OFF].toString(16)} ${f1[CPY_OFF + 1].toString(16)}) — the palette set size has moved`);
  }
  // ...and pin the instruction that makes X a carry-high rather than a selector
  const LDX_OFF = 0x10 + 15 * 0x4000 + (0xCC55 - 0xC000);
  if (f1[LDX_OFF] !== 0xA6 || f1[LDX_OFF + 1] !== 0x11) {
    bad('FF1 $CC55 is not `LDX $11` — the mapId*48 derivation no longer holds');
  }

  if (F1.PALETTE_TABLE !== 0x10 + (0xA000 - 0x8000)) {
    bad(`FF1 PALETTE_TABLE is 0x${F1.PALETTE_TABLE.toString(16)}, the captured pointers say $A000 (file 0x2010)`);
  }
  const setFor = (mapId) => F1.paletteSetForMap(f1, mapId);
  // MEASURED off the PPU: both of these maps show the same palettes, and the
  // POINTER captured on entry was $A180 / $A480 respectively.
  const MEASURED = [
    [8, '0f 0f 27 36', '0f 0f 16 36', '0f 12 1a 19'],
    [24, '0f 0f 27 36', '0f 0f 16 36', '0f 12 1a 19'],
  ];
  for (const [mapId, want2, want3, wantBg] of MEASURED) {
    const set = setFor(mapId);
    // go through the SAME helper the sheet renders with
    const np = F1.npcPalettesForMap(f1, mapId);
    if (hxs(np.top) !== want2) bad(`FF1 map ${mapId} NPC top palette is ${hxs(np.top)}, the PPU measured ${want2}`);
    if (hxs(np.btm) !== want3) bad(`FF1 map ${mapId} NPC bottom palette is ${hxs(np.btm)}, the PPU measured ${want3}`);
    if (hxs(set.slice(8, 12)) !== wantBg) bad(`FF1 map ${mapId} BG palette 2 is ${hxs(set.slice(8, 12))}, the PPU measured ${wantBg}`);
  }
  // the table must still be a run of valid palette sets, with real variety
  let valid = 0;
  const pairs = new Set();
  for (let n = 0; n < 40; n++) {
    const s2 = setFor(n);
    if (s2.every(v => v <= 0x3F) && [0, 4, 8, 12, 16, 20, 24, 28].every(i => s2[i] === 0x0F)) {
      valid++; pairs.add(hxs(s2.slice(24, 32)));
    }
  }
  if (valid < 40) bad(`only ${valid}/40 FF1 palette sets from $A000 are valid — the table base has moved`);
  if (pairs.size < 20) bad(`only ${pairs.size} distinct FF1 NPC palette pairs, expected ~25`);
  if (since()) ok(`FF1 palettes: set = $A000 + mapId*48, maps 8 and 24 match the PPU, ${valid} sets, ${pairs.size} distinct NPC pairs`);
}
{
  const f2 = F2.loadRom(FF2);
  // FF2's NPC sprite layout tables live at $B24F/$B25F in bank 3; every entry is
  // (attr, tile) and the attrs alternate palette 2 / palette 3.
  const off = (a) => 0x10 + 3 * 0x4000 + (a - 0x8000);
  // ⛔ ALIGNMENT: the pointer the game holds ($B24F) lands on a TILE byte — the
  // routine writes tile0 before the loop. The attribute bytes are the EVEN
  // addresses. Scanning from the odd pointer reads tiles and yields 0,1,0,1.
  const attrs = new Set();
  for (let a = 0xB240; a < 0xB270; a += 2) attrs.add(f2[off(a)]);
  const stray = [...attrs].filter(v => (v & 3) !== 2 && (v & 3) !== 3);
  if (stray.length) {
    bad(`FF2 NPC layout tables use palette(s) ${stray.map(v => v & 3).join(',')} — NPCs draw only on 2 and 3`);
  }
  if (!attrs.has(0x02) || !attrs.has(0x03)) {
    bad(`FF2 NPC layout tables no longer alternate 02/03 (got ${[...attrs].map(v => v.toString(16)).join(' ')})`);
  }
  if (since()) ok(`FF2 NPC layout tables draw only on sprite palettes 2 and 3 (${[...attrs].map(v => '0x' + v.toString(16)).join(' ')})`);

  // ── which colours those two palettes hold ──────────────────────────────
  //
  //   $9D52  LDA $48 / LSR A x4 / ORA #$A0    ; -> $A000 + mapId*16
  //   $9D3C  LDA ($80),Y / TAY                ; a palette INDEX
  //   $9D3F  LDA $8E00,Y / $8E80,Y / $8F00,Y  ; three PARALLEL colour tables
  //
  // Same shape as FF3's 0x1110/0x1210/0x1310. MEASURED against the live $03C0
  // buffer in the Altair throne room ($48 = 4), 5/5 map-driven slots exact.
  // ⛔ Go through the LIBRARY, not a local copy — a gate that recomputes the
  // constants passes even when the shipped module is reverted.
  {
    const hxs = (a) => a.map(v => v.toString(16).padStart(2, '0')).join(' ');
    const np = F2.npcPalettesForMap(f2, 4);
    if (hxs(np.top) !== '0f 0f 27 36') bad(`FF2 map 4 NPC top palette is ${hxs(np.top)}, the PPU measured 0f 0f 27 36`);
    if (hxs(np.btm) !== '0f 0f 30 36') bad(`FF2 map 4 NPC bottom palette is ${hxs(np.btm)}, the PPU measured 0f 0f 30 36`);
    // the BG slots the same list feeds — they pin the list's alignment
    const list = F2.paletteListForMap(f2, 4);
    const BG = [[1, '0f 00 10 30'], [2, '0f 08 16 28'], [3, '0f 00 10 37']];
    for (const [i, want] of BG) {
      const got = hxs(F2.paletteForIndex(f2, list[i]));
      if (got !== want) bad(`FF2 map 4 BG palette from list[${i}] is ${got}, the PPU measured ${want}`);
    }
    if (F2.PAL_LIST_NPC_TOP !== 4 || F2.PAL_LIST_NPC_BTM !== 5) {
      bad('FF2 NPC palette list slots are no longer 4/5');
    }
    // ⛔ and the variety must survive — a collapse would look fine but say nothing
    const pairs = new Set();
    const maps = F2.MAPOBJ_MAPS;
    for (let m = 0; m < maps; m++) {
      const p = F2.npcPalettesForMap(f2, m);
      pairs.add(hxs(p.top) + '|' + hxs(p.btm));
    }
    if (pairs.size < 8) bad(`only ${pairs.size} distinct FF2 NPC palette pairs across ${maps} maps — expected many more`);
    if (since()) ok(`FF2 palettes: map 4 matches the PPU (NPC + 3 BG slots), ${pairs.size} distinct NPC pairs over ${maps} maps`);
  }
}

if (failed) { console.error(`\ncheck-ff12-text: FAIL (${failed})`); process.exit(1); }
console.log('\ncheck-ff12-text: OK');
