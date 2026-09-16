#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { describePlan } from '../src/dungeon/plan.js';
import { generateFloor } from '../src/dungeon-generator.js';
import { DUNGEONS } from '../src/data/dungeons.js';
const OWEN = DUNGEONS.find(d => d.id === 'owen');
import { applyFeature } from '../src/dungeons/compile.js';
import { MapRenderer } from '../src/map-renderer.js';
import { walkDungeon, neighbours, validateDungeonFloor } from '../src/dungeons/validate.js';
globalThis.document = { createElement: () => createCanvas(8,8) };
const rom = fs.readFileSync(new URL('../FF3-English.nes', import.meta.url));
const gate = process.argv.find(a => a.startsWith('--gate='))?.split('=')[1];
const samples = Number(process.argv.find(a => a.startsWith('--seeds='))?.split('=')[1] || 120);
const index = ([x,y]) => y * 32 + x;
const clone = m => ({...m,tilemap:m.tilemap.slice(),triggerMap:new Map(m.triggerMap),dungeonDestinations:new Map(m.dungeonDestinations)});
const check = (letter, test) => { if (!gate || gate === letter) test(); };
export function measure(map) {
  const { distance } = walkDungeon(map), target = index(map.route.exit);
  const fromExit = walkDungeon(map,map.route.exit).distance;
  const detours = map.features.filter(f=>f.kind==='chest').map(f=>{
    const candidates=neighbours(index(f.at)).filter(n=>distance[n]>=0 && fromExit[n]>=0);
    return Math.min(...candidates.map(n=>distance[n]+fromExit[n]))-distance[target];
  });
  return {walkable:distance.filter(n=>n>=0).length,crossing:distance[target],detours};
}
// Two vertex-disjoint routes inside a promised bank, using actual movement.
// A vertex-capacitated max-flow avoids mistaking two sides of one shared
// bottleneck for two independent lanes.
function bankFlow(map,bank) {
  const view=walkDungeon(map).view, [l,t,r,b]=bank.rect, edges=new Map();
  const add=(a,b,c)=>{if(!edges.has(a))edges.set(a,new Map());if(!edges.has(b))edges.set(b,new Map());edges.get(a).set(b,c);if(!edges.get(b).has(a))edges.get(b).set(a,0);};
  const s=index(bank.entry), target=index(bank.exit), inside=n=>n%32>=l&&n%32<=r&&Math.floor(n/32)>=t&&Math.floor(n/32)<=b;
  for(let y=t;y<=b;y++)for(let x=l;x<=r;x++)if(view.isPassable(x,y,1)){
    const n=y*32+x;add(n*2,n*2+1,n===s||n===target?2:1);
    for(const k of neighbours(n))if(inside(k)&&view.isPassable(k%32,Math.floor(k/32),1))add(n*2+1,k*2,2);
  }
  let flow=0;
  while(flow<2){const q=[s*2],prev=new Map([[s*2,null]]);for(let h=0;h<q.length&&!prev.has(target*2+1);h++)for(const [v,cap]of edges.get(q[h])||[])if(cap>0&&!prev.has(v)){prev.set(v,q[h]);q.push(v);}if(!prev.has(target*2+1))break;for(let v=target*2+1;prev.get(v)!==null;){const u=prev.get(v);edges.get(u).set(v,edges.get(u).get(v)-1);edges.get(v).set(u,edges.get(v).get(u)+1);v=u;}flow++;}
  return flow;
}
const stats=Array.from({length:5},()=>[]), signatures=Array.from({length:5},()=>new Set());
const routes=Array.from({length:5},()=>new Set()), junctions=Array.from({length:5},()=>new Set()), statesSeen=Array.from({length:5},()=>new Set());
for(let trial=0;trial<samples;trial++)for(let floor=0;floor<5;floor++){
  const seed=1754900087109+trial*9973;
  const closed=generateFloor(rom,floor,seed,OWEN);
  signatures[floor].add(JSON.stringify(closed.route.floorCells));
  assert(!describePlan(closed.plan).includes('undefined'),'Owen plan must describe machinery bounds');
  const states=[closed];
  const control=closed.features.find(f=>f.kind==='passage');
  if(control){const open=clone(closed);applyFeature(open,control,OWEN);states.push(open);}
  for(const map of states){
    const m=measure(map);stats[floor].push(m);
    const distances=walkDungeon(map).distance, path=[];
    let cursor=index(map.route.exit);
    while(distances[cursor]>0){path.push(cursor);cursor=neighbours(cursor).find(n=>distances[n]===distances[cursor]-1);}
    path.push(cursor);routes[floor].add(JSON.stringify(path));
    junctions[floor].add(JSON.stringify(map.route.banks.map(b=>[b.entry,b.exit])));
    statesSeen[floor].add(JSON.stringify(map.features.filter(f=>f.kind==='passage').map(f=>f.tiles.map(p=>map.tilemap[p.y*32+p.x]))));
    check('A',()=>{
      assert.deepEqual(map.route.shell,[1,3,14,12],'A: structural envelope must be 14x10');
      for(let y=0;y<32;y++)for(let x=0;x<32;x++){
        if(x>15||y>13)assert.equal(map.tilemap[y*32+x],0x5f,'A: material escapes tower envelope');
        if((x===0||x===15)&&y<=13||y===0&&x<=15||y===13&&x<=15)assert.equal(map.tilemap[y*32+x],0,'A: broken outer shell');
      }
      const d=walkDungeon(map).distance;
      for(let n=0;n<1024;n++)if(d[n]>=0)assert(n%32>=1&&n%32<=14&&Math.floor(n/32)>=3&&Math.floor(n/32)<=12,'A: floor outside envelope');
    });
    check('C',()=>{
      assert(map.entranceX>=11&&map.route.exit[0]<=4,'C: arrival and onward stair must oppose');
      assert(m.crossing >= (floor === 4 ? 12 : 18), `C: crossing ${m.crossing} is too short`);
      for(let y=floor===4?7:3;y<=(floor===4?8:5);y++)for(let x=12;x<=(floor===4?13:14);x++)assert(walkDungeon(map).distance[y*32+x]>=0,'C: arrival needs its full 3x3 landing');
      const port=map.route.ports.find(p=>p.role==='objective');
      if (port) { const trig=map.triggerMap.get(port.at.join(','));assert(map.dungeonDestinations.has(`${trig.type}:${trig.trigId}`),'C: onward stair has no destination'); }
      else { assert.equal(floor,4); assert.deepEqual(map.warpTile,{x:1,y:8}); assert.equal(map.dungeonDestinations.size,1,'engine may only have a return stair; completion uses boss gate'); }
    });
    check('D',()=>{
      const [lo,hi]=[[98,105],[104,114],[38,50],[70,80],[18,18]][floor];
      assert(m.walkable>=lo&&m.walkable<=hi,`D: ${map.sectionId} density ${m.walkable} outside ${lo}..${hi}`);
    });
    check('E',()=>{
      for(const [n,f]of map.features.filter(f=>f.kind==='chest').entries()){
        assert(m.detours[n]>=4,`E: ${f.id} detour ${m.detours[n]} is below 4 steps`);
        const removed=clone(map);removed.tilemap[index(f.at)]=0x30;removed.triggerMap.delete(f.at.join(','));
        assert.equal(walkDungeon(removed).distance[index(map.route.exit)],m.crossing,`E: removing ${f.id} shortens progression`);
      }
    });
    if(!gate){validateDungeonFloor(map,OWEN);for(const bank of map.route.banks)assert.equal(bankFlow(map,bank),2,`${bank.id} needs independent lanes`);}
  }
  if(!gate && trial===0){
    const real=new MapRenderer(closed,closed.entranceX,closed.entranceY),view=walkDungeon(closed).view;
    for(let y=0;y<32;y++)for(let x=0;x<32;x++)for(const z of [0,1,2])assert.equal(view.isPassable(x,y,z),real.isPassable(x,y,z));
    if(control){
      const after=walkDungeon(states[1]).distance,before=walkDungeon(closed).distance;
      assert(before.every((d,n)=>d<0||after[n]>=0),'control closed reachable floor');
      const cache=closed.features.find(f=>f.kind==='chest');
      const approach=d=>Math.min(...neighbours(index(cache.at)).filter(n=>d[n]>=0).map(n=>d[n]));
      assert(approach(after)<approach(before),'service gate must reduce the cache detour');
      const invalid=clone(closed),bytes=invalid.tilemap.slice();
      assert.throws(()=>applyFeature(invalid,{...control,tiles:[{x:12,y:4,tile:0x1b}]},OWEN),/only open/);
      assert.deepEqual(invalid.tilemap,bytes,'rejected control mutated occupied floor');
      applyFeature(states[1],control,OWEN);assert.deepEqual(walkDungeon(states[1]).distance,after,'control must be idempotent');
    }
  }
}
if(!gate && samples>=4)for(let f=0;f<5;f++)assert(signatures[f].size >= (f===4?1:f===3?2:3),'seed must change arrangements');
for(let f=0;f<5;f++)console.log(`${OWEN.design.floors[f]}: envelope 14x10; walkable ${Math.min(...stats[f].map(m=>m.walkable))}..${Math.max(...stats[f].map(m=>m.walkable))}; crossing ${Math.min(...stats[f].map(m=>m.crossing))}..${Math.max(...stats[f].map(m=>m.crossing))}; chest detour ${f===4?'none':`${Math.min(...stats[f].flatMap(m=>m.detours))}..${Math.max(...stats[f].flatMap(m=>m.detours))}`}`);
console.log(`Route measurements (no overlap gate): gallery ${routes[0].size} primary route(s), ${junctions[0].size} bank-junction arrangements, ${statesSeen[0].size} machinery states; shaft ${routes[2].size} primary route(s), ${signatures[2].size} service-spur arrangements.`);
console.log(`PASS Owen ${gate||'A/C/D/E, banks, opening-only state, renderer parity'} — ${samples} seeds per floor`);
