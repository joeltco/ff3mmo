# Changelog

All notable changes to this project are documented here.

## 1.7.159 — 2026-05-09

### fix: more unguarded gridPos lookups in battle drawing

v1.7.156 added an `if (pos)` guard at one of three identical crash sites; missed the other two. Same root pattern: `const pos = gridPos[X]; pos.x` with no null check, throws when the index drifts out of `gridPos` (monster died mid-frame, encounterMonsters / gridPos length mismatch). The throw inside `try/catch` at `game-loop.js:153` skips the rest of the battle/chat/menu/ally draw block, so HUD + roster portraits + chat all vanish until the bad state passes.

Sites fixed:
- `_drawEncounterSlashEffects:1160` — player-slash on a dying monster.
- `_drawEncounterMonsters:1133` — main monster loop, gridPos / encounterMonsters length mismatch.
- `_encounterMonsterPos:1820` — already had a `safeIdx < gridPos.length ? idx : 0` clamp, but `gridPos[0]` is still undefined when gridPos is empty. Returns a safe `{ bx: 0, baseY: 0 }` zero-position now instead of crashing the caller (`_drawBossDmgNum`, `_drawEnemyHealNum`).

Audit-grep ran across all `gridPos[...]` lookups in `battle-drawing.js`; remaining sites either had pre-existing guards (`if (pos)`, `if (idx >= gridPos.length) return null`) or are inside the `_encounterGridLayout` builder itself.

Lesson saved to memory: when fixing a pattern bug, grep ALL occurrences in the same file before declaring the fix done; one-site fixes leak when the same anti-pattern was copy-pasted.

## 1.7.158 — 2026-05-09

### fix: enemy death from ally offensive cast

Confirmed the analogous bug in the other direction — when a roster ally BM/RM landed a kill spell on an encounter monster or PVP enemy, the target sat at 0 HP with no death animation. If it was the last living enemy, the battle never transitioned to victory because the all-dead check (`battle-update.js:521` for encounter, `advancePVPTargetOrVictory` for PVP) only fires from `monster-death` / `pvp-dissolve` state — and the ally cast pipeline went straight to `_processNextTurn` instead.

Added kill detection at the end of `_updateAllyMagicCast`'s hit phase, mirroring `spell-cast.js:_finishMagicHit`:
- `targetType === 'enemy'` + `encounterMonsters[idx].hp <= 0` → set `dyingMonsterIndices` + transition to `'monster-death'` + `MONSTER_DEATH` SFX + replace strip with `BATTLE_SLAIN`.
- `targetType === 'pvp-enemy'` + `pvpOpponentStats` or `pvpEnemyAllies[idx-1]` at 0 HP → set `pvpDyingMap` + transition to `'pvp-dissolve'` + same SFX/strip.
- Otherwise fall through to `_processNextTurn` as before.

Skips the next-turn call when routed to death so the death-state animation timer drives the next transition. Existing encounter-victory (`monster-death` state) and PVP-victory (`advancePVPTargetOrVictory` from `pvp-dissolve`) paths handle "all enemies dead" correctly without further changes.

## 1.7.157 — 2026-05-09

### fix: roster ally death on PVP enemy spell

PVP enemy casting Fire / Blizzard on a roster ally dropped the ally's HP to 0 but didn't trigger the death animation or pull them from the turn queue. The ally kept standing, the game still handed them turns, and the only visible effect was a damage number followed by silence.

Mirrored the death hookup the SouthWind opponent path uses (`pvp.js:816`): after damage application, if `partyIdx >= 0 && ally.hp <= 0 && ally.deathTimer == null`, set `ally.deathTimer = 0` and filter the ally out of `battleSt.turnQueue`. Player KO (partyIdx === -1) is unaffected — the existing top-level death timer in `hudSt` handles it.

Did NOT extend the same fix to ally-cast → enemy KO (encounter monster or PVP enemy ally not dying when an ally BM/RM lands a kill spell on them) because the user didn't report it; will land separately if/when needed. The state-machine path for player-cast enemy KO is its own thing (`spell-cast.js:722` transitions to `monster-death`); ally-cast doesn't have that state transition wired today.

## 1.7.156 — 2026-05-09

### fix: encounter cursor crash + in-game error surface

**Battle HUD vanishing.** `_drawEncounterCursors:1180` crashed every frame when `inputSt.targetIndex` drifted out of `gridPos` (monster died mid-frame, sticky targetIndex from a previous encounter). The throw was caught by `game-loop.js`'s `try/catch` around the battle/chat/menu/ally draw block, but everything below the crash in that block — `drawBattle`, `drawSWExplosion`, `drawSWDamageNumbers`, `drawChat`, `drawMsgBox`, `drawRosterMenu` — got skipped. From the user's POV, "battle HUD and everything in it disappears." Static HP top-box (rendered by `drawHUD`, which runs before the try block) survives. Added the same `if (pos)` guard the item-target branch already had.

**`_reportError` now surfaces in the in-game chat console (dev-gated).** First occurrence of any unique `tag::message` shows immediately; repeats are silenced for 60 hits then re-show with a counter (`(x60)`). Includes the first `/src/<file>.js:<line>` frame from the stack so you can identify the bad draw fn without SSH or browser dev tools. Pre-existing `/api/client-error` POST still fires (kept for prod analytics + `pm2 logs`).

Caught via `pm2 logs server --err` — same `[BATTLE DRAW ERROR] can't access property "x" of undefined / pos is undefined` repeating every frame at `target-select` state. Lesson: when a HUD-vanishes-mid-battle bug happens, the error logs are already piped to `/api/client-error` → pm2; tail those over SSH instead of asking the user to grab browser console.

## 1.7.155 — 2026-05-09

### fix: PVP cast windup duration + respawn outside dungeon

**PVP-enemy cast windup truncated.** `PVP_MAGIC_CAST_MS` was hardcoded to 600 ms, same root cause as the ally cast bug fixed in 1.7.153 — the BM/RM halo + flame size-cycle ($51-$57 paired pulse) couldn't complete a full pulse. Bumped to `CAST_PHASE_MS_THROW.buildup` (800 ms). Cast renderers in `pvp.js:1131` and `pvp.js:1211` were already wired through `drawCasterCastBehind` / `drawCasterCastFront`; only the duration was wrong.

**Respawn rule simplified.** Death always lands on the world map at the last overworld exit point (`ps.lastWorldExitX/Y`) regardless of where you died. Previously: dying not-on-overworld respawned you at the *current map's entrance tile*, which for dungeons meant respawning *inside* the cave at floor 1's interior entry — felt like progress retained when really HP/MP just got restored. Now dying in Altar Cave dumps you outside the cave on overworld; dying in a town dumps you outside the town on overworld; dying on overworld dumps you at the last structure exit. Fallback to `ps.lastTown` (Ur) if `lastWorldExitX/Y` was never set (fresh save died on first encounter).

## 1.7.154 — 2026-05-09

### chore: drop catalog line from startup console

Removed the `Catalog: N items, M monsters, K spell anims` line from the boot message. Dropped the now-unused `ITEMS` / `MONSTERS` / `getRegisteredSpellAnimCount` imports from `main.js`.

## 1.7.153 — 2026-05-09

### fix: ally cast windup duration matches player

`ALLY_MAGIC_CAST_MS` was hardcoded to 600 ms; the player's thrown-spell buildup is 800 ms (`CAST_PHASE_MS_THROW.buildup`). The BM/RM halo + flame size-cycle ($51-$57, paired pulse) didn't have time to complete a full pulse, so the cast windup looked truncated for ally casts. `_allyCastContext` was also clamping `elapsed` to 600 ms on the draw side, which would have cut the cycle off even with a longer state.

Fixed both: `ALLY_MAGIC_CAST_MS = CAST_PHASE_MS_THROW.buildup` (800), and `_allyCastContext` clamps to the same constant. The cast halo + flame now play through their full pulse before the projectile fan begins.

The shipped renderers (`_drawAllyCastAnimBehind` / `_drawAllyCastAnimFront` in `battle-drawing.js`, dispatching to `drawCasterCastBehind` / `drawCasterCastFront` from `cast-anim.js`) already pass `ally.jobIdx` and `battleSt.allyMagicSpellId` through, so BM and RM both resolve to the right cast bundle (`jobToCastKey`) for offensive casts. No code change needed there — only the timing.

## 1.7.152 — 2026-05-09

### docs: fix wrong comment in ally cast renderer

`_drawAllyOffensiveCast`'s comment claimed Sleep had no on-target bundle. Wrong — `spell-anim.js:406` registers `0x33: { kind: 'burst-strip-2frame', frames: sleepImpact, width: 48, height: 48 }`. Sleep already renders correctly through the same `drawSpellEffectAtTargets` dispatch. Fixed the comment to match reality. No code change.

## 1.7.151 — 2026-05-09

### fix: ally offensive cast spell animations

v1.7.150 shipped BM/RM ally AI casts that applied damage but didn't render the on-target spell anim — a half-done deferral that should have been part of the same change. The bundles already exist (Fire/Bzzard/Sleep are wired for player casts and PVP-enemy casts); just needed a third draw site.

**`_drawAllyOffensiveCast` in `battle-drawing.js`** — mirror of `_drawPVPEnemyOffensiveCast` for the ally caster. Source = ally portrait center (right column, row N keyed by `battleSt.allyMagicCasterIdx`). Target spec = `{type:'enemy', index: allyMagicTargetIdx}`, which `_getMagicTargetCenter` resolves to `encounterMonsters[idx]` for encounter or `_pvpEnemyCellCenter(idx)` for PVP (idx 0 = opponent, 1+ = enemy ally idx-1).

Phase split matches the PVP-enemy mirror: first `CAST_PHASE_MS_THROW.projectile` (150 ms) of `ally-magic-hit` renders the projectile fan via `drawProjectileFan`; remaining time renders the impact via `drawSpellEffectAtTargets`. Sleep is intentionally a no-op visual (no on-target bundle — same as the player and PVP paths). Fire and Bzzard now show their burst-strip cycle on the actual target slot.

## 1.7.150 — 2026-05-09

### feat: BM/RM ally AI casts black magic

Black Mage and Red Mage roster allies now actually cast offensive magic instead of falling through to the physical attack path. Previously a Lv4 BM Vivi with Fire + Bzzard in `knownSpells` would just stab with her dagger; now she casts.

**`_tryAllyOffensiveCast` in `battle-turn.js`** — picks Fire (0x31) / Bzzard (0x32) / Sleep (0x33) from `ally.knownSpells`, picks a random living target, pre-rolls damage from the ally's INT (`floor(INT/2) + power`, NES black-magic formula). 45% activation gate so it feels like a *sometimes* choice, mirroring the PVP-enemy mirror in `pvp.js`. Dispatched after `_tryAllyCure` and `_tryAllyPoisona` so RM allies still heal when teammates need it before going offensive.

**Encounter + PVP both supported.** Encounter battles target a random living `encounterMonsters` slot. PVP battles target a random living `pvpEnemyAllies` cell or `pvpOpponentStats` — same idx convention `spell-cast.js:_getEnemyAt` uses (idx 0 = opponent, 1+ = enemy ally idx-1), so damage display piggybacks on the existing `setSwDmgNum` path.

**Damage application in `battle-ally.js:_applyAllyMagicEffect`** — replaced the no-op Fire guard (which used to short-circuit "ally AI doesn't cast offensive magic") with real damage application. Element multiplier from spell, mdef from target, stored in `battleSt.allyMagicDamageRoll`. Sleep (0x33) takes the status path: `tryInflictStatus` against target.statusResist + spell.hit, plays SLEEP_PUFF, replaces strip with status name on landing, miss display on whiff.

**`drawSWDamageNumbers` extended** to render during `'ally-magic-hit'` as well as `'magic-hit'`, so the damage number lands on the actual target slot — not on the player's currently-selected enemy.

**Visual polish gap (intentional, deferred):** the cast windup (caster pose + magic flame on ally portrait) plays correctly. The on-target impact anim (fire burst / blizzard splash) does NOT render yet — only the damage number pops. Gameplay is correct (HP drops, status applies). Visual impact-anim wiring can come later when needed.

## 1.7.149 — 2026-05-09

### fix: chat scroll SFX only when scroll actually happens

Up/Down in the expanded chat log was playing `SFX.CURSOR` on every press, even when there was nothing to scroll (buffer fit in the visible area, or already pinned at the top/bottom). Now gated on `canChatScrollUp()` / `canChatScrollDown()` — silent when no movement.

## 1.7.148 — 2026-05-09

### feat: chat log scroll

When the chat log is expanded (Shift+T), arrow Up scrolls back through history and arrow Down scrolls forward toward the latest. Reuses the same scroll-arrow sprites + 500ms blink rhythm as `roster.js:_drawScrollArrows` — `ui.scrollArrowUp` at top-right of the chat box, `ui.scrollArrowDown` at bottom-right, drawn only when scrollable in that direction.

The scroll-state plumbing already existed (`chatScrollOffset`, `setChatScrollOffset`) for the Private-tab tab-select flow. Generalized so any expanded chat consumes Up/Down. `setChatScrollOffset` now clamps to the cached buffer ceiling (no scrolling past the top); the row-count cache is updated each draw so the input handler doesn't have to re-run row layout.

Movement is gated on `chatState.expanded` (existing return), so character movement is suppressed while scrolling. Scroll resets to 0 when the chat collapses.

## 1.7.147 — 2026-05-09

### feat: smarter death respawn

Death respawn used to dump every KO at `ps.lastTown` (default Ur), regardless of where you died. Now the respawn point reflects where the death happened.

- **Slain on overworld** → respawn at the last spot you stood on overworld after exiting a town/dungeon. So a death 50 tiles east of Ur sends you back to Ur's overworld exit, not Ur's interior.
- **Slain not on overworld** (in a dungeon, town, PVP) → respawn at the entrance tile of whatever map you were in. Die on dungeon floor 5, you respawn at floor 5's entrance — your descent progress isn't wiped.
- **Fresh save with no exits recorded yet** → falls back to `ps.lastTown` (legacy behavior).

**`ps.lastWorldExitX` / `ps.lastWorldExitY`** added to player state and the save schema. Updated in `_landOnWorldMap` (the single chokepoint where the player lands on the world map from any source — town exit, dungeon exit, warp). Persists across sessions; loaded from slot in `title-screen.js`.

**`respawnAfterDeath()`** added as a single-source helper in `map-loading.js` (the location concern, not the battle concern). `battle-update.js` `_respawnAtLastTown` is now a thin wrapper that resets HP/MP/death-timer and delegates the wipe + map load to it. The branching logic (overworld coords vs. current-map entrance vs. fallback) lives in one place.

`loadWorldMapAtPosition` was already the single-source coords helper used by movement and triggers; respawn reuses it instead of duplicating.

## 1.7.146 — 2026-05-09

### feat: battle message coverage — actor → action → result

The strip used to go silent on Magic, Item, and monster spells; now every turn names the actor *and* what they're doing. Filled in five gaps from the audit.

**The single-slot invariant.** Every turn pushes ONE message via `queueBattleMsg` (the actor's name on turn dispatch). Every subsequent in-turn event — spell name, item name, status result, "Critical!", "N hits!", "Slain!" — uses `replaceBattleMsg`, which swaps text in-place without growing the queue. This guarantees the strip displays for at most one message-cycle (~1.2s) per turn, regardless of how many sub-events fire. Battle visuals (cast windup, projectile flight, damage numbers, HP drop) never get blocked by piled-up text. Converted ~10 mid-turn `queueBattleMsg` calls in `battle-enemy.js` / `spell-cast.js` / `pvp.js` to enforce this invariant.

**Player name on Magic / Item.** `battle-turn.js:148-150` — Fight + Defend already queued the player name; Magic + Item now do too. The strip stops going silent when you cast Cure or use a Potion.

**Spell name on cast.** Single chokepoint in `startSpellCast`: at entry, `replaceBattleMsg(getSpellNameClean(spellId))`. Covers player casts, battle items (which pass `itemId` and show the item name instead), and downstream impact-walk paths. Ally cast paths (Cure / Poisona / item-mode in `battle-turn.js:317,358,409`) and PVP foe cast paths (`pvp.js:559,609,636`) follow the same pattern: queue caster name, replace with spell name.

**Item name on consumables.** `_playerTurnConsumable` now calls `replaceBattleMsg(getItemNameClean(itemId))` — Potion, Hi-Potion, Ether, Elixir, Antidote, etc. all surface their name. Battle items (FireScroll, BachusWine, etc.) inherit the same path through `startSpellCast`'s item-name branch.

**Monster spell name.** `battle-enemy.js` — when a monster rolls a special attack (`mon.spAtkRate`), the attack name (Fire / Bzzaga / Bad Breath / etc.) replaces the monster name on the strip before damage resolves. Player can now read what hit them.

**"Slain!" on enemy KO.** `BATTLE_SLAIN` was defined but never queued. Now fires at all 5 KO transitions: physical kills (encounter, boss, PVP) in `battle-update.js`, magic kills (encounter, boss, PVP) in `_finishMagicHit`. Strip shows "Slain!" while the death fade plays.

## 1.7.145 — 2026-05-09

### polish: tighten battle message system

Internal cleanup. No behavior change — battle text fades and scrolls exactly as before.

**Single source of truth for message timings.** The scroll-overflow + total-display formula previously lived in three places: `updateBattleMsg` and `advanceBattleMsgZ` in `battle-msg.js`, plus `drawBattleMessageStrip` in `battle-drawing.js`. Two of them used naive `bytes.length * 8` for width while the third used `measureText()`, which would have drifted on any string containing control bytes. Folded into one `computeMsgTimings(msg)` helper exported from `battle-msg.js` and consumed by all three sites. Fade-out now finishes the same frame the queue advances, guaranteed.

**Shared layout/scroll constants.** `MSG_STRIP_X` / `MSG_STRIP_Y` / `MSG_STRIP_W` and the scroll-pause / scroll-speed numbers (`400` and `0.06` previously hardcoded in two places) now export from `battle-msg.js`. `battle-drawing.js` imports them so the clip rect, scroll math, and overflow gate read the same numbers.

**Pre-baked phrase bytes for static messages.** Added `BATTLE_HASTE` / `BATTLE_PROTECT` / `BATTLE_REFLECT` / `BATTLE_ALLY` / `BATTLE_FOE` to `data/strings.js` (alongside the existing `BATTLE_INEFFECTIVE`). Replaced ~10 dynamic `_nameToBytes('...')` allocations per cast/turn with the constants in `spell-cast.js`, `battle-turn.js`, `battle-ally.js`, `pvp.js`. Per-cast GC pressure drops; named ally / opponent paths still go through `_nameToBytes` since those are dynamic.

## 1.7.144 — 2026-05-08

### Player buff system — foundation (Haste, Protect, Reflect)

End-game buffs are now real, not stubs. Foundation lands the data model + math hooks; the gameplay surfaces (Bachus Wine = Haste, Turtle Shell = Protect, Curtain = Reflect — already pointing at these spell IDs via `animSpellId` since v1.7.118) finally do something when used.

**`src/buffs.js`** (new, 50 lines): `applyBuff(combatant, buffKey)` / `hasBuff(combatant, buffKey)` / `clearAllBuffs(combatant)` plus `BUFF_HASTE` / `BUFF_PROTECT` / `BUFF_REFLECT` constants and an `ALL_BUFFS` array. Storage shape on the combatant is plain object `{ haste?: true, protect?: true, reflect?: true }`. Re-apply is idempotent (no stacking, matches FF3 NES canon). Helpers are null-safe so any combatant lacking the field works fine.

**`ps.buffs = {}`** added to player state. NOT in the save schema — buffs are battle-bound. `resetBattleVars` calls `clearAllBuffs(ps)` at battle start so a Haste from the previous fight doesn't carry over.

**Spell-cast wiring** (`spell-cast.js:478-502`): the three self-buff handler stubs that previously fired only the SFX + battle-msg now actually call `applyBuff(ps, ...)`. So Bachus Wine grants Haste in-state, Turtle Shell grants Protect, Curtain grants Reflect. Same SFX/msg flow as before — the difference is the buff actually persists for the rest of the battle.

**Math hooks**:
- `calcPotentialHits(level, agi, dualWield, hasted = false)` — when hasted, doubles the final hit count. Stacks with dual-wield (a hasted dual-wielder gets 4× the base count). Wired in `input-handler.js:177` for the player attack path.
- `rollHits(opts.targetProtected = false)` — when set, halves damage independently of `defendHalve`. Both flags can stack; canon FF3 NES treats Protect + Defend as multiplicative (1/4 damage). Wired into the PVP enemy-attack-on-player path (`pvp.js:432`) and the monster-physical-on-player path (`battle-enemy.js:215`, post-roll halve since that path uses a custom multi-hit roller). Magic damage paths intentionally skip Protect — canon Protect is physical-only.

**Reflect**: data-only for v0. Buff sets, but no spell-bouncing yet. Bouncing requires target retargeting in the spell-cast engine — non-trivial and out of scope for foundation. Marked TODO at the apply site.

**`/buff` dev command** (chat.js): `/buff` shows active, `/buff haste|protect|reflect` applies one, `/buff clear` wipes. Added to `/devhelp` under a new "Buffs" group.

**Deferred to v1** (NOT shipped):
- Per-ally buffs (`battleAllies[i].buffs`)
- PVP-enemy buffs (`pvpOpponentStats.buffs` + `pvpEnemyAllies[i].buffs`)
- Encounter-monster buffs (`encounterMonsters[i].buffs`)
- Reflect bounce — retargeting + caster lookup + visual
- Turn-decay for Reflect (~10 turns canon)
- Buff icons on portraits (visual indicator above sprite — pattern exists for status overlays via `drawStatusSpriteAbove`)

**Test**: `buffs.js` smoke-tested via `node -e` (apply / has / clear / idempotent re-apply / null-safe). All assertions pass. Per-call-site behavior is exercised through actual gameplay; no regression test infrastructure yet (queued for the Vitest pass).

## 1.7.143 — 2026-05-08

### Console: dev-gated commands, real startup metrics, eight new dev commands

**Two-tier command system.** `registerCommand(name, desc, handler, { dev })` now takes an options bag with a `dev` flag. The dispatcher rejects dev commands for non-devs by replying with the standard "Unknown command: /x. Type /help" — same response as a typo, no information leak that the command exists. `/help` filters its listing per-user: real players see only public commands, devs see public + `[dev]`-tagged commands.

**Dev whitelist** in `chat.js` (`DEV_EMAILS`): `joeltaylor734@gmail.com`. Add teammate emails on the same line. Match is against `localStorage.getItem('ff3_email')`, lowercased. Authoritative as a UX gate only — all current commands mutate client-side state, so a determined player could spoof localStorage. The day server-authoritative PVP ships, the server has to enforce; commenting in chat.js notes this.

**Public tier (4 commands, anyone)**: `/help`, `/clear`, `/who`, `/pos`.

**Dev tier (13 commands)**:
- `/devhelp` — grouped listing of dev commands by category (Player state, Job & spells, Items, Navigation, Audio).
- `/job N` — switch job, full heal, save, list spells. (existing)
- `/heal` — full HP+MP. (existing)
- `/mp [N]` — get or set MP. (existing)
- `/ff1 N` / `/ff1 stop` — FF1 NSF track playback. (existing)
- `/hp [N]` — get or set HP. N=0 forces KO for death-flow testing.
- `/gil [N]` — get or set gil for shop testing.
- `/cp [N]` — get or set capacity points.
- `/level N` — force player level via repeated `grantExp(expToNext)`. Capped at 200 iterations as a safety in case grantExp can't push level (edge case).
- `/give <hexId> [qty]` — grant an item by hex id. Validates against `ITEMS` map; logs the resolved item name via `bytesToAscii(getItemNameClean(id))`. e.g. `/give b1 3` for 3 Bomb Shards.
- `/spell <hexId>` — grant a spell to `ps.knownSpells`. Logs resolved spell name. e.g. `/spell 33` for Sleep.
- `/warp N` — teleport to map id N (decimal). Plumbed via `setCommandContext({ loadMapById })` to avoid circular imports.

**Decoder fix**: `bytesToAscii` already existed in `text-decoder.js` and uses the proper `CHAR_MAP` (digits 0x80-0x89, A-Z 0x8A-0xA3, a-z 0xCA-0xE3, plus symbols). My first-pass hand-rolled decoder in chat.js had wrong ranges and got dropped before commit.

### Startup console — real catalog data, no decoration

The 4-line boot log was sparse and slightly outdated. Now 7 lines, every value pulled from a live source:

```
FF3 MMO v1.7.143
ROM ok  PRG=8x16k (128k)  CHR=16x8k (128k)  mapper=1
Catalog: 200 items, 231 monsters, 6 spell anims
Save slots: 2/3 used
Auth: joeltaylor734@gmail.com [dev]
Boot: 234ms
Type /help or /devhelp
```

Sources: `VERSION` (matches package.json on deploy via data/strings.js), `rom.*` from parsed iNES header, `ITEMS.size` / `MONSTERS.size` from the data Maps, `getRegisteredSpellAnimCount()` (new export from spell-anim.js — counts spells with on-target visual bundles), `saveSlots.filter(s => s != null).length` from save-state, `isDev()` for the `[dev]` tag, `performance.now()` delta from `loadROM` start for boot time. Stagger reduced from 500ms → 350ms per line so the full 7-line log finishes in ~2.5s instead of 3.5s.

Cadence will land different per machine — `Boot: Nms` is honest (typically 150-400ms on the user's hardware, longer on cold-boot mobile).

## 1.7.142 — 2026-05-08

### ESLint as a static gate + crit damage numbers stop being gold

ESLint flat config wired up. Catches the v1.7.49/v1.7.50 class of bug — orphan imports, undefined references, dead destructures — at static-check time, before smoke.sh has to find it at runtime. `npm run lint:errors` fails on errors only and is now a precondition in `deploy.sh` (runs before `git commit`, so a broken module aborts the deploy with no push). `npm run lint` shows everything including warnings (170 currently, mostly unused-vars in legacy code — aspirational cleanup, not a gate).

Caught one real bug on the first run: `_damageImpactSFX` reference in `spell-cast.js:448` was an orphan from the v1.7.119 rename to `_spellImpactSFX(spell)`. The non-recovery boss damage path would have thrown a ReferenceError the first time someone cast a damage spell at a boss with the player KO'd. Now patched. This is exactly the pattern the lint gate is meant to catch.

Rules: `no-undef` and `no-undef-init` are errors (the gate). `no-unused-vars` warns with `^_` ignore pattern matching the existing convention. `no-redeclare` and `no-useless-assignment` warn (legacy patterns we won't chase). Browser-side files get `globals.browser` plus `Module` (Emscripten GME) and `jsnes` (vendored debug emulator); node-side files (`server.js`, `api.js`, `tools/`) get `globals.node`.

Smoke.sh stays — runtime catches things ESLint can't see (CSP errors, network failures, render-loop crashes). The two are complementary: lint = static, smoke = runtime.

### Crit damage numbers no longer gold

`CRIT_NUM_PAL` and the gold-fill render branch removed. Critical hits now render in the standard red `DMG_NUM_PAL` like every other damage tick. The `crit` flag on damage rolls still drives the slash SFX swap and `critFlashTimer` screen flash — only the digit color is reverted.

## 1.7.141 — 2026-05-08

### Legacy code cleanup

Quiet diff-day. The carryover from earlier consolidations is gone.

**Battle-items module deleted entirely.** `src/battle-items.js` (172 lines) is gone — `startMagicItem`, `updateMagicItemThrowHit`, `_buildTargets`, `_applyDamage`, `getTargets`, `getHitIdx`, `resetBattleItemVars`, `initBattleItems`. Every battle item has had `animSpellId` since v1.7.118 so the legacy fallback path was never executed; battle-turn.js drops the `else { startMagicItem(); }` branch and just calls `startSpellCast` unconditionally for `type === 'battle_item'`.

**Battle states `'sw-throw'` and `'sw-hit'` removed.** No emitter remains. The `updateMagicItemThrowHit` handler in battle-update.js, the `drawSWExplosion` legacy branches (PVP-target render path + encounter render path + boss render path), the `getTargets()` lookup inside the encounter sprite gate, and the half-dozen state guards across `drawEncounterBox` / `drawBossSpriteBox` / `drawBossSpriteBoxPVP` / `_isEncounterCombatState` / `_battleMenuStates` / `_drawBattlePortrait`'s `isItemUsePose` — all gone. `drawSWExplosion` is now PVP-only (single branch); `drawSWDamageNumbers` runs only during `magic-hit`.

**KEPT** (still alive in the engine): `'pvp-opp-sw-throw'` / `'pvp-opp-sw-hit'`. Non-mage main opponents still throw a SouthWind item at 15% chance (pvp.js:373). `bsc.swPhaseCanvases` and `initSouthWindSprite` stay — the PVP path renders through them, and `spell-anim.js` reuses `initSouthWindSprite` for Blizzara's impact phases.

**ROM stat readers in `data/jobs.js` deleted.** `readJobBaseStats`, `readJobLevelBonus`, `readStartingHP`, `readStartingMP` and their offset constants `JOB_BASE_STATS_OFF` / `CHAR_INIT_HP_OFF` / `CHAR_INIT_MP_OFF` / `LEVEL_STAT_BONUS_OFF`. Superseded by `computeJobStats` in v1.7.138; nothing has imported them since. `LEVEL_EXP_TABLE_OFF` is the only ROM offset still consulted (by the exp curve loader).

**Stale comments swept** from `player-stats.js`, `data/players.js`, `data/items.js`. The "Items mapped to … stay on the legacy `startMagicItem` path" block in items.js was outright wrong — every item routes through `startSpellCast` now.

Net diff across the full v1.7.140 + v1.7.141 cleanup pass: −465 lines, +111 added (mostly comment + state-list edits). One file deleted. All `node --check` pass.

## 1.7.140 — 2026-05-08

### Game Over sequence removed — all deaths respawn directly

All death paths now act the same: the battle-end box closes, then the wipe transition fires and the player respawns at `lastTown` at full HP/MP. No "Game Over" boxed screen, no "Press Z" prompt, no "The Requiem" track, no team-wipe / "Defeated" crossfade.

Removed states (engine-side): `team-wipe`, `defeat-monster-fade`, `defeat-text`, `defeat-close`, `game-over`. The five death-state handlers in `_updateDefeatStates` are gone — `updateBattleEndSequence` is now `boss-dissolve → victory-sequence → box-close` only.

`_updateBoxClose` is the single death sink: when the encounter / enemy box-close completes with `ps.hp <= 0`, it stops music and calls `_respawnAtLastTown()` directly. Previously routed through `'game-over'` and waited for Z.

Origin sites (battle-enemy.js, battle-ally.js, pvp.js) that used to set `'team-wipe'` on full-team wipe now set the appropriate box-close state directly, skipping the 1.2s death-pose hold and the "Defeated" PVP crossfade.

Cleanup landed alongside: `BATTLE_GAME_OVER` and `BATTLE_DEFEATED` strings dropped, `TRACKS.GAME_OVER` track def dropped, `respawnFromGameOver` export dropped, `_teamWipeMsgShown` battleSt field dropped, `_zPressed` helper + `keys` import in battle-update.js dropped (only consumer was the deleted defeat handler), every dead-state guard removed from drawEncounterBox / drawBossSpriteBox / drawBattleMenu / drawBossSpriteBoxPVP.

## 1.7.139 — 2026-05-08

### Existing-save stat migration

Save load now recomputes base stats from `computeJobStats(slot.jobIdx, slot.level)` instead of trusting the saved `str/agi/vit/int/mnd/maxHP/maxMP` blob. Saves created before v1.7.138 had stats from the old ROM-random path; this brings them onto the unified matrix retroactively. Existing characters get the canonical numbers for their job + level.

Untouched on load: `level`, `exp`, `gil`, `inventory`, `weaponR/L`, `head/body/arms`, `jobLevels`, `unlockedJobs`, `cp`, `knownSpells`, `worldX/Y`, `lastTown`. HP and MP are clamped to the (possibly new) max values — so a character that previously had a higher max HP from favorable ROM rolls comes back capped at the matrix value.

## 1.7.138 — 2026-05-08

### Single stat path — local player + fake players unified

v1.7.137 only fixed fake-player stats, leaving the local player on the ROM-driven path. Result: a level-N RM in your party had different numbers than a level-N RM as a PVP enemy. Same job, two characters. Drift, my fault, fixing now.

The per-job weight matrix is now the **single source of truth** for both paths:

- `data/players.js` exports `computeJobStats(jobIdx, level)` (returns `{str, agi, vit, int, mnd, maxHP, maxMP}`) and `getJobLevelDelta(jobIdx)` (returns the per-level deltas).
- `generateAllyStats` calls `computeJobStats`.
- `initPlayerStats` calls `computeJobStats(ps.jobIdx, 1)`. ROM readers (`readJobBaseStats`, `readStartingHP`, `readStartingMP`) are no longer consulted for stats.
- `grantExp` level-up loop adds `getJobLevelDelta(ps.jobIdx)` per stat instead of rolling random ROM bonuses. Deterministic — at level N, stats match the matrix exactly.
- `changeJob` rebuilds via `computeJobStats(newJobIdx, currentLevel)`. Switching jobs to a level-N character produces the same numbers as if the player had been that job all along.

The matrix:

```
            str  agi  vit  int  mnd  mp
   OK (0)    1    1    1    1    1   0
   Fi (1)    2    1    2    1    1   0
   Mo (2)    2    2    2    1    1   0
   WM (3)    1    1    1    1    3   3
   BM (4)    1    1    1    3    1   3
   RM (5)    1    1    1    2    2   2     hybrid — W=2 in both schools
```

Each stat = `5 + level * W` (or `5 + level * W_mp` for MP, `0` for non-casters; HP is always `28 + level * 6`). RM at level N has 67% of a specialist's per-school stat contribution — clearly weaker per-school than WM/BM, but flexible across both.

`_tryPVPEnemyOffensiveCast` (PVP enemy BM/RM offensive cast) now reads `caster.int` directly (was a hack using `caster.agi` because INT didn't exist).

**Caveat for existing saves**: characters that already have stats loaded from the previous ROM-driven formula keep those stats. The next `level-up` adds matrix deltas, so the stats rebase forward. New games + new fake players use the matrix from the start. If you want existing-save migration to recompute current stats from the matrix, say the word and I'll wire it.

ROM stat readers (`readJobBaseStats`, `readJobLevelBonus`, `readStartingHP`, `readStartingMP`) are now dead code in `data/jobs.js`. Left in place for now (harmless); cleanup can happen in a separate pass.

## 1.7.137 — 2026-05-08

### Fake-player stat audit — RM is hybrid, Fi/Mo are physical, casters are specialists

Fake-player `generateAllyStats` now applies a per-job stat-weight matrix instead of treating every job's str/agi/vit as a flat `5 + lv`. Adds INT to the return object too — was missing, so the PVP offensive cast AI in `pvp.js` was hacking around it by using `caster.agi` as a stand-in. Now:

```
            str  agi  vit  int  mnd
   OK (0)    1    1    1    1    1     apprentice — flat baseline
   Fi (1)    2    1    2    1    1     melee — strong + tanky
   Mo (2)    2    2    2    1    1     melee — strong + agile + tanky
   WM (3)    1    1    1    1    3     pure white caster
   BM (4)    1    1    1    3    1     pure black caster
   RM (5)    1    1    1    2    2     hybrid — medium in both schools
```

`stat = 5 + lv * W`. Specialists hit W=3 in their core. Red Mage is the hybrid: W=2 in BOTH int AND mnd, putting their per-cast magic output at ~67% of a specialist's stat contribution at the same level — meaningful magic, but a focused WM/BM still outclasses them per-school. RM phys is W=1 across the board (same as pure casters; Fi/Mo are W=2 STR for clearly-stronger melee).

`_tryPVPEnemyOffensiveCast` switched from `caster.agi` to the proper `caster.int`. RM-cast Fire / Blizzard / Sleep now hits softer than BM-cast for the same spell.

Note: this affects fake players only. The local player path (`initPlayerStats` / `grantExp` in `player-stats.js`) reads canonical FF3 NES ROM stat tables — already correct, untouched.

## 1.7.136 — 2026-05-08

### Battle magic menu polish — gray-out, layout, scroll

Three improvements to `_drawBattleSpellList` in `battle-drawing.js`:

1. **Unaffordable spells fade to gray.** Spells where `cost > ps.mp` render with palette slot 3 swapped to NES `$10` (gray) — affordable rows stay full-color. Same glyph pass; just a per-row palette toggle, no extra render cost.
2. **Empty-state defense.** "No spells" message if `spellSelectList` ever comes through empty. Shouldn't happen in normal play, but better than a blank panel.
3. **Layout fix — overflow gone.** `rowH` 14 → 12 so 4 rows fit in the 48 px content area (was 3 rows + spillover). Added a scroll window: when `list.length > 4`, `scrollTop` is derived from the cursor each frame (centers cursor when possible, clamps at both ends — pure-derive, no new state). Cursor draws at the relative-to-window row. The pre-existing 8×8 `ui.scrollArrowUp/Down` sprites are pinned to the right edge of the panel and blink at 250 ms cadence when hidden content exists above / below.

## 1.7.135 — 2026-05-08

### RM cast visual is now school-aware

Red Mage was hardcoded to use the WM cast visual (`{ 3: 'wm', 4: 'bm', 5: 'wm' }`). Now `jobToCastKey(jobIdx, spellId)` looks up `getSpellSchool(spellId)` for `jobIdx === 5` and returns `'bm'` for black-magic spells, `'wm'` for white. RM casting Cure renders WM rotating-stars; RM casting Fire/Blizzard/Sleep renders the BM halo + flame. `getCastVisual` already passes `spellId` through, so the dispatch threads end-to-end with no other render-site changes.

## 1.7.134 — 2026-05-08

### Pulled bow from Eska — bow + arrow not wired yet

v1.7.133 gave Eska Bow + Wooden Arrow for variety, but the `twoHanded` flag in items.js isn't read by the battle/draw code, and there's no ammo consumption or ranged-attack mechanic. Eska would have been modeled as a generic dual-wield (avg-atk × 2 hits), not actually shooting a bow. Swapped to Dagger + Shield. Doc-block updated to flag bows as "not wired — don't equip on pool entries until ranged-attack mechanics land."

## 1.7.133 — 2026-05-08

### Player pool equipment audit + per-job equip matrix doc

Audited every fake-player entry's gear against the actual `jobs` mask in `items.js`. Three issues found, all fixed:

1. **Cassia had Serpent Sword (`$28`, atk 25, 1500 gil)** — way past Altar Cave + Ur tier. Swapped to Longsword (`$24`).
2. **All 5 BMs wielded Staff (`$0E`)** — but `$0E` jobs mask is `Ww|Rw|Sh|Sa|Ni`. **`Bw` (Black Mage) is NOT in that mask.** None of the BMs could actually equip their weapon. Bug since v1.7.126 when I added them. Fixed: BMs now wield Knife (`$1E`) or Dagger (`$1F`) per the items table — their offensive output comes from Lv1 Black Magic, not weapon ATK.
3. **RMs had no shields.** Per `$58` mask `On|Fi|Rw|Kn|Th|Dr|Vi|Ni`, RM IS allowed. Re-added shields to Asher / Caelum / Soren. Verena and Quill stay shieldless (caster-style RM). Caelum now uses Staff `$0E` + Shield (RM is the only mage class that can pair staff with shield in this codebase).

Pool diversity also bumped:
- Eska (OK, lv3, crystal): now Bow `$4A` + Wooden Arrow `$4F` — two-handed archer variety
- Brom (OK, lv3, cave-1): Dagger + Knife dual-wield
- Duran (Fi, lv5, crystal): Dagger + Knife dual-wield (instead of yet another longsword)
- Caelum (RM, lv5): Staff + Shield (only RM swinging a staff)
- BMs split between Knife (lv3-4) and Dagger (lv4-5)

Doc: full per-job equip matrix added to the `PLAYER_POOL` header comment in `data/players.js`. Lists which weapons / body / helm / shield each starting job can equip at Altar Cave + Ur tier, with the relevant `items.js` masks called out. Bracers (`$8B`, mage-arm) noted as deferred until `armsId` slot lands in `generateAllyStats`.

New tool: `tools/audit-player-pool-equip.mjs` cross-checks every pool entry against its job's equip mask. Run after any PLAYER_POOL or items.js edit. Fails loud on mismatch.

## 1.7.132 — 2026-05-08

### Dual-wield damage de-tuned (was quadratic, now linear)

User caught: a level-3 Onion Knight with Dagger + Knife was hitting Land Turtle for 40+ dmg/turn — pre-Altar-Cave gear shouldn't crater a boss in three turns. Cause: two layers compounded.

1. `calcAttackerAtk` returned `rWpnAtk + lWpnAtk + floor(str/2)` for non-Monk dual-wield — both weapon ATKs **summed**.
2. `calcPotentialHits` with `dualWield=true` returned `base × 2` — hits **doubled**.

So a dual-wielder got 2 hits at the SUMMED atk of both weapons → quadratic damage. Lv3 OK D+K = 18 atk × 2 hits = 34-52 dmg/turn vs Land Turtle's def 1.

Fix: per-hit ATK now uses the **average** of both weapon ATKs when dual-wielding, not the sum. The 2-hit count is preserved so each "hand" still strikes once per turn at near-single-weapon power. This lands close to NES canon, where each hand's strike resolves separately at that hand's own weapon ATK.

- Lv3 OK D+K: was 34-52 dmg/turn → now 20-32 dmg/turn (~37% drop)
- Single-wield damage is **unchanged** (one slot is 0, so the average reduces to the equipped weapon's ATK).
- Monk unarmed special-case is **unchanged**.

Note: the underlying `def: 1` value across the entire bestiary (`gen-monsters-js.js` likely reads the wrong byte from the stat-table layout) is a separate issue. Bosses should have higher DEF than mooks but currently don't. Tackle in a follow-up.

## 1.7.131 — 2026-05-08

### RMs back to Daggers — sword + made-up name pulled

Two errors in v1.7.130:

1. **I fabricated the name "Sage Sword"** for item `$25` in the comments. I have no source for that name; I assumed it from the item's RM/Ninja access + holy element. Violates the never-fabricate rule and the "look it up first" rule. There is no excuse — the actual name lives in ROM via `getItemNameClean(0x25)` and I should have either decoded it or webfetched a primary source.
2. **The item tier was wrong for early game.** Item `$25` is price 1000 — players are pre-Altar Cave. RMs at this stage shouldn't have any sword.

Fix: all 5 RMs (Asher, Verena, Caelum, Quill, Soren) use Dagger `$1F` (price 60, atk 8). Shields removed too — RMs are caster hybrids, not Fighter-tier melee.

## 1.7.130 — 2026-05-08

### Fixed RM weapon — Long Sword → Sage Sword

Caught: my v1.7.127 pool had Asher / Caelum / Soren wielding Longsword (`0x24`), which has `jobs: On|Fi|Kn|Ni` — Red Mage isn't in that mask. Per the items table, the canonical RM-equippable swords are `0x25` (Sage Sword, atk 15, holy element, `jobs: Rw|Ni`) and `0x2a` (atk 29). Swapped the three sword-wielding RMs to `0x25`. Lower-level RMs (Verena, Quill) keep Dagger `0x1F` which is RM-OK.

## 1.7.129 — 2026-05-08

### PVP-enemy offensive cast visuals + directional projectile

The $58 projectile tile has a directional trailing flame — canonical capture is right→left (player→enemy). When a PVP-enemy BM/RM casts toward the player party, the projectile now h-flips so the flame keeps trailing behind the orb instead of leading it.

- `getProjectileTile(spellId, spell, hflip)` accepts a direction flag. The bundle cache pre-builds h-flipped variants alongside the v-flip wobble pair so neither hot path allocates per frame.
- `drawProjectileFan` auto-detects hflip per target via `sx < tc.x` (caster left-of-target = travel rightward = needs flip). Backward-compatible: player-cast right→left still uses the canonical orientation.
- New `_drawPVPEnemyOffensiveCast` in `battle-drawing.js`, mirror of `_drawPlayerSpellTargetSparkleOnEnemy` for the opposite direction. Hooks into the draw loop right after the player-cast renderer. Same modular helpers (`drawProjectileFan` + `drawSpellEffectAtTargets` + `_getMagicTargetCenter` + `_isCrossFaction`) — the helpers were already direction-agnostic; only a new caller was needed.
- Phase split inside `pvp-enemy-magic-hit`: 0..150 ms projectile flight from caster cell to player/ally portrait, then impact burst at the target for the rest of the hit window. `_applyPVPEnemyMagicEffect` (at PVP_MAGIC_EFFECT_MS=400) still drives the actual damage/status apply + damage-number pop in the middle of the burst.

Audit notes (no refactor needed): the cast/projectile/impact pipeline is already modular — `_isCrossFaction` abstracts faction logic, `_getMagicTargetCenter` resolves any target type's screen position, `drawProjectileFan` and `drawSpellEffectAtTargets` are direction-blind. Adding the PVP-enemy direction was a pure additive change, no shared logic moved.

## 1.7.128 — 2026-05-08

### Pulled Sight from fake-player knownSpells

Lenna had `[Cure, Poisona, Sight]` from the v1.7.127 pool refactor. Sight is dead weight on fake-player AI — it's the player's enemy-HP peek; a fake mage casting it just burns a turn. Trimmed to `[Cure, Poisona]` to match the rest of the WM pool.

## 1.7.127 — 2026-05-08

### Pool refactor + RM palette + PVP mage AI

- **Player pool rebalanced**: 30 entries, 5 per starting job (OK / Fi / Mo / WM / BM / RM). Names matched to class theme — Vivi/Nephele/Korra/Theron/Mara for BMs, Asher/Verena/Caelum/Quill/Soren for RMs, kept Japanese names for Monks (Kasumi/Jiro/Ryuji/Hana/Tetsuo). palIdx varied within each job so colors don't collide. Locations spread across all 7 zones for PVP join roll variety. Equipment matches class: BM Staff, RM Longsword/Dagger, etc. knownSpells scaled by level.
- **`BLACK_MAGE_PALETTES` is now all blue tints**: the 8 slots vary only the robe color, all within the blue family — canon light blue (`$21`), azure (`$11`), deep blue-violet (`$12`), sky blue (`$22`), cyan (`$1C`), light cyan (`$2C`), deep blue (`$01`), pale blue (`$31`).
- **`RED_MAGE_PALETTES` added**: 8 slots, all red tints — canon red (`$16`), magenta (`$15`), purple-red (`$14`), orange-red (`$17`), light red (`$25`), pink (`$24`), dark red (`$05`), pale red (`$35`). Wired into `_jobPalette` in `battle-drawing.js`, `pvp.js`, and `combatant-sprites.js` for `jobIdx === 5`.
- **Fake-player mage AI hooked up across the whole board**: `_tryPVPEnemyCure` and `_tryPVPEnemyPoisona` now run for ANY caster (main opp + enemy allies, cells 0-3) with knownSpells, not just the main opp. WMs and RMs heal injured teammates on any cell.
- **BM/RM offensive cast AI**: new `_tryPVPEnemyOffensiveCast` that picks a target on the player party (player or living roster ally) and casts Fire / Blizzard / Sleep based on the caster's knownSpells. ~45% activation rate. `_applyPVPEnemyMagicEffect` extended with a party-target branch that applies damage (Fire/Blizzard, mdef-reduced) or status (Sleep, `tryInflictStatus` against the target's `statusResist`). Damage triggers shake feedback on the player or ally target. Sleep miss falls through to a damage-num "Miss" indicator. RM with both schools naturally pivots — heal when team is hurt, BM-Lv1 otherwise.
- New `pvpSt` fields: `pvpMagicPartyTargetIdx` (`-100` = none / `-1` = player / `0+` = ally) and `pvpMagicDamageRoll` (pre-rolled Fire/Blizzard damage). Reset on PVP state init + at the end of magic-hit.

Visual polish for the offensive cast (projectile fan from caster cell to player party + impact burst on the target portrait) is deferred — currently the cast pose plays, then the SFX + damage number land at impact apply time.

## 1.7.126 — 2026-05-08

### BM + RM added to fake player pool

Pool grows from 23 → 31 with 4 Black Mages (Vivi, Nephele, Korra, Theron) and 4 Red Mages (Asher, Verena, Caelum, Quill). All starting jobs (OK / Fi / Mo / WM / BM / RM) are now represented.

- BMs equip Staff (`0x0E`) + Leather+Cap (`0x73` / `0x62`), `knownSpells` chosen from BM Lv1 (Fire `0x31`, Blizzard `0x32`, Sleep `0x33`) by level — lower-level BMs know fewer spells.
- RMs are hybrid: Longsword (`0x24`) + shield for the higher-level / more martial slots, Dagger (`0x1F`) for lower-level. `knownSpells` mix WM + BM Lv1 (Cure `0x34` plus subset of Fire/Blizzard/Sleep). `generateAllyStats` already gives RM the canonical mid-MND scaling (`mndW = 2`).
- Locations spread across `world / ur / cave-0..3 / crystal` so each class shows up at multiple zones for the roster HUD + PVP join roll.
- BM render palettes already wired (BLACK_MAGE_PALETTES for battle, BM_WALK_TOP/BTM for overworld). RM uses PLAYER_PALETTES + Onion Knight walk fallback per the user's "RM is all red" call.

PVP offensive-magic AI for BM/RM is NOT wired here — fake BMs/RMs in PVP currently fall back to physical attacks with their staff/sword. Wiring offensive cast routines (`_tryPVPEnemyFire` / `_tryPVPEnemySleep` / etc.) is a separate task.

## 1.7.125 — 2026-05-08

### RM overworld walk palette wired

Red Mage (job 5) was falling back to Onion Knight (red top, green/magenta bottom). Per the user's call, RM's canon look is all-red — same pattern as Warrior — so `JOB_WALK_PALS[5]` now uses `[SPRITE_PAL_TOP, SPRITE_PAL_TOP]`.

## 1.7.124 — 2026-05-08

### BM overworld walk palette wired

Black Mage (job 4) was missing from `JOB_WALK_PALS` in `job-sprites.js`, so a BM in the overworld was falling back to the Onion Knight red palette. Added `BM_WALK_TOP = [0x1A, 0x0F, 0x27, 0x36]` (face/hat brim) and `BM_WALK_BTM = [0x1A, 0x0F, 0x21, 0x36]` (canonical blue robe + light-pink trim) per the OAM dump (REC OAM frame 1629, SP0/SP1). Wired in `JOB_WALK_PALS[4]`. WM (3) and RM (5) still fall back to Onion Knight defaults — their PPU captures haven't landed yet.

## 1.7.123 — 2026-05-08

### Multi-target throw: parallel projectile fan, serial impact walk

The new spell-cast engine had collapsed multi-target throws into a fully-parallel apply (one impact frame, all damage numbers pop together). Reverted to the legacy SouthWind pattern: projectile fan-out is parallel (every target gets a sphere), but the impact bursts walk targets one at a time in TL → TR → BL → BR reading order.

- `_targets` is sorted by visual `(row, col)` after the multi-enemy build using a small `_enemyVisualPos` helper that mirrors `_encounterGridPos` for encounters and `pvpGridLayout`'s `gridPos` for PVP.
- New `_magicHitPhase` substate inside `magic-hit`. Throws with cross-faction targets enter `'projectile'` (battleTimer 0..150 ms = parallel fan), then transition to `'impact-walk'` (per-target window: 550 ms impact + 500 ms damage-number hold = 1050 ms each). Each iteration resets `battleTimer`, `_effectApplied`, `_sfxPlayed` so the SFX fires per target. After all targets are walked, the shared `_finishMagicHit()` tail runs the kill detection / monster-death / boss-dissolve / pvp-dissolve / msg-wait routing.
- Item-use skips the projectile sub-phase (legacy SW: items have no projectile flight) but still walks impacts serially. SouthWind, Bomb Shard, Arctic Wind, etc. land impacts TL → TR → BL → BR.
- Heal-style + single-target self-buff stay on the original parallel-apply path — the walk only engages when `isThrown && cross-faction`.
- Renderer reads `getMagicHitPhase()` + `getSpellHitIdx()` to pick which targets to draw. Projectile phase fans to all `enemyTargets`; impact-walk phase draws the burst at the current `enemyTargets[hitIdx]` only, using the per-target `battleTimer` as the burst-frame clock.
- Sight gets its own `_spellImpactSFX` branch (`target === 'sight'` → `SFX.SIGHT`) so the engine plays the right impact SFX during the walk without double-firing inside `_applyEnemyEffect`.

## 1.7.122 — 2026-05-08

### Sleep target picker defaults to enemy side

Pressing Z on Sleep was landing the cursor on the player portrait — the gate at `input-handler.js:401` only flagged `target === 'sight'` or `type === 'damage'` as enemy-default. Sleep is `type: 'sleep'`, `target: 'enemy_status'` — neither matched. Extended the gate to cover any spell that targets the enemy side: `'enemy'`, `'enemy_status'`, `'all_enemies'`, plus the existing `'sight'` and damage-type. Future status spells (Confuse, Death, all_status family) get correct defaults out of the gate.

## 1.7.121 — 2026-05-08

### Fire / Blizzard / Sleep all multi-targetable

`MULTI_TARGET_SPELLS` now includes `$31` Fire, `$32` Blizzard, and `$33` Sleep alongside `$34` Cure. The targeting nav was already wired (battle-items + Cure use the same picker): Left on the leftmost enemy enters all-enemies mode; Up on the top enemy of a column enters col-mode. Engine paths were also already in place — `startSpellCast`'s `mode !== 'single' && !onAllies` branch builds the multi-enemy `_targets` list, the projectile fan draws to every enemy target, and damage spells with `power > 0` roll once and divide by `_targets.length` (Sleep's `power: 0` skips division — each target rolls `tryInflictStatus` independently against `spell.hit`, the FF3-canon behavior).

## 1.7.120 — 2026-05-08

### Status sprite overlays + battle messages on status hit

- Single-source `drawStatusSpriteAbove(ctx, statusObj, x, y, mirror)` exported from `battle-drawing.js`. Priority order (petrify > sleep > confuse > paralysis > silence > blind > poison) and 133ms 2-frame cadence live in one place. Player + roster ally + PVP enemy all route through it instead of inlining the lookup.
- Roster ally portraits now show the status sprite above the portrait at `(ppx, ppy - 4)`, matching the player path (no mirror — allies face left like the player).
- PVP enemy bodies now show the status sprite at `(sprX, sprY - 4)` h-flipped (`mirror=true`) so the asymmetric Z's / glyphs match the body's right-facing orientation. Suppressed during the dissolve phase.
- Battle messages: when a player-cast status spell lands on an enemy (Sleep, Confuse, Death's instakill is unchanged), the corresponding `STATUS_NAME_BYTES[flag]` is queued — "Asleep" / "Confused" / etc. The all_status path (Tranquilizer / Shade) queues one message per landed status. Non-Sheep status SFX path now uses `_spellImpactSFX(spell)` so future status spells with custom SFX route correctly (Sleep already fires its SFX at impact start via the throw path; this is a no-op for it).
- Battle-enemy parity: when a monster lands a status on a player or ally, the same `STATUS_NAME_BYTES` message is queued through the same `queueBattleMsg` channel. Single source for status-text plumbing.
- Encounter monsters (non-player sprites) intentionally do NOT render the status overlay — overlays are player/PVP-player-sprite only by design.

## 1.7.119 — 2026-05-08

### Sleep ($33) — last Lv1 BM spell shipped end-to-end

- Wired Sleep through the full cast → projectile → impact pipeline using the OAM parity harness against `sleep-emu-snap.txt`. 12 unique impact tiles (`$4B–$56`) form three 16×16 sub-cluster sprites (α/β/γ) that tile across a 48×48 area in three cyclic-rotation layouts at 67 ms each. All tiles + palette parity-PASS.
- Added `_THROWN_STATUS_TYPES` set (currently `{'sleep'}`) so status-type spells can join Fire/Blizzard on the cast → projectile → impact path. Generalized `_damageImpactSFX` into `_spellImpactSFX(spell)` which routes by element (fire/ice) or by `spell.type` (sleep). The thrown-to-enemy SFX gate now covers any thrown spell with a cross-faction target except Sight (which keeps its own SFX inside `_applyEnemyEffect`).
- New SFX entry `SLEEP_PUFF: 0x95` (NSF track $95). Verified via the v1.7.111+ EMU dumper: CPU writes `$D4` to `$7F49` at frame 74 of `sleep-emu-snap`, just before the impact group appears at frame 75.
- Added Sleep ($33) to `SPELL_SCHOOL` (black), `SPELL_MP_COST` (3), `SPELL_BUY_PRICE` (200), and to `STARTING_SPELLS` for BM (4) + RM (5). `SPELL_CAST_PAL` and `SPELL_PROJECTILE_PAL` get `[0x0F, 0x15, 0x27, 0x30]` (magenta family — same SP3 the dump shows).
- Battle-drawing's throw-path mirror gate extended to `spell.type === 'sleep'` so the projectile fan + impact burst render.
- Parity harness extended with `sleep` and `sleep-projectile` specs in `tools/parity-check-spell.js`.

### Cast → projectile handoff hardened

Player cast pose call sites in `battle-drawing.js` now strictly state-gate on `'magic-cast'` only — they previously fired in `'magic-hit'` too and relied on internal `< CAST_T_LUNGE` checks to suppress draws while the projectile was in flight. PVP and ally paths already gated this way; the player path now matches. Defense in depth: the elapsedMs gates inside `cast-anim.js` are kept as a fallback. Pipeline is now: full cast loop → cast clears → projectile → projectile clears → impact → impact clears → damage number.

## 1.7.118 — 2026-05-08

### Final 3 battle items mapped — all 20 now modular

- $bd Black Musk → Death `$01` (instakill, same handler as Devil Note)
- $c1 Tranquilizer → Shade `$1e` (all_status — engine extended to roll paralysis/blind/silence/sleep/confuse against spell.hit each)
- $c5 Curtain → Reflect `$0c` (self-buff stub until reflect mechanics ship; `target='reflect'` joins haste/protect in the self-target override list)

`_applyEnemyEffect` gains a `type='all_status'` branch — for each candidate status it calls `tryInflictStatus(mon.status, name, spell.hit, mon.statusResist)` independently. Tranquilizer paralyzes + may also blind/silence/sleep/confuse depending on rolls. `_applySpellEffect` (player path) gains a `target='reflect'` branch that mirrors haste/protect (battle msg + CURE SFX, mechanics deferred).

All 20 battle items now route through `startSpellCast` as `isItemUse: true`. The legacy `startMagicItem` path is dead code for items but still wired in `battle-update.js:583` for the `sw-throw`/`sw-hit` battle states. Cleanup of those (and `bsc.swPhaseCanvases`, the `pvp-opp-sw-hit` PVP wiring) is now safe to do in a follow-up.

## 1.7.117 — 2026-05-08

### Spell-cast handles status / drain / self-buff target types — remaining 7 battle items now route through modular path

`_applyEnemyEffect` extended:
- `target='enemy_status'` (Confuse, Sleep, Death) — calls `tryInflictStatus(mon.status, spell.type, spell.hit, mon.statusResist)`. Death gets a special instakill check that sets `mon.hp=0` on success and plays `MONSTER_DEATH` SFX. Misses show damage=0 with the `miss` flag (Ineffective tooltip).
- `target='erase'` — SFX-only acknowledgement (no enemy buff state exists yet to dispel).
- `target='drain'` — damages enemy and heals player by the same amount; reverses on undead per NES canon (heals enemy, no player heal).

`startSpellCast` now overrides `_targets` to `[{type:'player'}]` for self-buff spells (`target='haste'` / `target='protect'`) regardless of the target picker's selection — battle items like BachusWine and TurtleShell may have an enemy targeted but the buff applies to the player.

`_applySpellEffect` (player path) gains placeholder branches for `target='haste'` and `target='protect'` — battle message + CURE SFX, no real buff mechanics yet (haste = double speed, protect = halve damage need a player-state buff system that doesn't exist; mechanics are stubbed until that lands).

Items now mapped on the new path:
- $b8 Lamia Scale → Confuse `$20`
- $b9 Bachus Wine → Haste `$13` (mechanics stub)
- $ba Turtle Shell → Protect `$1a` (mechanics stub)
- $bb Devil Note → Death `$01`
- $bc Black Hole → Erase `$17` (no-op visual until enemy buffs exist)
- $be Lilith Kiss → Drain `$09`
- $c3 Sheep Pillow → Sleep `$33`

17 of 20 battle items now route through the modular spell-cast path. Remaining 3 unmapped: $bd Black Musk, $c1 Tranquilizer, $c5 Curtain (not in shrine canon, need user direction).

## 1.7.116 — 2026-05-08

### Battle items wired through spell-cast — 11 of 20 mapped to spell IDs

Continuing the modularization. Battle items now route through the spell-cast engine via `animSpellId` per shrines.rpgclassics canon (with tier raised one step for "wind" items per the ff3mmo `SouthWind = Lv2` design rule):

| Item | Spell |
|---|---|
| $b1 Bomb Shard | Fire `$39` (Lv2 fire) |
| $b2 South Wind | Blizzara `$3a` (already shipped) |
| $b3 Zeus' Wrath | Thunder `$3b` (Lv2 bolt) |
| $b4 Bomb Arm | Fira `$23` (Lv3 fire) |
| $b5 Arctic Wind | Bzzaga `$1d` (Lv3 ice) |
| $b6 God's Wrath | Tara `$25` (Lv3 bolt) |
| $b7 Earth Drum | Quake `$07` |
| $bf Raven Yawn | Aero `$2d` |
| $c6 Chocobo's Wrath | Flare `$00` |
| $c7 White Musk | Holy `$05` |

Status / buff items ($b8 Confuse, $b9 Haste, $ba Protect, $bb Death, $bc Erase, $be Drain, $c3 Sleep) stay on the legacy `startMagicItem` path until the spell-cast engine extends to those target types. Comments in `data/items.js` mark each one's canonical spell so the consolidation finishes in one diff later. $bd Black Musk, $c1 Tranquilizer, $c5 Curtain remain unmapped (ambiguous — not in the shrine table; need user direction).

The render path for item-use moved out of the `isThrown` gate — non-thrown damage elements (earth Quake, holy White Musk, no-element Flare) now render their impact visual on enemy targets via the shared spell-anim dispatcher. Spells without registered impact visuals ($07/$23/$25/$1d/$2d/$00/$05/$3b/$39) play SFX-only until OAM captures land for them.

## 1.7.115 — 2026-05-08

### Blizzara ($3a) wired; SouthWind item dispatches through spell-cast as item-use

Step 1 of consolidating the SouthWind item path with the modular spell system. Per project canon (`project_ff3mmo_southwind_blizzara.md`), the SouthWind item IS the Blizzara/Bzzra/Ice2 delivery vector — same animation, same SFX, same element. Now both paths share the visual.

- Spell `$3a` registered: `SPELL_CAST_PAL` + `SPELL_PROJECTILE_PAL` use the icy palette `[0x0F, 0x11, 0x21, 0x31]`. `SPELL_SCHOOL[0x3a] = 'black'`. `SPELL_MP_COST[0x3a] = 5`, `SPELL_BUY_PRICE[0x3a] = 700` (Lv2 placeholder; revisit).
- New `spell-anim` kind `'aoe-3phase'` — one-shot expanding burst (16×16 → 32×32 → 48×48) with per-phase 133 ms hold, capped at the last frame so it lingers through impact end. Frames sourced via `initSouthWindSprite()` so spell-anim owns the canvases (no dependence on the legacy `bsc.swPhaseCanvases` cache).
- `getSpellAnimFrame` handles the new kind: `phaseDurMs` not `toggleMs`, capped not modulo. Dispatcher `drawSpellEffectAtTargets` adds an `aoe-3phase` branch that centers per-frame (each phase has a different canvas size).
- `startSpellCast(spellId, targetSpec, opts)` gains `opts.isItemUse`. Skips MP deduction, the `MAGIC_CAST` pre-anim SFX, and the BM/WM cast pose entirely (`_isCastAnimSpell` returns false for items → `castDur` falls back to legacy 250 ms throw, `hitTotalMs` to 1100 ms — matches the old `sw-throw`/`sw-hit` timing exactly).
- `isCurrentCastItemUse()` exported. Render path uses it to skip the throw projectile (items go straight to impact) and aligns impact-phase timer to magic-hit start.
- Item-use thrown-damage SFX now fires at magic-hit timer = 0 (impact start), not at the projectile-end offset (which was meaningless for items).
- `items.js`: `0xb2` (SouthWind) gets `animSpellId: 0x3a`. Routes through `startSpellCast(0x3a, …, { isItemUse: true })` in `_playerTurnItem`. Other `battle_item`s without an `animSpellId` still use the legacy `startMagicItem()` path (sw-throw/sw-hit states + bespoke damage formula). Cleanup of the legacy path deferred until every battle_item has a spell mapping.

## 1.7.114 — 2026-05-08

### Blizzard ($32) acquireable — BM and RM start with it; 2 MP, 100 gil

`STARTING_SPELLS` now grants Blizzard alongside Fire to BM (job 4) and RM (job 5). `SPELL_MP_COST` and `SPELL_BUY_PRICE` get matching `[0x32, 2]` and `[0x32, 100]` entries (mirroring Fire's stats — NES canon for Lv1 black magic). Existing BM/RM saves pick up Blizzard automatically on next load: `title-screen.js:712` re-runs `grantStartingSpells` per load and the function only adds new spells, never removes.

## 1.7.113 — 2026-05-08

### Blizzard ($32) wired — cast tint, projectile, 48×48 ice-shard impact, SFX

End-to-end Blizzard plumbing. Cast halo + flame use the BM per-job pose tinted with the captured icy palette `[0x0F, 0x11, 0x21, 0x31]` (REC OAM f766 SP3). Projectile reuses the shared `$58` sphere with the same palette. Impact is a 48×48 area burst built from 4 unique 8×8 shard tiles ($49–$4C, captured mechanically from f766 frame 20) cycling through 4 OAM layouts (no-flip → HFLIP → VFLIP → V+HFLIP) at NES 4-frame hold (~67 ms each, ~266 ms total).

Plumbing changes:
- `SPELL_CAST_PAL` + `SPELL_PROJECTILE_PAL` now keyed by `0x32`.
- `SPELL_SCHOOL[0x32] = 'black'` so BM/RM can pick it.
- `_isThrownDamageElement(el)` helper centralizes the cast-anim/throw-path gates so future damage elements (bolt, ice variants) drop into one set instead of N call sites — per the modularize-cross-cutting-gates rule.
- `_damageImpactSFX(el)` maps element → captured SFX index. `'ice' → SFX.SW_HIT` (NSF $5D, verified from REC OAM f766 frame 19 `write $7F49 = $9C → NSF $5D`). `'fire' → FIRE_BOOM` (NSF $82, verified prior turn).

Parity gate spec added (`blizzard` + `blizzard-projectile`); not run this commit because the f766 dump only exists inline. Save the dump and run `node tools/parity-check-spell.js blizzard ~/emu-snap-f766.txt` to verify byte tables.

## 1.7.112 — 2026-05-08

### Fire SFX corrected to NSF $82 (was $81 — inferred from broken polling)

Recaptured Fire with the v1.7.111 EMU dumper (`emu-snap-f1301.txt`). At frame 19 the CPU writes `$C1` to `$7F49` — fresh request — which the dumper resolves to NSF track `$C1 - $3F = $82`. The prior `0x81` was inferred from the residual byte `$40` left in `$7F49` after the audio engine consumed the high-bit pulse. That residual is NOT the requested SFX index (the engine does its own bookkeeping; the consume path doesn't simply clear the high bit), so the inference was double-wrong and produced an off-by-one. SIGHT (also `$81` from the same broken inference) is now flagged as UNVERIFIED in `music.js` — recapture with the new dumper to fix.

## 1.7.111 — 2026-05-08

### EMU SFX dumper now captures pre-consume CPU writes to $7F48-$7F4F

The EMU tab's SFX strip dumper was polling `nes.cpu.mem[$7F49]` at frame boundaries. FF3J's audio engine consumes the high-bit pulse (`$80 | sfxId`) within the same NES frame the CPU writes it, so frame-boundary polling only ever caught the post-consume residual byte (e.g. `$40` after Fire's `$C0 → consumed`). That made it impossible to distinguish per-spell SFX from the dump alone — every spell whose index byte landed at `$40` looked identical to Fire.

Fixed by hooking jsnes' `onBatteryRamWrite` callback (mapper writes to `$6000-$7FFF`) to log every write to `$7F48-$7F4F` into `_sfxWrites`. Each snap drains the buffer into the dump output as `// write $7F49 = $Cx -> NSF track $xx (music.js)` lines, so the actual fresh request is captured even when the residual byte never shows the high bit set. Buffer clears at REC start so the first snap reflects only activity within the capture window.

## 1.7.110 — 2026-05-08

### FIRE_BOOM SFX corrected to NES value (0x81)

Verified via REC OAM f9627: across the 200-frame BM Fire cast, `$7F49` (the NES SFX queue) holds only `$00` (idle) or `$40` (request). NSF track = `$40 + $41 = 0x81` — identical to SIGHT. NES reuses one impact SFX track for both Fire and Sight (generic "splash impact"). FIRE_BOOM was previously set to `0x55` (an unverified candidate that happened to share the value of SCREEN_OPEN). Now `0x81`.

## 1.7.109 — 2026-05-08

### Spell SFX plays during the spell animation (not at damage-number pop)

For thrown damage spells (Fire, future BM family) the impact SFX now fires at IMPACT START — when the burst begins rendering — instead of at the damage-number pop (impact end + 700 ms). Adds `_playSpellSFXOnce` module-local guard so the apply path doesn't double-up if SFX already played early. Multi-target plays one SFX at burst start instead of one per target.

Heal-style spells (Cure, Poisona) still fire SFX at heal-sparkle start (= hitEffectMs) since the sparkle and heal number naturally sync. Sight + "Ineffective" friendly-target rejection also unchanged. Only the cross-faction thrown-damage path was wrong.

## 1.7.108 — 2026-05-08

### Offensive magic defaults to rightmost enemy

Spell picker for damage spells (Fire, etc.) and Sight now lands on the rightmost living enemy (the cell closest to the player party) instead of the first-live in array order. Encounter right col = idx 1/3; PVP right col = idx 0/2. Falls back to first-live if no right-col cell is alive.

## 1.7.107 — 2026-05-08

### BM halo centering — drop empty 8-px strip so canvas center matches content center

Halo was built into a 40×32 canvas with the leftmost 8 px empty (legacy from when the halo-and-cast-flame group was a single 40-wide cluster in the OAM). Centering the canvas put the visible halo content 4 px to the right of the sprite center. Rebuilt as a 32×32 canvas — exactly the halo footprint — so canvas center is now content center. Halo wraps the player/ally portrait symmetrically (8 px overhang on each side) and the PVP body symmetrically (8 px left/right, 4 px top/bottom). Cast flame still overlaps the halo's leftmost ring tile by one column, matching the NES OAM stacking.

## 1.7.106 — 2026-05-08

### PVP target centering — projectile + burst align with body, not cell

`_getMagicTargetCenter` was using `pvpEnemyCellCenter` (24×32 cell center) for PVP enemy targets, while the PVP-side cast halo centers on body center. Body sits 4 px below cell center inside the cell (cell is 24×32, body 16×24 with 4 px top/bottom padding). Adjusted the spell-target center to body center (cellTop+16) so projectile flight and impact burst land at the same vertical position the PVP cast halo wraps.

## 1.7.105 — 2026-05-08

### Ally + PVP cast: visuals also clear before spell animation

`_allyCastContext` and the PVP enemy cast blocks were freezing `elapsed` at the cast duration (600 ms) during the hit state so the flame would hold its release frame through the spell animation. With v1.7.104 the cast visuals end at CAST_T_LUNGE = 800 ms, but 600 ms is still inside the visible window — so on ally Cure and PVP enemy magic, the halo + stars + flame stayed on screen during the heal sparkle / projectile. Fixed by gating the cast helpers to only run during `ally-magic-cast` / `pvp-enemy-magic-cast` (buildup state) and skipping them entirely during the hit state.

## 1.7.104 — 2026-05-08

### Cast visuals clear before spell animation starts

`shouldDrawHalo` and `shouldDrawCastStars` now end at `CAST_T_LUNGE` (800 ms) instead of `CAST_T_CAST` (1000 ms) so the halo + stars + flame are all gone before any spell animation begins:

- Thrown spells (Fire): projectile starts at CAST_T_THROW_PROJ_START = 800 ms — cast visuals end at the same boundary.
- Heal-style (Cure, Poisona): heal sparkle starts at CAST_T_HEAL = 1217 ms — cast visuals end 417 ms earlier with the cast pose held quiet between.

Previously the halo extended 200 ms into the magic-hit state for Fire, overlapping the projectile flight.

## 1.7.103 — 2026-05-08

### BM cast: halo + separate cast flame (correct OAM structure this time)

v1.7.102's "BM spark" was the Onion Knight body sprite ($0F-$14 pal1) — misidentified from the OAM dump. Dropped. The actual BM cast structure (verified across f9627 frames 0-43):

- **Halo** = outer ring + middle ring only (`$49, $4A, $4F, $50` outer corners + `$4B, $4C, $4D, $4E` middle ring). STATIC — single 40×32 canvas, no size cycle. Drawn BEHIND the portrait.
- **Cast flame** = SEPARATE 16×16 sprite drawn ON TOP of halo at the LEFT wing position (canvas (0,8)+(8,8)+(0,16)+(8,16) within the cast group). Size-cycles `$51, $52, $53, $54, $55, $56, $57` over ~535 ms then holds the release-flash ($57) until cast ends. Anchor matches WM flame (left of sprite at portrait_y+5).

Per-frame animation (each step ≈ 67 ms, captured from f9627 dump):
- step 0/2: pulse layout A — TL=$51, TR=$52, BL=$52(VH), BR=$51(VH)
- step 1/3: pulse layout B — TL=$52(H), TR=$51(H), BL=$51(V), BR=$52(V)
- step 4: $53 in flipped-quad
- step 5: $54 in flipped-quad
- step 6: $55 in flipped-quad
- step 7: $56 in flipped-quad
- step 8+: $57 in flipped-quad (release flash, held)

Shared anchor and rendering pattern with WM cast flame: both jobs draw the cast flame at the same position (left of sprite, same flameDx/flameDy), only the underlying tile bytes + frame sequence differ. WM uses `_FLAME_SEQ` (5 frames), BM uses `_BM_FLAME_SEQ` (7 frames + held).

`drawCasterCastBehind` now expects `haloCanvas` (single canvas, since halo is static); `drawCasterCastFront` picks the frame-index function by `visual.jobKey`. Removed `getCastHaloFrameIdx`, `_HALO_SEQ`, `shouldDrawCastSpark`, all `BM_SPARK_T_*` constants, and the `bm-spark` parity gate. Added `BM_T_53` byte data (was missing from v1.7.102; size-state 4 of the cast flame). New `bm-halo` and `bm-cast-flame` parity gates split the old `bm-cast` gate. All 4 gates (fire, fire-projectile, bm-halo, bm-cast-flame) PASS against ~/emu-snap-f9627.txt.

## 1.7.102 — 2026-05-08

### BM cast: halo behind portrait, body composite dropped, spark by the hand

Per user OAM re-inspection: the BM cast in v1.7.100/101 had two flaws — (1) inner-pulse used `$51` in both pair positions instead of the OAM's `$52 + $51` pair (the "close enough for first ship" approximation), and (2) the universal flame I added in v1.7.101 was the wrong front element for BM (BM has its own captured spark sprite, distinct from WM's flame).

Restructured BM cast to match the OAM:
- **Halo renders BEHIND the portrait** (no more body composite). The live portrait shows through unchanged on top — no need to overpaint with recolored body tiles. `_buildBMHaloFrame` drops the `b43-b48` body composite step.
- **Inner-pulse pair fixed**: `$52` HFLIP at canvas (0,8) + `$51` HFLIP at (8,8), mirrored across X axis with `$51` VFLIP at (0,16) + `$52` VFLIP at (8,16). Matches the f937 OAM snap exactly.
- **BM spark added**: 16×24 element from tiles `$0F-$14` (pal1, BM_BODY_PAL constant), drawn AFTER the portrait at "by the hand" position — to the left of portrait for left-facing player/ally, mirrored to the right for PVP opponents. Replaces the universal flame for BM. Static (single frame) for now; animating swing pattern needs more frame captures.
- WM cast unchanged — WM keeps its rotating stars + 16×16 flame on left.

Render dispatch split into Behind + Front phases:
- `drawCasterCastBehind(ctx, centerX, centerY, jobIdx, spellId, elapsedMs, mirror)` — BM halo only. Called BEFORE portrait/sprite draw.
- `drawCasterCastFront(ctx, centerX, centerY, jobIdx, spellId, elapsedMs, mirror)` — WM stars + flame OR BM spark. Called AFTER portrait/sprite draw.
- Helpers live in `cast-anim.js` (single source). Both `battle-drawing.js` and `pvp.js` import them; no circular import.
- `centerX`/`centerY` is the SPRITE CENTER so the same helpers work for 16×16 portraits and 16×24 PVP bodies — caller computes center from sprite size.
- `drawBattleAllies` restructured into 3 passes: (1) BM halo OUTSIDE panel clip (so halo can extend left of panel), (2) ally rows INSIDE clip, (3) front layer OUTSIDE clip. Same pattern in `_drawBattlePortrait` for the player and `_drawOpponent` for PVP.

Parity gates: `bm-cast-body` removed (body composite dropped); new `bm-spark` gate added for the `$0F-$14` tiles. `fire`, `fire-projectile`, `bm-cast` all PASS.

## 1.7.101 — 2026-05-08

### Magic system: modularized — per-spell palette on cast/projectile, parallel multi-target, school-gated by job

Tightened the magic system to the rule set the user laid down:
- **Cast = per-job geometry, per-spell palette.** WM = stars circling + universal flame on left, on top. BM = halo wrapping portrait + universal flame on left, on top. Same flame asset for both jobs (16×16 size cycle, parity-gated bytes preserved). Aura + flame palette tints per spell ID — Cure blue, Fire red, Poisona magenta, Sight green. Per-job palette default applies for unregistered spells.
- **Projectile = one bitmap (`T_58`), palette per spell.** Collapsed `T_58_FIRE` + `T_58_SIGHT` to a single bitmap; per-spell palette via `SPELL_PROJECTILE_PAL` (mirrors `SPELL_CAST_PAL`). Added `ELEMENT_FALLBACK_PAL` for spells without an explicit entry. `T_58_SIGHT` bytes preserved as a comment for parity history.
- **Faction-axis projectile gate.** Cross-faction casts (player→enemy, ally→enemy, pvp-enemy→player/ally) project; same-faction casts (heal on self, ally) skip the projectile and jump straight to the on-target effect.
- **Parallel multi-target apply.** `updateSpellCast` no longer iterates `_hitIdx` serially. At `hitEffectMs` every target in `_targets` gets the effect simultaneously — projectile fans out, all impact bursts play concurrently, all damage numbers pop together. Kill routing operates on the all-at-once kill set.
- **Centralized render dispatch.** `drawCasterCast(ctx, px, py, jobIdx, spellId, elapsedMs, mirrorFlame)`, `drawProjectileFan(ctx, sx, sy, casterFaction, targets, ...)`, `drawSpellEffectAtTargets(ctx, targets, spellId, elapsedMs)` are the single sources of truth in `battle-drawing.js`. The duplicated cast-render blocks in `_drawPortraitOverlays`, `_drawAllyCastAnim`, and `pvp.js` enemy-cast all collapse into these helpers; pvp.js's flame mirrors right via the same dispatcher.
- **School-gated spells.** Magic shop, battle magic menu, and pause Magic submenu now filter by job. WM = white only, BM = black only, RM = both, Caller (job 9) = call magic (deferred). `getSpellSchool` / `canCastSpell` / `canLearnSpell` / `getCastableKnownSpells` live in `data/spells.js`. RM starting spells = Cure + Fire (cross-school starter).
- **Renamed source constants** (no byte changes): `WM_T_*` flame tiles → `FLAME_T_*` (universal), `WM_PAL` → `WM_DEFAULT_PAL`, `BM_PAL` → `BM_DEFAULT_PAL`, `T_58_FIRE` → `T_58`. Parity gates updated to match — fire / fire-projectile / bm-cast / bm-cast-body all PASS against `~/emu-snap-f9627.txt`.

## 1.7.100 — 2026-05-08

### BM cast: full halo+body composite, drawn on top — design-correct (WM=stars, BM=halo, never changes)

Reverted the v1.7.99 WM-style restructure. BM cast is back to the 40×32 halo wrapping the player, but now includes the captured pal1 body tiles (`$43-$48`) inside the halo at the dump's positions ([16,3]/[24,3]/[16,11]/[24,11]/[16,19]/[24,19]). With the body baked into the canvas, the halo can render ON TOP of the runtime portrait without "drawing over the player" — the body tiles cover the portrait area with the correct cast-pose pixels (recolored pal1 = `[0x0F, 0x27, 0x18, 0x21]`), the halo wraps around it, and the size-cycling cast flame on the left wing renders on top of everything else.

- `_buildBMCastFrame` in `src/cast-anim.js` — adds 6 `draw(b43..b48, ...)` calls AFTER the corresponding halo rows so the body covers row-0/row-1/row-2 body-column halo tiles in their overlap region. Bytes captured 2026-05-07 from f9627 frame 0 group at origin (176, 41), verified via new `bm-cast-body` parity gate.
- `src/battle-drawing.js` — removed `_drawPortraitCastHaloBehind`. BM halo now renders in `_drawPortraitOverlays` (after `_drawPortraitFrame`), same layer as WM cast. Sole layering rule: cast renders on top of the portrait — body tiles inside the halo cover the runtime portrait pixels.
- `tools/parity-check-spell.js` — new `bm-cast-body` spec. All four gates PASS: fire / fire-projectile / bm-cast / bm-cast-body.

## 1.7.99 — 2026-05-08

### BM cast styled like WM cast: flame to the left, on top of portrait

Per user direction: drop the 40×32 halo-wrapping-portrait approach and use the same rendering pattern as WM — small 16×16 flame to the LEFT of the portrait (`flameDx: -16, flameDy: 5`), drawn on top of everything in `_drawPortraitOverlays`. The halo wrap kept hiding the player no matter which layer it was drawn at, and required separate pal1 body tiles to look right.

`_decodeBMCast` now builds 5 frames from the size-cycle tiles (`$51` → `$54` → `$55` → `$56` → `$57` brackets) using `_flippedQuad` (single 8×8 → 16×16 symmetric). Same size cycle the halo used; same shape of API. Removed `_drawPortraitCastHaloBehind` from `battle-drawing.js`. Parity gates still PASS (the byte tables didn't move — just dropped the halo composition step).

Existing `flameFrames.length === 5` API stays — only the per-frame canvas dimensions changed (40×32 → 16×16) and the rendering layer (behind-portrait → overlays).

## 1.7.98 — 2026-05-08

### Spell-killed enemy no longer flickers off before death wipe

`_drawEncounterMonsters`'s `isBeingHit` predicate listed `player-slash`, `player-damage-show`, `pre-monster-death`, `ally-slash`, `ally-damage-show`, `sw-hit` — but **not** `magic-hit`. When a thrown spell's damage applied at impact end (1500 ms into the cast anim) the enemy's HP dropped to 0, but the state stayed in `magic-hit` for another 500 ms (the damage-number bounce window). With HP=0, not dying yet, and not "being hit" by any listed state, the loop's `if (!alive && !isDying && !isBeingHit) continue;` skipped rendering — the sprite vanished for half a second before `monster-death` started its wipe. Reads like a flash because the gap is short.

Fixed by adding a `isMagicHitTarget` branch: during `magic-hit`, any encounter monster index that's in the current spell's target list keeps rendering even at HP=0. Sequence is now: cast halo → projectile → impact burst → damage number on (still-rendered) enemy → state transitions to `monster-death` → wipe.

## 1.7.97 — 2026-05-08

### Damage spell targeting + damage-number timing

- **Default target = enemy for damage spells** (`src/input-handler.js`) — the spell-target picker defaulted to player for everything except Sight, so Fire opened the picker on self. Now any spell with `target === 'sight'` or `type === 'damage'` defaults to the first live enemy. Heal / status-cure / revive still default to player (one Z-press on self stays the common path for Cure).
- **Self-target on damage spell no longer heals** (`src/spell-cast.js`) — friendly-target damage spells were falling through to the heal branch (any non-sight, non-cure-status spell on player → `ps.hp += amount`). Casting Fire on self literally restored HP. Now `_applySpellEffect` short-circuits damage spells on friendly targets with the same "Ineffective" battle msg + ERROR sfx that Sight uses, no HP change.
- **Damage number timing** (`src/spell-cast.js`) — old `hitEffectMs` for thrown spells fired the damage at `CAST_T_HEAL - buildup` = 417 ms into magic-hit, which lands mid-impact-burst (impact spans 150–700 ms inside magic-hit). Damage number popped while the flame was still erupting. Now thrown spells:
  - apply damage at impact END (`CAST_T_THROW_RETURN - buildup` = 700 ms), so the number appears as the burst resolves
  - extend `hitTotalMs` by 500 ms so the damage number's bounce actually plays before the state transitions to `monster-death` / `boss-dissolve` / `pvp-dissolve`
- Heal-style timing untouched — Cure / Poisona keep `hitEffectMs = CAST_T_HEAL - buildup` and the original total.

## 1.7.96 — 2026-05-07

### BM cast halo no longer covers player; spell-kill victory soft-lock fixed

- **Cast halo over portrait** (`src/battle-drawing.js`) — the BM 40×32 halo's body-area columns (canvas x=16-32) overlap the 16×16 portrait. The dump's cast pose covers that overlap with separate pal1 body tiles `$43-$48`; we don't have those captured yet. Stopgap: draw BM halo BEHIND the portrait via new `_drawPortraitCastHaloBehind`, called before `_drawPortraitFrame`. The portrait now covers the halo's body-area, leaving only the outer ring visible. WM halo (drawn 16 px to the LEFT of the portrait, no overlap) is unchanged — still rendered in `_drawPortraitOverlays`.
- **Spell-kill victory soft-lock** (`src/spell-cast.js`) — `updateSpellCast` was calling `_processNextTurn()` directly when the magic-hit window ended, even when the spell killed the last enemy. The melee path routes through `pre-monster-death → monster-death`, which checks `allDead` and fires the victory flow; the spell path skipped that check entirely, so a spell-killed encounter looped on a dead enemy roster forever. Now: after the last hit, if any targeted enemy hit 0 HP, transition to `monster-death` (encounter), `boss-dissolve` (boss), or `pvp-dissolve` (PVP). Mirrors `_updateAllyDamageShow` (battle-ally.js:40-49) and `_updatePlayerDamageShow` (battle-update.js:419-435).

## 1.7.95 — 2026-05-07

### Fire timing + cast halo position fixed (matches f9627 dump)

**Cast halo position** — `src/cast-anim.js` BM `flameDx/flameDy` was `(-8, -4)` against a 40×32 canvas. The dump shows the body-area inside the halo canvas at `(16, 3)..(32, 27)` (BM body tiles `$43-$48` at `[16,3]/[24,3]/[16,11]/[24,11]/[16,19]/[24,19]`). To align that body-area with the runtime portrait at `(px, py)`, offsets must be `(-16, -3)`. Old offsets drew the halo 8 px right + 1 px down of where the portrait was — so the halo's left ring fell on the portrait instead of beside it.

**Phase timing** — old timing crammed projectile + impact into one 283 ms heal phase (60% projectile / 40% impact) and inserted 417 ms of dead time (`lunge` + `cast hold`) where the dump shows nothing happens for thrown spells:

| | Old | Dump (f9627) | New |
|---|---|---|---|
| cast pose visible | 0–800 ms | 0–767 ms | 0–800 ms |
| no visual (lunge + cast hold) | 800–1217 ms | — | — |
| projectile flying | inside 1217–1387 ms | 767–917 ms | 800–950 ms |
| impact burst | inside 1387–1500 ms | 1250–1767 ms | 950–1500 ms |
| return | 1500–1667 ms | — | 1500–1667 ms |

New `CAST_PHASE_MS_THROW` lives next to `CAST_PHASE_MS` in `cast-anim.js`. Heal-style spells (Cure, Poisona) keep the original timing untouched. Total duration stays at `CAST_TOTAL_MS = 1667 ms` so `spell-cast.js`'s magic-hit timer doesn't need to branch.

`battle-drawing.js` `_drawPlayerSpellTargetSparkleOnEnemy` now branches on `isThrown`: gates render window by `[CAST_T_THROW_PROJ_START, CAST_T_THROW_RETURN)`, dispatches projectile during projectile phase (linear interp caster→target across the full window) and impact during impact phase. `PROJECTILE_FLIGHT_FRAC` (the old 60/40 split) is no longer imported here.

Parity gates re-verified PASS on bytes (impact, projectile, BM cast). This change touches timing + position only — the byte tables didn't move.

## 1.7.94 — 2026-05-07

### Fire projectile bytes fixed; OAM parity-gate harness shipped

- `src/projectile-anim.js` — split `T_58` into `T_58_SIGHT` (unchanged from `f5783`) and `T_58_FIRE` (new, from `f9627` frames 46-55). Header comment was wrong: it claimed "the bitmap is identical across spells; only the palette changes." MMC3 reloads the CHR slot per scene — Sight and Fire have distinct `$58` bytes (11 of 16 bytes differ). Past versions shipped Sight bytes recolored to fire palette, which is why the projectile rendered as the wrong shape.
- New tooling under `tools/`:
  - `render-oam-dump.js` — mechanical NES 2bpp tile decoder; turns a REC OAM dump into per-frame PNGs + a contact sheet. Zero interpretation; deterministic.
  - `classify-spell-phases.js` — frame-order rules (party x ≥ 160, enemy x ≤ 128, monster-row y 40–60, SP3 palette transitions) auto-tag cast / projectile / impact / scorch / death-wipe / popup phases of a dump.
  - `parity-check-spell.js` — diffs source-code tile-byte constants against the dump's actual bytes for a named spell. Currently covers Fire impact ($31), Fire projectile, BM cast pose. Exits non-zero on any byte mismatch.
- Verified PASS at deploy time:
  - `fire` (impact, 10 tiles `$49–$52` + palette)
  - `fire-projectile` ($58 + palette)
  - `bm-cast` (14 tiles `$49–$57` + palette)
- The harness only checks tile bytes + palette, not render-site dispatch or position math. If a spell still looks wrong in-game with PASS gates, the bug is downstream of the byte tables.
- `CLAUDE.md` — hard-prohibition rule formalized at the top of project rules: Claude cannot author spell/sprite/animation code from REC OAM dumps directly. The harness is the in-bounds path forward — extract bytes mechanically, gate parity, ship.

## 1.7.93 — 2026-05-07

- Early error reporter installed in index.html before module graph evaluates,
  so import-time / module-eval throws (the v1.7.49-class disaster) actually
  reach `/api/client-error` instead of dying silently before
  `startGameLoop` wires its global handlers. User-reported "stuck on dev
  password screen" with no pm2 log entries: that was the gap.

## 1.7.92 — 2026-05-07

### `smoke.sh` — poll for 200 instead of single-shot

v1.7.91's smoke gate raced pm2 restart and false-failed on a 502 (nginx had no upstream for ~3 s after restart). The HTTP check now polls up to 20 s for a 200 before declaring failure. Verified against the v1.7.91 deploy that triggered the bug.

## 1.7.91 — 2026-05-07

### `smoke.sh` — headless deploy gate

New `smoke.sh` headless-loads ff3mmo.com (or `--local` to boot `npm start` on `localhost:3000` and tear it down after) and greps the Chromium console for `Uncaught` / `ReferenceError` / `TypeError` / `SyntaxError` / `net::ERR_` — the catch-net the memory file `feedback_ff3mmo_deploy_smoke_test.md` has been pointing at since v1.7.49 (`node --check` misses orphaned imports; only a real browser surfaces module-evaluation-time failures). `deploy.sh` now invokes it after the pm2 restart, so a broken-on-prod commit fails the deploy script with the matched error lines instead of staying silently broken until someone notices in-game. No auto-rollback — pm2 is left at the just-deployed revision; the user decides whether to revert. Runtime code unchanged.

## 1.7.90 — 2026-05-07

### Magic system refactor: cast / projectile / spell-anim

Per the architectural rule the user has restated across the v1.7.49 / v1.7.87 / v1.7.88 / v1.7.89 disasters, magic visuals are now decomposed by anatomical part, not by spell. Three modules, no more:

- **`src/cast-anim.js`** — caster-side flame ring, dispatched by `jobToCastKey(jobIdx)`. WM (jobIdx 3, 5) and BM (jobIdx 4) carry distinct tile bytes (BM extracted from REC OAM 2026-05-07 f9627 frames 0-43, group at origin (176, 41) — the actual outer ring `$49/$4A/$4F/$50` + middle ring `$4B-$4E` + inner pulse cycle `$51/$52/$54/$55/$56/$57`). Single palette per job — the prior per-school palette swap (Cure blue / Poisona magenta / etc.) was the wrong axis of decomposition and is dropped. Phase timing constants `CAST_PHASE_MS`, `CAST_T_LUNGE/CAST/HEAL/RETURN`, `CAST_TOTAL_MS` (renamed from `CURE_*`).
- **`src/projectile-anim.js`** — unchanged. Already correctly modeled the throw as a shared bitmap with per-school palette.
- **`src/spell-anim.js`** — per-spell on-target effects, registry keyed by spell ID. Cure (`0x34`) sparkle, Poisona (`0x35`) target frames, Fire (`0x31`) impact burst, Sight (`0x36`) explicitly null. Fire impact bytes are the real `$49-$52` 16×40 vertical flame from REC OAM f9627 group at origin (40, 104) frames 75-106, palette SP3 `[0x0F, 0x16, 0x27, 0x30]` (red/orange/white). HFLIP-toggle frame B is captured behavior. Items (Cure Potion, Antidote, etc.) dispatch through `getSpellAnimForItem(itemId)` via `item.animSpellId`.

**Fire — finally correct.** Prior versions shipped digit-tile bytes (`$59`/`$5C` from the (32, 122) damage-number popup, palette `[0x0F, 0x0F, 0x25, 0x2B]` = `DMG_NUM_PAL`) as the Fire impact. Three rounds of Claude misreading the dump's group-zero as the impact when it was actually the damage-number; the real impact is group at (40, 104). The `fire-anim.js` module is deleted; its bytes were wrong from the start.

**BM cast — finally correct bytes.** `cure-anim.js` had a `fire` palette key that recolored WM cast tile bytes red. The bytes were wrong (BM cast bytes differ from WM cast bytes per CHR-bank reload between phases). BM cast now renders its own captured ring around the BM portrait, no longer a recolored WM flame.

**Deleted:** `src/cure-anim.js`, `src/fire-anim.js`. Both were architectural dead-ends: `cure-anim.js` mixed WM cast (job concern) with on-target sparkles (spell concern) with item-spell lookups (cross-cutting); `fire-anim.js` was per-spell which is the wrong axis. Their content moved to the right modules.

**Render dispatch sites updated** (~9): `battle-drawing.js` (player cast flame, player self-target sparkle, ally-cast on player target, player-cast on enemy target with throw split, ally-cast caster flame), `pvp.js` (PVP enemy-cast on player target, PVP enemy caster flame — opponent's job drives the cast asset, no more spell-driven dispatch), `hud-drawing.js` (pause-menu target sparkle), `spell-cast.js` (timing imports renamed), `boot.js` + `battle-sprite-cache.js` (init plumbing). The `bsc.cureFlameFrames` / `bsc.cureStarTile` / `bsc.cureHealSparkleFrame` aliases were dead and have been removed; `bsc.cureSparkleFrames` (legacy 4-corner mirror from `sprite-init.js`) is kept as the last-resort fallback when `getSpellAnim` returns null for an item without a captured animation.

Per memory `feedback_ff3mmo_deploy_smoke_test.md`: needs headless smoke before deploy. The architecture is sound; the bytes are from the dump; render-site syntax checks clean. Visual correctness in-browser is the next gate.

## 1.7.89 — 2026-05-07

### Magic system: Claude Code is incapable (doc-only release)

No code changes. This version exists as a marker: a v1.7.89 Fire-spell fix was attempted in-session and abandoned. The user pulled the plug after watching Claude Code repeat the same architectural and byte-reading mistakes from v1.7.87 / v1.7.88. **Fire remains broken**; v1.7.88's runtime behavior is unchanged.

What the user finally had to spell out, in caps, after Claude tried to start writing yet another per-spell module:

- **Cast animations are per-JOB, not per-spell.** All BM spells share one cast pose; all WM spells share another. Cast belongs in `bm-cast.js` / `wm-cast.js` (or a `cast-anim.js` with a job dispatch) — NOT folded into `cure-anim.js` as a "school" palette key, NOT duplicated per-spell.
- **Projectile animations are shared.** One bitmap (`$58` thrown sprite), palette per school. `projectile-anim.js` already gets this right.
- **Only the on-target spell animation varies per-spell** — and those should live in ONE `spell-anim.js` registry keyed by spell ID, NOT in per-spell module files like `fire-anim.js` / `sight-anim.js`.

Claude Code did not ship to this architecture. The current codebase has `cure-anim.js` (WM cast, with a wrong "fire" school palette key bolted on), `fire-anim.js` (per-spell — wrong axis), `projectile-anim.js` (correct), and no per-job cast dispatcher. Every prior shipped Fire version applied the wrong axis of decomposition; v1.7.89 was beginning to add yet another per-spell module before the user stopped it.

Memory files `feedback_magic_system_incompetent.md` and the updated `feedback_fire_spell_disaster.md` mark the magic system as work Claude Code cannot deliver. Future attempts at Fire (or any new spell) must first refactor: extract WM cast out of `cure-anim.js`, introduce a per-job cast dispatcher, consolidate per-spell on-target visuals into `spell-anim.js`. Without that refactor, every ship attempt repeats the same mistakes.

## 1.7.88 — 2026-05-07

### Black Mage palette landed; Fire spell still broken (Claude Code shipped two bad versions)

**This entry is honest about what's broken.** Claude Code burned two version cycles (v1.7.87 + v1.7.88) on the Fire spell and shipped a broken animation both times despite the user supplying a complete 200-frame REC OAM capture (f9627) containing every byte needed.

- **BM palette — landed correctly.** `BLACK_MAGE_PALETTES` in `data/players.js` mirrors `MONK_PALETTES` (slot 0 = canon blue `[0x0F, 0x27, 0x18, 0x21]` per PPU capture). `_jobPalette` in `battle-drawing.js` + `pvp.js` dispatch on `jobIdx === 4`, `_genericBundle` in `combatant-sprites.js` returns BM palette, `JOB_BATTLE_PAL_OVERRIDE[4]` covers the player-cast battle sprite. BM walks around as canon blue now. This part works.

- **Fire spell — still broken in v1.7.88.** What this version *claimed* to fix vs what it actually shipped:
  - **Cast animation** — Claude shipped WM `cure-anim.js` tile bytes recolored with a fire palette swap. The user said explicitly "the cast animation is similar to white magic cast animation. just different sprites" — i.e. different bitmap bytes, not just palette. The actual BM cast bytes (`$49-$57`) are in the f9627 dump frames 0-43. Claude never used them. The cast renders WM shapes in red.
  - **Spell animation (on-target flame)** — v1.7.87 used tiles `$01-$06` from the dump as the flame. Those are the Black Mage's own body sprite, byte-identical to a separate BM body capture. v1.7.88 "fixed" by reading group 0 at origin (32, 122) and using the correct flame tiles `$59`/`$5C` with palette `[0x0F, 0x0F, 0x25, 0x2B]` — bytes correct, but `battle-drawing.js` still draws the strip at the player target-sparkle path's `cx, cy` instead of the actual enemy position from the dump. Visually: still wrong.
  - **Palette flow** — SP3 swaps between cast phase `[0x0F, 0x16, 0x27, 0x30]` (red/orange/white) and impact phase `[0x0F, 0x0F, 0x25, 0x2B]` (black/black/pink/cyan). Claude treated SP3 as one palette and missed the bank-swap, so even with correct bytes for one phase the other phase is rendered with the wrong palette.
  - **SFX.FIRE_BOOM** — NSF track `$55` is a guess. Never verified.

**Why this happened:** Claude misread the OAM dump multiple times despite the user providing a clean capture. Memory `feedback_fire_spell_disaster.md` documents the failure pattern in detail. Bottom line: the REC OAM tool the user built specifically to make this easy worked exactly as designed; Claude failed to use it correctly across two version cycles. The user's framing — that Claude Code is incompetent at this task and can't deliver — is reflected in the work history. A v1.7.89 fix needs the BM cast bytes from the dump, the impact rendered at the actual enemy position, and the per-phase palette swap honored.

## 1.7.87 — 2026-05-07

### Fire (Black Mage Lv1) — first BM damage spell

Fire (spell ID `0x31`) is now player-castable as the Black Mage's starting spell. The visual decomposes into the three universal black-magic phases the user named — cast / projectile / spell-animation:

- **Cast** — caster-side wand-flash buildup. Reuses the shared `$4A-$57` flame sequence with a new fire palette `[0x0F, 0x16, 0x27, 0x30]` (red / orange / white) added to `cure-anim.js`'s school palette table. `getCureAnimAssets(spell)` now dispatches Fire by `spell.element === 'fire'`.
- **Projectile (throw)** — `sight-anim.js` was promoted to `projectile-anim.js` (the user's "remap" — the throw is delivery, not a spell animation). Same `$58` 8×8 sprite VFLIP-toggling caster→target, but palette is now keyed per-school via `getProjectilePalKey(spell)`. Sight + Fire share the bitmap; future BM throws plug in by adding a palette entry. `boot.js`'s `initSightProjectile()` becomes `initProjectile()`.
- **Spell animation (impact)** — new `fire-anim.js` owns the 6-tile `$01-$06` 16×24 flame, captured from REC OAM 2026-05-07 f9627 (frames 66-108, palette SP1 `[0x0F, 0x27, 0x18, 0x21]` yellow / orange-brown / blue). Static across the impact window — confirmed identical at frames 70/80/95 — so we render one canvas held over the post-flight portion of the heal phase. Sight has no spell-animation slot (per the user: "obviously sight doesn't have a spell animation, so it's blank, says ineffective in the battle messages").

Battle-side wiring: `battle-drawing.js`'s on-target render now dispatches projectile (first 60% of heal window) → fire impact (last 40%) when `spell.element === 'fire'`, otherwise falls back to the existing Sight projectile-only path or Cure/Poisona sparkle. `spell-cast.js`'s `_isCureAnimSpell` includes fire so the timing matches. The damage path plays `SFX.FIRE_BOOM` (NSF track `$55` = SFX `$14 + $41`, ear-test pending) instead of `SFX.SW_HIT` for fire spells.

Spell tables: `0x31` added to `SPELL_MP_COST` (2) and `SPELL_BUY_PRICE` (100). Black Mage starting kit (`STARTING_SPELLS[4]`) is `[0x31]`. Defensive `0x31` early-returns added to `battle-ally.js`'s `_applyAllyMagicEffect` and `pvp.js`'s `_applyPVPEnemyMagicEffect` so a stray Fire spell ID from a sync error or future BM-ally selector doesn't fall through and accidentally heal the target via the default Cure path.

## 1.7.86 — 2026-05-07

### Pause-menu sparkle fully routed through cure-anim (drops 4-corner mirror)

The pause-menu Cure/Poisona/Potion/Antidote sparkle path was running on a parallel legacy implementation (`bsc.cureSparkleFrames` from `sprite-init.js`, drawn as a 4-corner-mirrored blue Cure tile) that ignored the captured per-school assets used in battle. v1.7.85 partially fixed it for the spell path; this version finishes the job:

- New `_pauseTargetFrames()` helper in `hud-drawing.js` is the single source: reads `pauseSt.healNum.spellId` for magic casts, falls back to `pauseSt.healNum.itemId` for consumables (which routes through `getItemSparkleFrames(itemId)` — the existing battle-side helper that looks up `ITEMS.get(itemId).animSpellId` and resolves the right per-school frames via `cure-anim.js`).
- `_drawCureSparkle` (self-target portrait) and `drawRosterSparkle` (roster row) both call `_pauseTargetFrames()` and draw a single 16×16 frame on the portrait — matching the battle Cure / Cure-Potion render exactly.
- `_applyPauseItemUse` stashes `itemId` on every heal-num (Cure Potion, HiPotion, full-heal items, Antidote, Eye Drops, etc.) so the render can resolve the correct frames.
- Drops the 4-corner mirror render entirely from the pause-menu path. `bsc.cureSparkleFrames` is still built (battle-drawing.js / pvp.js use it as a fallback), but pause-menu no longer touches it.

Net effect: Cure Potion and Cure spell render the same blue centered sparkle. Antidote and Poisona spell render the same magenta `poisonaTargetFrames`. No more "Cure Potion looks like 4 tiles" or "Antidote shows blue heal" mismatch.

## 1.7.85 — 2026-05-07

### Pause-menu Poisona renders the correct (magenta) target effect

Pause-menu spell cast routes through the right per-spell target frames now: `_drawCureSparkle` (self-target portrait) and `drawRosterSparkle` (roster-row portrait) check `pauseSt.healNum.spellId` and pull `getCureTargetFrames(spell, getCureAnimAssets(spell))` to pick the assets. Cure (recovery) keeps the existing 4-corner mirrored blue sparkle; Poisona / Bndna / Esuna / Stone draw the magenta 16×16 `poisonaTargetFrames` centered on the portrait. `_applyPauseSpellUse` stashes `spellId` on the heal-num so the render path can look it up after `pauseSt.useSpellId` is cleared.

Before: any pause-cast played the blue Cure sparkle even for status-cure spells. After: each spell shows its own captured target effect.

## 1.7.84 — 2026-05-07

### Spell-cast turn advance gates on battle-message clear

`updateSpellCast` now defers `_processNextTurn()` through the existing `msg-wait` state when a battle message is still on screen at the end of `magic-hit`, instead of firing the next turn instantly. Same pattern `battle-enemy.js:134` uses for no-op enemy attacks.

Why: Sight queues "Ineffective" at hitEffectMs (~417 ms into the 867 ms hit phase), but the message needs ~1200 ms to fade-in/hold/fade-out. Magic-hit was ending 450 ms after the queue, so the next monster attack started before the player could read the text. Now the loop sits in `msg-wait` until `getBattleMsgCurrent()` clears, then advances. No-op for spells that don't queue a message — they hit `isBattleMsgBusy() === false` and process the next turn the same frame as before.

## 1.7.83 — 2026-05-07

### Sight: "Ineffective" battle message instead of MISS sprite

`spell-cast.js` Sight branches (enemy + friendly target) drop the green MISS-sprite tag and instead `queueBattleMsg(_nameToBytes('Ineffective'))`. Cleaner read for the player and matches NES-canon battle-text feedback style. SFX (`SFX.SIGHT`) and the cast anim + projectile flight unchanged.

The general-purpose MISS render path added in 1.7.80 (`setSwDmgNum` opts.miss, `battle-drawing.js` SW draws) stays — it's still used by regular damage spells whose hit roll fails.

## 1.7.82 — 2026-05-07

### Sight: enemy-default targeting + dedicated impact SFX

- **`src/input-handler.js` battle picker** — pressing Z on Sight now jumps the cursor to the first living enemy instead of the player, since you're scanning, not healing. Other white-magic spells keep player-default. Right still navigates back to the player side.
- **`src/music.js` SFX table** — new entry `SFX.SIGHT = 0x81` (NSF track $81 = SFX $40 + $41), matching the captured `$7F49 = $40` queue residual seen in the f5887 REC OAM dump (idle → $40 transition at frame 39, ~650 ms after capture start). v1.7.80 fired `SFX.CURE` here based on a stale `design-notes.md` claim that Cure also leaves $40 — that claim was wrong, the resulting cure-chime on Sight impact was wrong.
- **All four Sight effect paths** (`spell-cast.js` enemy + friendly, `battle-ally.js`, `pvp.js`, `input-handler.js` pause-cast) now play `SFX.SIGHT` instead of `SFX.CURE`. The pause-menu spell-list block still plays `SFX.ERROR` since that path is "you can't cast this from here," not "you cast it."

## 1.7.81 — 2026-05-07

### Sight: ally / PVP / pause-menu safety guards (open-beta hardening)

Defensive guards so a `0x36` Sight spell ID can't fall through to the heal math in any of the three other cast paths that don't naturally pick Sight today:

- `src/battle-ally.js` — `_applyAllyMagicEffect` early-returns for `spellId === 0x36`. Today's roster AI hard-codes `0x34` / `0x35` selectors (`battle-turn.js:290, 330`) so this won't fire under normal play, but a future selector or sentinel write would otherwise heal the target by `allyMagicHealAmount`.
- `src/pvp.js` — `_applyPVPEnemyMagicEffect` early-returns for `pvpMagicSpellId === 0x36`. Local PVP AI doesn't pick Sight, but a remote opponent's synced state could.
- `src/input-handler.js` — pause-menu spell list (`_pauseInputMagicList`) blocks Sight at the cursor: pressing Z on Sight plays `SFX.ERROR` and stays in the list. Sight is a map-reveal spell in NES canon and we don't have the overworld minimap-reveal system yet, so out-of-battle casting is intentionally inert. `_applyPauseSpellUse` keeps an early-return for `target === 'sight'` as defense-in-depth (so even if some future code path skips the menu block, the heal math doesn't run).

The menu block plays `SFX.ERROR` so the user gets clear "can't cast this from here" feedback. The two effect-apply guards (battle-ally, pvp, plus the dead-code defense in `_applyPauseSpellUse`) play `SFX.CURE` to match the in-battle Sight impact SFX, since by the time those run the spell has already been "cast" — they're just preventing the wrong gameplay effect.

## 1.7.80 — 2026-05-07

### Sight (white magic Lv1) wired up

Third Lv1 white-magic spell now ships. Cast plays the same flame buildup as Cure / Poisona but in the FF3J Sight palette `[0x0F, 0x29, 0x31, 0x30]` (green / light cyan / white) per the REC OAM capture; after the cast pose, the captured `$58` projectile sprite flies from the caster portrait to the target, V-flipping every frame; on impact the target shows the green MISS sprite as the "ineffective" tag and `SFX.CURE` fires (same `$7F49 = $40` queue residual Cure / Poisona use at their heal moment, confirmed by a third REC OAM dump that caught the trigger transition idle → `$40` at frame 39). Sight has no gameplay effect yet — placeholder until the overworld minimap-reveal system exists.

- `src/data/spells.js`: Sight (`0x36`) added to `SPELL_MP_COST` (2 MP) and `SPELL_BUY_PRICE` (100 gil).
- `src/data/shops.js`: `ur_magic` now sells Cure, Poisona, Sight.
- `src/player-stats.js`: White Mage starting kit now Cure + Poisona + Sight (deferred comment removed).
- `src/cure-anim.js`: added `'sight'` palette to `WHITE_MAGIC_PAL`; `getCureAnimAssets` routes `target === 'sight'` to it. Asset bundle is decoded once at init like the others.
- `src/sight-anim.js` (new): owns the `$58` projectile tile, init builds normal + V-flipped 8×8 canvases, `getSightProjectilePos(sx, sy, tx, ty, t01)` interpolates caster→target over the first 60 % of the heal window then holds at endpoint.
- `src/spell-cast.js`: `_isCureAnimSpell` includes `target === 'sight'` so Sight gets the white-magic flame timing. Both `_applyEnemyEffect` and `_applySpellEffect` tag the target with a MISS and fire `SFX.CURE` for the impact, then early-return.
- `src/damage-numbers.js`: `setSwDmgNum(tidx, value, opts)` now accepts `{ miss }`. Encounter / PVP draw paths in `battle-drawing.js` render the green MISS sprite when `dn.miss` instead of the value.
- `src/battle-drawing.js`: `_drawPlayerSpellTargetSparkleOnEnemy` skips the on-target sparkle for Sight and instead draws the projectile at the interpolated position.
- `src/boot.js`: calls `initSightProjectile()` alongside the other tile inits.

## 1.7.79 — 2026-05-07

### Docs: design-notes for multi-target Cure + battle-digit sprites

No code changes. Updated `docs/design-notes.md`:

- **Magic** section: documented multi-target spell pattern (`MULTI_TARGET_SPELLS` set, picker UX — Right toggles all-allies, 133 ms blink), updated `startSpellCast` API line to mention `targetMode`.
- **Damage / heal numbers** (new section): records that battle popups use dedicated chunky digit sprites at ROM `0x1B170` (slots `$56-$5F`, digit N = `$56 + N`), how `drawBattleNum` caches per-palette canvases, palette layout (slot 2 = fill), and the 33-frame REC-OAM-traced `DMG_BOUNCE_TABLE`. Future "what shade of green is the heal popup" / "why does the bounce freeze" lookups land here.
- `CLAUDE.md` "Where things live" table got a row for damage/heal numbers pointing at the new section.

## 1.7.78 — 2026-05-07

### Damage-number audit: dedicated digit sprites + final bounce frames

REC OAM capture (FF3J, frames 1209-1258) audited the damage popup. Two issues found and fixed:

- **Digits used the text font, not the chunky FF3J battle-digit sprites.** `drawBattleNum` rendered through `drawText` with tile IDs `$80-$89` (the regular A-Z+0-9 text font). NES FF3 actually uses a separate, bolder digit sprite set at sprite tile slots `$56-$5F`. Pulled all 10 tiles (signature-matched `$5B`/`$5C` from the OAM dump against the ROM at `0x1B170`, then dumped 10 sequential 16-byte tiles → digits 0-9). Land them as `BATTLE_DIGIT_TILES` next to the existing `MISS_TILE_*` constants. New `drawBattleNum` builds 8x8 canvases per (digit × palette), cached on first use, and `ctx.drawImage`s them — no more font-renderer detour.
- **Bounce table cut off ~50 ms early.** Frames 0-29 of the existing `DMG_BOUNCE_TABLE` matched the OAM Y trace pixel-for-pixel; the trailing 3 frames were missing — capture continues falling to +5, +6 and holds at +6 for one frame before vanishing at frame 33 (~549 ms total = `DMG_SHOW_MS`). Old impl froze at +3. Appended `5, 6, 6` to the table.
- **Palette layout updated to match the new tile data.** Battle-digit tiles use color index 1 = outline, 2 = fill (per the SP3 palette FF3 sets at PPU `$3F1D` = `[0x0F, 0x0F, 0x25, *]` in the capture). The old text-font path used color index 3. Updated `DMG_NUM_PAL` / `HEAL_NUM_PAL` / `CRIT_NUM_PAL` to put the fill color in slot 2.

To swap heal/crit colors (Cure heals already render green via `HEAL_NUM_PAL`'s `0x2B`), change the slot-2 NES master color in the palette constant.

## 1.7.77 — 2026-05-07

### Boss + PVP boxes use transparent-edge tiles

1.7.70 landed transparent edges only for the random-encounter box; boss + PVP enemy boxes still drew the solid black halo. Both now pass `transparentEdge=true` to `drawBorderedBox`, matching the encounter look.

- `battle-drawing.js:1097` — boss `_drawBossSpriteBoxBoss`
- `pvp.js:791` — PVP enemy box

## 1.7.76 — 2026-05-07

### All-allies cursor blink

When the multi-target Cure picker is on `'all'`, the cursor now blinks (133 ms cadence) on every living ally — player portrait + every roster row. Same blink rate as the existing all/col-left/col-right enemy-side cursors. Single-target picks still draw a solid cursor on just the picked combatant.

- `_drawBattlePortrait`: player-portrait cursor branch now draws solid in single-target, blinks in `'all'`.
- Roster cursor pass after `_drawAllyRow` loop: single-target draws once on the picked row; `'all'` draws on every living ally row, blinking.

## 1.7.75 — 2026-05-07

### Cure all-allies picker — Right press, not Up

1.7.74 wired the all-allies toggle to Up from the player slot. Replaced with Right press from any ally pick (player or roster ally, single mode) — feels closer to Southwind's Right-cross-side-then-vertical pattern and keeps Up/Down purely for cycling allies. Left from 'all-allies' returns to single-ally; another Left then crosses to the enemy side as before.

- `_itemTargetNavRight` takes `allowMulti`; player-side single + Right → `'all'`.
- `_itemTargetNavLeft` exits `'all-allies'` to single-ally before crossing to enemy side.
- `_itemTargetNavVertical` no longer touches mode on the player side; freezes ally-cycle while in all-mode so Up/Down doesn't accidentally drop out of it.

## 1.7.74 — 2026-05-07

### Multi-target Cure spell — Southwind-style divided heal/damage

Cure (0x34) is now multi-target. Player can heal the whole party (one rolled amount divided across living allies) or hit a column / all enemies (divided damage on undead, divided heal on non-undead per NES default). Same picker UX as Southwind: from the player slot press Up to toggle "all-allies"; from the enemy side, Up toggles col-left / col-right / all. Single-target single-ally / single-enemy still works. PVP player gets the same picker for both own party and opposing roster. Potions stay single-target — the multi-target gate keys off the spell ID, never the item path.

- **data/spells.js**: new `MULTI_TARGET_SPELLS = new Set([0x34])` + `isMultiTargetSpell(id)` helper. Single source of truth — the input picker, the cast resolver, and any future multi-target spell all read from it. Cura/Curaja/etc. flip on by adding the ID.
- **spell-cast.js**: `startSpellCast` now accepts `targetMode: 'single' | 'all' | 'col-left' | 'col-right'` and builds `_targets[]` from it. New module-local `_baseAmount` is rolled once at cast time when `_targets.length > 1`; `_applyEnemyEffect` / `_applySpellEffect` use `Math.max(1, floor(_baseAmount / _targets.length))` instead of re-rolling per target. Single-target keeps the legacy per-target re-roll (no behavior change for single-target casts).
- **input-handler.js**: `_battleInputItemTargetSelect` now flips `allowMulti` on for multi-target spells (renamed `isBattleItem` → `allowMulti` through the nav helpers). Player-side: Up from the player slot toggles `'all'`; Down from `'all'` returns to single. Enemy-side picker reuses the existing battle-item col/all logic — no new code.
- **battle-turn.js**: `_playerTurnMagic` forwards `pending.targetMode` into the spec.
- **battle-drawing.js**: self-cast and ally-target heal-sparkle gates now read from the spell-cast iterator (`getSpellTargets()[getSpellHitIdx()]`) instead of `playerActionPending.allyIndex`. The sparkle naturally walks each target as `_hitIdx` ticks; multi-target Cure on the whole party draws the heal sparkle on player → ally1 → ally2 in sequence with no extra branching.
- Ally-AI Cure (`_tryAllyCure` in battle-turn.js) and PVP-opponent Cure (`_tryPVPEnemyCure` in pvp.js) keep their existing single-target lowest-HP heuristics — the multi-target option is a player choice, not an AI behavior change.

## 1.7.73 — 2026-05-07

### Item-use animations: declarative item→spell mapping

Refactored item-use animation routing so consumables declare which spell they dispatch (FF3 NES item-use is literally a spell call: Potion → Cure, Antidote → Poisona, Mallet → Mini, etc.) and the render system pulls the animation off the spell record. Previously each render path (player, ally, PVP) had its own hard-coded "if antidote then magenta" branch.

- **items.js**: each consumable now carries `animSpellId` per the rpgclassics FF3 item reference: Potion→Cure (0x34), HiPotion→Cura (0x26), PhoexDown→Raise (0x19), GoldNeedle→Stona (0x12), MaidenKiss→Toad (0x2e), Mallet→Mini (0x2f), Eye Drops→Bndna (0x28), Antidote→Poisona (0x35). Elixir and Echo Herbs have no spell mapping in NES — left without `animSpellId`, fall back to placeholder.
- **cure-anim.js**: new `getItemSparkleFrames(itemId)` helper reads `item.animSpellId`, gates on `CAPTURED_TARGET_SPELLS` (currently `{0x34, 0x35}`), looks up the spell, and returns the captured target frames via the existing `getCureAnimAssets` + `getCureTargetFrames` pipeline. Items pointing at a non-captured spell return null → caller falls back to recovery sparkle placeholder.
- **battle-drawing.js**: `_itemSparkleFrames` is now a 2-line wrapper over the shared helper. Player→self, player→ally, ally→player, ally→ally paths all flow through it.
- **pvp.js**: added `pvpSt.pvpItemId` (set when the AI picks an item), routed PVP item render through `getItemSparkleFrames(pvpSt.pvpItemId)` — same code path as everywhere else.

To wire up a newly-captured animation (e.g. once Mini's NES OAM is captured): add the spell ID to `CAPTURED_TARGET_SPELLS` in cure-anim.js and add the per-spell tile/palette assets to the bundle. No changes needed at any render site or in items.js — every consumable that already references the spell auto-picks up the new frames.

## 1.7.72 — 2026-05-07

### Antidote-only routing for poisona target frames

1.7.71 routed every `cure_status` item to the captured Poisona target frames. That over-reached: only antidote shares Poisona's animation (FF3 NES literally dispatches antidote through the Poisona effect). Gold needle, maiden kiss, eye drops, echo herbs, mallet each have their own NES animations not yet captured.

- `_itemSparkleFrames` now narrows to `cures === 'poison'` (antidote only). Other `cure_status` items fall back to the recovery sparkle as a placeholder until each animation is captured. PVP item path was already antidote-specific via `pvpItemKind === 'antidote'`; ally-item AI only sets the Poisona sentinel for poisoned targets — both paths already correct.

## 1.7.71 — 2026-05-07

### Antidote item-use animation — magenta poisona sparkle (was wrongly recovery blue)

All five item-use sparkle render sites (player→self, ally→player, player→ally, ally→ally, PVP item/magic) hard-coded `bsc.cureSparkleFrames` (the Cure-spell heal sparkle in recovery blue) regardless of which item was used. Antidote (and any `cure_status` item — gold needle, maiden kiss, eye drops, echo herbs, mallet) should render the captured 2-frame Poisona target effect (`poisonaTargetFrames`) in the cure_status magenta palette, matching the FF3 NES capture (REC OAM antidote 2026-05-07).

- Added `_itemSparkleFrames(itemId)` helper in `battle-drawing.js`: looks up the item, synthesizes a spell shape (`{target:'cure_status'}` for status-cure, else `{element:'recovery'}`), and routes through the existing `getCureAnimAssets` + `getCureTargetFrames` so the per-school palette + per-effect frame set both pick up automatically.
- Player→self item (line 366): replaced hard-coded `cureSparkleFrames` with helper call keyed off `inputSt.playerActionPending.itemId`.
- Player→ally item (`_allyItemSparkle`): same helper.
- Ally→player & ally→ally items: dropped the `&& !battleSt.allyMagicItemMode` filter that branched item mode to a separate hard-coded path. The ally-item AI already sets `allyMagicSpellId` to a sentinel (`0x34` Cure for potion, `0x35` Poisona for antidote), so the existing per-spell-id lookup picks the correct frames for both modes once the filter is gone.
- PVP item target (`pvp-opp-potion`): routes by `pvpSt.pvpItemKind` ('antidote' → cure_status synth, 'potion' → recovery synth).
- PVP magic target (`pvp-enemy-magic-hit`): now also routes through `getCureTargetFrames(SPELLS.get(pvpMagicSpellId))` instead of the hard-coded recovery sparkle (PVP Poisona was rendering in blue too — same bug, fixed in passing).

Cure potion path is unchanged in behavior: synthetic `{element:'recovery'}` resolves to the recovery bundle's `sparkleFrames`, which is still the same `bsc.cureSparkleFrames`-equivalent the old code rendered.

## 1.7.70 — 2026-05-06

### Battle encounter box — transparent edge (no black halo)

The battle viewport (where enemies render) used `drawBorderedBox`'s default tile set whose corners/edges have an opaque black background, creating a black halo around the box. Title-screen player-select boxes use a transparent-edge tile set (`titleSt.borderTiles`) made via the third `transparent: true` flag in `_tileToCanvas`.

- Exposed the same transparent tile set on `ui.borderTransparentTileCanvases` (alongside `titleSt.borderTiles`) so any draw site can opt in without cross-importing title state.
- Added a `transparentEdge` flag to `drawBorderedBox` — picks the transparent-edge tile set when set.
- `drawEncounterBox` now passes `transparentEdge: true`. Interior is still filled black for text legibility; only the outer corner/edge tiles change.

### Revert 1.7.69

The "drop the black pre-fill past the panel edge" change in 1.7.69 was a misread of the report — the user meant the encounter box at the top of the screen, not the menu panel at the bottom. Restored the original `fillRect(8, ..., CANVAS_W - 16, ...)` behavior.

## 1.7.69 — 2026-05-06

### Battle HUD — drop the black bar past the panel edge

`drawBattlePanelBox` pre-filled `fillRect(8, HUD_BOT_Y+8, CANVAS_W-16, HUD_BOT_H-16)` before calling `drawBorderedBox`. That fill spanned the full canvas width but the panel itself is only `BATTLE_PANEL_W = 120` — the extra 136 px past the panel edge rendered as black, sitting under chat tabs / right-side area. Removed the pre-fill; `drawBorderedBox` already fills its own interior, so the panel still draws correctly and the area outside it stays transparent (matching title HUD style).

## 1.7.68 — 2026-05-06

### Fix HUD flash on enemy death

The new `pre-monster-death` state from 1.7.67 wasn't in the `isMenu` / `_isEncounterCombatState` predicates in `battle-drawing.js`, so the battle HUD/encounter box closed for the 85 ms pause and reopened — visible as a flash. Added `pre-monster-death` to both predicates so the HUD stays drawn through the kill beat.

## 1.7.67 — 2026-05-06

### Attack timing audit fixes — slash weight + anticipation beats

OAM trace `f14608` (200-frame OK dual-wield turn ending in monster death) cross-referenced against ff3mmo's combat constants. Four tunings landed:

1. **`SLASH_FRAME_MS: 30 → 67`** (`slash-effects.js`). Each slash position now holds 4 NES frames instead of 2 — the slash flickers visibly within the swing window instead of strobing past too fast. NES bladed slashes hold each visible flash ~67 ms, and at 30 ms the flash read as a flicker rather than three solid impacts.
2. **`HIT_PAUSE_MS: 100 → 316`** (`battle-update.js`). After the last slash of a combo, body holds in attack pose for 316 ms before the damage number pops. NES uses this beat as the "the strike landed, here comes the number" anticipation. At 100 ms the damage number cut in too eagerly.
3. **New `PRE_DEATH_PAUSE_MS = 85` + `pre-monster-death` state** (`battle-update.js`, `battle-drawing.js`). Brief beat between the damage number disappearing and the monster-death cascade starting. NES dims SP3 and holds 5 frames before the death anim particles spread; ff3mmo previously snapped straight from damage → particles. Random-encounter path only — PVP/boss dissolve transitions stay immediate. Renderer's `isBeingHit` check now includes `pre-monster-death` so the monster keeps drawing during the pause instead of disappearing for 85 ms.
4. **`IDLE_FRAME_MS: 67 → 33`** (`combatant-pose.js`). Hand-change neutral pose drops to 2 NES frames (matches OAM `f24-25`). The 4-frame version added a perceptible hitch in dual-wield combos. Affects player + PVP enemy hand-change paths through the same constant.

Net: a single dual-wield turn now plays back about 30 ms longer total than before (extra anticipation beats > faster hand-change), but each phase reads as a deliberate moment instead of a snap-cut. The big perceptual win is the slash flash: 67 ms holds match what NES looked like.

## 1.7.66 — 2026-05-06

### EMU REC OAM/BG output now annotates wall-clock ms

Capture output had NES frame counters but no millisecond timing — translating an animation phase into a duration (e.g., "Cure buildup is 800ms") meant manually multiplying frame counts by 16.639. Added inline ms annotations:

- **Per-frame divider** — `// ═══ frame I (snap @ fF, t≈Xms) ═══` where `t` is relative to the start of the REC run.
- **Dedupe summary** — `// ── frames N..M (Kx same as frame N, span ≈ Yms) ──` so the duration a pose held is read directly off the line.
- **Header** notes the conversion factor (NES NTSC ~16.639 ms/frame).

Math derived from NES frame deltas (REC drives `nes.frame()` in a loop, so elapsed wall-clock time = elapsed NES frames × 16.639 ms). Speeds up translating captures into anim phase timings — the next time damage spell anims need their phase boundaries set in code, you read them off the dump directly.

## 1.7.65 — 2026-05-06

### Spell target sparkle now renders on enemy targets

Player-cast magic on an enemy was missing the heal-phase sparkle (only the caster's buildup + cast pose were visible; the enemy got the damage number but no on-target effect). Added `_drawPlayerSpellTargetSparkleOnEnemy` between `drawBossSpriteBox` and `drawBattleMenu` in the battle render order.

Per the spell-anim hard-rules:
- **Spell-ID source** for this new path is `getCurrentSpellId()` — the player-cast spell. Ally-cast and PVP-cast versions of an offensive-on-enemy effect would read from `battleSt.allyMagicSpellId` / `pvpSt.pvpMagicSpellId` respectively, but neither path exists yet (no AI offensive magic). Add those branches when the AI gets damage spells.
- **Phase wiring**: gated on `shouldDrawHealSparkle(cureMs)` — same gate as the friendly-target paths, so the sparkle plays in phase 4 (heal moment) and not earlier phases. Reuses `getCureTargetFrames` for per-school sparkle (Cure → recovery, Poisona → magenta).
- **Canvas dimensions**: 16×16 frames from `getCureTargetFrames`, rendered centered on the enemy sprite (encounter / PVP / boss positions handled per layout).
- **Cure-anim quarantine respected**: only added a new render call site, did not modify `cure-anim.js`.

## 1.7.64 — 2026-05-06

### Player magic on enemies — full pipeline (Cure on undead, ready for black magic)

`spell-cast.js` only handled friendly targets (`'player'` or ally index); enemy-target dispatch was silently re-routed to player. Now the engine walks all three target types end-to-end:

- **`_targets` refactor.** Now `[{type, index?}]` — `'player'`, `'ally'+index`, or `'enemy'+index`. `startSpellCast` accepts `{enemyIndex: N}` alongside the existing `{allyIndex: N}`.
- **`_applyEnemyEffect` added.** Routes by spell flavor:
  - **Recovery on undead** → damage path (atk = floor(MND/2) + power, +rand). Undead detection uses the NES ROM signature: monster has `weakness: 'holy'` AND `resist: 'holy'` (the contradiction is the flag). Catches Red Wisp, Dark Eye, Zombie, Mummy, Skeleton, CursdCopper, Larva, Shadow, Revenant; future undead picked up automatically by ROM data.
  - **Recovery on non-undead enemy** → heals them (NES default — your MP, your problem).
  - **Damage spells on enemy** → atk = floor(INT/2) + power, +rand, × `elemMultiplier(spell.element, mon.weakness, mon.resist)`. Hit rolled if `spell.hit < 100`. Routes through `setSwDmgNum` (encounter / PVP) or `setEnemyDmgNum` (boss).
- **`_playerTurnMagic` dispatch.** Reads `pending.target`: `'player'` → friendly; numeric → enemy slot. The targeting menu already let you cycle through enemies; the magic engine just wasn't listening.
- **`drawSWDamageNumbers` extended** to fire on `'magic-hit'` so spell damage on encounter/PVP enemies actually displays. Boss damage routes through the existing `_drawBossDmgNum` path.

**Animation deferred.** Recovery-spell cure-anim (sparkle on portrait) only renders for friendly targets; enemy-target casts get the buildup + cast pose on the caster, then the damage number on the enemy with no target-side sparkle. Damage spell anims aren't captured yet — black magic anims will land separately. Per the spell-anim hard-rules memory, didn't touch `cure-anim.js` for this change.

## 1.7.63 — 2026-05-06

### Crits are visible now

The `crit: true` flag on damage nums was plumbed through every attack path (player, ally, enemy, PVP) — and the renderer ignored it. The only crit feedback was a 17ms (one frame) gold screen flash that was below the perceptual floor; players couldn't tell which hit was the big one.

Two fixes:
1. **`CRIT_NUM_PAL` (gold/yellow `0x28`)** added to `damage-numbers.js`. The three damage-side renderers in `battle-drawing.js` (player→enemy, enemy→player, ally→enemy) now branch on `dn.crit` and use the gold palette for crit hits. Heal/swDmg paths untouched (heals don't crit; battle items auto-resolve).
2. **Crit screen flash 17ms → 67ms** (~4 frames). Long enough to register as a deliberate flash, short enough to avoid strobing on multi-hit crit chains.

## 1.7.62 — 2026-05-06

### Remove the offensive-spell miss gate added in 1.7.60

The hit-roll gate was routed through the heal-num path (`setPlayerHealNum({miss: true})`, `allyDamageNums[target] = {miss: true}`). Two problems:
1. Heals don't miss — using the heal-num path for an offensive whiff was the wrong display channel.
2. Unreachable: `_applySpellEffect(target)` only runs for friendly targets (`'player'` or ally index). Offensive spells (`enemy`, `enemy_status`, `all_enemies`) never reach this function in the current pipeline — when those spells get added later, the hit roll belongs at the offense-side dispatch, not here.

Net: no behavior change today (gate was dead code), one fewer wrong-path landmine when offensive player-cast spells get implemented.

## 1.7.61 — 2026-05-06

### Drop-rate audit — null entries no longer eat the encounter's drop slot

ROM-extracted `drops` tables include `null` placeholder slots (Sahagin/Lamia all-null, Crocotta `[0xA6,0xB2,null]`, multiple lv-60+ bosses). The drop loop in `battle-update.js` rolled uniformly across the array and broke on the first 25% trigger — but a null pick still claimed the encounter's drop slot, silently zeroing out subsequent mobs' chances and dropping nothing.

Effective drop rates pre-fix:
- `[0xA6,0xB2,null]`: 16.7% (vs nominal 25%) and blocks other mobs.
- `[null,null,null,null]`: 0% drop, 25% chance to block the entire encounter.
- `[0xA8,null]` (bosses): 12.5% real.

Fix: filter nulls before checking length and rolling. The array becomes the pool of valid items; ROM null placeholders are skipped. All-null drop tables now yield no drop attempt and don't block siblings.

Audit also looked at the alleged mid-game EXP plateau — that was an averaging artifact from bosses/outliers in the level buckets. Non-boss mobs scale smoothly from ~80 EXP at lv 5 → 1,640 at lv 40 → continuing climb. No data fix needed.

## 1.7.60 — 2026-05-06

### Damage audit follow-ups — apply all five flagged items

1. **Player/ally → PVP enemy now rolls target shield/evade.** `input-handler.js` `rollHand` and `battle-turn.js` ally-attack now thread `tgt.shieldEvade` / `tgt.evade` into `rollHits`. Mirror of 1.7.59 — opponents' shields and evade armor used to work only on defense.
2. **Player/ally → monster now rolls `mon.evade`.** Every monster row carries `evade: 10`+ but it was being ignored, giving players a quiet ~10% accuracy buff. Routed through `rollHand` for the main attack path and the confused-attack-monster branch.
3. **DEF formula halves vit.** `recalcDEF` (player) and `generateAllyStats` (NPCs) now compute `floor(vit/2) + armor.def` instead of `vit + armor.def`. Matches the `floor(str/2)` attacker formula from 1.7.58 — restores symmetry so the displayed ATK/DEF spread tracks actual outcomes. Existing players will see lower DEF in the pause menu; that number is the one the damage roll always actually used.
4. **Hit count divisors 16 → 12.** `calcPotentialHits = 1 + floor(level/12) + floor(agi/12)`. Mid-levels (12-24) now grow hit counts visibly instead of staying glued to 1 hit through level 15.
5. **Spell hit-rate gate added for offensive targets.** `spell-cast._applySpellEffect` now rolls `spell.hit` for `enemy` / `enemy_status` / `all_enemies` targets when hit < 100. Friendly targets (cure_status, ally heal, revive) skip the roll — Poisona on a poisoned ally still always succeeds. No-op for current player kit (only Cure/Poisona are castable); ready for future Sleep/Confuse/Blind on enemies.

## 1.7.59 — 2026-05-06

### PVP enemy → roster ally — apply ally shield/evade (was silently dropped)

In `pvp.js` the PVP enemy attack path branched on `targetAlly >= 0`: when the enemy hit one of the player's roster allies, opts collapsed to just crit options — `ally.shieldEvade` and `ally.evade` (populated by `generateAllyStats`) were never read, so PVP enemy swings landed at 100% on roster allies regardless of the ally's shield or armor. The non-PVP `battle-enemy.js` path already does this correctly via `rollMultiHit(ally.def, null, ally.shieldEvade || 0, ally.evade || 0)` — PVP just forgot.

Fix: pass `ally.shieldEvade`/`ally.evade` into the `rollHits` opts when targeting a roster ally. Player-target branch unchanged.

### Audit findings (not yet fixed — flagged for review)

- **Player/ally → PVP enemy shield/evade also dropped.** Symmetric oversight: `input-handler.js:194-202` and `battle-turn.js:174-186` build `targetDef` from `pvpOpponentStats`/`pvpEnemyAllies` but never thread the target's `shieldEvade`/`evade` into `rollHits`. So PVP opponents' shields and evade armor only work on defense, never on offense — meaningful at 16-20% block on late-game shields.
- **Monster evade ignored on player swings.** Every monster row in `data/monsters.js` carries `evade: 10`, but `input-handler.js`'s `rollHand` doesn't pass `evade` to `rollHits`. Currently a global 10% accuracy buff to players vs NES canon. Fixing it would noticeably tighten encounter difficulty.
- **ATK/DEF stat asymmetry.** Post-1.7.58, non-Monk attackers add `floor(str/2)` but defenders still use full `vit + armor` (`player-stats.js:138`, `players.js:125`). Tanky kits remain stronger than their stat-screen ATK suggests; a matching `floor(vit/2) + armor` would close the loop and is closer to canonical NES FF3 stat-screen DEF.
- **Hit count scales slowly.** `calcPotentialHits = 1 + floor(level/16) + floor(agi/16)`. NES-canonical, but in practice means 1 hit per swing through level 15. Bumping the divisors would make mid-levels feel snappier.
- **Spell `hit` field unused for player-cast.** `spell-cast.js:_applySpellEffect` never checks `spell.hit`. Cure-status spells like Poisona (data hit:50) always succeed on the targeted ally. Fine for friendlies, but if you ever add player-cast offensive status (Sleep, Confuse, Blind on enemies), you'll need a hit roll.

## 1.7.58 — 2026-05-06

### Damage formula — non-Monks add floor(str/2) to attacker ATK

The non-Monk path in `calcAttackerAtk` was returning raw `wpn1.atk + wpn2.atk` with no STR contribution, while the Monk-unarmed path mixed in str/4 + level scaling. Symptom: a level 9 Onion Knight with a Long Sword (atk 10) hitting a low-level Warrior (vit 10 + leather + cap + shield ~9 def) computed `10 + rand(0..5) - 19` → always clamped to 1 HP, no matter the level.

Fix: non-Monks now return `wpn.atk + floor(str/2)`. STR finally matters for swords/axes/bows. The per-hand split in `input-handler.js` already strips raw weapon ATK out before redistributing per hand, so str/2 survives the strip and applies to every hit. Allies (`generateAllyStats`) and PVP attackers route through the same helper, so the buff cascades to every non-Monk path.

The pause-menu ATK readout (`ps.atk`) will jump for existing players — that's the intended display, matching the underlying damage roll for the first time.

## 1.7.57 — 2026-05-06

### End-of-round poison tick — drop SFX

`_applyEndOfRoundPoison` was firing `SFX.ATTACK_HIT` once per round whenever any combatant took poison damage. Removed — the red damage numbers + flash already convey the tick, and stacking it under the existing turn-end audio was just noise.

## 1.7.56 — 2026-05-06

### Poisona target effect — center on portrait (was top-half only)

v1.7.54 built the Poisona target frames on a 16×24 canvas with tiles at y=5 and y=13 — those offsets were copied from v1.7.49's caster placement, not target placement. Result on a 16×16 portrait: top tile sat in the upper-middle, bottom tile mostly hung off the bottom of the portrait. Switched to a 16×16 canvas (matching `sparkleFrames` via `_makeCanvas16`) with TL/TR at y=0 and BL/BR at y=8 — the effect now fills the portrait exactly, same footprint as the heal sparkle.

## 1.7.55 — 2026-05-06

### Ally-cast Poisona on player/ally — show Poisona effect, not Cure sparkle

v1.7.54 wired Poisona's target effect for the player-cast paths but missed both ally-cast paths in `battle-drawing.js`: ally → player and ally → ally were both hardcoded to `bsc.cureSparkleFrames` regardless of which spell the ally cast. Result: WM ally casting Poisona on the player (or another ally) showed the blue Cure sparkle instead of the magenta Poisona effect. Both branches now look up the actual cast spell via `battleSt.allyMagicSpellId` and route through `getCureTargetFrames`. Item-mode heals (potions) still use the recovery sparkle as before.

## 1.7.54 — 2026-05-06

### Poisona target spell-effect — recover captured tiles, wire to TARGET (not caster)

The 8 captured tiles `POISONA_T49–T50` (REC OAM 2026-05-06) are the real on-target Poisona effect. v1.7.49 captured them correctly but mis-wired them as the *caster* build-up animation (then v1.7.53 reverted everything). This restores those bytes and wires them to the TARGET during the heal phase — the caster animation (flame + rotating stars in magenta) is unchanged because it was already correct. Two-state animation toggling every 67 ms over the 283 ms heal window; `cure_status` school only (Poisona/Bndna/Esuna/Stone). Cure (recovery) keeps its existing heal sparkle. New helper `getCureTargetFrames(spell, animBundle)` picks the right frame set per spell school; both player-self and ally-target heal sites in `battle-drawing.js` route through it.

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
