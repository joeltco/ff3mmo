#!/usr/bin/env node
// sara-candidates.mjs — pick the princess's face from RENDERED options.
//
// ⛔ SARA AND CID WEAR THE SAME BUNDLE TODAY. `SARA.romOffset` and
// `CID.romOffset` are both `0x1D910` — the ROM's own gfx for her id (67), and
// also the red-cap sprite Joel identified as Cid at a 90.2% shape match. The
// source justified the clash with "Cid is in the pub (map 12); she is out in
// the town (map 10) — never on screen together". That premise is DEAD: she
// left Kazus for the Cave of Seals, and is headed for Castle Sasune's spring
// room. Joel, looking at a render of her: *"thats not sara. thats cid"*.
//
// ⛔ NEVER HAND-AUTHOR THE ART. Every option below is a real ROM walk bundle
// (`0x1C010 + gfx * 0x100`), drawn with the game's own decoder in the palette
// of the room she will stand in.
//
//   node tools/sara-candidates.mjs [--map 24]
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
const _ctx = { createImageData: (w,h)=>({data:new Uint8ClampedArray(w*h*4),width:w,height:h}),
  getImageData: (x,y,w,h)=>({data:new Uint8ClampedArray(Math.max(1,w)*Math.max(1,h)*4),width:w,height:h}),
  putImageData(){}, drawImage(){}, fillRect(){}, clearRect(){}, save(){}, restore(){},
  translate(){}, scale(){}, beginPath(){}, rect(){}, clip(){} };
globalThis.document = { createElement: () => ({ width:0, height:0, getContext: () => _ctx }) };
globalThis.window = { addEventListener(){}, matchMedia: () => ({ matches:false }) };

const { loadMap } = await import('../src/map-loader.js');
const { decodeTile, NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');
const { gfxForNpcId } = await import('../src/data/npc-gfx.js');
const rom = new Uint8Array(fs.readFileSync(new URL('../FF3-English.nes', import.meta.url).pathname));

const MAP = parseInt((process.argv.find(a=>a.startsWith('--map='))||'--map=24').split('=')[1], 10);
const md = loadMap(rom, MAP);
const sp = md.spritePalettes;
const PAL = { top: sp[1], btm: sp[0] };

// Who else wears each bundle, and where they stand — so a clash is visible.
const wearers = new Map();
for (let id = 0; id < 256; id++) {
  const g = gfxForNpcId(rom, id);
  if (g == null) continue;
  const off = 0x1C010 + g * 0x100;
  if (!wearers.has(off)) wearers.set(off, []);
  wearers.get(off).push(id);
}
const { TOWN_NPCS } = await import('../src/data/town-npcs.js');
const usedBy = new Map();
for (const [mapId, list] of TOWN_NPCS)
  for (const r of list) {
    const o = r.spec.romOffset; if (o == null) continue;
    if (!usedBy.has(o)) usedBy.set(o, new Set());
    usedBy.get(o).add(`${r.key}(${mapId})`);
  }

// ⛔ EVERY distinct sprite in the ROM, not just the ones the valley happens to
// load. The first cut of this sheet showed the 14 bundles the beginner-valley
// maps draw and Joel said, correctly, "none of those are sara" — I had filtered
// the answer out of the question before asking it. FF3 assigns 59 distinct gfx
// indices across its 256 npc ids.
const CANDIDATES = [...new Set(
  Array.from({ length: 256 }, (_, id) => gfxForNpcId(rom, id))
       .filter((g) => g != null).map((g) => 0x1C010 + g * 0x100))]
  .sort((a,b)=>a-b)
  // ⛔ THE BANK ENDS. `0x1C010 + gfx*0x100` only addresses walk bundles up to
  // 0x1FF10; past that the ids index into other data entirely and the sheet
  // renders noise and font tiles. The first cut of this sheet drew 24 rows of
  // garbage and presented them as sprite options.
  .filter((off) => off <= 0x1FF10);
const SC = 4, T = 8, COLS = 4, CELL_W = 236, ROW_H = 16*SC + 46;
const ROWS = Math.ceil(CANDIDATES.length / COLS);
const cv = createCanvas(COLS*CELL_W + 16, ROWS*ROW_H + 52);
const g = cv.getContext('2d');
g.imageSmoothingEnabled = false;
g.fillStyle = '#101018'; g.fillRect(0,0,cv.width,cv.height);
g.font = 'bold 13px monospace'; g.fillStyle = '#e8e8f0';
g.fillText(`ALL ${CANDIDATES.length} distinct FF3 NPC sprites — DOWN + walk frame, map ${MAP} palette`, 12, 18);
g.font = '11px monospace'; g.fillStyle = '#9a9ab0';
g.fillText('red 0x1D910 = the one Sara and Cid BOTH wear today. Point at whichever is her.', 12, 36);

const rgb = (v) => NES_SYSTEM_PALETTE[v & 0x3f] || [0,0,0];
function blit(off, frame, dx, dy) {
  for (let t = 0; t < 4; t++) {
    const pal = t < 2 ? PAL.top : PAL.btm;
    const px = decodeTile(rom, off + (frame*4 + t)*16);
    const img = g.createImageData(T*SC, T*SC);
    for (let yy=0; yy<T*SC; yy++) for (let xx=0; xx<T*SC; xx++) {
      const ci = px[Math.floor(yy/SC)*8 + Math.floor(xx/SC)];
      const k = (yy*T*SC+xx)*4;
      if (ci === 0) { img.data[k+3]=0; continue; }
      const [r,gg,b] = rgb(pal[ci]);
      img.data[k]=r; img.data[k+1]=gg; img.data[k+2]=b; img.data[k+3]=255;
    }
    g.putImageData(img, dx + (t%2)*T*SC, dy + Math.floor(t/2)*T*SC);
  }
}
CANDIDATES.forEach((off, i) => {
  const cx = 8 + (i % COLS) * CELL_W;
  const y = 52 + Math.floor(i / COLS) * ROW_H;
  blit(off, 0, cx, y);
  blit(off, 1, cx + 16*SC + 6, y);
  const isCid = off === 0x1D910;
  const tx = cx + 16*SC*2 + 14;
  g.font = 'bold 11px monospace';
  g.fillStyle = isCid ? '#ff8080' : '#ffd77a';
  g.fillText(`0x${off.toString(16).toUpperCase()}`, tx, y + 14);
  if (isCid) { g.fillStyle = '#ff8080'; g.fillText('SARA=CID', tx, y + 28); }
  g.font = '10px monospace'; g.fillStyle = '#9fd8ff';
  const ids = (wearers.get(off) || []);
  g.fillText(`id ${ids.slice(0, 5).join(' ')}${ids.length > 5 ? '+' : ''}`, tx, y + (isCid ? 42 : 28));
  const named = [...(usedBy.get(off) || [])];
  if (named.length) { g.fillStyle = '#8f8fa8'; g.fillText(named[0].slice(0, 18), tx, y + (isCid ? 56 : 42)); }
});
const out = new URL('../docs/sprites/sara-candidates.png', import.meta.url).pathname;
fs.writeFileSync(out, cv.toBuffer('image/png'));
console.log(`${CANDIDATES.length} bundles -> ${out}`);
