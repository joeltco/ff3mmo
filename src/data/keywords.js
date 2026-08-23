// Key Terms — FF2's Word Memory.
//
// In FF2 a quest is not "kill N and come back", it is "carry the right word to
// the right person": an NPC says something, you LEARN the term out of it, and
// you ASK it of somebody else to unlock the next step (usually another term).
// Terms can be missed. See the research note in CHANGELOG v1.7.979.
//
// This file is only the vocabulary. WHO teaches a term and WHO answers it lives
// on the NPC specs in data/town-npcs.js (`teaches` / `answers`), so an NPC's
// placement, dialogue and word behaviour all sit in one row.

// Every term here is a word an Ur NPC ALREADY says in their idle dialogue —
// that is what makes LEARN honest: you take the word out of what you were just
// told. A term with no teacher or no answerer among the NPCs actually placed on
// a map is a dead end; tools/check-words.mjs fails the build on one.
export const KEYWORDS = {
  brother: { text: 'BROTHER' },   // ur_npc_09: "It took my brother."
  cave:    { text: 'CAVE' },      // ur_npc_0d: "The cave drains the light."
  riders:  { text: 'RIDERS' },    // ur_elder_kin_a: "for riders long gone."
  vein:    { text: 'VEIN' },      // ur_tavern_drinker_b: "the vein went black."
  airship: { text: 'AIRSHIP' },   // kazus_town_d: "He left an airship west."
};

/** Display text for a term id, or null if the id is unknown. */
export function keywordText(id) {
  const k = KEYWORDS[id];
  return k ? k.text : null;
}
