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
};

// `questsForMap` lived here unused from the day it was written — removed
// v1.8.6. `talkQuest` resolves the giver by (mapId, npcKey) directly and no
// caller ever wanted a per-map list.
