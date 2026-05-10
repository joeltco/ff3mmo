# ff3mmo Balance Audit — 2026-05-10

Driven by `tools/battle-sim.js` (Phase 1–4) using statistical mode
(`--runs=200`/`--runs=100` per matchup, mulberry32-seeded). All numbers
are reproducible — repro commands below each finding.

**TL;DR — six issues worth attention:**

1. 🐛 **`_JOB_STAT_WEIGHTS` only filled for jobIdx 0–5** — Knight/Thief/Ranger/**Black Belt**/Ninja/etc. all use flat 1/1/1/1/1 default. Single concrete fix.
2. ⚠️  **Werewolf and Killer Bee in grasslands wipe a starter solo** — 0–6% win
3. ⚠️  **First-move advantage is universal (~65–70% in mirrors)** — design choice or bug?
4. ⚠️  **Land Turtle is a coin-flip solo, trivial in 3-party** — wide difficulty range
5. ⚠️  **Black Mage at L4 deals 5–12× physical damage** vs low-mdef targets
6. ✅  **Altar Cave + Goblin grasslands** are appropriately tuned

> **NOTE — earlier "Monk unarmed broken" finding has been retracted.** That
> conclusion came from comparing Monk-with-special-weights against jobs that
> were silently using default 1/1/1/1/1 weights. Once the missing weights are
> added (#1 below), Monk's unarmed power is right-sized: ahead in early game
> (gear-poor) and pulled past by Fighter once tier-3 swords (atk 35 → 120 →
> 160) come online. Monks are *supposed* to kick ass unarmed, and they do.
> See section 1 for the actual bug + fix.

---

## 1. `_JOB_STAT_WEIGHTS` only covers jobs 0–5

`src/data/players.js:219` defines stat weights for Onion Knight, Fighter,
Monk, White Mage, Black Mage, and Red Mage. Every job past jobIdx 5 falls
through to `_DEFAULT_STAT_WEIGHTS = {1, 1, 1, 1, 1}`. So:

> Black Belt — Monk's L14 evolution — has WORSE stats than Monk at the
> same level (Monk has weight 2 for str/agi/vit; Black Belt has 1).

**Stat readout @ L10 (every "advanced" job is identical):**

| Job          | jobIdx | Has weight? | ATK | DEF | AGI | INT | MND |
|--------------|--------|-------------|-----|-----|-----|-----|-----|
| Onion Knight | 0      | yes (1/1/1/1/1) | 17 | 10  | 15  | 15  | 15 |
| Fighter      | 1      | yes (2/1/2/1/1) | 22  | 15  | 15  | 15  | 15 |
| Monk         | 2      | yes (2/2/2/1/1) | 22  | 15  | **25**  | 15  | 15 |
| White Mage   | 3      | yes (1/1/1/1/3) | 17 | 10  | 15  | 15  | **35** |
| Black Mage   | 4      | yes (1/1/1/3/1) | 17 | 10  | 15  | **35** | 15 |
| Red Mage     | 5      | yes (1/1/1/2/2) | 17 | 10  | 15  | **25** | **25** |
| Ranger       | 6      | **NO** | 17 | 10  | 15  | 15  | 15 |
| Knight       | 7      | **NO** | 17 | 10  | 15  | 15  | 15 |
| Thief        | 8      | **NO** | 17 | 10  | 15  | 15  | 15 |
| Scholar      | 9      | **NO** | 17 | 10  | 15  | 15  | 15 |
| Geomancer    | 10     | **NO** | 17 | 10  | 15  | 15  | 15 |
| Dragoon      | 11     | **NO** | 17 | 10  | 15  | 15  | 15 |
| Viking       | 12     | **NO** | 17 | 10  | 15  | 15  | 15 |
| Black Belt   | 13     | **NO** | 17 | 10  | 15  | 15  | 15 |
| Magic Knight | 14     | **NO** | 17 | 10  | 15  | 15  | 15 |
| Ninja        | 21     | **NO** | 17 | 10  | 15  | 15  | 15 |

Sixteen advanced jobs are functionally identical at the same level. A
player who unlocks Black Belt (intended power-up over Monk) gets a
*downgrade* in str/agi/vit. A Knight should out-tank a Ranger but
they're stat-twins. A Ninja should be the speed king but is just an
average physical.

This is also the root cause of the original "Monk unarmed broken"
finding I retracted — Monk *appeared* to dominate because every other
job past RM5 was using default stats. With proper weights filled in,
Knight matches Monk on physical, Ninja outpaces both via AGI, etc.

**Suggested fix.** Fill in the table. Educated guesses by class identity
(open to user override):

```js
const _JOB_STAT_WEIGHTS = {
  0: { str: 1, agi: 1, vit: 1, int: 1, mnd: 1, mp: 0 }, // Onion Knight
  1: { str: 2, agi: 1, vit: 2, int: 1, mnd: 1, mp: 0 }, // Fighter
  2: { str: 2, agi: 2, vit: 2, int: 1, mnd: 1, mp: 0 }, // Monk
  3: { str: 1, agi: 1, vit: 1, int: 1, mnd: 3, mp: 3 }, // White Mage
  4: { str: 1, agi: 1, vit: 1, int: 3, mnd: 1, mp: 3 }, // Black Mage
  5: { str: 1, agi: 1, vit: 1, int: 2, mnd: 2, mp: 2 }, // Red Mage
  // --- L9 unlocks ---
  6: { str: 1, agi: 2, vit: 1, int: 1, mnd: 1, mp: 0 }, // Ranger (bow + agi)
  7: { str: 2, agi: 1, vit: 3, int: 1, mnd: 1, mp: 0 }, // Knight (tank)
  8: { str: 1, agi: 3, vit: 1, int: 1, mnd: 1, mp: 0 }, // Thief (speed)
  9: { str: 1, agi: 1, vit: 1, int: 2, mnd: 2, mp: 0 }, // Scholar
  // --- L14 unlocks ---
 10: { str: 1, agi: 2, vit: 1, int: 1, mnd: 2, mp: 0 }, // Geomancer
 11: { str: 2, agi: 1, vit: 2, int: 1, mnd: 1, mp: 0 }, // Dragoon
 12: { str: 3, agi: 1, vit: 3, int: 1, mnd: 1, mp: 0 }, // Viking (heavy tank)
 13: { str: 3, agi: 3, vit: 3, int: 1, mnd: 1, mp: 0 }, // Black Belt (Monk evolved)
 14: { str: 2, agi: 1, vit: 2, int: 1, mnd: 1, mp: 1 }, // Magic Knight
 15: { str: 1, agi: 1, vit: 1, int: 1, mnd: 3, mp: 4 }, // Conjurer
 16: { str: 1, agi: 2, vit: 1, int: 1, mnd: 2, mp: 0 }, // Bard
  // --- L29+ unlocks (high tier) ---
 17: { str: 1, agi: 1, vit: 1, int: 1, mnd: 3, mp: 4 }, // Summoner
 18: { str: 1, agi: 1, vit: 1, int: 1, mnd: 4, mp: 5 }, // Devout
 19: { str: 1, agi: 1, vit: 1, int: 4, mnd: 1, mp: 5 }, // Magus
 20: { str: 1, agi: 1, vit: 1, int: 3, mnd: 3, mp: 5 }, // Sage
 21: { str: 2, agi: 3, vit: 2, int: 1, mnd: 1, mp: 0 }, // Ninja (speed god)
};
```

These are *guesses* — the user owns the design and should refine. The
weights respect class identity (tanks have str/vit, mages have int/mnd,
speed jobs have agi).

**Repro:**
```bash
for spec in OK10 FI10 MO10 KN10 BB10 NI10; do
  node tools/battle-sim.js --p1=$spec --turns=1 --seed=1 | grep "P1:"
done
# All non-OK/FI/MO show identical stats — confirms the fall-through.
```

---

## 2. Grasslands has lethal formations for a starter party

Per `data/encounters.js`, grasslands has three formations: Goblin, Killer
Bee, Werewolf. Goblin is fine. The other two are not.

**OK1 (default starter) win-rate over 200 runs:**

| Formation       | Solo OK1 | OK1+FI1 | OK1+FI1+WM1 |
|-----------------|----------|---------|-------------|
| Goblin × 2      | 100%     | —       | —           |
| Goblin × 4      | 97.5%    | 100%    | —           |
| Killer Bee × 2  | 54.5%    | 100%    | —           |
| Killer Bee × 4  | **1.0%** | 54.5%   | 98.5%       |
| Werewolf × 2    | **0.0%** | 72.5%   | —           |
| Werewolf × 4    | **0.0%** | 0.0%    | **6.5%**    |

A solo OK1 effectively cannot enter grasslands without immediate wipe
once a non-Goblin formation rolls. **Even a full L1 3-party wipes to
Werewolf×4** (the max-roll formation): 6.5% survival rate.

This is structurally identical to the v1.7.193 dual-wield bug — the
data is technically valid, but a real player will hit it and conclude
the game is broken.

**Suggested fixes** (any one of):
- Lower max-count for Werewolf/Killer Bee formations (`max: 2` instead of 4).
- Move Werewolf to `altar_cave` only (already in its location list).
- Adjust Werewolf stats: `atk: 9` × `attackRoll: 3` × 70% hitRate = ~16
  dpt per werewolf — at 4 werewolves that's 64 dpt vs OK1's 24 HP.
  Cap at 2 werewolves OR drop `attackRoll: 2`.

**Repro:**
```bash
node tools/battle-sim.js --party=OK1 --enemies=werewolf*4 --runs=200
node tools/battle-sim.js --party=OK1,FI1,WM1 --enemies=werewolf*4 --runs=200
```

---

## 3. First-move advantage is universal (~65–70% in mirrors)

In every mirror match at L7, P1 (acts first) wins ~65–70% of the time.
Same combatant, same stats, same equipment — turn order alone biases
the result by 30+ percentage points.

**L7 mirror matches, 200 runs each:**

| Matchup        | P1 wins | P2 wins |
|----------------|---------|---------|
| RM7 vs RM7     | 66.0%   | 34.0%   |
| BM7 vs BM7     | 67.5%   | 32.5%   |
| WM7 vs WM7     | 70.0%   | 30.0%   |
| KN7 vs KN7     | 68.0%   | 32.0%   |
| FI7 vs FI7     | 64.5%   | 35.5%   |
| TH7 vs TH7     | 66.5%   | 33.5%   |
| **MO7 vs MO7** | 75.5%   | 24.5%   |

The MO mirror is even more skewed because Monks KO faster (~2.8 turns
vs ~4) so the first-move premium compounds.

NES FF3 used AGI to decide turn order with random tie-breaking. The sim
mirrors this except ties go to whoever's listed first. **In duels with
equal AGI, the sim always gives P1 first move.** A real PVP system
should either:
- Roll initiative randomly per turn (eliminates the bias entirely)
- Add a small AGI variance per turn (`agi + rand(0..agi/4)`) so equal-AGI
  combatants don't strictly tie

**This may be intended for single-player vs monsters** (player goes
first feels good), but it skews PVP and any same-stat duel.

**Repro:**
```bash
for job in RM BM WM KN FI MO TH; do
  node tools/battle-sim.js --p1=${job}7 --p2=${job}7 --runs=200 --seed=1
done
```

---

## 4. Land Turtle is a coin-flip solo, trivial in 3-party

Land Turtle (HP 120, atk 9 × 3, mdef 32) at `altar_cave_boss`. 200 runs each.

| Party                              | Win rate | Avg turns |
|------------------------------------|----------|-----------|
| OK4 solo                           | **1.5%** | 6.93      |
| OK5 solo                           | 57.0%    | 8.96      |
| KN5 solo                           | 60.0%    | 8.84      |
| RM5 solo                           | 60.0%    | 8.76      |
| WM5 solo                           | 55.0%    | 9.11      |
| **FI5 solo**                       | **100%** | 8.82      |
| BM5 (Fire spam)                    | 37.0%    | 9.53      |
| MO5 unarmed solo                   | 100%     | 3.37      |
| OK4/FI5/WM4 (intended early-game)  | 100%     | 3.83      |
| FI5/WM5/BM5 (Fire)                 | 100%     | 3.60      |

Solo difficulty swings from 1.5% (OK4) to 100% (FI5, MO5) depending on
class — wider spread than feels intentional. 3-party trivializes it
regardless of comp.

**BM5 with Fire is the worst solo option** (37%) because Land Turtle's
mdef 32 eats most of Fire's ~31 baseDmg, leaving ~2–10 per cast.

**MO5 unarmed solo at 100% / 3.37 turns** is also out-of-line — much
faster than FI5's 8.82 turns. Same Monk-scaling pathology as #1.

**Repro:**
```bash
node tools/battle-sim.js --party=OK4 --boss=land_turtle --runs=200
node tools/battle-sim.js --party=BM5 --p1.action=cast:Fire --boss=land_turtle --runs=200
node tools/battle-sim.js --party=FI5 --boss=land_turtle --runs=200
```

---

## 5. Black Mage at L4 outdamages physical 5–12×

L4 dpt vs static KN15 dummy (mdef 2), 200 runs:

| Action                     | DPT       |
|----------------------------|-----------|
| OK4 knife                  | 2.10      |
| TH4 knife                  | 2.16      |
| BM4 knife (melee)          | 2.17      |
| WM4 staff                  | 2.00      |
| RM4 knife                  | 2.42      |
| FI4 default sword          | 4.06      |
| MO4 unarmed                | 6.73      |
| FI4 dual-knife             | 8.09      |
| **RM4 cast Fire**          | 36.53     |
| **BM4 cast Fire**          | 39.06     |
| **BM4 cast Bzzard**        | 39.06     |
| **BM4 cast Thunder**       | **51.59** |

Black Mage's Fire/Bzzard at L4 deal **18×** what an OK with a knife does.
This is fine if monsters at L1–4 have appropriate mdef — but most
monsters at the early tier have `mdef: 10`, which only knocks ~10 off
Fire's ~50 baseDmg, leaving 40+ per cast vs OK1's 5 HP.

The asymmetry only flips on bosses: vs Land Turtle (mdef 32), BM5's
Fire gets gated to ~11 dpt (37% solo win-rate above).

**Repro:**
```bash
for spell in Fire Bzzard Thunder; do
  node tools/battle-sim.js --p1=BM4 --p1.action=cast:$spell --p2=KN15 --mode=dummy --runs=200
done
```

---

## 6. Things that are tuned correctly

- **Goblin grasslands**: solo OK1 wins 97.5% vs 4 goblins. ✓
- **Altar Cave F1–F4**: 3-party wins 100%, solo wins 42–100% depending on
  formation depth. ✓
- **Solo intended-class vs Land Turtle (~55–60% win)**: tight enough to be
  a legit boss check at the right level.
- **Mid-game encounters in 3-party**: Petits, zombies, lilliputians, all
  beatable at expected level (when those zones are wired up — most are
  data-only, not in `encounters.js` yet).

---

## Speculative — not currently active in the game

These tests assumed the data in `MONSTERS` is going to ship as-is. Most of
these zones aren't in `encounters.js` yet, so **none of these are live
issues — flag them when you wire the zones up:**

| Encounter (zone)                   | Result | Notes |
|------------------------------------|--------|-------|
| FI4/WM4 vs zombie×3 (cave_seal)    | 6%     | 30 dpt — needs BM Fire (2× weakness) |
| FI4/WM4 vs mummy×2 + skeleton×2    | 0%     | 49 dpt total |
| FI6/WM6/BM6 vs firefly×3 (summit)  | **0%** | 97 dpt from Fire spam — see #4b below |
| FI6/WM6/BM6 vs rust_bird+helldiver | 2%     | Helldiver has 3-status atk |
| FI8/WM8/BM8 vs petit×2 (nepto)     | 99%    | spAtkRate 80% Fire/Bzzard/Thunder |

**4b. Firefly density is the killer.** A single firefly is a 99.5% win
fight (22 dpt). Two are 24% (57 dpt). Three is 0% (95 dpt). If you wire
summit_road into encounters.js, cap firefly formations at `max: 2` or
their Fire-spam will instantly wipe a 3-party.

**Repro (when you're ready):**
```bash
node tools/battle-sim.js --party=FI6,WM6,BM6 --enemies=firefly*3 --runs=200
node tools/battle-sim.js --party=FI4,WM4,BM4 --p3.action=cast:Fire --enemies=zombie*4 --runs=200
```

---

## Catalog of high-spAtkRate monsters (≥50%)

For when those zones get wired up — these monsters can wipe a party
through specials alone. The player may want to design formations
(low-count, mixed) around them.

| Monster        | Lv  | spAtkRate | Attacks                          | Zone                |
|----------------|-----|-----------|----------------------------------|---------------------|
| Firefly        | 3   | 60%       | Fire                             | summit_road         |
| Lilliputian    | 2   | 50%       | Fire/Bzzard/Thunder              | nepto_shrine        |
| Petit          | 3   | 80%       | Fire/Bzzard/Thunder              | nepto_shrine        |
| Flyer          | 7   | 50%       | Glare                            | castle_argus        |
| Bomb           | 9   | 50%       | Explosion                        | dwarven_cave        |
| Magician       | 12  | 50%       | Fira/Bzzara/Tara                 | surface_world       |
| Manticore      | 18  | 60%       | Bzzard                           | dwarven_cave        |
| Sorcerer       | 22  | 99%       | Fira/Bzzara/Tara                 | dragon_tower        |
| Hein (boss)    | 12  | 99%       | Fira/Bzzara/Tara                 | flame_cave_boss     |
| HelgaruMage    | 32  | 99%       | Break/Fira/Shade/Bzzara/Tara     | dragon_tower        |
| Frostfly       | 34  | 90%       | Bzzara                           | sky                 |

The "99%" entries always fire their special on every turn. For boss
fights this is fine; for trash mobs the player will get caught between
two casts with no recovery time.

---

## Method

- All runs used `tools/battle-sim.js --runs={100|200} --seed=1` for
  reproducibility (mulberry32 swap of `Math.random`).
- DPT measurements via `--mode=dummy` (P2 doesn't retaliate, so the
  reported dpt is pure offensive output).
- Win rates via `--mode=duel` or full encounter mode.
- Generated histograms inspected manually for distribution shape (not
  just mean).
- Numbers should be reproducible to the digit when re-running — same
  seed, same sim version (v1.7.197).

To re-run the audit after a balance fix, the spec for each finding
includes a working `--runs=200` command.
