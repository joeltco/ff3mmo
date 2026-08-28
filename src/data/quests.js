// Quest definitions.
//
// One quest per entry, keyed by id. `ps.quests[id]` holds the player's progress
// as `{ s, n }` — the STAGE they are on and that stage's objective count — and
// nothing else; the MECHANICS live here so the save stays small and the server
// has a fixed table to validate claims against. The PROSE lives in
// `data/script.js` — client-only, and deliberately out of the server's reach.
//
// ⛔ THIS FILE MUST STAY IMPORT-FREE. `economy-arbiter.js` and `api.js` import
// it directly so the SERVER validates quest claims and clamps saved counts
// against the same table the client uses (v1.8.6). One browser-only import here
// (a sprite, a canvas helper) takes the server process down at boot.
//
// There is no overhead marker. Quest stage lives in `ps.quests[id].s` and is
// surfaced by what the giver SAYS, not by a sprite — removed in v1.7.990/991
// because Word Memory (ASK/LEARN) is the signposting now. Progress is surfaced
// the same way: pages carry `{n}` / `{count}` / `{left}` tokens that
// `quests.js#talkQuest` fills in, so the giver tells you where you are instead
// of a journal screen doing it. Adding a quest UI would undo the design.
//
// ── STAGES ────────────────────────────────────────────────────────────────
//
// ⭐ A quest is a LIST OF STAGES, and each stage names its own NPC. That is the
// whole reason this shape replaced `giver: { mapId, npcKey }`.
//
// The old shape welded a quest to ONE person: `talkQuest`, `askQuestWord` and
// `_takeQuestNotice` each filtered on `giver.mapId && giver.npcKey`, so a quest
// could not be offered by one character and handed in to another. That is not a
// missing luxury — it is why `kazus_cid_airship` is DEAD. Its giver is `cid`,
// whose placement row is `when: (q) => q('kazus_cid_airship')`, so Cid only
// appears once the quest he gives is already finished. On a fresh save the tile
// holds `cid_ghost`, a different key, and the offer can never fire. A quest that
// must be offered by a cursed man and remembered by an uncursed one needs two
// bindings, and there was only one.
//
// ⛔ NO PROSE LIVES HERE. Every line a quest makes somebody say is in
// `data/script.js`, which the server never imports — see that file's header.
// This file was roughly 45% English while two server modules booted from it.
// `tools/check-script-split.mjs` is the gate.
//
// A stage is:
//
//   { id,                    the value stored in `ps.quests[id].s`
//     at: { map, npc },      WHO advances it
//     objective,             optional — absent or kind 'talk' means TALKING to
//                            `at` advances it (see quest-objectives.js)
//     sets,                  story flags set on advance (data/flags.js)
//     item,                  handed over when this stage advances, through the
//                            validated claim path (ledgered `questId#stageId`)
//     vehicle }              a craft parked when this stage advances
//
// Stage 0 is the offer: it ends in a CHOICE rather than a step, so its pages in
// `script.js` are `offer` / `accepted` / `denied` rather than `say` /
// `onAdvance`. Advancing the LAST stage finishes the quest and pays `reward`.
//
// ⛔ EVERY STAGE'S NPC MUST BE PLACED WHEN THAT STAGE IS LIVE. That is not a
// convention, it is `tools/check-quest-stages.mjs`, and it exists because the
// bug above sat in a shipped release behind a gate that drove the quest API
// directly and never asked whether the giver was standing there.

export const QUEST_DONE = 'done';     // handed in, finished for good

export const QUESTS = {
  // ── UR: the missing brother ──────────────────────────────────────────────
  //
  // Ur's first quest. The giver is the ROM NPC below the elder's house — door
  // to map 6 sits at (9,26), and he stands at ROM (10,28), a row further down
  // and out in the open where you actually walk past him.
  ur_missing_brother: {
    id: 'ur_missing_brother',

    // FF2 Word Memory hook: he does NOT offer the job on sight. You learn
    // BROTHER from ur_npc_09 ("It took my brother.") and ASK him about it —
    // then the offer comes, with ACCEPT / DENY.
    startWord: 'brother',

    // `item` is the brother's own gear — the hand-in line hands over an object,
    // so one has to actually change hands. 0x58 Leather Shield: 40 gil, the
    // cheapest thing in Ur's armor shop, wearable by nearly every job.
    reward: { gil: 300, exp: 80, item: 0x58 },

    stages: [
      { id: 'ask', at: { map: 114, npc: 'ur_npc_05' } },
      {
        id: 'clear',
        at: { map: 114, npc: 'ur_npc_05' },
        // `zonePrefix` matches against `currentEncounterZoneKey()`, which
        // returns keys like `altar_cave_f1` / `altar_cave_boss`, so one prefix
        // covers every floor.
        objective: { kind: 'defeat', zonePrefix: 'altar_cave', count: 3 },
        // ⭐ The world fact his parting line hangs off — see data/flags.js.
        sets: ['brother_avenged'],
      },
    ],
  },

  // ── UR: the lost riders ──────────────────────────────────────────────────
  //
  // Deliberately NOT on ur_npc_05: one quest each reads better and puts the two
  // errands in different buildings. The teacher and the giver are also different
  // people, which is the point of the word gate — learn RIDERS from
  // ur_elder_kin_a on the elder's UPPER floor, then carry it across town to the
  // tavern. A giver who teaches their own start word is a chain with no walk.
  ur_lost_riders: {
    id: 'ur_lost_riders',
    startWord: 'riders',

    // One for each rider. Longsword (0x24, atk 10, 100 gil in Ur's own weapon
    // shop) — a real upgrade on the starting Knife without outrunning the shop,
    // and a knight's weapon is what a knight leaves behind.
    reward: { gil: 250, exp: 60, item: 0x24 },

    stages: [
      { id: 'ask', at: { map: 9, npc: 'ur_tavern_drinker_d' } },
      {
        id: 'clear',
        at: { map: 9, npc: 'ur_tavern_drinker_d' },
        // The road they rode, not the cave. `grasslands_valley` is the goblin
        // corridor within radius 8 of Ur — picked by DISTANCE, not a coordinate
        // box. NOT the bare `grasslands` prefix: that also matches
        // `grasslands_wild`, which is everything past the radius.
        objective: { kind: 'defeat', zonePrefix: 'grasslands_valley', count: 4 },
        sets: ['road_cleared'],
      },
    ],
  },

  // ── CASTLE SASUNE: THE KING'S DAUGHTER ───────────────────────────────────
  //
  // ⚠ THE CANOE, NOT THE AIRSHIP, AND THAT IS MEASURED. On our world map with
  // the ROM's own mask table at $C6CD: on foot Ur reaches 267 tiles and four
  // entrances; the CANOE reaches 296 and opens the Sealed Cave; the airship
  // reaches 304 and opens NEITHER cave, because both mouths carry tile byte1
  // $9e and bit 4 is the flight barrier. The canoe is the only key that fits
  // the lock we have.
  //
  // ⭐ THE SHAPE IS THE CARTRIDGE'S. A craft handed over BEFORE the search
  // (`0x225`, Cid's airship) and the princess found INSIDE the cave (`0x245`).
  // Only the craft differs. See data/script.js.
  sasune_missing_daughter: {
    id: 'sasune_missing_daughter',

    // Heard at the gate from sasune_guard_w, carried inside to her father. The
    // King deliberately does NOT teach it.
    startWord: 'sara',

    reward: { gil: 500, exp: 200 },

    stages: [
      {
        id: 'ask',
        at: { map: 29, npc: 'sasune_king' },
        // ⭐ THE KING GIVES THE CANOE, at the ASK — nothing about the search
        // depends on finishing the search. Paid through the validated claim
        // path, ledgered `sasune_missing_daughter#ask` in `quest_claims`, so it
        // is handed over exactly once. See `validateQuestClaim`.
        // ⭐ IT IS AN ITEM: `0xa5` / `Canoe`, `type: 'key'`.
        item: 0xa5,
        // ...and the craft itself, parked at world (87,41) — the last
        // foot-walkable tile before the water leading to the Sealed Cave's
        // mouth at (84,36). Boarding is by POSITION (`movement.js`), so the
        // item without the craft is a boat you cannot get into.
        vehicle: { mode: 1, x: 87, y: 41 },
        sets: ['canoe_granted'],
      },
      // No objective: talking to the runner IS the beat. He was outside on an
      // errand when the curse fell (script 0x238).
      { id: 'errand', at: { map: 25, npc: 'sasune_hall_servant' } },
      { id: 'forge', at: { map: 10, npc: 'kazus_smith' } },
      // ⭐ IN THE SEALED CAVE, past the boulder on floor 1 — map 2001 is the
      // Cave of Seals' first floor (`base` 2000). She is behind the wall that
      // boulder opens, in the chamber the way down is in, so finding her and
      // finding the way deeper are the same walk.
      { id: 'found', at: { map: 2001, npc: 'sara' }, sets: ['sara_found'] },
      { id: 'return', at: { map: 29, npc: 'sasune_king' }, sets: ['daughter_home'] },
    ],
  },

  // ── KAZUS: THE SEALED CAVE ───────────────────────────────────────────────
  //
  // ⭐ REPLACES `kazus_cid_airship`, which was DEAD ON EVERY SAVE. Its giver was
  // `cid`, whose placement row was gated on that same quest being finished, so
  // the offer could never fire. Two Cids with two keys and a quest that could
  // only name one of them.
  //
  // ⛔ THE OBJECTIVE IS A BOSS, NOT A ZONE. `kind: 'boss'` names monster 0xCD by
  // id, so clearing the Cave of Seals' ordinary encounters does not satisfy it.
  kazus_sealed_cave: {
    id: 'kazus_sealed_cave',

    // Learned from the cursed King, or from Sara, or from the smith — all three
    // say it in lines they would say anyway.
    startWord: 'djinn',

    // He keeps his promise: the airship, parked in the sand west of Kazus where
    // FF3 leaves it. (89,59) is one tile west of the ROM's own map-180
    // entrance, which cannot be the parking tile because map 180 is in
    // STRANDING_MAPS and refuses entry at the door.
    //
    // ⭐ AND IT DOES NOT LEAVE THE VALLEY. Nelv Valley is still blocked, which
    // is the containment we want.
    reward: { gil: 400, exp: 120, vehicle: { mode: 4, x: 89, y: 59 } },

    stages: [
      { id: 'ask', at: { map: 12, npc: 'cid' } },
      {
        id: 'seal',
        at: { map: 12, npc: 'cid' },
        objective: { kind: 'boss', bossId: 0xCD },
        // ⭐ TWO FLAGS, ON PURPOSE. `djinn_sealed` is the event; `curse_lifted`
        // is the world afterwards. Kazus and Sasune read the second, so a
        // future scene that lifts the curse another way needs no new predicate.
        sets: ['djinn_sealed', 'curse_lifted'],
      },
    ],
  },
};

// ── Row-shape helpers (pure — no player state, so the server can use them) ──

/** The stage record for a stage id, or null. */
export function stageById(quest, stageId) {
  return (quest.stages || []).find((s) => s.id === stageId) || null;
}

/** Index of a stage id, or -1. */
export function stageIndex(quest, stageId) {
  return (quest.stages || []).findIndex((s) => s.id === stageId);
}

/** The first stage — the offer. */
export function firstStage(quest) {
  return (quest.stages || [])[0] || null;
}

/**
 * The largest objective count across a quest's stages.
 *
 * ⛔ USED BY THE SERVER to clamp a saved `n`. With one objective per quest the
 * old validator could clamp against `quest.objective.count`; with stages the
 * legal maximum depends on which stage the save claims to be on, and a
 * validator that trusted `s` to pick the bound would be trusting the field it
 * is meant to be checking. Clamping to the largest is the honest bound: it
 * cannot be used to forge progress, because progress is not what pays — the
 * `quest_claims` ledger is.
 */
export function maxObjectiveCount(quest) {
  let max = 0;
  for (const s of quest.stages || []) {
    const c = s.objective ? (s.objective.count | 0) : 0;
    if (c > max) max = c;
  }
  return max;
}

/** Is `stageId` a legal stage of this quest (or the finished marker)? */
export function isLegalStage(quest, stageId) {
  return stageId === QUEST_DONE || stageIndex(quest, stageId) >= 0;
}
