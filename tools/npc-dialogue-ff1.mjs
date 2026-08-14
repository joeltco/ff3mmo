#!/usr/bin/env node
// npc-dialogue-ff1.mjs — every FF1 map object, with where it stands and what
// it says. `tools/lib/ff1-text.mjs` documents how each piece was measured.
//
//   node tools/npc-dialogue-ff1.mjs            # maps that have objects
//   node tools/npc-dialogue-ff1.mjs 0 1 2      # specific maps
//   node tools/npc-dialogue-ff1.mjs --json
//   node tools/npc-dialogue-ff1.mjs --names    # only the self-identifying ones

import { loadRom, decodeString, mapObjects } from './lib/ff1-text.mjs';

const rom = loadRom();
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const NAMES_ONLY = args.includes('--names');
const only = args.filter(a => /^\d+$/.test(a)).map(Number);

/**
 * A name only counts when the speaker identifies ITSELF.
 * "I am Jane, Queen of Coneria" names Jane. "Garland used to be a good
 * knight" does NOT name that NPC Garland — it is somebody talking about him.
 */
export function selfName(text) {
  let m = /^I am ([A-Z][A-Za-z]+)/.exec(text);
  if (m) return m[1];
  m = /^I,? ([A-Z][A-Za-z]+),/.exec(text);
  if (m) return m[1];
  m = /^My name is ([A-Z][A-Za-z]+)/.exec(text);
  if (m) return m[1];
  // ⛔ NO "^Name:" rule here. FF1 writes ellipsis as "::", so "Oh:: My
  // sister::" matches it and yields a character called "Oh". FF3 can use that
  // pattern because it really does prefix speakers with "Cid:"; FF1 does not.
  return null;
}

const rows = [];
// ⛔ 64 maps, and every object must satisfy Y <= 63. Reading past the end of
// the table yields plausible-looking rows with Y of 160+ — sweeping to 128
// invented eight extra "Kope"s standing at y=161. The invariant is the guard.
for (let mapId = 0; mapId < 64; mapId++) {
  if (only.length && !only.includes(mapId)) continue;
  const objs = mapObjects(rom, mapId);
  if (!objs.length) continue;
  if (objs.some(o => o.y > 63)) continue;
  for (const o of objs) {
    const text = decodeString(rom, o.type);
    rows.push({
      mapId, objType: o.type, x: o.x, y: o.y,
      inRoom: o.inRoom, still: o.still,
      dialogueId: o.type, name: selfName(text), text,
    });
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ rule: 'dialogueId === objType', objects: rows }, null, 2));
} else if (NAMES_ONLY) {
  const named = rows.filter(r => r.name);
  console.log(`FF1 — ${named.length} objects that name themselves\n`);
  for (const r of named) {
    console.log(`map ${String(r.mapId).padStart(2)} obj ${String(r.objType).padStart(3)} (${r.x},${r.y})  «${r.name}»`);
    console.log(`     "${r.text}"`);
  }
} else {
  let last = -1;
  console.log(`FF1 map objects — ${rows.length} across ${new Set(rows.map(r => r.mapId)).size} maps` +
              `   (dialogue id == object type)\n`);
  for (const r of rows) {
    if (r.mapId !== last) { console.log(`── map ${r.mapId} ──`); last = r.mapId; }
    const flags = (r.inRoom ? ' [room]' : '') + (r.still ? ' [still]' : '');
    console.log(`  obj ${String(r.objType).padStart(3)} (${r.x},${r.y})${flags}${r.name ? '  «' + r.name + '»' : ''}`);
    console.log(`     ${r.text ? '"' + r.text + '"' : '(silent)'}`);
  }
  const named = rows.filter(r => r.name);
  console.log(`\n${named.length} name themselves: ` +
    [...new Set(named.map(r => r.name))].join(', '));
}
