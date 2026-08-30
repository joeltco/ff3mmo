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

> ⭐ **BOTH ARE NOW ACTED ON (v1.10.72).** This section said "recorded rather
> than acted on", and note 2 was RIGHT ALL ALONG — *"The NPC wearing Cid is id 31
> at (17,21)"*. It was later overruled by `npcId + 0x202`, which named that
> bundle's wearers "Sara" and "Desch", and Cid's label was deleted. A sprite
> match put it back: see **Cid** below.
>
> `0x01D910` is now RESERVED to `cid`; `0x01ED10` is reserved to `cid_ghost` and
> still banned for everyone else. Cid ships in the Kazus pub at map 12 (6,23) in
> two states.

---

## FF3 — the map NPC list, verified against the CPU

`src/map-loader.js#readNPCs` is **load-bearing** — the shipped game places NPCs
from it — and it had never been checked. Traced with
`tools/ff3-mapobj-trace.mjs` (warp while recording reads in banks 44/45):

```
3B/B310  LDA #$80 / STA $81      ; pointer base $8000
3B/B314  LDA $0784               ; the map's npcIdx
3B/B317  ASL A / BCC / INC $81   ; idx*2, carry -> the "+0x100" branch
3B/B31D  LDA ($80),Y             ; pointer LO
3B/B324  ORA #$80                ; force bit 7 of the HIGH byte
3B/B336  LDY #$00 / LDA ($8C),Y
3B/B33A  BEQ                     ; id == 0 is the ONLY terminator
3B/B342  ADC #$04                ; 4 bytes per record {id, x, y, flags}
```

Every assumption in `readNPCs` is one of those lines, and **this model held up**
— like FF1's, unlike FF2's. Map 7's pointer was read at file `0x5801a`, its
records at `0x58b01`, giving `(17,2,4,0xCB) (18,6,4,0xCA) (19,4,3,0xC8)` —
byte for byte what `loadMap` returns. `npcIdx` is map property byte 4, confirmed
on four maps by where the traced pointer landed.

> ⛔ **The 16-NPC cap is ours, not the game's.** The game's loop is unbounded and
> stops only on `id == 0`. The cap is safe only because the busiest map (69) has
> **12**. The gate asserts no map ever reaches 16.

> ⛔ **`hi | 0x80` is untestable here.** It faithfully mirrors `$B324 ORA #$80`,
> but every map's pointer high byte is already `0x8A`-`0x99`, so removing it
> changes nothing and **no revert test can catch it**. The gate asserts the
> *reason* instead — that no pointer lacks bit 7 — so it fires if that ever
> stops being true.

---

## FF3 — the record's 4th byte, and the visibility bitmap

Two fields that were shipped broken by being ignored. Both are MEASURED on
hardware, not inferred.

### The flags byte: movement is decoded, facing is NOT

The per-map entry is `{id, x, y, FLAGS}` — four bytes. The record handler
(bank `$3B`, `$B34E`) splits the last one:

```
LDA ($8C),Y            ; Y=3, the flags byte
AND #$F0               -> npc struct +1      MOVEMENT
ASL x4 / AND #$C0      -> ($8A),Y=5          bits 2-3
```

**MOVEMENT — high nibble `$00` roams, `$C0` holds its post.** Measured by
booting the field ROM, warping to Ur, walking the party 90 steps and counting
distinct tiles per NPC at `$7000 + slot*16` (+2/+3 = x/y):

| | |
|---|---|
| `$00` | `$06 $0a $0c $0d $0e $0f` — 15..27 tiles each |
| `$C0` | `$05 $07 $08 $09` — 1 tile each |

10 of 10. ⛔ **Idling proves nothing** — FF3 only steps NPCs while the party is
walking. A first attempt sat still for 1440 frames, saw nobody move, and would
have "proved" the opposite.

> ⛔ **BITS 2-3 ARE NOT FACING — they are the PALETTE SELECTOR.**
> `flame-sprites.js:92` reads exactly `((flags >> 2) & 3) >= 2 ? 1 : 0` to pick a
> torch palette. v1.10.76 shipped them as facing and standing NPCs faced wrong.
>
> The trap: that byte was verified to arrive at `$7100 + slot*16 + 5` as
> `value << 6` on **26 records across three maps**. A perfect score — which
> proves the number ARRIVES, not what it MEANS. The meaning was then taken from
> a comment. **Verifying transport is not verifying semantics.**
>
> What killed it (`facedir.cjs`): match an NPC's on-screen OAM tiles back to a
> 4-tile group of its own walk bundle and read the H-flip bit.
> `$05` (map 114, value 2) and `$1e` (map 10, value 1) BOTH draw RIGHT.
> Different values, identical facing.
>
> ⛔ A walk bundle holds **DOWN, UP, LEFT-f0, LEFT-f1** — only THREE directions.
> RIGHT is a mirrored LEFT, so a group index is not a facing index either.
>
> Facing is undecoded. It comes from the spec, hand-set per NPC.

`src/data/npc-flags.js` is Node-clean so the GATES run the same derivation the
game ships — they were auditing `e.spec`, which the player never sees.

### Whether a record is drawn at all: the visibility bitmap

Each record is gated by a **per-npc-id bitmap**, not by the flags byte and not
by the story flags at `$6020`:

```
addr = $6080 + (npcId >> 3)      bit = 1 << (npcId & 7)
$78 != 0  ->  addr += $20        ; the second bank at $60A0
```

Flag CLEAR → the id is overwritten with **0** and the record is not drawn
(bank `$3B` `$B51A`, called from the record handler). On a new game
`$6080..$60BF` is copied from a ROM table at **bank 0 `$B600` = file offset
`0x1610`**; live SRAM matches that table byte for byte, both banks.

Event opcodes: **`$F4 <npcId>` shows** an NPC, **`$F5 <npcId>` hides** one —
distinct from `$F2`/`$F3`, which set the story flags. Across all 512 scripts, 15
ids are ever shown and 54 ever hidden.

> ⛔ **On a fresh game the cartridge draws the CURSED cast.** Kazus and Castle
> Sasune are full of the Djinn's ghosts and the living villagers are switched
> off until the Sealed Cave falls. ff3mmo currently has this INVERTED — it shows
> 16 people the cartridge hides and hides 21 it shows. Unfixed; see the
> `project_ff3mmo_cursed_town_inversion` memory.

Read the cast the game actually draws with **`tools/monscan/npc-cast.cjs`**
(`ROM=` a field ROM, `MAPS=`), which reads the engine's own slot table at
`$7000` rather than re-deriving it. ⛔ The bitmap is SRAM — it only exists after
a real boot; warping a cold machine returns all zeros, which reads exactly like
"everyone is hidden".

### Cid

**Cid is npc `$1f`, sprite bundle `0x01D910`**, and he stands in the **Kazus pub
at map 12 (6,23)** — record `$2c`, cursed (`0x01ED10`, the Djinn's ghost) before
the Sealed Cave and himself after.

> ⛔ **NEVER identify a character from `npcId + 0x202`.** It is a description of
> the string table with a measured counterexample, not a derivation. It put
> Cid's *"I'm Cid from Canaan"* line on the **Castle Sasune gate guard**, and it
> named `0x01D910`'s wearers "Sara" and "Desch" — which is what got Cid's label
> deleted from `STORY_SPRITE_BUNDLES` in the first place.
>
> **Identify by PICTURE.** Shape-match a reference against the DOWN frame of all
> 88 bundles (`0x1C010 + gfx*0x100`, 4 tiles row-major, compare the transparency
> mask). Cid scored 90.2%, nine points clear of second place.
>
> ⚠ FF3 reuses walk sprites heavily — ids 31, 67, 192 and 217 all wear
> `0x01D910`. Only id 31 is the man himself, so `src/data/sprite-names.js` keys
> confirmed names on the **npc id**, never the bundle.

## FF3 — the dialogue table, decoded

Every NPC's line is its id, offset into the global string table:

```
stringId = npcId + 0x202
```

> ⛔ **This is a DESCRIPTION of what the table contains, not a derivation — and
> it has a measured exception.** `tools/ff3-talk-trace.mjs` followed the talk
> routine on the CPU:
>
> ```
> 3B/B6BF  LDX $71          ; the NPC's slot
> 3B/B6C1  LDA $0740,X      ; a PER-NPC dialogue byte held in RAM
> 3B/B6C4  STA $76          ; -> the string id LOW byte
> 3B/B6C6  LDA #$84         ; base $8400 -> string block 0x200
> 3B/B6CA  BEQ ; else LDA #$86   ; ...or $8600 -> block 0x300, when $78 is set
> 3F/EE9F  LDA $92 / ASL A / TAY / LDA ($94),Y     ; the pointer fetch
> ```
>
> The id is a RAM byte the engine **rewrites** — a talk queues its follow-on
> lines into `$0740` (Topapa's conversation loads 0x215, 0x216, 0x217 in
> sequence) — and there is a **second string block** at 0x300. No constant
> offset can be exact.
>
> `tools/ff3-talk-probe.mjs` measured **7 of 8** NPCs matching. The
> counterexample: **Ur's NPC at (10,28) is npcId 5**, so the rule says 0x207
> ("Where are you rugrats off to"), but the running game shows **0x206** ("Press
> the B Button to use an item") — and no Ur NPC has id 4, so the rule cannot
> produce it there.
>
> The offset is kept (it is right for the towns we ship, and it is what our
> content uses) but it is gated as approximate, with the counterexample pinned.

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
| **Sara** — King Sasune's daughter | 67 | ⛔ see below — id 67 is NOT her face |
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

### ⛔⛔ AND THE ROW ABOVE IS A TRAP — id 67 IS NOT SARA'S FACE (2026-08-28)

The `Sara -> id 67` row is a **dialogue** attribution: id 67 is the record whose
string identifies itself as Sara. It is NOT a sprite attribution, and it was used
as one. `gfxForNpcId(rom, 67)` is gfx 25 -> **`0x1D910`**, which is the bundle
ff3mmo dresses **Cid** in — so `SARA.romOffset` and `CID.romOffset` shipped as
the same value, byte for byte, and the princess wore the engineer's face.

**Sara is `0x1D810`.** Joel, looking at a render: *"thats not sara. thats cid"*,
then *"0x1D810 is sara"*. It is worn by ROM ids 57/61/65 and placed only on maps
104/105/106/178/182/253/255 — nowhere ff3mmo ships, so nobody here wears it but
her. Rendered four directions: `docs/sprites/sara-0x1D810.png`
(`node tools/sara-shot.mjs`).

⛔ **The id->gfx table was never going to know her.** It is PPU-verified and
correct; FF3 simply puts Sara on screen by EVENT SCRIPT rather than from the
static NPC list. Do NOT "restore" her to gfx 25 on the strength of that lookup.

⛔ **Do not answer a sprite question from a filtered sheet.** The search that
missed this drew only the 14 bundles the beginner valley loads — `0x1D810` is not
one of them, so the right answer had been excluded before the question was asked.
`tools/sara-candidates.mjs` draws all 32 real walk bundles; anything past
`0x1FF10` is off the end of the bank and renders as noise and font tiles.

Gated by **`check-story-sprites`**: two different NAMED characters may never share
a walk bundle. The ghost `0x1ED10` is an allowed exception — the cartridge
dresses every cursed id in gfx 45.

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

Map objects are **15 slots of 3 bytes** (type, X + flags, Y), stride 48:

```
map objects = 0x3410 + mapId * 48        (bank 0, $B400)
```

Re-derived from the CPU (v1.8.40), the same way FF2's was:

```
$E7F3  LDA #$0F / STA $1B      ; FIFTEEN slots
$E7FB  LDA $48 / ASL A x4      ; mapId * 16
$E80D  ASL $1C / ROL $1D       ; mapId * 32
$E812  ADC $1C                 ; 16x + 32x  =  mapId * 48
$E819  ADC #$B4                ; + $B400   =  file 0x3410
$E824  LDA ($1C),Y             ; the object TYPE
$E82C  ADC #$03                ; 3 bytes per entry
$E836  DEC $1B / BNE           ; exactly 15 — a zero is NOT a terminator
```

Unlike FF2's, **this model held up** — the check confirmed it rather than
overturning it. Cross-checked against the live object array at RAM `$6F00`:
Coneria Castle (map 8) matches the ROM in all 15 slots byte for byte, and map 24
differs only where a story NPC is conditionally not spawned.

**64 maps**, fixed two independent ways: every map 0-63 keeps its raw Y byte
inside the `#$3F` mask while **all** of 64-127 exceed it, and
`0x3410 + 64*48 = 0x4010` — exactly the end of bank 0.

> ⛔ 15 x 3 = 45 bytes but the stride is **48**. Bytes 45-47 of each map are
> **dead** — the loader never reaches them. Maps 28, 30 and 31 hold leftover
> object data there (all type 87), so reading 16 slots injects **3 phantom
> NPCs**. The gate asserts the count stays 3.

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

**Confirmed on the CPU** by `tools/ff1-talk-trace.mjs`:

```
$902B  LDA $6F00,X          ; the object TYPE (X = live object slot)
$9034  ASL A / ROL $15      ; type * 2, SIXTEEN-BIT (the table spans pages)
$9037  ASL A / ROL $15      ; type * 4
$903A  ADC #$D5 / LDA #$95  ; + $95D5  =  file 0x395E5
$9046  LDA ($14),Y ...      ; all FOUR record bytes -> $10 $11 $12 $13
$906C  LDA $90D3,Y / JMP ($0016)     ; a per-type CODE HANDLER
```

⛔ **FF1 has the same architecture as FF2** — a record plus a per-type code
handler — which nobody had noticed. The two handler shapes are what settle
"byte 1 is the default":

```
$941B  LDY $10 / JSR $9091 / BCS -> LDA $12 ; else LDA $11   (flag-gated)
$9492  LDA $11 / RTS                                          (unconditional)
```

So byte 0 is a story-flag id, byte 1 the default line and byte 2 the post-flag
line — an NPC's line is **state-dependent**, and only the no-flags one can be
resolved statically.

**The independent check**: the handler jump table (`0x390E3`) and the record
table (`0x395E5`) are separate data, yet every record's SHAPE matches what its
handler actually reads — **76/76** unconditional types carry no flag and no
after-line, **12/12** flag-gated ones carry both. Shift `DIALOGUE_TABLE` by one
record and every type pairs with the wrong handler.

**Measured on screen**: `tools/ff1-talk-probe.mjs` predicts the id in advance
and checks the box — 4 readings across 2 maps and 3 types, including
**objType 48 -> string 49**, which discriminates against the retracted rule.
The Coneria Castle guard displayed string 49, and type 32's record
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

Map objects are **12 slots of 3 bytes** (type, X + flags, Y) in **ONE table**,
indexed straight by map id — FF2 does *not* use FF1's `0x3410` (332 of 569
entries there give Y > 63):

```
map objects = 0x3510 + mapId * 36        (bank 0, $B500)
```

Confirmed from the CPU:

```
$9E15  ASL A / ASL A         ; mapId * 4
$9E1D  ASL A / ROL $81  x3   ; mapId * 32
$9E26  ADC $80               ; 32x + 4x  =  mapId * 36
$9E2A  LDA $81 / ADC #$B5    ; + $B500   =  file 0x3510
$9E30  LDY #$23              ; copy 36 bytes = 12 objects x 3
```

**401 objects across 60 populated maps.** Coordinates confirmed by *walking to
them* in the emulator and finding an NPC there.

> ⛔ **This replaces a two-block model that was wrong.** The catalog used to read
> `[{0x3510, 17}, {0x3990, 32}]`. There is no second block — `0x3990` is simply
> **map 32** (`0x3990 - 0x3510 = 32 x 36`). That model read maps 0-16 and 32-63
> and **skipped maps 17-31 entirely**: 79 objects, including **ヨーゼフ (Josef)**,
> a main character who was missing from the catalog. Corrected in v1.8.39, which
> took the named cast from 13 speakers to 18.

### The X/Y flag bits

```
X byte:  bits 6-7 = flags,  bits 0-5 = the X coordinate
Y byte:  bits 0-5 = the Y coordinate,  bits 6-7 DISCARDED
```

Read off the loader:

```
$E84D  LDA ($1C),Y / STA $16   ; the X byte, raw
$E851  AND #$C0 / STA ($1E),Y  ; object+1 = FLAGS (bits 6-7)
$E85C  AND #$3F / STA ($1E),Y  ; object+2 = X  (bits 0-5)
$E864  LDA $17 / AND #$3F      ; the Y byte -> object+3 and +5
```

> ⛔ **The Y byte has no flags.** Its top two bits are masked off and never
> stored. The old note said only that no object *sets* them — a fact about the
> data. This is a fact about the **code**: data could set them and nothing would
> happen.

**Bit 6** — measured at `$E51F`: `LDA $6F01,X / AND #$40 / ORA $6F0C,X / BEQ +`
then `RTS`. Set means the update routine returns early and the object skips that
work. "Does not move" is supported.

**Bit 7** — measured at `$E6D8`:

```
LDA $0D / AND #$01 / BEQ E6E5
LDA $6F01,X / BMI E6EA   ; $0D.0 set   + bit7 set   -> proceed
             / BPL E72C  ; $0D.0 set   + bit7 clear -> skip
LDA $6F01,X / BMI E72C   ; $0D.0 clear + bit7 set   -> skip
                         ; $0D.0 clear + bit7 clear -> proceed
```

The object is processed **only when bit 7 equals `$0D` bit 0** — a layer match
against a global player state.

> ⛔ **The field was called `inRoom`. That name is RETRACTED** (v1.8.43) — it
> was never derived from anything, and `tools/ff1-flag0d-probe.mjs` argues
> against it:
>
> - `$0D` bit 0 is **0 in every reachable state** — castle courtyard, castle
>   interior, overworld — so bit-7 objects are never processed there at all.
> - It does **not** flip while walking, and does **not** flip across a map
>   transition (overworld → Coneria Castle). "Inside a room" would have to.
> - It is not frame parity either: `$0D` reads 0 for 24 consecutive frames.
> - `$0D` is pushed/popped alongside `$48`, the map id (`$C95C`-`$C964` /
>   `$C991`-`$C998`); it is `ASL`'d at `$CE65`, `EOR #$84` at `$CE48`, cleared at
>   `$C20D`/`$C70E`/`$C903`, and written inside the PPU nametable routines. It
>   behaves like a **bitfield of engine state**, not a boolean.
>
> The field is now `altLayer`, named for the mechanism: the object belongs to the
> alternate layer selected by `$0D` bit 0. **What that layer is remains
> undetermined** — an open question, not a solved one.

Counts: **61 objects carry bit 7, 78 carry bit 6**, and **0 set Y high bits**.

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

### objType → dialogue — solved by disassembling the talk routine

```
record  = bank 14, pointer at file 0x38210 + objType*2      (24 bytes)
id      = record[0]
table   = objType < 0x60 ? 0x18010 (bank 6) : 0x28010 (bank 10)
          objType >= 0xC0 -> no handler at all
```

**How it was found.** `tools/ff2-talk-trace.mjs` hooks every cartridge read,
talks to Minwu, and catches the instruction that reads his string pointer.
Minwu displays string 49, whose pointer is at file `0x18072` = `$8062` with
bank 6 mapped — so the read is unmissable. It landed on the generic fetch
routine:

```
$EA8C  LDA $93 / JSR $FE03     ; switch to the string's PRG bank
       LDA $92 / ASL A         ; string id * 2
       ADC $94 / ... $95       ; + table base -> $80/$81
       LDA ($80),Y             ; <- the $8062 read.  $3E/$3F = string address
```

That is a *primitive*, not the mapping — so the question became "who writes
`$92`". Watching zero-page writes answered it in one run: `$CBD0 JSR $9794`
returns the id in A, and `$CBD3 STA $92` stores it.

```
$9794  LDA #$06 / STA $93          ; default bank 6
       LDA #$00 / STA $94
       LDA #$80 / STA $95          ; default table base $8000  -> file 0x18010
       LDA $7500,X                 ; the object TYPE (X = object slot)
       CMP #$C0 / BCS $97FE        ; >= 0xC0 -> RTS, no dialogue
       CMP #$60 / BCC +            ; >= 0x60 -> LDX #$0A / STX $93  (bank 10)
       ASL A / TAX                 ; type * 2
       LDA $8200,X / $8201,X       ; -> $84/$85, A POINTER PER OBJECT TYPE
       LDY #$17 / LDA ($84),Y / STA $7B00,Y   ; copy a 24-byte RECORD to $7B00
       LDA $A0 / ASL A / TAY
       LDA $9923,Y / $9924,Y / JMP ($0086)    ; per-type CODE handler
```

**Every object type has its own handler routine.** Minwu's, at `$9C82`:

```
$9C82  LDY #$50 / JSR $989E    ; test a story flag
       BNE (a different line)
       LDA $7B00               ; <- byte 0 of the record IS the string id
       RTS                     ; caller does STA $92
```

`CMP #$60 → bank 10` is why object types 97 and 99 read `0x28010` — the thing
that made "one dialogue table indexed by type" impossible in the first place.

> ⛔ **The default line only.** The handler swaps in other bytes of the record
> as story flags are set, so a late-game player sees something else. `record[0]`
> is what a fresh game shows and is all a static tool can report.

### How it was verified

`tools/ff2-talk-probe.mjs` walks to each NPC, talks, reads the box off the
nametable, finds that text in the ROM, and compares against what
`stringIdForType` **predicted in advance** — and exits non-zero on any mismatch:

| objType | who | predicted | on screen |
|---|---|---|---|
| 1 | ヒルダ (Hilda) | `0x18010[1]` | ✓ |
| 8 | ミンウ (Minwu) | `0x18010[49]` | ✓ — **the case that broke the old rule** |
| 97 | — | `0x28010[2]` | ✓ — the *other table* |
| 99 | — | `0x28010[4]` | ✓ |

**5/5 talked-to objects predicted correctly.**

An independent check the derivation cannot satisfy by construction: **a named
speaker must wear one sprite.** Nothing in the dialogue rule touches the sprite
table, yet ヒルダ (types 1, 4) is spr 20 in both, and ゴードン (types 13, 14) is
spr 16 in both — **3/3**. Under the retracted rule ヒルダ wore **seven**
different sprites and ゴードン four. The gate asserts this.

### ⛔ The retraction that led here

v1.8.26 shipped `dialogueId == objType` **as verified. It was false**, and it
failed exactly the way FF1's did: one coincidence read as a rule. Hilda is the
first NPC anyone talks to, she is object type 1, *and* she says string 1 — so
the first measurement always agrees.

**Rendering the sheet is what caught it.** Under that rule ten visibly different
sprites all came out "Hilda", and 44 of the 175 placed object types "spoke" lines
whose opening name insert was a *keyword* — ペンダント (pendant), めがみのベル
(goddess bell), エギルのたいまつ (Egil's torch), ひくうせん (airship), ミスリル
(mythril). Pendants do not talk. Under the real rule it is 17, and the speakers
are people.

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

> ⛔ A speaker is only `18 NN B9` at the very start (`NAME「`). Counting any
> mid-line insert as a speaker is how the retracted rule produced pendants and
> airships "talking".

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

## The three sheets

`docs/sprites/ff{1,2,3}-npc-sheet.png` — one cell per placed object type (FF1,
FF2) or NPC id (FF3): the four facings, the sprite it resolves to, the line it
gives, and where it stands. `--named` renders only the ones that name a speaker.

| game | placed | named | how a name is established |
|---|---|---|---|
| FF1 | 182 types | 5 | first person only — "I am X" / "My name is X" |
| FF2 | 175 types | 23 | `NAME「` in the opening-quote position |
| FF3 | 179 ids | 23 | self-identification (`selfName`) |

⛔ **Two caveats are printed on the sheets themselves**, because a sheet that
looks authoritative gets believed:

- **All three now use the real NPC palettes.** In every game an NPC's top half
  draws on sprite palette 2 and its bottom half on palette 3 (the player takes
  0/1). FF3's are resolved per map; FF1's and FF2's use the measured town/castle
  values because their per-map selector is not decoded — see below.
- **The line is the no-flag default.** All three games pick the actual line in a
  per-type code handler driven by story flags.

⛔ FF1's Bahamut (type 14) renders as noise: he is drawn larger than the standard
16x16 four-frame layout, so the table is right and the sprite simply is not a
normal NPC.

### FF3's NPC colours, decoded

```
top half    = the map's spritePalette7   (PPU sprite palette 3)
bottom half = the map's spritePalette6   (PPU sprite palette 2)
```

Both are indices into the shared palette library at `0x1110`/`0x1210`/`0x1310`
(entry `i` = colours 1, 2, 3; colour 0 is the backdrop), taken from bytes 8 and 9
of the map's own properties. `src/map-loader.js#buildSpritePalettes` already read
them; what was missing was the confirmation that this is what NPCs wear.

**Measured** by `tools/ff3-npc-palette.mjs` — warp in, read `$3F10-$3F1F` and
OAM, cluster the 8x8 sprites into 16x16 NPCs and take each cluster's palette
attribute. Result: **16/16 maps predicted exactly**, across **8 distinct**
palette-7 values.

> ⛔ **There is no per-NPC palette.** Every map NPC draws top-on-3 and
> bottom-on-2 with no per-NPC selection, so the colours are a property of the
> MAP. The competing reading — that `0x1110`/`0x1210`/`0x1310` are indexed by
> npcId — produces numbers that match nothing on screen (npcId 17 would give
> `1b 22 0c`; the PPU holds `0f 27 30`). An NPC standing on several maps really
> does change colour, and the sheet says which map it is showing.

The rendered sheet was checked pixel-by-pixel against the measurement: the cell
for Topapa contains exactly five colours — `0F` black, `12` blue and `36` pale
(the bottom palette), `27` gold and `30` white (the top) — and nothing else.

### FF1 and FF2 NPC colours

```
top half    = sprite palette 2
bottom half = sprite palette 3      (the player draws on 0 and 1)
```

**Measured** by `tools/nes12-npc-palette.mjs` two independent ways: by
y-coordinate off OAM (FF1 `(112,76)`=pal2 sits above `(112,84)`=pal3; FF2
`(80,92)`=pal2 above `(80,100)`=pal3), and in code — FF2's sprite layout tables
at `$B24F`/`$B25F` contain only attribute bytes `02`, `03` and `43` (= 3 plus
the horizontal-flip bit). That is why one flat palette looked plausible for so
long: the player really does use one pair and NPCs another.

### FF1: the map's palette set

```
set = $A000 + mapId * 48        (bank 0, file 0x2010 + mapId*0x30)
sprite palettes = set bytes 16..31;  NPC top = 24..27, bottom = 28..31
```

Traced end to end:

```
$CC49  LDA $48 / ASL A x4       ; $10/$11 = mapId * 16
$CC55  LDX $11                  ; save the HIGH byte of mapId*16
$CC57  ASL $10 / ROL $11        ; $10/$11 = mapId * 32
$CC5C  ADC $10 / TXA / ADC $11  ; 16x + 32x  =  mapId * 48
$CC63  ORA #$A0                 ; -> $A000 + mapId*48
$CC69  LDA ($10),Y / STA $0780,Y ; 0x30 bytes -> RAM
$D8AD  LDA $0780,X / STA $03C0,X ; 0x20 bytes -> the PPU buffer
$D880  LDA $03C0,X / STA $2007   ; re-uploaded EVERY FRAME
```

> ⛔ **`X` is not a palette selector.** It looked like one — the pointer reads as
> `$A000 + X*0x100 + mapId*16` — but `$CC55 LDX $11` is just saving the carry-high
> of `mapId*16` so the 16x and 32x halves can be summed. **The set index IS the
> map id.** Confirmed by capturing the pointer on two entries: map 8 → `$A180`,
> map 24 → `$A480`.

The table holds **40 valid 48-byte sets with 25 distinct NPC palette pairs**, and
maps 8 and 24 match the PPU byte for byte across all eight palettes. The FF1
sheet now draws every NPC in its map's real colours, pixel-verified: cell 0
(objType 1, first placed on map 24) contains only `0F`, `16`, `27` and `36`.

### FF2: three parallel colour tables

```
list = $A000 + mapId*16                     (bank 0, file 0x2010 + mapId*16)
palette(i) = [0x0F, T1[i], T2[i], T3[i]]    T1=$8E00  T2=$8E80  T3=$8F00
BG 0/1/2 = list[1..3]     NPC top = list[4]     NPC bottom = list[5]
```

```
$9D52  LDA $48 / LSR A x4 / ORA #$A0    ; -> $A000 + mapId*16
$9D3C  LDA ($80),Y / TAY                ; a palette INDEX
$9D3F  LDA $8E00,Y / $8E80,Y / $8F00,Y  ; three PARALLEL colour tables
```

**Exactly FF3's shape** — three parallel tables indexed by a per-map byte —
even though FF1, its closer sibling, uses flat 48-byte sets instead. Measured
against the live `$03C0` buffer in the Altair throne room (`$48 = 4`): **5/5
map-driven slots exact**.

> ⛔ BG palette 3 is the hardcoded menu palette (`$9D2E` writes `$03CD-$03CF`
> directly) and sprite palettes 0/1 are the **party's** — neither comes from the
> map, which is why a naive "the list feeds all eight slots" read is off by one
> and then diverges.

> Map ids are just map ids — see the single-table note above. The old
> `globalMapId` helper existed only to paper over the two-block model, and its
> guess (block 1 starts at 17) was wrong; `0x3990` is map 32.

### A name the sheet caught

Rendering FF3's sheet and reading it found two NPCs wrongly labelled **Sara**:
`"Princess Sara.You're safe."` is someone *greeting* her, and `"Princess Sara
wanted to see you guys"` is someone talking *about* her. A bare `Princess X`
pattern had matched both. The genuine narrator-label form always carries its
descriptive clause — *"Elder Topapa, **the man who** raised the four orphans"* —
so `selfName` now requires it. The gate pins three self-identifications and three
third-person mentions.

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
| `tools/npc-dialogue-ff2.mjs` | every FF2 object: position, sprite, string id, handler, line |
| `tools/ff2-talk-probe.mjs` | walks to an NPC, talks, and checks the rule's prediction against the screen |
| `tools/ff2-talk-trace.mjs` | hooks every cartridge read/zero-page write to find the talk routine |
| `tools/lib/nes-trace.mjs` | the shared read/write/PC tracer (and its three jsnes traps) |
| `tools/ff1-talk-trace.mjs` / `ff1-talk-probe.mjs` | FF1: find the rule, then predict-vs-screen |
| `tools/ff3-talk-trace.mjs` / `ff3-talk-probe.mjs` | FF3: find the rule, then predict-vs-screen |
| `tools/npc-sheet-ff1.mjs` / `-ff2.mjs` / `-ff3.mjs` | the rendered sprite sheets, `--named` for the cast |
| `tools/lib/romaji.mjs` | kana→Hepburn, a reading aid only (never a source of names) |
| `tools/ff2-script-dump.mjs` | FF2 raw script dump |
| `tools/check-ff12-text.mjs` | FF1/FF2 gate — 11 reverts tested, all fail |
| `docs/sprites/ff3-npc-catalog.png` | 88 FF3 sprites, labelled |
| `docs/sprites/ff1-npc-catalog.png` | 48 FF1 entries |
| `docs/sprites/ff2-npc-catalog.png` | 47 FF2 entries |
