# Modularization / single-source audit

Started 2026-05-10. Tracks duplicate / parallel-path patterns surfaced during
the damage-number animation audit and follow-up sweeps. Goal: kill the
"local-player + fake-player" / N-caller-drift class of bug at the root, per
the recurring memory `feedback_ff3mmo_single_source_paths.md` and
`feedback_ff3mmo_modularize.md`.

## TL;DR

| # | Item | Tier | Status |
|---|------|------|--------|
| 1 | Heal clamp duplicated between Potion paths and `applyMagicHeal` | 🟢 1 | ✅ v1.7.206 |
| 2 | Initiative roll formula duplicated 5× in `buildTurnOrder` | 🟢 1 | ✅ v1.7.206 |
| 3 | Combo-hit summing (`totalDmg/anyCrit/allMiss`) duplicated 3× | 🟢 1 | ✅ v1.7.206 |
| 4 | Miss-canvas blit pattern duplicated 5×, y-offset inconsistent | 🟡 2 | ✅ v1.7.207 |
| 5 | Cast-callback I/O bindings (`onHealNum`) duplicated 4× | 🟡 2 | ✅ v1.7.207 (narrowed) |
| 6 | `Math.max(0, hp - dmg)` HP zero-clamp duplicated 12+ sites | 🟡 2 | ❎ skipped (see #6 below) |
| 7 | Three near-identical "pick target & apply enemy damage" paths | 🔴 3 | deferred |
| 8 | `CURE_NAME_TO_FLAG` table — could consolidate with status-effects | 🔴 3 | deferred |

## #1 — Heal clamp duplicated

**Sites:** `battle-turn.js:550, 555, 562, 567` (Potion: player / ally /
encounter monster / boss); `combatant-cast.js:244` (`applyMagicHeal`).

`_playerTurnConsumable` reproduces `Math.min(power, maxHP - hp)` + HP write
that `applyMagicHeal` already does. Spell vs. potion heals can drift if
`applyMagicHeal` ever grows logic (e.g., overheal, status interactions).

**Fix:** route Potion targets through `applyMagicHeal(target, power,
{ onHealNum: ... })`. The four targets each get the right `onHealNum` setter
(setPlayerHealNum / getAllyDamageNums-write / setEnemyHealNum).

**Risk:** trivial. `applyMagicHeal` is already the canonical helper used by
Cure / Cura / Cure-on-ally / Cure-on-PVP-ally.

## #2 — Initiative roll formula duplicated 5×

**Sites:** `battle-turn.js:30, 34, 40, 46, 51`. Same `(agi * 2) +
Math.floor(Math.random() * 256)` formula five times, one per actor type
(player / ally / encounter / PVP-opp / PVP-enemy-ally).

**Fix:** `rollInitiative(agi)` in `battle-math.js` (formula already
documented there per the v1.7.201 fix). Five callers shrink to one-liners.

**Risk:** zero — pure function, no state.

## #3 — Combo-hit summing duplicated 3×

**Sites:** `battle-update.js:295` (player), `battle-ally.js:36` (ally),
`pvp.js:919` (PVP). Same reduction:
```js
let totalDmg = 0, anyCrit = false, allMiss = true, hitsLanded = 0;
for (const h of hitResults) {
  if (!h.miss) {
    totalDmg += h.damage;          // pvp uses h.dmg
    allMiss = false;
    hitsLanded++;
    if (h.crit) anyCrit = true;
  }
}
```

The PVP version uses `h.dmg` instead of `h.damage` and also gates on
`!h.shieldBlock`. Other than that, identical.

**Fix:** `summarizeHits(hitResults, opts)` in `battle-math.js`. `opts.dmgKey`
defaults to `'damage'`, can override to `'dmg'`. `opts.respectShieldBlock`
gates the shield-block field. Returns `{ totalDmg, anyCrit, allMiss,
hitsLanded }`.

**Risk:** zero — pure function, three callers.

**Why it matters:** the v1.7.193 dual-wield bug was inside one of these
three. Keeping them parallel is the textbook half-fix risk per the
single-source-paths memory.

## #4 — Miss-canvas blit pattern duplicated 5×

**Sites:** `battle-drawing.js:106, 125, 137, 405, 448`,
`battle-draw-allies.js:262`. All do roughly:
```js
if (dn.miss && mc) ui.ctx.drawImage(mc, bx - 8, by - 4);
```
…but the y-offset is **inconsistent**: `by - 4` in some, `by` in others.

**Fix:** `drawMissOrNumber(ctx, dn, bx, by, pal)` in `damage-numbers.js`
that handles both branches. Pick the correct y-offset and apply uniformly.

**Risk:** low. Pure rendering. Likely fixes a small visual quirk for free.

**Open question:** which y-offset is correct? Need to compare to the NES
miss-frame REC OAM capture to pick the canonical one. (If no capture, pick
whichever value 3 of 5 sites use — that's the de-facto standard.)

## #5 — Cast-callback I/O bindings (narrowed scope)

**Original idea:** factor a `bindCastIO({ role, ... })` helper that returns
`{ onHealNum, onSparkle, onDmgNum }`.

**What shipped:** narrower — `makeHealNumCallback(scope, idx)` in
`damage-numbers.js` covering the four `onHealNum` closures (player cast,
ally cast, PVP cast, drain-undead in spell-cast). The other parts of the
broader idea didn't pencil out:
- `onSparkle` is just `() => onHealNum(0)` — too thin for a wrapper.
- `onDmgNum` has role-specific dispatch (`_setEnemyDmg` already handles
  encounter / PVP / boss), no clean way to fold further.
- Target-object resolution (e.g., `isPlayerTgt ? ps : battleSt.battleAllies[idx]`)
  is one line and the call sites use slightly different state vars
  (`target.index` vs `battleSt.allyMagicTargetIdx`); helper would just
  push that branching down.

The popup format (`{ value, timer, [index] }`) now lives in one place,
which is the actual drift risk.

## #6 — `Math.max(0, hp - dmg)` zero-clamp — SKIPPED

**Initial sites surveyed:** 12+ across `battle-turn.js`, `battle-enemy.js`,
`pvp.js`, `combatant-cast.js`, `battle-update.js`, `battle-ally.js`.

**Why skipped:** the inline pattern `target.hp = Math.max(0, target.hp - dmg)`
is a single-line clamp. Folding into `applyHpDelta(target, -dmg)` saves
roughly zero code per site and adds an indirection layer. The cases where
polymorphism actually matters (target-shape lookup, undead inversion,
status-tick) already route through `applyMagicDamage` / `applyMagicHeal` /
`applyMagicDrain` in `combatant-cast.js`.

The poison-on-friendly `Math.max(1, ...)` cases (3 sites) are the only
non-trivial variant. Each is a 4-line block with shake / dmg-num callbacks
that would still need to live at the call site, so the wrapper would only
absorb the clamp — not worth a dedicated helper.

**Revisit if:** a future bug hinges on inconsistent HP-zero-clamp behavior
across paths.

## #7 — DEFERRED: Three near-identical "pick target & apply enemy damage" paths

`spell-cast.js:_setEnemyDmg` already handles encounter / PVP / boss split
for spells. Physical-attack paths re-derive the target each time, but they
also carry slash-anim state, so it's not pure refactor.

Revisit if a target-resolution bug crosses encounter ↔ PVP again.

## #8 — DEFERRED: `CURE_NAME_TO_FLAG` consolidation

Local mapping in `battle-turn.js:512`. Implicit elsewhere
(`status-effects.js`). Small footprint; not worth the churn yet.
