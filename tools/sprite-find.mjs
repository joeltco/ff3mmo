#!/usr/bin/env node
// sprite-find.mjs — locate a 16x16 sprite in a CHR-RAM ROM by SHAPE.
//
// FF3/FF1/FF2 are all CHR-RAM (iNES CHR size 0), so tiles live inside PRG and
// there is no CHR bank to browse — you have to scan the whole ROM.
//
// Matching is transparent-vs-drawn ONLY. Palette indices cannot be known ahead
// of time, and a reference taken from a screenshot has usually lost the outline
// colour to JPEG noise; an exact colour match therefore produces false
// NEGATIVES. Shape survives both.
//
// SELF-TEST FIRST. Build a reference from a sprite already known to be in the
// ROM (e.g. the moogle at 0x01EA10) and confirm this reports distance 0 at that
// offset. An earlier version of this search silently matched nothing at all,
// and "0 results" from an unproven searcher is worth nothing.
//
//   node tools/sprite-find.mjs ref16.json rom.nes [more.nes ...]
//
// ref16.json is a 16x16 array of ints; any non-zero counts as "drawn".

import fs from 'node:fs';

// Whole-16x16 SHAPE search: compares only transparent-vs-drawn, so a palette we
// cannot know (and a JPEG reference that flattened any outline colour) cannot
// cause a false negative. Tries the two common 4-tile layouts.
const grid = JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const mask = [];
for (let y=0;y<16;y++) for (let x=0;x<16;x++) mask.push(grid[y][x] !== 0 ? 1 : 0);
function tileMask(rom, off){
  const m=new Uint8Array(64);
  for(let y=0;y<8;y++){const lo=rom[off+y],hi=rom[off+8+y];
    for(let x=0;x<8;x++){const b=7-x;m[y*8+x]=(((lo>>b)&1)|((hi>>b)&1))?1:0;}}
  return m;
}
const LAYOUTS = { 'TL,TR,BL,BR':[0,1,2,3], 'TL,BL,TR,BR':[0,2,1,3] };
for (const path of process.argv.slice(3)) {
  const rom = new Uint8Array(fs.readFileSync(path));
  const name = path.split('/').pop();
  for (const [lname, ord] of Object.entries(LAYOUTS)) {
    let best = { d: 1e9, off: -1 };
    for (let off=0; off+64<=rom.length; off+=16) {
      const q = [tileMask(rom,off), tileMask(rom,off+16), tileMask(rom,off+32), tileMask(rom,off+48)];
      let d = 0;
      for (let y=0;y<16 && d<best.d;y++) for (let x=0;x<16;x++) {
        const qi = (y>7?2:0)+(x>7?1:0);
        const t = q[ord[qi]];
        if (mask[y*16+x] !== t[(y%8)*8+(x%8)]) { d++; if (d>=best.d) break; }
      }
      if (d < best.d) best = { d, off };
    }
    console.log(`${name}  layout ${lname}: best shape distance ${best.d}/256 px at 0x${best.off.toString(16)}`);
  }
}
