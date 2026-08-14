#!/usr/bin/env node
// npc-dialogue-ff2.mjs — every FF2 map object, where it stands and what it says.
// `tools/lib/ff2-text.mjs` documents how each piece was measured.
//
//   node tools/npc-dialogue-ff2.mjs           # all 49 maps
//   node tools/npc-dialogue-ff2.mjs --names   # only the ones that name a speaker
//   node tools/npc-dialogue-ff2.mjs --json

import { loadRom, decodeLine, mapObjects, MAPOBJ_BLOCKS } from './lib/ff2-text.mjs';

const rom = loadRom();
const NAMES_ONLY = process.argv.includes('--names');

/**
 * FF2 writes a speaker as `NAME「…」` — 0xB9 is the opening quote. A leading
 * name-insert (or literal kana) immediately followed by 0xB9 IS the speaker.
 *
 * ⛔ 【…】 that appear MID-line are ASK/LEARN keywords, not speakers —
 * "【ヒルダ】さまに はけんされてきた?" is a guard talking ABOUT Hilda.
 * Only a name in the opening-quote position counts.
 */
export function speaker(line) {
  const m = /^([^「\n]{1,14})「/.exec(line);
  if (!m) return null;
  const n = m[1].replace(/\{[0-9a-f]{1,2}\}/g, '').trim();
  return n.length >= 2 ? n : null;
}

const rows = [];
for (const { base, maps } of MAPOBJ_BLOCKS) {
  for (let m = 0; m < maps; m++) {
    for (const o of mapObjects(rom, base, m)) {
      const text = decodeLine(rom, o.type);
      rows.push({
        block: '0x' + base.toString(16), mapIndex: m,
        objType: o.type, dialogueId: o.type, x: o.x, y: o.y,
        speaker: speaker(text), text,
      });
    }
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rule: 'dialogueId === objType (table 0x18010)', objects: rows }, null, 2));
} else if (NAMES_ONLY) {
  const named = rows.filter(r => r.speaker);
  console.log(`FF2 — ${named.length} objects with a named speaker\n`);
  for (const r of named) {
    console.log(`${r.block} map ${String(r.mapIndex).padStart(2)} obj ${String(r.objType).padStart(3)} (${r.x},${r.y})  «${r.speaker}»`);
    console.log(`     ${r.text.slice(0, 150)}`);
  }
  const uniq = [...new Set(named.map(r => r.speaker))];
  console.log(`\ndistinct speakers (${uniq.length}): ${uniq.join(', ')}`);
} else {
  console.log(`FF2 map objects — ${rows.length} across ${MAPOBJ_BLOCKS.reduce((a, b) => a + b.maps, 0)} maps` +
              `   (dialogue id == object type, table 0x18010)\n`);
  let last = null;
  for (const r of rows) {
    const key = r.block + '/' + r.mapIndex;
    if (key !== last) { console.log(`── ${r.block} map ${r.mapIndex} ──`); last = key; }
    console.log(`  obj ${String(r.objType).padStart(3)} (${r.x},${r.y})${r.speaker ? '  «' + r.speaker + '»' : ''}`);
    console.log(`     ${r.text.slice(0, 160)}`);
  }
}
