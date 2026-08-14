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

## FF3 — the dialogue table, decoded

Every NPC's line is its id, offset into the global string table:

```
stringId = npcId + 0x202
```

**Measured, not inferred.** Ur's elder house (map 7) holds exactly three NPCs at
known ROM coordinates. Warping there, walking to each and reading the message
box off the PPU **nametable** gave:

| NPC | ROM position | line read off the screen | string |
|---|---|---|---|
| id 19 | (4,3) centre | "Elder Topapa, the man who raised the four orphans" | `0x215` |
| id 17 | (2,4) left | "Nina, the adoptive mother of the four orphans" | `0x213` |
| id 18 | (6,4) right | "Tomak, a village Elder" | `0x214` |

Three for three, with left/centre/right matching the ROM's own coordinates. A
fourth confirmation came from Kazus's inn (map 12): the NPC at (8,28) is id 43,
and the game displayed *"The Djinn that we had banished into the Sealed Cave was
released by the earthquake"* — string `0x22d` = 43 + 0x202.

### Reading the nametable is the trick

By the time the game draws a box it has already expanded the text compression,
so the BG tiles **are** the decoded text (tile index == character code). That
sidesteps the decoder entirely for verification.

> ⛔ Read **all four** nametables and diff against a post-warp baseline. FF3 does
> not draw the box into `$2000`, and the previous screen's tiles linger — an
> absolute read of one nametable returns the *stale battle screen* while the
> screenshot plainly shows a town interior. Also: the `inBattle()` heuristic
> (>12 OAM sprites) **false-positives in town interiors**, where three NPCs at 4
> sprites each plus the player clears the threshold. It reported "still in
> battle" while standing in Ur's elder house.

### The text format

- **String pointer table** at `0x30010`, 2 bytes per id, bank packed in the top
  3 bits of the high byte: `bank = 0x18 + (hi >> 5 & 7)`. (This scheme was
  already in `tools/text-decode.js` for item/monster names; it works unchanged
  for dialogue.)
- **Dialogue is string ids `0x000`–`0x3FF`**; `0x400`+ are item/spell/monster/job
  names.
- **DTE compression**: bytes `0x29`–`0x5C` are one byte, two characters. The
  table is at `0x75FA1` and is stored as **two parallel 52-byte arrays** — all
  the first characters, then all the second characters. Searching for the pairs
  as *adjacent* bytes ("ed", "it") finds nothing, which cost several attempts.
  A duplicate copy sits at `0x7F4F1`.

Decoded, the script reads cleanly:

> *"The Parmeni Mountains that surround these lands are ruled by King Sasune,
> whose castle is west of here."*
> *"That earthquake buried the Crystal's altar. The world is ending!"*

### The named cast

The dialogue names people directly. In the towns we ship:

| name | id | where |
|---|---|---|
| **Topapa** — the elder who raised the four orphans | 19 | Ur elder house |
| **Nina** — their adoptive mother | 17 | Ur elder house |
| **Tomak** — a village elder | 18 | Ur elder house |
| **Dahn** — Father Dahn, elder | 16 | Ur elder house |
| **Cid** — of Canaan | 48 | (his line) |
| **Takka** — the blacksmith | 52 | Kazus |
| **Sara** — King Sasune's daughter | 67 | — |
| **Desch** | 192 | — |

Full rosters: `docs/sprites/ff3-npc-dialogue.txt` (the 44 NPCs in shipped towns)
and `ff3-npc-dialogue-all.txt` (every id). Regenerate with
`node tools/npc-dialogue.mjs`.

> ⛔ Names are taken **only** where a character identifies itself — a `"Name:"`
> speaker prefix or a `"Name, the …:"` label. *"Takka is the finest blacksmith
> around. He lives here alone"* is somebody talking **about** Takka; that NPC is
> not Takka. Third-person mentions are deliberately not matched, because naming
> from them invents characters.

### A third correction to shipped data

`town-npcs.js` bans **`0x1D910` as "Cid"**. The dialogue says otherwise: the four
NPC ids wearing that sprite are **Sara** (id 67), **Desch** (id 192), and two
unnamed. One sprite cannot be both Sara and Desch, so it is a shared townsfolk
sprite, not Cid's. Combined with `0x1ED10` (the generic ghost, above), **both**
entries in `STORY_SPRITE_BUNDLES` are labelled wrong.

The ghost identification is now doubly confirmed: all ten ids wearing gfx 45 are
Kazus's cursed cast, and their own lines say so — *"The Djinn's curse has left me
in this state!"* — plus the sprite renders as a translucent outline on screen.

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

## FF1 — the dialogue table, decoded

Same result as FF3, one game earlier:

```
dialogueId == objType        (exactly, 1:1)
```

**Map objects**: 16 slots of 3 bytes per map at file `0x3410` (bank 0, CPU
`$B400`) — type, X (bits 0-5; bit 7 = in a room, bit 6 = does not move), Y.
Verified: all **290 placed objects across 40 maps have Y ≤ 63**.

Confirmed by talking to a Coneria Castle guard in the running game, which
displayed *"The King is looking for the LIGHT WARRIORS. You do not happen to be
them, do you?"* — that box is string **49**, and object type **49** is on map 0.
Map 0 then reads as a coherent castle cast (Honor Guard, the Queen locked
inside, the LUTE), and map 1's object 4 is **Garland**.

### The text format

- **Encoding** calibrated off the game's own class-select menu: "FIGHTER"
  renders as `8f 92 90 91 9d 8e 9b`, fixing **A–Z = 0x8A+, a–z = 0xA4+**.
- **String pointer table at `0x28010`** — the *same offset FF2 uses*, which is
  what you'd expect from one engine family. Text lives in the same bank.
- **DTE**: bytes `0x1A`–`0x69`, 80 entries, two parallel arrays — and FF1 stores
  them **in the opposite order to FF3**: *second* chars at `0x3F060`, *first*
  chars at `0x3F0B0`.

> ⛔ That reversal is why every search failed. Pairs-adjacent, firsts-then-seconds,
> and a delta-invariant sweep of the whole ROM all returned nothing. It was only
> found by deriving 16 codes from a single line read off the running game, then
> searching for **each half independently**.

### The named cast

Only five FF1 objects identify themselves, and all five do it with "I am …" /
"My name is …":

| name | object | map |
|---|---|---|
| **Jane**, Queen of Coneria | 59 | 12 |
| **Lukahn**, the prophet | 160 | 6 |
| **Arylon**, the Dancer | 71 | 9 |
| **Jim**, of the Dwarf Village | 139 | 16 |
| **Kope** | 177 | 5 |

Others are named only in the third person — *"Garland used to be a good knight
until…"*, *"I am BAHAMUT, King of the Dragons"* (an unplaced object) — and those
do **not** name the NPC saying them.

> ⛔ Two traps recorded in the tool: FF1 writes ellipsis as `::`, so a `"Name:"`
> speaker rule matches *"Oh:: My sister::"* and invents a character called
> **Oh**. And sweeping past map 63 yields plausible rows with Y of 161+ —
> it invented eight extra "Kope"s before the `Y ≤ 63` invariant caught it.

Full roster: `docs/sprites/ff1-npc-dialogue.txt`.

**Still open for FF1:** objType → sprite entry. The PPU allocates char slots per
map object, but the slot order does not align 1:1 with the object table, and a
delta-invariant search for the table found nothing. Every NPC has its line, its
map and its position; it does not yet have its picture.

---

## FF2 — the map object table, found

**Encoding** calibrated off Altair's own verb menu, which reads
たずねる / おぼえる / アイテム as tile indices `99 96 a1 b2` / `8e a7 8d b2` /
`ca cb dc ea` — fixing **hiragana at 0x8A, katakana at 0xCA**.

> ⛔ The kana run is **45 long, not 46: there is no を**, and `0xB6` is **ん**.
> `0xB6` appears mid-word in はんらん and さくせんかいぎ, where を is impossible.

### The objects

Map objects are **12 slots of 3 bytes** (type, X + flags, Y), in **two blocks** —
FF2 does *not* use FF1's `0x3410` (332 of 569 entries there give Y > 63):

| block | maps |
|---|---|
| `0x3510` | 17 |
| `0x3990` | 32 |

**311 objects across 44 populated maps**, and the rule is the same as FF1 and
FF3:

```
dialogueId == objType        (into the table at 0x18010)
```

**Measured**: standing in the throne room and talking produced
**【ヒルダ】「あいことばは【のばら】です。よく おぼえておくのよ。」** — that is
string **1** of the `0x18010` table, and that map's object list starts with
**type 1**. Its neighbours corroborate: type 8 is the line about **シド (Cid)**
building the airship, type 13 is about **ミンウ (Minwu)** healing her father.

> ⛔ FF2 has **eight** text pointer tables. Both object blocks validate "100%"
> against `0x4010` as well — because almost any small id has *a* pointer there —
> but `0x4010` decodes them to garbage. **Pointer validity does not identify the
> bank; content does.** The gate asserts that `0x4010` does *not* yield the
> Hilda line.

### Name and keyword inserts

Control byte `0x18` followed by N inserts string `0x100 | N` from the `0x28010`
table, which holds character names and the **ASK/LEARN keyword list**:

```
0x18 0xEF -> string 0x1EF = ヒルダ        0x18 0xF1 -> string 0x1F1 = のばら
```

That is why speakers appear at all — the name is never in the line itself. FF2
writes a speaker as `NAME「…」` (`0xB9` is the opening quote).

> ⛔ 【…】 appearing **mid-line** are keywords, not speakers. *"【ヒルダ】さまに
> はけんされてきた?"* is a guard talking **about** Hilda. Only a name in the
> opening-quote position counts.

**69 objects have a named speaker, 13 distinct.** レイラ (Leila) and ミンウ
(Minwu) come through exactly. Rosters: `docs/sprites/ff2-npc-dialogue.txt` and
`ff2-npc-names.txt`.

### There is no dictionary

The sub-`0x8A` codes are **not compression at all — they are more characters.**
Dakuten and handakuten kana sit in four contiguous blocks:

| range | contents |
|---|---|
| `0x3C`–`0x4F` | hiragana dakuten が…ぼ |
| `0x50`–`0x63` | katakana dakuten ガ…ボ |
| `0x64`–`0x68` | hiragana handakuten ぱ…ぽ |
| `0x69`–`0x6D` | katakana handakuten パ…ポ |

Seven values had already been derived from context *before* the layout was
known — `0x3D`=ぎ, `0x3E`=ぐ, `0x49`=で, `0x4B`=ば, `0x5A`=ダ, `0x5D`=デ,
`0x69`=パ — and this layout reproduces **all seven**.

Small kana and punctuation fill the gaps, each derived from context in the
script: `0x7B`=を, `0x7C`=っ ("かかっている"), `0x7D`=ゃ ("じゃくてん"),
`0x7E`=ゅ ("きゅうに"), `0x7F`=ょ ("もんしょう"), `0xBC`=ッ ("スコット"),
`0xBD`=ャ ("ジャイアントビーバー"), `0xBE`=ュ ("カシュオーン"), `0xB8`=ィ
("ミシディア"), plus `0xB9`=「, `0xC1`=。, `0xC2`=ー, `0xC3`=…, `0xC4`=!,
`0xC5`=?. Digits are at `0x80`–`0x89`, the same slot as FF1 and FF3 —
"しろの**1**かい" is a floor number.

> ⛔ **This is why every DTE-table search failed.** FF1 and FF3 really do
> compress; FF2 does not. Hunting for a table that does not exist cost several
> passes — the give-away was that the "dictionary" codes were *contiguous* and
> mapped to *single* characters.

**Coverage went from 78% to 94.7% mean literal, 397 of 397 strings above 60%.**
What remains as `{xx}` is **control codes, not text**: the low bytes (`0x02`,
`0x04`, `0x07`–`0x17`, `0x2F`, `0x3B`) drive party-name inserts and formatting —
FF3 shows the same shape as `{10}{2}` — and they are printed, never guessed.

Names now render in full, which is the whole point:

> ヨーゼフ「ありがとう。 むすめがかえってきた。 ボーゲンに おどされて
> うそをついて いたんだ。 むすめのことが しんぱいで…… すまなかった!」

**15 distinct speakers**: ヒルダ, ヨーゼフ, レイラ, ミンウ, ゴードン, シド,
ポール, ネリー, フィンおう, ダークナイト, ジャイアントビーバー, and four
descriptive labels (みはり, まどうし, ははおや, どれい).

---

## Files

| path | what |
|---|---|
| `src/data/npc-gfx.js` | the FF3 resolution (Node-clean; tools and gates import it) |
| `tools/npc-catalog.mjs` | renders all three catalogs + `--json` |
| `tools/check-npc-gfx.mjs` | sprite gate — 11 reverts tested, all fail |
| `tools/lib/ff3-text.mjs` | the script decoder (string table + DTE) |
| `tools/npc-dialogue.mjs` | every NPC with its sprite and its line |
| `tools/check-npc-dialogue.mjs` | dialogue gate — 6 reverts tested, all fail |
| `docs/sprites/ff3-npc-dialogue*.txt` | the named FF3 rosters |
| `tools/lib/ff1-text.mjs` / `tools/npc-dialogue-ff1.mjs` | FF1 script + named NPC roster |
| `tools/lib/ff2-text.mjs` / `tools/npc-dialogue-ff2.mjs` | FF2 decoder + named NPC roster |
| `tools/ff2-script-dump.mjs` | FF2 raw script dump |
| `tools/check-ff12-text.mjs` | FF1/FF2 gate — 11 reverts tested, all fail |
| `docs/sprites/ff3-npc-catalog.png` | 88 FF3 sprites, labelled |
| `docs/sprites/ff1-npc-catalog.png` | 48 FF1 entries |
| `docs/sprites/ff2-npc-catalog.png` | 47 FF2 entries |
