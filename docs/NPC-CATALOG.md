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

## FF1 — the map-load routine, disassembled

The link is solved, and disassembling the loader corrected three things I had
wrong.

```
$E7FB  LDA $48        ; $0048 IS the current map id
       ASL/ROL x4     ; mapId * 16, then *2 + itself  => mapId * 48
       ADC #$B4       ; + $B400
       LDA #$00 / JSR $FE03    ; switch to BANK 0
$E824  LDA ($1C),Y    ; read the object TYPE
$E82C  ADC #$03       ; 3 bytes per entry
$E7F3  LDA #$0F       ; FIFTEEN slots, always
```

So: **15 slots of 3 bytes per map at file `0x3410`, stride 48**, and

```
sprite ROM offset = 0xA210 + SPRITE_TABLE[objType] * 0x100     (table @ file 0x2E10)
```

### How the sprite table was found

Every earlier attempt failed because I was feeding searches *wrong pairs*. The
fix was to stop inferring and **patch the ROM**: set every object on one map to
a single type, boot in, and read which single sprite the PPU loads. That gives
`objType -> sprite` with no alignment assumption anywhere.

Six probes (types 49, 32, 63, 100, 150, 200) yield **exactly one** table in the
whole ROM that reproduces them — file `0x2E10`, CPU `$AE00`, bank 0, with a
constant bias of +18. It then predicts the *unpatched* map's ten objects
**10/10**, and all **182 placed types land in entries 18–47** — exactly the NPC
half of the 48-entry bank (0–17 are the player classes and vehicles).

### Three corrections the disassembly forced

1. **15 slots, not 16 — and a zero type is not a terminator.** The loader reads
   all 15 (`LDA #$0F`). The old reader stopped at the first zero *and* read a
   16th slot: 287 objects, not 290.
2. **Both coordinate bytes are masked with `#$3F`.** The X mask is observable
   (108 of 287 objects carry flag bits). The **Y mask is not** — no object in
   this ROM sets bits 6–7 of byte 2 — so the gate does not pretend to test it.
3. **The map I had been probing was map 8, not map 0.** `$0048` held 8, and the
   captured table pointer was `$B580` = `0x3410 + 8*48`. Patching map 0 changed
   nothing, which is why the first probe returned identical results for all
   eight types.

### objType → dialogue: a four-byte record

Traced by hooking the string-pointer fetch and walking the stack back
(`$DB71` ← `$D4B1` ← `$CA03` ← `$902B` in bank 14):

```
$902B  LDA $6F00,X    ; the object's TYPE, from the RAM object array
       ASL A / ASL A  ; type * 4
       ADC #$D5 ...   ; + $95D5
$9046  LDA ($14),Y    ; four bytes
$9059  JMP ($0016)    ; per-type handler ($90D3 / $91D3 jump tables)
```

Each type has a **four-byte record at CPU `$95D5` in bank 14 = file `0x395E5`**:

| byte | meaning |
|---|---|
| 0 | game-flag / condition index |
| 1 | **the line shown by default** |
| 2 | the line after that event |
| 3 | usually 0 |

A per-type handler picks between [1] and [2] on a flag, so there is no single
"the" id — but **[1] is the first thing an NPC says**.

**Measured**: the Coneria Castle guard displayed string 49, and type 32's record
is `(18, 49, 50, 0)`. Decoding [1] map-wide comes out location-coherent: map 8 is
Coneria Castle (King / LUTE / Queen locked inside), map 2 is ElfLand (Save our
Prince / Astos / Dark Elf), map 12 is the Temple of Fiends past.

### ⛔ The retraction that led here

v1.8.25 claimed `dialogueId == objType`, verified. **It was wrong** — the
"confirmation" was a coincidence (a talk gave string 49; some map happened to
hold an object of type 49). Patching *every* map-8 object to type 100 still made
a talk fetch string 120, which is what forced the trace above.

The tell that it was wrong all along: under that rule **Jane, Queen of Coneria,
sat on map 12**. Under the real table she is **object type 41 on map 8 —
Coneria Castle**, where a Queen of Coneria belongs. Bahamut likewise moved to
map 39, his own cave. The gate now asserts both.

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

**311 objects across 44 populated maps.** Coordinates confirmed by *walking to
them* in the emulator and finding an NPC there.

### objType → sprite

```
sprite ROM offset = 0x9B10 + SPRITE_TABLE[objType] * 0x100   (table @ file 0xD10)
```

Measured exactly like FF1's: patch every object on the Altair throne room to one
type, boot in, read which single sprite the PPU loads. Five clean probes
(types 1, 8, 13, 97, 150 → entries 20, 14, 16, 37, 30) leave **exactly one**
table in the whole ROM, and it then predicts that room's seven objects **7/7**
against a PPU trace captured before any of it was known.

> ⛔ `0xD10` sits in a region of mostly-small bytes that an early structural scan
> dismissed as a trivial match. Structure did not find it; measurement did.

### ⛔ objType → dialogue is UNSOLVED — and the old answer was wrong

v1.8.26 shipped `dialogueId == objType` **as verified. It is false**, and it
failed exactly the way FF1's retracted rule did: one coincidence read as a rule.

`tools/ff2-talk-probe.mjs` walks to a tile, presses A, reads the box off the
nametable, then finds that text in the ROM and reports which table entry points
at it. Run against every object in the Altair throne room:

| objType | who | resolves to | verdict |
|---|---|---|---|
| 1 | ヒルダ (Hilda) | `0x18010[1]` | id == type — **the coincidence** |
| 8 | ミンウ (Minwu) | `0x18010[49]` | id ≠ type — **the disproof** |
| 97 | — | `0x28010[2]` | a *different table* |
| 99 | — | `0x28010[4]` | a *different table* |

So there is not even a single dialogue table to be indexed. Hilda being object
type 1 *and* string 1 is the first thing anyone checks, which is why it stood.

**The tell it was wrong all along**: under that rule, 44 of the 175 placed object
types "spoke" lines whose opening name insert was a *keyword* — ペンダント
(pendant), めがみのベル (goddess bell), エギルのたいまつ (Egil's torch),
ひくうせん (airship), ミスリル (mythril). Pendants do not talk. It also labelled
ten visibly different sprites "Hilda", which is what made it visible at last:
**rendering the sheet is what caught it.**

Two measured pairs are not enough to identify the mapping — a byte table with
`T[1]=1` and `T[8]=49` still leaves 6 candidates at stride 1. Finding it needs
more probe points or a disassembly of FF2's talk routine, the way
`tools/dis6502-ff1.mjs` cracked FF1's.

> ⛔ FF2 has **eight** text pointer tables. Both object blocks validate "100%"
> against `0x4010` as well — because almost any small id has *a* pointer there —
> but `0x4010` decodes them to garbage. **Pointer validity does not identify the
> bank; content does.**

### Name and keyword inserts

Control byte `0x18` followed by N inserts string `0x100 | N` from the `0x28010`
table, which holds character names and the **ASK/LEARN keyword list**:

```
0x18 0xEF -> string 0x1EF = ヒルダ        0x18 0xF1 -> string 0x1F1 = のばら
```

The name is never in the line itself. FF2 writes a speaker as `NAME「…」`
(`0xB9` is the opening quote).

> ⛔ 【…】 appearing **mid-line** are keywords, not speakers. *"【ヒルダ】さまに
> はけんされてきた?"* is a guard talking **about** Hilda. Only a name in the
> opening-quote position counts.

> ⛔ A speaker names **whoever speaks that string** — it does *not* name the NPC
> you are standing in front of, because the objType → string link is unsolved
> (above). Counting speakers per *object* was how the retracted rule produced
> ten different sprites all labelled "Hilda".

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

**15 distinct speakers appear in the script**: ヒルダ, ヨーゼフ, レイラ, ミンウ,
ゴードン, シド, ポール, ネリー, フィンおう, ダークナイト, ジャイアントビーバー,
and four descriptive labels (みはり, まどうし, ははおや, どれい) — that is a
fact about the *script*, not an assignment of names to sprites.

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
| `tools/lib/ff1-text.mjs` | FF1 script + map objects + objType→sprite |
| `tools/npc-dialogue-ff1.mjs` | FF1 objects: position + sprite (no dialogue — see above) |
| `tools/ff1-script-dump.mjs` | FF1 script + self-naming characters |
| `tools/dis6502-ff1.mjs` | 6502 disassembler for the MMC1 ROMs |
| `tools/lib/ff2-text.mjs` | FF2 kana decoder + map objects + objType→sprite |
| `tools/npc-dialogue-ff2.mjs` | FF2 objects (no dialogue — see above); `--strings` dumps the script by id |
| `tools/ff2-talk-probe.mjs` | walks to an NPC, talks, and reports which table entry it displayed |
| `tools/npc-sheet-ff1.mjs` / `-ff2.mjs` | the rendered sprite sheets |
| `tools/lib/romaji.mjs` | kana→Hepburn, a reading aid only (never a source of names) |
| `tools/ff2-script-dump.mjs` | FF2 raw script dump |
| `tools/check-ff12-text.mjs` | FF1/FF2 gate — 11 reverts tested, all fail |
| `docs/sprites/ff3-npc-catalog.png` | 88 FF3 sprites, labelled |
| `docs/sprites/ff1-npc-catalog.png` | 48 FF1 entries |
| `docs/sprites/ff2-npc-catalog.png` | 47 FF2 entries |
