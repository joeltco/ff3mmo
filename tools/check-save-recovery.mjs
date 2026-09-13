import assert from 'node:assert/strict';
import { memorySaveDB } from './lib/save-db-fixture.mjs';
globalThis.document = { createElement: () => ({getContext:()=>({})}) };
let owner='A', offline=false, release;
const cloud=[];
globalThis.window = { ff3Auth: {
  getAccountKey:()=>owner,
  serverLoadSaves:async()=>[{name:[65],flags:{},exp:0}],
  serverSave:async(slot,data)=>{
    if(offline)return false;
    cloud.push(structuredClone(data));
    if(cloud.length===1)await new Promise(resolve=>{release=resolve;});
    return true;
  },
} };
const db=memorySaveDB();
const { queueSaveSnapshot, readLocalSnapshot }=await import('../src/save-sync.js');
const saves=await import('../src/save-state.js');
const a=queueSaveSnapshot([{name:[65],exp:1,flags:{}}]);
const b=queueSaveSnapshot([{name:[65],exp:2,flags:{enterprise_upgraded:1},vehicleParkedMode:6}]);
await new Promise(r=>setTimeout(r,0));
assert.equal(cloud.length,1,'cloud writes must be ordered');
assert.equal(db.values.get('saves')[0].exp,2,'slow network must not delay local checkpoints');
release();await Promise.all([a,b]);
assert.equal(cloud.at(-1).exp,2);assert.equal((await readLocalSnapshot()).pending,false);
offline=true;
await queueSaveSnapshot([{name:[65],exp:3,flags:{enterprise_upgraded:1},vehicleParkedMode:6}]);
assert.equal((await readLocalSnapshot()).pending,true);
await saves.loadSlotsFromDB();
assert.equal(saves.saveSlots[0].exp,3,'stale cloud overwrote offline progress');
assert.equal(saves.saveSlots[0].flags.enterprise_upgraded,1);
assert.equal(saves.saveSlots[0].vehicleParkedMode,6);
owner='B';assert.equal((await readLocalSnapshot()).slots,null,'local recovery crossed accounts');
offline=false;db.fail(true);
await queueSaveSnapshot([{name:[66],exp:4}]);
assert.equal(cloud.at(-1).exp,4,'IndexedDB failure prevented cloud persistence');
console.log('check-save-recovery: OK — ordered writes, local checkpoints, offline recovery, account isolation, storage failure');

const { parseSaveSlots }=await import('../src/save.js');
const legacy=parseSaveSlots([{name:[65],vehicle:1,vehicleParked:1,vehicleParkedMode:1}])[0];
assert.equal(legacy.vehicleParkedMode,2);assert.equal(legacy.vehicle,0);
const riding=parseSaveSlots([{name:[65],vehicle:1,vehicleParkedMode:3}])[0];
assert.equal(riding.vehicle,1);assert.equal(riding.vehicleParkedMode,3);
