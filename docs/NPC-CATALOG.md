# NPC sprite catalog — FF1, FF2, FF3

Every NPC sprite in the three games, enumerated, rendered and labelled from
measurement. Sheets live in `docs/sprites/`; regenerate with:

```
node tools/npc-catalog.mjs            # all three
node tools/npc-catalog.mjs --json     # machine-readable
node tools/check-npc-gfx.mjs          # the gate
```

Why this exists: Kazus shipped with all three shop keepers wearing the **ghost**
sprite and a townsman wearing **Cid**, because sprites were being picked off a
list of hex offsets — "which bundles does this map load" — which says nothing
about who they depict, and none of them was rendered before it went out.

---

## FF3 — the id → sprite lookup, decoded

**This is the headline result.** FF3's per-map NPC list gives each NPC an `id`.
That id is *not* a sprite index; `town-npcs.js` carried a standing warning
saying so, because using it as one (v1.7.968) dressed all of Ur in player job
sprites. It also recorded three measured pairs nobody could explain:

> the known pairs (`$14->32`, `$15->34`, `$19->38`) are not a constant offset

They are a **table lookup**. Searching the entire ROM for a 256-byte window
satisfying all three yields **exactly one** offset:

```
NPC_GFX_TABLE @ ROM 0x1410      npcId -> gfx index
```

It sits immediately after the three parallel palette tables at `0x1110` /
`0x1210` / `0x1310` — precisely where the next table in that series belongs.

### How it was verified

Predicted bundle sets vs. what the **real PPU** holds
(`tools/monscan/map-bundles.cjs`), across every map the harness could load:

| | result |
|---|---|
| maps with drawn NPCs measured | **18** |
| predicted exactly | **18** |
| misses | **0** |

Including Ur 5/5, Castle Sasune 2/2, Kazus 4/4. Independently, the two flames
whose offsets `flame-sprites.js` had already measured by reading OAM agree: the
Kazus campfire (id 190) and the large torch (id 193) resolve to the **same**
index — which is exactly what that capture found — while the candle (id 194)
resolves to a different one. And gfx 79 lands on `0x14790`, whose two frames the
repo already had as `STAR_FRAMES = [0x14790, 0x147D0]`.

> ⚠ `map-bundles.cjs` writes the destination map id as a **single byte**, so any
> `MAPS=` value ≥ 256 actually loads `mapId & 0xFF`. Seven maps looked like
> misses until this was spotted; all seven match the *truncated* map's
> prediction. Not counter-examples — a harness limit. `ff1-overworld-sweep.mjs`
> has a related defect (below).

### The index space

| range | meaning | resolves to |
|---|---|---|
| `0..21` | the 22 player **job** walk sprites, in `JOB_NAMES` order | `0x1C010 + i*0x100` |
| `22..63` | **NPC people** — 16 tiles, four 2×2 facings | `0x1C010 + i*0x100` |
| `64..87` | **objects** — 8 tiles, two 2×2 frames, a *different* array | `0x14010 + (i-64)*0x80` |
| `88+` | **not drawn** — invisible event markers | — |

The job range is anchored on a fact, not a guess: **gfx 4 is the magic-shop
keeper in both Ur and Kazus**, and job 4 is the Black Mage — the repo's own
helper is called `addBlackMageShopkeeper`.

The **drawn/undrawn boundary is nominal**. The highest index any NPC uses as a
drawn sprite is 87; the lowest it uses as a marker is 97. Indices 88–96 are used
by nobody, so the line cannot be measured inside that gap and every value in
`[88, 97]` behaves identically. (Transparent-pixel fraction was tried as a
discriminator and rejected — the ranges overlap, 0.09–0.97 vs 0.05–0.77.) The
gate asserts the *gap*, not a false precision.

Totals across all 512 maps: **1187 placements — 782 people/job, 174 object,
231 invisible markers.** Every shop counter trigger in the game is index 115,
the single most-placed index (184 uses).

### Two corrections to shipped data

1. **`0x1ED10` is not "Cid (ghost form)".** `town-npcs.js` lists it in
   `STORY_SPRITE_BUNDLES`, which bans it from ordinary NPCs. It is the generic
   **ghost** sprite — used by **10 different NPC ids across 22 maps**, including
   all of Kazus's interiors (inn, magic, weapon, armor). It renders as a
   hollow outline. Banning it means Kazus's cursed interiors cannot use the
   sprite the ROM actually puts there.

2. **Kazus's real bundle set includes `0x1D910` (Cid).** Re-measured on
   hardware: map 10 loads `0x1D900, 0x1DF00, 0x1E000, 0x1E200`, and `0x1ED00`
   is **absent**. The NPC wearing Cid is **id 31 at (17,21)**. The earlier note
   claiming map 10 loads the ghost bundle was a bad measurement.

Both are recorded here rather than acted on — changing who stands where in a
live town is a content decision, not a cataloguing one.

---

## FF1 and FF2 — same engine, same layout

Both were read off a **running PPU**, not guessed. Four wrong sheets came out of
guessing before that.

* A character is **4 consecutive tiles drawn TL, TR, BL, BR**. Measured from
  OAM coordinates: FF1's Coneria Castle draws tiles `$50,$51,$52,$53` at
  `(32,28) (40,28) (32,36) (40,36)`; FF2's Altair draws `$20..$23` the same way.
* An entry is **`0x100` bytes = four 16×16 frames**, at **`0x9010 + n*0x100`**,
  **48 entries**, ending where background tiles begin at `0xC010`.
* FF1 loads three distinct frames and repeats the third; FF2 uses all four.

> The `+0x10` is the **iNES header**. Rendering from `0x9000` misaligns every
> tile by one and produces confident garbage — that is exactly what happened,
> and it is the same trap `feedback_ff3mmo_ines_header_offset` already records.

### FF1 player classes — measured

Building a party led by each class and tracing the leader's OAM tile home gives
**class N = entry N**, for all six. Names are from the game's own class-select
menu (screenshotted, not recalled):

| entry | offset | class |
|---|---|---|
| 0 | `0x9010` | Fighter |
| 1 | `0x9110` | Thief |
| 2 | `0x9210` | Bl.Belt |
| 3 | `0x9310` | RedMage |
| 4 | `0x9410` | Wh.Mage |
| 5 | `0x9510` | Bl.Mage |

Entries **6–11 are deliberately unlabelled.** They sit immediately after the six
base classes and look like the promoted forms, but promotion happens far into
the game and poking the class byte does not work — FF1 caches the walk sprite
until a map change. Unverified, so unlabelled.

### A broken tool, found on the way

`tools/ff1-overworld-sweep.mjs` finds locations by poking the party coordinate
(`$027`/`$028`) and watching for a music change. It cannot work: **806
coordinates swept, 0 hits.** FF1 only runs its entrance check on a real step, so
the poke moves the party without ever triggering entry. Walking works; the poke
never will.

---

## Files

| path | what |
|---|---|
| `src/data/npc-gfx.js` | the FF3 resolution (Node-clean; tools and gates import it) |
| `tools/npc-catalog.mjs` | renders all three catalogs + `--json` |
| `tools/check-npc-gfx.mjs` | the gate — 11 reverts tested, all fail |
| `docs/sprites/ff3-npc-catalog.png` | 88 FF3 sprites, labelled |
| `docs/sprites/ff1-npc-catalog.png` | 48 FF1 entries |
| `docs/sprites/ff2-npc-catalog.png` | 47 FF2 entries |
