#!/usr/bin/env node
// npc-dialogue-ff2.mjs — every FF2 map object, where it stands, and what it says.
//
// The objType -> dialogue link was found by disassembling the talk routine
// (`tools/ff2-talk-trace.mjs`); `tools/lib/ff2-text.mjs#stringIdForType`
// documents it. In short:
//
//   record  = bank 14, pointer at 0x38210 + objType*2   (24 bytes)
//   id      = record[0]
//   table   = objType < 0x60 ? 0x18010 : 0x28010        (>= 0xC0: no handler)
//
// ⛔ THE DEFAULT LINE ONLY. Each object type runs its own code handler (jump
// table at 0x39933) that swaps in a different byte of the record once story
// flags are set, so a late-game player sees something else. `record[0]` is what
// a fresh game shows and is all a static tool can report.
//
// ⛔ v1.8.26-1.8.30 used `dialogueId == objType`, RETRACTED in v1.8.31.
//
//   node tools/npc-dialogue-ff2.mjs             # every object
//   node tools/npc-dialogue-ff2.mjs --names     # only ones that name a speaker
//   node tools/npc-dialogue-ff2.mjs --json

import {
  loadRom, decodeLine, mapObjects, MAPOBJ_MAPS,
  stringIdForType, lineForType, handlerForType, speakerForType,
} from './lib/ff2-text.mjs';
import { romaji } from './lib/romaji.mjs';

const rom = loadRom();
const NAMES_ONLY = process.argv.includes('--names');
const JSON_OUT = process.argv.includes('--json');

const rows = [];
{
  for (let m = 0; m < MAPOBJ_MAPS; m++) {
    for (const o of mapObjects(rom, m)) {
      rows.push({
        mapId: m, slot: o.slot,
        objType: o.type, x: o.x, y: o.y,
        sprite: o.sprite, spriteOffset: '0x' + o.spriteOffset.toString(16),
        stringId: o.stringId,
        stringTable: o.stringTable === null ? null : '0x' + o.stringTable.toString(16),
        handler: o.stringId === null ? null : '$' + handlerForType(rom, o.type).toString(16),
        speaker: speakerForType(rom, o.type),
        text: lineForType(rom, o.type),
      });
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    rule: 'id = record[0], record ptr @ 0x38210 + objType*2 (bank 14); ' +
          'table = objType < 0x60 ? 0x18010 : 0x28010; objType >= 0xC0 has no handler',
    caveat: 'DEFAULT line only — the per-type handler swaps in other record bytes as story flags set',
    objects: rows,
  }, null, 2));
} else if (NAMES_ONLY) {
  const named = rows.filter(r => r.speaker);
  console.log(`FF2 — ${named.length} objects whose default line names a speaker\n`);
  for (const r of named) {
    console.log(`map ${String(r.mapId).padStart(2)} type ${String(r.objType).padStart(3)} ` +
                `(${r.x},${r.y}) spr ${r.sprite}  «${r.speaker}»  ${r.stringTable}[${r.stringId}]`);
    console.log(`     ${r.text.slice(0, 140)}`);
  }
  const uniq = [...new Set(named.map(r => r.speaker))];
  console.log(`\ndistinct speakers (${uniq.length}): ${uniq.join(', ')}`);
} else {
  const maps = MAPOBJ_MAPS;
  console.log(`FF2 map objects — ${rows.length} across ${maps} maps\n` +
              `   id = record[0] via 0x38210 + objType*2; DEFAULT line only\n`);
  let last = null;
  for (const r of rows) {
    if (r.mapId !== last) { console.log(`── map ${r.mapId} ──`); last = r.mapId; }
    console.log(`  type ${String(r.objType).padStart(3)} (${r.x},${r.y}) spr ${String(r.sprite).padStart(2)}` +
                `${r.stringId === null ? '  (no handler)' : `  ${r.stringTable}[${r.stringId}] ${r.handler}`}` +
                `${r.speaker ? '  «' + r.speaker + '»' : ''}`);
    if (r.text) {
      console.log(`     ${r.text.slice(0, 150)}`);
      console.log(`     ${romaji(r.text).slice(0, 150)}`);
    }
  }
}
