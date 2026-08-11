// Does a BOW attack play $8f?
//
// The forced-entry run showed $8f opening a battle attack animation (character
// swings, "1xHit" follows), and it never once fired across four maps of real
// encounters — so it belongs to an attack the starting party cannot perform.
// The starting party swings knives ($b6). Arm one with a bow and arrows and see.
//
// Equipment lives in the character-B block: $6200 + i*0x40, bytes head/body/
// arms/WEAPON/shield -> weapon at +3, shield slot at +4 (arrows go there).
// Re-asserted every frame, because a poke made before the fight is rewritten
// once combat starts (learned the hard way on the item sweep).
const { readFileSync, writeFileSync, mkdtempSync } = require('fs');
const { tmpdir } = require('os'); const { join } = require('path');
const { Nes } = require('/home/joeltco/projects/ff3mmo/tools/monscan/nes.cjs');
const ENCOUNTER_SET=0x05C010, ENCOUNTER_MON=0x05C410, ENCOUNTER_STR=0x05CA10;
const MONSTER_PROPS=0x060010, STAT_TABLE=0x061010;
const SRAM=0x6000, CHARS_B=0x200;
const BOW=parseInt(process.env.BOW||'0x4a',16), ARROW=parseInt(process.env.ARROW||'0x4f',16);
const EQUIP=process.env.EQUIP!=='0';
const rom=Buffer.from(readFileSync('/home/joeltco/projects/ff3mmo/FF3-English.nes'));
let list=null;
for(let m=0;m<256&&list===null;m++){const o=ENCOUNTER_MON+m*6;
  for(let s=0;s<4;s++) if(rom[o+2+s]===0x00){list=m;break;}}
const mo=ENCOUNTER_MON+list*6;
rom[mo+2]=0x00;rom[mo+3]=0xFF;rom[mo+4]=0xFF;rom[mo+5]=0xFF;
rom[MONSTER_PROPS+1]=0xFF;rom[MONSTER_PROPS+2]=0x7F;
const so=STAT_TABLE+rom[MONSTER_PROPS+9]*3; rom[so+1]=0;rom[so+2]=0;rom[MONSTER_PROPS+10]=0;
rom[ENCOUNTER_STR]=1;rom[ENCOUNTER_STR+1]=0;rom[ENCOUNTER_STR+2]=0;rom[ENCOUNTER_STR+3]=0;
for(let e=0;e<256;e++){rom[ENCOUNTER_SET+e*2]=list;rom[ENCOUNTER_SET+e*2+1]&=0xC0;}
const dir=mkdtempSync(join(tmpdir(),'bow-'));const P=join(dir,'b.nes');writeFileSync(P,rom);
const hits=[]; let nes=null, want=null;
nes=new Nes(P,{onBatteryRamWrite:(a,v)=>{ if(a!==0x7F49||!nes) return; hits.push({f:nes.frames,v});
  if(v===0x8f&&want===null) want=nes.frames; }});
const n=nes;
const _run=n.run.bind(n);
n.run=(k)=>{ for(let i=0;i<k;i++){ _run(1);
  if(EQUIP) for(let c=0;c<4;c++){ const b=SRAM+CHARS_B+c*0x40; n.ram[b+3]=BOW; n.ram[b+4]=ARROW; }
  if(want!==null){ const d=n.frames-want; if([1,20,45,80].includes(d)) n.screenshot(`/tmp/bow-${String(d).padStart(3,'0')}.png`); } }
  return n; };
n.run(300);
for(let i=0;i<25;i++) n.press('start',6,45);
for(let b=0;b<10;b++){for(let k=0;k<6;k++) n.press('a',8,25); n.press('down',8,40);}
const sc=()=>{let c=0;for(let i=0;i<64;i++) if(n.nes.ppu.sprY[i]<0xEF) c++; return c;};
let ok=false;
for(let blk=0;blk<250&&!ok;blk++){for(const d of ['down','up','right','left']){n.hold(d,16);n.run(4);if(sc()>12){ok=true;break;}}}
if(!ok){console.log('no battle');process.exit(1);}
n.run(150);
const mark=hits.length;
for(let r=0;r<10;r++){ for(let i=0;i<5;i++) n.press('a',6,26); n.run(150); }
const t={}; for(const h of hits.slice(mark)) t[h.v]=(t[h.v]||0)+1;
console.log(`EQUIP=${EQUIP?'bow 0x'+BOW.toString(16)+' + arrow 0x'+ARROW.toString(16):'stock knives'}`);
console.log('sounds:', Object.entries(t).sort((a,b)=>b[1]-a[1]).map(([v,c])=>`$${(+v).toString(16)}=nsf${((+v)-0x3f)&0xff} x${c}`).join('  '));
console.log(want!==null?`*** $8f fired, first at frame ${want}`:'no $8f');
