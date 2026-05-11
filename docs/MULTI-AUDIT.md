# Multi-system audit: slash + spell-anim + encounter + chat + HUD fade

Started 2026-05-10. Surveys the five remaining-after-save-state audit
areas. Each is a fast sweep — find structural duplication, latent
bugs, dead schema, parallel implementations.

## TL;DR

| # | Item | Class | Status |
|---|------|-------|--------|
| 1 | `SLASH_FRAMES = 3` duplicated in 4 files | dedup | ✅ v1.7.217 |
| 2 | `BATTLE_TEXT_STEPS = 4` + `BATTLE_TEXT_STEP_MS = 50` duplicated in 3 files | dedup | ✅ v1.7.217 |
| 3 | Encounter rate rolls threshold per-step (probabilistic, not fixed) | gameplay nuance | ⏸ doc-only — current behavior feels right |
| 4 | `encounterSteps` resets on map load — re-entry gives ~20-step grace period | exploit-ish | ⏸ deferred — typical NES behavior |
| 5 | Hardcoded valley bounding-box `(93-96, 34-44)` in 2 files | dedup | ⏸ minor; deferred |
| 6 | Spell-anim phase pipeline | clean | ✅ verified clean — single source via `CAST_PHASE_MS_THROW` / `CAST_PHASE_MS_HEAL` in `cast-anim.js` |
| 7 | Chat command registry | clean | ✅ verified clean — `registerCommand` single source, no dupes |
| 8 | HUD fade — `TOPBOX_FADE_STEPS` / `_STEP_MS` | clean | ✅ single source in `transitions.js` |

## #1 — `SLASH_FRAMES = 3` duplicated

Found in: `battle-drawing.js:65`, `pvp.js:46`, `pvp-drawing.js:38`,
`battle-draw-encounter.js:35`. Not exported from `slash-effects.js`
(where it logically belongs alongside `SLASH_FRAME_MS` /
`SWING_HOLD_MS`).

**Fix:** export from `slash-effects.js`, drop the four local copies.

## #2 — `BATTLE_TEXT_STEPS` + `BATTLE_TEXT_STEP_MS` duplicated

Found in: `battle-draw-menu.js:32-33`, `battle-update.js:43-44`,
`pvp.js:50-51`. Same values (`4` / `50`), three files. Tear-down
timer for battle text fade-in/out — drives every menu / message
fade in battle.

**Fix:** export from `battle-state.js` (alongside other battle
timing constants like `MONSTER_DEATH_MS`, `BATTLE_SHAKE_MS`).

## #3 — Encounter rate: per-step threshold roll

`battle-encounter.js:_consumeEncounter`:
```js
mapSt.encounterSteps++;
const threshold = onGrass
  ? 20 + Math.floor(Math.random() * 20)  // 20-39
  : 15 + Math.floor(Math.random() * 15); // 15-29
if (mapSt.encounterSteps >= threshold) { ... }
```

The threshold rolls **fresh every step**. NES FF3 rolls a fixed
threshold at encounter end and counts steps against it. The
practical effect is similar in expected value (encounters
clustered around ~25-30 steps) but the distribution is different:
- Per-step rolling: low-counter steps can't trigger (need
  threshold ≤ counter); high-counter steps almost always trigger
  (lots of rolls, most beat the low end).
- Fixed-threshold-per-encounter: each step is a "have I reached
  the goal yet" check.

Current behavior tested as "feeling right" — leaving as-is. Doc'd
here for future tuning reference.

## #4 — `encounterSteps` resets on map load

`map-loading.js:133, 251, 285` reset `mapSt.encounterSteps = 0`.
Effect: re-entering a dungeon (or any map) gives the player ~20
free steps before the first possible encounter.

Could be:
- **Exploit-friendly** — players can chain re-entry for safe travel.
- **NES-faithful** — original FF games behave this way; the grace
  period feels intentional after a "go in, fight monster, come
  out" loop.

Not actionable without a design call. Flagged.

## #5 — Hardcoded valley bounding box

The Ur valley `(93..96, 34..44)` boundary appears at:
- `battle-encounter.js:57` — encounter-zone routing
- `world-map-renderer.js` — visual choke marker

Both files mutate / read the same conceptual region. If the choke
moves (or the valley expands), two files have to change in lockstep.

Minor surface, deferred. Single source could live in
`data/world-map.js` if/when a second consumer appears.

## #6 — Spell-anim phase pipeline — clean

`cast-anim.js` exports the canonical timing constants:
- `CAST_PHASE_MS_THROW = { buildup, projectile, preImpactGap, impact }`
  for offensive (cross-faction) magic.
- `CAST_PHASE_MS_HEAL` for same-team friendly magic.
- `CAST_T_LUNGE`, `CAST_T_HEAL`, `CAST_T_RETURN`, `CAST_TOTAL_MS`,
  `CAST_T_THROW_RETURN`, `CAST_T_THROW_IMPACT_START` — heal-style
  phase markers.

All four consumers (`spell-cast.js`, `combatant-cast.js`,
`battle-ally.js`, `pvp.js`) import these. No local copies. The PVP
constants `PVP_MAGIC_CAST_MS` / `PVP_THROW_SFX_MS` (in `pvp.js`) are
derived from the canonical values with documented math — derivation
is fine; they're aliases, not duplicates.

Modularization audit + post-T5 cleanup (v1.7.207) already
consolidated the cast-IO bindings. Spell-anim pipeline is in good
shape.

## #7 — Chat command registry — clean

`chat.js:registerCommand(name, desc, handler, opts)` is the single
public command entry. All 17 commands route through it. Dev gating
via `opts.dev` flag. No parallel command-registration paths.

The `saveSlotsToDB()` calls inside cheat commands (`/level`, `/gil`,
`/give`, `/spell`, etc.) all use the canonical save path. No
inline persistence hacks.

## #8 — HUD fade — clean (where it matters)

- `TOPBOX_FADE_STEPS` / `_STEP_MS`: only in `transitions.js`. Single
  source. ✓
- `HUD_INFO_FADE_STEPS` / `_STEP_MS`: exported from `hud-state.js`,
  consumers import. ✓
- `BATTLE_TEXT_STEPS` / `_STEP_MS`: see #2 — needs dedup.

## Out of scope / further audit candidates

If you want even more sweep:
- **Multiplayer / network state** — server save/load, chat propagation,
  presence. Touched the surface; would need a deeper trace through
  `window.ff3Auth` and the server endpoints.
- **Job system / EXP / leveling** — stat scaling, JP tracking.
  Probably clean per the v1.7.139 stat migration.
- **Inventory / shop pricing / drop rates** — economy balance.
- **Map renderer / tile decoding** — large surface, lower bug risk.
