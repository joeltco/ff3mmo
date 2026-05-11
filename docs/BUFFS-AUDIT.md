# Buffs (Haste / Protect / Reflect) + defense audit

Started 2026-05-10. Sweep of the buff system (`buffs.js`) and the
adjacent defense / shield-block / evade mechanics — what's applied,
what's actually enforced, what's dead.

## TL;DR

| # | Item | Class | Status |
|---|------|-------|--------|
| 1 | **Reflect is dead** — `BUFF_REFLECT` applied but never read in any damage / spell path | gameplay bug | ✅ v1.7.214 (MVP — blocks PVP-enemy spells on player) |
| 2 | Haste enforcement | gameplay | ✅ already correct (player-only per `buffs.js` v0 scope) |
| 3 | Protect enforcement | gameplay | ✅ already correct (player-only per v0 scope) |
| 4 | Curtain item (5000 gil) was applying a dead buff | gameplay | ✅ closed by #1 |
| 5 | Allies / PVP enemies / monsters can't have buffs | by-design (v0) | ⏸ deferred per `buffs.js` roadmap |
| 6 | No buff visual indicator on portraits | feature gap | ⏸ deferred per `buffs.js` roadmap |
| 7 | Reflect bounce-back targeting (NES canon: bounces to caster's team) | nice-to-have | ⏸ deferred — MVP just blocks |
| 8 | Reflect on encounter-monster specials (Fire breath / Glare / Bad Breath) | enforcement gap | ⏸ deferred — needs SPECIAL_ATTACKS magic vs non-magic classification |
| 9 | Defense / shield-block / armor-evade enforcement | gameplay | ✅ all clean (see matrix below) |

## Buff enforcement matrix

| Buff | Effect | Where checked | Status |
|------|--------|---------------|--------|
| Haste | doubles `calcPotentialHits` | `input-handler.js:172` (player attack) | ✓ enforced |
| Protect | halves physical damage taken | `battle-enemy.js:220` (monster→player), `pvp.js:411` (PVP→player) | ✓ enforced |
| Reflect | blocks incoming enemy magic | `pvp.js:_applyPVPEnemyMagicEffect` (v1.7.214) | ✓ MVP shipped |

## Defense / shield / evade enforcement matrix

| Mechanic | Where checked | Notes |
|----------|---------------|-------|
| `isDefending` halve | `battle-enemy.js:107, 217` (monster→player), `pvp.js:405` (PVP→player), `physical-attack.js` (player→PVP-opp via `pvpOpponentIsDefending`) | Player + PVP main opp can defend; allies + PVP-enemy-allies + monsters cannot |
| `targetProtected` halve | `rollHits` `opts` → `pvp.js:411` only | Combines multiplicatively with `defendHalve` (1/4 dmg if both); per-buff comment |
| Shield-block `shieldEvade` | `rollHits` → player/ally/PVP attacks; `battle-enemy.js:rollMultiHit` for monster→ally | enforced everywhere |
| Armor `evade` | `rollHits` → player/ally/PVP attacks; `battle-enemy.js:rollMultiHit` for monster→player+ally | enforced everywhere |

All clean — no enforcement gaps in defense/evade beyond the deliberate
"only player + PVP main opp can defend" scope.

## #1 — Reflect was completely dead pre-v1.7.214

`BUFF_REFLECT` had **two writers** and **zero readers**:

- Writers: `spell-cast.js:482` (Reflect spell 0x0c, including Curtain
  item routing through `animSpellId: 0x0c` per `data/items.js:233`).
- Readers: none. Grepped the codebase — no `hasBuff(.+REFLECT)` /
  `buffs.reflect` reads outside `buffs.js` itself.

**User-facing impact pre-v1.7.214:**
- Reflect spell (10 MP per Spell-2 slot): MP spent for nothing.
- Curtain item (5000 gil, single-use): gil spent for nothing.

## #1 fix — MVP scope shipped v1.7.214

**What's reflected (v0.5 MVP):**
- PVP enemy damage spells on player (Fire / Blizzard) — full block.
- PVP enemy status spells on player (Sleep) — full block.

**What's NOT reflected (deferred):**
- Friendly Cure / Cure-status / heal spells (designer choice — NES
  literal bounces *all* magic, our v0.5 keeps friendly heals through).
- Encounter monster specials (Fire breath / Glare / Bad Breath /
  etc.) — these don't route through the spell-cast pipeline and
  `SPECIAL_ATTACKS` doesn't classify magic vs non-magic.
- Spells targeting allies (allies don't have buffs per v0 scope).

**Visual + UX:**
- "Reflected!" message strip via existing `BATTLE_REFLECT` bytes.
- `SFX.SW_HIT` (impact pop) on reflect — distinguishes from a clean
  miss.
- Damage/status entirely skipped — no number, no shake.

## #7 — DEFERRED: Reflect bounce-back

NES FF3 canon: a Reflected spell bounces to a random target on the
caster's team. This needs:
- Re-target logic at spell-apply time (pick a living enemy of the
  caster's faction).
- Visual: spell anim playing twice (original cast, then bounce-back
  on the new target).
- Reflect-vs-Reflect ping-pong handling.

MVP (full block) is functionally equivalent for the player —
incoming spells do nothing either way. Bounce-back is a buff to the
PLAYER (deals damage to the caster). Revisit when needed.

## #8 — DEFERRED: Encounter monster specials

`SPECIAL_ATTACKS` (`battle-enemy.js:27`) currently has these `type`
values: `damage`, `status`, `multi_status`, `none`. No `magic` flag,
so we can't gate which specials Reflect should block.

To wire this up would require:
- Classify each entry (Fire/Bolt/Bad Breath/Glare/Demon Eye/...) as
  magic vs non-magic.
- Add a `Reflect` check in `_doSpecialAttack` before applying.

Probably a 1-hour ticket once the classification table is settled.
