# Status effects + low-HP audit

Started 2026-05-10. Sweep of every place status flags are inflicted,
enforced, removed, or rendered, plus the low-HP visual cues that share
the same screen real estate above each combatant.

## TL;DR

| # | Item | Class | Status |
|---|------|-------|--------|
| 1 | Encounter monster has no status sprite overlay | gameplay/visual | ✅ v1.7.209 |
| 2 | PVP enemies skip `processTurnStart` (no paralysis/sleep/confuse handling) | gameplay | ✅ v1.7.209 |
| 3 | Ally + PVP-enemy attacks ignore `blindHitPenalty` | gameplay | ✅ v1.7.209 |
| 4 | Ally + PVP-enemy attacks ignore `miniToadAtkMult` | gameplay | ✅ v1.7.209 |
| 5 | `canCastMagic` (Silence) is dead code | gameplay | ✅ v1.7.210 |
| 6 | `STATUS_PAL1/2/3` are placeholder copies of `PAL0` | visual | ⏸ deferred — needs NES capture |
| 7 | Player kneels on active status; allies don't | visual | ✅ v1.7.209 |
| 8 | Mini/Toad have no body sprite (transformation invisible) | visual | ⏸ deferred — sprite work |
| 9 | Fourth duplicate name→flag table in `pause-menu.js:820` | dedup | ✅ v1.7.209 |
| P | **Priority rule:** status sprite suppresses low-HP sweat | visual | ✅ v1.7.209 |

## Priority rule (user-directed)

When both an active status AND near-fatal HP would render visual cues
above a combatant, the **status sprite wins**. Concretely:

- **Status overlay** (16×8 sprite above the body): renders unconditionally
  when `statusObj.mask` is non-zero. Highest-priority flag from the
  `_STATUS_PRIO` table wins among multiple statuses.
- **Low-HP sweat** (16×8 alternating sprite 3 px above the portrait):
  suppressed whenever an active status would render in the same space.
  This keeps the screen from showing two overlapping icons.
- **Kneel pose** (body change): independent of the icon question — the
  body kneels for either condition (low-HP or active status). Player
  already did this; allies now match.

Implementation lives at the render sites:
- Player: `hud-drawing.js` sweat gated by `!hasActiveStatus`.
- Ally: `battle-draw-allies.js` sweat gated by `!hasActiveStatus`, kneel
  pose now triggers on active status (matching player).
- Monsters: no sweat anim, only status icon (new — see #1).

## #1 — Encounter monster status sprite overlay

`drawStatusSpriteAbove` was wired for player / ally / PVP enemy but not
for encounter monsters. A poisoned / blinded / silenced / sleeping
monster carried the flag in data but rendered nothing above the body.

**Fix:** call `drawStatusSpriteAbove(ctx, mon.status, x, drawY - 4)`
after the monster sprite blit in `battle-draw-encounter.js`. Centered
horizontally based on the monster's actual sprite width since
monsters vary (32 / 48 / 64 wide) where portraits are uniformly 16.

## #2 — PVP enemies skip `processTurnStart`

`battle-turn.js:200-206` ran `processTurnStart` for encounter monsters
(paralysis-skip, sleep-wake 25% roll, confuse snap-out roll). The PVP
branch directly below (lines 207-213) did setup but never called
`processTurnStart`. So Paralyzed PVP enemies still acted, Slept PVP
enemies never woke, Confused PVP enemies never snapped out.

**Fix:** add the same `processTurnStart` call for PVP main opponent +
enemy allies, sharing the helper.

## #3 — Ally + PVP-enemy attacks ignore `blindHitPenalty`

Sites already enforcing blind:
- Player attack: `input-handler.js:174`, `battle-turn.js:101`
- Monster attack on player party: `battle-enemy.js:184`

Sites previously NOT enforcing:
- Ally attack: `battle-turn.js:188` (where `allyHitResults` is rolled)
- PVP-enemy attack: `pvp.js:379`

**Fix:** multiply each by `blindHitPenalty(attackerStatus)`. The helper
returns 0.5 when blind is active (matches NES), 1.0 otherwise — so the
math is uniform with the player path.

## #4 — Ally + PVP-enemy attacks ignore `miniToadAtkMult`

Sites enforcing: only `input-handler.js:175` (player).

Sites NOT enforcing: ally attack and PVP-enemy attack — same two as #3.

**Fix:** multiply `atk` by `miniToadAtkMult(attackerStatus)` at each
roll site. Helper returns 0 for Mini/Toad (zero damage from physical),
1 otherwise.

## #5 — Silence enforcement landed

User-confirmed scope (2026-05-10): block all MP-cost spell casts,
all factions, no auto-wear-off (Echo Herbs is the cure). Items bypass
Silence (NES-faithful — items don't channel magic).

**Six gate sites added:**

1. Player battle menu (`battle-update.js`) — picking the Magic slot
   while Silenced plays `SFX.ERROR`, shows "Silenced" on the strip,
   leaves the cursor on the slot.
2. Ally Cure AI (`battle-turn.js:_tryAllyCure`) — early return,
   falls through to physical attack.
3. Ally Poisona AI (`battle-turn.js:_tryAllyPoisona`) — same.
4. Ally offensive cast AI (`battle-turn.js:_tryAllyOffensiveCast`) — same.
5. PVP enemy AI: `_tryPVPEnemyCure`, `_tryPVPEnemyOffensiveCast`,
   `_tryPVPEnemyPoisona` (`pvp.js`) — each early-returns when caster
   is Silenced.
6. Pause-menu spell cast (`pause-menu.js:_applyPauseSpellUse`) —
   `SFX.ERROR` + no-op when the player is Silenced.

**NOT gated:** monster special attacks (Fire / Bzzard / Glare / Bad
Breath etc.). Monsters don't have MP, so the "blocks all MP casts"
rule doesn't apply. Some NES monsters can still be Silenced via
weapon-on-hit (e.g., `0x2e` Defender sword has `silence` in its
status list); those will still use their specials. Reasonable
under-reach — revisit if specific monster specials need gating.

## #6 — DEFERRED: `STATUS_PAL1/2/3` placeholder copies of `PAL0`

`sprite-init.js:507-510`. The comment claims per-status palette
differences (sleep ≠ confuse ≠ blind/petrify) from the NES disasm,
but the bytes are identical. Needs an EMU REC OAM capture of each
status mid-anim to land the real palettes.

## #7 — Player kneels on active status; allies don't

`hud-drawing.js:274` already kneels the player on
`(near-fatal || hasActiveStatus)`. `battle-draw-allies.js:188` only
kneels on near-fatal.

**Fix:** match the player rule for allies. With the priority rule
above, the kneel pose + status sprite read clearly as "this combatant
is in trouble" even at full HP.

## #8 — DEFERRED: Mini/Toad have no body sprite

NES had transformed Mini and Toad sprites (small body, frog body). We
only flip the mask — body sprite stays the same. Combined with #4,
Mini/Toad are nearly invisible to the player. Needs sprite work.

## #9 — Fourth duplicate name→flag table

`pause-menu.js:820` defines yet another local `flagMap` for the
out-of-battle item-cure path. T8 (v1.7.208) collapsed three duplicates
into `STATUS_NAME_TO_FLAG` but missed this one.

**Fix:** drop the local table, use `STATUS_NAME_TO_FLAG`.
