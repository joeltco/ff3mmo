# Job system / EXP / leveling audit (multiplayer-prep)

Started 2026-05-10. Sweep of the job system from the angle of
"will this be deterministic when remote-player state lands via
websocket?" — since the fake-player system is the multiplayer
seam (per memory `project_ff3mmo_fake_player_multiplayer.md`),
every stat path that handles fake-players also handles real
remote players once the websocket layer ships.

## TL;DR

| # | Item | Class | Status |
|---|------|-------|--------|
| 1 | `generateAllyStats` hardcodes `jobLevel: 1` regardless of player descriptor | multiplayer determinism bug | ✅ v1.7.218 |
| 2 | Fake-player path skips `getJobLevelStatBonus` — AGI/STR bonus diverges from local-player | multiplayer determinism bug | ✅ v1.7.218 |
| 3 | `JOB_SCALING` (`data/jobs.js`) vs `_JOB_STAT_WEIGHTS` (`data/players.js`) — two scaling tables | naming confusion | ⏸ doc-only — they're different things |
| 4 | `EXP / 4` divisor is NES legacy ("we have 1 player") — needs revisit for real multiplayer | multiplayer gameplay | ⏸ deferred — design call |
| 5 | `isMonkClass = jobIdx === 2 \|\| jobIdx === 13` magic-number check duplicated | minor | ⏸ deferred |
| 6 | `gainJobJP` uses inline `< 15` threshold + magic `5` flat rate | minor | ⏸ deferred |
| 7 | `JP_RATES` table is a 3rd job-tuning table separate from `JOB_SCALING` and `_JOB_STAT_WEIGHTS` | doc-only | ⏸ deferred |

## Three job-tuning tables (verified separate, not bugs)

| Table | Location | Drives | Shape |
|-------|----------|--------|-------|
| `_JOB_STAT_WEIGHTS` | `data/players.js:223` | character-level stat growth (1→99). Pure `computeJobStats(jobIdx, level)` reads it. | `{str, agi, vit, int, mnd, mp}` per job |
| `JOB_SCALING` | `data/jobs.js:76` | job-level stat BONUS on top (jobLv 1→99, `floor(jobLv * W / 20)` max ~5 bonus at jobLv 99) | `[str, agi, vit, int, mnd]` array per job |
| `JP_RATES` | `player-stats.js:251` | per-job JP gain at jobLv 15+ (jobLv 1-14 is flat 5 JP/action) | `{ jobIdx: rate }` |

Three tables, three different purposes — not a dedup target. But
adding a new job requires editing all three; consider a unified
job-tuning data file in the future.

## #1 — `jobLevel` hardcoded in `generateAllyStats`

`data/players.js:310`:
```js
const atk = calcAttackerAtk({
  rWpnAtk, lWpnAtk, isMonkClass, level: lv, str, jobLevel: 1,
});
```

And the returned object at line 327: `..., jobLevel: 1, ...`.

The `calcAttackerAtk` formula uses `jobLevel` for the Monk
unarmed bonus (`floor(jobLevel/4)`). A real BB/Monk player at
jobLv 50 has +12 attack from this term that their fake-player
twin lacks.

More broadly: the fake-player path completely ignores any
`jobLevels` data that might exist on the player descriptor. When
the websocket layer ships, remote-player jobLevels need to flow
through this helper or the local + remote views of the same
character will desync.

**Fix shape (v1.7.218):**

- New pure helper `jobLevelStatBonus(jobIdx, jobLv)` in
  `data/jobs.js` — same math as `getJobLevelStatBonus` minus the
  `ps` read. Imported by `data/players.js:generateAllyStats` and
  by `player-stats.js:getJobLevelStatBonus` (which becomes a thin
  wrapper).
- `generateAllyStats` accepts `player.jobLevel` (single number,
  current job's level) OR `player.jobLevels[jobIdx].level`
  (full job-progression object). Falls back to `1` if neither
  is provided (current PLAYER_POOL entries have no JP data so
  behavior is unchanged for static NPCs).
- Applies the bonus to STR / AGI / VIT / INT / MND before
  computing ATK / DEF / hit-count.
- Returns the actual `jobLevel` used so downstream code can read it.

## #4 — EXP/4 divisor for multiplayer

`player-stats.js:208-210`:
```js
export function grantExp(amount) {
  // NES splits EXP across 4 party members; we have 1 player, so divide by 4
  ps.stats.exp += Math.max(1, Math.floor(amount / 4));
```

The NES heritage is "EXP from a battle splits among 4 living
party members". Our v0 has 1 controllable player + AI roster
allies, so dividing by 4 is a tuning hack.

For multiplayer: if N real players are in a party, should EXP
split N ways? Match NES exactly (always /4)? Multiply by some
factor? Open design question. Flagged for the websocket-layer
ticket.

## #5 — `isMonkClass` magic indexes

`data/players.js:308`:
```js
const isMonkClass = player.jobIdx === 2 || player.jobIdx === 13; // Monk / BlackBelt
```

Same check appears in `input-handler.js` and `battle-sim.js`. Could
be a job-data property `JOBS[i].isMonkClass = true` instead of magic
indexes. Minor — defer.

## #6 — `gainJobJP` thresholds

`player-stats.js:276`:
```js
const rate = jl.level < 15 ? 5 : (JP_RATES[ps.jobIdx] || 4);
```

The `15` is the jobLv threshold for the per-job rate table. The
`5` and `4` are flat rates. Could be `JP_RATE_FLAT_LV = 14`,
`JP_RATE_FLAT = 5`, `JP_RATE_FALLBACK = 4`. Minor — defer.

## Multiplayer-readiness summary

After v1.7.218, the fake-player path now:
- Correctly applies job-level stat bonuses (AGI for hit-count, STR
  for ATK, etc.) when the player descriptor includes JP data.
- Passes `jobLevel` through to `calcAttackerAtk` (Monk unarmed bonus
  scales properly).
- Returns the resolved jobLevel for downstream consumption.

Schema the websocket layer will need to send for a remote player to
be deterministic:
- `name`, `palIdx`, `jobIdx`, `level` (char level) — already used
- `weaponR`, `weaponL`, `armorId`, `helmId`, `shieldId` — already used
- `knownSpells` — already used
- **`jobLevel`** (new, single number for current job) OR **`jobLevels`**
  (full `{jobIdx: {level, jp}}` map) — newly consumed v1.7.218
- `hp`, `mp` — current health (need to add to current path; today
  ally HP is derived from `computeJobStats(jobIdx, lv).maxHP` at
  spawn time)
- `status` — battle status mask + poison tick
- `buffs` — Haste/Protect/Reflect (deferred per buffs.js v0 scope)
- `cp`, `gil`, `inventory` — economy state (defer until needed)
