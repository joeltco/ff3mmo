#!/usr/bin/env node
// audit-talk-reach.mjs — can the player actually PRESS Z on this person?
//
// `check-npc-room` uses tools/lib/talkable.mjs, which allows talking ACROSS a
// solid counter in a straight line. The GAME does not: `movement.js` calls
// `findNpcAt(facedX, facedY)` on the ONE tile the player faces, and if that
// tile is the counter it opens the shop instead. So the gate's rule is strictly
// more permissive than the runtime's, and an NPC that only passes the counter
// clause has dialogue nobody can ever trigger.
//
// This applies the RUNTIME rule: an NPC is talkable only if some tile the
// player can STAND on is orthogonally adjacent to them.
import fs from 'node:fs';
const _ctx = { createImageData: (w,h)=>({data:new Uint8ClampedArray(w*h*4),width:w,height:h}),
  getImageData: (x,y,w,h)=>({data:new Uint8ClampedArray(Math.max(1,w)*Math.max(1,h)*4),width:w,height:h}),
  putImageData(){}, drawImage(){}, fillRect(){}, clearRect(){}, save(){}, restore(){},
  translate(){}, scale(){}, beginPath(){}, rect(){}, clip(){} };
globalThis.document = { createElement: () => ({ width:0, height:0, getContext: () => _ctx }) };
globalThis.window = { addEventListener(){}, matchMedia: () => ({ matches:false }) };

const { loadMap } = await import('../src/map-loader.js');
const { MapRenderer } = await import('../src/map-renderer.js');
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const { calcSpawnY } = await import('./lib/spawn.mjs');
const { playerRegion, isTalkable } = await import('./lib/talkable.mjs');
const { allPageSets } = await import('../src/data/dialogue.js');
const { SHOPS } = await import('../src/data/shops.js');

const ROM = process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname;
let rom; try { rom = new Uint8Array(fs.readFileSync(ROM)); }
catch { console.error('SKIP — no ROM'); process.exit(0); }
const W = 32;

let counterOnly = 0, direct = 0;
for (const [mapId, list] of TOWN_NPCS) {
  const md = loadMap(rom, mapId);
  const { stand } = playerRegion(md, MapRenderer, calcSpawnY);
  for (const n of list) {
    const faceable = [[0,1],[0,-1],[1,0],[-1,0]].some(([dx,dy]) => stand.has((n.y+dy)*W + (n.x+dx)));
    const words = (n.spec.teaches||[]).length || Object.keys(n.spec.answers||{}).length;
    const pages = allPageSets(n.spec.dialogue).filter(Boolean);
    if (faceable) { direct++; continue; }
    counterOnly++;
    const has = pages.length ? `${pages.length} page set(s)` : 'NO dialogue';
    const w = words ? `, ${words} word entr(ies)` : '';
    const gateSays = isTalkable(md, stand, n.x, n.y) ? 'check-npc-room PASSES it' : 'even the gate says no';
    console.log(`[UNTALKABLE] map ${mapId} ${n.key} (${n.x},${n.y}) — ${has}${w}; ${gateSays}`);
    for (const p of pages) console.log(`             unreachable: ${p.map(s=>`"${s}"`).join(' / ')}`);
  }
}
console.log(`\n${direct} NPC(s) the player can face directly, ${counterOnly} reachable only across a counter (the game never talks through one).`);
