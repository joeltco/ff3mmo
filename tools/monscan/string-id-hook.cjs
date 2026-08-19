// string-id-hook.cjs — recover the ACTUAL FF3 string id a script resolves to.
//
// ⭐ WHY: `$F1` takes a ONE-BYTE operand; the id is completed by a bank in `$95`,
// which `$B6CE` sets to `$84` when `$78` == 0 and `$86` otherwise. So an operand
// alone does not identify a string, and both candidate decodes are usually
// coherent prose — which is exactly how a wrong vehicle naming got published.
//
// This sidesteps the banking entirely. The global 2-byte string-pointer table is
// at file 0x30010 = bank 24, CPU $8000, so id N's pointer sits at $8000 + N*2.
// Hook cpu.load, confirm bank 24 is really mapped there (compare live memory
// against the ROM at several offsets), and the ADDRESS IS THE ID.
//
// ⛔ Do NOT try to read the message off the screen instead. The box does write
// nametable $2000 and the glyph decode works, but no dialogue renders in this
// harness at all — the party cycles encounters and never reaches the field
// dialogue state, so only battle text ever appears.
//
// Verified: with the opening script's tail patched to `fc 40 f1 0f ff`, the hook
// reports id 0x00F ("Cid: ...You'll make great use of my airship") and never
// 0x20F, alongside the opening's own 0x000/0x006/0x007/0x008. That is the
// $78 == 0 case of the rule, measured rather than assumed.
//
// ⚠ The $78 != 0 direction is NOT confirmed: pinning $78 makes the script take a
// different branch (it starts resolving map-name strings such as 0x1BB) and the
// message is never reached, so PIN78 does not falsify the rule cleanly.
//
//   OP=15 node tools/monscan/string-id-hook.cjs
//   OP=15 PIN78=1 node tools/monscan/string-id-hook.cjs
//
// Recover FF3 string ids by hooking the STRING-POINTER READ.
//
// The global 2-byte pointer table lives at file 0x30010 = bank 24, CPU $8000.
// String id N's pointer is therefore at $8000 + N*2. Hook cpu.load, confirm
// bank 24 is actually mapped at $8000 (compare live memory against the ROM),
// and the address IS the id — no $78, no bank arithmetic, no rendering.
const {Nes,BTN}=require('/home/joeltco/projects/ff3mmo/tools/monscan/nes.cjs');
const fs=require('fs'),os=require('os'),path=require('path');
const {execFileSync}=require('child_process');
(async()=>{
const {decodeString}=await import('/home/joeltco/projects/ff3mmo/tools/lib/ff3-text.mjs');
const ROMPATH='/home/joeltco/projects/ff3mmo/FF3-English.nes';
const rj=new Uint8Array(fs.readFileSync(ROMPATH));
const PTR_FILE=0x030010;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sp-'));
const baseRom=path.join(dir,'g.nes');
execFileSync('node',['/home/joeltco/projects/ff3mmo/tools/monscan/build-field-rom.cjs',baseRom]);
const base=fs.readFileSync(baseRom);
const bankOff=(b,a)=>b*0x2000+0x10+(a>=0xA000?a-0xA000:a-0x8000);
const p=bankOff(0x2C,0x8600)+48*2, ptr=base[p]|(base[p+1]<<8), start=bankOff(0x2D,ptr);
let end=start; for(let n=0;n<200;n++){const op=base[end];
  let len; if(op===0xFE)len=2; else if(op<0xE4)len=1; else if(op<=0xFC)len=2; else len=1;
  if(op===0xFF||op===0xFD)break; end+=len;}
const at=end-4;
const OP=parseInt(process.env.OP||'15',10);
const b=Buffer.from(base); b[at]=0xFC; b[at+1]=0x40; b[at+2]=0xF1; b[at+3]=OP; b[at+4]=0xFF;
// ⭐ WORLD=n pins $78 at BOOT by rewriting the save load at $C0DE
//   C0DE  AD 08 60  LDA $6008
//   C0E1  85 78     STA $78
// as `LDA #n ; NOP`. This mimics a save made in world n, unlike pinning $78
// every frame (PIN78), which desynchronises the script mid-run.
if(process.env.WORLD!==undefined){
  const FIXED=16+b[4]*16384-16384, at2=FIXED+(0xC0DE-0xC000);
  if(b[at2]!==0xAD||b[at2+1]!==0x08||b[at2+2]!==0x60) throw new Error('expected LDA $6008 at $C0DE');
  b[at2]=0xA9; b[at2+1]=parseInt(process.env.WORLD,10)&0xFF; b[at2+2]=0xEA;
  console.log('WORLD pinned: $78 <- '+process.env.WORLD+' at boot');
}
const romPath=path.join(dir,'m.nes'); fs.writeFileSync(romPath,b);
const nes=new Nes(romPath); const cpu=nes.nes.cpu;
// is bank 24 currently mapped at $8000? sample a few offsets
const SAMPLES=[0x000,0x101,0x2aa,0x3ff,0x555,0x6ff,0x77e];
function bank24Mapped(){
  for(const o of SAMPLES) if(cpu.mem[0x8000+o]!==base[PTR_FILE+o]) return false;
  return true;
}
const ids=new Map();
const orig=cpu.load.bind(cpu);
cpu.load=function(addr){
  if(addr>=0x8000 && addr<0x8800 && bank24Mapped()){
    const id=(addr-0x8000)>>1;
    ids.set(id,(ids.get(id)||0)+1);
  }
  return orig(addr);
};
// optionally PIN $78 (the world index) every frame, to prove the banking rule
// fires in both directions rather than only observing the $78==0 case.
const PIN=process.env.PIN78!==undefined?parseInt(process.env.PIN78,10):null;
const run=n=>{for(let i=0;i<n;i++){ if(PIN!==null) cpu.mem[0x78]=PIN; nes.nes.frame(); }};
const press=(bt,h=8,a=24)=>{nes.nes.buttonDown(1,BTN[bt]);run(h);nes.nes.buttonUp(1,BTN[bt]);run(a);};
const spr=()=>{let n=0;const o=nes.nes.ppu.spriteMem;for(let i=0;i<256;i+=4)if(o[i]<0xEF)n++;return n;};
run(300);
for(let i=0;i<25;i++)press('start',6,45);
for(let bl=0;bl<10;bl++){for(let k=0;k<6;k++)press('a',8,25);press('down',8,40);}
run(400);
for(let r=0;r<20&&spr()>12;r++){for(let k=0;k<8;k++)press('a',6,18);run(120);}
for(let i=0;i<10;i++)press('a',6,20);
run(600);
for(let k=0;k<40;k++){press('a',6,14);run(70);}
const sorted=[...ids].sort((a,b)=>b[1]-a[1]);
console.log(`distinct string ids whose pointer was read: ${sorted.length}`);
console.log(`operand under test: ${OP}  ->  candidates 0x${OP.toString(16)} / 0x${(0x200+OP).toString(16)}`);
console.log('');
console.log('top ids by read count:');
for(const [id,n] of sorted.slice(0,18)){
  let t=''; try{t=decodeString(rj,id).replace(/\\s+/g,' ').slice(0,64);}catch(e){t='<err>';}
  const mark=(id===OP)?'  <== bank $84':(id===(0x200+OP)?'  <== bank $86':'');
  console.log(`   0x${id.toString(16).padStart(3,'0')}  x${String(n).padStart(4)}  ${t}${mark}`);
}
console.log('');
console.log(`0x${OP.toString(16)} read? ${ids.has(OP)?'YES ('+ids.get(OP)+')':'no'}    0x${(0x200+OP).toString(16)} read? ${ids.has(0x200+OP)?'YES ('+ids.get(0x200+OP)+')':'no'}`);
})();
