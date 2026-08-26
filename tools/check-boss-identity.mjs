#!/usr/bin/env node
// check-boss-identity.mjs — the boss you fight is the boss the registry names.
//
// ⛔ WHY THIS EXISTS. `battleSt.bossId` was READ in three places and ASSIGNED IN
// NONE. `startBattle()` set `enemyHP = BOSS_MAX_HP`, a module-level constant
// built from `DEFAULT_BOSS_ID` at import time, so EVERY boss chamber in the game
// fought the Land Turtle: the Cave of Seals drew the Djinn's sprite, its loading
// screen advertised his 480 HP straight off the dungeon registry, and the thing
// that actually swung at you had 120 and answered to 0xCC.
//
// The registry has carried `bossId: 0xCD` since v1.10.55 with no consumer, and
// `data/bosses.js` documented the intent — "a per-encounter boss sets
// `battleSt.bossId`" — for just as long. A field decoded and not wired is not
// done.
//
// It also silently broke a quest: `kazus_sealed_cave`'s objective is
// `{ kind: 'boss', bossId: 0xCD }`, and `noteBossDefeated` reported 0xCC from
// inside the Djinn's own chamber, so the quest could never advance.
//
// ⛔ `check-quests` CANNOT catch that. It calls `noteBossDefeated(obj.bossId)`
// itself, so it proves the objective machinery and never asks what the BATTLE
// would have passed in — the same shape of blind spot as the giver-placement bug
// one layer down.
//
//   node tools/check-boss-identity.mjs

import { createCanvas } from '@napi-rs/canvas';

// The same shim the other battle gates use — `ui-state.js` reads `window` at
// module scope, and `battle-update.js` pulls it in transitively.
globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document = { createElement: () => createCanvas(8, 8), addEventListener() {},
                        getElementById: () => null, body: { appendChild() {} },
                        fonts: { load: () => Promise.resolve() } };

let failed = 0;
const ok  = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };

const { DUNGEONS, bossFloorMapId } = await import('../src/data/dungeons.js');
const { MONSTERS } = await import('../src/data/monsters.js');
const { DEFAULT_BOSS_ID } = await import('../src/data/bosses.js');
const { battleSt, activeBossStats } = await import('../src/battle-state.js');
const { mapSt } = await import('../src/map-state.js');
const { ps } = await import('../src/player-stats.js');
const q = await import('../src/quests.js');
const { QUESTS } = await import('../src/data/quests.js');

// ── 1. every dungeon names a boss the bestiary actually has ───────────────
for (const d of DUNGEONS) {
  const mon = MONSTERS.get(d.bossId);
  if (!mon) { bad(`dungeon '${d.id}' names bossId 0x${(d.bossId | 0).toString(16)} — not in the bestiary`); continue; }
  ok(`${d.id}: boss 0x${d.bossId.toString(16).toUpperCase()} = ${mon.hp} HP / atk ${mon.atk} / def ${mon.def}`);
}

// ⛔ TWO DUNGEONS MUST NOT SHARE A BOSS. If they did, this whole gate would pass
// against a `startBattle` that still hardcoded the default — the bug it exists
// to catch would be invisible. Guard the guard.
{
  const ids = DUNGEONS.map((d) => d.bossId);
  if (new Set(ids).size !== ids.length) bad('two dungeons share a bossId — this gate cannot tell them apart');
  else if (!ids.includes(DEFAULT_BOSS_ID)) bad('no dungeon uses DEFAULT_BOSS_ID — the fallback path is untested');
  else ok('the dungeons have distinct bosses, and one of them is the default');
}

// ── 2. entering a boss chamber makes THAT boss the active one ─────────────
//
// Drives the SHIPPED `startBattle()`. A reimplementation of the lookup here
// would keep agreeing with itself after someone changed the real one.
const { startBattle } = await import('../src/battle-update.js');
for (const d of DUNGEONS) {
  const mapId = bossFloorMapId(d);
  mapSt.currentMapId = mapId;
  ps.quests = {}; ps.flags = {};
  try { startBattle(); } catch (e) { bad(`${d.id}: startBattle threw — ${e.message}`); continue; }

  const want = MONSTERS.get(d.bossId);
  if (battleSt.bossId !== d.bossId) {
    bad(`${d.id}: fought bossId 0x${(battleSt.bossId | 0).toString(16)}, registry says 0x${d.bossId.toString(16)}`);
  } else ok(`${d.id}: map ${mapId} -> bossId 0x${d.bossId.toString(16).toUpperCase()}`);

  if (battleSt.enemyHP !== want.hp) {
    bad(`${d.id}: boss entered the fight with ${battleSt.enemyHP} HP, bestiary says ${want.hp}`);
  } else ok(`${d.id}: ${want.hp} HP on the field`);

  const stats = activeBossStats();
  if (stats.atk !== want.atk || stats.def !== want.def) {
    bad(`${d.id}: activeBossStats gave atk ${stats.atk}/def ${stats.def}, bestiary says ${want.atk}/${want.def}`);
  }
}

// ── 3. the id does not stick between fights ───────────────────────────────
// `resetBattleVars` does not clear `bossId`, so it must be ASSIGNED on every
// entry, not just when a dungeon happens to name one.
{
  const seals = DUNGEONS.find((d) => d.bossId !== DEFAULT_BOSS_ID);
  const altar = DUNGEONS.find((d) => d.bossId === DEFAULT_BOSS_ID);
  if (seals && altar) {
    mapSt.currentMapId = bossFloorMapId(seals); startBattle();
    mapSt.currentMapId = bossFloorMapId(altar); startBattle();
    if (battleSt.bossId !== altar.bossId) {
      bad(`the previous dungeon's boss stuck: after entering ${altar.id}, bossId is 0x${(battleSt.bossId | 0).toString(16)}`);
    } else ok('the boss id does not carry over from the previous dungeon');
  }
}

// ── 4. a boss quest can actually be finished by fighting that boss ────────
//
// End to end through the SHIPPED victory path's argument, not through a value
// this file picked: enter the chamber, read what the battle would report, and
// hand THAT to the quest runtime.
for (const quest of Object.values(QUESTS)) {
  const stage = (quest.stages || []).find((st) => st.objective && st.objective.kind === 'boss');
  if (!stage) continue;
  const d = DUNGEONS.find((x) => x.bossId === stage.objective.bossId);
  if (!d) { bad(`${quest.id}/${stage.id}: wants boss 0x${stage.objective.bossId.toString(16)}, no dungeon has it`); continue; }

  ps.quests = { [quest.id]: { s: stage.id, n: 0 } };
  ps.flags = {};
  mapSt.currentMapId = bossFloorMapId(d);
  startBattle();
  // This is the exact expression battle-update.js passes on boss death.
  q.noteBossDefeated(battleSt.bossId ?? DEFAULT_BOSS_ID);
  if ((ps.quests[quest.id].n | 0) < 1) {
    bad(`${quest.id}/${stage.id}: beating the boss in ${d.name} did NOT advance it — ` +
        `the battle reported 0x${(battleSt.bossId | 0).toString(16)}, the objective wants ` +
        `0x${stage.objective.bossId.toString(16)}`);
  } else ok(`${quest.id}/${stage.id}: beating ${d.name}'s boss advances it`);
}
ps.quests = {}; ps.flags = {};

console.log(failed ? `\ncheck-boss-identity: ${failed} FAILED` : '\ncheck-boss-identity: OK');
process.exit(failed ? 1 : 0);
