// Quest completion and its reward must land in the same save snapshot.
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
globalThis.document = { createElement: () => createCanvas(1, 1) };
const writes = [];
globalThis.window = { ff3Auth: {
  serverLoadSaves: async () => [{ name: [65], level: 1, inventory: {},
    stats: { level: 1, exp: 0, maxHP: 100, maxMP: 10 } }, null, null],
  serverSave: async (_slot, data) => { writes.push(structuredClone(data)); },
} };
const { memorySaveDB } = await import('./lib/save-db-fixture.mjs');
memorySaveDB();
const { ps, grantExp } = await import('../src/player-stats.js');
const saves = await import('../src/save-state.js');
const quests = await import('../src/quests.js');
await saves.loadSlotsFromDB();
saves.setPsAligned(true);
saves.setPositionGetter(() => null);
ps.stats = { level: 1, exp: 0, expToNext: 1000, maxHP: 100, maxMP: 10 };
ps.quests = {}; ps.flags = {}; ps.jobLevels = {};
assert.equal(quests.acceptQuest('ur_missing_brother'), true);
for (let i = 0; i < 3; i++) quests.noteEncounterVictory('altar_cave_f1');
quests.talkQuest(114, 'ur_npc_05', reward => grantExp(reward.exp));
await new Promise(resolve => setTimeout(resolve, 0));
const completed = writes.filter(s => s.quests.ur_missing_brother?.s === 'done');
assert.ok(completed.length, 'completion was not saved');
assert.equal(ps.stats.exp, 20, 'quest XP must use the existing single-player split');
assert.equal(completed.at(-1).exp, ps.stats.exp, 'quest was saved without its XP reward');
assert.equal(completed.at(-1).flags.brother_avenged, 1);
console.log('check-quest-persistence: OK — completion includes its XP reward and flag');
