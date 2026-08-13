// Quest runtime — state, the overhead marker, and the talk handler.
//
// State lives in `ps.quests[id] = { s, n }` (state + objective count) and
// nothing more; the static half is in data/quests.js so the server has a fixed
// table to check claims against. Persisted through BOTH the client serializer
// (save-state.js) and the server validator (api.js) — a `ps.*` field added to
// only one of those silently vanishes on the next login.
//
// Marker colour is DERIVED from state every frame, never stored, so the sprite
// can never disagree with the save.

import { ps } from './player-stats.js';
import { QUESTS, QUEST_ACTIVE, QUEST_DONE } from './data/quests.js';
import {
  QUEST_MARKER_OFFSET, QUEST_MARKER_FRAMES, QUEST_MARKER_TILES_PER_FRAME,
  QUEST_MARKER_PALETTES,
} from './data/quest-marker.js';
import { NES_SYSTEM_PALETTE, decodeTile } from './tile-decoder.js';
import { _makeCanvas16 } from './canvas-utils.js';

// ── marker sprite ─────────────────────────────────────────────────────────
// Decoded once from the ROM, then coloured per state on demand. Same shape as
// flame-sprites.js: 2 frames of 4 tiles, 16x16.
let _rawFrames = null;                 // [[tl,tr,bl,br], [tl,tr,bl,br]]
const _canvasCache = new Map();        // "state" -> [canvas, canvas]

export function initQuestMarker(romData) {
  if (_rawFrames) return;
  _rawFrames = [];
  for (let f = 0; f < QUEST_MARKER_FRAMES; f++) {
    const base = QUEST_MARKER_OFFSET + f * QUEST_MARKER_TILES_PER_FRAME * 16;
    const tiles = [];
    for (let t = 0; t < QUEST_MARKER_TILES_PER_FRAME; t++) {
      tiles.push(decodeTile(romData, base + t * 16));
    }
    _rawFrames.push(tiles);
  }
}

/** Both frames of the marker in `state`'s palette, or null before init. */
export function getMarkerFrames(state) {
  if (!_rawFrames) return null;
  const cached = _canvasCache.get(state);
  if (cached) return cached;
  const pal = QUEST_MARKER_PALETTES[state];
  if (!pal) return null;
  const rgb = pal.map(v => NES_SYSTEM_PALETTE[v & 0x3F] || [0, 0, 0]);
  const offsets = [[0, 0], [8, 0], [0, 8], [8, 8]];
  const out = [];
  for (const tiles of _rawFrames) {
    const c = _makeCanvas16();
    const cx = c.getContext('2d');
    const img = cx.createImageData(16, 16);
    for (let q = 0; q < 4; q++) {
      const tile = tiles[q];
      const [ox, oy] = offsets[q];
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const v = tile[y * 8 + x];
          const i = ((oy + y) * 16 + (ox + x)) * 4;
          if (v === 0) { img.data[i + 3] = 0; continue; }   // index 0 = transparent
          const col = rgb[v];
          img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2];
          img.data[i + 3] = 255;
        }
      }
    }
    cx.putImageData(img, 0, 0);
    out.push(c);
  }
  _canvasCache.set(state, out);
  return out;
}

// ── state ─────────────────────────────────────────────────────────────────
function _entry(id) {
  if (!ps.quests || typeof ps.quests !== 'object') return null;
  const e = ps.quests[id];
  return e && typeof e === 'object' ? e : null;
}

/** True once the objective count is met. */
function _objectiveMet(quest, entry) {
  return !!entry && (entry.n | 0) >= (quest.objective.count | 0);
}

/**
 * Marker to draw over this NPC, or null for none. Derived — never stored, so
 * the bubble cannot drift out of sync with the save.
 */
export function questMarkerState(mapId, npcKey) {
  for (const quest of Object.values(QUESTS)) {
    if (quest.giver.mapId !== mapId || quest.giver.npcKey !== npcKey) continue;
    const e = _entry(quest.id);
    if (!e) return 'available';                       // red — not taken yet
    if (e.s === QUEST_DONE) return null;              // finished; no marker
    return _objectiveMet(quest, e) ? 'turnin'         // green — hand it in
                                   : 'active';        // amber — still working
  }
  return null;
}

/**
 * Talking to a quest giver. Returns the pages to show and advances the quest,
 * or null when this NPC has nothing quest-related to say (caller then falls
 * back to the NPC's ordinary idle dialogue).
 */
export function talkQuest(mapId, npcKey, grantReward) {
  for (const quest of Object.values(QUESTS)) {
    if (quest.giver.mapId !== mapId || quest.giver.npcKey !== npcKey) continue;
    if (!ps.quests || typeof ps.quests !== 'object') ps.quests = {};
    const e = _entry(quest.id);

    if (!e) {
      // Word-gated quests stay shut until the player ASKs about the start
      // term (see askQuestWord). Returning null drops the caller back to the
      // giver's ordinary idle dialogue — which is where the ASK menu opens.
      if (quest.startWord) return null;
      ps.quests[quest.id] = { s: QUEST_ACTIVE, n: 0 };
      return quest.offer;
    }
    if (e.s === QUEST_DONE) return quest.done;
    if (_objectiveMet(quest, e)) {
      e.s = QUEST_DONE;
      if (typeof grantReward === 'function') grantReward(quest.reward);
      return quest.complete;
    }
    return quest.active;
  }
  return null;
}

/**
 * The player asked this NPC about `wordId`. Returns the quest's offer when
 * that is the start term of an untaken quest they give, else null — the caller
 * then falls back to the NPC's ordinary answer for the word.
 *
 * Nothing is written here: the offer is a question, and `acceptQuest` is what
 * actually starts it.
 */
export function askQuestWord(mapId, npcKey, wordId) {
  for (const quest of Object.values(QUESTS)) {
    if (quest.giver.mapId !== mapId || quest.giver.npcKey !== npcKey) continue;
    if (quest.startWord !== wordId) continue;
    if (_entry(quest.id)) continue;                 // already offered and taken
    return { id: quest.id, pages: quest.offer, accepted: quest.accepted, denied: quest.denied };
  }
  return null;
}

/** Take the quest that askQuestWord offered. */
export function acceptQuest(id) {
  const quest = QUESTS[id];
  if (!quest) return false;
  if (!ps.quests || typeof ps.quests !== 'object') ps.quests = {};
  if (ps.quests[id]) return false;
  ps.quests[id] = { s: QUEST_ACTIVE, n: 0 };
  return true;
}

/**
 * An encounter was won in `zoneKey`. Advances every active quest whose
 * objective matches. Counting client-side is fine because the REWARD is what
 * matters, and that is granted through the same path the server already
 * validates; the count only decides which colour the bubble is.
 */
export function noteEncounterVictory(zoneKey) {
  if (!zoneKey || !ps.quests || typeof ps.quests !== 'object') return;
  for (const quest of Object.values(QUESTS)) {
    const e = _entry(quest.id);
    if (!e || e.s !== QUEST_ACTIVE) continue;
    const obj = quest.objective;
    if (obj.kind !== 'defeat') continue;
    if (!String(zoneKey).startsWith(obj.zonePrefix)) continue;
    if ((e.n | 0) >= obj.count) continue;
    e.n = (e.n | 0) + 1;
  }
}

/** Sanitise a `quests` blob loaded from a save or pushed by the server. */
export function sanitizeQuests(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    const quest = QUESTS[id];
    if (!quest || !v || typeof v !== 'object') continue;   // unknown id -> drop
    const s = v.s === QUEST_DONE ? QUEST_DONE : QUEST_ACTIVE;
    const n = Math.max(0, Math.min(quest.objective.count | 0, v.n | 0));
    out[id] = { s, n };
  }
  return out;
}
