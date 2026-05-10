# `tools/battle-sim.js` — Plan

Terminal-runnable battle simulator. Lets Claude observe combat output without
the user testing in the browser. Sibling to `tools/render-oam-dump.js`.

**Origin:** post-v1.7.192 deferred work (memory `project_ff3mmo_next_tasks.md`,
item #1). Triggering case: L7 Red Mage dual-dagger reportedly hit L4 Black
Mage for only 4 damage; expected ~30-42/turn. Need a Node-side scope to
reproduce, observe, and bisect.

## Constraints

- **Node-only.** No DOM, no canvas, no `window`, no `Audio`. Imports must be
  pure-data / pure-math modules.
- **Must mirror production paths exactly.** Don't re-derive math; call into
  `battle-math.js` and assemble combatants via `generateAllyStats` from
  `data/players.js`. If sim and prod diverge, the sim is useless.
- **Deterministic.** `--seed=N` flag → replace `Math.random` with a 4-line
  mulberry32. `battle-math.js` already calls `Math.random` directly, so no
  math-side patching needed.
- **Memory `feedback_never_fabricate.md` applies.** If a stat or formula
  isn't in the codebase, the sim says `"unknown"` rather than guessing.

## Imports (Phase 1)

| Module | Used for |
|---|---|
| `src/battle-math.js` | `calcAttackerAtk`, `calcPotentialHits`, `rollHits`, `elemMultiplier` |
| `src/data/items.js` | `ITEMS`, `isWeapon`, `weaponSubtype` |
| `src/data/jobs.js` | `JOBS` (crit / weapon-mask / job names) |
| `src/data/players.js` | `generateAllyStats`, `computeJobStats`, `PLAYER_POOL` |
| `src/data/spells.js` | (Phase 2 only) spell defs |

Engines deliberately **not** imported: `battle-update.js`, `battle-turn.js`,
`battle-enemy.js`, `pvp.js`, `input-handler.js`, `combatant-cast.js`. They
carry timers, state machines, canvas, SFX. Sim mirrors their **call shape**.

## The three attack call shapes

Production has three different ways `rollHits` gets called. The sim must
support all three to reproduce real bugs.

| Shape | Source | dualWield flag | Per-hand split? |
|---|---|---|---|
| **Player single-wield** | `battle-turn.js:106` | `false` | No — one `rollHits` call |
| **Player dual-wield** | `input-handler.js:173-212` | `false` (per hand) | **Yes** — two `rollHits` calls, R first then L, summed |
| **Ally / PVP** | `battle-turn.js:187`, `pvp.js:386` | `true` | No — one `rollHits` call uses `attackerStats.atk` precomputed |

The L7 RM bug almost certainly lives in the divergence between the
**player-dual-wield per-hand** shape and the **PVP single-call** shape,
since one duel can hit either path depending on perspective.

## Combatant model

```js
{
  // Identity
  name, jobIdx, level,

  // Stats (from computeJobStats)
  str, agi, vit, int, mnd, hp, maxHP,

  // Equipment (item IDs)
  weaponR, weaponL, armorId, helmId, shieldId,

  // Derived (assembled by generateAllyStats)
  atk, def, hitRate, evade, shieldEvade, mdef, statusResist, jobLevel,

  // Battle state (mutable across turns)
  status,         // poison, sleep, etc — Phase 2
  buffs,          // haste, protect — Phase 2
  isDefending,    // halve incoming — Phase 2
}
```

Profile shorthand resolves to one of these via `generateAllyStats`:

```
RM7  → Red Mage L7,   default loadout (PLAYER_POOL or by-loc fallback)
BM4  → Black Mage L4
WM3  → White Mage L3
OK1  → Onion Knight L1
KN12 → Knight L12
```

Loadout overrides via flags:

```
--p1 RM7 --p1.weaponR=0x1E --p1.weaponL=0x1E   # both hands dagger
--p1 BM4 --p1.armorId=0x42                      # specific armor
```

If unspecified, defaults come from `PLAYER_POOL` location-tier rules already
in `generateAllyStats`.

## CLI

```
node tools/battle-sim.js                            # default: RM7 vs BM4 duel, seed 1
node tools/battle-sim.js --p1=RM7 --p2=BM4
node tools/battle-sim.js --p1=RM7 --p2=BM4 --turns=5
node tools/battle-sim.js --p1=RM7 --p2=BM4 --mode=dummy   # P2 doesn't swing back
node tools/battle-sim.js --p1=RM7 --p2=BM4 --seed=42
node tools/battle-sim.js --p1=RM7 --p2=BM4 --runs=1000    # Phase 4 statistical
node tools/battle-sim.js --help
```

Modes:
- `duel` (default) — round-robin, P1 then P2 each turn until someone KOs
- `dummy` — only P1 swings, P2 is a static HP target. Best for isolating an
  attacker's damage output (e.g., the L7 RM bug)
- `solo` — only P1, no defender. For testing buff/status timing.

## Output (Phase 1)

```
=== ff3mmo battle-sim  seed=1  mode=duel ===
P1: RM L7  "Tellah"   HP 120/120  ATK 17  DEF  9  AGI 11  hitRate 80
    R: dagger (atk 9)   L: dagger (atk 9)   armor: leather, cap, no shield
P2: BM L4  "Strago"    HP  78/ 78  ATK 14  DEF  6  AGI  8  hitRate 80
    R: rod (atk 5)      L: -                armor: cloth, hat, no shield

--- Turn 1 ---
P1 → P2  (player-dual-wield path: 2 hits/hand, sequential R then L)
  R-hand (dagger atk 9):  rollHits(atk=17, def=6, n=2) → [dmg=14, dmg=11]   sum=25
  L-hand (dagger atk 9):  rollHits(atk=17, def=6, n=2) → [miss, dmg=12]     sum=12
  total: 37 dmg (4 swings, 1 miss)
  P2 HP: 78 → 41

P2 → P1  (PVP path: dualWield=false, single rollHits, n=2)
  rollHits(atk=14, def=9, n=2) → [dmg=6, dmg=8]
  total: 14 dmg
  P1 HP: 120 → 106

--- Turn 2 ---
...

=== P1 wins on turn 3 ===
Summary: P1 dealt 78 over 3 turns (avg 26/turn).  P2 dealt 39 over 3 turns (avg 13/turn).
```

For the **L7 RM bug repro**:

```
node tools/battle-sim.js --p1=RM7 --p1.weaponR=0x1E --p1.weaponL=0x1E \
                         --p2=BM4 --mode=dummy --turns=5 --seed=1
```

If output shows `total: 4` consistently, we've reproduced. Then bisect:
disable per-hand path, switch to PVP-shape, etc. — see if the path
selection is the bug, or if the math itself is.

## Phases

### Phase 1 — Physical attacks (target: ~150 LOC)

**Ships:** L7 RM bug repro tool.

- [ ] Profile shorthand resolver (`RM7` → combatant) using `generateAllyStats`
- [ ] CLI parser (no deps; `process.argv.slice(2)` + `--key=value` split)
- [ ] Mulberry32 seeding via `Math.random` replacement
- [ ] Three attack-path simulators:
  - `simAttackPlayerSingleWield(att, def)` — one `rollHits` call
  - `simAttackPlayerDualWield(att, def)` — two `rollHits` (R then L), summed
  - `simAttackPVP(att, def)` — one `rollHits` with `dualWield=true`
- [ ] Path selector: by `combatant.role` (`'player'` / `'pvp'`) and weapons
- [ ] Turn loop: P1 swings → resolve → check KO → P2 swings (or skip if `--mode=dummy`)
- [ ] Pretty-printer for combatant header + per-turn output
- [ ] `--help` text

### Phase 1.5 — Output polish

- [ ] Per-turn diff view: `P1 HP 120 → 106 (-14)` ANSI red/green
- [ ] `--quiet` mode: just the final result line (for use in test harness)
- [ ] `--json` output mode for tooling

### Phase 2 — Spells, status, buffs ✅ shipped v1.7.194

- [x] Spell cast: damage / heal / cure-status / status / instakill / buff.
  Ported pure math from `combatant-cast.js` + `spell-cast.js:_rollMagicAmount`.
- [x] Status effects via `status-effects.js` (pure import): poison tick,
  sleep + paralysis skip-turn, blind hit penalty, mini/toad atk multiplier,
  silence blocks cast, sleep wake-on-hit.
- [x] Buffs via `buffs.js` (pure import): Haste (2× hits via
  `calcPotentialHits`), Protect (halves physical via `rollHits.targetProtected`).
- [x] Defend action: halves NEXT incoming swing on actor (consumed when
  the swing lands, not on turn boundary).
- [x] CLI: `--p1.action=attack|defend|cast:<spell>`,
  `--p1.status=poison,sleep`, `--p1.buff=haste,protect`, `--p1.hp=N`.
- [x] Spell-name resolver covering the common spells (Fire, Bzzard, Sleep,
  Cure, Poisona, Esuna, Death, Haste, Protect, etc.) — see SPELL_BY_NAME.
- [-] AI heuristic: deferred. Manual `--p1.action` is enough; AI lives in
  Phase 2.5 if a need surfaces.

**Skipped intentionally** (would need encounter / multi-target plumbing):
multi-target spells (Curaja, Quake, Aero), reflect bouncing, drain
caster-heal, MP cost / "out of MP" handling, monster `weakness`/`resist`
elemental scaling (data is there but no synthetic monsters use it yet —
defer to Phase 3).

### Phase 3 — Encounters & bosses ✅ shipped v1.7.195

- [x] Monster combatants from `data/monsters.js` via `buildMonster(idOrName)`.
  Auto-extracts the 231 monster names from inline comments at startup so
  `--enemies=goblin*3` works (lowercase snake_case). Hex IDs and decimal
  IDs both accepted.
- [x] Multi-target battles via `--party=RM7,BM4,WM4 --enemies=goblin*3,killer_bee`.
  AGI-ordered turn loop sorts all alive combatants per turn.
- [x] Monster attack call shape (`attackMonster`) mirrors `battle-enemy.js:189
  rollMultiHit` — uses `mon.attackRoll` for hit count, `mon.atk` direct
  (no str/2), `mon.atkElem` for elemental, `mon.weakness`/`resist` for
  defender lookup, no crit (NES canon).
- [x] Boss path: `--boss=land_turtle` shorthand. `[BOSS]` tag in header.
- [x] Spell casts work in encounter mode (Cure auto-redirects to self).
- [x] Targeting: random alive enemy on opposite team.
- [-] Monster special attacks (`mon.spAtkRate` + `mon.attacks[]`) — deferred
  to Phase 3.5. Currently monsters only do physical attacks.
- [-] Per-ally action overrides (`--p2.action=cast:Fire`) — deferred.
  Currently the whole party uses `--p1.action`.

### Phase 4 — Statistical mode

- [ ] `--runs=1000` flag — runs N battles, aggregates results
- [ ] Output: P1 win-rate, avg turns to KO, dmg histogram per side
- [ ] CSV export for spreadsheet analysis

## Out of scope (forever)

- Animation timing (cast / spell / damage-num phases)
- SFX / audio
- Sprite rendering
- Save / load state
- Multiplayer matchmaking / netcode
- UI / menus / target selection — just direct API

## Risks

- **`generateAllyStats` accepts a `player` object shape that may have hidden
  required fields.** Mitigation: read all the call sites first, mirror the
  exact shape passed in production. If it errors, fix the input — don't
  patch the helper.
- **Path-selector bugs.** If sim picks the wrong attack path for a given
  matchup, output won't match the in-game observation. Mitigation: print
  the selected path in the output header; cross-check against a known
  matchup in browser before trusting numbers.
- **Status / buff state leakage between turns.** Mutable combatant fields
  must be reset properly. Mitigation: deep-clone the combatant at the
  start of each turn for `--runs` mode.
- **The L7 RM bug might not reproduce in sim.** Either the bug needs a
  state we don't simulate (status, buff, equipment misread), or the bug
  is in the visual/render path and the math is fine. Either way, the sim
  output narrows it down.

## Success criteria

Phase 1 ships when: `node tools/battle-sim.js --p1=RM7 --p2=BM4 --mode=dummy
--seed=1 --turns=5` runs and prints turn-by-turn damage, the numbers match
what an in-game RM7 vs BM4 fight produces (verified by user), and the L7 RM
4-dmg anomaly is either reproduced or ruled-out at the math layer.

## Memory updates after Phase 1

If the L7 RM bug is reproduced and root-caused, update:
- `project_ff3mmo_next_tasks.md` — strike item #2 (low-dmg anomaly)
- Add a `feedback_*` memory if the root cause is a path-selector divergence
  (so future Claude knows to check both per-hand and PVP shapes for any
  dual-wield change).
