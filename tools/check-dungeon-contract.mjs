#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
// Observe the real boundary without replacing its checks, so removing the call
// from either generation path fails this test even if direct unit tests pass.
const validationURL=new URL('../src/dungeons/validate.js',import.meta.url).href;
globalThis.__dungeonContractCalls=[];
const hook=registerHooks({load(url,context,next){const result=next(url,context);if(url!==validationURL)return result;return {...result,source:result.source.toString().replace('export function validateDungeonFloor(map, dungeon) {','export function validateDungeonFloor(map, dungeon) { globalThis.__dungeonContractCalls.push(dungeon.id);')};}});
try{
  const {generateFloor}=await import('../src/dungeon-generator.js');
  const {DUNGEONS}=await import('../src/data/dungeons.js');
const OWEN=DUNGEONS.find(d=>d.id==='owen');
  const {validateDungeonFloor,neighbours}=await import('../src/dungeons/validate.js');
  const rom=fs.readFileSync(new URL('../FF3-English.nes',import.meta.url));
  for(const d of DUNGEONS)for(let f=0;f<d.floors;f++){
    const start=globalThis.__dungeonContractCalls.length;
    generateFloor(rom,f,1754900087109,d);
    assert(globalThis.__dungeonContractCalls.slice(start).includes(d.id),`boundary not called for ${d.id}`);
  }
  const base=generateFloor(rom,0,1754900087109,OWEN);
  const clone=()=>({...base,tilemap:base.tilemap.slice(),features:structuredClone(base.features),triggerMap:new Map(base.triggerMap),dungeonDestinations:new Map(base.dungeonDestinations)});
  const cases=[
    ['arrival',m=>{for(const n of neighbours(m.entranceY*32+m.entranceX)){m.tilemap[n]=0x1b;m.triggerMap.delete(`${n%32},${Math.floor(n/32)}`);}},/unsafe arrival/],
    ['transition',m=>m.dungeonDestinations.set('1:999',{mapId:-1}),/invalid transition/],
    ['objective',m=>m.features.push({id:'bad',kind:'landmark',at:[28,28]}),/unreachable objective/],
    ['treasure',m=>{m.tilemap[28*32+28]=0x7c;m.triggerMap.set('28,28',{type:2,trigId:99});},/unusable treasure/],
    ['isolated floor',m=>{m.tilemap[28*32+28]=0x30;},/isolated floor/],
  ];
  for(const [label,breakMap,error]of cases){const map=clone();breakMap(map);assert.throws(()=>validateDungeonFloor(map,OWEN),error,`${label} corruption must fail`);}
  console.log('PASS shared dungeon contract — legacy/authored call sites; arrival, transitions, objectives, treasure and isolated-floor failures');
}finally{hook.deregister();delete globalThis.__dungeonContractCalls;}
