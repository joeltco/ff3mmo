// vehicle-test.cjs — exercise EVERY vehicle and prove what each one actually does.
//
// ⛔ WHY THIS EXISTS: earlier vehicle probes were ad-hoc and drew conclusions from
// states that were never verified. The worst case: a sound sweep reported "modes
// 5/6/7 make no sound" without ever checking the party MOVED — and a propeller
// loop only plays while flying. A "no result" from a vehicle that never moved is
// not evidence of silence, it is evidence of a broken test.
//
// So every row here proves, in order:
//   1. the vehicle STICKS      ($42 read back after boot, not assumed)
//   2. the vehicle MOVES       (party $27/$28 actually change; distance reported)
//   3. only then, what it SOUNDS like, plays as music, and looks like
//
// Terrain matters: mode 3 needs ocean, mode 2 shallow, flight can cross anything.
// Each vehicle is tried on several terrains and the best (most mobile) is kept.
//
//   node tools/monscan/vehicle-test.cjs
//   VEH=5 node tools/monscan/vehicle-test.cjs      # one vehicle, verbose
//
const H=require('./world-harness.cjs');
const {BTN}=require('./nes.cjs');
const fs=require('fs');

(async()=>{
const romJ=new Uint8Array(fs.readFileSync('/home/joeltco/roms/ff3-jp.nes'));
const {loadWorldMap}=await import('../../src/world-map-loader.js');
const w=loadWorldMap(romJ,0);
const b1=(x,y)=>w.tileProps[w.tilemap[((y&127)*128)+(x&127)]&0x7F].byte1;
const CLS={0b0110:'land',0b1110:'forest',0b1011:'ocean',0b1101:'shallow',0b1111:'mtn'};
const cls=(x,y)=>CLS[b1(x,y)&0x0F]||'?';

/** find a tile of `want` with a big clear run around it, so movement is possible */
function findSite(want,span){
  for(let y=8;y<118;y++)for(let x=8;x<118;x++){
    if(cls(x,y)!==want) continue;
    let ok=true;
    for(let d=1;d<=span;d++) if(cls(x-d,y)!==want||cls(x+d,y)!==want) ok=false;
    if(ok) return [x,y];
  }
  return null;
}
const SITES={ocean:findSite('ocean',3),land:findSite('land',3),shallow:findSite('shallow',1),mtn:findSite('mtn',3)};
console.log('sites: '+Object.entries(SITES).map(([k,v])=>k+'='+(v?`(${v})`:'none')).join('  '));
console.log('');

function trial(veh,terrain){
  const site=SITES[terrain]; if(!site) return null;
  const sfx=[],mus=[],bootSfx=[],bootMus=[];
  let booting=true;
  const onSnd=(a,v)=>{
    if(a===0x7F49&&(v&0x80)) (booting?bootSfx:sfx).push(v&0x7F);
    if(a===0x7F43) (booting?bootMus:mus).push(v);
  };
  let nes; try{ nes=H.bootToWorldMap({worldX:site[0],worldY:site[1],vehicle:veh,onBatteryRamWrite:onSnd}); }
  catch(e){ return {err:e.message}; }
  booting=false;
  const m=nes.nes.cpu.mem;
  // ⛔ walking into a map transition crashes jsnes with an invalid opcode, so bail
  // the moment the world tile-property table stops being live at $0400.
  const onWorld=()=>{for(let i=0;i<16;i++) if(m[H.PROPS_RAM+i]!==romJ[0x510+i]) return false; return true;};
  let dead=false;
  const run=n=>{for(let i=0;i<n&&!dead;i++){ m[0x602E]=0xFF; m[0x602F]=0xFF;
    try{ nes.nes.frame(); }catch(e){ dead=true; break; }
    if(!onWorld()){ dead=true; break; } }};
  run(60);
  const mode=m[0x42], start=[m[0x27],m[0x28]], startCls=cls(start[0],start[1]);
  // ── prove it MOVES, in every direction, before believing anything else
  let dist=0; const path=[];
  for(const d of ['left','right','up','down','left','right']){
    const b=[m[0x27],m[0x28]];
    if(dead) break;
    nes.nes.buttonDown(1,BTN[d]); run(60); nes.nes.buttonUp(1,BTN[d]); run(10);
    const a=[m[0x27],m[0x28]];
    const dd=Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1]);
    dist+=dd; path.push(`${d}:${dd}`);
  }
  const o=nes.nes.ppu.spriteMem; const tiles=[];
  for(let i=0;i<256;i+=4) if(o[i]<0xEF) tiles.push(o[i+1]);
  return {dead,bootSfx:[...new Set(bootSfx)],bootMus:[...new Set(bootMus)],mode,after:m[0x42],startCls,endCls:cls(m[0x27],m[0x28]),dist,path,
          sfx:[...new Set(sfx)],mus:[...new Set(mus)],tiles:[...new Set(tiles)].sort((a,b)=>a-b)};
}

const only=process.env.VEH!==undefined?[parseInt(process.env.VEH,10)]:[0,1,2,3,4,5,6,7];
for(const veh of only){
  let best=null,bestT=null;
  for(const t of ['ocean','shallow','land','mtn']){
    let r=null; try{ r=trial(veh,t); }catch(e){ continue; }
    if(!r||r.err) continue;
    // a site is only useful if the vehicle STICKS *and* can actually MOVE there
    const good=(x)=>(x.after===veh||veh===0)&&x.dist>0;
    if(!best){best=r;bestT=t;continue;}
    if(good(r)&&!good(best)){best=r;bestT=t;continue;}
    if(good(r)===good(best)&&r.dist>best.dist){best=r;bestT=t;}
  }
  if(!best){ console.log(`veh ${veh}: no usable site`); continue; }
  const stuck=best.after===veh?'STUCK ':'norm->'+best.after;
  console.log(`veh ${veh} on ${bestT.padEnd(8)} $42=${best.mode}->${best.after} ${stuck.padEnd(9)} moved=${String(best.dist).padStart(3)} tiles [${best.path.join(' ')}]`);
  console.log(`        terrain ${best.startCls}->${best.endCls}`);
  console.log(`        BOOT/board sfx=[${best.bootSfx.map(v=>'$'+v.toString(16)).join(' ')||'none'}] music=[${best.bootMus.map(v=>'$'+v.toString(16)).join(' ')||'none'}]`);
  console.log(`        MOVING    sfx=[${best.sfx.map(v=>'$'+v.toString(16)).join(' ')||'none'}] music=[${best.mus.map(v=>'$'+v.toString(16)).join(' ')||'none'}]`);
  console.log(`        OAM tiles [${best.tiles.slice(0,12).map(v=>'$'+v.toString(16)).join(' ')}]`);
}
})();
