#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: () => createCanvas(256, 240), getElementById: () => null, addEventListener() {} };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { loadWorldMap } = await import('../src/world-map-loader.js');
const { WorldMapRenderer } = await import('../src/world-map-renderer.js');
const { initMapLoading, loadMapById } = await import('../src/map-loading.js');
const { mapSt } = await import('../src/map-state.js');
const { transSt } = await import('../src/transitions.js');
const { checkTrigger } = await import('../src/map-triggers.js');
const { handleInput } = await import('../src/movement.js');
const { setPlayerSprite } = await import('../src/player-sprite.js');
const { DIR_UP } = await import('../src/sprite.js');
const { msgState, forceCloseMsgBox } = await import('../src/message-box.js');
const { keys } = await import('../src/input-handler.js');
const { ps } = await import('../src/player-stats.js');
let dir = DIR_UP;
setPlayerSprite({ getDirection: () => dir, setDirection: d => { dir = d; }, resetFrame() {}, setWalkProgress() {} });
const rom = fs.readFileSync(new URL('../FF3-English.nes', import.meta.url));
initMapLoading(rom);
mapSt.worldMapData = loadWorldMap(rom, 0);
mapSt.worldMapRenderer = new WorldMapRenderer(mapSt.worldMapData);
const { battleSt } = await import('../src/battle-state.js');
const { tryJoinPlayerAlly } = await import('../src/battle-update.js');
const { pvpSt } = await import('../src/pvp.js');
const { companionProfiles } = await import('../src/data/companions.js');
const { ITEMS } = await import('../src/data/items.js');
ps.stats = { level: 15 }; ps.jobIdx = 1; ps.flags = {};
battleSt.battleAllies = []; pvpSt.isPVPBattle = false; pvpSt.isWirePVP = false;
tryJoinPlayerAlly({initial:true});
assert.equal(battleSt.battleAllies.length,3);
assert.ok(battleSt.battleAllies.every(a=>a.companionId && a.fadeStep===0));
const old = [...battleSt.battleAllies]; old[0].hp=0; old[1].hp=2;
tryJoinPlayerAlly();
assert.equal(battleSt.battleAllies[0],old[0]); assert.equal(old[0].hp,0);
assert.equal(battleSt.battleAllies[1],old[1]); assert.equal(old[1].hp,2);
ps.flags.bahamut_escaped=1; battleSt.battleAllies=[]; tryJoinPlayerAlly({initial:true});
assert.ok(battleSt.battleAllies.some(a=>a.name==='Desch'));
ps.flags.owen_restored=1; battleSt.battleAllies=[]; tryJoinPlayerAlly({initial:true});
assert.ok(!battleSt.battleAllies.some(a=>a.name==='Desch'));
for(const flags of [{},{curse_lifted:1},{curse_lifted:1,owen_restored:1}]) {
  for(let jobIdx=0;jobIdx<10;jobIdx++) for(const p of companionProfiles({...ps,jobIdx,flags})) {
    for(const key of ['weaponR','armorId','helmId','shieldId']) {
      const item=ITEMS.get(p[key]); if(!item) continue;
      assert.ok(item.jobs & (1<<p.jobIdx), `${p.name} cannot equip ${key} ${p[key].toString(16)}`);
    }
  }
}
// A real online player replaces an NPC even when all three slots were full.
let socket;
globalThis.location={protocol:'http:',host:'localhost'};
globalThis.localStorage.getItem=()=> 'test';
globalThis.setInterval=()=>1;globalThis.clearInterval=()=>{};
globalThis.WebSocket=class {
  static OPEN=1;static CONNECTING=0;readyState=1;listeners={};
  constructor(){socket=this;}
  addEventListener(k,fn){this.listeners[k]=fn;}send(){}
};
const { connectNet }=await import('../src/net.js');
const { getPlayerLocation }=await import('../src/roster.js');
connectNet(()=>({slot:0,name:[65]}),()=>getPlayerLocation());
socket.listeners.open();
socket.listeners.message({data:JSON.stringify({type:'ready',userId:'self'})});
socket.listeners.message({data:JSON.stringify({type:'snapshot',players:[{
  userId:'friend',name:'Friend',loc:getPlayerLocation(),jobIdx:1,level:15,palIdx:1,
}]})});
assert.equal(battleSt.battleAllies.length,3);
tryJoinPlayerAlly({initial:true});
assert.equal(battleSt.battleAllies.length,3);
assert.ok(battleSt.battleAllies.some(a=>a.name==='Friend'&&!a.companionId));
assert.equal(battleSt.battleAllies.filter(a=>a.companionId).length,2);
socket.listeners.message({data:JSON.stringify({type:'snapshot',players:[]})});
tryJoinPlayerAlly();assert.ok(battleSt.battleAllies.every(a=>a.companionId));
battleSt.battleAllies=[]; pvpSt.isPVPBattle=true; tryJoinPlayerAlly({initial:true});
assert.equal(battleSt.battleAllies.length,0,'NPCs must never enter PvP');
console.log('check-companions: OK — solo fill, role choice, injury continuity, Desch, legal gear, PvP exclusion');
