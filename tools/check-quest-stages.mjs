#!/usr/bin/env node
// check-quest-stages.mjs — is the person you need actually IN THE ROOM?
//
// ⛔ THIS IS THE GATE THAT WAS MISSING, AND `kazus_cid_airship` IS WHY.
//
// That quest named `at: { map: 12, npc: 'cid' }`, and `cid`'s placement row in
// data/town-npcs.js is `when: (q) => q('kazus_cid_airship')` — he is only put in
// the room ONCE THE QUEST HE GIVES IS FINISHED. On a fresh save the tile holds
// `cid_ghost`, a different key, so the offer could never fire. On any save. It
// shipped that way and stayed that way, because every quest gate in the repo
// drives the quest API with `quest.giver` / `stage.at` values DIRECTLY:
//
//   check-quests      — walks offer -> objective -> hand-in through talkQuest()
//   audit-quests      — checks the giver has `teaches`/`answers` for the word
//   check-cid-airship — checks both Cid states stand on the ROM tile
//
// Every one of them passes. Not one asks whether the NPC is PLACED at the
// moment the stage needs them. That is the whole of this file.
//
// Method: for each stage, reconstruct the story state a player would be in when
// that stage is live — this quest parked on that stage, plus every flag the
// EARLIER stages set — then run the map's real `when` predicates and look for
// the key.
//
//   node tools/check-quest-stages.mjs
//   node tools/check-quest-stages.mjs --all     # print every stage, not just failures

let failed = 0;
const ok  = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };
const SHOW_ALL = process.argv.includes('--all');

const { QUESTS, QUEST_DONE } = await import('../src/data/quests.js');
const { TOWN_NPCS, GENERATED_NPCS } = await import('../src/data/town-npcs.js');
const { isFlag } = await import('../src/data/flags.js');

/**
 * Who is standing on `mapId` given a story state.
 *
 * ⛔ Runs the REAL `when` predicates off the REAL table. A reimplementation here
 * would keep agreeing with itself after someone changed the rule — the failure
 * mode `check-shops` had when it asked `findShopAtCounter` for the shop's own
 * coordinates.
 */
function placedOn(mapId, { quests = {}, flags = {} } = {}) {
  const questDone = (id) => !!quests[id] && quests[id].s === QUEST_DONE;
  const flag = (id) => !!flags[id];
  // ⛔ BOTH TABLES. A person on a GENERATED map has no tile to write in
  // `TOWN_NPCS`, so they live in `GENERATED_NPCS` instead — and a gate that
  // reads only the first one calls them missing. That is how this check first
  // reported `sasune_missing_daughter/found` as unstartable on a chain that
  // works: Sara stands in the Cave of Seals, which is carved fresh every entry.
  return [...(TOWN_NPCS.get(mapId) || []), ...(GENERATED_NPCS.get(mapId) || [])]
    .filter((n) => !n.when || n.when(questDone, flag))
    .map((n) => n.key);
}

// Flags that ANY quest sets, so a stage's requirement can be reported against
// something real rather than "some flag somewhere".
const _setters = new Map();
for (const q of Object.values(QUESTS)) {
  for (const st of q.stages || []) {
    for (const f of st.sets || []) {
      if (!isFlag(f)) bad(`${q.id}/${st.id}: sets undeclared flag '${f}' — data/flags.js does not list it`);
      if (!_setters.has(f)) _setters.set(f, []);
      _setters.get(f).push(`${q.id}/${st.id}`);
    }
  }
}

console.log('── every stage, with the room as it would actually be ──');
for (const quest of Object.values(QUESTS)) {
  const stages = quest.stages || [];
  if (!stages.length) { bad(`${quest.id}: no stages`); continue; }
  const failedBefore = failed;

  // Flags accumulate as the player walks the quest. Stage i is reached with
  // everything stages 0..i-1 set, and nothing later.
  const flags = {};
  let questsAtStage = {};                    // untaken at stage 0

  for (let i = 0; i < stages.length; i++) {
    const st = stages[i];
    if (!st.at || st.at.map == null || !st.at.npc) { bad(`${quest.id}/${st.id}: no at:{map,npc}`); continue; }

    const room = placedOn(st.at.map, { quests: questsAtStage, flags });
    const there = room.includes(st.at.npc);
    const label = `${quest.id}/${st.id} needs ${st.at.npc} on map ${st.at.map}`;
    if (there) { if (SHOW_ALL) ok(`${label} — present`); }
    else {
      bad(`${label} — NOT PLACED. Room holds: ${room.join(', ') || '(nobody)'}`);
      // Say WHY, because "not placed" without the reason is a scavenger hunt.
      const row = [...(TOWN_NPCS.get(st.at.map) || []), ...(GENERATED_NPCS.get(st.at.map) || [])]
        .find((n) => n.key === st.at.npc);
      if (!row) console.error(`      ${st.at.npc} is in neither TOWN_NPCS[${st.at.map}] nor GENERATED_NPCS[${st.at.map}]`);
      else if (row.when) {
        console.error(`      it has a \`when\` predicate that is false at this point in the story.`);
        console.error(`      state here: quests=${JSON.stringify(questsAtStage)} flags=${JSON.stringify(flags)}`);
      }
    }

    // ⭐ `also` speakers must be in THEIR room at this stage too — a mid-stage
    // aside nobody can hear is dialogue that was written and never reaches a
    // player. They are keyed by npcKey alone, so check every map they sit on.
    for (const key of Object.keys(st.also || {})) {
      const anywhere = [...TOWN_NPCS.keys(), ...GENERATED_NPCS.keys()].some((m) => placedOn(m, { quests: questsAtStage, flags }).includes(key));
      if (!anywhere) bad(`${quest.id}/${st.id}: also.${key} is placed nowhere while this stage is live`);
      else if (SHOW_ALL) ok(`${quest.id}/${st.id} aside ${key} — present`);
    }

    // Walk forward: this stage's flags land, and the player moves on.
    for (const f of st.sets || []) flags[f] = 1;
    const next = stages[i + 1];
    questsAtStage = { [quest.id]: { s: next ? next.id : QUEST_DONE, n: 0 } };
  }

  // Once it is over, whoever the quest gives `after` lines to must be standing
  // somewhere — otherwise the pay-off line is unreachable.
  for (const key of Object.keys(quest.after || {})) {
    const anywhere = [...TOWN_NPCS.keys(), ...GENERATED_NPCS.keys()].some((m) => placedOn(m, { quests: questsAtStage, flags }).includes(key));
    if (!anywhere) bad(`${quest.id}: after.${key} is placed nowhere once the quest is finished`);
    else if (SHOW_ALL) ok(`${quest.id} after ${key} — present`);
  }

  // ⛔ Only claim the walk if it actually walked. A ✓ under two ✗ for the same
  // quest reads as "mostly fine", which is how a dead quest keeps looking alive.
  if (!SHOW_ALL && failed === failedBefore) ok(`${quest.id}: ${stages.length} stage(s) walked`);
}

// A flag read by a placement predicate that no stage sets is a town that can
// never change — the inverse of the bug above, and just as silent.
{
  const readInWhen = new Set();
  for (const rows of TOWN_NPCS.values()) {
    for (const n of rows) {
      if (!n.when) continue;
      for (const m of String(n.when).matchAll(/\bf\s*\(\s*['"]([a-z0-9_]+)['"]\s*\)/g)) readInWhen.add(m[1]);
    }
  }
  const unsettable = [...readInWhen].filter((f) => !_setters.has(f));
  if (unsettable.length) {
    bad(`placement predicates read flag(s) no quest stage ever sets: ${unsettable.join(', ')} — ` +
        'those NPCs can never change state');
  } else if (readInWhen.size) {
    ok(`all ${readInWhen.size} flag(s) read by placements are set by some stage`);
  }
}

console.log(failed ? `\ncheck-quest-stages: ${failed} FAILED` : '\ncheck-quest-stages: OK');
process.exit(failed ? 1 : 0);
