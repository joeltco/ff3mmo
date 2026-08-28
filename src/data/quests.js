// Quest definitions.
//
// One quest per entry, keyed by id. `ps.quests[id]` holds the player's progress
// as `{ s, n }` — the STAGE they are on and that stage's objective count — and
// nothing else; everything static lives here so the save stays small and the
// server has a fixed table to validate claims against.
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
// A stage is:
//
//   { id,                    the value stored in `ps.quests[id].s`
//     at: { map, npc },      WHO advances it
//     objective,             optional — absent or kind 'talk' means TALKING to
//                            `at` advances it (see quest-objectives.js)
//     say,                   pages `at` speaks while the stage is unfinished
//     onAdvance,             pages `at` speaks at the moment it advances
//     sets,                  story flags set on advance (data/flags.js)
//     also }                 { npcKey: pages } — what the quest's OTHER people
//                            say while this stage is current, so walking back to
//                            the King mid-search is not silence
//
// Stage 0 is the offer: `offer` / `accepted` / `denied` instead of `say` /
// `onAdvance`, because it ends in a CHOICE rather than a step. Advancing the
// LAST stage finishes the quest and pays the reward. `after` is what each
// person says once it is over, keyed by npcKey.
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
  // and out in the open where you actually walk past him. (8,27) is closer to
  // the door but tucked against the wall.
  //
  // ⭐ PORTED UNCHANGED to stages. Two stages, both on the same man, which is
  // what the old one-giver shape could express — the port is meant to be
  // behaviour-preserving and `check-quests.mjs` walks it to prove that.
  ur_missing_brother: {
    id: 'ur_missing_brother',

    // FF2 Word Memory hook: he does NOT offer the job on sight. You learn
    // BROTHER from ur_npc_09 ("It took my brother.") and ASK him about it —
    // then the offer comes, with ACCEPT / DENY. Talking to him without the
    // word just gets his idle lines.
    startWord: 'brother',

    // `item` is the brother's own gear — the hand-in line hands over an object,
    // so one has to actually change hands. 0x58 Leather Shield: 40 gil, the
    // cheapest thing in Ur's armor shop, wearable by nearly every job. Shipped
    // v1.8.6; before that `complete` said "Take this. It was his." and paid
    // pure gil, which is what an audit called a lazy seam.
    reward: { gil: 300, exp: 80, item: 0x58 },

    stages: [
      {
        id: 'ask',
        at: { map: 114, npc: 'ur_npc_05' },
        // Message-box pages. The box wraps at 16 chars and fits 3 lines, so each
        // page must stay under ~48 characters — see data/town-npcs.js.
        offer: [
          'My brother went below.',
          'Eight days ago now.',
          'Thin out what nests there.',
          "I'll pay you well.",
        ],
        // Shown after ACCEPT, and after DENY, respectively. Both are replies to
        // a choice the player made, so neither repeats the offer.
        accepted: [
          'Then go. Tonight.',
          'Three of them. No more.',
        ],
        denied: [
          'No. I understand.',
          'The word will keep.',
        ],
      },
      {
        id: 'clear',
        at: { map: 114, npc: 'ur_npc_05' },
        // Objective: clear encounters inside the Altar Cave. `zonePrefix`
        // matches against `currentEncounterZoneKey()`, which returns keys like
        // `altar_cave_f1` / `altar_cave_boss`, so one prefix covers every floor.
        objective: { kind: 'defeat', zonePrefix: 'altar_cave', count: 3 },
        // `{n}` / `{count}` / `{left}` are filled in at talk time. This is the
        // ONLY place quest progress is shown — see the header note. Keep the
        // tokens on their own short line: check-dialogue-fit wraps the WIDEST
        // expansion.
        say: [
          'Still down there?',
          '{n} of {count} cleared.',
          '{left} more. Please.',
        ],
        onAdvance: [
          'You went down. For him.',
          'Take this. It was his.',
        ],
      },
    ],

    after: {
      ur_npc_05: [
        'The cave is quieter now.',
        'It will not bring him back.',
        'But it is quieter.',
      ],
    },
  },

  // ── UR: the lost riders ──────────────────────────────────────────────────
  //
  // Ur's second quest, and the payoff RIDERS never had — four NPCs already
  // talked about the knights who rode north and never came back, and nothing
  // came of it. v1.8.9.
  //
  // Deliberately NOT on ur_npc_05: a giver can hold several quests since the
  // v1.8.6 ranking fix, but one each reads better and puts the two errands in
  // different buildings. The teacher and the giver are also different people,
  // which is the point of the word gate — learn RIDERS from ur_elder_kin_a on
  // the elder's UPPER floor, then carry it across town to the tavern. A giver
  // who teaches their own start word is a chain with no walk in it.
  ur_lost_riders: {
    id: 'ur_lost_riders',

    // He already answers RIDERS — "They took the north road. I poured for
    // them." The offer replaces that answer once the quest is live.
    startWord: 'riders',

    // One for each rider. Longsword (0x24, atk 10, 100 gil in Ur's own weapon
    // shop) — a real upgrade on the starting Knife without outrunning the
    // shop, and a knight's weapon is what a knight leaves behind.
    reward: { gil: 250, exp: 60, item: 0x24 },

    stages: [
      {
        id: 'ask',
        at: { map: 9, npc: 'ur_tavern_drinker_d' },   // Ur tavern
        offer: [
          'Four rode north.',
          'I poured for them.',
          'The road took them.',
          'Clear it. For me.',
        ],
        accepted: [
          'Aye. The north road.',
          'One for each rider.',
        ],
        denied: [
          'No shame in it.',
          'The road keeps.',
        ],
      },
      {
        id: 'clear',
        at: { map: 9, npc: 'ur_tavern_drinker_d' },
        // The road they rode, not the cave. `grasslands_valley` is the goblin
        // corridor within radius 8 of Ur — `battle-encounter.js` picks it by
        // DISTANCE, not the old x=93..96 box (v1.7.945 replaced that), and the
        // Altar Cave mouth sits 7 tiles out, so the zone is exactly the stretch
        // of road between the town and the cave. NOT the bare `grasslands`
        // prefix: that also matches `grasslands_wild`, which is everything past
        // the radius plus Ur's own dark-tile patch, and clearing the north road
        // without walking it is not the errand.
        objective: { kind: 'defeat', zonePrefix: 'grasslands_valley', count: 4 },
        say: [
          'The road, warrior?',
          '{n} of {count} down.',
          '{left} still hold it.',
        ],
        onAdvance: [
          'The road is walked again.',
          'One of them left this.',
        ],
      },
    ],

    after: {
      ur_tavern_drinker_d: [
        'They will not ride back.',
        'But the road is ours.',
      ],
    },
  },

  // ── CASTLE SASUNE: THE KING'S DAUGHTER ───────────────────────────────────
  //
  // ⭐ THE CARTRIDGE SCRIPTED THIS. Script `0x23f` is the King, near verbatim:
  // the Djinn cursed everyone, it must be resealed to lift the curse, that
  // needs a Mythril Ring, Princess Sara has one — and where is she? Script
  // `0x240` is the payoff: "King Sasune gave you a Canoe."
  //
  // ⚠ THE ORDER IS OURS, AND IT IS THE RIGHT ONE FOR THIS MAP. In FF3 the canoe
  // is the reward AFTER the Djinn is sealed, and Cid's AIRSHIP is what crosses
  // the lake to the cave (`0x225`). Measured on our world map with the ROM's own
  // mask table at $C6CD: on foot Ur reaches 267 tiles and four entrances; the
  // CANOE reaches 296 and opens the Sealed Cave; the airship reaches 304 and
  // opens NEITHER cave, because both mouths carry tile byte1 $9e and bit 4 is
  // the flight barrier. The canoe is the only key that fits the lock we have.
  //
  // ⛔ THIS BLOCK USED TO SAY "SO SARA CANNOT BE IN THE CAVE", AND IT HAD THE
  // ARGUMENT BACKWARDS. It reasoned: the cave is behind the canoe, the canoe is
  // this quest's REWARD, therefore she must be somewhere else — and parked her
  // in Kazus. Joel, 2026-08-27: *"the king should have a quest to go find sara
  // where we receive the canoe to go there.... why is sara in kazus?!"*
  //
  // The canoe's TIMING was the thing that should have moved, not the princess. A
  // reward that arrives after the search cannot be the means of the search; it
  // has to arrive at the beat that tells you where she went. So the smith — the
  // man who cut her ring and was asked "what crosses water" — is now who puts a
  // craft in your hands, and she is where she said she was going.
  //
  // The walk: gate -> throne -> the one servant who was outside -> the smith who
  // made the ring AND the boat -> north across the water -> the Sealed Cave, and
  // she is past its boulder, one floor down. Four leads, two towns, and the last
  // one is a dungeon rather than a doorway.
  sasune_missing_daughter: {
    id: 'sasune_missing_daughter',

    // Heard at the gate from sasune_guard_w, carried inside to her father. The
    // King deliberately does NOT teach it — a giver who teaches their own start
    // word is a chain with no walk in it.
    startWord: 'sara',

    // ⭐ THE CANOE, parked at the shore it is for: world (87,41) is the last
    // foot-walkable tile before the four water tiles that lead to the Sealed
    // Cave's mouth at (84,36). Parked rather than boarded, like every craft —
    // you walk out to it and step in.
    // ⛔ NO `vehicle` HERE ANY MORE — it moved to the `forge` stage. A craft on
    // the reward is granted by `_grantVehicle` only when the LAST stage closes,
    // which is exactly what made the cave unreachable until after the search.
    reward: { gil: 500, exp: 200 },

    stages: [
      {
        id: 'ask',
        at: { map: 29, npc: 'sasune_king' },
        offer: [
          'The Djinn woke.',
          'It made ghosts of us.',
          'My daughter took her ring',
          'and did not come back.',
        ],
        accepted: [
          'Find her. Not the Djinn.',
          'Her.',
          'Take the canoe. She did.',
        ],
        // ⭐ THE KING GIVES THE CANOE. Joel said so five times, and I put it on
        // the smith anyway and wrote a paragraph explaining why the smith was
        // better. He asks you to go; he hands you the means. Granted the moment
        // the quest is accepted, so nothing about the search depends on
        // finishing the search.
        //
        // ⭐ THE CANOE IS AN ITEM. Joel, 2026-08-27: *"THE POCKET CANOE IS A
        // FUCKING ITEM."* `0xa5` / `Canoe`, `type: 'key'` — unsellable, and in
        // the pack where you can see it.
        //
        // It is paid through the validated claim path, ledgered `sasune_missing_
        // daughter#ask` in `quest_claims`, so it is handed over exactly once and
        // the mirror does not take it back. See `validateQuestClaim`.
        item: 0xa5,
        // ...and the craft itself, parked at world (87,41) — the last
        // foot-walkable tile before the water leading to the Sealed Cave's mouth
        // at (84,36). Boarding is by POSITION, the way the cartridge does it
        // (`movement.js`), so the item without the craft is a boat you cannot
        // get into.
        vehicle: { mode: 1, x: 87, y: 41 },
        sets: ['canoe_granted'],
        denied: [
          'No. You owe us nothing.',
          'I will ask again tomorrow.',
        ],
      },
      {
        // No objective: talking to the runner IS the beat. He was outside on an
        // errand when the curse fell (script 0x238) and is the only one who
        // could have seen her leave.
        id: 'errand',
        at: { map: 25, npc: 'sasune_hall_servant' },
        say: [
          'You are looking for her.',
          'I was outside. Ask me.',
        ],
        onAdvance: [
          'East gate, a week back.',
          'She wanted the Kazus road.',
          'I was carrying eggs.',
        ],
        also: {
          // Walking back to the King mid-search must not be silence.
          sasune_king: [
            'Still here?',
            'Ask the one who was out',
            'when it took us.',
          ],
        },
      },
      {
        id: 'forge',
        at: { map: 10, npc: 'kazus_smith' },
        say: [
          'Mind the ghosts.',
          'They were my neighbours.',
        ],
        onAdvance: [
          'The princess? Aye.',
          'Asked what crosses water.',
          'Went north, into the seal.',
          'You have the King\'s boat.',
        ],
        also: {
          sasune_king: [
            'North, past the water.',
            'She took a boat, not a road.',
          ],
        },
      },
      {
        // ⭐ IN THE SEALED CAVE, past the boulder on its second floor — map 2001
        // is the Cave of Seals' floor 1 (`base` 2000). She is behind the wall
        // that boulder opens, in the chamber the way down is in, so finding her
        // and finding the way deeper are the same walk.
        id: 'found',
        at: { map: 2001, npc: 'sara' },
        onAdvance: [
          'Sara. Of Castle Sasune.',
          'You are late, and I am',
          'not going back up yet.',
        ],
        sets: ['sara_found'],
        also: {
          kazus_smith: ['Past the water. She had', 'the ring and my boat.'],
        },
      },
      {
        id: 'return',
        at: { map: 29, npc: 'sasune_king' },
        say: [
          'You found her?',
          'Say it plainly.',
        ],
        onAdvance: [
          'Alive. Under the ground.',
          'Of course she is.',
          'She has her mother\'s',
          'contempt for stairs.',
        ],
        also: {
          sara: ['Tell him yourself.', 'He will not believe me.'],
        },
      },
    ],

    after: {
      sasune_king: [
        'She is home and furious.',
        'Let her be furious.',
      ],
      sara: [
        'You told him, then.',
        'I am still going back',
        'for that thing.',
      ],
    },
  },

  // ── KAZUS: THE SEALED CAVE ───────────────────────────────────────────────
  //
  // ⭐ REPLACES `kazus_cid_airship`, which was DEAD ON EVERY SAVE. Its giver was
  // `cid`, whose placement row was gated on that same quest being finished, so
  // the offer could never fire. Two Cids with two keys and a quest that could
  // only name one of them. See the note on the TOWN_NPCS rows.
  //
  // ⭐ Script `0x22d`: "The Djinn that we had banished into the Sealed Cave was
  // released by the earthquake." `0x23d`, the cursed: "The Djinn's curse has
  // left me in this wretched state."
  //
  // ⛔ THE OBJECTIVE IS A BOSS, NOT A ZONE. `kind: 'boss'` names monster 0xCD by
  // id, so clearing the Cave of Seals' ordinary encounters does not satisfy it.
  // Under the old runtime this quest could not have existed: `defeat` was the
  // only kind, which is why its ancestor asked you to grind four Altar Cave
  // encounters for an errand about a genie in a different dungeon.
  kazus_sealed_cave: {
    id: 'kazus_sealed_cave',

    // Learned from the cursed King, or from Sara, or from the smith — all three
    // say it in lines they would say anyway.
    startWord: 'djinn',

    // He keeps his promise from the old quest: the airship, parked in the sand
    // west of Kazus where FF3 leaves it. (89,59) is one tile west of the ROM's
    // own map-180 entrance, which cannot be the parking tile because map 180 is
    // in STRANDING_MAPS and refuses entry at the door.
    reward: { gil: 400, exp: 120, vehicle: { mode: 4, x: 89, y: 59 } },

    stages: [
      {
        id: 'ask',
        at: { map: 12, npc: 'cid' },
        offer: [
          'Look at me. Then look',
          'at the rest of this town.',
          'It sits in a cave north,',
          'past the water.',
        ],
        accepted: [
          'Take the ring to it.',
          'Nothing else bites.',
        ],
        denied: [
          'No. It is a lot to ask.',
          'We are not going anywhere.',
        ],
      },
      {
        id: 'seal',
        at: { map: 12, npc: 'cid' },
        objective: { kind: 'boss', bossId: 0xCD },
        say: [
          'Still here, warrior?',
          'North. Past the water.',
        ],
        onAdvance: [
          'The weight is off me.',
          'Feel the town? It breathes.',
          'She is west, in the sand.',
          'Walk to her. She knows you.',
        ],
        // ⭐ TWO FLAGS, ON PURPOSE. `djinn_sealed` is the event; `curse_lifted`
        // is the world afterwards. Kazus and Sasune read the second, so a future
        // scene that lifts the curse another way — or a Djinn beaten without
        // lifting it — needs no new predicate anywhere.
        sets: ['djinn_sealed', 'curse_lifted'],
        also: {
          sara: [
            'It is still down there.',
            'Go. I will wait.',
          ],
          sasune_king: [
            'You mean to go after it.',
            'Come back, warrior.',
          ],
        },
      },
    ],

    after: {
      cid: [
        'Cid, of Canaan. Properly,',
        'this time.',
        'Fly her well.',
      ],
    },
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
