// Boss identity — the ONE place a boss's bestiary id is written down.
//
// ⛔ DO NOT put this in `data/monsters.js`. That file is AUTO-GENERATED from the
// ROM and overwritten wholesale by `tools/gen-monsters-js.js`; anything added by
// hand disappears on the next regeneration. This module is hand-maintained and
// imports nothing, so every module can read it without an import cycle
// (`battle-state.js` imports `pvp.js`, so `pvp.js` cannot import back).
//
// The id used to be the bare literal `0xCC` in SEVEN places — `boot.js`
// (sprite load), `battle-state.js` (BOSS_ATK / BOSS_DEF / BOSS_MAX_HP),
// `battle-update.js` (victory rewards), `pvp.js`, `input-handler.js` and
// `loading-screen.js`. `pvp.js` and `input-handler.js` re-derived atk and def
// that `battle-state.js` already exports, which is exactly how a later change
// lands in some of them and not others.
//
// ⭐ For the reward path, prefer `battleSt.bossId` — it defaults to this and is
// what a second boss would set per-encounter. `DEFAULT_BOSS_ID` is for the
// module-level constants that are evaluated at import time and cannot be
// per-battle (the HP/ATK/DEF numbers the battle math is built on).
export const DEFAULT_BOSS_ID = 0xCC;   // Land Turtle / Adamantoise — Altar Cave
