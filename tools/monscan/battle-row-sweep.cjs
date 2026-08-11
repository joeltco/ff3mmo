// Which sound does each battle COMMAND ROW play?
//
// Attempts 1-3 all died the same way: Guard / Run / Item never kill anything, so
// the party gets worn down, wipes, and the run ends after a couple of rounds.
// "3 rounds over 0 battles" is not a measurement.
//
// So build a battle that cannot end. Patch every encounter to a single goblin,
// give it 0x7FFF HP so it cannot be killed, and zero its hit% AND attack power
// so it cannot kill the party. Same technique spell-sweep.cjs uses to hold a
// spell target still — an injected state, not a guess.
//
// Then pick one command for ALL FOUR characters, many rounds, and tally per row.
// Rows are COMPARED: a battle is full of sounds the player did not cause, and
// those appear under every row. A sound under ONE row only is that row's.
const { readFileSync, writeFileSync, mkdtempSync } = require('fs');
const { tmpdir } = require('os'); const { join } = require('path');
const { Nes } = require('/home/joeltco/projects/ff3mmo/tools/monscan/nes.cjs');

const ENCOUNTER_SET=0x05C010, ENCOUNTER_MON=0x05C410, ENCOUNTER_STR=0x05CA10;
const MONSTER_PROPS=0x060010, STAT_TABLE=0x061010;
const rom = Buffer.from(readFileSync('/home/joeltco/projects/ff3mmo/FF3-English.nes'));

let list=null;
for(let m=0;m<256&&list===null;m++){ const o=ENCOUNTER_MON+m*6;
  for(let s=0;s<4;s++) if(rom[o+2+s]===0x00){ list=m; break; } }
const mo=ENCOUNTER_MON+list*6;
rom[mo+2]=0x00; rom[mo+3]=0xFF; rom[mo+4]=0xFF; rom[mo+5]=0xFF;
const props=MONSTER_PROPS+0x00*16;
rom[props+1]=0xFF; rom[props+2]=0x7F;                 // unkillable
const atkIdx=rom[props+9];
const so=STAT_TABLE+atkIdx*3;
console.log(`goblin atkHitIdx ${atkIdx}: roll ${rom[so]} hit% ${rom[so+1]} power ${rom[so+2]} -> zeroing hit% and power`);
rom[so+1]=0x00; rom[so+2]=0x00;                        // harmless
rom[props+10]=0x00;                                    // no status on hit
rom[ENCOUNTER_STR]=1; rom[ENCOUNTER_STR+1]=0; rom[ENCOUNTER_STR+2]=0; rom[ENCOUNTER_STR+3]=0;
for(let e=0;e<256;e++){ rom[ENCOUNTER_SET+e*2]=list; rom[ENCOUNTER_SET+e*2+1]&=0xC0; }
const dir=mkdtempSync(join(tmpdir(),'rowsb-')); const P=join(dir,'sb.nes');
writeFileSync(P,rom);

const hits=[]; let nes=null, PH='boot';
nes=new Nes(P,{onBatteryRamWrite:(a,v)=>{ if(a===0x7F49&&nes) hits.push({f:nes.frames,v,ph:PH}); }});
const n=nes;
n.run(300);
for(let i=0;i<25;i++) n.press('start',6,45);
for(let b=0;b<10;b++){ for(let k=0;k<6;k++) n.press('a',8,25); n.press('down',8,40); }
const sc=()=>{let c=0;for(let i=0;i<64;i++) if(n.nes.ppu.sprY[i]<0xEF) c++; return c;};
const reach=()=>{ for(let blk=0;blk<250;blk++){ for(const d of ['down','up','right','left']){ n.hold(d,16); n.run(4); if(sc()>12) return true; } if(blk%7===6){n.hold(blk%2?'right':'left',40);n.run(6);} } return false; };
PH='walk';
if(!reach()){ console.log('never reached a battle'); process.exit(1); }
n.run(160);
const PER=parseInt(process.env.PER_ROW||'25',10);
const ROWS=[0,1,2,3];
const done={};
for(const row of ROWS){
  let r=0;
  for(;r<PER;r++){
    if(sc()<=12){ PH='rewalk'; if(!reach()) break; n.run(160); }
    PH='row'+row;
    for(let ch=0;ch<4 && sc()>12;ch++){
      n.press('a',6,16);
      for(let d=0;d<row;d++) n.press('down',6,16);
      n.press('a',6,30);
      n.run(70);
    }
    n.run(120);
  }
  done[row]=r;
  console.log(`  row ${row}: ${r} rounds`);
}
const t={};
for(const h of hits){ if(!/^row\d/.test(h.ph)) continue;
  const r=h.ph.slice(3); (t[r]=t[r]||{})[h.v]=((t[r]||{})[h.v]||0)+1; }
const LABEL={0:'Attack',1:'Guard',2:'Run',3:'Item'};
const all=[...new Set(Object.values(t).flatMap(o=>Object.keys(o).map(Number)))].sort((a,b)=>a-b);
console.log('\nvalue  nsf   ' + ROWS.map(r=>`${LABEL[r]}(${done[r]})`.padStart(12)).join(''));
for(const v of all){
  console.log(`$${v.toString(16).padEnd(4)} ${String((v-0x3f)&0xff).padEnd(5)} `
    + ROWS.map(r=>String((t[r]&&t[r][v])||0).padStart(12)).join(''));
}
