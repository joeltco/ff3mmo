// Capture the ITEM row. Everything that blocked this is now solved:
//
//  - the battle cannot end (unkillable, harmless goblin)
//  - navigation is VERIFIED per press, not counted. The command cursor is OAM
//    tile 0x59; parked on a monster it means target-select, parked in the menu
//    gutter (x<70, y 168/184/200/216) it means command-select and its Y is the
//    row. Three earlier attempts failed because presses were being swallowed
//    during target-select and the script kept counting anyway.
//  - the bag is stocked, re-asserted EVERY FRAME, because a poke made before the
//    fight is rewritten once combat starts. Verified visually: the item list
//    reads "Potion" instead of empty slots.
//
// Two arms, because Item on an empty bag is a fact about the inventory rather
// than the command. A sound in STOCKED and absent from EMPTY is the item sound.
const { readFileSync, writeFileSync, mkdtempSync } = require('fs');
const { tmpdir } = require('os'); const { join } = require('path');
const { Nes } = require('/home/joeltco/projects/ff3mmo/tools/monscan/nes.cjs');
const ENCOUNTER_SET=0x05C010, ENCOUNTER_MON=0x05C410, ENCOUNTER_STR=0x05CA10;
const MONSTER_PROPS=0x060010, STAT_TABLE=0x061010;
// A Potion on a FULL-HP party is refused — 16 verified picks produced nothing
// but the error buzz, identical to an empty bag. Same no-op trap as the pond and
// the cure-status spells. Bomb Shard (0xb1) is a battle_item that damages the
// enemy, so it cannot be refused for having nothing to do.
const SRAM=0x6000, INV_IDS=0x0C0, INV_QTY=0x0E0;
const ITEM=parseInt(process.env.ITEM||'0xb1',16);

function sandbox(){
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
  const dir=mkdtempSync(join(tmpdir(),'icap-'));const P=join(dir,'i.nes');writeFileSync(P,rom);return P;
}

function run(stocked, picks, shotTag){
  const P=sandbox();
  const hits=[]; let nes=null, PH='boot';
  nes=new Nes(P,{onBatteryRamWrite:(a,v)=>{ if(a===0x7F49&&nes) hits.push({v,ph:PH}); }});
  const n=nes;
  const _run=n.run.bind(n);
  n.run=(k)=>{ for(let i=0;i<k;i++){ _run(1);
    if(stocked) for(let s=0;s<4;s++){ n.ram[SRAM+INV_IDS+s]=ITEM; n.ram[SRAM+INV_QTY+s]=9; } } return n; };
  n.run(300);
  for(let i=0;i<25;i++) n.press('start',6,45);
  for(let b=0;b<10;b++){for(let k=0;k<6;k++) n.press('a',8,25); n.press('down',8,40);}
  const sc=()=>{let c=0;for(let i=0;i<64;i++) if(n.nes.ppu.sprY[i]<0xEF) c++; return c;};
  const reach=()=>{for(let blk=0;blk<250;blk++){for(const d of ['down','up','right','left']){n.hold(d,16);n.run(4);if(sc()>12)return true;} if(blk%7===6){n.hold(blk%2?'right':'left',40);n.run(6);}}return false;};
  PH='walk'; if(!reach()) return {picks:0,hits};
  n.run(160);
  const cur=()=>{const p=n.nes.ppu; for(let i=0;i<64;i++) if(p.sprTile[i]===0x59&&p.sprY[i]<0xEF) return {x:p.sprX[i],y:p.sprY[i]}; return null;};
  const cmdRow=()=>{const c=cur(); if(!c) return -1;
    return (c.x<70 && c.y>=160 && c.y<=224) ? Math.round((c.y-168)/16) : -1; };
  // Using an item runs an effect animation, so the command window can be gone
  // for a while. The first four-press run got exactly ONE pick because this gave
  // up after 14 tries; wait longer and idle between probes rather than mashing.
  const waitCmd=(t)=>{for(let i=0;i<t;i++){ if(cmdRow()>=0) return true;
    if(sc()<=12){PH='rewalk'; if(!reach())return false; n.run(160);}
    if(i%3===2) n.run(60); else n.press('a',6,22);} return cmdRow()>=0;};
  const goRow=(w,t)=>{for(let i=0;i<t;i++){const r=cmdRow(); if(r<0)return false; if(r===w)return true; n.press('down',8,24);} return cmdRow()===w;};
  let done=0, shots=0;
  for(let i=0;i<picks;i++){
    PH='nav';
    if(!waitCmd(40)) break;
    if(!goRow(3,10)) continue;
    PH='item';
    // Four presses, not three. Traced with the cursor: A opens the list, A picks
    // the item, A enters TARGET SELECT (the cursor jumps from the list gutter at
    // x=0 to a party member at x=192), and a fourth A confirms. The earlier runs
    // stopped at three, so the item was never actually used and every pick
    // decayed into the error buzz — identical to an empty bag, which is why both
    // arms matched exactly.
    n.press('a',8,40);                       // open the item list
    if(stocked && shots<1 && shotTag){ n.screenshot(`/tmp/${shotTag}-list.png`); shots++; }
    n.press('a',8,40);                       // pick the first item
    n.press('a',8,44);                       // enter target select
    n.press('a',8,44);                       // confirm the target
    // Hold the sampling window OPEN through the effect animation. 140 frames
    // closes before a Bomb Shard's blast resolves, and a sound that lands just
    // outside the window reads as "this command is silent" — the exact bounded-
    // window mistake that faked a spell impact in v1.7.870.
    n.run(parseInt(process.env.ITEM_WINDOW||'420',10));
    done++;
    PH='idle'; n.run(60);
  }
  return {picks:done,hits};
}
const N=parseInt(process.env.PICKS||'16',10);
const A=run(true,N,'icap'), B=run(false,N,null);
const tal=(h)=>{const t={};for(const x of h) if(x.ph==='item') t[x.v]=(t[x.v]||0)+1; return t;};
const ta=tal(A.hits), tb=tal(B.hits);
console.log(`STOCKED: ${A.picks} item picks    EMPTY: ${B.picks} item picks`);
const all=[...new Set([...Object.keys(ta),...Object.keys(tb)].map(Number))].sort((a,b)=>a-b);
console.log('\nvalue  nsf     STOCKED     EMPTY');
for(const v of all) console.log(`$${v.toString(16).padEnd(4)} ${String((v-0x3f)&0xff).padEnd(6)}${String(ta[v]||0).padStart(8)}${String(tb[v]||0).padStart(10)}`);
const only=all.filter(v=>(ta[v]||0)>0&&(tb[v]||0)===0);
console.log('\nSTOCKED-only (item-use candidates):', only.length?only.map(v=>`$${v.toString(16)} = nsf ${(v-0x3f)&0xff}`).join(', '):'(none)');
