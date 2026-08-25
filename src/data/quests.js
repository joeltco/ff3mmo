// Quest definitions.
//
// One quest per entry, keyed by id. `ps.quests[id]` holds the player's progress
// as `{ s, n }` — state and objective count — and nothing else; everything
// static lives here so the save stays small and the server has a fixed table to
// validate claims against.
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

export const QUEST_ACTIVE = 'active';   // accepted, objective unfinished
export const QUEST_DONE   = 'done';     // handed in, finished for good

export const QUESTS = {
  // Ur's first quest. The giver is the ROM NPC below the elder's house — door
  // to map 6 sits at (9,26), and he stands at ROM (10,28), a row further down
  // and out in the open where you actually walk past him. (8,27) is closer to
  // the door but tucked against the wall.
  ur_missing_brother: {
    id: 'ur_missing_brother',
    giver: { mapId: 114, npcKey: 'ur_npc_05' },

    // FF2 Word Memory hook: he does NOT offer the job on sight. You learn
    // BROTHER from ur_npc_09 ("It took my brother.") and ASK him about it —
    // then the offer comes, with ACCEPT / DENY. Talking to him without the
    // word just gets his idle lines.
    startWord: 'brother',

    // Objective: clear encounters inside the Altar Cave. `zonePrefix` matches
    // against `currentEncounterZoneKey()`, which returns keys like
    // `altar_cave_f1` / `altar_cave_boss`, so one prefix covers every floor.
    objective: { kind: 'defeat', zonePrefix: 'altar_cave', count: 3 },

    // `item` is the brother's own gear — the hand-in line hands over an object,
    // so one has to actually change hands. 0x58 Leather Shield: 40 gil, the
    // cheapest thing in Ur's armor shop, wearable by nearly every job. Shipped
    // v1.8.6; before that `complete` said "Take this. It was his." and paid
    // pure gil, which is what an audit called a lazy seam.
    reward: { gil: 300, exp: 80, item: 0x58 },

    // Message-box pages. The box wraps at 16 chars and fits 3 lines, so each
    // page must stay under ~48 characters — see data/town-npcs.js.
    offer: [
      'My brother went below.',
      'Eight days ago now.',
      'Thin out what nests there.',
      "I'll pay you well.",
    ],
    // Shown after ACCEPT, and after DENY, respectively. Both are replies to a
    // choice the player made, so neither repeats the offer.
    accepted: [
      'Then go. Tonight.',
      'Three of them. No more.',
    ],
    denied: [
      'No. I understand.',
      'The word will keep.',
    ],
    // `{n}` / `{count}` / `{left}` are filled in at talk time. This is the ONLY
    // place quest progress is shown — see the header note. Keep the tokens on
    // their own short line: check-dialogue-fit wraps the WIDEST expansion.
    active: [
      'Still down there?',
      '{n} of {count} cleared.',
      '{left} more. Please.',
    ],
    complete: [
      'You went down. For him.',
      'Take this. It was his.',
    ],
    done: [
      'The cave is quieter now.',
      'It will not bring him back.',
      'But it is quieter.',
    ],
  },

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
    giver: { mapId: 9, npcKey: 'ur_tavern_drinker_d' },   // Ur tavern

    // He already answers RIDERS — "They took the north road. I poured for
    // them." The offer replaces that answer once the quest is live.
    startWord: 'riders',

    // The road they rode, not the cave. `grasslands_valley` is the goblin
    // corridor within radius 8 of Ur — `battle-encounter.js` picks it by
    // DISTANCE, not the old x=93..96 box (v1.7.945 replaced that), and the
    // Altar Cave mouth sits 7 tiles out, so the zone is exactly the stretch of
    // road between the town and the cave. NOT the bare `grasslands` prefix:
    // that also matches `grasslands_wild`, which is everything past the radius
    // plus Ur's own dark-tile patch, and clearing the north road without
    // walking it is not the errand.
    objective: { kind: 'defeat', zonePrefix: 'grasslands_valley', count: 4 },

    // One for each rider. Longsword (0x24, atk 10, 100 gil in Ur's own weapon
    // shop) — a real upgrade on the starting Knife without outrunning the
    // shop, and a knight's weapon is what a knight leaves behind.
    reward: { gil: 250, exp: 60, item: 0x24 },

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
    active: [
      'The road, warrior?',
      '{n} of {count} down.',
      '{left} still hold it.',
    ],
    complete: [
      'The road is walked again.',
      'One of them left this.',
    ],
    done: [
      'They will not ride back.',
      'But the road is ours.',
    ],
  },

  // ── CID'S AIRSHIP ────────────────────────────────────────────────────────
  //
  // ⚠ ROUGH ON PURPOSE. The whole NPC-dialogue + quest pass comes after the
  // towns are shaped; this carries the BEATS of FF3's chain — a cursed Cid in
  // the Kazus inn, and an airship waiting in the western desert — not the final
  // voice, and not the Mythril Ring errand the cartridge actually runs (there
  // is no fetch-an-item objective kind yet; `defeat` is the only one).
  kazus_cid_airship: {
    id: 'kazus_cid_airship',
    // ⭐ THE REAL CID (v1.10.70): map 10, at the Kazus pub door. `cid_ghost`
    // was never him — it stood on record $27, "This cave is the Mythril Mines."
    giver: { mapId: 12, npcKey: 'cid' },

    // Learned from kazus_town_d out in the town ("Left an airship in the
    // sand."), carried into the inn. Teacher and giver in different rooms, as
    // with RIDERS.
    startWord: 'airship',

    objective: { kind: 'defeat', zonePrefix: 'altar_cave', count: 4 },

    reward: { gil: 400, exp: 120 },

    // ⭐ THE REAL PAYOUT — the airship, parked where FF3 leaves it: the desert
    // pocket west of Kazus. (89,59) is one tile west of the ROM's own map-180
    // entrance at (90,59), which cannot be the parking tile because that map is
    // in STRANDING_MAPS and refuses entry at the door.
    //
    // Parked rather than boarded: boarding is by POSITION, so the player walks
    // out to the sand and climbs in, which is the sequence rather than a craft
    // appearing under them.
    grantsVehicle: { mode: 4, x: 89, y: 59 },

    offer: [
      'You know of her.',
      'West, past the rock.',
      'The cave road is thick.',
      'Thin it and she is yours.',
    ],
    accepted: [
      'Then go. Come back whole.',
      'A ghost keeps his word.',
    ],
    denied: [
      'No. Sand keeps her fine.',
      'Ask again.',
    ],
    active: [
      'The cave road, warrior?',
      '{n} of {count} cleared.',
      '{left} more and she flies.',
    ],
    complete: [
      'The road is thin. Good.',
      'She waits west, in the sand.',
      'Walk to her. She knows you.',
    ],
    done: [
      'The curse let go of me.',
      'Fly her well.',
    ],
  },
};

// `questsForMap` lived here unused from the day it was written — removed
// v1.8.6. `talkQuest` resolves the giver by (mapId, npcKey) directly and no
// caller ever wanted a per-map list.
