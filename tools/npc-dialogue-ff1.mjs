#!/usr/bin/env node
// npc-dialogue-ff1.mjs — every FF1 map object: where it stands and which
// SPRITE it wears. `tools/lib/ff1-text.mjs` documents how each piece was
// measured (disassembly of the map-load routine + ROM-patch probes).
//
//   node tools/npc-dialogue-ff1.mjs            # all maps
//   node tools/npc-dialogue-ff1.mjs 8          # one map
//   node tools/npc-dialogue-ff1.mjs --sprites  # group by sprite entry
//   node tools/npc-dialogue-ff1.mjs --json
//
// ⛔ dialogueId is NOT objType — that was a wrong claim in v1.8.25. The real
// link is a FOUR-BYTE record per type at file 0x395E5:
//     [0] flag index   [1] default line   [2] line after that event   [3] 0
// A per-type handler picks between [1] and [2], so [1] is "the first thing this
// NPC says", not the only thing. See tools/lib/ff1-text.mjs for the trace.

import { loadRom, mapObjects, MAPOBJ_PER_MAP, decodeString } from './lib/ff1-text.mjs';

const rom = loadRom();
const args = process.argv.slice(2);
const only = args.filter(a => /^\d+$/.test(a)).map(Number);

const rows = [];
for (let mapId = 0; mapId < 64; mapId++) {
  if (only.length && !only.includes(mapId)) continue;
  for (const o of mapObjects(rom, mapId)) {
    rows.push({
      mapId, slot: o.slot, objType: o.type, x: o.x, y: o.y,
      inRoom: o.inRoom, still: o.still,
      spriteEntry: o.sprite, spriteOffset: '0x' + o.spriteOffset.toString(16).toUpperCase(),
      dialogueId: o.dialogueId, dialogueAfter: o.dialogueAfter,
      text: decodeString(rom, o.dialogueId),
    });
  }
}

if (args.includes('--json')) {
  console.log(JSON.stringify({
    rule: 'sprite = 0xA210 + SPRITE_TABLE[objType]*0x100 (0x2E10); ' +
          'dialogue = [flag, default, after, 0] at 0x395E5 + objType*4',
    slotsPerMap: MAPOBJ_PER_MAP, objects: rows,
  }, null, 2));
} else if (args.includes('--sprites')) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.spriteEntry)) by.set(r.spriteEntry, { off: r.spriteOffset, types: new Set(), n: 0 });
    const e = by.get(r.spriteEntry); e.types.add(r.objType); e.n++;
  }
  console.log(`FF1 — ${by.size} sprite entries in use across ${rows.length} objects\n`);
  for (const [e, v] of [...by].sort((a, b) => a[0] - b[0])) {
    console.log(`entry ${String(e).padStart(2)}  ${v.off}   ${v.n} objects, ${v.types.size} types`);
    console.log(`     types: ${[...v.types].sort((a, b) => a - b).join(',')}`);
  }
} else {
  console.log(`FF1 map objects — ${rows.length} across ${new Set(rows.map(r => r.mapId)).size} maps` +
              `   (sprite = 0xA210 + table[objType]*0x100)\n`);
  let last = -1;
  for (const r of rows) {
    if (r.mapId !== last) { console.log(`── map ${r.mapId} ──`); last = r.mapId; }
    const f = (r.inRoom ? ' [room]' : '') + (r.still ? ' [still]' : '');
    console.log(`  slot${String(r.slot).padStart(2)}  type ${String(r.objType).padStart(3)} @(${r.x},${r.y})${f}` +
                `   sprite ${String(r.spriteEntry).padStart(2)} ${r.spriteOffset}   str ${r.dialogueId}`);
    console.log(`        "${r.text}"`);
  }
}
