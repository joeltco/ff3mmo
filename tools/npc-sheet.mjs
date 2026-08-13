import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
const { decodeTile, NES_SYSTEM_PALETTE } = await import('../src/tile-decoder.js');
const { loadMap } = await import('../src/map-loader.js');
const rom = new Uint8Array(fs.readFileSync(process.env.FF3_ROM));
const mapId = parseInt(process.argv[2], 10);
const md = loadMap(rom, mapId);
// Sprite palettes for this map come from the map props (spritePalette6/7).
const pals = md.spritePalettes || [];
const pal = (pals[0] || [0x0F, 0x0F, 0x16, 0x30]).map(v => NES_SYSTEM_PALETTE[v & 0x3F] || [0,0,0]);
const ids = [...new Set(md.npcs.map(n => n.id))];
const SC = 4, CELL = 16, LBL = 12;
const cv = createCanvas(ids.length * CELL * SC, CELL * SC + LBL);
const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
g.fillStyle = '#202030'; g.fillRect(0,0,cv.width,cv.height);
ids.forEach((id, n) => {
  const off = 0x01C010 + id * 256;         // same convention as MOOGLE_SPRITE_OFF
  const img = g.createImageData(CELL, CELL);
  for (let t = 0; t < 4; t++) {            // frame 0 = 2x2 tiles, facing DOWN
    const tile = decodeTile(rom, off + t * 16);
    const bx = (t % 2) * 8, by = ((t / 2) | 0) * 8;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const v = tile[y*8+x]; const c = pal[v] || [0,0,0];
      const i = ((by+y)*CELL + bx+x)*4;
      img.data[i]=c[0]; img.data[i+1]=c[1]; img.data[i+2]=c[2]; img.data[i+3]= v===0?0:255;
    }
  }
  const tmp = createCanvas(CELL, CELL); tmp.getContext('2d').putImageData(img,0,0);
  g.drawImage(tmp, 0,0,CELL,CELL, n*CELL*SC, LBL, CELL*SC, CELL*SC);
  g.fillStyle='#c8a832'; g.font='10px monospace';
  g.fillText('$'+id.toString(16).padStart(2,'0'), n*CELL*SC+4, 10);
});
fs.writeFileSync(process.argv[3], cv.toBuffer('image/png'));
console.log(`map ${mapId}: ${ids.length} distinct NPC gfx -> ${process.argv[3]}`);
