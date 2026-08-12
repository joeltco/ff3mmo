// Do MONSTER SPECIALS play $8f?
//
// $c8 was identified exactly this way — caught as a Flyer used "Glare". $8f's
// site is in the battle bank and no weapon class or (pending) job command
// produces it, so a monster special is the remaining candidate.
//
// Patch every encounter to one chosen monster, give it 0x7FFF HP so the fight
// cannot end early, and leave its attack script INTACT (unlike the sandbox used
// elsewhere, which zeroes the monster so it cannot act). The party attacks; the
// monster gets many turns to roll its special.
const { readFileSync, writeFileSync, mkdtempSync } = require('fs');
const { tmpdir } = require('os'); const { join } = require('path');
const { Nes } = require('/home/joeltco/projects/ff3mmo/tools/monscan/nes.cjs');
const ENCOUNTER_SET=0x05C010, ENCOUNTER_MON=0x05C410, ENCOUNTER_STR=0x05CA10;
const MONSTER_PROPS=0x060010, STAT_TABLE=0x061010;
const MON=parseInt(process.env.MON||'0x01',16);
const rom=Buffer.from(readFileSync('/home/joeltco/projects/ff3mmo/FF3-English.nes'));
let list=null;
for(let m=0;m<256&&list===null;m++){const o=ENCOUNTER_MON+m*6;
  for(let s=0;s<4;s++) if(rom[o+2+s]===0x00){list=m;break;}}
const mo=ENCOUNTER_MON+list*6;
rom[mo+2]=MON; rom[mo+3]=0xFF; rom[mo+4]=0xFF; rom[mo+5]=0xFF;
const props=MONSTER_PROPS+MON*16;
rom[props+1]=0xFF; rom[props+2]=0x7F;                  // unkillable so it keeps acting
const so=STAT_TABLE+rom[props+9]*3;
rom[so+2]=0x00;                                        // 0 attack power: party survives
rom[ENCOUNTER_STR]=1;rom[ENCOUNTER_STR+1]=0;rom[ENCOUNTER_STR+2]=0;rom[ENCOUNTER_STR+3]=0;
for(let e=0;e<256;e++){rom[ENCOUNTER_SET+e*2]=list;rom[ENCOUNTER_SET+e*2+1]&=0xC0;}
const dir=mkdtempSync(join(tmpdir(),'mon-'));const P=join(dir,'m.nes');writeFileSync(P,rom);
const hits=[]; let nes=null, PH='boot';
nes=new Nes(P,{onBatteryRamWrite:(a,v)=>{ if(a===0x7F49&&nes) hits.push({v,ph:PH}); }});
const n=nes;
n.run(300);
for(let i=0;i<25;i++) n.press('start',6,45);
for(let b=0;b<10;b++){for(let k=0;k<6;k++) n.press('a',8,25); n.press('down',8,40);}
const sc=()=>{let c=0;for(let i=0;i<64;i++) if(n.nes.ppu.sprY[i]<0xEF) c++; return c;};
const reach=()=>{for(let blk=0;blk<250;blk++){for(const d of ['down','up','right','left']){n.hold(d,16);n.run(4);if(sc()>12)return true;}if(blk%7===6){n.hold(blk%2?'right':'left',40);n.run(6);}}return false;};
PH='walk'; if(!reach()){console.log(`mon 0x${MON.toString(16)}: no battle`);process.exit(0);}
n.run(150); PH='fight';
for(let r=0;r<parseInt(process.env.ROUNDS||'10',10);r++){ for(let i=0;i<5;i++) n.press('a',6,24); n.run(200); if(sc()<=12){ PH='walk'; if(!reach()) break; n.run(150); PH='fight'; } }
const t={}; for(const h of hits) if(h.ph==='fight') t[h.v]=(t[h.v]||0)+1;
const has=(t[0x8f]||0)>0;
console.log(`mon 0x${MON.toString(16).padStart(2,'0')}  ${has?'*** $8f ***  ':''}`
  + Object.entries(t).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([v,c])=>`$${(+v).toString(16)}=${((+v)-0x3f)&0xff}x${c}`).join(' '));
