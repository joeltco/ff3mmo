// Quest definitions.
//
// One quest per entry, keyed by id. `ps.quests[id]` holds the player's progress
// as `{ s, n }` — state and objective count — and nothing else; everything
// static lives here so the save stays small and the server has a fixed table to
// validate claims against.
//
// Marker colour is derived, never stored: see `questMarkerState` in quests.js.
// The ROM has only ONE bubble glyph (see data/quest-marker.js), so a quest's
// stage is carried by the mark's colour rather than by a second symbol.

export const QUEST_ACTIVE = 'active';   // accepted, objective unfinished
export const QUEST_DONE   = 'done';     // handed in, finished for good

export const QUESTS = {
  // Ur's first quest. The giver stands directly under the elder's house door
  // (map 114 door to map 6 is at (9,26); he is at ROM (8,27)) — the spot you
  // walk past on the way in and out of the elder's, so the bubble is hard to
  // miss.
  ur_missing_brother: {
    id: 'ur_missing_brother',
    giver: { mapId: 114, npcKey: 'ur_npc_07' },

    // Objective: clear encounters inside the Altar Cave. `zonePrefix` matches
    // against `currentEncounterZoneKey()`, which returns keys like
    // `altar_cave_f1` / `altar_cave_boss`, so one prefix covers every floor.
    objective: { kind: 'defeat', zonePrefix: 'altar_cave', count: 3 },

    reward: { gil: 300, exp: 80 },

    // Message-box pages. The box wraps at 16 chars and fits 3 lines, so each
    // page must stay under ~48 characters — see data/town-npcs.js.
    offer: [
      'My brother went down into the cave.',
      'That was eight days ago.',
      'Thin out whatever is nesting in there.',
      "I'll make it worth your while.",
    ],
    active: [
      'Still down there, is it?',
      'Clear three of them out. Please.',
    ],
    complete: [
      'You went down there. For him.',
      'Take this. It was going to be his.',
    ],
    done: [
      'The cave is quieter now.',
      'It does not bring him back.',
      'But it is quieter.',
    ],
  },
};

/** Every quest whose giver stands on this map. */
export function questsForMap(mapId) {
  return Object.values(QUESTS).filter(q => q.giver.mapId === mapId);
}
