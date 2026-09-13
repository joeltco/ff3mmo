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
globalThis.requestAnimationFrame = cb => cb();
globalThis.document.fonts = { load: async () => [] };
const { initSpriteAssets } = await import('../src/boot.js');
const { drawNpcs } = await import('../src/npc.js');
initSpriteAssets(rom);
const { initTextDecoder } = await import('../src/text-decoder.js'); initTextDecoder(rom);
const { initBattleAlly } = await import('../src/battle-ally.js');
const { initBattleEnemy } = await import('../src/battle-enemy.js');
const { initSpellCast } = await import('../src/spell-cast.js');
const { buildTurnOrder, processNextTurn } = await import('../src/battle-turn.js');
const { startBattle, executeBattleCommand, isTeamWiped, updateBattle } = await import('../src/battle-update.js');
const { battleSt, getEnemyHP } = await import('../src/battle-state.js');
const { handleBattleInput, initInputHandler, inputSt } = await import('../src/input-handler.js');
const { computeJobStats } = await import('../src/data/players.js');
const { recalcCombatStats } = await import('../src/player-stats.js');
const { setPlayerInventory } = await import('../src/inventory.js');
const { seed } = await import('../src/rng.js');
initBattleAlly({buildTurnOrder,processNextTurn,isTeamWiped});
initBattleEnemy({processNextTurn,isTeamWiped});initSpellCast({processNextTurn});
initInputHandler({executeBattleCommand,startPVPBattle:()=>{}});
for(const [map,level] of [[5003,12],[6004,16],[7003,18],[8003,22],[9004,24]]) {
 let wins=0,loss=0,stalls=0;
 for(let run=1;run<=20;run++) {
  ps.jobIdx=1;ps.stats={...computeJobStats(1,level),level,exp:0,expToNext:999999};
  ps.hp=ps.stats.maxHP;ps.mp=ps.stats.maxMP;ps.status={mask:0};ps.buffs={};ps.jobLevels={};
  ps.flags={curse_lifted:1,...(map>=7000?{owen_restored:1}:{bahamut_escaped:1})};
  ps.weaponR=map>=7000?0x29:0x27;ps.weaponL=map>=7000?0x5b:0x58;
  ps.head=map>=7000?0x66:0x64;ps.body=map>=7000?0x77:0x75;ps.arms=0;
  recalcCombatStats();setPlayerInventory({});mapSt.currentMapId=map;startBattle();
  forceCloseMsgBox();battleSt.battleState='menu-open';seed(run);
  let steps=0;
  for(;steps<150000;steps++) {
    if(getEnemyHP()<=0){wins++;break;} if(isTeamWiped()){loss++;break;}
    if(battleSt.battleState==='menu-open')executeBattleCommand(0);
    if(battleSt.battleState==='target-select'){keys.z=true;handleBattleInput();}
    updateBattle(33);
  }
  if(steps===150000){stalls++;console.log('stalled',map,battleSt.battleState,getEnemyHP(),ps.hp);}
 }
 assert.equal(stalls,0, 'combat stalled');
 assert.ok(wins>=10, `${map}: fewer than half the equipped party runs won`);
 console.log(JSON.stringify({map,level,wins,loss,stalls}));
}
