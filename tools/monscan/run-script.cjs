// run-script.cjs — run ANY FF3 event script and read the string ids it resolves.
//
// Repoints slot 48 (the OPENING script, which always runs) at the target
// script's body, so the target executes without needing to reach its real
// trigger. Combined with the string-pointer hook, this reports the ACTUAL ids —
// not a guess between the two banking candidates.
//
//   SCRIPT=83 WORLD=0 node tools/monscan/run-script.cjs
//
// WORLD=n additionally rewrites the save load at $C0DE (`LDA $6008 / STA $78`)
// to `LDA #n ; NOP`, pinning the world at boot as a real save would.
//
// ⛔ WORLD != 0 DOES NOT WORK for this purpose. $78 is taken (map names change —
// "Amur" appears), but the boot state is otherwise incoherent for that world, the
// script diverges, and its messages are never reached: every operand reports
// "neither" candidate. Running a grant script in an ADVANCED world needs a
// coherent late-game save — world AND map AND position AND story flags together —
// not a pinned $78.
//
// Measured with WORLD=0: script 83's operands 50/51/52 resolve to 0x32/0x33/0x34,
// the Saronia thug scene (bank $84) — NOT the Cid/mythril-ram reading at 0x232+.
// That is a measurement, not a coherence argument.
//
// Run an arbitrary script by REPOINTING the opening script's slot at its body,
// then read the string ids it resolves off the string-pointer hook.
//   SCRIPT=83 WORLD=1 node runscript.cjs
const {Nes,BTN}=require('/home/joeltco/projects/ff3mmo/tools/monscan/nes.cjs');
const fs=require('fs'),os=require('os'),path=require('path');
const {execFileSync}=require('child_process');
(async()=>{
const {decodeString}=await import('/home/joeltco/projects/ff3mmo/tools/lib/ff3-text.mjs');
const rj=new Uint8Array(fs.readFileSync('/home/joeltco/projects/ff3mmo/FF3-English.nes'));
const PTR_FILE=0x030010;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rs-'));
const baseRom=path.join(dir,'g.nes');
execFileSync('node',['/home/joeltco/projects/ff3mmo/tools/monscan/build-field-rom.cjs',baseRom]);
const b=fs.readFileSync(baseRom);
const bankOff=(bk,a)=>bk*0x2000+0x10+(a>=0xA000?a-0xA000:a-0x8000);
const TARGET=parseInt(process.env.SCRIPT||'83',10);
// point slot 48 (the opening, which always runs) at TARGET's body
const pT=bankOff(0x2C,0x8600)+TARGET*2, tgtPtr=b[pT]|(b[pT+1]<<8);
const p48=bankOff(0x2C,0x8600)+48*2;
b[p48]=tgtPtr&0xFF; b[p48+1]=tgtPtr>>8;
console.log(`slot 48 -> script ${TARGET} body $${tgtPtr.toString(16)}`);
// expected operands of that script
let o=bankOff(0x2D,tgtPtr); const ops=[];
for(let n=0;n<512;n++){const op=b[o];let len;if(op===0xFE)len=2;else if(op<0xE4)len=1;else if(op<=0xFC)len=2;else len=1;
  ops.push({op,operand:len===2?b[o+1]:null});o+=len;if(op===0xFF||op===0xFD)break;}
const f1=ops.filter(x=>x.op===0xF1).map(x=>x.operand);
console.log(`its $F1 operands: [${f1.join(', ')}]`);
if(process.env.WORLD!==undefined){
  const FIXED=16+b[4]*16384-16384, at2=FIXED+(0xC0DE-0xC000);
  if(b[at2]!==0xAD||b[at2+1]!==0x08||b[at2+2]!==0x60) throw new Error('expected LDA $6008 at $C0DE');
  b[at2]=0xA9; b[at2+1]=parseInt(process.env.WORLD,10)&0xFF; b[at2+2]=0xEA;
  console.log('WORLD pinned: $78 <- '+process.env.WORLD);
}
const romPath=path.join(dir,'r.nes'); fs.writeFileSync(romPath,b);
const nes=new Nes(romPath); const cpu=nes.nes.cpu;
const SAMPLES=[0x000,0x101,0x2aa,0x3ff,0x555,0x6ff,0x77e];
const mapped=()=>{for(const s of SAMPLES) if(cpu.mem[0x8000+s]!==b[PTR_FILE+s]) return false; return true;};
const ids=new Map();
const orig=cpu.load.bind(cpu);
cpu.load=function(a){ if(a>=0x8000&&a<0x8800&&mapped()) { const id=(a-0x8000)>>1; ids.set(id,(ids.get(id)||0)+1);} return orig(a); };
const run=n=>{for(let i=0;i<n;i++)nes.nes.frame();};
const press=(bt,h=8,af=24)=>{nes.nes.buttonDown(1,BTN[bt]);run(h);nes.nes.buttonUp(1,BTN[bt]);run(af);};
const spr=()=>{let n=0;const om=nes.nes.ppu.spriteMem;for(let i=0;i<256;i+=4)if(om[i]<0xEF)n++;return n;};
run(300);
for(let i=0;i<25;i++)press('start',6,45);
for(let bl=0;bl<10;bl++){for(let k=0;k<6;k++)press('a',8,25);press('down',8,40);}
run(400);
for(let r=0;r<20&&spr()>12;r++){for(let k=0;k<8;k++)press('a',6,18);run(120);}
for(let i=0;i<10;i++)press('a',6,20);
run(600);
for(let k=0;k<45;k++){press('a',6,14);run(70);}
console.log(`\n$78 at end = ${cpu.mem[0x78]}   $600B = ${cpu.mem[0x600B]}`);
console.log('operand -> which candidate actually resolved:');
for(const op of f1){
  const lo=ids.has(op), hi=ids.has(0x200+op);
  const pick=lo&&!hi?`0x${op.toString(16)} (bank $84)`:(hi&&!lo?`0x${(0x200+op).toString(16)} (bank $86)`:(lo&&hi?'BOTH':'neither'));
  let t=''; try{t=decodeString(rj, lo?op:(hi?0x200+op:op)).replace(/\s+/g,' ').slice(0,90);}catch(e){}
  console.log(`   op ${String(op).padStart(3)} -> ${pick.padEnd(22)} ${lo||hi?t:''}`);
}
})();
