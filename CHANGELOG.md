# Changelog

All notable changes to this project are documented here.

## 1.7.53 — 2026-05-06

### Revert v1.7.49 spell-anim rewrite — restore working Cure + Poisona animations

The v1.7.49 "per-spell animation registry" rewrite was wrong. It deleted the working white-magic cast animation (flame buildup + rotating stars around the caster) and replaced it with a static overlay built from a misinterpreted REC OAM capture. Cure (blue palette) and Poisona (orange palette) both lost their cast animation; Poisona also lost its target spell-effect. Reverted commit 0841b98 wholesale: `cure-anim.js` is back, `spell-anim.js` is gone, and call sites in `battle-drawing.js`, `battle-sprite-cache.js`, `pvp.js`, `spell-cast.js` are restored to the 1.7.48 shape. Cast + spell animations work again for both spells.

## 1.7.52 — 2026-05-06

### Hotfix: restore OK_* sprite imports in sprite-init.js (game wouldn't load)

v1.7.50's "trim corresponding imports" step deleted the `OK_*` import block from `sprite-init.js`, but the `_FP_*` module-scope constants at lines 141-163 (`_FP_KNEEL = OK_KNEEL`, `_FP_KNIFE_R = OK_R_BACK_SWING`, the OK_LEG_* aliases, etc.) still reference them at module load. Result: a `ReferenceError: OK_R_BACK_SWING is not defined` at line 141 fired before the page's `<script type="module">` block could attach the password-gate listener — so submitting the dev password did nothing. Re-imported the OK idle / victory / kneel / swing / leg constants used by the player-portrait builders. WR_* / MO_* stay deleted (those jobs have already moved to the bundle path).

## 1.7.51 — 2026-05-06

### Poison damage moves to end-of-round, no shake, no hit-pose

Poison damage no longer ticks at each combatant's turn-start. Instead, after every round (queue empty, before the menu reopens), `_applyEndOfRoundPoison` walks player + battle allies + monsters + PVP opponent + PVP enemy allies once, applies `floor(maxHP/16)` to anyone with the POISON flag, and pops their damage numbers at the same moment. Player + allies clamp to HP 1 (NES never lets poison kill); enemies/monsters can still die from the tick.

New `'poison-end-tick'` battle state holds for 700ms (long enough for the 550ms damage-num bounce to land) then transitions straight to `'menu-open'`. Distinct from the existing `'poison-tick'` state, which is still used by the confused-self-attack hold and keeps its shake + hit-pose. The end-of-round state is intentionally absent from the shake conditions in `hud-drawing.js` and `battle-drawing.js` and from the `isHitPose` predicate — no portrait shake, no damage pose, just damage numbers. It IS in the broad in-combat classifiers so encounter UI keeps rendering during the hold.

If multiple party members are poisoned, all their damage numbers display simultaneously: player gets `setPlayerDamageNum`, each ally gets `getAllyDamageNums()[i]`, the enemy slot is shared (single-slot constraint, last write wins for multi-monster poison — acceptable since the focus is the player team).

## 1.7.50 — 2026-05-06

### Drop OK/WR/MO_DEATH constants and the dead legacy sprite path

The 1.7.47 ROM-stride derivation made the hardcoded `OK_DEATH` / `WR_DEATH` / `MO_DEATH` PPU-capture constants redundant — every job's death tiles, including 0/1/2, live at `jobBase + 0x240` in the per-job battle CHR slot. Extracted `_deathTilesForJob(romData, jobIdx)` in `combatant-sprites.js`; all four bundles (OK / WR / MO / generic) now use it. The byte-for-byte constants in `data/job-sprites.js`, `data/warrior-sprites.js`, `data/monk-sprites.js` are gone.

Also deleted the 295-line legacy ally-sprite branch in `sprite-init.js` (`_initFakePosePortraits`, `_buildIdleFullBodies`, `_buildKnifeFullBodies`, `_buildHitFullBodies`, `_buildDeathPoseCanvases`, `_buildWarriorFullBodies`, `_initWarriorPosePortraits`, `_initMonkPosePortraits`, `_buildMonkFullBodies`, `_initGenericJobPosePortraits`, `_buildGenericJobFullBodies`). All 22 jobs went through `_buildFakePlayerSet` since 1.7.42 — the old per-job if/else was unreachable code preserved only as historical reference. Trimmed the corresponding imports.

POSES debug tab loses the WR DEATH / MO DEATH visualization cards; the death tiles are now ROM-only data, the tab can re-add a ROM-read card later if needed.

## 1.7.49 — 2026-05-06

### Per-spell animation registry (fixes: Poisona used Cure's tile bytes with palette swap)

Two REC OAM captures (Cure @ frame 2877, Poisona @ frame 827) confirmed the 2026-05-05 "shared tile bytes, palette differs" assumption was wrong. Cure's `$49`/`$4A` (cross-star + dot) and Poisona's `$49`–`$50` (8-tile wing pattern) are entirely different sprites — and the "flame buildup f0-47 size 1→4" model in cure-anim.js was fabricated. Real Cure has no flame at all; it's just stars cycling. Real Poisona is a different shape entirely.

Replaced `cure-anim.js` with `spell-anim.js`: per-spell registry keyed by spell ID. Each entry owns its tile bytes, palette, and phase render functions. Render sites call `drawSpellCasterEffect(ctx, spellId, ms, x, y)` / `drawSpellTargetEffect(ctx, spellId, ms, x, y)` — they no longer know about flame vs stars vs wings vs curves. Adding a future spell anim is one new entry in the registry; no render-site changes.

- Cure (0x34): 4 sprites cycling HFLIP/VFLIP across `[0,5]/[8,5]/[0,13]/[8,13]` for 1017ms, then `$66` sparkle on target.
- Poisona (0x35): 8-tile wing pattern alternating phase A (`$49`–`$4C`) and phase B (`$4D`–`$50`), then `$07`/`$08` curve sprite on target.
- Removed 5-frame flame buildup, rotating-ring star math, and `WHITE_MAGIC_PAL` palette-swap shortcut — none of those exist in the real animations.

Touched: `src/spell-anim.js` (new), `src/battle-drawing.js`, `src/pvp.js`, `src/spell-cast.js`, `src/battle-sprite-cache.js`. `src/cure-anim.js` deleted.

=======
>>>>>>> parent of 0841b98 (v1.7.49 — per-spell animation registry; rip out cure-anim shared-palette hack, real captured tiles for Cure + Poisona)
## 1.7.48 — 2026-05-06

### Slash-flash hit-gate is now single-source (fixes: misses showed slash on user portrait in PVP)

PVP-enemy slash overlay drawn on the user's own portrait at `battle-drawing.js:425` had **no hit/miss gate** — every swing flashed a slash, even on misses and shield-blocks. The portrait-blink and hit-pose checks 50 lines below correctly guarded with `pvpPendingAttack && !miss && !shieldBlock`, but the slash flash didn't.

Root cause was structural: the gate was caller-driven, scattered across 6 different `drawSlashOverlay` call sites, and the `slash-effects.js` comment block told callers "you MUST gate the flash". One missed wrap and the whole subsystem leaks visuals.

Moved the gate INSIDE `drawSlashOverlay`. New signature folds `mirror` / `weaponId` / `hit` into an opts object, and `hit !== undefined && !shouldDrawSlash(hit)` short-circuits the draw. `shouldDrawSlash` now also rejects shield-block (monster hits have no `shieldBlock` field, so existing encounter paths unaffected). All 5 call sites updated to the opts shape and pass the relevant hit object (`pvpPendingAttack` / `allyHitResult`).

Result: any future `drawSlashOverlay` call automatically inherits the gate. The "callers MUST remember to wrap with shouldDrawSlash" footgun is gone.

## 1.7.47 — 2026-05-06

### Real death poses for all 22 jobs (was: mirrored idle)

Defeated allies in the roster panel were showing a *mirrored idle pose* instead of a death sprite — and not just the orientation was wrong, there literally was no death pose data for any job except 0/1/2. `_genericBundle` in `combatant-sprites.js:229` hardcoded `death: null`, so 19 jobs (White Mage, Black Mage, etc.) hit the `bodies.idle` fallback at `sprite-init.js:1021` — which uses `buildOpponentBodyCanvases` output (pre-h-flipped for opponent rendering), drawn directly without counter-flip at `battle-drawing.js:1326`.

Reverse-mapping the captured `OK_DEATH` / `WR_DEATH` / `MO_DEATH` constants back to ROM offsets revealed they all live at `BATTLE_SPRITE_ROM + jobIdx * BATTLE_JOB_SIZE + 0x240` — tile indices 36-41 within each job's 42-tile per-job slot. Verified byte-for-byte against the PPU-captured constants for jobs 0/1/2; the same stride applies to all 22 jobs since the per-job ROM block is uniform.

`_genericBundle` now reads the 6 death tiles (3 cols × 2 rows, 24×16 prone) directly from ROM, eliminating the need for per-job PPU capture. Roster ally death pose now renders the canonical lying-down sprite for every job.

## 1.7.46 — 2026-05-06

### Freeze watchdog + global error handlers + battle context in error reports

The 1.7.42 freeze investigation has been blind because the existing client-error reporting only wrapped the *render* path (line 76 + 103 of `game-loop.js`) and didn't include any state context. Errors in the update path were caught at the outer game-loop try/catch but only `console.error`'d locally — never POSTed to the server. State-machine freezes that don't throw exceptions (an orphan state with no advance handler) had no detection at all.

Three additions to make the next freeze self-diagnose:

1. **`_battleCtx()`** snapshot included in every `/api/client-error` POST: `battleState`, `battleTimer`, `turnQueue.length`, `pvpCurrentEnemyAllyIdx`, `pvpPreflashDecided`, `psHp`, `psHasStatus`, `battleAllies.length`, `pvpEnemyAllies.length`. Server pretty-prints it on the same log line as the message.

2. **Freeze watchdog** ticks once per frame after the game loop. If `battleState` stays in a *non-idle* state (excludes `menu-open`, `target-select`, `item-*`, `msg-wait`, etc.) for >5s without changing, fires one `[FREEZE WATCHDOG]` report identifying the stuck state. One report per stuck spell — won't spam.

3. **Global `window.error` + `unhandledrejection` handlers** installed in `startGameLoop`. Catches anything that escapes the per-frame try/catch, including async failures (fetch / setTimeout) that were previously silent.

The outer game-loop catch now also POSTs via `_reportError` (was console-only). Server-side, `console.error` in `api.js:74` includes `body.ctx` JSON-stringified so `pm2 logs` shows the full state at error time.

`src/game-loop.js`, `api.js`.

### Postscript — actual root cause of the user-reported freeze

Once the diagnostic infra was deployed, `pm2 logs` immediately showed `[CLIENT ERROR] _s is not defined` at `drawBattleMessageStrip@battle-drawing.js:1373:60` firing every frame. Investigation revealed the production server was stuck at **1.7.34** — none of the 1.7.41–1.7.46 commits had reached production because `git push` alone doesn't trigger the server-side `git pull` (that requires `./deploy.sh` or the equivalent `ssh root@... 'cd /var/www/ff3mmo && git pull && pm2 restart server --update-env'`).

The `_s` reference was an artifact of the pre-1.7.34 "legacy `_s` bag" pattern that was retired but left an orphan reference in 1.7.34's `drawBattleMessageStrip`. The 1.7.42 magic/item AI was *never* the cause of the freeze — it never ran in production. Pulled 1.7.46 to the server; freeze gone.

Memory updated (`feedback_ff3mmo_deploys.md`) so future "deploy" instructions trigger an actual `./deploy.sh` invocation, not just `git push`.

## 1.7.45 — 2026-05-06

### Hotfix — re-disable 1.7.42 enemy-magic / item AI hooks (1.7.44 still freezing)

1.7.44's poison-tick handler fix did not unblock the user. Reverting the AI call-sites again (matching 1.7.43) while keeping the poison-tick fix in place. Confirms whether the freeze is in the new magic/item AI vs elsewhere.

- `_processEnemyFlash` reverted to main-opp-only defend / self-heal-50 / sword-throw decision tree.
- `_tryAllyItem` invocation removed from WM AI chain.
- `updatePoisonTick` still wired into the PVP dispatcher (1.7.44 fix preserved).

`src/pvp.js`, `src/battle-turn.js`.

## 1.7.44 — 2026-05-06

### Fix: poison-tick handler missing from PVP dispatcher (real cause of 1.7.42 softlock)

Root cause of the post-1.7.42 softlock found and fixed. The bug was **not** in the new magic AI — it was a pre-existing PVP dispatcher gap exposed by 1.7.41's `status: createStatusState()` addition to `generateAllyStats`.

**The bug:** `_updatePoisonTick` (battle-update.js:789) only existed in the non-PVP dispatcher chain at line 804. The PVP dispatcher (`updatePVPBattle` in pvp.js) never wired it in. When a poisoned actor's turn started, `battle-turn.js` set `battleSt.battleState = 'poison-tick'` to display the poison damage tick, but in PVP nothing advanced that state. Softlock — exactly matching the reported symptoms (state stuck mid-turn, menu panel renders because `poison-tick` is in `isMenu`, but cursor doesn't draw because state isn't `menu-open`).

**Why it surfaced now:** Before 1.7.41, roster allies had no `status` field, so `tryInflictStatus(ally.status, …)` calls in `battle-enemy.js` silently no-op'd — allies couldn't actually be poisoned. 1.7.41 fixed that, allowing the latent PVP poison-tick gap to deadlock the turn loop.

**Fix:** Exported `updatePoisonTick` from `battle-update.js` and added it to the front of the PVP dispatcher chain.

**Re-enabled the 1.7.42 systems** that were unfairly disabled in the 1.7.43 hotfix:
- PVP enemy magic AI (Cure / Poisona on each other) — `_tryPVPEnemyPoisona` + `_tryPVPEnemyCure` back in `_processEnemyFlash`
- PVP enemy item AI (Cure Potion / Antidote on any teammate) — `_tryPVPEnemyItem` back in `_processEnemyFlash`
- Roster ally item AI — `_tryAllyItem` back in the WM AI chain

`src/battle-update.js`, `src/pvp.js`, `src/battle-turn.js`.

## 1.7.43 — 2026-05-06

### Hotfix — disable 1.7.42 enemy-magic / item AI hooks (PVP softlock)

PVP softlock reproduced live after opponent turn (no cursor on battle menu). Reverted the AI **call-sites** for the new systems while keeping the underlying state machines + render hooks in place so we can re-enable selectively after diagnosis.

- `_processEnemyFlash` reverted to the original main-opp-only defend / self-heal-50 / sword-throw decision tree. PVP enemy magic + the generalized `_tryPVPEnemyItem` are no longer invoked.
- `_tryAllyItem` invocation in `battle-turn.js` removed from the WM AI chain. Roster ally Cure / Poisona spell AI still fires (1.7.41 behavior).

The 1.7.42 implementations (`_tryPVPEnemyCure`, `_tryPVPEnemyPoisona`, `_tryPVPEnemyItem`, `_processPVPEnemyMagic`, `_tryAllyItem`, `allyMagicItemMode`) remain in the codebase but are unreachable. Heal-num cell-idx targeting + render gates also remain — they are no-ops without the AI calling them.

`src/pvp.js`, `src/battle-turn.js`.

## 1.7.42 — 2026-05-06

### PVP enemy support magic + items + roster ally items

PVP enemies (main opp + their allies) now cast Cure / Poisona on each other and use Cure Potions / Antidotes on each other. Roster allies pick up the same item AI.

**PVP enemy magic** — `_tryPVPEnemyCure` / `_tryPVPEnemyPoisona` in `pvp.js` mirror the `_tryAllyCure` / `_tryAllyPoisona` AI from `battle-turn.js`, scoped to the enemy team. New states `pvp-enemy-magic-cast` (600 ms) → `pvp-enemy-magic-hit` (1000 ms, effect at 400 ms) mirror the ally-magic state machine; `_processPVPEnemyMagic` is wired into `updateBattleEnemyTurn`.

**Mirrored cast animation** — `_drawPVPEnemyCell` now recognizes the caster cell for the new states, swaps the body to victory pose, and renders the flame + 8-star ring via the same `getCureAnimAssets` / `getCureFlameFrameIdx` pipeline. Flame draws at `sprX + 16, sprY + 5` — the visual mirror of the ally side's `ppx - 16, ppy + 5`. Sparkle on the target cell during hit phase reuses `bsc.cureSparkleFrames`.

**PVP enemy items** — generalized the old main-opp self-only potion roll into `_tryPVPEnemyItem`, callable by any enemy on any teammate. Antidote (any poisoned teammate) takes priority over Cure Potion (lowest-HP teammate < 50%). Reuses the existing `pvp-opp-potion` state but with new `pvpItemCasterCellIdx` / `pvpItemTargetCellIdx` fields driving caster pose + target sparkle. The 25% trigger rate matches the original main-opp behavior.

**Roster ally items** — `_tryAllyItem` in `battle-turn.js` adds Cure Potion / Antidote to the WM AI chain (Cure → Poisona → Item). Reuses the `ally-magic-cast` / `ally-magic-hit` pipeline with a new `battleSt.allyMagicItemMode` flag that suppresses the cast flame visual; caster pose + target sparkle still render. SFX is `CURE` instead of `MAGIC_CAST`.

**Heal-num targeting** — `_drawEnemyHealNum` PVP branch now honors `getEnemyHealNum().index` so heal numbers float over the actual targeted cell (was previously always cell 0).

`src/pvp.js` (AI + state machine + render), `src/battle-turn.js` (ally item AI), `src/battle-ally.js` (item-mode reset), `src/battle-state.js` (allyMagicItemMode field), `src/battle-drawing.js` (cast flame gate + heal-num index).

## 1.7.41 — 2026-05-06

### Roster allies can now actually be poisoned (and Poisona AI can target them)

`generateAllyStats` in `src/data/players.js` was not assigning a `status` object, so every roster ally (and PVP opponent + their allies) had `status === undefined`. Two consequences:

1. Every `tryInflictStatus(ally.status, …)` call in `battle-enemy.js` silently no-op'd — enemies could never poison roster allies.
2. The WM `_tryAllyPoisona` AI in `battle-turn.js` could only ever detect a poisoned *player*, since the `other.status` guard short-circuited every ally check. Ally-on-ally Poisona never fired in practice.

Fixed by importing `createStatusState` from `status-effects.js` and adding `status: createStatusState()` to the `generateAllyStats` return object. Now allies can be poisoned, the per-ally turn-start poison-tick path in `battle-turn.js` (already wired) actually runs, and WM allies will cast Poisona on poisoned teammates.

`src/data/players.js`.

## 1.7.40 — 2026-05-06

### Unified swing-pose dwell across player / ally / PVP opponent

Removed the three independent swing-hold constants — `ALLY_SLASH_MS` (battle-ally.js), `ENEMY_SLASH_TOTAL_MS` (pvp.js), and the per-weapon `getSlashHoldMs(weaponId)` body-hold (battle-update.js) — and replaced them with a single `SWING_HOLD_MS = 200ms` constant exported from `slash-effects.js`. Every melee state machine now reads from one source.

Also dropped the `!drawSlash || …` short-circuit from the player AND PVP-opponent slash phases. Same root cause as the ally bug fixed in 1.7.35: missed attacks were advancing the slash state machine on frame 1 because `shouldDrawSlash` returned false. Now hit and miss share the same body-pose dwell on every path, and only the slash *flash overlay* is suppressed on miss (correctly, via `if (drawSlash)` inside the draw blocks). `shouldDrawSlash` doc updated to flag the invariant: callers must NOT short-circuit the state machine on miss.

`getSlashHoldMs` still exists, but is now scoped to the per-frame slash-flash overlay timing only — not the body-pose hold.

`src/slash-effects.js` (added `SWING_HOLD_MS`, updated `shouldDrawSlash` doc), `src/battle-update.js` (player), `src/battle-ally.js` (ally), `src/pvp.js` (PVP opponent).

## 1.7.39 — 2026-05-06

### Ally swing duration unified across hit/miss

Removed the hit/miss split from 1.7.38. Both now use `ALLY_SLASH_MS = 200ms` for the slash phase so the strike rhythm is identical regardless of outcome. The slash-flash overlay still only draws on hit, but the body+weapon hold is consistent.

`src/battle-ally.js` only.

## 1.7.38 — 2026-05-06

### Ally miss-swing hold bumped to 200ms

1.7.35 fixed the early-advance bug on miss but kept the 90ms slash hold for both hit and miss. Hits stayed readable because the white slash-flash overlay draws the eye to the strike. Misses have no flash, so 90ms (5 frames) of body + swung weapon canvas alone reads as a blink — the user reported "still not seeing" the fwd staff on miss after reloading. Split the hold: hits keep 90ms (flash carries the visual weight), misses now hold 200ms (12 frames) so the swung-staff frame reads clearly without the flash.

`src/battle-ally.js` only.

## 1.7.37 — 2026-05-06

### WM heal threshold restored to 60%

The 1.7.34 drop to 40% was a misdiagnosis — WMs *appearing* to disappear on certain turns was actually the missed-attack swing-blink bug fixed in 1.7.35. Now that swings render at full duration regardless of hit/miss, restored the canonical 60% heal threshold so WMs heal preemptively at meaningful HP loss rather than waiting for someone to be near death.

`src/battle-turn.js` only.

## 1.7.36 — 2026-05-06

### WM roster allies cast Poisona on poisoned teammates

White Mage roster allies now scan player + self + other allies for the POISON status flag and cast Poisona on the first match. Priority order: player → self → other allies. Cure (HP heal) still gets first dibs on the turn — if anyone is below 40% HP, that takes precedence; otherwise we look for poison to clean. The existing `ally-magic-cast → ally-magic-hit` pipeline handles the visuals (flame+stars on caster portrait already palette-dispatch via `getCureAnimAssets(spell)`, so Poisona's magenta SP3 shows correctly). On effect application the apply function now dispatches on `allyMagicSpellId`: 0x35 strips POISON via `removeStatus`, 0x34 keeps the existing HP heal path. Caster must have 0x35 in `knownSpells`.

`src/battle-turn.js` (added `_tryAllyPoisona`, wired after `_tryAllyCure`), `src/battle-ally.js` (renamed `_applyAllyCureEffect` → `_applyAllyMagicEffect`, added Poisona branch).

## 1.7.35 — 2026-05-06

### Ally swing pose holds full duration on miss

The actual culprit for "WM staff swing looks fucked up on certain turns": on a missed attack `shouldDrawSlash(hit)` returned false, which short-circuited the `ally-slash` state machine and advanced it on the very next frame. Result: the forward-swung staff canvas was visible for ~16ms (1 frame at 60fps) instead of the full 90ms, reading as a broken/blink swing. Fixed by holding `ally-slash` for the full `ALLY_SLASH_MS` regardless of hit/miss — the slash *overlay* is still correctly suppressed on miss via `drawSlash`, only the body pose hold is preserved. Hit and miss now read at identical pace.

`src/battle-ally.js` only.

## 1.7.34 — 2026-05-06

### WM heal threshold 60% → 40%

The 60% threshold meant WM allies cast Cure on most turns once anyone took a hit, which visually read as "staff disappearing on certain turns." Dropped to 40% so WMs swing the staff way more often — they only heal when someone is genuinely low (memo to self: 40% HP is the canonical NES FF3 "ouch" threshold for AI heal triggers).

`src/battle-turn.js` only.

## 1.7.33 — 2026-05-06

### Revert: staff overlay during cast pose

1.7.32 added a staff overlay during magic-cast pose for player and ally — that was wrong. NES FF3 white-magic cast doesn't show the weapon; the body is the canonical victory pose with empty hands. Reverted.

`src/battle-drawing.js` only.

## 1.7.32 — 2026-05-06

### Staff visible during cast pose — player and ally

WMs hold their staff in their hand canonically; FF3 NES victory-pose body tiles (which our magic-cast pose reuses) don't include the weapon graphics, so during cast the staff visually disappeared. Now we overlay the "raised" weapon canvas (R-back position, dx=8, dy=-7 from the body) on top of the cast-pose body for both:

- Player path (`_drawPortraitOverlays`) when `battleState === 'magic-cast'` or `'magic-hit'`. Gated on `isWeapon(ps.weaponR)` so unarmed/rod cases skip cleanly.
- Ally path (`_drawAllyPortrait`) when `isAllyCastingMagic && isWeapon(ally.weaponId)`. Same R-back canvas, ally portrait position.

Item-use (Potion etc.) intentionally skips this overlay since potions don't involve a weapon. The raised canvas position matches the back-swing offset, so visually the staff reads as held overhead during the cast.

`src/battle-drawing.js` only.

## 1.7.31 — 2026-05-06

### WM ally cast animation — flame + stars on the caster portrait

1.7.27 shipped the WM ally heal AI but explicitly deferred the magic-circle visuals: "Ally caster magic-circle (the flame + 8-star ring) is **not** rendered yet — that requires per-ally portrait positioning math which needs its own pass." This is that pass.

`_drawAllyCastAnim` runs after `_flushAllyWeaponDraws` in `drawBattleAllies`, deliberately OUTSIDE the right-panel clip so the flame can extend left of the ally portrait into the map area (matching the player-cast layout where the flame at `px-16` reaches into the enemy side). Renders during `ally-magic-cast` and `ally-magic-hit`:

- 8-star ring rotates around the caster portrait at radius 15, CW at the OAM-canonical 1.2 s/turn rate. Stars drawn during `ally-magic-cast` only (matches player's `shouldDrawStars` gate ending at `CURE_T_CAST`).
- Flame pulses 4 sizes during the 600 ms cast windup, then brackets/release at the end, drawn 16 px left of the portrait. Hidden during `ally-magic-hit`.
- Spell palette picked via `getCureAnimAssets(spell)` from `battleSt.allyMagicSpellId` so per-school palettes (Cure blue / Poisona magenta) work.

Caster pose was already wired to victory in 1.7.27. Heal sparkle on target was already wired for both player-target and ally-target heals. The missing piece was the caster-side flame + stars; now in.

`src/battle-drawing.js` only.

## 1.7.30 — 2026-05-06

### Fix: starting a new game cloned the previously-played slot

Reproduction: play any slot → return to title via pause-menu → create a new save in an empty slot. The new game began with the previous slot's level, inventory, gil, equipment, knownSpells, lastTown, and world position — fully cloned.

Root cause: `returnToTitle()` (`src/main.js`) didn't clear `ps`, so the previous slot's data stayed live in memory. Then in title's name-entry flow, `saveSlotsToDB()` ran on the freshly-created shell slot and unconditionally baked the still-loaded `ps` state into it (every field — stats, hp, mp, inventory, gil, jobLevels, jobIdx, unlockedJobs, knownSpells, world position, lastTown). When the user then pressed Z to enter that "new" slot, `_updateTitleMainOutCase` saw populated `slot.stats` and copied it back into `ps` — guaranteeing the clone.

Fix is a `psAligned` gate:

- `psAligned` flag in `save-state.js` (default false). Cleared by `returnToTitle` after the final save; set true at the end of `_updateTitleMainOutCase` once a slot is loaded into `ps`.
- `saveSlotsToDB` skips the entire `ps → slot` bake when `psAligned === false`. Slot-level shells (just name + defaults) still persist via the `data.forEach` loop, so navigating away mid-name-entry doesn't lose the slot. The full bake resumes on the first in-game save after `_updateTitleMainOutCase` flips the flag.
- `_updateTitleMainOutCase` now reinitialises `ps` from ROM defaults when entering a slot whose `stats` is null (a fresh slot). Calls `initPlayerStats(ps._romData)` and resets equipment to canonical OK-starter loadout (Knife, Leather Cap, Cloth Armor) — the equipment slots aren't touched by `initPlayerStats` so they need explicit reset.

Side benefits: returning to title from an existing slot and immediately starting a new game now gives a true clean start. Page-refresh + new game still works as before (boot inits ps fresh, psAligned starts false).

`src/save-state.js`, `src/title-screen.js`, `src/main.js`.

## 1.7.29 — 2026-05-06

### Roster redistribution — every floor has a healer, Ur slimmed down

Population was lopsided after the WM additions: ur=6, world=5, cave-0=4, cave-1/2=3, cave-3=1, crystal=1. Every WM was clustered in ur/world/cave-0; deeper caves had nothing but Fighters and Monks. Ur is the safe-zone starter map and didn't need a third of the player base hanging around there.

Six relocations:

- **Zephyr** (lv5 WM): ur → cave-3
- **Suki** (lv3 WM): cave-0 → cave-1
- **Blix** (lv4 WM): cave-0 → cave-2
- **Vex** (lv5 Fi): cave-2 → cave-3
- **Wren** (lv4 OK): world → cave-0
- **Jiro** (lv5 Mo): ur → crystal

New distribution: ur 4 / world 4 / cave-0 3 / cave-1 4 / cave-2 3 / cave-3 3 / crystal 2. Every cave 0-3 has at least one WM. Ur is now 2 campers (Aldric Fi + Lenna WM) plus Ivy (WM lv2) and Nyx (OK lv1) — appropriate for a starter zone. Caves 1-3 each gain a healer for harder encounters; crystal gets a Monk for non-Fi variety. Roster movement keeps them shuffling, so any given moment in any given location should have a reasonable mix.

`src/data/players.js` only.

## 1.7.28 — 2026-05-06

### Four more White Mages — 8 total on the roster

Converted four more Onion Knights to White Mages: Zephyr (Ur, lv5, palIdx 1 / blue trim), Mira (world, lv4, palIdx 2 / green trim), Suki (cave-0, lv3, palIdx 4 / yellow trim), Blix (cave-0, lv4, palIdx 7 / pink trim). All carry Staff + Leather + Cap and know Cure + Poisona.

Roster mix is now: 8 WMs, 8 Fighters, 4 Monks, 2 OKs, 1 OK-Knife (Mira) — well-distributed across all locations. Roster movement (`_updateMovement`) shuffles non-camper players around naturally, so any given location will have at least one WM most of the time.

`src/data/players.js` only.

## 1.7.27 — 2026-05-06

### White Mages on the roster — they actually heal you in battle now

Replaced 4 Onion Knights in `PLAYER_POOL` with White Mages (jobIdx 3): Lenna (Ur, lv5, Cure+Poisona), Ivy (Ur, lv2, Cure), Tora (world map, lv5, Cure+Poisona), Pip (cave-0, lv3, Cure+Poisona). Each equipped with Staff (0x0E) + Leather Armor (0x73) + Leather Cap (0x62) — the staff gives them a real (if weak) attack so they're not useless when nobody needs healing. Per-WM color is the same red-trim variation `PLAYER_PALETTES` already offers (palIdx 0/2/5/6) — the color slot 3 is what changes per slot, identical scheme to the OK roster they're replacing.

White Mage ally AI:

- `generateAllyStats` now returns `mnd` and `knownSpells`. MND scales as `5 + lv*W` where W=3 for WM, W=2 for Red Mage, W=1 otherwise. Cure heal at lv5 WM (MND 20) lands ~52-78 HP.
- `_tryAllyCure` (battle-turn.js) runs at the top of every WM ally turn before the attack roll. Builds a candidate list of every living teammate (player + other allies + self), picks the lowest HP%, and casts Cure if anyone is below 60% HP. Otherwise falls through to the staff attack.
- New battle states `ally-magic-cast` (600 ms windup) → `ally-magic-hit` (1000 ms total, effect applied at 400 ms). Mirror of the player magic-cast / magic-hit pipeline but with caster=ally.
- `SFX.MAGIC_CAST` at cast start, `SFX.CURE` at heal moment. Same chime as player Cure.

Visuals:

- WM caster portrait switches to victory pose for the cast duration (same arms-up pose used for victory, defend, magic-cast on the player). Held steady, not flickering.
- Heal sparkle (recovery palette) renders on the target portrait — player or ally — during the heal phase. Reuses `bsc.cureSparkleFrames` (the existing recovery-school sparkle) so no new asset work.
- Heal number bounces on the target portrait via the existing `setPlayerHealNum` / `getAllyDamageNums` paths. 0-value popup suppression from 1.7.25 covers full-HP overheal automatically.

Ally caster magic-circle (the flame + 8-star ring) is **not** rendered yet — that requires per-ally portrait positioning math which needs its own pass. Functional gameplay first; polish to follow.

`src/data/players.js`, `src/battle-state.js`, `src/battle-turn.js`, `src/battle-ally.js`, `src/battle-update.js`, `src/battle-drawing.js`.

## 1.7.26 — 2026-05-05

### White-magic numbers audit — equalised MP cost, missing-entry guard, drop dead clamp

Five low-risk corrections after auditing the v1 white-magic system:

- **Cure MP 4 → 2.** Asymmetric Cure=4 / Poisona=2 had no source. NES FF3 uses level-slot MP — both Cure and Poisona consume one Lv1 slot, same cost. Equalising to 2 each makes the WM start kit (~6 MP) yield ~3 casts before sleep, matching the canonical "3 Lv1 slots" feel.
- **`getSpellMPCost` no longer silently defaults to 0.** Old behaviour: any spell ID added to `ps.knownSpells` without a `SPELL_MP_COST` entry was free to cast. New behaviour: warn once via `console.warn` and return 99 (effectively uncastable) so the omission surfaces immediately in playtest. Latent footgun gone.
- **Dropped dead `Math.max(0, ps.mp - cost)` clamp** in `startSpellCast`. All three call sites already gate on `ps.mp >= cost` upstream (`input-handler.js:385`, `:825`, `:923`) so the clamp only ever masked an upstream bug. If MP goes negative now, an upstream check is missing and we want to notice.
- **`STARTING_SPELLS` comment** flags Sight (0x36) as canon-deferred so the WM Lv1 kit gap is intentional and visible at the data site.
- **Ur magic shop comment** notes the higher-tier rollout plan (Cura mid-game, Curaga late-game) so future shop authoring has the canonical reference inline.

`src/data/spells.js`, `src/spell-cast.js`, `src/player-stats.js`, `src/data/shops.js`.

## 1.7.25 — 2026-05-05

### Suppress 0-value heal popups (Poisona, Antidote, full-HP overheal)

Status-cure spells (Poisona, Bndna, Esuna, Stone) and cure-status items (Antidote, Eye Drops, etc.) push a `{ value: 0, ... }` heal-num purely to drive the sparkle animation + `inv-heal` state-machine timing — there's no HP delta to display. The renderer was happily drawing "0" on the portrait.

`drawBattleNum` in `damage-numbers.js` now returns early when `value === 0`. Single point of change covers both battle and pause-menu, both player and ally, both spell and item paths. Sparkle anim is gated on heal-num *existence* not value, so it's unaffected — Poisona/Antidote still render the cure-sparkle visual, just without the pointless "0" floating above the portrait. Side benefit: full-HP cure-overheal (`heal = min(amount, maxHP - hp) === 0`) also no longer pops a "0".

`src/damage-numbers.js` only.

## 1.7.24 — 2026-05-05

### Per-school SP3 palette for white-magic cast anim

1.7.23 widened the cure-anim render gate to status-cure + revive on the assumption that Cure and Poisona shared everything. They share **tile bytes** (verified) but **not the SP3 palette** — Cure's hardcoded `[0x0F, 0x12, 0x22, 0x31]` rendered Poisona's magic circle in Cure-blue when the actual ROM renders it magenta/orange. Caught by re-reading the user's REC OAM dump SP3 row (`[0x0F, 0x15, 0x27, 0x30]`) — should have flagged the diff in 1.7.23, didn't.

`cure-anim.js` refactored to decode tile canvases per palette at init:

- `WHITE_MAGIC_PAL` map keyed by school (`recovery` / `cure_status` / `revive`). Recovery keeps Cure's blue. Status-cure uses the captured magenta. Revive defaults to status-cure's palette as a placeholder until Raise gets its own REC.
- `_decodeForPalette(pal)` builds the full bundle (`flameFrames` × 5, `starTile`, 2-frame `sparkleFrames`) for one palette. Init runs it twice (recovery + status; revive aliases status), so 2 distinct decode passes.
- New `getCureAnimAssets(spell)` getter: returns the right pre-decoded bundle by spell. Unknown spells / non-white-magic return null.
- Backward compat: `initCureAnimSprites()` still returns the recovery bundle at the top level so `bsc.cureFlameFrames` / `cureStarTile` / `cureSparkleFrames` keep working for HUD pause-heal, item-use Cure, PVP-potion etc.

`battle-drawing.js` magic-cast and ally-magic-heal paths now look up the active spell at render time (`SPELLS.get(getCurrentSpellId())`) and use `getCureAnimAssets(spell)` to pick the per-school flame, stars, and heal sparkle. Item-use Cure (potion path) is unchanged — always recovery palette via `bsc.cureSparkleFrames`. Ally heal sparkle render rewired through a single `healSparkleSet` arg to `_drawAllyTexts` so magic vs item-use no longer share a hardcoded asset.

Test: cast Cure on self → blue circle/sparkles. Cast Poisona on a poisoned ally → magenta/orange circle/sparkles. Both now match what the FF3 ROM actually renders.

`src/cure-anim.js`, `src/battle-drawing.js`.

## 1.7.23 — 2026-05-05

### White-magic anim widened from Cure-only to the whole school

A 120-frame REC OAM capture of Poisona showed tiles `$4A-$57` byte-identical to the Cure capture (same SP3 palette `[0x0F, 0x15, 0x27, 0x30]`, same per-frame progression: small `$4B/$4C` → medium `$4D/$4E` → large `$4F/$50` → XL with mirroring `$53-$56` → brackets `$57`). The FF3 ROM uses one shared "white-magic cast" animation — the cure-anim work captured general-purpose white-magic tiles, not Cure-specific.

`_isCureAnimSpell()` in `spell-cast.js` widened from `spell.element === 'recovery'` to also cover `spell.target === 'cure_status'` (Poisona, Bndna, etc.) and `spell.target === 'revive'` (Raise). Effects propagate automatically:

- Status-cure spells now run through the full 1667 ms cure-anim timing (build-up 800 ms → lunge 200 ms → cast 217 ms → heal 283 ms → return 167 ms) instead of the legacy 1100 ms placeholder.
- Magic-circle + 8-star ring renders caster-side via `getCureAnimElapsedMs()` (battle-drawing.js gates off the same predicate).
- Heal-phase sparkle on the cured target via `shouldDrawHealSparkle()`.
- `MAGIC_CAST` SFX at `magic-cast` start was already universal (fired in `startSpellCast` regardless of school per FF3J 33/B0D8/B0FF). `_applySpellEffect`'s `SFX.CURE` chime at heal-time now lands at the captured 1217 ms mark instead of 400 ms.

Damage spells are not yet captured; they still keep the legacy 1100 ms timing. Followups in `docs/design-notes.md` updated accordingly.

`src/spell-cast.js` (one function widened), `docs/design-notes.md` (followups).

## 1.7.22 — 2026-05-05

### EMU debugger — REC `DEDUPE` toggle (60–70% smaller spell captures)

A 120-frame OAM REC of a spell anim is 400-800 KB — past mobile clipboard limits. NES holds each animation state 2-4 frames per pose, so most of those bytes are duplicate tile dumps for visually identical frames. New `DEDUPE` button next to `REC OAM` / `REC BG`: when ON, _recordFrames hashes each snap (with the per-frame `@ frame N` header normalised away) and emits identical consecutive frames as a single `// frames N..M (Kx same as frame N)` divider instead of repeating the full tile dump. The PPUCTRL + SFX strip headers added in 1.7.21 are part of the hash, so the frame where `$7F49` flips from `$00` to `$A1` (cast SFX fires) emits in full and stands out.

- Toggle button visual mirrors `SOUND` / `MUTE`: green border + checkmark when ON, default border when OFF. Per-session toggle (no persistence).
- Default OFF — preserves the per-frame paste-ready format the cure-anim work was built on.
- Status row at run completion reports `Nx/Ny unique frames` so you can eyeball the compression ratio.

`src/debug/tabs/emu.js` only.

## 1.7.21 — 2026-05-05

### EMU debugger — SFX strip + PPUCTRL header on every OAM/BG snap

The magic-capture pipeline had one step that still required leaving the EMU tab: identifying the SFX number a spell played. 1.7.16's `MAGIC_CAST = 0x62` was sourced from FF3J disasm (`LDA #$A1 / STA $7F49` at 33/B0FF) rather than the running ROM. Two snapshot-header additions close that gap and make the existing OAM/BG bank assumptions visible diagnostics.

- **`_dumpSfxStrip()`** — reads `$7F48-$7F4F` from the running CPU RAM and emits one line per byte at the top of every OAM/BG snapshot. `$7F49` is FF3J's SFX queue; the inline note translates a non-zero high-bit value to the `music.js` NSF track number (`byte − 0x3F`), so e.g. `$A1 → NSF track $62` lands paste-ready next to the rest of the capture. Recognises `$00` (idle) and `$FF` (cut SFX).
- **`_dumpPpuctrl()`** — reassembles jsnes's split `f_spriteSize` / `f_spPatternTable` / `f_bgPatternTable` / `f_nTblAddress` flags into a 4-line header so any divergence from the snapshot's hardcoded "sprite=$1000, BG=$0000, NT=$2000" assumption surfaces in the output instead of silently misreading the wrong bank. Each line annotates what the snapshot actually reads from for cross-reference.
- **OAM grouping merge bug** — `_oamSnapshotText`'s adjacency union-find used `groups.indexOf(groups[merged])` after a splice. When `g < merged`, `groups[merged]` post-splice resolves to a different element, `indexOf` returns -1, and the next adjacency on the same sprite double-adds it to a fresh singleton group. Tracked the merged group by *reference* instead — `mergedGroup.push(...)` survives the splice without lookup. Latent before today; would have surfaced on long captures with non-monotonic merges.

REC OAM / REC BG inherit both helpers automatically since they delegate to `_oamSnapshotText` / `_bgSnapshotText` per frame.

`src/debug/tabs/emu.js` only.

## 1.7.20 — 2026-05-05

### Cure-anim vocabulary — `flame` and `stars`, not "circle" and "bg sparkle"

The user named the visual elements: the rotating tiles are **stars**, and the pulsing thing to the left of the caster is a **flame**. My code had been calling them "circle" (for the flame) and "bg sparkle" (for the stars), which was confusing and conflated three distinct visuals (flame, stars, heal sparkle). Renamed throughout so future changes don't drift.

- `cure-anim.js`: `circleFrames` → `flameFrames`, `bgSparkle` → `starTile`, `getCureCircleFrameIdx` → `getCureFlameFrameIdx`, `shouldDrawBgSparkle` → `shouldDrawStars`. Pinned the vocabulary in a header comment.
- `battle-sprite-cache.js`: `cureCircleFrames` → `cureFlameFrames`, `cureBgSparkle` → `cureStarTile`.
- `battle-drawing.js`: imports + render block updated to match.

No behavior change.

## 1.7.19 — 2026-05-05

### Cure draw order — magic circle on top of sparkle ring

Swapped the draw order in the cure-anim render block: sparkle ring renders first (background), magic circle renders on top. Previously the circle rendered first and the rotating sparkles painted over its detailed pixels where the ring's left arc swept past. Now the circle's detail reads clean even when a sparkle passes behind it.

`src/battle-drawing.js` — two `drawImage` calls swapped.

## 1.7.18 — 2026-05-05

### Cure on ally — heal sparkle only on the target, not the caster too

`isCureMagicSelf` was checking `target === 'player'`, which means "player-side target" and is true for BOTH self-cast and ally-cast (since allies are player-side). So when casting Cure on an ally, the heal sparkle was drawing on the player AND the targeted ally. The actual self/ally distinction is `allyIndex`: `< 0` = self, `>= 0` = ally N. Tightened the check to `allyIndex == null || allyIndex < 0`.

Caster-side animation (magic circle + 8-sparkle ring) is unchanged — it still draws on the player in both cases, since the player is the caster regardless of target. Only the heal-effect sparkle moves correctly to the target.

`src/battle-drawing.js` — one condition.

## 1.7.17 — 2026-05-05

### Cure sparkle ring — center fix + speed match to NES rate

Two bugs, both from doing the math wrong on the OAM dump.

**Off-center.** I'd built the ring centroid from sparkle TOP-LEFT positions (the OAM's `[x,y]` is the 8×8 tile's TL corner). The actual ring center is the centroid of sparkle CENTERS, which is body-relative `(8, 11)` — i.e., body horizontal center, slightly below body vertical center. In our 16-tall portrait that's effectively `(px+8, py+8)`. 1.7.16 had it at `(px+4, py+7)` — 4 left, 1 up of where it should be.

**Speed.** Tracked the top-sparkle angle through f0..f3: `-90°, -86.2°, -78.7°, -75.1°` → ~5°/NES-frame. At 60 fps that's 300°/s, or one full turn every 1.2 s. 1.7.16 was 4 s/turn (3.3× too slow); now 1200 ms/turn matches the captured rate.

`src/battle-drawing.js` — three numbers (`cx`, `cy`, period).

## 1.7.16 — 2026-05-05

### Magic-cast SFX wired from FF3J disassembly

Added `SFX.MAGIC_CAST = 0x62` (NES SFX `$21`, ROM byte `$A1`). Confirmed in the everything8215/ff3 disassembly at:
- `33/B0D8`: `LDA #$A1 / STA $7F49` — black magic pre-animation
- `33/B0FF`: `LDA #$A1 / STA $7F49` — white magic pre-animation

Both schools use the same pre-anim channel sound. `startSpellCast` now fires `MAGIC_CAST` at the moment the state flips to `magic-cast`, matching the NES timing where the channel sound plays at the start of the pre-animation (our build-up phase). Heal-effect chime at `_applySpellEffect` time is unchanged. Should replace 1.7.14's incorrect `SFX.CURE` duplicate.

`src/music.js` (new SFX entry), `src/spell-cast.js` (one-line `playSFX` call).

## 1.7.15 — 2026-05-05

### Revert duplicated CURE sfx at cast start

1.7.14 fired `SFX.CURE` at `startSpellCast` to act as the cast chime, but FF3 NES has a distinct cast/channel SFX (separate from the cure heal chime), and reusing CURE just doubled the same sound. Reverted to no-cast-sfx until the actual cast SFX number is wired in. Heal-effect chime at `_applySpellEffect` time is unchanged.

`src/spell-cast.js` — single revert.

## 1.7.14 — 2026-05-05

### Cure spell — cast SFX at build-up start + real ring rotation

Two fixes:

1. **Cast SFX fires at build-up start.** `SFX.CURE` was only playing at heal-effect application (~1217 ms in). Now also fires at the moment `startSpellCast` flips to `magic-cast` state, matching the FF3 NES chime that plays as the magic circle starts forming. Status-cure (Poisona) and revive (Raise) get the same cast chime; damage spells unchanged.
2. **Sparkle ring actually rotates now.** 1.7.13 used `Array.shift` to "rotate" 8 sparkles through 8 fixed positions, which is a no-op — same canvas at the same 8 spots. Replaced with real polar math: 8 sparkles on a radius-15 ring centered at body-relative `(4, 7)`, completing one full turn every 4 s.

`src/spell-cast.js` (cast SFX), `src/battle-drawing.js` (rotation math).

## 1.7.13 — 2026-05-05

### Cure spell — three corrections from re-reading the OAM frame-by-frame

1. **Sparkle ring is static, not rotating.** The OAM has 8 `$49` sparkles at fixed body-relative offsets `(4,-8), (-7,-4), (15,-4), (-11,7), (19,7), (-7,18), (15,18), (4,22)` with sub-pixel jitter that's invisible at our render rate. 1.7.11 made them orbit at one step per 67 ms, which read like a beyblade. Now placed statically at the captured offsets.

2. **Circle pulse cycle off-by-one fixed.** Re-tabulating cure_bg f0-47: f0-3 size 1, f4-7 size 2, f8-11 size 2 h-mirror, f12-15 size 3, f16-19 size 4, f20-23 size 4 h-mirror, f24-27 size 3, f28-31 size 4, f32-35 size 4 h-mirror, f36-47 brackets. 1.7.10/.11 had size-3 at the f28-31 slot instead of size 4. Cycle is now `[0,1,1,2,3,3,2,3,3]` followed by brackets, collapsing the h-mirror variants into their non-mirrored size (eye doesn't distinguish).

3. **Circle vertical offset.** OAM has the circle at group y=13 vs body at group y=8, i.e. 5 px below body top. 1.7.10 drew it top-aligned with the portrait. Now offset by `+5` in y to match.

`src/cure-anim.js` (cycle), `src/battle-drawing.js` (sparkle ring + circle position).

## 1.7.12 — 2026-05-05

### Cure heal sparkle — single tile on body, not corner-mirrored

1.7.10/.11 routed the heal-phase sparkle through the existing `drawSparkleCorners` helper (used by Defend, item-use, etc.), which mirrors the 16×16 frame to all four portrait corners. The OAM captures show the heal sparkle is a single 16×16 placed on the body at relative `[0,5]-[16,13]`, not four mirrored copies. Replaced the corner-mirror helper with a plain `drawImage` at portrait position for both player-self and ally-target heal paths.

`src/battle-drawing.js` only — two render sites.

## 1.7.11 — 2026-05-05

### Cure spell — bg sparkles now orbit the player

1.7.10 drew 4 sparkles pinned at the portrait corners. The OAM actually has 8 `$49` sparkles forming a ring around the body (top, upper-L/R, L/R, lower-L/R, bottom) with positions jittering every NES frame — a twinkling halo, not corner decor. Replaced the 4 fixed positions with an 8-sparkle ring orbiting the portrait center, advancing one step every 67 ms so the ring spins instead of jitters (deterministic; reads the same to the eye). Radius 13×14 puts the sparkles just outside the 16×16 portrait box.

`src/battle-drawing.js` only — single render block; no tile data or timing changes.

## 1.7.10 — 2026-05-05

### Cure spell — full PPU-captured animation

Replaces the placeholder corner-sparkle flicker with the actual FF3 NES Cure animation, frame-mapped from a 100-frame REC OAM capture. The animation has five distinct phases over ~1667 ms:

| Phase | Duration | What renders |
|---|---|---|
| build-up | 800 ms | Magic circle pulses 4 sizes (`$4A`, `$4B-$4E`, `$4F-$52`, `$53-$56`) + scattered `$49` sparkles |
| lunge | 200 ms | Sparkles continue; circle gone |
| cast | 217 ms | Engine's existing item-use pose holds |
| heal | 283 ms | Captured `$4A`/`$49` sparkles flicker on the target portrait — 4-color asterisk, way more detail than the old placeholder |
| return | 167 ms | Anim resolves |

Tiles `$49` and `$4A` re-bank mid-animation (MMC3 CHR switch) — the small build-up sparkle and the large heal-phase sparkle are different bytes, captured separately and decoded via the SP3 palette `[0x0F, 0x12, 0x22, 0x31]`.

New `src/cure-anim.js` owns tile bytes, decode, frame builders, and phase boundary helpers (`getCureCircleFrameIdx`, `shouldDrawBgSparkle`, `shouldDrawHealSparkle`). `src/spell-cast.js` re-times recovery spells to the full 1667 ms (status-cure + damage spells keep their legacy 1100 ms timing until those are captured). `src/sprite-init.js` `_initCureSparkleFrames` now uses the real captured heal-phase tile bytes — so item-use Cure (potions) also gets the upgraded sparkle flicker for free. `src/battle-drawing.js` draws the magic circle 16×16 to the left of the player portrait (caster-side, regardless of target) plus four bg sparkles around the portrait corners during build-up; heal sparkles render on the target portrait (self or ally) during phase 4.

## 1.7.9 — 2026-05-05

### REC OAM/BG max frames bumped 60 → 240

A 60-frame cap was too short for magic captures — full spell animations (caster build-up + magic circle + cast moment + followthrough) run 2-3 seconds and exceed the 1-second window. Bumped to 240 (4 seconds at 60fps) so even long spells (Cure, summons, multi-target) fit in one capture.

`REC_FRAMES_MAX = 240` in `src/debug/tabs/emu.js`. Input field `max` attribute updates automatically. Lower bound stays at 1.

## 1.7.8 — 2026-05-04

### Magic-grant buttons — bit-field correction + ALL SPELLS

1.7.7 still had the white/black bits inverted, and the CALL button was wrong: bit 6 doesn't grant summons (Chocb/Shiva/Ramuh/etc.) — those are inventory book items at `$60C0-$60FF`. Bit 6 grants the underlying *summon-effect spells* (FF3J names: Bahamur, Heatra, Spark, Catas, Hyper, Icen, Leviath, Escape — the spells that summons cast into).

Verified bit-mapping by cross-ref'ing L8 spell IDs against the disassembly mask table:

| Bit | Mask | School | L1 / L8 example |
|---|---|---|---|
| 0-2 | 0x01 / 0x02 / 0x04 | **Black** | Sleep/Fire/Ice → Flare/Death/Meteor |
| 3-5 | 0x08 / 0x10 / 0x20 | **White** | Pure/Cure/Sight → WWind/Life2/Holy |
| 6 | 0x40 | Summon-effect | Escape → Bahamur |

Changes:

- **WM SPELLS** now writes `0x38` (bits 3-5) — was `0x07`, swapped.
- **BM SPELLS** now writes `0x07` (bits 0-2) — was `0x38`, swapped.
- **CALL SPELLS** removed; replaced with **ALL SPELLS** writing `0x7F` (all 7 bits) and setting job to Sage (`$6100=14`). Sage is the only job that can naturally use bits across all schools, and the all-bits mask gets every animation-bearing spell in the bitfield in one tap.

For real summon books (Chocb/Shiva/etc.), TODO is a separate `SUMMON BOOKS` preset that pokes the 8 summon-book item IDs into inventory — needs item-table research.

## 1.7.7 — 2026-05-04

### Magic-grant buttons — bitfield encoding fix

1.7.6's WM/BM/CALL buttons wrote raw spell IDs (e.g. `0x34` for Cure) to `$6207-$620E`. Wrong encoding — the byte is a **bitfield**, not a spell ID. Each level packs 7 spells: bits 0-2 = the 3 white spells, bits 3-5 = the 3 black spells, bit 6 = the summon. Source: `ff3j.asm` at `3D/A1F4` (`LDA spell_mask,X / ORA $6207,X` — masks `01,02,04,08,10,20,40` × 8 levels).

Writing `0x34` (binary `00110100`) for Cure was setting bits 2, 4, 5 → "Sight, Fire, Ice" all at once across two schools, hence "spells are all mixed up".

Fix: write a per-school MASK to all 8 level bytes:

- **WM SPELLS** → `0x07` per level (all 3 white spells)
- **BM SPELLS** → `0x38` per level (all 3 black spells)
- **CALL SPELLS** → `0x40` per level (the summon spell)

Also added a job-level bump at `$6210+jobId*2 = 99` so all 8 magic levels actually unlock — without that, char level alone wasn't enough to access higher tiers.

## 1.7.6 — 2026-05-04

### EMU debugger — magic-grant preset buttons

Three new preset buttons in the **PARTY / INVENTORY EDITOR** panel, next to `FULL HP` / `CLEAR INV`. Each one pokes char A's SRAM to make the running FF3 ROM ready to cast a school of magic — for use with the REC OAM/BG capture pipeline to grab spell animations.

- **`WM SPELLS`** — sets job to White Mage (`$6100=03`), level 50, MP 9/9 across all 8 levels (`$6130-$613F`), and equips Cure / Aero / Cura / Libra / Curaga / Haste / Curaja at L1-L7 (`$6207-$620E`). L8 left zeroed (Sage-only).
- **`BM SPELLS`** — Black Mage (`$6100=04`), same setup, equips Fire / Thunder / Fira / Break / Taga / Firaga / Quake at L1-L7.
- **`CALL SPELLS`** — Summoner (`$6100=13`), equips a best-guess summon-effect mapping (Summon / Blizzard / Thunder / Fire / Earthquake / Glare / Tidal Wave / ParcleBeam at L1-L8). Empirical — may need tuning once we observe what each level dispatches in-battle.

Spell IDs cross-referenced from `tools/rom-dump-spells.txt` and the rpgclassics FF3 NES spell tables. SRAM offsets sourced from the everything8215/ff3 disassembly (`field-ram.txt`):

- `$6100` — char A job ID
- `$6101` — char A level
- `$6130-$613F` — MP (current/max × 8 levels)
- `$6207-$620E` — char B equipped spell list (1 byte per level)

Constants (`JOB_OFF`, `LEVEL_OFF`, `MP_OFF`, `SPELL_LIST_OFF`) added to `src/debug/tabs/emu.js` alongside the existing `INV_IDS_OFF` / `INV_QTY_OFF` so future SRAM presets have a clean foundation. Unlocks the magic-capture phase of the EMU plan — workflow: tap a button → enter battle → cast → REC OAM through animation → paste back.

## 1.7.5 — 2026-05-04

### Docs catchup for the 1.7.x line

Stale-session sweep — README, CLAUDE.md, EMU-PLAN, and design-notes were lagging the v1.6.94 → v1.7.4 jump.

- **README.md** — status bumped from 1.6.94 to 1.7.4. Added a paragraph on the EMU debugger tab (REC N FRAMES, 4-slot savestates, scene library, SRAM editor) and the per-weapon slash work that came out of those captures. Architecture concern list adds a `Debug` row covering `src/debug/{panel,bus,tabs/*}` and `src/debug/scenes/`.
- **CLAUDE.md** — PPU capture section now documents `REC OAM` / `REC BG` (multi-frame, the highest-leverage tool), 4-slot savestates with selection UX, and the `SCENES` panel + commit flow. `COPY` / `SAVE FILE` output toolbar called out as mobile-critical. The "where things live" table's slash row now points at `slash-effects.js` as single-source.
- **docs/EMU-PLAN.md** — new "Status (as of v1.7.4)" table marks Phase 0, 1.1, 1.2, 1.3, and 3 as shipped (with release versions); Phase 1.4, 2, 4, 5 still pending. Adjacent-work section captures the v1.7.1–1.7.4 slash refactor that fell out of REC captures, plus a note that DEDUPE toggle is the obvious next-leverage move on REC itself.
- **docs/design-notes.md** — "Battle attack animation" section rewritten for the consolidated `slash-effects.js` exports (`SLASH_FRAME_MS`, `getSlashPattern`, `setSlashOffsetForFrame`, `shouldDrawSlash`, `getSlashHoldMs`). Per-hit cycle line updated for per-weapon hold (blade 90 ms, impact 60 ms) and miss skip-on-miss.

No code changes in this release.

## 1.7.4 — 2026-05-04

### Slash logic consolidated into `slash-effects.js`

After 1.7.1 → 1.7.3 added the same skip-on-miss and timer-gate logic to three different state machines (`battle-update.js`, `battle-ally.js`, `pvp.js`), the duplication was getting out of hand. Pulled all the cross-cutting slash concerns into `slash-effects.js`:

- **`SLASH_FRAME_MS = 30`** — was split (30 ms in `battle-update.js`, 50 ms in `battle-drawing.js`). The drawing-side 50 ms made the ally `af` sprite-canvas index lag the state machine's `slashFrame`, so ally slash sprites would skip frames or stall. Now single-source.
- **`shouldDrawSlash(hit)`** — central predicate replacing inline `hit && !hit.miss` checks in 8 different sites across `battle-update.js`, `battle-ally.js`, `pvp.js`, and `battle-drawing.js`. Future rules (shield-block fast-skip, dead-target, etc.) live in one place.
- **`getSlashHoldMs(weaponId)`** — wraps `pattern.totalFrames * SLASH_FRAME_MS` so player slash code doesn't need to recompute it inline.
- All five touched modules now import from `slash-effects.js`. No behavior change in this release beyond the implicit ally-`af` fix from unified `SLASH_FRAME_MS` (ally slash sprite frames now advance at the same cadence as the state machine).

## 1.7.3 — 2026-05-04

### Player + ally slash also skip the impact hold on a miss

Same fix as 1.7.2 (PVP-enemy slash) applied symmetrically to the two outgoing slash paths so the whole combat chain is consistent — there's never a frozen pause when the slash sprite isn't going to render.

- `_updatePlayerSlash` in `battle-update.js`: on miss, skip the per-frame slash-offset advance and the `pattern.totalFrames * SLASH_FRAME_MS` wait. Routes straight to `player-hit-show`.
- `ally-slash` state in `battle-ally.js`: same — on miss, skip the `ALLY_SLASH_MS` hold; advance the combo or finalise immediately.
- Hit and crit paths unchanged in both.

## 1.7.2 — 2026-05-04

### PVP-enemy slash skips its impact hold on a miss

`_processPVPEnemySlash` in `pvp.js` always waited the full `ENEMY_SLASH_TOTAL_MS` regardless of the hit outcome. The slash sprite render path was already gated by `!miss`, so on a miss the entire wait was dead time after the body's forward swing — no visual, just a pause before the MISS popup.

Now on miss, the state short-circuits and routes straight to combo advance / damage display. Hits and shield blocks (which still want the impact frames) are unchanged. Affects PVP-opponent slashes targeting both the player and any ally.

## 1.7.1 — 2026-05-04

### Per-weapon slash scatter from PPU captures

Replaces the 1.6.89 "bladed = clean diagonal, else random ±8 per frame" heuristic with a PPU-derived per-weapon table. Driven by 20-frame OAM captures (OK dual-wield knife, WM staff, Monk full dual-fist combo) via the new EMU REC tool.

- **New single source of truth** in `src/slash-effects.js`: `getSlashPattern(weaponId)` plus `setSlashOffsetForFrame(state, weaponId, frame)` for player and `_scatterFor(weaponId, frameIdx)` for ally/PVP. `battle-sprite-cache.js` re-exports the helpers so consumers don't need to know which file owns what.
- **Bladed** (knife / sword / katana / dagger): deterministic UR→LL diagonal, 3 frames at `[(16,-16), (0,0), (-16,16)]`, 1 frame each. PPU showed step `(-16, +16)` per frame — the previous `(-8, +8)` step was half-magnitude.
- **Impact** (fists, staff, rod, nunchaku, claw, hammer, etc.): single RNG-scattered position per hit, range `±12 x / ±20 y`, held 2 frames. Multi-hit combos re-roll per hit. The previous "staff = downward arc" / "fists = tight cluster" overrides from 1.6.86 were wrong — staff impacts are the same RNG-on-target as fists.
- **Player path** (`battle-update.js _updatePlayerSlash`, `_advanceHitCombo`, `input-handler.js` first-hit queue) replaced inline bladed/random branches with `setSlashOffsetForFrame`. RNG-pattern weapons re-set offset only on hold-window boundaries (`frame % holdFrames === 0`), matching NES single-roll-per-hit.
- **Ally / PVP path** (`drawSlashOverlay`) now uses the same pattern table. Module-local cache stabilises the RNG roll across render calls within a hold-window — fixes a pre-existing per-render jitter where `Math.random()` re-rolled every frame draw. `resetSlashScatterCache()` is called when starting any new ally hit (`battle-ally.js`) or PVP-enemy slash (`pvp.js`) so RNG re-rolls cleanly per hit.
- **Fist body wiggle moved from sprite to body group.** 1.6.94 wiggled only the fist sprite at ±2 x / ±1 y, which detached the fist from the arm. PPU shows the **whole body group** alternates ±1 x while bladed strikes hold steady. `_drawPortraitWeapon` no longer wiggles; the parent draw site shifts `pxs` ±1 px x during fist `player-slash`.
- **Followups doc updated** — design-notes "Battle attack animation" section rewritten; "Staff slash 3-frame anim" and "Staff/rod downward-arc scatter" entries deleted from Followups (both were misreads of single-capture noise).

## 1.7.0 — 2026-05-04

### EMU debugger: REC N FRAMES — multi-frame OAM/BG capture (Phase 3)

Animation work like the 3-frame staff slash, spell anims, and any future N-frame sprite work no longer needs N separate pause-snap-step cycles. New `REC OAM` and `REC BG` buttons capture N consecutive frames in one pass.

- **New REC row** in the EMU tab below the SAVE/LOAD/SNAP capture row. Two buttons (`REC OAM`, `REC BG`) plus `frames` (default 3, max 60) and `gap` (default 1, max 30) numeric inputs. `gap=1` captures consecutive frames; `gap=N` advances N frames between snaps for slower anims.
- **Async loop drives `nes.frame()` between snaps** with a `setTimeout(0)` yield each step, so the canvas updates live during the record (you watch the animation play) and the cancel tap stays responsive. Tap the active REC button mid-run to cancel — text changes to `CANCEL (i/N)` while recording.
- **Output is one paste-ready block.** Each frame's snap is preceded by a `// ═══ frame N (snap @ fXXXXX) ═══════` divider. Per-frame OAM blocks include the PPU palette (in case it shifts mid-anim) and all meta-sprite groups. Per-frame BG blocks include the nametable grid + unique tile patterns.
- **Refactor:** `_snapshotOAM` body extracted into a pure `_oamSnapshotText()` helper used by both single-snap and the REC loop. `_bgSnapshotText` was already pure — REC reuses it directly.

## 1.6.99 — 2026-05-04

### EMU debugger: scene library framework (Phase 1.2)

Committed savestates of canonical FF3 moments, loaded on demand from a new `SCENES` panel in the EMU tab. Solves the "single-slot localStorage means every capture clobbers the previous" problem and makes captured moments **portable across browsers** — anyone who clones the repo gets the same `LOAD` buttons.

- **New dir** `src/debug/scenes/` with `index.json` (manifest) and `<name>.json` (full scene file). Schema documented in `src/debug/scenes/README.md`.
- **`SCENES` collapsible panel** below the output textarea. On open, fetches `index.json` and renders one row per scene (name + description + tappable `LOAD` button). Header summary shows the count: `SCENES (3)`. `REFRESH` button re-fetches without a page reload.
- **`LOAD` per scene** fetches `<name>.json`, auto-pauses the emulator, applies via `nes.fromJSON` after a `JSON.parse(JSON.stringify(...))` deep-clone (same aliasing-decoupling reason as the slot fix in 1.6.98), then resumes. `nes.romData` re-attached if the scene file's `state.romData` is null (which it always is — `romData` is intentionally stripped on export).
- **`EXPORT SCENE` form** at the bottom of the panel — name input (lowercase letters / digits / hyphens) + description input + button. Tap `EXPORT SCENE` and the full scene JSON (with metadata header + slim `nes.toJSON()` state) lands in the output textarea, paste-ready. From there `COPY` or `SAVE FILE` shares the JSON for committing into the repo.
- Scene library ships **empty** in this release. Initial captures land per future release as we accumulate them.

## 1.6.98 — 2026-05-04

### Fix: EMU savestate `LOAD` only worked once per `SAVE`

The 1.6.97 multi-slot work shipped with a latent bug inherited from the original single-slot code: `nes.fromJSON(state)` aliases the saved object's inner arrays into the running NES (jsnes' generic helper does `target[prop] = source[prop]` — straight reference assignment, no copies). After the first `LOAD`, every CPU/PPU mutation between then and the next `LOAD` silently rewrote the savestate, so `LOAD` #2 was effectively a no-op against drifted data.

Slots now store the savestate as a **JSON string** instead of a parsed object. `LOAD` parses a fresh copy each time, so the running emulator and the saved slot stay decoupled. A small `slotFrames` sidecar caches the frame number per slot so the slot-select status line doesn't need to re-parse a 100–500 KB string just to display `@ fN`.

## 1.6.97 — 2026-05-04

### EMU debugger: 4-slot savestates (Phase 1.1)

Replaces the single SAVE / LOAD slot with four numbered slots (`S1` … `S4`) so multiple captured moments can persist side by side instead of clobbering each other.

- New slot row above the SAVE / LOAD buttons. Tap `S1` … `S4` to select; the selected slot has a gold border and bold text. Populated slots show a `•` and green text; empty slots stay gold.
- `SAVE` and `LOAD` always operate on the currently-selected slot. Status messages are now slot-aware (`S2: saved @ frame 12345 (24 KB)`, `S3: empty`).
- Saved state now records `frame` so `LOAD` can report which frame the slot was captured at (`S2: loaded (@ f12345)`).
- Each slot persists at `localStorage[ff3_emu_savestate_slot_${i}_v1]`. The pre-1.6.97 single-slot key (`ff3_emu_savestate_v1`) auto-migrates into slot 0 on first boot if slot 0 is empty.

## 1.6.96 — 2026-05-04

### EMU debugger: Phase 0 — mobile QoL + capture race fix

First slice of the EMU-tab improvement plan (`docs/EMU-PLAN.md`). All five items are mobile-first since the user tests over SSH on a phone; selecting a 50-line textarea on touch was the gating UX problem.

- **`COPY` button** above the output textarea. Uses `navigator.clipboard.writeText` with a select+`execCommand('copy')` fallback for non-HTTPS / older WebViews. 800ms `COPIED ✓` flash on success.
- **`SAVE FILE` button** alongside it — downloads the current output as `emu-snap-f${frameCount}.txt` via a temporary `Blob` + `<a download>` click.
- **`SOUND` / `MUTE` button** now flips border + text colour (green when audio is on, default gold when muted) so audio state is scannable at a glance instead of relying on the textContent label alone.
- **Captures auto-pause the emulator.** New `_withPause(fn)` helper wraps `SNAP OAM`, `SNAP BG`, `WPN TILES`, and the per-tile `DUMP` button — pauses for the duration of the read, resumes if it was running. Eliminates the half-old / half-new tile race when `nes.frame()` ticks mid-walk through `ppu.ptTile` / `spriteMem` / `vramMem`.
- **`Escape` no longer closes the panel from inside an input/textarea.** Scoped via `document.activeElement.tagName` check in `src/debug/panel.js` — typed write-bytes / tile indices survive accidental Esc presses.

## 1.6.95 — 2026-05-04

### Docs: README + design-notes catch up to magic + animation work

- README status line bumped to v1.6.94 and now mentions player-cast magic. Architecture module list adds `Magic — spell-cast, data/spells`.
- New "Magic" section in `docs/design-notes.md` covering `ps.knownSpells`, MND vs INT stat, `menuMode = 'magic'` piggyback, battle cast pipeline, status-cure flow, pause-menu submenu.
- New "Battle attack animation" section documenting per-hit cycle (back-swing every hit, idle only at hand change, fists skip back-swing), per-weapon slash scatter (bladed = diagonal, else random per frame), per-weapon slash sprite routing, and fist sprite wiggle.
- Updated stale notes: magic-cast pose now lives in the `isItemUsePose` branch (was "TODO"); magic shop is wired (was "no-op"); fist combo notes updated for shipped behavior.

## 1.6.94 — 2026-05-04

### Fist sprite wiggles during punch slash

Each punch's fist sprite now wiggles ±2px x / ±1px y at ~30ms cadence during `player-slash` so the impact reads with shake. Applied in `_drawPortraitWeapon` only when `handWeapon === 0` (unarmed) and state is `player-slash` — weapons unaffected.

## 1.6.93 — 2026-05-04

### Every weapon hit now gets a full back-swing (was 30ms flash for repeats)

`HIT_COMBO_PAUSE_MS` (30ms) was being used for every hit after the first within the same hand — that's barely two NES frames in back-swing pose, so it visually looked like the back-swing was skipped. Now every hit uses `BACK_SWING_MS` (~167ms) so the wind-up is clearly visible per hit. Fists still skip the back-swing entirely (punches go straight forward). Hand change still inserts the idle pose break.

## 1.6.92 — 2026-05-04

### Idle pose only at hand change (revert from per-hit)

Reverting the per-hit idle break from 1.6.91. Pattern is: right hand back→forward repeats for however many R hits, then ONE idle pose at the hand change boundary, then left hand back→forward repeats for however many L hits. Same-hand subsequent hits stay in back-swing pose between strikes (no idle in between).

`_updatePlayerAttackBack` back to the handChange branch using `IDLE_FRAME_MS`, with `HIT_COMBO_PAUSE_MS` for same-hand hits and `BACK_SWING_MS` for hit 0. `_getPortraitSrc` `interHitGap` renamed back to `handChangeGap` and only fires when the hand actually swapped.

## 1.6.91 — 2026-05-04

### Idle pose break between EVERY combo hit (not just R↔L hand swaps)

Previously the inter-hit gap held the back-swing pose for `HIT_COMBO_PAUSE_MS` (~30ms) and only inserted the idle pose on actual hand changes. Per "each hand should get whatever number of hits, each hit getting the 3 slash frames, idle pose, next hand repeats", every hit after the first now gets a `IDLE_FRAME_MS` (67ms) idle pose break before the next strike — same-hand and hand-change alike.

`_updatePlayerAttackBack` simplified: hit 0 = weapon back-swing (skipped for fists), hit 1+ = idle break. `_getPortraitSrc` renamed `handChangeGap` → `interHitGap` and fires for every hit > 0.

## 1.6.90 — 2026-05-04

### PvP-enemy + ally slash overlays use the same per-weapon scatter as the player

`drawSlashOverlay` now takes a `weaponId` and applies the same rule as `_updatePlayerSlash`: bladed → clean UR→LL diagonal, non-bladed → random ±8 per frame. Previously ally + PvP-opponent slashes were stuck on the legacy `[0,10,-8] / [0,-6,8]` shake regardless of weapon.

## 1.6.89 — 2026-05-04

### Slash scatter back to simple per-frame random for staff/nunchaku/fists

Reverted the per-weapon scatter system (1.6.86) and the 2-frame "skip slot N" hack (1.6.88). Back to: blades get the clean UR→LL diagonal (unchanged), everything else gets a small per-frame random offset (`Math.random()*16 - 8`) per the 3 timing slots. `SLASH_FRAMES` stays at 3 for all weapons; `drawSlashOverlay` is back to its original signature using the legacy `[0,10,-8] / [0,-6,8]` shake for ally/PVP slashes. `getSlashScatter` and the per-weapon scatter constants removed.

## 1.6.88 — 2026-05-04

### Slash effect for staff/nunchaku/fists is 2 frames AFTER the swing

Per PPU OAM comparison: the NES staff slash effect plays for **2 game frames** AFTER the player's arm has come down on the forward strike. Frame 1 of the effect is held empty (no slash sprite rendered yet); frame 2 has the sprite at one static position on the target. Both PPU snapshots showed a forward-strike pose, just at slightly different sub-poses — neither was a wind-up.

Previous engine ran a 3-frame scatter dance over the entire 150ms `player-slash` window. Now:
- `_STAFF_SCATTER` and `_PUNCH_SCATTER` are static `(0,0)` (sprite holds at one position).
- Both encounter and boss slash render paths skip drawing the slash sprite on `slashFrame === 0` for non-bladed weapons — so the visible flash starts on frame 1 and holds through frame 2 (~100ms post-swing).
- Bladed weapons untouched (no PPU verification yet — they keep the UR→LL diagonal).

## 1.6.87 — 2026-05-04

### Pause-menu inv-target cursor: scroll the roster instead of walking off

`pauseSt.invAllyTarget` Down past the visible roster window now bumps `inputSt.rosterScroll` so the roster panel scrolls in sync (mirroring the way normal roster browsing scrolls). Up below the visible window pulls scroll back. Also fixed `pause-menu.js` `ROSTER_VISIBLE` from `5` to `3` to match `roster.js` — that mismatch is what let the cursor walk one extra row past the bottom into empty space before stopping.

## 1.6.86 — 2026-05-04

### Per-weapon slash scatter — staves swing down, fists land in a tight cluster

Player slash and ally/PVP slash overlays now pick a per-weapon 3-frame offset pattern instead of the old "bladed = clean diagonal, everything else = random ±20" heuristic.

- `getSlashScatter(weaponId)` in `slash-effects.js` returns `{ x: [3], y: [3] }` per category:
  - **Staff / rod / nunchaku** → downward arc `(-2,4,8) / (-16,0,16)` matching the PPU-captured staff hit (origin shifted from y=58 to y=124 across hits).
  - **Fists** (weaponId 0) → tight `(-6,4,-2) / (-4,4,8)` impact cluster — replaces the old random ±20 jitter.
  - **Bladed** (knife/dagger/sword) → `(8,0,-8) / (-8,0,8)` clean upper-right → lower-left diagonal — same shape the player-slash code used to compute inline.
  - **Default** → legacy shake.
- `_updatePlayerSlash` and `_advanceHitCombo` in `battle-update.js` now read directly from `getSlashScatter(handWeapon)` — no more per-weapon `if/else`, no more `Math.random()` for non-bladed.
- `drawSlashOverlay(ctx, frame, frameIdx, originX, originY, mirror, weaponId)` takes the weapon id so ally + PVP-opponent slash overlays use the same per-weapon scatter as the player. Existing callers updated to pass the active hand's weapon id.

## 1.6.85 — 2026-05-04

### Nunchaku slash now shares the staff slash sprite

Second-frame PPU capture of the staff slash returned tile bytes byte-for-byte identical to frame 1 (just at different CHR addresses — $4D == $55, $4E == $56, etc.). The OAM positions differ per frame (origin shifts (+5,+66) between hits), and that bouncing is already handled by `drawSlashOverlay`'s scatter array — so the existing single-sprite `initStaffSlashSprites()` is correct as-is.

Per a hunch from PPU watching, also pointed nunchaku slash at the same `bsc.staffSlashFramesR` cache (was using a separate capture). The old `initNunchakuSlashSprites()` is left in `slash-effects.js` for now in case the hunch is wrong, but it's no longer called.

Per-frame positioning (OAM showed a much bigger vertical arc than the generic scatter does) is a polish followup — staff would benefit from a downward-arc scatter override.

## 1.6.84 — 2026-05-04

### Magic content: Poisona spell, Ur magic shop, staff slash sprite

- **Poisona spell (`0x35`).** Status-cure only — removes poison from the target, never heals HP. Wired into both battle (`spell-cast.js`) and pause-menu (`_applyPauseSpellUse`) via a new `SPELL_CURE_FLAG` map (`spell.type` → `STATUS.*`). White Mage now starts with Cure + Poisona. MP cost: 2.
- **Ur magic shop is live.** `openShop` now accepts `spells:` catalogs. Magic shop in Ur (map 3, counter 4,4) sells Cure (100 gil) and Poisona (100 gil). Spell list renders with `getSpellNameClean` + price right-aligned; confirm dialog reads "Learn X?". Buying deducts gil and pushes the spell ID into `ps.knownSpells`. "Already known" rejection if you re-buy. Sell tab is blocked for spell shops with an ERROR sfx (can't sell spells). New `SPELL_BUY_PRICE` table in `data/spells.js`.
- **Staff slash sprite.** New `initStaffSlashSprites()` in `slash-effects.js` using the PPU-captured tiles `$4D/$4E/$4F/$50` (SP3 palette `[0x0F, 0x17, 0x27, 0x37]`) from a White Mage staff swing. `getSlashFramesForWeapon` now routes `staff` and `rod` subtypes to it instead of the generic punch slash. Single-frame for v1; mid + late slash frames still need PPU capture for a true 3-frame anim.

## 1.6.83 — 2026-05-04

### Cure uses Potion's CURE SFX; pause-menu inv-target cursor aligns with roster rows

- **Battle Cure now plays `SFX.CURE`** instead of `SFX.SW_HIT`. `_applySpellEffect` in `spell-cast.js` branches on `spell.element === 'recovery'` so heal spells get the same chime as Potion. Damage spells will keep the SW hit sfx until per-spell sfx land.
- **Pause-menu inv-target cursor was drifting** lower by 8px per ally row — `pauseSt.menu.js` had `ROSTER_ROW_H = 24` while the actual roster (`roster.js`) draws rows at `ROSTER_ROW_H = 32`. Changed to 32 so Potion AND Cure target cursors land on the right portrait row.

## 1.6.82 — 2026-05-04

### Battle spell-list cost no longer clipped off the right edge

The bottom panel's outer clip is `rect(8, HUD_BOT_Y, CANVAS_W-16, HUD_BOT_H)` — right edge at x=248. The Cure cost was being drawn at x=244-252, so the right half of the "4" was getting clipped, looking like a stray glyph hanging off the panel. Re-anchored cost to `CANVAS_W - 16 - measureText(...)` so its right edge sits at x=240 (8px margin from the clip).

## 1.6.81 — 2026-05-04

### Cure target select: cycle player/allies/enemies; pause-menu Cure works like a Potion

**Battle:** removed the ally-only lock on heal spells in `_battleInputItemTargetSelect`. Left/Right now navigates to enemies the same way item-target select does — symmetric with how Potion behaves. Picking an enemy with Cure in v1 still heals the caster (since damage spells aren't wired yet); will route correctly once Black Mage spells land.

**Pause menu:** Cure now goes through the same target-select cursor as Potion — Z on a spell stashes it in `pauseSt.useSpellId` and transitions to `inv-target`, where Up/Down cycles player → roster allies. Confirming with Z calls `_applyPauseSpellUse` which deducts MP, applies the heal to the chosen target, and sets `pauseSt.healNum` (with `rosterIdx` if an ally was picked) so the green-number bounce lands on the right portrait.

## 1.6.80 — 2026-05-04

### Pause menu Magic submenu — proper spell list, not instant cast

Z on Magic in the pause menu now opens a real spell-select submenu. Piggybacks on the inventory state machine (`inv-text-out` → `inv-expand` → `inv-items-in` → `inventory`) via a new `pauseSt.menuMode = 'inv' | 'magic'` flag (mirrors the battle menu pattern).

- Magic mode renders `ps.knownSpells` with MP costs right-aligned, navigates with Up/Down, Z casts the highlighted spell on self (v1: ally-only spells), X exits back to the main pause menu.
- Cast reuses the existing `inv-heal` flow — green heal number bounces over the player portrait with the cure-sparkle overlay.
- Returning from `inv-heal` keeps the spell list visible (state stays `'inventory'`, menuMode stays `'magic'`) so the player can cast again or X out.
- `menuMode` resets to `'inv'` on `inv-text-in` → `'open'` so a future Item-cursor open starts in inventory mode.

## 1.6.79 — 2026-05-04

### Magic v1 polish: cure-sparkle visual, MND-based heal, encounter visibility

- **Cure visual swapped from SouthWind ice burst to the cure sparkle.** `bsc.cureSparkleFrames` (the same alternating-flip overlay used for pause-menu Potion heals and battle-item Potion) now flickers on the player portrait during `magic-cast` / `magic-hit` whenever a player-target heal is mid-cast. The SouthWind explosion no longer renders for spell casts.
- **Heal formula now uses MND (caster's mind), not INT.** Per NES FF3 disasm, white magic uses MND and black magic uses INT. `_rollMagicAmount(power, useMnd)` in `spell-cast.js` picks the right stat based on the spell's element (`recovery` → MND); pause-menu Cure does the same.
- **Encounter monsters no longer disappear during a cast.** `_isEncounterCombatState` and the PVP/boss equivalent state-lists now include `magic-cast`/`magic-hit`, so monsters stay drawn while the spell animates instead of hiding for ~1.1s.

## 1.6.78 — 2026-05-04

### Magic v1 fixups: pause-menu Cure, MP refill on /job, strip spell-name padding

- **Pause menu Magic now casts Cure on self.** `pauseSt.cursor === 1` (Magic) was a no-op since the menu shipped — Z press now deducts MP, applies the heal via the existing `inv-heal` flow with green-number bounce, and returns to the main pause menu (new `pauseSt.magMode` flag distinguishes from Item heals so we go back to `'open'` instead of `'inventory'`). Proper spell-pick UI is TODO; v1 shorts straight to Cure.
- **`/job N` now full-heals.** Switching jobs in the test console restores HP+MP to max so a freshly-switched White Mage can actually cast Cure (4 MP) without the Z press silently failing the cost gate.
- **New `/heal` and `/mp [N]` console commands** for ad-hoc top-ups during testing.
- **`getSpellNameClean(spellId)`** in `text-decoder.js` — allowlist filter (letters, digits, basic punct, space) that strips the magic-school icon tile and any trailing padding bytes the ROM stores around spell names. Battle spell list now uses it; "Cure" no longer renders with a stray glyph at the right edge of the row.

## 1.6.77 — 2026-05-04

### Magic v1: White Mage Cure end-to-end

First slice of the player-cast magic system. Battle slot 1 for mage jobs (3/4/5) now opens a spell-select menu, picks a known spell, target-selects an ally (player for v1), deducts MP, plays a placeholder cast animation (SouthWind sprite reused), applies heal via the NES magic damage formula, and persists MP + `knownSpells` across saves.

- New `ps.knownSpells: []` on player-stats; `grantStartingSpells(jobIdx)` auto-grants per-job starting spells on `changeJob` and on save load. White Mage (job 3) starts with Cure (`0x34`).
- New `src/spell-cast.js` — `startSpellCast(spellId, target)` / `updateSpellCast(dt)` driving `magic-cast` (250ms windup) → `magic-hit` (400ms anim → apply heal → hold to 1100ms) state pair, modelled on the SouthWind throw/hit loop.
- Battle menu plumbing piggybacks on the item-* state machine via a new `inputSt.menuMode = 'item' | 'magic'` flag. Spell-select reuses the item-list panel; ally-target spells lock the target cursor to the player/ally side.
- New `SPELL_MP_COST` table in `data/spells.js` (Cure = 4 MP for v1).
- Save schema: `knownSpells` added to `save-state.js` + `save.js` + title-screen restore. On load, `grantStartingSpells(ps.jobIdx)` runs so existing mage saves get their starter spells without manual job re-switch.
- New `/job N` console command for testing — bypasses CP cost, shows known spells.
- Cast visual is a placeholder: SouthWind sprite reused as the spell anim. Per-spell PPU traces will land later.

## 1.6.76 — 2026-05-04

### Docs: README + design-notes catch up to the shop / save work

- README status line bumped from v1.6.9 → v1.6.75 and now mentions town shops as a feature. Added "Shops" entry to the architecture module list.
- New "Shops" section in `docs/design-notes.md` covering counter-tile detection, the two-phase NES fade, the equip-preview portrait + delta triangle, FF1 NSF track 14, and the blue confirm-text palette.
- New "Saves" section noting `saveSlotsToDB()` is the single source of truth for the save schema (post v1.6.74 audit), all known save trigger points, and that MP + poison tick are now persisted.

## 1.6.75 — 2026-05-03

### Shops: blue confirm dialog now uses blue text-bg + mobile-aware A/B prompts

The buy/sell confirm dialog renders on a blue (`drawBorderedBox(.., true)`) background, but the text was using `_makeFadedPal(0)` = `[0x0F, 0x0F, 0x0F, 0x30]` — color 1/2 (font shadow) was black, leaving a black halo around each glyph on the blue box. Switched to `[0x02, 0x02, 0x02, 0x30]` (the same palette `message-box.js` uses for "Bought X!" toasts), so the shadow renders blue and disappears into the bg.

Confirm hint also now reads `A=Yes  B=No` on touch devices and `Z=Yes  X=No` on desktop — same `isMobile` check `loading-screen.js` uses for its "Press A" prompt.

## 1.6.74 — 2026-05-03

### Save: persist MP + poison tick, save chests/pond, centralize the schema in `saveSlotsToDB`

Audit revealed three classes of bugs.

**Missing fields**
- `ps.mp` was never persisted — `title-screen.js` reset it to `maxMP` on every load. Added `mp` to the saved schema and the load path (`save.js`, `save-state.js`, `title-screen.js`).
- `ps.status.poisonDmgTick` was lost — only the status mask was saved. Added `statusPoisonTick` to schema + load.

**Mutations that didn't trigger a save**
- `handleChest` (gil + items from chests) and `handlePondHeal` (HP/MP restore) in `map-triggers.js` now call `saveSlotsToDB()` after mutating `ps`. Previously a crash before the next save trigger lost the pickup or heal.

**Schema duplication / drift risk**
- `saveSlotsToDB()` already copied `playerInventory` into the active slot, but every caller was *also* doing `saveSlots[selectCursor].inventory = { ...playerInventory };` inline. New callers could forget the inline copy and silently clobber. Removed all 6 inline copies in `input-handler.js` and the helper in `shop.js` — `saveSlotsToDB()` is now the single source of truth for what gets serialized. Callers just invoke it.

## 1.6.73 — 2026-05-03

### Shops: persist inventory + gil to DB after every buy / sell

`_attemptBuy` / `_attemptSell` now copy `playerInventory` and `ps.gil` into the active save slot and call `saveSlotsToDB()` immediately — same pattern as the pause-menu inventory mutations in input-handler.js. Without this, shop transactions only survived until the next battle ended, the page closed cleanly, or an inventory action in the pause menu — closing the tab mid-shop would lose them.

## 1.6.72 — 2026-05-03

### Shops: weapon delta no longer treats empty off-hand as a free upgrade

Switched weapon comparison from `Math.min(weaponR.atk, weaponL.atk)` back to `Math.max`. With one hand empty, MIN reads as 0 and made every weapon look like an upgrade ("fill the empty hand"). MAX compares against the best weapon already wielded, which matches "is this a real upgrade to my main weapon".

Added explicit short-circuit: if the hovered weapon ID matches `ps.weaponR` or `ps.weaponL`, return 0 (white =). A duplicate of what's already equipped shouldn't show ▲ just because the off-hand is empty.

## 1.6.71 — 2026-05-03

### Shops: HUD viewport border no longer fades during the NES map fade

Root cause: the snapshot fed to `buildNesFadeFrames` covered the full HUD_VIEW area, which includes the 8px-wide HUD border tiles around the map. NES-quantizing + palette-stepping that snapshot dimmed the border tiles along with the map content. Same problem applied to the shop-visible phases — `fillRect` was wiping the borders too, then `drawHudBox` redrew them, but during `map-out`/`map-in` there was no redraw.

Fix: confine all shop drawing to the inner content rect (`INNER_X = 8, INNER_Y = 40, INNER_W = 128, INNER_H = 128`). Snapshot the inner area only; draw fade frames at the inner area; black-fill the inner area; rely on the static HUD canvas (drawn each frame by `drawHUD` before `drawShop`) for the border. `drawHudBox` import dropped from shop.js — no longer needed.

## 1.6.70 — 2026-05-03

### Shops: bordered box no longer fades — only text fades

Shop `drawHudBox(... boxFadeStep)` was stepping the border-tile palette during shop-in / shop-out, which read as the HUD border itself fading. Locked to fadeStep 0 — the box pops in/out at full opacity, only the text inside still does the 4-step palette fade.

## 1.6.69 — 2026-05-03

### Shops: white = indicator on equal stat + empty-slot weapons now read as upgrades

- **Equals indicator**: `shopHoverStatDelta()` now returns `null` for "no indicator" (non-equipment / not equippable / unknown subtype) and a number for actual deltas. `_drawDeltaMark()` (renamed from `_drawDeltaTriangle`) routes `> 0` → green ▲, `< 0` → red ▼, `= 0` → white = (two 8-wide bars at rows 2 and 4 in the same 8×8 box). HUD only draws when `delta !== null`, so non-equippable items still show no indicator.
- **Empty-slot fix**: weapon delta now compares `item.atk` against `Math.min(weaponR.atk, weaponL.atk)` instead of `Math.max`. With one hand empty (atk treated as 0), any new weapon reads as a clear upgrade — matches the "fill the empty hand" intent. Shields keep `Math.max` since at most one shield can be equipped.

## 1.6.68 — 2026-05-03

### Shops: green ▲ / red ▼ delta triangle in HUD name row

When the shop cursor is on a weapon/armor the player can equip and the slot it would replace has different ATK (weapons) or DEF (armor), an 8×8 triangle is drawn at the left padding of the HUD info panel (`HUD_RIGHT_X + 40, HUD_VIEW_Y + 8`). Green ▲ for upgrade, red ▼ for downgrade. Hidden when delta = 0 / non-equipment / non-equippable. Triangle pixels are filled directly via `ctx.fillRect` per-row (NES color $2A / $16, faded with `nesColorFade` to track the existing HUD info-panel fade).

Comparison rules in `shopHoverStatDelta()`:
- weapon (non-shield): `item.atk` vs `max(weaponR.atk, weaponL.atk)`
- shield: `item.def` vs `max(weaponR shield def, weaponL shield def)`
- helmet / body / arms: `item.def` vs the matching slot's def

## 1.6.67 — 2026-05-03

### Shops: HUD portrait flickers victory pose when cursor is on equippable gear

In a shop's buy or sell list, when the cursor is on a weapon/armor that the player's current job can equip (`item.jobs & (1 << ps.jobIdx)`), the existing HUD portrait at top-right (drawn by `_drawHUDPortrait` in hud-drawing.js) alternates between `bp.victory` and `bp.idle` every 250ms — same cadence as the battle ally victory portrait. Otherwise the portrait keeps its normal kneel/defend/idle logic.

`shopHoverEquippable()` exported from shop.js — returns false outside buy/sell, false for non-equipment, false for items the current job can't wield.

## 1.6.66 — 2026-05-03

### Shops: FF1 NSF shop track → 14 (verified by ear)

## 1.6.65 — 2026-05-03

### Shops: NES palette-step fade for the map ↔ shop transition + `/ff1` console command

Replaced the alpha-based outer fade with an actual NES PPU-style palette fade. New module `src/nes-fade.js` exports `buildNesFadeFrames(srcCanvas, sx, sy, sw, sh, steps)`: snapshots a region of the canvas, quantizes each pixel to its nearest NES palette index, then uses `nesColorFade` to produce N+1 progressively darker frames (frame 0 = original, frame N = nearly black). Cached nearest-color lookup keeps the snapshot ~50ms one-time on shop open.

Shop state machine now does the transition in two distinct phases per direction:

- **Open**: `map-out` (320ms — 5 NES fade frames of the map snapshot, lazy-built on first frame) → `shop-in` (500ms — black bg + faded bordered box via `drawHudBox(fadeStep)` + faded text) → `menu`.
- **Close**: `shop-out` → `map-in` → `closed`. Reuses the same snapshot.

Sub-screen swaps (root menu ↔ buy/sell list) keep the existing 500ms text-palette fade — they don't touch the map.

Also new console command: `/ff1 <n>` plays FF1 NSF track index N (pauses map music). `/ff1 stop` resumes map music. Use to ear-check the right index for `FF1_TRACKS.SHOP` since 8/12/17 are all wrong.

## 1.6.64 — 2026-05-03

### Shops: FF1 NSF shop track → 8 (FF1&2 cart song ordering)

The NSF is built from the FF1&2 (Japan) compilation cart, not standalone FF1, so the track index doesn't match the FF1-only NSF song lists. Track 8 per Gemini.

## 1.6.63 — 2026-05-03

### Shops: switch FF1 NSF shop track from 17 → 12

Per Gemini, the FF1 shop theme is NSF track 12 (song $4D), not 17.

## 1.6.62 — 2026-05-03

### Shops: FF1 NSF shop track plays while menu is open

`openShop` now `pauseMusic()` + `playFF1Track(FF1_TRACKS.SHOP)`; `_close` calls `stopFF1Music()` + `resumeMusic()` — same pattern the pause menu uses with `MENU_SCREEN`. New constant `FF1_TRACKS.SHOP = 17` — the next NSF track index after `MENU_SCREEN` (16). If the wrong song plays, bump the index and re-deploy; can't verify without ear-checking against the FF1 NSF.

## 1.6.61 — 2026-05-03

### Shops: outer alpha fade — map fades to black as shop fades in

`openShop` now enters `'opening'` (250ms `globalAlpha` 0→1) before settling on the root menu. Exit / X from the root menu enters `'closing'` (alpha 1→0) before fully closing. The bordered box's black interior, drawn with progressive alpha over the live map, gives a crossfade where the map dims as the shop materializes. Sub-screen swaps (menu↔buy↔sell) keep their existing 500ms text-palette fades.

State machine: `closed → opening → menu → (closing | menu-out → buy-in/sell-in) → ...`. `shopSt.afterFade` records the next state when leaving the root menu so a single `menu-out` transition can route to either `buy-in` or `sell-in`.

## 1.6.60 — 2026-05-03

### Shops: Buy / Sell / Exit root menu + text-fade transitions

Shop now opens to a root menu (`Buy / Sell / Exit`) instead of jumping straight into the buy list. Each panel — root menu, buy list, sell list — fades in/out using the same 4-step palette fade as the pause menu (`PAUSE_TEXT_STEP_MS = 100`, 4 steps + 1 = 500ms total). Input is blocked during fades.

- **Sell**: lists every inventory item that has a non-zero ROM price. Sell price = `floor(buy / 2)` (FF3 NES convention). Confirm dialog mirrors buy. Inventory list rebuilds after each sale so counts stay accurate. Empty inventory shows "Nothing to sell".
- **State machine**: `closed → menu-in → menu → (buy-in / sell-in / menu-out) → ...`. Buy/sell exit via X fades back to root menu (not straight to closed); Exit on root or X on root fades the whole shop out.
- **Magic shop** still no-ops — `openShop` returns false when the catalog has `spells:` instead of `items:`. Wiring deferred.

## 1.6.59 — 2026-05-03

### Shops: weapon, armor, item buy menus wired in Ur

Face the counter in any of the three Ur shops (armor map 4 @ 3,5 / weapon map 5 @ 3,15 / item map 8 @ 8,15) and press Z. Opens a buy menu listing the catalog from `data/shops.js` with prices pulled from `ITEMS` (which were already auto-generated from the FF3 NES ROM at `$21E10`). Z on an item shows a confirm dialog; Z again deducts gil + adds to inventory and shows "Bought X!"; X cancels at any level. Insufficient gil shows "Not enough gil!" instead.

- New module: `src/shop.js` (state, input, render). Standalone — no animations yet.
- `data/shops.js` — each shop now carries `{ mapId, counter: {x,y} }`. `findShopAtCounter()` does the reverse lookup.
- `movement.js` — `handleAction` checks counters before chest/wall/etc.; `handleInput` early-returns to `handleShopInput` when a shop is open.
- `game-loop.js` — `drawShop()` runs after pause menu, before message box (so the "Bought X!" toast overlays the shop list).
- Magic shop (Ur, map 3 @ 4,4, tile 0x3A) is detected by counter lookup but `openShop` no-ops because `spells:` aren't items — buy flow needs `spells.js` integration. Deferred.

## 1.6.58 — 2026-05-03

### Console: `/pos` command for inspecting player and faced tile

New chat command — prints current map ID, player tile (X,Y), facing direction, and the faced tile's coordinates + tile ID (hex). On the world map, just prints world tile coords. Needed to identify shop counter tiles in Ur (and any future map work) without recompiling debug hooks.

## 1.6.57 — 2026-05-02

### Fix: knife forward strike on player slot was rendering the back-swing pose

`_buildPlayerSpriteSet` in `sprite-init.js` was assembling `bsc.battlePoses` with `knifeR`, `knifeL`, `knifeBack` but **not** `knifeRFwd` / `knifeLFwd`. The bundle produced both correctly — the fields just weren't carried over to the player canvas object.

When dual-wielding knives, `pickAttackPoseKey` returns `'knifeRFwd'` / `'knifeLFwd'` during the forward strike. `_playerPoseCanvas` saw those keys as undefined and fell through `PLAYER_POSE_FALLBACK` to `'knifeR'` / `'knifeL'` — which are the back-swing canvases. Net result: every knife forward strike rendered the back-swing pose instead of the strike pose. Most visible on Black Mage (frequently dual-wielding daggers as the only equippable weapon).

Now `knifeRFwd` / `knifeLFwd` are exposed on `bsc.battlePoses`. Affects every job, not just black mage.

## 1.6.56 — 2026-05-02

### Staff weapon sprite wired in; ally portraits now cover all 22 jobs; staff added to Altar F2 loot

- **Staff sprite**: PPU-captured 4-tile block (`$4A/$49/$4C/$4B`) added to `weapon-sprites.js` with SP3 palette `[0x0F, 0x17, 0x27, 0x37]` (gold). New `getStaffBladeCanvas` / `getStaffBladeSwungCanvas` getters; `'staff'` subtype routes through them in `pickAttackWeaponSpec`. White Mage (and any other staff-wielder) now overlays the gold staff during back/fwd swings using the same `swungOrder = [1,0,3,2]` mirror trick as blades.
- **Ally portraits**: `_USE_BUNDLE_FOR_ALLY` expanded from `{0,1,2}` to all 22 jobs. `boot.js` `initFakePlayerSprites` now seeds the full 0-21 range. Symptom: a saved slot with jobIdx 3+ on the title screen was rendering Onion Knight (fallback to job 0 because no entry existed). Now the bundle path produces correct per-job portraits with the canonical tile pattern that POSES tab verifies. The legacy per-job if/else in `initFakePlayerPortraits` is now dead and kept as historical reference.
- **Altar loot**: Staff (0x0E) added to F2 weapon tier alongside Dagger, Nunchuck, and Leather Cap. Same weight bucket — drop rates unchanged for the other items.
- **Rod**: still no sprite (OAM not yet captured). `'rod'` subtype falls through to no-overlay; rods don't appear in any shop or loot pool yet, so this is harmless.

## 1.6.55 — 2026-05-02

### Battle menu: "Defend" relabelled to "Guard"

`BATTLE_DEFEND` constant in `data/strings.js` renamed to `BATTLE_GUARD`, bytes re-encoded for "Guard" (G u a r d). Only call site was the local `BATTLE_MENU_ITEMS` array in the same file; no other code touches the label.

## 1.6.54 — 2026-05-02

### Fix: kneel head TL/TR for jobs 3-21 was reading the wrong ROM tile-indices

`_genericBundle` had kneel head at t(36)/t(37). That's correct for Warrior — and so were the previous PPU captures — but Warrior is the outlier: Onion Knight, Monk, and (per visual confirmation in the POSES tab) every job 3+ stores kneel head TL/TR at t(8)/t(9). Fixed both `_genericBundle` and the corresponding POSES tab card.

## 1.6.53 — 2026-05-02

### POSES debug tab now seeds jobs 3-21 from ROM using the canonical tile layout

Previously the POSES tab only loaded Onion Knight, Warrior, and Monk (PPU-captured constants). Jobs 3-21 (White Mage onward) had no cards — there was no way to visually verify whether `_genericBundle`'s tile-index pattern produced correct poses for a given job.

Added `_seedGenericJobPoses()` which, for each remaining job, reads tiles directly from ROM at `BATTLE_SPRITE_ROM + jobIdx * BATTLE_JOB_SIZE` and pushes 8 pose cards (idle / L back / L fwd / R back / R fwd / kneel / victory / hit). The tile-index slot layout matches `_genericBundle` exactly, so the tab is now the visual ground truth: if a card looks wrong, the bundle (and therefore the in-game render) is wrong, and the slot can be re-mapped from there.

## 1.6.52 — 2026-05-02

### Fix: generic-job battle sprites (jobs 3-21) now use correct ROM tile indices for L-back, L-fwd, kneel, and per-pose legs

`_genericBundle` in `combatant-sprites.js` had the L-back/L-fwd body indices and kneel body BL/BR off, and reused default legs for every pose. Symptom: switching to White Mage (or any non-OK/Warrior/Monk job) showed garbage tiles during L-side swings and kneel.

Reverse-mapped the PPU-captured Onion Knight + Warrior bytes back to ROM tile-indices and confirmed a uniform per-job layout:

- 0-3 idle body, 4-5 idle legs
- 6-7 R-fwd legs
- 10-11 kneel body BL/BR, 12-13 kneel legs
- 14 R-back body-TL, 15 R-back legL (legR shares tile 7)
- 16-17 L-fwd body, 18-19 L-fwd legs
- 20-21 L-back head-TR + body-TR, 22-23 L-back legs
- 24-27 victory body, 28-29 victory legs
- 30-33 hit body, 34-35 hit legs
- 36-37 kneel body TL/TR

Bug indices were 6/7 (L-back), 8/9 (L-fwd), 38/39 (kneel BL/BR) — those slots hold unrelated data on most jobs, which is why the previous "approximation" disclaimer existed. Pattern is canonical, not approximate.

Player path only this version. Ally legacy path (`_initGenericJobPosePortraits` / `_buildGenericJobFullBodies` in sprite-init.js) still uses the old indices for jobs 3-21 — opponents/allies of those jobs will still glitch until that path is migrated to the bundle.

## 1.6.51 — 2026-05-01

### Fix: enemy actor name now appears before the swing lands (was lagging behind animations)

`battle-enemy.js _processEnemyFlash` and `pvp.js _runEnemyAttack` both queued the enemy's name AFTER the BOSS_PREFLASH_MS (133ms) preflash window — i.e. at the same instant the swing animation began. Combined with the message strip's 200ms fade-in, the player saw the hit land before the name finished fading in (often after the hit, depending on swing duration). This was especially noticeable on fast monster attacks.

The name is now queued at turn dispatch (`battle-turn.js`, the moment state transitions to `'enemy-flash'`). The 200ms fade-in starts immediately and overlaps the 133ms preflash, so the name is visible by the time the swing connects. Both regular monster attacks (looked up via `getMonsterName`) and PVP opponent / enemy-ally attacks (looked up via `pvpSt.pvpOpponentStats` / `pvpSt.pvpEnemyAllies`) route through the same call site.

Cleanup: `battle-enemy.js` and `pvp.js` no longer import `queueBattleMsg`/`getMonsterName`/`_nameToBytes` since they no longer queue messages directly.

## 1.6.50 — 2026-05-01

### Fix: typed chat messages now appear in the tab they were sent from

`onChatKeyDown` always called `addChatMessage(text, 'chat')` with no channel, which `addChatMessage` defaulted to `'room'`. The active-tab filter (`_passesTabFilter`) only renders messages whose channel matches the tab — so a user typing on the **World** tab pushed a `room`-channel message that was immediately filtered out, looking like nothing happened. Auto-chat already routed correctly (`'room'` for local, `'world'` for remote) so other people's chats still appeared, masking the bug.

The send path now maps `activeTab → channel`: World → `world`, Room → `room`, Private → `pm`, System → `room` (you can't post to system, so fall back).

## 1.6.49 — 2026-05-01

### Fix: PVP opponent attack message now matches the rest of the codebase ("Name" not "Name attacks!")

`pvp.js _runEnemyAttack` was the only `queueBattleMsg` site in the codebase that suffixed `' attacks!'` to the actor name. Player fight, player defend (`battle-turn.js`), ally attack (`battle-ally.js`), and regular enemy attack (`battle-enemy.js`) all queue just the bare actor name. PVP now matches.

## 1.6.48 — 2026-05-01

### Refactor: deleted second battle message UI; BATTLE_CANT_ESCAPE now uses queue strip everywhere

The codebase had two battle-context message renderers: the queued fade strip (`battle-msg.js`, used by hit names / attack lines / victory) and a second centered-bordered-box system (`'message-hold'` battle state + `battleSt.battleMessage` field + `drawBattleMessage` renderer in `battle-drawing.js`). The centered box had exactly one caller — boss/non-random escape failure — while random-encounter escape failure already used the queue strip for the same `BATTLE_CANT_ESCAPE` text. Same string, two visual treatments.

**Visual change:** boss-flee failure now shows the same fading strip as random-encounter flee failure. UX is now consistent across both encounter types.

Deletions:
- `drawBattleMessage()` and its caller in `battle-drawing.js`.
- `TEXT_WHITE_ON_BLUE` palette const (only used by the deleted renderer).
- `battleMessage` field on `battleSt` + its reset in `battle-update.js`.
- `CENTER_MSG_HOLD_MS = 1200` constant (was duplicated in `battle-update.js` and `pvp.js`).
- Dead `'message-hold'` handler in `pvp.js _updatePVPMenuConfirm` — was unreachable since the only setter lived in `battle-update.js` and PVP doesn't go through that path.

The state name `'message-hold'` is retained (still referenced by 4 draw guards that gate non-message rendering) but its semantics changed from "show centered box for 1200ms" to "wait for queue strip to drain, then re-open battle menu."

## 1.6.47 — 2026-05-01

### Refactor: battle message system tightening (no behavior change)

Cleanup pass on the three message UIs (battle queue strip, battle centered box, overworld slide box). All changes are equivalence-preserving — visuals and timing unchanged.

- **`message-box.js`**: added `dismissMsgBox()` so callers stop poking `msgState.state = 'slide-out'; msgState.timer = 0` from outside the module. `movement.js` and `input-handler.js` now go through the API.
- **`battle-msg.js`**: replaced the generic `setBattleMsgCurrent(v)` setter with a named `clearVictoryPersist()` that only clears messages flagged `persist: true`. The single caller (victory text-out) is more readable. Also dropped `MSG_TOTAL_MS` (exported, zero importers) and the now-unused `getBattleMsgQueue` export.
- **`battle-update.js`**: replaced two `!getBattleMsgCurrent() && getBattleMsgQueue().length === 0` guards with `!isBattleMsgBusy()` — equivalent given the invariant that current is null iff queue is empty.
- **`pvp.js`**: removed dead `if (queueBattleMsg && ...)` truthy check (ESM static imports are always truthy).
- **`message-box.js`**: dropped unused 2nd parameter from `drawMsgBox`; updated `game-loop.js` caller.
- **Constant disambiguation**: renamed `BATTLE_MSG_HOLD_MS = 1200` (locally defined in `battle-update.js` and `pvp.js`, governs the `'message-hold'` centered-box state) to `CENTER_MSG_HOLD_MS`, with a comment noting it's distinct from `battle-msg.js`'s `MSG_HOLD_MS = 800` (which times the queue strip's hold phase).

## 1.6.46 — 2026-05-01

### Fix: in-game console version banner now reads from `#version-badge` (was hardcoded)

`src/data/strings.js` previously hardcoded `VERSION = '1.6.44'` with a comment claiming "single source of truth (update here + package.json)" — which was the opposite of single-source. The in-game console banner (`'FF3 MMO v' + VERSION` rendered by `src/main.js`) had been silently lagging `package.json` for releases that bumped the version without also editing this file.

`VERSION` now reads from the server-substituted `#version-badge` div (which already gets `{{VERSION}}` replaced in `server.js`). Module scripts are deferred so the DOM is parsed before this evaluates. `package.json` is now the only place to bump.

## 1.6.45 — 2026-05-01

### Refactor: Monk ally render migrated to unified bundle path; dead legacy builder deleted

`_USE_BUNDLE_FOR_ALLY` now includes jobIdx 2 (Monk) alongside OK and Warrior, so Monk fake-player portraits + bodies flow through `_buildFakePlayerSet` → `getJobPoseTileBundle` (which has had a fully populated `_monkBundle` since the bundle abstraction landed). The Monk-specific legacy ally helpers (`_initMonkPosePortraits`, `_buildMonkFullBodies`) are now unreachable but kept for one release as a rollback safety net — pending visual verification.

Also deleted `_legacyInitBattleSpriteForJobInline` from `src/sprite-init.js` (327 lines). It was orphaned after `initBattleSpriteForJob` migrated to `_buildPlayerSpriteSet` and had zero callers anywhere in the codebase — comment claimed "preserved temporarily for fake-player builders that haven't migrated yet" but no caller existed. `src/sprite-init.js` is now 1156 lines (was 1484).

Opponent rendering (`initBattleSpriteForJob`) is already 100% on the bundle path for all 22 jobs unconditionally; ally is now {OK, Warrior, Monk} on bundle, generic 3-21 still on legacy (untriggered today since `boot.js` only initializes `[0, 1, 2]`).

## 1.6.44 — 2026-05-01

### Fix: PVP opponent L-hand back-swing missing on dual-wield

`_processPVPSecondWindup` set the wait for hand-change hits to `IDLE_FRAME_MS` (67ms), and `oppHandChangeGap` rendered idle body for that whole window — leaving no time for the back-swing. Dual-wield L-hand jumped straight from idle to fwd-strike.

Now: hand-change wait = `IDLE_FRAME_MS + BOSS_PREFLASH_MS` (armed) — 67ms idle gap, then 133ms back-swing pose with weapon raised. `oppHandChangeGap` only holds idle for the gap portion. Unarmed unchanged (no distinct back-swing pose).

## 1.6.43 — 2026-05-01

### Fix: PVP opponent (OK + Warrior) facing wrong way

`_renderFullBody` in `src/combatant-sprites.js` was missing the final h-flip that the legacy `_buildFullBody16x24Canvas` (sprite-init.js) ends with. Bundle-path jobs (OK = 0, Warrior = 1, per `_USE_BUNDLE_FOR_ALLY`) drew un-flipped, so the opponent body faced the wrong direction AND the swing-hand looked wrong — `pickAttackPoseKey({mirror:true})` already inverts L↔R assuming the canvas is pre-flipped, so a missing flip showed the opposite hand swinging. Monk used the legacy h-flipped builder and rendered correctly, which is what surfaced the bug.

`_renderFullBody` is consumed only by `buildOpponentBodyCanvases`, and those `*FullBodyCanvases` are PVP-only — player and ally portrait paths (`_renderPortrait`) are unaffected.

## 1.6.42 — 2026-04-29

### Slash effect render path centralized

`drawSlashOverlay(ctx, frame, frameIdx, originX, originY, mirror)` added to `src/slash-effects.js`. Owns the per-frame scatter pattern (`[0, 10, -8]` / `[0, -6, 8]`), the optional mirror transform (PVP opponent attacking the player/ally portrait), and the `drawImage` call. No-ops on a null frame so call sites stay terse.

Five non-player slash render sites now collapse to one `drawSlashOverlay(...)` line:

- `battle-drawing.js _drawPortraitOverlays` — PVP opponent slash on player portrait
- `battle-drawing.js _drawEncounterSlashEffects` — ally slash in random encounters
- `battle-drawing.js _drawBossSprite` — ally slash on boss
- `battle-drawing.js _drawAllyPortrait` — PVP opponent slash on ally portrait
- `pvp.js` PVP grid — ally slash on opponent

Player slash path (battle-update.js / battle-drawing.js:773, 867) intentionally not migrated — it has its own bladed-walk-off + random-punch scatter logic driven by `battleSt.slashOffX/Y` that's incompatible with the deterministic 3-position pattern. Same architectural split as `combatant-pose.js`: centralize where it makes sense, leave intentional differences alone.

No behavior change.

## 1.6.41 — 2026-04-29

### Fix: unarmed Monk dealing 2 damage after loading a save

`title-screen.js _updateTitleMainOutCase` was calling `recalcCombatStats()` BEFORE assigning `ps.jobIdx` from the save slot. On save-load, `ps.jobIdx` is still the default 0 (Onion Knight) at recalc time, so `isMonkClass = (jobIdx === 2 || 13)` evaluates false and the unarmed Monk/BlackBelt ATK formula in `calcAttackerAtk` is skipped. Result: `ps.atk = rWpnAtk + lWpnAtk = 0`, both unarmed hands roll `calcDamage(0, def)` → clamped to 1 each → 2 total damage regardless of level.

Fix: move the `recalcCombatStats()` call past the `ps.jobIdx` assignment. New character flow (no slot) is unchanged — recalc still gated on `if (slot)`.

Verified by simulating the path in `battle-math.js`: `isMonkClass=false` + unarmed yields exactly the totals the user reported (`[2,2,2,2,2]`).

## 1.6.40 — 2026-04-29

### Battle sprite consistency audit

No behavior change — cleanup of two fragile patterns surfaced by an audit of the three render paths (player / ally / PVP opponent).

- **`src/pvp.js`** — corrected the comment block above the opponent body-canvas selection. Old text ("pre-h-flipped canvases face left" / "opponent faces left") contradicted the canonical wording in `combatant-pose.js:25` and `pvp.js:704` ("face-right pre-flipped canvas"). New comment cites `pickAttackPoseKey` + `mirror:true` as the source of truth for the L↔R cross.
- **`src/combatant-sprites.js`** — `_okBundle` now derives `jobBase = BATTLE_SPRITE_ROM + 0 * BATTLE_JOB_SIZE` and uses it for the OK hit-tile reads, instead of using `BATTLE_SPRITE_ROM` directly. Mathematically identical, but a future copy-paste (e.g. `_warriorBundle` / `_monkBundle`) won't silently read OK's hit tiles.

### Audit findings (no fix needed)

All three render paths route through `combatant-pose.js` (`pickAttackPoseKey`, `pickAttackWeaponSpec`) and `combatant-sprites.js` (`getJobPoseTileBundle`). Hand alternation, wind-up skip, unarmed pose selection (rBack/lFwd), fist offset (-4, +10), blade offsets (R+8 / L+16 / fwd-16), and the PVP-opponent mirrored `drawBlade()` transform are all consistent across player, ally, and opponent.

## 1.6.12 — 2026-04-23

### Monster stats — regenerated from ROM (fixes 3a54feb corruption)

- **`src/data/monsters.js`** regenerated via `tools/gen-monsters-js.js`. All 230 monsters now match `tools/rom-dump-monsters.txt` exactly. Fixes 224 inflated ATK values (Goblin 10→5, Werewolf 15→9, Berserker 20→10, …) and `attackRoll` values from commit `3a54feb`, and restores 16 missing `hp:` fields (Larva, Unei Clone, Darkface, Cuphgel, Lemur, Twin Heads, Twin Liger, Demon Horse, Saber Liger, Queen Lamia, KingBehemth, Abaia, Haokah, Archeron, Amon, Gomory).
- **`tools/gen-monsters-js.js`** now also emits `spiritInt` (ROM byte 7) and `statusResist` (ROM byte 13) — both were being read but discarded. `statusResist` array order normalized high-bit-first.
- **`docs/design-notes.md`** — removed the "Known broken data" block; added a short monster-data section pointing at the regen command.

## 1.6.11 — 2026-04-23

### Monk job — sprites, palettes, integration (end-to-end)

Added Monk (jobIdx 2) as a first-class playable job. All 9 battle poses PPU-captured and wired.

- **`src/data/monk-sprites.js`** — new file. PPU-dumped tile data for Monk: idle, R-back swing, R-fwd swing, L-back swing, L-fwd swing, hit flinch, kneel, victory (arms-up), death (24×16 prone). Shared legs de-duped across poses where bytes match.
- **`src/sprite-init.js`** — `_initMonkPosePortraits()` and `_buildMonkFullBodies()` dispatched from `initFakePlayerPortraits(romData, jobIndices)` when jobIdx === 2. Per-job battle-palette override `JOB_BATTLE_PAL_OVERRIDE[2] = [0x27, 0x18, 0x21]` (orange skin / olive hair / blue gi).
- **`src/job-sprites.js`** — `MO_WALK_TOP`/`MO_WALK_BTM` overworld walk palettes added, wired into `JOB_WALK_PALS[2]`.
- **`src/data/players.js`** — `MONK_PALETTES` pool (8 variants) — fixed skin/hair, varying gi color across palIdx slots. Used by `_genPosePortraits` for fake Monks.
- **`src/debug/tabs/sprites.js`** — Konami debugger POSES view now loads 9 MO entries from `data/monk-sprites.js` (previously ROM-offset math, moved to canonical).

### Nunchuck weapon — sprite, hit-effect, loot drop

- **`src/weapon-sprites.js`** — `NUNCHAKU_TILES` (PPU-captured $49/$4A/$4B/$4C diagonal chain). `initWeaponSprites` builds `nunchakuRaised` + `nunchakuSwung` canvases using the same raised-vs-swung tile-swap pattern as sword/knife. Accessors + `getBlades().nunchaku`.
- **`src/battle-drawing.js`** — added `wpnSt === 'nunchaku'` branches to all 6 weapon render paths (player R/L back/fwd, ally R/L back/fwd).
- **`src/pvp.js`** — `drawBlade` routes nunchaku through the same wind-up/swung canvas selection.
- **`src/slash-effects.js`** — `initNunchakuSlashSprites()` (tiles $4D/$4E/$4F/$50) for the on-target hit-flash. Reused across all 3 slash timing slots since the tile bytes don't animate (position moves via existing `slashOffX/Y` scatter).
- **`src/battle-sprite-cache.js`** — `nunchakuSlashFramesR/L` added; `getSlashFramesForWeapon` dispatch handles `'nunchaku'`.
- **`src/data/players.js`** — 5 Monk fake-player entries added (Kasumi, Jiro, Ryuji, Hana, Tetsuo). 2 equipped with Nunchuck (0x06), 3 unarmed (fists); mixed across cave-0/ur/cave-1/cave-2/world/camper.
- **`src/map-triggers.js`** — F2 Altar Cave uncommon pool adds Nunchuck (0x06) alongside Dagger.

### Fighter / OK L-back pose fix — head-TR was never swapping

A multi-year bug: whenever a character did a left-hand back-swing, all callers passed `idleTiles[1]` for the head-TR slot instead of the L-back variant. The pose data was partially right (body-TR swapped) but visually the head read as idle. Re-capture proved:

- `WR_L_BACK[1]` (head-TR $3F) was wrong — held idle bytes. Replaced with canonical L-back bytes. Also corrected `WR_L_BACK[3]` body-TR bytes (old bytes didn't match any ROM-extracted pose) and fixed `WR_LEG_L_BACK_L` byte 8 (`0x06 → 0x07`).
- `OK_L_BACK_SWING[1]` last-byte single-bit fix (`0xED → 0xEC`) to match the L-back head-TR variant.
- `src/sprite-init.js` — 4 consumer sites updated to pass `_FP_KNIFE_L[1]` / `WR_L_BACK[1]` for head-TR instead of idle: `_initBattleAttackSprites`, Warrior `_initBattleSpriteForJob`, `_initWarriorPosePortraits`, `_buildWarriorFullBodies`, `_initFakePosePortraits` (OK `fakePlayerAttackLPortraits`), OK `_initBattleAttackSprites` overlay path.

### Generic ROM-based pose builder for jobs 3–21

Previously the 19 non-starter jobs (White Mage, Black Mage, Red Mage, …, Ninja) in `initFakePlayerPortraits` fell through to the Warrior placeholder, so all of them visually rendered as Warriors. Replaced with a generic ROM-keyed builder that reads each job's own `jobBase` block and bakes in the pattern: defend === victory === magic-cast, L-back swaps BOTH head-TR (tile 6) AND body-TR (tile 7), death placeholder until PPU-captured.

- **`src/sprite-init.js`** — `_initGenericJobPosePortraits()` + `_buildGenericJobFullBodies()`. The same head-TR swap fix was also applied to the `initBattleSpriteForJob` generic ROM path that runs for the player's own battle canvas when switching to any of these jobs.
- **`src/boot.js`** — `initFakePlayerSprites(rom, [0, 1, 2])` (up from `[0, 1]`) so Monk portraits build at boot.

### Defend / magic-cast consolidated under victory

In canonical FF3 all three poses (guard, item-use, spell-cast) share the same 4-tile arms-up stance as victory. The OK battle sprite init held a duplicate `DEFEND_TILES` byte array that was identical to `OK_VICTORY`. Removed the copy — everything now references `OK_VICTORY` directly. Warrior + generic-ROM paths already used `victoryTiles` for defend; added a comment in each so the invariant is clear.

### Game Over flow — death no longer grants rewards, dedicated HUD box

When you died but allies finished the fight, the existing flow was granting EXP/gil/CP (and the level-up `fullHeal()` was auto-reviving KO'd players, masking the death from the end-of-battle respawn check). Reworked:

- **`src/battle-update.js`** — 3 reward-grant sites (monster-death, `_triggerPVPVictory`, `_updateBossDissolve`) now gate on `ps.hp > 0`. When KO'd, the victory flow is skipped — goes straight to `encounter-box-close` / `enemy-box-close` with all reward counters zeroed.
- New `'game-over'` battle state. `encounter-box-close`, `enemy-box-close`, and `defeat-close` (team-wipe) now transition here when `ps.hp <= 0` instead of directly respawning.
- `TRACKS.GAME_OVER = 0x2B` ("The Requiem") plays on game-over entry.
- `respawnFromGameOver()` exported — called from `input-handler.js` when Z is pressed during `'game-over'`. Routes back through `_respawnAtLastTown()` (HP/MP restore, wipe to `ps.lastTown`).
- **`src/battle-drawing.js`** — `_drawGameOver()` renders a small bordered HUD box (96×40) centered in the battle viewport with "GAME OVER" text and a blinking "Press Z" prompt. Overworld/roster continue to render behind it.

### Level-up no longer restores HP

`grantExp()` used to `fullHeal()` on level-up, which (a) auto-revived KO'd players mid-battle and (b) was not canonical FF3 behavior. Removed the call. Current HP is preserved; maxHP still grows as normal. The Game Over flow above depends on this.

### Save sync diagnostics

- **`src/save-state.js`** — `serverSave` / `serverLoadSaves` errors now log to console (`[save] server sync failed …`) instead of being silently swallowed.
- On load, if the server responds but every slot is null, fall back to IndexedDB instead of clobbering local saves with the empty server response.

### Known bug — monster ATK / attackRoll values are inflated vs ROM

Discovered during Werewolf damage testing: `tools/rom-dump-monsters.txt` (an independent ROM extractor) disagrees with `src/data/monsters.js` on most ATK values. Goblin ROM=5/ours=10; Werewolf ROM=9/ours=15; Berserker ROM=10/ours=20; Zombie ROM=12/ours=25; etc. Commit `3a54feb` on 2026-04-10 claiming to "Fix all 231 monster ATK and attackRoll values from ROM stat tables" actually decoded the NES stat-set index bitmask incorrectly and shipped inflated values. **Not yet fixed in 1.6.11 — scheduled as a follow-up; the ROM dump is the source of truth.**

## 1.6.10 — 2026-04-22

### Chest loot pools — per-map + floor tiers + gil

Chest loot was a single global 4-tier table regardless of where the chest lived — same odds in the starter town as in the final floor of the first dungeon. Also, SouthWind was sitting at the 2% legendary slot in every chest, which made it cheap to farm.

- **`src/map-triggers.js`** — `LOOT_POOLS` keyed by `mapId`. Ur (114) drops potions/antidotes/gil only; Altar Cave F1–F4 (1000–1003) scale from consumables + Leather Cap to Bronze Bracers + Longsword with gil ranges growing 20–60 → 125–275. Unlisted maps fall back to the F1 pool. Crystal room (1004) is a boss room and has no chests.
- **Gil entries** — pool entries of shape `{ gil: [min, max] }` roll a random amount into `ps.gil` and show "Found N gil!" via the existing message box.
- **`src/data/monsters.js`** — Land Turtle drops reduced from `[0xA6, 0xB2]` to `[0xA6]`. SouthWind no longer in any chest pool, so it's now obtainable only via the late-game monster drops that canonically carry it (Darkface, Parademon, Crocotta, Lemur).
- **`docs/design-notes.md`** — updated the loot section to reflect per-map pools, gil entries, and SouthWind sourcing.

## 1.6.9 — 2026-04-22

### Ally-won victory no longer strands dead player at 0 HP

When the player died but allies finished the battle, the victory flow ran (`monster-death` → `victory-*` → `encounter-box-close`) and dumped the player back to the overworld with `hp = 0`. Death respawn only fired from `team-wipe → defeat-close`, which requires *everyone* down.

- **`src/battle-update.js`** — extracted `_respawnAtLastTown()` (HP/MP restore + wipe to `ps.lastTown`). Called from `encounter-box-close` / `enemy-box-close` when `ps.hp <= 0`, plus `defeat-close` (dedup of the inline block).

### Victory box text overflow

Audit: item-drop and job-level-up text was drawing outside the 120 px victory box. Worst cases: `Found MythrilShield!` = 144 px; `ONION KNIGHT LV 99!` = 152 px. Neither actually reached the ally HUD (ally column starts at x=144, worst-case text end x=136) but broke the bordered-box frame visually.

- **Item drops** now stack 2 rows: "Found" top, "`{item}!`" bottom. Max line width 96 px, both well inside the box.
- **Job level up** uses static "Job Level Up!" (104 px) instead of `{JOBNAME} LV {lv}!` (up to 152 px).
- `src/data/strings.js` — new `BATTLE_FOUND`, `BATTLE_JOB_LEVEL_UP`.
- `src/text-utils.js` — `makeFoundItemText(id)` replaced by `makeItemDropText(id)` (returns `{name}!` only). Removed dead `makeJobLevelUpText` and its `JOBS`/`ps` imports.
- `src/battle-drawing.js` — `_drawRewardText` stacks 2 rows for item drops, single row for the rest.

### Docs cleanup

- `README.md` — reconciled multiplayer status (roster is simulated from a fake player pool, not online); pruned the per-file architecture listing (100+ lines) to a concern-grouped overview. Networked multiplayer is planned — see `MULTIPLAYER.md`.
- `REFACTOR.md` → `docs/history/REFACTOR.md` (completed, archived).
- `AUDIT-LOOT.md` retired — bug fixes already captured in 1.6.0, design notes moved to `docs/design-notes.md`.

## 1.6.8 — 2026-04-19

### Monster magic damage formula — caster stat + variance

NES magic damage (`31/B17C`) uses:
```
atk = floor(caster_INT / 2) + spell_power
dmg = atk + rand(0..atk/2) - mdef
```

Ours was a flat `power - mdef`. That ignored the caster's INT entirely, so endgame mages were dealing ~150 flat damage instead of 300+. The `spiritInt` byte (ROM $60010 byte 7) existed in the gen script but was never written to `monsters.js` — same class of omission as `statusResist`.

- **`monsters.js`** — 110 of 231 monsters now have `spiritInt` field (values 17–255). Low-level mages around 17–34, bosses and endgame casters 150–255.
- **`battle-encounter.js`** — propagates `spiritInt` onto spawned monster instances.
- **`battle-enemy.js`** — magic damage recalculated per NES: `atk = floor(mon.spiritInt/2) + spec.power`, then `atk + rand(0..atk/2) - mdef` × elemMult, min 1. Applied to both ally-target and player-target paths.

### Ally shield evade

`generateAllyStats()` now exposes `shieldEvade` from the equipped shield. Previously allies with Leather Shield were dropping it in the void; monster physical attacks against allies bypassed the block roll entirely.

- **`src/data/players.js`** — returns `shieldEvade`.
- **`src/battle-enemy.js`** — monster→ally physical attack now passes `ally.shieldEvade` and `ally.evade` into `rollMultiHit`.

## 1.6.7 — 2026-04-19

### Player / ally armor status immunity wired up

Armor items have `sResist` bitmasks (ROM byte 3) that nothing was checking. A Ribbon (`sResist: 0xFE`) was cosmetic.

- **`src/player-stats.js`** — `recalcCombatStats()` now OR's all equipped armor `sResist` bytes into `ps.statusResist` (bitmask). Recomputed on equip change.
- **`src/data/players.js`** — `generateAllyStats()` builds the same bitmask for allies' armor/helm/shield.
- **`src/battle-enemy.js`** — all 4 player/ally `tryInflictStatus` calls now pass the target's `statusResist`. Monster `statusAtk` on physical hit and monster special-attack status both respect immunity.

`tryInflictStatus()` already accepted numeric bitmasks from the monster-side fix in 1.6.5, so no status-effects.js change.

## 1.6.6 — 2026-04-19

### Poison tick — match NES exactly

Battle poison damage was `max(1, floor(maxHP / 16))`. NES (`35/BADC-BB1E`) uses `floor(maxHP / 16)` with no minimum clamp, so tiny enemies with <16 maxHP take 0 poison damage. The `max(1, ...)` clamp was killing small monsters over time in situations NES would leave them alone.

Walk poison (`-1 HP per step, min 1 HP`) already matched NES `3B/A0B1-A10D` exactly.

## 1.6.5 — 2026-04-19

### Monster status resistance (ROM data wired up)

`tools/gen-monsters-js.js` read byte 13 of each monster record as `statusResist` but never wrote it to `monsters.js`, so every monster was equally vulnerable to every status — bosses included.

30 of 231 monsters have NES status-immunity bits:
- 26 resist Toad (mostly undead, zombies, dragons, bosses)
- 6 resist Paralysis (including Unei Clone and 2 end-game bosses)
- 2 resist both Paralysis + Toad
- 1 resists Petrify

Now added to `monsters.js` as `statusResist: 'toad'` / `['paralysis','toad']` / etc.

- **`src/status-effects.js`** — `tryInflictStatus()` accepts optional `resist` (name, array, or mask); auto-fails if flag matches.
- **`src/battle-encounter.js`** — propagates `statusResist` onto spawned monster instances.
- **`src/battle-update.js`** — weapon on-hit status passes `targetMon.statusResist` (player → monster).

Player-side status immunity from armor `sResist` is tracked on items but not yet aggregated or applied — flagged for follow-up.

## 1.6.4 — 2026-04-19

### Monster special attacks — power/hit corrected from ROM

Seven entries in the hardcoded `SPECIAL_ATTACKS` table in `battle-enemy.js` diverged from the NES spells data (`spells.js`, generated from ROM `$618D0`):

- **Fira** 60 → 55, **Bzzara** 60 → 55, **Thundara** 75 → 55 — damage spells off by 5–20.
- **Bzzaga** 130 → 85 — 1.5× too strong.
- **Sleep** hit 60% → 15% — Sleep was landing 4× more often than NES.
- **Confuse** hit 60% → 25% — same issue.
- **Silence** hit 80% → 60%.

All 231 monster `spAtkRate` values are ROM-clean, no changes needed there.

### Armor audit — 1 item fixed

- `0x97 CrystalGlove` had `def/evade/mdef: undefined` — now `10/15/10` per ROM. `tools/extract-all.js` armor loop stopped at 0x96 and skipped it.

All 85 weapons and 64 armor items (after this fix) now match ROM at `$61410`.

## 1.6.3 — 2026-04-19

### Per-job crit rate and crit bonus (ROM-verified)

Our combat used a fixed 5% crit chance and a derived `atk/4` crit bonus. NES (`39/BB1A` job modifiers table, 5 bytes per job) specifies both values per-job:

- **Crit rate**: 0–5% depending on job. White Mage and Bard never crit; Black Belt and Ninja crit 5%.
- **Crit bonus**: flat 1–100 added on a crit. Bard = +1 (almost cosmetic), Ninja = +100 (big spike).

Fixes: mage/bard jobs were critting too often, warrior jobs were critting with a damage bonus disconnected from their weapon style, Ninja was underpowered on crits.

- **`src/data/jobs.js`** — added `critPct` and `critBonus` fields to all 22 jobs from ROM `$73B2A`.
- **`src/battle-math.js`** — `rollHits` now reads `critPct` and `critBonus` from `opts`. Fixed `CRIT_RATE` constant removed.
- **Call sites updated** (`input-handler.js`, `battle-turn.js`, `pvp.js`): pass the attacker's job crit values on each attack. Monsters pass 0/0 (they don't crit in our system, matching NES default behavior).

### Stat cap on level-up

NES caps each stat at 99 on level-up (`35/BF92`). Our `grantExp` and `changeJob` were incrementing stats without a cap. Added `Math.min(99, ...)` to STR/AGI/VIT/INT/MND updates.

## 1.6.2 — 2026-04-19

### Job switch cost formula rewritten (CRITICAL)

Byte 0 of each job record at ROM `$72010` was mislabeled as `cpCost` by `tools/extract-all.js` and that mislabel propagated into `src/data/jobs.js`. The byte is actually **alignment** — high nibble = physical/magical index, low nibble = lawful/chaotic index.

The NES computes job change cost dynamically from the alignment vector between the *current* and *target* jobs (disasm `3D/AD85`):

```
cost = (|physDiff| + |chaosDiff|) * 4 - newJobLevel, min 0
```

Our old formula charged a fixed per-target value (40–255) that didn't depend on the current job at all. Every cost was 3–20× too high. Example from Onion Knight starter:

| Target | Old (fixed) | New (alignment-based) |
|---|---|---|
| Fighter / Monk / White Mage / Black Mage / Red Mage | 121–153 | 7–8 |
| Knight / Thief / Scholar | 117–170 | 15 |
| Black Belt | 40 | 23 |
| Sage | 255 (capped) | 55 |
| Ninja | 0 (bug) | 63 |

Ninja was effectively free because its alignment byte is `0x00`; now it correctly costs ~60 CP from a neutral-aligned job. The whole job economy is now NES-calibrated.

- **`src/data/jobs.js`** — `cpCost: N` → `alignment: 0xXX` (same byte, correct label) across all 22 jobs.
- **`src/player-stats.js`** — `jobSwitchCost()` computes the NES formula; uses current job's alignment.
- **`tools/extract-all.js`** — prints `Align:0xXX (phys:N chaos:N)` instead of the mislabeled `CP:`.

## 1.6.1 — 2026-04-19

### Monster ATK outliers fixed (ROM-verified)

Six monsters had ATK values 3.75-5x their ROM counterparts — typos that survived the 2026-04-09 audit. Restored to ROM values from `$61010` stat table:

- **Killer Bee** (Lv2, Altar Cave): 50 → 10 — was one-shotting starters (~150 dmg × 3 hits)
- **Revenant** (Lv6, Cave of Seal): 50 → 10
- **Helldiver** (Lv6, Summit Road): 50 → 10
- **Mandrake** (Lv5, dummied): 60 → 16
- **Petit** (Lv3, Nepto Shrine): 60 → 16 — was the highest-ATK low-level monster
- **Poison Bat** (Lv10, Nepto Shrine): 60 → 16

Remaining monster ATK values are intentionally scaled (median ~0.69× ROM for high-level, ~1.5-2× for low-level single-player balance). `hitRate` verified 231/231 matching ROM; `attackRoll` is deliberately capped at 2-3 (ROM goes up to 11).

### Defeat respawn system

Replaces the prior "teleport to nearest world tile" defeat flow — which could dump you at Ur's entrance after an overworld encounter far from town, or cause stale `currentMapId` state after dungeon wipes.

- **`ps.lastTown`** (defaults to 114 / Ur) tracks the most recent town visited. Updated whenever the player enters a map in `AREA_NAMES`.
- **On team wipe**: HP/MP restore to max, `mapStack` cleared, player respawns at the entrance of `ps.lastTown` via `loadMapById()`.
- **Save persistence**: `lastTown` is written to save slots and restored on game load.
- **Fixes data-loss gap**: defeat-close now calls `saveSlotsToDB()`, so tab-close immediately after a wipe no longer loses the HP/MP restore.
- Currently only Ur (114) is in `AREA_NAMES`, so all defeats respawn in Ur. Mechanism auto-extends as Kazus / Canaan / etc. are added.

This diverges from NES FF3 (which jumps to `$C000` / program start on defeat — a hard reboot to title for save reload). That model doesn't fit a continuously-auto-saving MMO, so we use a home-town respawn pattern instead.

### Dead code removed

- `findWorldExitIndex`, `loadWorldMapAt`, `loadWorldMapAtPosition` no longer imported by `battle-update.js` — defeat flow no longer uses them.

## 1.6.0 — 2026-04-18

### Shared-bag refactor — all 14 bags eliminated

- **State modules extracted** — `battle-state.js`, `battle-sprite-cache.js`, `hud-state.js`, `map-state.js`, `ui-state.js`. Consumers import the state object directly; no more `shared` parameter threading.
- **`fake-player-sprites.js`** — fake player canvases extracted from game.js (Step 1 of shared-bag refactor).
- **`battle-update.js` (732L)** — entire battle state machine (opening, attack chain, defend/item, run, boss dissolve, victory, defeat, PVP) extracted from game.js.
- **`movement.js` (260L)** — player movement, input dispatch, tile collision, action handling extracted. Pre-existing `MapRenderer` / `resetIndoorWaterCache` import bug fixed in `_checkFalseWall`.
- **`title-screen.js`** — `updateTitle` + `_updateTitleMainOutCase` merged in, sharing a `waterSt` ref with game.js for animation continuity.
- **game.js: 1,920L → 912L** (52% reduction). Target <4,000L achieved.

### Battle pose audit

- **Konami debugger** now the documented source of truth for pose correctness.
- **OK main `lFwd` canvas** — was null, now built from `[idle0, idle1, OK_L_FWD_T2, OK_L_FWD_T3]`. L-forward swings no longer fall back to L-back pose.
- **OK main `rFwd` canvas** — was loading garbage from ROM offset 18 (leg tiles), now built from idle tiles per debugger (R-fwd body = idle, legs-only animation).
- **OK PVP `KnifeRFwd` LEG_L** — `_FP_LEG_L_BACK_R` → `_FP_LEG_L` (idle).
- **Warrior ally attack portraits** — now use R_BACK_T2 / L_BACK[3] tiles matching main player + OK ally conventions (were all-idle / L_FWD).
- **`_FP_ATK_R_TILE`** — was aliased to `OK_R_FWD_T2` which had been "fixed" to idle T2; now correctly points to `OK_R_BACK_SWING[2]`. Restored R-back swing visual.
- **Konami debugger** — updated Warrior R-FWD LEG_L to `WR_LEG_L_FWD_R` to match code (debugger was stale since commit `e2e401d`).

### Battle message system

- **`battle-msg.js`** extracted. `replaceBattleMsg` swaps text mid-action for crits, hit count, status inflictions, spell names.
- **Phase 1**: "Attacker : Target" format for player/monster/ally turns.
- **Phase 2**: crit/hits/status result text replaces Phase 1.

### Combat fixes

- **ATK formula** — weapon power only. STR/AGI affect hit count not damage (NES disasm 30/9F44).
- **All 231 monster ATK + attackRoll** corrected from ROM stat tables.
- **Starting equipment** fixed to Knife(0x1E) + Leather Cap + Cloth Armor (matches NES).
- **Ally slash timing** — 3 frames fit in 90ms `ALLY_SLASH_MS` (was 67ms/frame, frame 2 never shown).
- **Ally slash hand/weapon** — now uses correct hand and weapon (was always right-hand + `weaponId`).
- **7 game-logic bugs** fixed: confusion targets any combatant, mini/toad ATK, per-hit shield/evade, special attacks on allies, ally poison floor.
- **EXP display** — victory screen now shows post-/4 value (matching actual gain).
- **Monster turn order** — level-based AGI proxy (`agi = level`).

### Other

- **Play time tracking** — `ps.playTime` ticks in game loop, persisted in saves, shown HH:MM on player select.
- **Victory rewards** — shown in enemy name box, save fix, chat clear.
- **PVP fixes** — `drawBossSpriteBoxPVP` stale null arg, `pvp.js` invalid LHS assignments, `drawBattleMessageStrip` stale `_s` reference.

---

Pre-1.6.0 history (1.5.0 → initial commit) is archived at [docs/history/CHANGELOG-pre-1.6.md](docs/history/CHANGELOG-pre-1.6.md).
