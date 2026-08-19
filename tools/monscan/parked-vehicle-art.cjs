// parked-vehicle-art.cjs — rip the world-map PARKED vehicle sprites.
//
// ⛔ THERE IS NO PER-VEHICLE PARKED SPRITE SET. $DC1A is NOT a sprite table — it
// is 16 bytes of LAYOUT/facing offsets (values $00/$10/$20/$30) indexed by $A7,
// OR'd into $80 and used as an offset into the metasprite tables at $DC6A/$DCAA
// ($DA07 / $DA19 build the pointer). The TILE BASE is hard-coded per draw block:
//
//   $DAD8  needs $6000, $6003==$78, $42 not in {3,4}   -> one craft
//   $DB09  needs $6020 bit0, $6000, $42 != 5           -> base $68
//   $DB2F  needs $6020 bit6, $6003==$78, $42 != 6      -> base $68
//   $DB73  if $600B == 4, layout offset $30 instead
//
// So $600B picks a LAYOUT, not a sprite. Two distinct craft exist, not eight.
//
// ⚠ $DAD8 has NO flag gate and fires whenever $6000 != 0, so it cannot be isolated
// by clearing $6020 — it will draw on top of everything. $DB2F does NOT check
// $6000, so clearing $6000 leaves only it. Setting $6020 = $FF fires all blocks at
// once and yields overlapping sprites that look identical for every $600B.
//
//   node tools/monscan/parked-vehicle-art.cjs out.png
//
// The parked-vehicle sprite is NOT per-vehicle. Three draw blocks exist and the
// tile base is hard-coded in each; $600B only picks a LAYOUT offset:
//   $DAD8  needs $6000, $6003==$78, $42 not in {3,4}      -> base $50
//   $DB09  needs $6020 bit0, $6000, $42 != 5              -> base $68
//   $DB2F  needs $6020 bit6, $6003==$78, $42 != 6         -> base $68
//   $DB73  if $600B == 4 -> layout offset $30 instead
// So isolate one block at a time, or they draw on top of each other.
const H=require('/home/joeltco/projects/ff3mmo/tools/monscan/world-harness.cjs');
const {encodePng}=require('/home/joeltco/projects/ff3mmo/tools/monscan/nes.cjs');
const fs=require('fs');
(async()=>{
const romJ=new Uint8Array(fs.readFileSync('/home/joeltco/roms/ff3-jp.nes'));
const {loadWorldMap}=await import('/home/joeltco/projects/ff3mmo/src/world-map-loader.js');
const {NES_SYSTEM_PALETTE}=await import('/home/joeltco/projects/ff3mmo/src/tile-decoder.js');
const w=loadWorldMap(romJ,0);
const b1=(x,y)=>w.tileProps[w.tilemap[((y&127)*128)+(x&127)]&0x7F].byte1;
let site=null;
for(let y=3;y<124&&!site;y++)for(let x=3;x<124;x++){
  const v=b1(x,y); if((v&1)||(v&0x80))continue;
  if((b1(x+2,y)&0x0F)===0b1011){site=[x,y];break;}
}
// $DAD8 has no flag gate and always fires while $6000 != 0, so it cannot be
// isolated by flags. $DB2F does NOT check $6000 — clearing $6000 leaves only it.
const CASES=[
  {name:'$DAD8 base $50  ($600B=1)', flags:0x00, veh:1, owned:1},
  {name:'$DAD8 base $50  ($600B=4)', flags:0x00, veh:4, owned:1},
  {name:'$DB2F base $68  ($6000=0)', flags:0x40, veh:1, owned:0},
  {name:'$DB2F base $68  ($600B=4)', flags:0x40, veh:4, owned:0},
];
const Z=6,BOX=48,cells=[],labels=[];
for(const c of CASES){
  const nes=H.bootToWorldMap({worldX:site[0],worldY:site[1],vehicle:0});
  const m=nes.nes.cpu.mem;
  const px=m[H.PARTY_X], py=m[H.PARTY_Y];
  for(let f=0;f<60;f++){
    m[0x6000]=c.owned; m[0x6001]=(px+3)&0xFF; m[0x6002]=py&0xFF; m[0x6003]=m[0x78];
    m[0x600B]=c.veh;
    for(let k=0;k<16;k++) m[0x6020+k]=0;
    m[0x6020]=c.flags;                    // only the gate under test
    nes.nes.frame();
  }
  const ppu=nes.nes.ppu, oam=ppu.spriteMem;
  const patBase=(ppu.f_spPatternTable?1:0)*0x1000;
  const chr=ppu.vramMem.slice(patBase,patBase+0x1000);
  const pal=Array.from({length:16},(_,i)=>ppu.vramMem[0x3F10+i]&0x3F);
  const ents=[]; for(let i=0;i<256;i+=4) if(oam[i]<0xEF) ents.push({y:oam[i]+1,t:oam[i+1],a:oam[i+2],x:oam[i+3]});
  // the party stands at screen centre; the parked craft is 3 tiles east of it
  // no positional filter — the map scrolls, so the party is not at a fixed spot.
  // Cluster instead: the party is 4 sprites; anything beyond that is the craft.
  const byX=[...ents].sort((a,b)=>a.x-b.x);
  const groups=[]; let g=[];
  for(const e of byX){ if(!g.length||e.x-g[g.length-1].x<=16) g.push(e); else {groups.push(g);g=[e];} }
  if(g.length) groups.push(g);
  groups.sort((a,b)=>b.length-a.length);
  // drop the party (walk tiles $00-$03) so only the parked craft is ripped
const all=groups.flat().filter(e=>e.t>0x03);
const use=all;
  const tiles=[...new Set(use.map(e=>e.t))].map(t=>'$'+t.toString(16));
  console.log(`${c.name.padEnd(34)} sprites=${String(use.length).padStart(2)}  tiles=[${tiles.join(' ')}]`);
  const cell=new Uint32Array(BOX*Z*BOX*Z).fill(0xFF202020);
  if(use.length){
    const x0=Math.min(...use.map(e=>e.x)), y0=Math.min(...use.map(e=>e.y));
    for(const e of use){
      const px0=e.x-x0+8, py0=e.y-y0+8;
      const pi=(e.a&3)*4, hf=e.a&0x40, vf=e.a&0x80;
      for(let yy=0;yy<8;yy++)for(let xx=0;xx<8;xx++){
        const tx=hf?7-xx:xx, ty=vf?7-yy:yy;
        const lo=(chr[e.t*16+ty]>>(7-tx))&1, hi=(chr[e.t*16+ty+8]>>(7-tx))&1;
        const ci=lo|(hi<<1); if(!ci)continue;
        const rgb=NES_SYSTEM_PALETTE[pal[pi+ci]]||[0,0,0];
        const col=0xFF000000|(rgb[2]<<16)|(rgb[1]<<8)|rgb[0];
        const ox=px0+xx, oy=py0+yy;
        if(ox<0||oy<0||ox>=BOX||oy>=BOX)continue;
        for(let zy=0;zy<Z;zy++)for(let zx=0;zx<Z;zx++) cell[(oy*Z+zy)*BOX*Z+ox*Z+zx]=col;
      }
    }
  }
  cells.push(cell); labels.push(c.name);
}
const COLS=4,CELL=BOX*Z,W=COLS*CELL,HH=CELL;
const sheet=new Uint32Array(W*HH).fill(0xFF101010);
cells.forEach((c,k)=>{const ox=k*CELL; for(let y=0;y<CELL;y++)for(let x=0;x<CELL;x++) sheet[y*W+ox+x]=c[y*CELL+x];});
fs.writeFileSync(process.argv[2],encodePng(sheet,W,HH));
console.log('-> '+process.argv[2]);
})();
