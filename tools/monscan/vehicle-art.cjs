// vehicle-art.cjs — capture FF3's world-map VEHICLE sprites off the PPU.
//
// Boots straight onto open ocean with a chosen vehicle pinned (see
// world-harness.cjs) and crops the party sprite out of the rendered frame, so
// what lands in the PNG is what the NES drew — no hand-authored pixels.
//
// The vehicle is save field $600F, copied at boot to BOTH $42 (the movement
// mode that indexes the mask table at $C6CD) and $46. Forcing $42 alone does
// NOT change the sprite; $46 is what sprite selection follows.
//
// ⚠ The engine NORMALISES the request against the terrain you start on: asking
// for a boat while standing on grass silently gives you mode 0. Start on water.
//
//   node tools/monscan/vehicle-art.cjs <outdir>
//
const H=require('/home/joeltco/projects/ff3mmo/tools/monscan/world-harness.cjs');
const {encodePng}=require('/home/joeltco/projects/ff3mmo/tools/monscan/nes.cjs');
const fs=require('fs');
const SITE=[37,14];   // open ocean, so boats sit clear of clutter
const Z=6, CELL=48*Z;
const cells=[];
for(let v=0;v<8;v++){
  let nes; try{ nes=H.bootToWorldMap({worldX:SITE[0],worldY:SITE[1],vehicle:v}); }
  catch(e){ console.log(`vehicle ${v}: boot failed`); cells.push(null); continue; }
  H.run(nes,40);
  const o=nes.nes.ppu.spriteMem;
  let x0=999,y0=999,x1=-1,y1=-1,cnt=0;
  const tiles=[];
  for(let i=0;i<256;i+=4){ if(o[i]>=0xEF) continue; cnt++;
    const sy=o[i]+1, tile=o[i+1], attr=o[i+2], sx=o[i+3];
    tiles.push({sx,sy,tile,attr});
    x0=Math.min(x0,sx); y0=Math.min(y0,sy); x1=Math.max(x1,sx+8); y1=Math.max(y1,sy+8); }
  if(cnt===0){ cells.push(null); continue; }
  const cx=Math.round((x0+x1)/2), cy=Math.round((y0+y1)/2);
  const sx0=Math.max(0,Math.min(256-48,cx-24)), sy0=Math.max(0,Math.min(240-48,cy-24));
  const cell=new Uint32Array(CELL*CELL);
  for(let y=0;y<48;y++)for(let x=0;x<48;x++){ const px=nes.fb[(sy0+y)*256+(sx0+x)];
    for(let zy=0;zy<Z;zy++)for(let zx=0;zx<Z;zx++) cell[(y*Z+zy)*CELL+(x*Z+zx)]=px; }
  cells.push(cell);
  console.log(`vehicle ${v}: $42=${nes.nes.cpu.mem[0x42]} sprites=${cnt} bbox=${x1-x0}x${y1-y0} tiles=[${[...new Set(tiles.map(t=>'$'+t.tile.toString(16)))].join(' ')}]`);
  fs.writeFileSync(`${process.argv[2]}/vehicle-${v}-tiles.json`, JSON.stringify(tiles,null,1));
}
const COLS=4, rows=Math.ceil(cells.length/COLS), W=COLS*CELL, HH=rows*CELL;
const sheet=new Uint32Array(W*HH);
cells.forEach((c,k)=>{ if(!c)return; const ox=(k%COLS)*CELL, oy=Math.floor(k/COLS)*CELL;
  for(let y=0;y<CELL;y++)for(let x=0;x<CELL;x++) sheet[(oy+y)*W+ox+x]=c[y*CELL+x]; });
fs.writeFileSync(process.argv[2]+'/vehicle-art.png', encodePng(sheet,W,HH));
console.log('-> '+process.argv[2]+'/vehicle-art.png');
