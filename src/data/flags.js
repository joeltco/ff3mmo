// Story flags — the world's own state, as opposed to one quest's progress.
//
// `ps.flags[id] = 1` means the fact is true for this save. Absent means false.
// Nothing else is stored: a flag has no count, no timestamp and no payload, so
// the save stays small and the server has a fixed table to validate against.
//
// ⛔ THIS FILE MUST STAY IMPORT-FREE. `api.js` imports it directly so the
// SERVER validates flags against the same table the client uses — the same rule
// `data/quests.js` and `data/keywords.js` live under. One browser-only import
// here takes the server process down at boot.
//
// ⭐ WHY THIS EXISTS, AND WHY IT IS NOT `ps.quests`.
//
// Before this, the only expressible world fact was "is quest K done"
// (`npc.js#_questDone`, fed to TOWN_NPCS `when:` predicates). That works for one
// NPC and falls apart at scale: the cursed-town inversion needs THIRTY-SEVEN
// NPCs in two towns to change together, and keying all of them to a quest id
// welds the town's appearance to one quest's identity. Rename or retire that
// quest and two towns silently revert.
//
// A flag says what is true about the WORLD. A quest says where one player is in
// one errand. `curse_lifted` is the former; it happens to be SET by a quest
// stage today, and the towns do not care.
//
// ⛔ PER-PLAYER, NOT PER-WORLD. `ps.flags` lives in the save, so two players
// standing in Kazus can see different towns. That is deliberate: FF3's story is
// a personal progression, and a server-wide curse would mean whoever kills the
// Djinn first ends the early game for every player who arrives afterwards.
// Making it world-wide later is a server fact + a room sync, not a change here.

/**
 * Every flag the game may set, with what it means. An id absent from this table
 * is dropped by BOTH `sanitizeFlags` and the server validator — a flag that is
 * not declared here does not exist.
 */
export const FLAGS = {
  // ── Ur ──────────────────────────────────────────────────────────────────
  //
  // ⭐ THESE EXIST BECAUSE `after` DIED. A quest's parting line used to be
  // `quest.after[npcKey]`, a layer that outranked the NPC's own dialogue for
  // the rest of the save — so an endgame idle variant an author wrote could
  // never be seen (measured over all 384 world states: Cid's post-curse line
  // and Sara's `sara_found` line were both unreachable). What somebody says
  // forever after is a fact about the WORLD, which is what this table is for.
  brother_avenged: {
    text: 'The Altar Cave was thinned out for the man who lost his brother.',
  },
  road_cleared: {
    text: 'The north road out of Ur has been cleared.',
  },

  // ── The Sasune chain ────────────────────────────────────────────────────
  sara_found: {
    text: 'Princess Sara has been found.',
  },
  canoe_granted: {
    text: 'King Sasune has handed over the canoe.',
  },
  daughter_home: {
    text: 'The King has been told his daughter is alive.',
  },

  // ── The Sealed Cave chain ───────────────────────────────────────────────
  djinn_sealed: {
    text: 'The Djinn has been beaten in the Cave of Seals.',
  },
  // ⭐ The one the towns read. Kept SEPARATE from `djinn_sealed` on purpose:
  // one is an event, the other is the world's state afterwards. They are set
  // together today; a future scene that lifts the curse some other way, or a
  // Djinn that is beaten without lifting it, needs no new predicate anywhere.
  curse_lifted: {
    text: 'The Djinn\'s curse is off Kazus and Castle Sasune.',
  },
};

/** Is `id` a declared flag? */
export function isFlag(id) {
  return Object.prototype.hasOwnProperty.call(FLAGS, id);
}

/** Display text for a flag id, or null if the id is unknown. */
export function flagText(id) {
  const f = FLAGS[id];
  return f ? f.text : null;
}

/**
 * Sanitise a `flags` blob loaded from a save or pushed by the server.
 *
 * Mirrors `api.js`'s validator exactly — an undeclared id is dropped on both
 * sides. Two halves of one save must agree on what is legal; `quests` spent a
 * release where they did not (v1.8.6).
 */
export function sanitizeFlags(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const id of Object.keys(raw)) {
    if (!isFlag(id)) continue;          // undeclared -> drop
    if (!raw[id]) continue;             // falsey -> absent, not stored
    out[id] = 1;
  }
  return out;
}
