// Quest definitions.
//
// One quest per entry, keyed by id. `ps.quests[id]` holds the player's progress
// as `{ s, n }` — state and objective count — and nothing else; everything
// static lives here so the save stays small and the server has a fixed table to
// validate claims against.
//
// There is no overhead marker. Quest stage lives in `ps.quests[id].s` and is
// surfaced by what the giver SAYS, not by a sprite — removed in v1.7.990/991
// because Word Memory (ASK/LEARN) is the signposting now.

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

    reward: { gil: 300, exp: 80 },

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
    active: [
      'Still down there?',
      'Clear three. Please.',
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

/** Every quest whose giver stands on this map. */
export function questsForMap(mapId) {
  return Object.values(QUESTS).filter(q => q.giver.mapId === mapId);
}
