// launch-capture.cjs — capture an FF3 vehicle LAUNCH ANIMATION off the PPU.
//
// ── THE MECHANISM ───────────────────────────────────────────────────────────
// Event opcode $EF starts a CUTSCENE SEQUENCE by id: handler bank 59 $B6B4 does
// `LDA #$00 / STA $BC / STA $F0 / LDA $71 / JMP $A4FA`, and $A4FA is a CMP chain
// dispatching ids 0-13. Sequence 0 lands on $A8A9 — the SAME bank-59 offset as
// $88A9 viewed through the $8000 window — which raises an object from Y $6F to
// $60, one pixel every fourth frame at fixed X $70, then sets $42/$46 = 5.
//
// Each has exactly ONE caller: $A4FA only from the $EF handler, $A8A9 only from
// the id-0 branch. So sequence 0 is reachable only via `$EF 00`.
//
// ── HOW IT IS TRIGGERED HERE ────────────────────────────────────────────────
// Script 48 is the game's OPENING and always runs, so its tail is rewritten to
// `EF <id> FF`. A rolling frame buffer is dumped the moment $42 becomes 5, so the
// capture is the run-up rather than the aftermath.
//
// ⛔ THE ART THIS PRODUCES IS NOT THE REAL ANIMATION. FF3 is CHR-RAM: sprite
// tiles are decompressed per context, and the opening runs inside Altar Cave,
// where the vehicle's tiles are not loaded. The MOTION is right — measured Y runs
// $6F,$6E,...,$60 exactly as the disassembly says — but the pixels come out as
// whatever text/UI tiles occupy those slots. Capturing real art requires running
// the sequence in the context that loads the vehicle's CHR.
//
//   node tools/monscan/launch-capture.cjs <sheet.png> <strip.png>
//
// Capture FF3's vehicle LAUNCH ANIMATION off the PPU.
//
// The sequence is cutscene id 0 ($EF 00), dispatched at bank 59 $A4FA to $A8A9 —
// the same bank offset as $88A9 seen through the $8000 window. It raises an
// object from Y $6F to $60, one pixel every fourth frame, then sets $42/$46 = 5.
//
// Trigger: script 48 is the game's OPENING and always runs, so its tail is
// rewritten to `EF 00 FF`. A rolling frame buffer keeps the last N frames and is
// dumped the moment $42 becomes 5, so the capture is the run-up, not the aftermath.
const {Nes,BTN,encodePng}=require('/home/joeltco/projects/ff3mmo/tools/monscan/nes.cjs');
const fs=require('fs'),os=require('os'),path=require('path');
const {execFileSync}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lc-'));
const baseRom=path.join(dir,'goblin.nes');
execFileSync('node',['/home/joeltco/projects/ff3mmo/tools/monscan/build-field-rom.cjs',baseRom]);
const b=fs.readFileSync(baseRom);
const bankOff=(bk,a)=>bk*0x2000+0x10+(a>=0xA000?a-0xA000:a-0x8000);
const p=bankOff(0x2C,0x8600)+48*2, ptr=b[p]|(b[p+1]<<8), start=bankOff(0x2D,ptr);
let end=start; for(let n=0;n<200;n++){const op=b[end];
  let len; if(op===0xFE)len=2; else if(op<0xE4)len=1; else if(op<=0xFC)len=2; else len=1;
  if(op===0xFF||op===0xFD)break; end+=len;}
const patchAt=end-4;
const SEQ=parseInt(process.env.SEQ||'0',10), WANT=parseInt(process.env.WANT||'5',10);
b[patchAt]=0xEF; b[patchAt+1]=SEQ; b[patchAt+2]=0xFF;
const romPath=path.join(dir,'launch.nes'); fs.writeFileSync(romPath,b);
const nes=new Nes(romPath); const cpu=nes.nes.cpu;
const RING=300; const ring=[]; let fired=-1, frame=0;
function step(){
  nes.nes.frame(); frame++;
  ring.push({f:frame,fb:Uint32Array.from(nes.fb),y:cpu.mem[0x41],x:cpu.mem[0x40],v:cpu.mem[0x42]});
  if(ring.length>RING) ring.shift();
  if(fired<0 && cpu.mem[0x42]===WANT) fired=frame;
  return fired>=0;
}
const run=n=>{for(let i=0;i<n&&!step();i++);};
const press=(bt,h=8,a=24)=>{nes.nes.buttonDown(1,BTN[bt]);run(h);nes.nes.buttonUp(1,BTN[bt]);run(a);};
run(300);
for(let i=0;i<25&&fired<0;i++)press('start',6,45);
for(let bl=0;bl<10&&fired<0;bl++){for(let k=0;k<6&&fired<0;k++)press('a',8,25);press('down',8,40);}
// the opening plays dialogue that must be advanced before its tail runs
run(1200);
for(let k=0;k<40&&fired<0;k++){ press('a',6,18); run(90); }
console.log(fired<0?`⛔ vehicle ${WANT} never reached`:`✅ vehicle ${WANT} at frame ${fired}; ${ring.length} frames buffered`);
if(fired<0) process.exit(1);
// keep every 4th frame of the run-up (the animation advances once per 4 frames)
const sel=ring.filter((r,i)=>i%4===0).slice(-24);
console.log('sampled frames (frame, $40=X, $41=Y, $42):');
sel.forEach(r=>console.log(`   f${r.f}  X=$${r.x.toString(16)} Y=$${r.y.toString(16)} veh=${r.v}`));
const COLS=6,SC=2,CW=256/SC,CH=240/SC,rows=Math.ceil(sel.length/COLS),W=COLS*CW,H=rows*CH;
const sheet=new Uint32Array(W*H);
sel.forEach((r,k)=>{const ox=(k%COLS)*CW, oy=Math.floor(k/COLS)*CH;
  for(let y=0;y<CH;y++)for(let x=0;x<CW;x++) sheet[(oy+y)*W+ox+x]=r.fb[(y*SC)*256+x*SC];});
fs.writeFileSync(process.argv[2],encodePng(sheet,W,H));
console.log('-> '+process.argv[2]);
// also a zoomed strip of the moving object at X=$70
const Z=4,BW=64,BH=64;
const strip=new Uint32Array(sel.length*BW*Z*BH*Z);
const SW=sel.length*BW*Z;
sel.forEach((r,k)=>{const sx=Math.max(0,Math.min(256-BW,0x70-BW/2)), sy=Math.max(0,Math.min(240-BH,(r.y||0x68)-BH/2));
  for(let y=0;y<BH;y++)for(let x=0;x<BW;x++){const px=r.fb[(sy+y)*256+(sx+x)];
    for(let zy=0;zy<Z;zy++)for(let zx=0;zx<Z;zx++) strip[(y*Z+zy)*SW+(k*BW*Z)+x*Z+zx]=px;}});
fs.writeFileSync(process.argv[3],encodePng(strip,SW,BH*Z));
console.log('-> '+process.argv[3]);
