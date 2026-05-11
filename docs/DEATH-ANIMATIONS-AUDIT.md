# Death + dissolve animations audit

Started 2026-05-10. Sweep of every place a combatant transitions from
alive to dead — the trigger conditions, the dissolve / fade animation,
the SFX, the cleanup. Six combatant types die in this game: player,
ally, encounter monster, boss, PVP main opponent, PVP enemy ally.

## TL;DR

| # | Item | Class | Status |
|---|------|-------|--------|
| 1 | `MONSTER_DEATH_MS = 250` duplicated (was 4×, now 1× from `battle-state`) | dedup | ✅ v1.7.212 |
| 2 | Player death uses magic numbers; now `PLAYER_DEATH_HOLD_MS` / `_FADE_MS` / `_TOTAL_MS` exported from `hud-state` | consistency | ✅ v1.7.212 |
| 3 | Player death is alpha-fade only; ally has 3-phase 1100ms. No player kneel-slide / pose-fade. | feature parity | ⏸ needs design decision |
| 4 | `_buildPVPDyingMap` lazy-reads `pvpPlayerTargetIdx`; latent assumption baked into "multi-cell" map shape | latent bug | ⏸ open |
| 5 | Multi-target player spell on PVP can leave kills un-dissolved | gameplay bug | ⏸ open |
| 6 | `playerDeathTimer` cleanup — verify battle-end → respawn → battle-start path | minor | ⏸ verify |
| 7 | Ally `deathTimer` never cleared on revive (no revive in v1) | latent | deferred |

## Death timing summary

| Type | State machine | Duration | Visual |
|------|---------------|----------|--------|
| **Encounter monster** | `pre-monster-death` (200ms hold) → `monster-death` (250ms) | 450ms | Bayer-4×4 dither dissolve, 16-frame `monsterDeathFrames` |
| **Boss** | `boss-dissolve` (multi-block stagger) | `BOSS_BLOCKS × BOSS_DISSOLVE_STEPS × BOSS_DISSOLVE_FRAME_MS` | Bayer block-by-block reveal, SFX every 4th block |
| **PVP main opp** | `pvp-dissolve` (250ms) — no pre-hold | 250ms | Same dither dissolve as encounter monster |
| **PVP enemy ally** | `pvp-dissolve` (250ms) — no pre-hold | 250ms | Same dither dissolve |
| **Player** | `playerDeathTimer` (independent of `battleState`) | 800ms | Alpha-fade only (no kneel-slide, no death pose) |
| **Ally** | `ally.deathTimer` (independent of `battleState`) | 1100ms (500+300+300) | Kneel-slide (500ms) → text-fade (300ms) → death-pose-fade (300ms) |

## #1 — `MONSTER_DEATH_MS = 250` duplicated 4×

Single source of truth was added at `battle-state.js:99` (exported). But:
- `battle-drawing.js:61` — local copy
- `battle-draw-encounter.js:34` — local copy
- `pvp-drawing.js:39` — local copy

If anyone bumps the value in one file, the others silently drift. Easy
fix: import from `battle-state.js`, drop the locals.

## #2 — Player death uses magic numbers

`hud-drawing.js:282-296`:
```js
if (playerDeathTimer < 500) {
} else if (playerDeathTimer < 800) {
  const deathAlpha = 1 - (playerDeathTimer - 500) / 300;
  ...
}
```

Compare with `battle-draw-allies.js:43-46`:
```js
const DEATH_SLIDE_MS    = 500;
const DEATH_TXTFADE_MS  = 300;
const DEATH_POSEFADE_MS = 300;
const DEATH_TOTAL_MS    = DEATH_SLIDE_MS + DEATH_TXTFADE_MS + DEATH_POSEFADE_MS;
```

Player has the same `500 / 300` pattern but inline. Named constants
let you reason about the timing at a glance and keep player/ally in
sync if either side is ever tweaked.

## #3 — Player death is alpha-fade only; ally death has 3 phases

Ally death:
- **Phase 1 (500ms):** kneel portrait slides down 16px, clipped to portrait box.
- **Phase 2 (300ms):** name/HP text fades to alpha 0.
- **Phase 3 (300ms):** death pose (24×16 prone sprite) fades in to alpha 1.

Player death:
- **0-500ms:** nothing happens (player still rendered normally, name/HP stays).
- **500-800ms:** info-panel alpha fades from 1 to 0.
- **≥ 800ms:** info panel hidden. Player portrait? Not separately handled.

The player has no kneel-slide phase, no death-pose anim. The portrait
just keeps rendering whatever pose it was in when HP hit 0 (likely
kneel pose since `(near-fatal || hasActiveStatus) && bp.kneel` would
have been triggered). Compared to allies, the player death is
visually thin.

**Open question:** is this by design (player is always center-stage
and shouldn't dissolve dramatically) or just an unfilled gap? The
ally death animation infrastructure (kneel-slide + pose-fade) could
be wired to the player by adding `bp.death` body sprite and routing
`hudSt.playerDeathTimer` through the 3-phase shape.

## #4 — `_buildPVPDyingMap` lazy-reads `pvpPlayerTargetIdx`

`pvp.js:231-235`:
```js
function _buildPVPDyingMap() {
  const dyingIdx = pvpSt.pvpPlayerTargetIdx < 0 ? 0 : pvpSt.pvpPlayerTargetIdx + 1;
  pvpSt.pvpDyingMap = new Map([[dyingIdx, 0]]);
}
```

Called from `_updatePVPDissolve` when the map is empty. Two callers
transition to `pvp-dissolve` without populating `pvpDyingMap`:

- `battle-update.js:419` — player spell/attack kills PVP enemy. Lazy
  build reads `pvpPlayerTargetIdx` → correct (player's current
  target IS the one that died here).
- `battle-ally.js:50` — ally killed `getEnemyHP() <= 0`. Same — only
  triggers when the player's current target's HP hit 0, so the lazy
  read is correct.

So today this is **latent**, not a live bug — the dying cell always
happens to be the player's current target. But it's a single-target
assumption baked into a "dying cells map" that has no enforcement of
single-target. If a future ally-AoE or multi-cell spell starts
killing cells outside `pvpPlayerTargetIdx`, the wrong cell will
dissolve.

**Fix shape:** every transition to `pvp-dissolve` should set
`pvpDyingMap` with the actual killed indices, the same way
`battle-ally.js:375` already does for ally magic. Then drop the lazy
`_buildPVPDyingMap` fallback.

## #5 — Multi-target spell on PVP can leave kills un-dissolved

`spell-cast.js:692-710` builds `killedEnemyIndices` ONLY for `t.type
=== 'enemy'` (encounter monsters):
```js
for (const t of _targets) {
  if (t.type === 'enemy' && battleSt.encounterMonsters[t.index]?.hp <= 0) {
    killedEnemyIndices.push(t.index);
  }
}
```

PVP multi-target deaths are not collected. Falls through to the
single-target `getEnemyHP() <= 0` check (line 712) which only
fires for the player's current target.

**Consequence:** if a multi-target spell hits the PVP main opp +
enemy allies and kills 2 of them, but the player's current target is
the survivor — none of the dying cells get a dissolve anim. They
just sit at 0 HP, no SFX, no fade. The next turn discovers them as
dead and proceeds, but the visual is "they just disappear."

**Fix shape:** extend the loop to collect dying PVP cells:
```js
} else if (t.type === 'pvp-enemy') {
  const tgt = t.index === 0 ? pvpSt.pvpOpponentStats : pvpSt.pvpEnemyAllies[t.index - 1];
  if (tgt && tgt.hp <= 0) killedPVPIndices.push(t.index);
}
```
Then set `pvpDyingMap` from `killedPVPIndices` and transition once.

## #6 — `playerDeathTimer` cleanup

Cleared at:
- `battle-update.js:85` — `resetBattleVars()` at battle start
- `battle-update.js:709` — end of victory sequence

**Open question:** what if the player dies, battle ends via teammate
kill, then re-enters battle? Does `resetBattleVars` run before the
new battle starts? If yes, fine. If not, the death timer could carry
forward and the player would render mid-fade at battle 2 start.

Need to trace the battle-end → respawn → battle-start flow to
confirm. Likely fine but worth verifying.

## #7 — DEFERRED: ally `deathTimer` never cleared on revive

Allies have `ally.deathTimer = 0` set when HP hits 0 (battle-ally.js
+ pvp.js). No revive mechanic exists in v1, so the timer just runs
to `DEATH_TOTAL_MS` and the ally stays in the post-anim state.

If a revive item / spell ships in the future, the revive code MUST
also set `ally.deathTimer = null` (or remove the ally + re-add as
fresh). Worth tracking.
