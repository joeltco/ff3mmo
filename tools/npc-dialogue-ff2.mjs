#!/usr/bin/env node
// npc-dialogue-ff2.mjs — FF2's map objects, and (separately) FF2's script.
//
// ⛔ THESE TWO THINGS ARE NOT LINKED YET, and this tool will not pretend they
// are. Earlier versions printed a line under every object using
// `dialogueId == objType`. That rule is RETRACTED (v1.8.31):
//
//   `tools/ff2-talk-probe.mjs` walked to each NPC in the Altair throne room,
//   talked, and read the box off the nametable:
//     objType  1 (Hilda) -> string 1    id == type   <- the lone coincidence
//     objType  8 (Minwu) -> string 49   id != type   <- the disproof
//     objType 97, 99     -> table 0x28010, not 0x18010 at all
//
// So: objects here, strings there, and no arrow between them.
//
//   node tools/npc-dialogue-ff2.mjs             # the object table
//   node tools/npc-dialogue-ff2.mjs --strings   # the script, by string id
//   node tools/npc-dialogue-ff2.mjs --json

import { loadRom, decodeLine, mapObjects, MAPOBJ_BLOCKS, DIALOGUE_TABLE,
         literalRatio, spriteEntryForType } from './lib/ff2-text.mjs';
import { romaji } from './lib/romaji.mjs';

const rom = loadRom();
const STRINGS = process.argv.includes('--strings');
const JSON_OUT = process.argv.includes('--json');

if (STRINGS) {
  // The script, addressed the only way we can currently address it: by id.
  console.log(`FF2 script — table 0x${DIALOGUE_TABLE.toString(16)}, by STRING ID\n`);
  console.log('⛔ a string id is NOT an object type — see the header\n');
  for (let id = 0; id < 512; id++) {
    if (literalRatio(rom, id) <= 0) continue;
    const text = decodeLine(rom, id, { nl: ' / ' });
    if (!text) continue;
    console.log(`  ${String(id).padStart(3)}  ${text.slice(0, 120)}`);
    console.log(`       ${romaji(text).slice(0, 120)}`);
  }
  process.exit(0);
}

const rows = [];
for (const { base, maps } of MAPOBJ_BLOCKS) {
  for (let m = 0; m < maps; m++) {
    for (const o of mapObjects(rom, base, m)) {
      rows.push({
        block: '0x' + base.toString(16), mapIndex: m, slot: o.slot,
        objType: o.type, x: o.x, y: o.y,
        sprite: o.sprite, spriteOffset: '0x' + o.spriteOffset.toString(16),
      });
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    note: 'objType -> dialogue is UNSOLVED; no line is attached to any object',
    spriteRule: 'sprite ROM = 0x9B10 + table[objType] * 0x100, table @ 0xD10',
    objects: rows,
  }, null, 2));
} else {
  const maps = MAPOBJ_BLOCKS.reduce((a, b) => a + b.maps, 0);
  console.log(`FF2 map objects — ${rows.length} across ${maps} maps\n`);
  console.log('⛔ no dialogue column: the objType -> dialogue link is unsolved.\n' +
              '   `--strings` dumps the script by string id instead.\n');
  let last = null;
  for (const r of rows) {
    const key = r.block + '/' + r.mapIndex;
    if (key !== last) { console.log(`── ${r.block} map ${r.mapIndex} ──`); last = key; }
    console.log(`  slot ${r.slot}  type ${String(r.objType).padStart(3)}` +
                `  at (${r.x},${r.y})  sprite ${String(r.sprite).padStart(2)} @${r.spriteOffset}`);
  }
  const types = new Set(rows.map(r => r.objType));
  console.log(`\n${types.size} distinct object types placed; ` +
              `${new Set([...types].map(t => spriteEntryForType(rom, t))).size} distinct sprites`);
}
