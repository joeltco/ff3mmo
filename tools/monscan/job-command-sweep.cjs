// Does any JOB COMMAND play $8f?
//
// $8f is a battle attack animation at $A988 that is not any of the 16 weapon
// classes (WEAPON_ATTACK_SFX). Job commands are the next candidate: the party
// starts as Onion Knights, which have none, so nothing so far could have fired
// one. Job id is byte 0 of the character-A block ($6100 + i*0x40), re-asserted
// every frame like the other pokes.
//
// Rows are selected with the VERIFIED cursor (OAM tile 0x59, x<70, y 168..216),
// never counted presses — that is what made the Item row finally work.
const { readFileSync, writeFileSync, mkdtempSync } = require('fs');
const { tmpdir } = require('os'); const { join } = require('path');
const { Nes } = require('/home/joeltco/projects/ff3mmo/tools/monscan/nes.cjs');
const ENCOUNTER_SET=0x05C010, ENCOUNTER_MON=0x05C410, ENCOUNTER_STR=0x05CA10;
const MONSTER_PROPS=0x060010, STAT_TABLE=0x061010;
const SRAM=0x6000, CHARS_A=0x100;
const JOB=parseInt(process.env.JOB||'0',10);
let shots=0;
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
const dir=mkdtempSync(join(tmpdir(),'job-'));const P=join(dir,'j.nes');writeFileSync(P,rom);
const hits=[]; let nes=null, PH='boot';
nes=new Nes(P,{onBatteryRamWrite:(a,v)=>{ if(a===0x7F49&&nes) hits.push({v,ph:PH}); }});
const n=nes;
const _run=n.run.bind(n);
// Give the magic jobs something to cast. MP is 8 levels x (cur,max) at char-A
// +0x30; the spell list is one id per level at char-B +0x07. Without these the
// Magic row opens an empty list, which measures the character sheet rather than
// the command.
const CHARS_B=0x200, MP_OFF=0x30, SPELL_LIST_OFF=0x07;
const SPELLS=[0x31,0x34,0x32,0x33,0x31,0x34,0x32,0x33];   // Fire/Cure/Bzzard/Sleep...
n.run=(k)=>{ for(let i=0;i<k;i++){ _run(1);
  for(let c=0;c<4;c++){
    const a=SRAM+CHARS_A+c*0x40, b=SRAM+CHARS_B+c*0x40;
    n.ram[a]=JOB;
    for(let l=0;l<8;l++){ n.ram[a+MP_OFF+l*2]=9; n.ram[a+MP_OFF+l*2+1]=9; n.ram[b+SPELL_LIST_OFF+l]=SPELLS[l]; }
  } } return n; };
n.run(300);
for(let i=0;i<25;i++) n.press('start',6,45);
for(let b=0;b<10;b++){for(let k=0;k<6;k++) n.press('a',8,25); n.press('down',8,40);}
const sc=()=>{let c=0;for(let i=0;i<64;i++) if(n.nes.ppu.sprY[i]<0xEF) c++; return c;};
const reach=()=>{for(let blk=0;blk<250;blk++){for(const d of ['down','up','right','left']){n.hold(d,16);n.run(4);if(sc()>12)return true;}if(blk%7===6){n.hold(blk%2?'right':'left',40);n.run(6);}}return false;};
PH='walk'; if(!reach()){console.log(`job ${JOB}: no battle`);process.exit(0);}
n.run(150);
const cur=()=>{const p=n.nes.ppu;for(let i=0;i<64;i++) if(p.sprTile[i]===0x59&&p.sprY[i]<0xEF) return {x:p.sprX[i],y:p.sprY[i]};return null;};
const row=()=>{const c=cur(); if(!c) return -1; return (c.x<70&&c.y>=160&&c.y<=224)?Math.round((c.y-168)/16):-1;};
// The magic jobs wedged because a spell list parks the cursor at x=0, row()
// returns -1 there, and this loop just mashed A forever. Distinguish "in a
// submenu" (cursor exists but is not at the command column) from "no cursor at
// all" and back OUT with B instead of confirming deeper.
const waitCmd=(t)=>{for(let i=0;i<t;i++){ if(row()>=0) return true;
  if(sc()<=12){PH='rewalk'; if(!reach()) return false; n.run(150);}
  const c=cur();
  if(c) n.press('b',6,22);                 // submenu or target select -> escape
  else if(i%3===2) n.run(50);
  else n.press('a',6,22);
} return row()>=0;};
const goRow=(w,t)=>{for(let i=0;i<t;i++){const r=row(); if(r<0)return false; if(r===w)return true; n.press('down',8,24);} return row()===w;};
const ROWS=(process.env.ROWS||'0,1,2,3').split(',').map(Number);
const REPS=parseInt(process.env.REPS||'4',10);
for(const r of ROWS){
  for(let k=0;k<REPS;k++){
    if(!waitCmd(25)) break;
    if(!goRow(r,8)) continue;
    PH='row'+r;
    if(process.env.SHOTS && shots<3){ n.screenshot(`/tmp/bard-row${r}-${shots}.png`); shots++; }
    // FIVE presses. Three opens the spell list and stops there — the previous
    // pass reported a clean "no new sounds" for all ten magic jobs while never
    // actually casting, which is worth nothing. Items needed four (open / pick /
    // enter target / confirm); magic gets one more for slack.
    n.press('a',8,40); n.press('a',8,40); n.press('a',8,44);
    n.press('a',8,44); n.press('a',8,44);
    n.run(320);
    // Back out of anything still open. The magic jobs all TIMED OUT because
    // their Magic row opens a spell list that three A presses cannot finish, so
    // the run wedged and produced NO rows at all — which is "no data", not "this
    // job does not play $8f", and must not be counted as the latter.
    PH='idle';
    n.press('b',6,20); n.press('b',6,20); n.press('b',6,20);
    n.run(60);
  }
}
const t={}; const per={};
for(const h of hits) if(/^row/.test(h.ph)){ t[h.v]=(t[h.v]||0)+1; (per[h.ph]=per[h.ph]||{})[h.v]=((per[h.ph]||{})[h.v]||0)+1; }
for(const [ph,o] of Object.entries(per)) console.log(`  ${ph}: `+Object.entries(o).map(([v,c])=>`$${(+v).toString(16)}=${((+v)-0x3f)&0xff}x${c}`).join(' '));
const has8f = (t[0x8f]||0)>0;
console.log(`job ${String(JOB).padStart(2)}  ${has8f?'*** $8f ***  ':''}`
  + Object.entries(t).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([v,c])=>`$${(+v).toString(16)}=${((+v)-0x3f)&0xff}x${c}`).join(' '));
