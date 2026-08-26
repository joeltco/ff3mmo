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

// ── 5. the boss's ELEMENT reaches the damage math ─────────────────────────
//
// ⛔ THE BOSS WAS NOT A COMBATANT. Every boss-path branch in the game skipped
// the bestiary record's element fields on the grounds that "the boss has no
// monster object" — it has no monster object, but it has a RECORD, and that is
// where `weakness` / `resist` / `evade` / `mdef` / `atkElem` live.
//
// The Djinn is the case that exposed it. His record says `weakness: 'ice',
// resist: 'fire'` and the cartridge says so out loud in script 0x07c: "The Djinn
// is a fire genie. It won't like the cold." With the multiplier dropped, ice did
// flat damage to him and Fire did FULL damage to a fire genie. battle-sim at the
// level cap: 0% party wins without the weakness, 98.7% with one ice caster.
//
// The fight was never too hard. The counterplay did not function.
{
  const { elemMultiplier } = await import('../src/battle-math.js');
  const seals = DUNGEONS.find((d) => d.bossId === 0xCD);
  if (seals) {
    mapSt.currentMapId = bossFloorMapId(seals);
    startBattle();
    const b = activeBossStats();
    if (b.weakness !== 'ice' || b.resist !== 'fire') {
      bad(`the Djinn's record lost its elements: weakness=${b.weakness} resist=${b.resist}`);
    } else ok("activeBossStats carries the Djinn's ice weakness and fire resist");

    const ice = elemMultiplier('ice', b.weakness, b.resist);
    const fire = elemMultiplier('fire', b.weakness, b.resist);
    if (!(ice > 1)) bad(`ice on the Djinn multiplies by ${ice} — the weakness is not being applied`);
    else ok(`ice on the Djinn multiplies by ${ice}`);
    if (!(fire < 1)) bad(`fire on the Djinn multiplies by ${fire} — a fire genie is not resisting fire`);
    else ok(`fire on the Djinn multiplies by ${fire}`);
  }
}

// ── 6. every boss-path branch actually passes it through ─────────────────
//
// ⛔ SOURCE CHECK, DELIBERATELY. The four branches below live behind battle
// state a headless harness cannot easily reach, and the failure mode is a branch
// QUIETLY not passing a field — which no amount of driving the OTHER branch
// would reveal. Read on STRIPPED text so a comment naming the symbol cannot
// satisfy it; that is exactly how an early cut of `audit-quests` passed against
// a reverted fix.
{
  const fs = await import('node:fs');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const src = (rel) => strip(fs.readFileSync(new URL('../' + rel, import.meta.url).pathname, 'utf8'));

  const sites = [
    ['src/spell-cast.js', /isBoss\)\s*\{[\s\S]{0,900}?elemMultiplier\(\s*spell\.element/,
      'a spell on the boss applies the element multiplier'],
    ['src/spell-cast.js', /isBoss\)\s*\{[\s\S]{0,900}?mdef/,
      "a spell on the boss subtracts the boss's mdef"],
    ['src/input-handler.js', /_bossTgt[\s\S]{0,400}?elemMult:[\s\S]{0,120}?elemMultiplier/,
      "the player's weapon element applies to the boss"],
    ['src/battle-turn.js', /_aBoss\s*=[\s\S]{0,400}?_aWeak[\s\S]{0,200}?_aBoss/,
      "an ally's weapon element applies to the boss"],
    ['src/battle-enemy.js', /monAtkElem\s*=[\s\S]{0,160}?activeBossStats\(\)\.atkElem/,
      "the boss's own attacks carry its element"],
  ];
  for (const [file, re, what] of sites) {
    if (re.test(src(file))) ok(what);
    else bad(`${what} — not found in ${file}; that branch drops the bestiary record`);
  }
}

// ── 7. the boss drop ──────────────────────────────────────────────────────
//
// ⭐ The Djinn drops the WSlayer at 2/7 (Joel, 2026-08-26). It cannot live in
// `data/monsters.js` (generated from the ROM) and is not a ROM drop (FF3 gives
// bosses rate 0), so it hangs off the DUNGEON REGISTRY row and is rolled on the
// boss-death path with the ROM's own `DROP_GATE_DIE`.
{
  const { DROP_GATE_DIE } = await import('../src/data/monsters.js');
  const { ITEMS } = await import('../src/data/items.js');
  for (const d of DUNGEONS) {
    if (!d.bossDrop) continue;
    const bd = d.bossDrop;
    if (!ITEMS.get(bd.item)) { bad(`${d.id}: bossDrop item 0x${(bd.item | 0).toString(16)} is not a real item`); continue; }
    if (!(bd.rate > 0 && bd.rate < DROP_GATE_DIE)) {
      bad(`${d.id}: bossDrop rate ${bd.rate} is outside the ROM ladder 1..${DROP_GATE_DIE - 1}`);
      continue;
    }
    ok(`${d.id}: boss drops 0x${bd.item.toString(16)} at ${bd.rate}/${DROP_GATE_DIE} (${(bd.rate / DROP_GATE_DIE * 100).toFixed(1)}%)`);

    // ⛔ It must not ALSO be sitting in a chest table — that is where it came
    // from, and leaving it in both makes the boss drop meaningless.
    const LT = await import('../src/data/loot-tables.js');
    for (const [name, tiers] of Object.entries(LT.LOOT_TABLES)) {
      for (const t of tiers) {
        if (t.monster) continue;
        if (t.pool.includes(bd.item)) bad(`${d.id}'s boss drop 0x${bd.item.toString(16)} is ALSO in loot table '${name}'`);
      }
    }
  }

  // The roll itself, through the shipped gate expression.
  const rate = (DUNGEONS.find((d) => d.bossDrop) || {}).bossDrop;
  if (rate) {
    let hits = 0;
    const N = 70000;
    let seed = 12345;
    const rng = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < N; i++) if (Math.floor(rng() * DROP_GATE_DIE) < rate.rate) hits++;
    const pct = hits / N;
    const want = rate.rate / DROP_GATE_DIE;
    if (Math.abs(pct - want) > 0.01) bad(`the drop gate produced ${(pct * 100).toFixed(1)}%, the ladder says ${(want * 100).toFixed(1)}%`);
    else ok(`the drop gate lands at ${(pct * 100).toFixed(1)}% over ${N} rolls`);
  }
}

console.log(failed ? `\ncheck-boss-identity: ${failed} FAILED` : '\ncheck-boss-identity: OK');
process.exit(failed ? 1 : 0);
