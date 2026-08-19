// launch-capture.cjs — capture FF3's INVINCIBLE LAUNCH animation, in its real context.
//
// ── THE SEQUENCE ────────────────────────────────────────────────────────────
// Event opcode $EF starts a cutscene SEQUENCE by id (handler bank 59 $B6B4 ->
// $A4FA, a CMP chain over ids 0-13). Sequence 9 is the Invincible's launch and
// ends by setting the vehicle to 7. The game's own invocation is script 162:
//
//     $f0.1 $d0 $fe.3 $c9 $cd  $f9.19  $f8.31 $fc.80  $ef.9 ...
//                             ^^^^^^^ EXIT TO WORLD, *then* the sequence
//
// ⭐ THE EXIT-TO-WORLD IS THE WHOLE TRICK. FF3 is CHR-RAM: sprite tiles are
// decompressed per context. Running $EF 09 from the opening script executes it
// inside Altar Cave, where the craft's tiles are NOT loaded, and the "vehicle"
// renders as whatever text/UI tiles occupy those slots — visibly letters. Doing
// what script 162 does, exiting to the world FIRST, loads the right CHR.
//
// Trigger: the opening script's tail is `f2 2c f2 00 ff` — exactly 5 bytes, the
// same length as `f9 19 ef 09 ff`, so this is a straight overwrite with no reflow.
//
// Verified: all buffered frames report ON THE WORLD MAP (the world tile-property
// table is live at $0400), the craft draws from 40 OAM sprites using tiles
// $b7-$bb and $e2-$fb, and two tile sets alternate — the craft is itself animated.
// Those tiles do NOT overlap mode 7's in-flight sprite ($c6-$cd, $d0-$d5): the
// cutscene uses a dedicated, much larger sprite.
//
// Measured trajectory: X $97->$80, Y $82->$77, one step per four frames — a
// diagonal approach, not the straight rise of sequence 0.
//
//   node tools/monscan/launch-capture.cjs sheet.png [zoom.png] [rip.png]
//
// sheet = full frames, zoom = cropped to the craft, rip = the sprite rebuilt from
// OAM + pattern table + sprite palettes on a flat ground (a real rip, no background).
//
// Capture sequence 9 (the Invincible launch) IN ITS REAL CONTEXT.
//
// Script 162 is the game's own invocation and its prelude is:
//     $f0.1 $d0 $fe.3 $c9 $cd  $f9.19  $f8.31 $fc.80  $ef.9 ...
// i.e. it EXITS TO THE WORLD ($F9) before starting the sequence ($EF 09).
// That is why capturing from the opening produced garbage: the animation is meant
// to run with the WORLD MAP loaded, so the world CHR is what should be resident.
//
// The opening script's tail is `f2 2c f2 00 ff` — exactly 5 bytes, the same as
// `f9 19 ef 09 ff`, so the reproduction is a straight overwrite with no reflow.
const {Nes,BTN,encodePng}=require('/home/joeltco/projects/ff3mmo/tools/monscan/nes.cjs');
const fs=require('fs'),os=require('os'),path=require('path');
const {execFileSync}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'inv-'));
const baseRom=path.join(dir,'g.nes');
execFileSync('node',['/home/joeltco/projects/ff3mmo/tools/monscan/build-field-rom.cjs',baseRom]);
const b=fs.readFileSync(baseRom);
const romJ=new Uint8Array(fs.readFileSync('/home/joeltco/roms/ff3-jp.nes'));
const bankOff=(bk,a)=>bk*0x2000+0x10+(a>=0xA000?a-0xA000:a-0x8000);
const p=bankOff(0x2C,0x8600)+48*2, ptr=b[p]|(b[p+1]<<8), start=bankOff(0x2D,ptr);
let end=start; for(let n=0;n<200;n++){const op=b[end];
  let len; if(op===0xFE)len=2; else if(op<0xE4)len=1; else if(op<=0xFC)len=2; else len=1;
  if(op===0xFF||op===0xFD)break; end+=len;}
const at=end-4;
console.log('original tail: '+Array.from(b.slice(at,end+1)).map(v=>v.toString(16).padStart(2,'0')).join(' '));
const EXITOP=parseInt(process.env.EXIT||'0x19',16);
b[at]=0xF9; b[at+1]=EXITOP; b[at+2]=0xEF; b[at+3]=0x09; b[at+4]=0xFF;
console.log('patched  tail: '+Array.from(b.slice(at,end+1)).map(v=>v.toString(16).padStart(2,'0')).join(' ')+'   (exit-to-world, then sequence 9)');
const romPath=path.join(dir,'inv.nes'); fs.writeFileSync(romPath,b);
const nes=new Nes(romPath); const cpu=nes.nes.cpu;
const onWorld=()=>{let k=0;for(let i=0;i<32;i++) if(cpu.mem[0x0400+i]===romJ[0x510+i])k++;return k===32;};
const RING=340; const ring=[]; let fired=-1, frame=0, sawWorld=-1;
function step(){
  nes.nes.frame(); frame++;
  const oam=nes.nes.ppu.spriteMem; const tl=[];
  for(let i=0;i<256;i+=4) if(oam[i]<0xEF) tl.push(oam[i+1]);
  const ppu=nes.nes.ppu;
  const oamCopy=Array.from(oam);
  const patBase=(ppu.f_spPatternTable?1:0)*0x1000;
  const chr=Array.from(ppu.vramMem.slice(patBase,patBase+0x1000));
  const pal=[]; for(let i=0;i<16;i++) pal.push(ppu.vramMem[0x3F10+i]&0x3F);
  ring.push({f:frame,fb:Uint32Array.from(nes.fb),x:cpu.mem[0x40],y:cpu.mem[0x41],v:cpu.mem[0x42],w:onWorld(),tiles:tl,oam:oamCopy,chr,pal,big:!!ppu.f_spriteSize});
  if(ring.length>RING) ring.shift();
  if(sawWorld<0 && onWorld()) sawWorld=frame;
  if(fired<0 && cpu.mem[0x42]===7) fired=frame;
  return fired>=0;
}
const run=n=>{for(let i=0;i<n&&!step();i++);};
const press=(bt,h=8,a=24)=>{nes.nes.buttonDown(1,BTN[bt]);run(h);nes.nes.buttonUp(1,BTN[bt]);run(a);};
run(300);
for(let i=0;i<25&&fired<0;i++)press('start',6,45);
for(let bl=0;bl<10&&fired<0;bl++){for(let k=0;k<6&&fired<0;k++)press('a',8,25);press('down',8,40);}
run(1200);
for(let k=0;k<45&&fired<0;k++){press('a',6,18);run(90);}
console.log(`world map first seen: frame ${sawWorld<0?'NEVER':sawWorld}`);
console.log(fired<0?'⛔ vehicle 7 never reached':`✅ vehicle 7 at frame ${fired}`);
if(fired<0) process.exit(1);
const anim=ring.filter(r=>r.w);
console.log(`frames buffered ${ring.length}, of which ON THE WORLD MAP: ${anim.length}`);
const sel=(anim.length?anim:ring).filter((r,i)=>i%4===0).slice(-24);
sel.forEach(r=>console.log(`   f${r.f} X=$${r.x.toString(16)} Y=$${r.y.toString(16)} veh=${r.v} OAM=${r.tiles.length} tiles=[${[...new Set(r.tiles)].map(t=>'$'+t.toString(16)).join(' ')}]`));
const animTiles=new Set(); sel.forEach(r=>r.tiles.forEach(t=>animTiles.add(t)));
const INV=new Set([0xc6,0xc7,0xc8,0xc9,0xca,0xcb,0xcc,0xcd,0xd0,0xd1,0xd2,0xd3,0xd4,0xd5]);
const hit=[...animTiles].filter(t=>INV.has(t));
console.log(`\ndistinct OAM tiles during the animation: ${[...animTiles].map(t=>'$'+t.toString(16)).join(' ')}`);
console.log(`overlap with the mode-7 Invincible sprite ($c6-$cd,$d0-$d5): ${hit.length ? hit.map(t=>'$'+t.toString(16)).join(' ') : 'NONE'}`);
const COLS=6,SC=2,CW=256/SC,CH=240/SC,rows=Math.ceil(sel.length/COLS),W=COLS*CW,H=rows*CH;
const sheet=new Uint32Array(W*H);
sel.forEach((r,k)=>{const ox=(k%COLS)*CW,oy=Math.floor(k/COLS)*CH;
  for(let y=0;y<CH;y++)for(let x=0;x<CW;x++) sheet[(oy+y)*W+ox+x]=r.fb[(y*SC)*256+x*SC];});
fs.writeFileSync(process.argv[2],encodePng(sheet,W,H));
console.log('-> '+process.argv[2]);
// zoomed strip, cropped around the sequence's own draw coordinates ($40,$41)
if(process.argv[3]){
  const Z=5,BW=56,BH=56,SW=sel.length*BW*Z;
  const strip=new Uint32Array(SW*BH*Z);
  sel.forEach((r,k)=>{
    const sx=Math.max(0,Math.min(256-BW,r.x-BW/2)), sy=Math.max(0,Math.min(240-BH,r.y-BH/2));
    for(let y=0;y<BH;y++)for(let x=0;x<BW;x++){const px=r.fb[(sy+y)*256+(sx+x)];
      for(let zy=0;zy<Z;zy++)for(let zx=0;zx<Z;zx++) strip[(y*Z+zy)*SW+(k*BW*Z)+x*Z+zx]=px;}});
  fs.writeFileSync(process.argv[3],encodePng(strip,SW,BH*Z));
  console.log('-> '+process.argv[3]);
}
// ── isolated sprite rip: rebuild the craft from OAM + pattern table + sprite palettes
if(process.argv[4]){
  const {NES_SYSTEM_PALETTE}=require('/home/joeltco/projects/ff3mmo/src/tile-decoder.js');
  const picks=[sel[Math.floor(sel.length*0.55)], sel[Math.floor(sel.length*0.55)+1]||sel[sel.length-1]];
  const Z=6,BOX=72,SW=picks.length*BOX*Z;
  const out=new Uint32Array(SW*BOX*Z).fill(0xFF202020);
  picks.forEach((r,k)=>{
    if(!r) return;
    const cx=r.x, cy=r.y;
    for(let i=0;i<256;i+=4){
      const sy=r.oam[i]+1, tile=r.oam[i+1], attr=r.oam[i+2], sx=r.oam[i+3];
      if(r.oam[i]>=0xEF) continue;
      const px0=sx-(cx-BOX/2), py0=sy-(cy-BOX/2);
      if(px0<-8||py0<-8||px0>=BOX||py0>=BOX) continue;
      const pi=(attr&3)*4, hf=attr&0x40, vf=attr&0x80;
      for(let y=0;y<8;y++)for(let x=0;x<8;x++){
        const tx=hf?7-x:x, ty=vf?7-y:y;
        const lo=(r.chr[tile*16+ty]>>(7-tx))&1, hi=(r.chr[tile*16+ty+8]>>(7-tx))&1;
        const ci=lo|(hi<<1); if(!ci) continue;
        const rgb=NES_SYSTEM_PALETTE[r.pal[pi+ci]]||[0,0,0];
        const col=0xFF000000|(rgb[2]<<16)|(rgb[1]<<8)|rgb[0];
        const ox=px0+x, oy=py0+y;
        if(ox<0||oy<0||ox>=BOX||oy>=BOX) continue;
        for(let zy=0;zy<Z;zy++)for(let zx=0;zx<Z;zx++) out[(oy*Z+zy)*SW+(k*BOX*Z)+ox*Z+zx]=col;
      }
    }
  });
  fs.writeFileSync(process.argv[4],encodePng(out,SW,BOX*Z));
  console.log('-> '+process.argv[4]+'   (isolated sprite rip, 2 animation frames)');
}
