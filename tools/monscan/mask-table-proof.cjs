// mask-table-proof.cjs — prove the $C6CD mask table is what gates movement.
//
// ⛔ WHY NOT A PER-STEP TEST: five attempts at "predict each step, then take it"
// all failed to produce clean data. Reading the party position while it can
// still be mid-move scores the wrong tile; a 20-44 frame press sometimes crosses
// several tiles; and jsnes' savestate load() restores a machine that never moves
// again, so trials cannot be isolated by restoring an anchor. Those runs reported
// 76-81% "agreement" that was mostly instrument noise, including impossible
// results like a walker crossing mountains.
//
// This test avoids per-step measurement entirely. Patch one byte of the mask
// table, walk a lot, and ask only which terrain CLASSES the party ever stood on.
// The check is `AND mask ; CMP mask` -> blocked iff every mask bit is set, so:
//
//   mask[0] = $01  (stock)  walker must NEVER stand on water
//   mask[0] = $80           bit7 is the trigger bit -> almost nothing blocks
//   mask[0] = $00           AND $00 == $00 -> EVERYTHING blocks, party frozen
//
// Measured, from a land tile touching ocean:
//   $01 -> land 120, ocean 0      $80 -> mtn 113, land 5, ocean 2      $00 -> frozen
//
//   node tools/monscan/mask-table-proof.cjs
//
const H=require('/home/joeltco/projects/ff3mmo/tools/monscan/world-harness.cjs');
const fs=require('fs');
(async()=>{
const romJ=new Uint8Array(fs.readFileSync('/home/joeltco/roms/ff3-jp.nes'));
const { loadWorldMap } = await import('/home/joeltco/projects/ff3mmo/src/world-map-loader.js');
const w=loadWorldMap(romJ,0);
const b1=(x,y)=>{const m=w.tilemap[((y&127)*128)+(x&127)]&0x7F;return w.tileProps[m].byte1;};
const CLS={0b0110:'land',0b1110:'forest',0b1011:'ocean',0b1101:'shallow',0b1111:'mtn'};
// a LAND tile that touches ocean — the control must start somewhere a walker
// can actually walk, or "frozen" just means "stranded in the sea".
let START=null;
for(let y=3;y<124&&!START;y++)for(let x=3;x<124;x++){
  const v=b1(x,y); if((v&1)||(v&0x80)) continue;
  const n=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>b1(x+dx,y+dy)&0x0F);
  if(n.includes(0b1011) && n.filter(c=>c===0b0110||c===0b1110).length>=1){ START=[x,y]; break; }
}
console.log('start (land touching ocean):',START,'byte1=$'+b1(START[0],START[1]).toString(16));
async function trial(label, maskTable){
  let nes; try{ nes=H.bootToWorldMap({worldX:START[0],worldY:START[1],vehicle:0,maskTable}); }
  catch(e){ console.log(`${label}: boot failed — ${e.message}`); return; }
  const m=nes.nes.cpu.mem; const visited=new Map();
  const sig=()=>{let k=0;for(let i=0;i<32;i++) if(m[H.PROPS_RAM+i]===romJ[0x510+i])k++;return k;};
  const DIRS=['up','right','up','left','up','right','down','left'];
  try{
    for(let i=0;i<120;i++){
      if(sig()!==32) break;
      H.hold(nes,DIRS[i%DIRS.length],26);
      const c=CLS[b1(m[H.PARTY_X],m[H.PARTY_Y])&0x0F]||'?';
      visited.set(c,(visited.get(c)||0)+1);
    }
  }catch(e){ /* crash on transition; keep what we saw */ }
  const stood=[...visited].sort((a,b)=>b[1]-a[1]).map(([c,n])=>`${c}:${n}`).join('  ');
  console.log(`${label}\n    stood on -> ${stood}`);
  return visited;
}
console.log('mask[0] controls ON-FOOT passability. Stock is $01 (blocked where bit0 set).\n');
const a=await trial('A stock  mask[0]=$01  -> foot must NEVER stand on ocean', null);
const b=await trial('B patched mask[0]=$80 -> bit7 is the trigger bit, so almost nothing blocks', [0x80]);
const c=await trial('C patched mask[0]=$00 -> AND $00 == $00, so EVERYTHING blocks', [0x00]);
console.log('\n=== verdict ===');
const oceanA=(a&&a.get('ocean'))||0, oceanB=(b&&b.get('ocean'))||0;
const distinctC=c?c.size:0, totalC=c?[...c.values()].reduce((x,y)=>x+y,0):0;
console.log(`  A stock   ocean tiles stood on: ${oceanA}   ${oceanA===0?'✅ as required':'⛔ walked on water with stock mask'}`);
console.log(`  B $80     ocean tiles stood on: ${oceanB}   ${oceanB>0?'✅ mask change UNLOCKED water':'⛔ no change — mask may not drive movement'}`);
console.log(`  C $00     distinct classes visited: ${distinctC} over ${totalC} steps  ${distinctC<=1?'✅ frozen as required':'⛔ still moving with an all-block mask'}`);
})();
