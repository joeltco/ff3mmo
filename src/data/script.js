// The script — every line a quest makes somebody say.
//
// ⛔ CLIENT ONLY. THIS FILE MUST NEVER BE IMPORTED BY THE SERVER, and that is
// the entire reason it exists. `data/quests.js` is imported by `api.js` and
// `economy-arbiter.js` so the server can validate claims against the same table
// the client uses — and until v1.11.x that table was roughly 45% English. The
// process that decides whether a player gets paid was carrying the King's
// dialogue around in memory, and no line of it could be rewritten without
// touching the file two server modules boot from.
//
// The split is the one from `docs/QUEST-DIALOGUE-PLAN.md` §5.1, deferred once
// and now done:
//
//   data/quests.js    MECHANICS — who advances a stage, what the objective is,
//                     which flags it sets, what it pays. No prose.
//   data/script.js    PROSE — every page, keyed by quest / stage / field.
//
// `tools/check-script-split.mjs` is the gate: `data/quests.js` may contain no
// prose field, and nothing the server imports may reach this file.
//
// ── THE VOICE ─────────────────────────────────────────────────────────────
//
// The box wraps at `MSG_MAX_CHARS` and fits `MSG_MAX_LINES` = 2, so a page is
// about 32 characters. That constraint IS the voice — terse, declarative, no
// throat-clearing. `check-dialogue-fit` wraps the widest token expansion of
// every page here.
//
// Rules kept from the rebuild:
//   1. No exposition an NPC would not say out loud. Nobody explains the plot
//      to a stranger.
//   2. Every Key Term is a word somebody actually says, so LEARN is honest.
//   3. Where the cartridge has a line, it goes first and we say so —
//      `docs/FF3-SCRIPT.md`. Ours second.
//
// `{n}` / `{count}` / `{left}` are filled at talk time by `quests.js#_fill`.
// Keep them on their own short line: the gate wraps the WIDEST expansion.
//
// ── ⛔ THERE IS NO `after` ─────────────────────────────────────────────────
//
// A quest's parting line is NOT here, because it is not a property of the
// quest. `quest.after[npcKey]` used to be a resolution layer that outranked an
// NPC's own dialogue for the rest of the save, which meant an endgame idle
// variant an author wrote could never be reached — measured over all 384
// consistent world states, Cid's post-curse line and Sara's `sara_found` line
// were both dead. What somebody says forever after is a fact about the WORLD.
//
// So: every quest's LAST stage sets a flag (`data/flags.js`), and the parting
// line is a flag-guarded variant on that person's row in `data/town-npcs.js`.
// `check-speech-coverage` fails the build if a cast member says exactly the
// same thing after the quest as before it.

export const SCRIPT = {
  // ── UR: the missing brother ──────────────────────────────────────────────
  ur_missing_brother: {
    stages: {
      ask: {
        offer: [
          'My brother went below.',
          'Eight days ago now.',
          'Thin out what nests there.',
          "I'll pay you well.",
        ],
        // Replies to a choice the player already made, so neither repeats the
        // offer.
        accepted: [
          'Then go. Tonight.',
          'Three of them. No more.',
        ],
        denied: [
          'No. I understand.',
          'The word will keep.',
        ],
      },
      clear: {
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
    },
  },

  // ── UR: the lost riders ──────────────────────────────────────────────────
  ur_lost_riders: {
    stages: {
      ask: {
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
      clear: {
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
    },
  },

  // ── CASTLE SASUNE: THE KING'S DAUGHTER ───────────────────────────────────
  //
  // ⭐ THE CARTRIDGE SCRIPTED THIS. Script `0x23f` is the King, near verbatim:
  // the Djinn cursed everyone, it must be resealed to lift the curse, that
  // needs a Mythril Ring, Princess Sara has one — and where is she?
  //
  // ⭐ AND THE ORDER IS THE CARTRIDGE'S TOO. Measured 2026-08-27 against the
  // script and two walkthroughs: the party takes Cid's AIRSHIP before the
  // search (`0x225` — "Cross the lake with my airship and you'll reach the
  // Sealed Cave"), and Sara is found INSIDE the cave, part-way down (`0x245`).
  // A craft handed over at the ask, the princess found in the dungeon — that
  // is this chain, with the canoe substituted for the airship because our
  // terrain measurably requires it. The old "⚠ this reorders canon" note was
  // wrong and has been struck.
  sasune_missing_daughter: {
    stages: {
      ask: {
        offer: [
          'The Djinn woke.',
          'It made ghosts of us.',
          'My daughter took her ring',
          'and did not come back.',
        ],
        // ⭐ THE KING GIVES THE CANOE. He asks you to go; he hands you the
        // means. The grant itself is mechanics — `data/quests.js`.
        accepted: [
          'Find her. Not the Djinn.',
          'Her.',
          'Take the canoe. She did.',
        ],
        denied: [
          'No. You owe us nothing.',
          'I will ask again tomorrow.',
        ],
      },
      errand: {
        // He was outside on an errand when the curse fell (script `0x238`) and
        // is the only one who could have seen her leave.
        say: [
          'You are looking for her.',
          'I was outside. Ask me.',
        ],
        onAdvance: [
          'East gate, a week back.',
          'She wanted the Kazus road.',
          'I was carrying eggs.',
        ],
      },
      forge: {
        say: [
          'Mind the ghosts.',
          'They were my neighbours.',
        ],
        onAdvance: [
          'The princess? Aye.',
          'Asked what crosses water.',
          'Went north, into the seal.',
          "You have the King's boat.",
        ],
      },
      found: {
        onAdvance: [
          'Sara. Of Castle Sasune.',
          'You are late, and I am',
          'not going back up yet.',
        ],
      },
      return: {
        say: [
          'You found her?',
          'Say it plainly.',
        ],
        onAdvance: [
          'Alive. Under the ground.',
          'Of course she is.',
          "She has her mother's",
          'contempt for stairs.',
        ],
      },
    },
    // ⭐ VOICE — what the quest's OTHER people say while a stage is live, keyed
    // by PERSON rather than by stage. Same information as the old per-stage
    // `also`, transposed: you read one character's whole arc in order, and a
    // stage they have nothing for is visible as a gap on the page instead of
    // something you only find by walking the game. `check-speech-coverage`
    // fails the build on one.
    voice: {
      sasune_king: [
        { while: ['errand'], pages: [
          'Still here?',
          'Ask the one who was out',
          'when it took us.',
        ] },
        { while: ['forge'], pages: [
          'North, past the water.',
          'She took a boat, not a road.',
        ] },
      ],
      kazus_smith: [
        { while: ['found'], pages: ['Past the water. She had', 'the ring and my boat.'] },
      ],
      sara: [
        { while: ['return'], pages: ['Tell him yourself.', 'He will not believe me.'] },
      ],
    },
  },

  // ── KAZUS: THE SEALED CAVE ───────────────────────────────────────────────
  //
  // ⭐ Script `0x22d`: "The Djinn that we had banished into the Sealed Cave was
  // released by the earthquake." `0x23d`, the cursed: "The Djinn's curse has
  // left me in this wretched state."
  kazus_sealed_cave: {
    stages: {
      ask: {
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
      seal: {
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
      },
    },
    voice: {
      sara: [
        { while: ['seal'], pages: [
          'It is still down there.',
          'Go. I will wait.',
        ] },
      ],
      sasune_king: [
        { while: ['seal'], pages: [
          'You mean to go after it.',
          'Come back, warrior.',
        ] },
      ],
    },
  },
};

// ── Accessors — the ONE way prose is read ─────────────────────────────────
//
// The runtime and every gate go through these, so "where does this line live"
// has one answer. A missing entry returns null rather than throwing: a stage
// with no `say` is legal (the beat has no waiting line), and the caller falls
// through to the NPC's own dialogue.

/** Pages a stage speaks for `field` (offer/accepted/denied/say/onAdvance). */
export function stagePages(questId, stageId, field) {
  const q = SCRIPT[questId];
  const s = q && q.stages && q.stages[stageId];
  return (s && s[field]) || null;
}

/**
 * What the quest's OTHER people say while `stageId` is the live stage.
 *
 * ⭐ Reads the per-person `voice` block. The first entry whose `while` names
 * this stage wins, so a person can have one line for a run of stages and a
 * different one for a later beat.
 */
export function asidePages(questId, stageId, npcKey) {
  const q = SCRIPT[questId];
  const entries = q && q.voice && q.voice[npcKey];
  if (!Array.isArray(entries)) return null;
  const hit = entries.find((e) => (e.while || []).includes(stageId));
  return (hit && hit.pages) || null;
}

/** Every npcKey with a voice line at this stage — for gates walking coverage. */
export function asideKeys(questId, stageId) {
  const q = SCRIPT[questId];
  if (!q || !q.voice) return [];
  return Object.keys(q.voice).filter((k) => asidePages(questId, stageId, k));
}

/** Everyone a quest ever gives a voice line to, at any stage. */
export function voiceKeys(questId) {
  const q = SCRIPT[questId];
  return q && q.voice ? Object.keys(q.voice) : [];
}

/** Which stages a person has a voice line for — for coverage reporting. */
export function voiceStages(questId, npcKey) {
  const q = SCRIPT[questId];
  const entries = (q && q.voice && q.voice[npcKey]) || [];
  return entries.flatMap((e) => e.while || []);
}
