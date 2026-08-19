# Vehicle system — plan

Status: **PROPOSED**. Nothing under `src/` yet. Scoped 2026-08-18.
⚠ §19 CORRECTS the vehicle NAMING in §12/§18 — identity is `$600B`, not the mode.
Phase 0 **LANDED AND BEHAVIOURALLY PROVEN** — §9 reads the routine off the ROM,
§10 proves it by patching the mask table. It CORRECTS §1: bit 3 is never tested,
bit 4 is the flight barrier, and there are EIGHT movement modes, not four.

Decisions taken (Joel, 2026-08-18):

- **Ownership: personal, per player.** Every player who unlocks a vehicle has
  their own. No shared hull, no server authority, no new wire shape.
- **Scope: all vehicles**, not a canoe-only slice.
- **Prove the ROM bits before building on them.** Phase 0 gates everything.
- **Launch animations are in scope** — Cid's airship out of the sand, the
  Invincible out of the water, the Enterprise transforming.

---

## 1. What the ROM already gives us

`src/world-map-loader.js#loadWorldTileProps` already reads all 128 metatile
property pairs from `TILE_PROPS = 0x000510`. `world-map-renderer.js#isPassable`
uses exactly two bits of them:

```js
if (props.byte1 & 0x80) return true;   // entrance trigger
if (props.byte1 & 0x01) return false;  // blocked on foot
return true;
```

**Bits 1, 2 and 3 are loaded and thrown away.** Measured on world 0, the low
nibble takes only five values, and each mode unlocks exactly one terrain class:

| nibble | terrain (rendered and eyeballed) | who may enter | tiles |
|---|---|---|---|
| `0110` | grass / desert / hills | foot, airship landing | 3344 |
| `1110` | forest | foot only | 717 |
| `1011` | ocean (wave texture) | ship only | 4548 |
| `1101` | shallow speckled water | canoe only | 75 |
| `1111` | mountains + deep-blue border void | nobody | 5583 |

A bit SET means that mode may not enter. Deep ocean at the map border is `1111`,
not `1011` — a ship cannot sail off the edge. That case could have contradicted
the reading and did not.

⚠ **This is measured correlation plus a visual render, NOT proof from the code
that reads the bits.** The four-bit STRUCTURE is solid; the assignment of
bit1/bit2/bit3 to canoe/ship/airship is inference. Phase 0 exists to settle it.

## 2. Modes are not vehicles

The game's own script rules out one-bit-per-vehicle:

| line | text |
|---|---|
| `0x08c` | Cid: *"turn the Enterprise into an airship. But, you can only land on water."* |
| `0x0dd` | Unei: *"The Great Ship can cross over mountains."* |
| `0x0e7` | Doga: *"The Nautilus can now travel underwater."* |
| `0x072` | Unei: *"The A Button can also boost the engine to fly the ship over mountains. The B Button will stop the ship."* |

So one vehicle changes mode mid-flight, landing legality is per-vehicle rather
than one shared bit, and submerge / fly-over-mountains are not expressible in the
4-bit table at all.

**The model is `{terrain bits} x {per-vehicle capability flags}`.**

| Vehicle | Base mode | Extra rule beyond the bits | Source |
|---|---|---|---|
| Canoe | bit1 (shallow) | — | `0x240`, King Sasune |
| Ship | bit2 (ocean) | — | map **180**, already built |
| Enterprise | bit2 | toggles to flight; lands on water ONLY | `0x08c` |
| Nautilus | bit2 | submerges | `0x0e7` |
| Invincible | flight | crosses mountains; boost / stop controls | map **95**, `0x072` |

## 3. Entrances

27 world entrances. Exactly two are vehicle interiors, both currently disabled in
`REMOVED_ENTRANCES` (`src/world-map-renderer.js`):

```
trig  1 -> map  95  at (82,54)   the Invincible
trig  0 -> map 180  at (90,59)   the ship
```

Map 180 is already built — a wooden vessel with a shop counter, barrels, a bed
and a below-decks section. It has no reachable exit because you are meant to
disembark. The other three vehicles arrive via events, not world tiles. The
script also references a hangar (`0x248`) and a Wrecked Ship map (`0x1ae`).

## 4. Multiplayer

Checked, and it is smaller than assumed. Players broadcast a coarse `loc` string
on a poll, sent only when it changes (`src/net.js#_startLocPoll`), and **no
remote player avatars are drawn on the overworld at all**. Under personal
ownership a vehicle is **local movement state plus a save field** — not a
networked entity. No new wire shape.

Vehicle state must still clear the 4-hop save lockstep gated by
`tools/check-save-lockstep.mjs`: `ps -> slot`, `slot -> payload`, server
validator, `payload -> ps`.

## 5. Phases

| Phase | Work | Blocks |
|---|---|---|
| **0** | Prove the bit assignment from the code that reads it. Also answers whether flight/submerge are separate bits or pure code paths, and whether encounters are terrain-keyed. | everything |
| **0.5** | fm2 replayer + reach-the-scene harness (see §6). | all launch animations |
| **1** | `isPassable(x, y, mode)`; vehicle state through the 4 save hops. One call site: `movement.js:95`. | 2+ |
| **2** | Canoe end-to-end — sprite, board/disembark, save. Smallest complete vehicle. | — |
| **3** | Ship; re-enable entrance to map 180. | — |
| **4** | Enterprise — the mode-toggle case that breaks a naive model. | — |
| **5** | Nautilus + Invincible — the two needing rules outside the table. | — |

Sprite capture runs alongside from Phase 2. **Vehicle sprite CHR offsets are not
identified yet.**

## 6. Launch animations

⛔ **Captured, never drawn.** Standing rule: real rips or refuse.

Extraction is solved — `tools/monscan/nes.cjs` gives savestates, framebuffer,
palette and nametable access, and `CAPTURED_SUMMONS` in
`src/data/summon-anim-captured.js` proves multi-frame cinematic sequences can be
stored (per-state tile layouts plus `holds[]` in ms).

**Reaching the scenes is the problem.** Each is behind real progression:

| Animation | Gate |
|---|---|
| Cid's airship out of the sand | after Kazus/Canaan, `0x232` — hidden in the west desert |
| Enterprise -> airship | Cid remodels with the Time Wheel, `0x08b`/`0x08c` |
| Nautilus submerges | Doga casts Aquario, `0x0e7` |
| Invincible out of the water | after Unei wakes, `0x094`/`0x0dd` |

Three routes, in order of preference:

1. **Replay a TAS to the right frame.** `tools/movies/` holds two fm2 movies and
   **both match the JP ROM**, verified by checksum:

   ```
   TAS romChecksum          45a7d02ed0dc92665a30da1d9b4af35d
   ff3-jp.nes (headerless)  45a7d02ed0dc92665a30da1d9b4af35d   OK
   FF3-English.nes          2e517105c0084e36a8e7d47f941a2c8c   NO
   ```

   The JP ROM is a valid capture source because vehicle art is
   language-independent. **No fm2 replayer exists in the repo** — that is the
   missing tool, and fm2 is per-frame button masks in text, so it is small.
2. **ROM-patch the progression flags** so a scene triggers from a fresh file —
   the `tools/monscan/build-capture-rom.cjs` precedent, and the standing rule
   that a game refusing the state a capture needs gets patched, not reported as
   blocked.
3. **Call the scene routine directly**, once the event system is disassembled.

Capture order: **Cid's airship (sand) first** — earliest gate, cheapest to reach,
and it settles the capture format for the rest.

### Risks

- ⚠ **The glitched TAS probably skips these.** It is a 40-minute glitched
  completion (142,871 frames); the point is not watching cutscenes. `naruko` is
  21,316 frames (~6 min), far too short for a playthrough. Route 1 may be dead on
  arrival, and that is unknown until a replayer exists.
- ⚠ **Format may not fit.** Every animation captured so far is OAM sprites over a
  static scene. A ship breaking the water surface is likely BG animation *plus*
  OAM, and the `screen-strip` / layout format may not express it. Answered on the
  first scene captured.
- ⚠ Launch animations are roughly a second project beside the vehicle system, not
  a trim on it. Phases 4-5 were already the expensive end; these make it heavier.

## 7. Open questions

- Are encounters terrain-keyed? **Unmeasured.** Swings sea-encounter work between
  trivial and its own arc. Answered in Phase 0.
- Where are the vehicle sprite CHR tiles? **Unidentified.**
- Do flight and submerge have their own tile bits elsewhere, or are they pure
  code paths? Answered in Phase 0.

## 8. Phase 0 attempt — 2026-08-18, NOT landed

The bit assignment is still **unproven**. What the attempt established, and where
it stopped:

**Settled**

- The props table really is INTERLEAVED PAIRS, not two 128-byte tables. Under the
  split reading, zero metatiles carry the trigger bit, so no town on the world map
  would be enterable. Under the interleaved reading there are 54 trigger tiles
  resolving to 27 distinct destinations, matching the entrance table exactly. A
  test that could have failed, and didn't.
- The tile-props and entrance tables are **byte-identical between the JP and
  English ROMs** (256/256 and 64/64), so a finding on either transfers.

**Ruled out**

- ⛔ **Static search cannot find the read.** There is no `LDA #$85 / STA zp`
  pointer setup anywhere in the ROM (the single hit builds a pointer to `$0185`,
  the stack page), and no absolute reference to `$8500`/`$8501`. The table is
  almost certainly COPIED TO RAM at map load, which makes this a dynamic problem.
- ⛔ **Neither TAS movie leaves Altar Cave.** Both were replayed with soft-reset
  handling correct (see below). `naruko` is 21,316 frames and stays in the cave;
  the glitched TAS runs 142,871 frames and also never leaves. Whether that is a
  residual desync (RAM init differs — `naruko` declares `RAMInitSeed 3814`) or the
  movie genuinely exploiting in place is **unresolved**. Route 1 of §6 is not
  currently delivering.
- ⛔ **The world map is not reachable through the `$0700` warp.** Warping to ids
  0-17 from a clean field state loads interiors (id 10 is Kazus) and the screen
  genuinely changes, but walking out of a warped-in town reverts to Altar Cave —
  `$0700` is a warp REQUEST register, not the live map state. The world map is a
  separate mode whose flag has not been located.

**Traps hit, both now guarded in code**

1. **The fm2 command column is not decoration.** Both movies soft-reset within the
   first ten frames (the glitched one twice more, ~39005 and ~39670). The first
   replayer ignored `cmd`, so both replays desynced from frame 6 — and a desynced
   FF3 still renders a party walking around a cave, which reads as success. Fixed
   with `cpu.requestIrq(IRQ_RESET)` (RAM intact), NOT `nes.reset()` (rebuilds the
   CPU/PPU/mapper and wipes RAM to `0xFF`).
2. **"Warp accepted" was meaningless.** The engine rewrites `$AB` every frame a
   menu or dialogue is open, so the flag clears without any map load. A sweep
   returned "accepted" for all 8 map ids while rendering the same battle screen
   every time. The cause was upstream: `bootToWorld`'s flee loop can fail
   indefinitely, leaving the harness in a battle. Fixed by
   `tools/monscan/build-field-rom.cjs` — every encounter becomes one 1-HP harmless
   goblin, so the fight ends on the first hit (measured: sprites 48 -> 4, `$AB`
   back to 0, warps then actually change the screen).

**The next concrete step**

Find the exit-to-world routine statically. `EXIT_X_TABLE = 0x000890` and
`EXIT_Y_TABLE = 0x0008D0` are in bank 0, so they appear at CPU `$8880`/`$88C0`.
Code reading that range IS the return-to-world path, and it will lead to both the
world-map mode flag and, from there, the props read. That search has NOT been run.

## 9. Phase 0 — LANDED. The routine, read off the ROM.

Reached the world map by ROM patch (§8's dead ends stand; the way in was
`world-sfx-sweep.cjs`'s SPAWN trick — copy map 115's props over all 512 slots
with the entrance moved to (16,25), one tile above Altar Cave's exit at (16,26),
combined with the 1-HP goblin so the intro battle ends). **The props table is
copied to RAM at `$0400`** — full 256-byte match, which is why no static search
for `$8500` could ever have found the read.

Hooking reads of `$0400-$04FF` while walking gives four PCs, two of them hot
(135 reads each). The routine is in the fixed bank at **`$C69B`**:

```
C69D  B1 80     LDA ($80),Y     ; metatile id of the target tile
C69F  0A        ASL A           ; *2  <-- interleaved PAIRS, confirmed by the code
C6A0  AA        TAX
C6A1  BD 00 04  LDA $0400,X     ; byte1
C6A4  85 44     STA $44
C6A6  BD 01 04  LDA $0401,X     ; byte2
C6A9  85 45     STA $45
C6AB  A4 42     LDY $42         ; <-- THE MOVEMENT MODE
C6AD  B9 CD C6  LDA $C6CD,Y     ; <-- mask table, indexed by mode
C6B0  25 44     AND $44
C6B2  D9 CD C6  CMP $C6CD,Y     ; blocked iff EVERY mask bit is set
C6B5  D0 1E     BNE $C6D5
C6B7  38        SEC
C6B8  60        RTS             ; blocked
```

**The mask table at `$C6CD` is eight bytes:**

    mode   0     1     2     3     4     5     6     7
    mask  $01   $03   $02   $04   $10   $10   $10   $10
    bits  b0   b0+b1  b1    b2    b4    b4    b4    b4

Cross-checked against every terrain class on world 0 (`X` = blocked):

| class | byte1 vals | tiles | m0 | m1 | m2 | m3 | m4-7 |
|---|---|---|---|---|---|---|---|
| grass / desert / hills | `$46 $06` | 3679 | . | . | X | X | . |
| forest | `$6e $2e $0e` | 814 | . | . | X | X | . |
| ocean | `$6b` | 4548 | X | X | X | . | . |
| shallow | `$6d` | 75 | X | . | . | X | . |
| mountain + void | `$1f $0f $2f` | 7214 | X | X | X | X | mixed |

- **mode 0** = on foot. Land and forest only.
- **mode 1** = land + forest + shallow water. This is the **canoe**, and it is
  gated by TWO bits together (`b0+b1`) — no one-bit-per-vehicle model predicts it.
- **mode 2** = shallow water ONLY.
- **mode 3** = ocean ONLY. This is the **ship**.
- **modes 4-7** = everything except the **1122 tiles carrying bit 4**. Four
  distinct FLYING modes sharing one terrain mask, differing in rules elsewhere —
  exactly the `{terrain bits} x {per-vehicle flags}` model in §2.

Flying also suppresses entrances: at `$C6B9`, when the mode is >= 4 the code does
`AND #$7F` on byte1, clearing the trigger bit, so an airship cannot walk into a
town.

### What this CORRECTS in §1

- ⛔ **bit 3 is NEVER tested by this routine**, though 12,702 tiles carry it. The
  §1 reading of "bit3 = airship landing" was **wrong**.
- ⛔ **bit 4 was missed entirely** and is the real flight barrier.
- ⛔ **There are 8 modes, not 4.**
- ✅ Confirmed: interleaved pairs (the `ASL A`), bit 0 = foot, bit 2 = ship.
- ⚠ Partly right: bit 1 does gate the canoe, but as `b0+b1`, not alone.

### Still open

`LDA #imm / STA $42` appears at 10 sites setting modes 0, 1, 2, 5, 6 and 7
(3 and 4 are computed, not immediate). Mapping each site to a NAMED vehicle —
and identifying what mode 2 is — is not done. The passability STRUCTURE is now
proven; the vehicle-to-mode naming is not.

## 10. Mask table proven by patching it — and the harness that got there

### The proof

Per-step testing failed five times (see "What did NOT work" below), so the mask
table is proven a different way: **change one byte and watch reachability change
exactly as the table says it must.** The check is `AND mask ; CMP mask`, i.e.
blocked iff every mask bit is set in byte1, so `mask[0]` fully controls on-foot
movement. Starting the party on a land tile that touches ocean:

| `mask[0]` | terrain the party stood on, 120 steps | expected | result |
|---|---|---|---|
| `$01` (stock) | land 120, **ocean 0** | a walker can never stand on water | ✅ |
| `$80` | mtn 113, land 5, **ocean 2** | bit 7 is the trigger bit, so almost nothing blocks | ✅ |
| `$00` | frozen — 1 class, 120 steps | `AND $00 == $00`, everything blocks | ✅ |

Reproducible: `node tools/monscan/mask-table-proof.cjs`. This is the
revert-proves-the-gate pattern: the stock table FORBIDS water and the patched one
PERMITS it, so the table is demonstrably what gates movement.

### The harness

`tools/monscan/world-harness.cjs` (NEW) boots FF3 headless straight onto the
world map and self-verifies by checking that the world tile-property table is
live at `$0400` — it throws rather than hand back a machine sitting somewhere
else. Options: `worldX`/`worldY` (position), `vehicle`, `maskTable`.

Placement and vehicle are pinned by rewriting the three absolute loads at `$C0CD`
as `LDA #imm ; NOP`. Those loads read **battery-backed save RAM**, so position
and vehicle are SAVE fields:

    $6009 -> $27   world X
    $600A -> $28   world Y
    $600F -> $46 and $42   THE VEHICLE

### Vehicles are real, and the engine normalises them

`tools/monscan/vehicle-art.cjs` (NEW) captures each vehicle sprite off the PPU.
Distinct craft, all genuine rips:

| `$42` | OAM tiles | sprites | appearance |
|---|---|---|---|
| 0 | `$00-$03` | 4 | walking party |
| 2 | `$28-$2b` | 4 | small gold canoe |
| 3 | `$58-$5b` | 4 | white/gold rounded vessel |
| 5, 6 | `$7c-$7f` | 4 | masted sailing ship |
| 7 | `$c6-$d5` | **14** | large ornate golden craft (the Invincible) |

⭐ **Forcing `$42` alone does NOT change the sprite** — `$46` drives sprite
selection, and both come from `$600F`.

⭐ **The engine normalises the requested vehicle against the terrain you start
on.** Asking for a boat while standing on grass silently yields mode 0; modes 5
and 6 persist on ocean and shallow but revert to 0 on land, forest and mountain.
Mode 7 persisted everywhere tested (220/220). Any probe that sets a vehicle must
therefore READ BACK `$42` rather than trust the request.

### Vehicles are granted by EVENT COMMANDS

Bank 59 `$8157` is a `CMP #$xx / BNE` dispatcher on an event opcode:

    cmd $0A -> mode 6      cmd $0B -> mode 7
    cmd $0F -> mode 1      cmd $0E -> mode 0 (dismount; also records a return
                                   position to $6005/$6006 and sets $6004 = 1)

Modes 2, 3, 4 and 5 are set elsewhere (`LDA #imm / STA $42` appears at 10 sites
in total). Naming each mode to a STORY vehicle means resolving which event script
issues which command — `tools/event-resolve.mjs` is the way in. **NOT DONE.**

### What did NOT work — do not repeat

- ⛔ **jsnes `save()`/`load()` breaks movement.** A restored machine never moves
  again, no matter how long it settles. Trials cannot be isolated by restoring an
  anchor; every probe must boot fresh or walk continuously.
- ⛔ **Per-step prediction testing is too noisy to trust.** Runs reported 76-81%
  "agreement" that was instrument error, including impossible outcomes such as a
  walker crossing mountains. Causes: position read while still mid-move, a single
  press crossing several tiles, and the first press only TURNING the party.
- ⛔ **Writing `$27`/`$28` directly** holds the value but freezes the party — the
  engine keeps its own position/scroll state alongside them.
- ⛔ **The `0x890`/`0x8D0` exit tables do not drive the landing spot.**
- ⛔ **Walking into a map transition crashes the emulator** with an invalid
  opcode. Long walks need the `$0400` world-map check between steps.

## 11. How vehicles are granted — and a launch animation found in code

### Event opcodes $C0-$CF

Bank 59 `$812B` handles event opcodes `$C0-$CF` (`LDA $70 / CMP #$C0 / CMP #$D0`,
then `AND #$0F` to get the sub-command). Four of them set the vehicle:

    $CA -> mode 6      $CB -> mode 7      $CF -> mode 1
    $CE -> mode 0 (dismount; also records a return position to $6005/$6006
                   and sets $6004 = 1)

Scanning all 512 script-table entries, **exactly three scripts carry a vehicle
opcode**:

| script | ops | grants |
|---|---|---|
| #91 `$AC2A` | `$C1 $C1 $C7 $FC.20 $C9 $F8.BE $C2 $FC.10 $CE $FD` | dismount |
| #146 `$B6AA` | `$F0.00 $E2 $E2 $F8.B3 $CF $FD` | mode 1 |
| #163 `$BACC` | `$F0.00 $CB $FD` | mode 7 |

Resolving every map's event tiles (0-255) on a fresh save reaches only the
dismount, on **map 180 — the ship**. Scripts #146 and #163 sit behind later story
conditions, so naming them needs condition-aware resolution. **NOT DONE.**

### Modes 2 and 5 are not event-granted

- **Mode 2 is a TRANSFORMATION.** At `$C5F6`: `LDA $42 / CMP #$03 / BNE` then
  `LDA #$02 / STA $42`, guarded above by `LDA $44 / LSR / LSR / BCS` — a test of
  tile bit 1. So a mode-3 craft standing on the right water becomes mode 2. This
  is the shape the `{terrain} x {per-vehicle flags}` model predicted: one vehicle
  changing mode in place.
- **Mode 5 is granted at the END OF AN ANIMATION.** Bank 59 `$88A9`:

```
88AC  LDA #$6F / STA $62          ; start Y = $6F
88B0  JSR $A85A / $A842 / $A8EB   ; per-frame work
88B9  LDA $62 / STA $41           ; Y
88BD  LDA #$70 / STA $40          ; X = $70, fixed
88C1  LDA #$68 / JSR $A956        ; draw
88C6  INC $BC
88C8  LDA $F0 / AND #$03 / BNE $88B0   ; advance every 4th frame
88CE  DEC $62                     ; RISE one pixel
88D2  CMP #$60 / BCS $88B0        ; until Y = $60  -> 16 px over ~64 frames
88D6  LDA #$02 / STA $33
88DA  LDA #$05 / STA $42 / STA $46     ; ...now aboard vehicle 5
88E0  LDA #$01 / STA $6000 ; $00 -> $6003   ; story flags
```

⚠ **Status: read from the disassembly, NOT run.** What is proven by the code is
that something is drawn each pass at a fixed X while its Y decreases from `$6F`
to `$60`, one pixel per four frames, and that `$42`/`$46` become 5 afterwards.
`JSR $A956` builds a pointer (`$54`/`$55`) into a table at `$87xx` from the index
in A and jumps to `$87CD`, which is consistent with a draw call but has not been
traced to actual pixels.

That shape — an object RISING, then the party aboard a vehicle — is what a launch
animation looks like, so this is the strongest §6 lead found. But it has not been
executed or captured, and which story vehicle it belongs to is **not established**
(mode 5's sprite is the masted sailing ship). Do not treat it as "the Cid's
airship scene" until it has been triggered and watched.

Capturing it still needs the scene reached. With `world-harness.cjs` the party
can be put anywhere on the world map in any vehicle, but this sequence runs from
an event, so the remaining work is to trigger it — either by condition-patching
the script that calls it or by jumping the routine directly.

## 12. Naming the modes

Three new pieces of evidence made this possible: the **auto-disembark** routine,
the **per-vehicle music table**, and the sprites from §10.

### Auto-disembark — `$C5B5`

    C5B5  LDA $44 / LSR A / BCC $C5BB   ; tile bit0 CLEAR = walkable on foot
    C5BA  RTS                           ; otherwise stay aboard
    C5CB  LDA $42 / LDX #$00
    C5CF  STX $46 / STX $42             ; ZERO the vehicle
    C5D8  CMP #$03 / BEQ $C59E          ; was it vehicle 3?
    C59E  ...$6001 = X+7, $6002 = Y+7, $6003 = $78   ; record where it was left

**Stepping onto any foot-walkable tile puts you out of the vehicle**, and vehicle
3 *specifically* records a parking spot. That is what normalised every probe:
the exit walk out of Altar Cave crosses land, so a pinned vehicle is dropped
before the party ever reaches water.

⭐ Consequence for `world-harness.cjs`: to keep a vehicle you must land on water
and never touch a walkable tile.

### Vehicle music table — bank 59 `$A027`

`$A006` indexes it by `$78` and `$46` and writes `$7F43`, the song register:

| `$46` | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| track (`$78`=0) | `$1e` | `$08` | `$1e` | `$22` | `$0a` | `$0a` | `$0a` | `$23` |

Modes 4/5/6 SHARE a theme. Mode 7 has its own. Mode 2 plays the walking theme.
(`$78` selects a row — the `$78`=4 row gives modes 3-7 five *different* tracks,
so themes vary by world.)

### The naming

| mode | name | confidence | evidence |
|---|---|---|---|
| 0 | **on foot** | certain | mask bit 0; walking sprite; overworld theme `$1e` |
| 1 | **canoe (carried)** | high | mask `b0+b1` = land + forest + **shallow** — walk normally, enter rivers, which is exactly a portable canoe. Own theme `$08`. The only mode-1 grant in the game, script #146 via opcode `$CF` |
| 2 | **canoe (afloat)** | high | shallow-water ONLY; small gold canoe sprite; plays the WALKING theme, so it is not a separate vehicle; reached only by transformation at `$C5ED`-`$C5FE` on a bit-1 tile |
| 3 | **ship** | high | ocean only; own theme `$22`; **the only vehicle whose disembark records a mooring position** — you park it at a dock |
| 4 | **the Enterprise, flying** | high | §13 — same craft as mode 3; collapses to 3 over water; matches "can only land on water" (`0x08c`) |
| 5 | **Cid's airship** | high | §18 — granted by the SAND LAUNCH (seq 0), which rises out of the desert where `0x232` says Cid's airship is hidden |
| 6 | **DEAD CODE — never granted** | high | §15 — no script issues `$CA`; fully implemented but unreachable |
| 7 | **the Invincible** | high | flies; the ONLY flyer with its own theme `$23`; **14 sprites vs 4** for everything else — much the largest craft; granted by `$CB` via script #163. The script calls it "the Great Ship... Invincible" (`0x0de`) |

⛔ **Still open: which airship is 4 vs 5 vs 6.** They are indistinguishable by
terrain mask and share a music track; 5 and 6 share a sprite. Separating them
needs the story conditions on their grant scripts resolved, which is the same
work §11 left open. Do not guess: FF3 has Cid's airship, the Enterprise and the
Enterprise-as-airship, and nothing measured so far distinguishes them.

## 13. Airships 4 vs 5 vs 6

### Mode 4 is the AIRSHIP FORM OF THE MODE-3 CRAFT — resolved

Three independent lines agree:

1. **The parked-vehicle draw at `$DAD8` skips when `$42` is 3 OR 4.** A routine
   that draws "your vehicle sitting out there" suppresses itself while you are
   aboard — suppressing on *both* values means 3 and 4 are ONE craft. It also
   reads one owned-flag (`$6000`) and one position pair (`$6001`/`$6002`) for
   both, and draws them with the same sprite `$50`.
2. **Booting vehicle 4 yields `$42` = 3** — measured, on land AND on open ocean.
   Mode 4 collapses into mode 3 the moment it is over water; modes 5, 6 and 7 do
   not convert at all under the same test.
3. That is exactly `0x08c` — *"Press the A Button to turn the Enterprise into an
   airship. But, you can only land on water."* A craft that is a ship, becomes an
   airship, and can only set down on water.

So **mode 3 = that craft as a ship, mode 4 = the same craft flying.** Since the
mode-3/4 pair is the only vessel in the game that is both, it is the Enterprise.

### Modes 5 and 6 — separated mechanically, NOT named

They are not distinguishable by terrain (identical mask `$10`) or by sprite
(both draw `$7c-$7f` in flight and `$68` parked). What does differ:

| | mode 5 | mode 6 |
|---|---|---|
| story flag | `$6020` **bit 0** | `$6020` **bit 6** |
| parked-draw world check | **none** | requires `$6003 == $78` |
| flag ever cleared? | **yes** — bank 58 `$9ACC` clears bit 0, forces `$42`/`$46` to 0 and sets `$602F` bit 6 | not found |
| music when `$78`=4 | `$09` (same as mode 4) | `$15` (differs) |

Neither converts on water, so unlike mode 4 these do **not** land on water.

**Why I am not naming them.** ⚠ **The flag discriminator above is weaker than it
looks** — §14 decoded the flag system and the answer is not what this section
implied. `$6020` bit 0 is **flag id 0, set by script 48, which is the game's
OPENING sequence** ("We've fallen down a hole"), so it is a general world-state
flag, not an airship-acquisition flag; the mode-5 draw is effectively gated on
`$6000` (a vehicle is placed). And `$6020` bit 6 is **flag id 6, which NO script
sets, clears or tests** — the mode-6 draw block is gated on a flag nothing in the
event system ever writes.

So the flags do not encode which airship is which. The tempting move is to map
"the one that gets taken away" to Cid's airship and the other to a later one; FF3
does have Cid's airship, the Enterprise and a mythril-ram upgrade, and a plausible
story could be told for either assignment. That is exactly the guess that would
later get quoted back as measured.

**What would settle it:** decode the event opcode that writes story flags, find
the scripts that set `$6020` bit 0 and bit 6, and read the dialogue attached to
them. Same missing piece as §11 and §12 — the flag/condition encoding.

## 14. The event flag encoding — DECODED and verified live

### The encoding

A story flag is **one byte, id 0-127**, in battery-backed save RAM:

    address = $6020 + (id >> 3)        bit = 1 << (id & 7)

so ids 0-127 occupy `$6020`-`$602F`. **Two independent implementations in the ROM
agree on this for all 128 ids**, which is the cross-check:

- the CONDITION evaluator computes it arithmetically, bank `$3C` `$9344`:
  `AND #$7F / AND #$07 / TAY / LDA $935A,Y` (mask table `01 02 04 08 10 20 40 80`)
  then `PLA / LSR A x3 / TAY / LDA $6020,Y / AND $80`;
- the SETTER looks it up, bank 59 `$B983`: `LDA $BBD2,Y` (mask), `LDA $BCD2,Y`
  (byte offset), `ORA` / `STA $6020,Y`. Clear is the same at `$B999` with `EOR #$FF`.

### Condition records — bank `$3C` `$931B`

A record is condition bytes until `$FF`, then one RESULT byte (the script index).
**Bit 7 of a condition byte is POLARITY**: set = "this flag must be SET", clear =
"must be CLEAR". Low 7 bits are the flag id. Every condition in a record must
hold or the record is skipped and the next is tried.

### Event opcodes — jump table bank 59 `$B617`, opcode = `$E4 + index`

| opcode | meaning |
|---|---|
| `$F0` | show NPC dialogue by slot (`$0740,X`) |
| `$F1` | show message by id |
| `$F2` | **SET FLAG** (operand = flag id) |
| `$F3` | **CLEAR FLAG** |
| `$F8` | sound / music (writes `$7F42`, `$7F43`) |
| `$F9` | exit to world |
| `$FA` | go to map |
| `$FE` wait, `$FF` / `$FD` end | |

⛔ This corrects an earlier reading: `$F1`/`$F2` are message and set-flag, **not**
"call script". Operands that happened to equal a script index were coincidence.
`$F8` is music, so operands that looked like dialogue ids were song numbers.

### Verified live

Booting the real ROM and watching SRAM writes, the flags set during the opening
are **126, 44, 0 in that order** — exactly the `$F2` operands of script 48, at the
predicted addresses and bits. Final state `$6020 = $01`, `$6025 = $10`. (Flag 126
is cleared again later, so only the transition log shows it.)

⚠ The live test must NOT use `world-harness.cjs`'s ROM: that copies map 115's
props over all 512 maps **including byte 15, the event-table index**, so no map's
real events fire and zero flags are written. Use a goblin-only patch.

### The tool

`tools/event-flags.mjs` decodes an id, cross-checks the ROM tables, and indexes
every flag by which scripts set/clear it and which map events test it.
**106 of 128 flags are referenced somewhere.**

    node tools/event-flags.mjs        # summary
    node tools/event-flags.mjs 6      # everything about flag 6

### What it says about the airships

| flag | set by | cleared by | tested by conditions |
|---|---|---|---|
| 0 (mode 5 gate) | script 48 — **the opening** | script 17 | **0** |
| 6 (mode 6 gate) | **NONE** | none | **0** |

Both are read only by native code (`$DB09`, `$DB2F`), never by the event system.
**Flag 6 is never written by anything**, so the mode-6 parked-draw is gated on a
flag nothing sets. That is why §13's flag evidence does not name 5 vs 6 — and it
raises a new question worth chasing: whether mode 6 is reachable at all.

## 15. Is mode 6 reachable? NO — it is dead code

Four independent lines, all pointing the same way.

**1. No script issues `$CA`.** Sweeping all 1024 script-table slots (423 hold
valid pointers; the first invalid is slot 254, and a condition RESULT is a single
byte so only slots 0-255 can ever be selected):

| opcode | sets | scripts issuing it |
|---|---|---|
| `$CA` | mode 6 | **NONE** |
| `$CB` | mode 7 | 163 |
| `$CE` | dismount | 91 |
| `$CF` | mode 1 | 146 |

**2. A byte census rules out a parser artifact.** My script parser could in
principle misalign and hide a `$CA`. Of the 7 bytes equal to `$CA` in the script
data bank, **0 are parsed as an opcode**; 1 sits in an operand slot (the
interpreter never executes operand bytes — length rules read from `$D257`) and 6
are in regions no script reaches at all. Control: `$CB`, which we know IS
reachable, shows exactly **1 as an opcode** — so the census can detect a
reachable vehicle opcode when one exists.

**3. The only native write of 6 is the `$CA` handler itself.** Sweeping every
`LDA/LDX/LDY #imm` followed by a store to `$42`/`$46`, the sole source of the
value 6 is bank 59 `$8171` — the `$CA` branch of the `$C0-$CF` dispatcher.

**4. The save cannot smuggle it in.** `$600F` restores the vehicle at boot
(`$C0D7`), but `$600F` is written FROM `$42` by the save routine at bank 61
`$8E61`. For a save to contain 6, `$42` must already have been 6, which requires
`$CA`. Circular.

And the flag that gates its parked-vehicle drawing, `$6020` bit 6 = flag id 6, is
**set, cleared and tested by nothing** (§14).

### It is fully built, just never switched on

Mode 6 is not broken or half-written — forcing it produces a working vehicle:

- a mask-table entry (`$10`, flight) at `$C6CD`+6;
- an in-flight sprite (`$7c-$7f`, same as mode 5) and a parked sprite (`$68`);
- music — `$0a` normally, and `$15` when `$78`=4, where it is the ONE airship
  whose theme differs from modes 4 and 5;
- its own parked-vehicle draw block at `$DB2F`, with a world check
  (`$6003 == $78`) that mode 5's block does not have;
- a handler in the event dispatcher, waiting for an opcode no script sends.

Measured: booting with vehicle 6 on open ocean keeps `$42` = 6 and renders it.

### What this means for §13

The 4-vs-5-vs-6 question was malformed. There are **two** reachable airships in
this ROM — mode 4 (the Enterprise flying, §13) and mode 5 — plus mode 7, the
Invincible. Mode 6 is a third airship that was implemented and then cut, or was
staged for content that did not ship. Naming it against a story vehicle is not
merely unproven, it may be meaningless.

⭐ For the vehicle system: **do not build mode 6 in.** Wiring a vehicle the
original never grants would be inventing a system, not porting one.

## 16. Launch animations — mechanism decoded, motion captured, ART NOT captured

### The mechanism

Event opcode **`$EF` starts a CUTSCENE SEQUENCE by id**. Handler bank 59 `$B6B4`:
`LDA #$00 / STA $BC / STA $F0 / LDA $71 / JMP $A4FA`, and `$A4FA` is a `CMP`
chain dispatching **ids 0-13**. Sequence 0 lands on `$A8A9` — the same bank-59
offset as `$88A9` seen through the `$8000` window (§11).

Each link has exactly ONE caller: `$A4FA` only from the `$EF` handler, `$A8A9`
only from the id-0 branch.

### Census of all 14 sequences

Run by rewriting the opening script's tail to `EF <id> FF`, watching the draw
coordinates `$40`/`$41` and the vehicle `$42`:

| seq | motion | grants | notes |
|---|---|---|---|
| **0** | yes | **vehicle 5** | X fixed `$70`, Y `$6F`->`$60` — a straight RISE |
| **9** | yes | **vehicle 7 — the Invincible** | X `$97`->`$80`, Y `$82`->`$77` — a DIAGONAL approach |
| 2, 3, 4, 10, 11, 12, 13 | yes | — | other cutscenes |
| 1, 5, 6, 7, 8 | static | — | |

⭐ **Sequence 9 is the Invincible's launch and it IS script-invoked** — script 162
issues `$EF 09`, and script 163 (`$F0.00 $CB $FD`) grants mode 7. So the Invincible
launch is reachable in the shipped game.

⛔ **Sequence 0 is invoked by NO script.** All 256 scripts were swept for `$EF`;
ids 1-13 are used, 0 is not. Combined with the single-caller chain above, the
vehicle-5 rising animation is unreachable in the shipped game — the same status as
mode 6 (§15).

### What was actually captured

Both were run live and their trajectories recorded frame by frame. Sequence 0's
measured Y is `$6F, $6E, $6D, ... , $60`, one pixel per four frames at fixed X
`$70` — **exactly** what §11 predicted from the disassembly, which is a live
confirmation of that reading.

⛔ **The ART is NOT valid and must not be used.** FF3 is CHR-RAM: sprite tiles are
decompressed per context. These captures trigger the sequence from the OPENING
script, which runs inside Altar Cave, where the vehicle's tiles are not loaded.
The pixels that come out are whatever text/UI tiles occupy those slots — visibly
garbage (letters appear inside the "craft"). Motion right, art wrong.

`tools/monscan/launch-capture.cjs` (NEW) does the capture:
`SEQ=9 WANT=7 node tools/monscan/launch-capture.cjs sheet.png strip.png`.

### The remaining work — RESOLVED for sequence 9, see §17

⚠ Cid's-airship-out-of-the-sand and the Enterprise transformation are NOT among
the vehicle-granting sequences found. Sequence 0 grants vehicle 5 and is dead;
mode 4 (the Enterprise flying) is reached by transformation, not by a cutscene.
Whether a sand-launch animation exists in this ROM at all is **unanswered**.

## 17. Sequence 9 CAPTURED — the Invincible launch

### The exit-to-world was the whole trick

Script 162 is the game's own invocation, and its prelude is:

    $f0.1 $d0 $fe.3 $c9 $cd  $f9.19  $f8.31 $fc.80  $ef.9 ...
                            ^^^^^^^ EXIT TO WORLD, *then* the sequence

`$F9` exits to the world map **before** `$EF 09` runs. That is the entire reason
§16's capture produced garbage: FF3 is CHR-RAM, the opening script executes inside
Altar Cave, and the craft's tiles are not resident there. Doing what script 162
does — exit first — loads the right CHR.

Neither script 162 nor 163 is referenced by any map event tile, so the trigger
could not be reached the normal way. Instead the opening script's tail is
overwritten with the same prelude: `f2 2c f2 00 ff` is exactly 5 bytes, and so is
**`f9 19 ef 09 ff`** — a straight swap with no reflow.

### What was captured

- **All 340 buffered frames report ON THE WORLD MAP**, checked against the live
  world tile-property table at `$0400` — not assumed.
- Trajectory **X `$97`->`$80`, Y `$82`->`$77`**, one step per four frames: a
  diagonal approach, not sequence 0's straight rise.
- The craft draws from **40 OAM sprites**, tiles `$b7-$bb` and `$e2-$fb`, and
  **two tile sets alternate between frames** — the craft is itself animated.
- Those tiles have **zero overlap** with mode 7's in-flight sprite
  (`$c6-$cd`, `$d0-$d5`): the cutscene uses a dedicated, much larger sprite.

`docs/sprites/ff3-invincible-launch.png` is the sprite rebuilt from OAM + pattern
table + sprite palettes on a flat ground — a real rip, no background, two
animation frames. A three-masted golden vessel, matching "the Great Ship...
Invincible" (`0x0de`).

`tools/monscan/launch-capture.cjs` reproduces it end to end.

### Still open

- **Sequence 0** (the vehicle-5 rise) remains uncaptured as ART. Its context is
  unknown because **no script invokes it** (§16), so there is no prelude to copy.
  It is dead code, so there may be no correct context at all.
- Cid's-airship-out-of-the-sand and the Enterprise transformation are still not
  located as sequences; mode 4 is reached by transformation, not a cutscene.
- The `$f9.19` operand (`$19`) is the exit destination script 162 uses; capturing
  from a different world position would mean changing it.

## 18. The sand launch EXISTS — sequence 0, and it names mode 5

Joel: *"it's an event that happens in the desert west of Kazus after talking to Cid."*
That located it.

### The desert is real, and map 180 is not what the repo says

Kazus is world map 10 at **(93,59)**. Three tiles west, at **(90,59)**, trigId 0
leads to **map 180**. The tiles either side of it — (89,59) and (91,59) — are
metatile `$2`, which the class render (§1) shows is the **sand/desert** tile.

⛔ **This corrects a comment in `src/world-map-renderer.js`**, which calls map 180
"the ship... a wooden vessel on open water". It is not on open water: it sits in
the desert three tiles west of Kazus, exactly where the script says Cid's airship
is hidden (`0x232`, *"My airship's hidden in the west desert"*). **Map 180 is
Cid's airship.**

### The animation

**Sequence 0 is the sand launch.** Captured on the world map using the §17
exit-to-world prelude (`f9 19 ef 00 ff`):

- the craft rises **straight up**, X pinned at `$70`, Y `$6F` -> `$60`, one pixel
  per four frames — a vertical launch, unlike the Invincible's diagonal approach;
- it is drawn from **14 OAM sprites**: the vessel in tiles `$7c-$7f` **alternating
  with `$78-$7b`** — two animation frames — plus `$94-$97` and `$fe`/`$ff`, which
  are the **dust plume** billowing beneath it;
- it ends by setting the vehicle to **5**.

`docs/sprites/ff3-cid-airship-sand-launch.png` is the rip: a masted vessel lifting
out of a cloud of scattered particles, two animation frames.

⭐ **This names mode 5: Cid's airship.** §12 left it as "airship, unnamed"; the
launch that grants it rises out of the sand at the spot the script says Cid's
airship is buried.

### What this corrects

- ⛔ v1.9.24 said "whether a sand-launch animation exists in this ROM is
  unanswered". **It exists**, and it is complete — dust plume, two-frame craft
  animation, vertical rise.
- ⚠ v1.9.23/24 called sequence 0 "dead code". That was based on **no script
  issuing `$EF 00`**, which is still true and still verified. But a fully animated
  launch with its own particle effect is not plausibly unused, so the honest
  reading is that **the invocation path has not been found**, not that none
  exists. `$A4FA` has one caller (the `$EF` handler) and `$A8A9` one caller (the
  id-0 branch), so if the game reaches it, it is by a route outside the script
  table — that is now the open question.

## 19. CORRECTION — vehicle IDENTITY is `$600B`, not the movement mode

Joel pushed back on "cut content". The orphaning is real, but the conclusion I
drew from it was wrong, and the reason is a variable I had been collapsing.

### `$600B` is the vehicle; `$42`/`$46` is only a movement STATE

Event opcode **`$EE`** (`$B6A6`: `LDA $71 / STA $600B`) sets **which vehicle
exists in the world**. Eight are granted, each by its own script:

| `$600B` | script | messages | sets flag |
|---|---|---|---|
| 1 | 120 | 2 | 67 |
| 2 | 51 | 15 | 19 |
| 3 | 124 | 166,167,168 | 126,1,2,3 |
| 4 | 136 | — | — |
| 5 | 150 | 237,238,239 | 51 |
| 6 | 83 | 50-54 | 52 |
| 7 | 84 | 55-58,226 | 72 |
| 8 | 161 | — | 57 |

**Not one of them invokes a sequence.** Vehicle grants are dialogue plus `$EE`;
they never play a launch cutscene.

Boarding is a position test, not an identity: `$C633` compares the party position
against the parked vehicle at `$6001`/`$6002` and on a match sets `$46`/`$47` = **3**
regardless of which vehicle it is. The craft's identity comes from `$600B`; the
mode then changes by transformation (3 -> 2 on shallow water at `$C5FC`, 3 <-> 4
for the flying form).

### What this corrects

- ⛔ **§12/§18's naming is unsound.** Modes were named by which cutscene granted
  them, but cutscenes do not grant vehicles — `$EE` does. "Mode 5 = Cid's airship"
  rested on seq 0, which is exactly the orphaned content. Modes 0-7 are movement
  states; the eight VEHICLES are `$600B` 1-8 and are not yet mapped to names.
- ⛔ **§15's "mode 6 is dead code" needs the same caveat.** It is true that no
  script issues `$CA`, but since boarding sets the mode directly and vehicles
  transform between modes, "no script sets this mode" was never the right test for
  whether a vehicle is reachable.
- ✅ **The orphaning itself stands.** Script bodies tile the bank almost perfectly
  — 230 of 247 consecutive pairs end exactly where the next begins, zero overlaps,
  only 7 gaps in 254 slots — so an unreferenced 12-byte block is meaningful, not
  normal slack. `$A568` (`f8 bd | ef 00 | c8 | f8 0a | f8 a5 | f2 3f | ff`) is
  genuinely unreachable: a RESULT byte indexes the slot table, and no slot holds
  `$A568`.

### So what is actually cut

**The sand-launch CUTSCENE, not the airship.** Cid's airship is granted normally
by one of the `$EE` scripts with dialogue. What no longer runs is the animated
rise out of the sand — the animation is intact and plays correctly when invoked
(§18 captured it), but nothing points at the script that would start it.

### Next

Map `$600B` 1-8 to names via each grant script's dialogue. That needs the `$F1`
message-id banking resolved (`$B6CE`: `$95` = `$84` or `$86` depending on `$78`),
which is not yet done. **Do not name vehicles from cutscenes again.**

## 20. The eight vehicles — one named, seven not

### The grant table (all verified)

Every `$EE` in the game, each script confirmed to carry exactly one:

| `$600B` | script | `$F1` message operands | sets flag | referencing maps |
|---|---|---|---|---|
| 1 | 120 | 2 | 67 | (none found) |
| **2** | **51** | **15 (`0x00F`)** | **19** | **10/t0 — KAZUS** + 7 others |
| 3 | 124 | 166,167,168 | 1,2,3 | (none found) |
| 4 | 136 | — | — | (none found) |
| 5 | 150 | 237,238,239 | 51 | (none found) |
| 6 | 83 | 50-54 | 52 | 69,90,91,149,166,167,173,256 |
| 7 | 84 | 55-58,226 | 72 | 69,90,91,149,166,167,256,313 |
| 8 | 161 | — | 57 | (none found) |

### `$600B` = 2 is CID'S AIRSHIP — solid

Triangulated three ways:

1. **Map**: script 51 is reached from **map 10 = Kazus**, trigId 0, on conditions
   `SET 18, CLR 19`, and the script sets flag 19 so it fires once.
2. **Dialogue**: its `$f1.f` is message `0x00F` — *"Cid: Yeah. I knew you could do
   it. **You'll make great use of my airship.** But first, Mrs. Cid's been waiting
   for me in Canaan. Take me back."*
3. **Joel's own account**: "an event that happens... after talking to Cid in Kazus."

The script in full: `... $f1.f  $ee.2  $cc $f8.2c $fc.c0 $f8.7e  $f2.13  $f5.1f $ff`
— message, **grant**, music, set-flag-19, end. ⭐ **No sequence opcode**, which is
the point: the grant plays dialogue and music, never an animation. The orphaned
block at `$A568` (§19) is the launch cutscene that is missing from it.

### The other seven are NOT named — and here is exactly why

`$F1` takes a ONE-BYTE operand; the message id is completed by a bank in `$95`,
which `$B6CE` sets to **`$84` when `$78` == 0 and `$86` otherwise**. `$78` is the
world (from save byte `$6008`), so the same operand decodes to two different
strings depending on where the script runs, and **both readings are usually
internally coherent**:

| script | as bank `$84` | as bank `$86` |
|---|---|---|
| 51 | `0x00F` Cid's airship ✅ | `0x20F` "Kazus is a town south of here" |
| 83 | `0x32-36` Saronia thugs / Prince Alus | `0x232-36` Cid, Nelv rock, **mythril ram on the airship** |
| 84 | `0x37-3a` Doga's manor | `0x237-3a` Takka, the Djinn's curse, **a magical folding canoe** |
| 150 | `0x0ed-ef` Aria, Temple of Water | `0x2ed-ef` "Status restored / Revived" |

For script 51 the `$84` reading is clearly right. For 83 and 84 **both** readings
are coherent scenes, so coherence cannot arbitrate — and the `$86` readings are
the ones that mention an airship and a canoe, which is exactly the kind of
suggestive-but-circular evidence that produced the naming error retracted in §19.

⛔ **Not guessed at.** Resolving this needs `$78` determined per calling context,
which means finishing the `$76`/`$92` -> `$EC8B` message path. Until then the
roster is: **`$600B` 2 = Cid's airship**, and seven vehicles with known grant
scripts, flags and dialogue operands but no confirmed names.

## 21. Message banking — the rule is confirmed, the CONTEXT is not. Naming still open.

### What is now certain

The banking rule is read directly from `$B6C6`-`$B6CE` and is not in doubt:

    B6C6  LDA #$84
    B6C8  LDX $78
    B6CA  BEQ $B6CE
    B6CC  LDA #$86
    B6CE  STA $95        ; $95 = $84 when $78 == 0, else $86

And **`$78` is the WORLD index, not a constant**. It is restored at boot from save
byte `$6008` (`$C0DE`), and story events change it — bank 59 `$95F9` does
`LDA #$3 / STA $78`. The vehicle music table (§12) is indexed by it over rows
0..5, so it spans at least six values.

**Consequence: a script's messages decode differently depending on WHEN in the
story it runs.** The id is not a property of the script alone. That is the whole
difficulty, and it is why the two readings in §20 were both coherent.

### One case pinned empirically

Running script 51's message operand through the real ROM, **`$78` measured 0**,
which selects bank `$84` -> id `0x00F` -> *"Cid: ...You'll make great use of my
airship."* So `$600B` = 2 = Cid's airship is confirmed by the rule as well as by
map and dialogue. That case is closed.

### What blocked the rest

To decode scripts 83, 84, 120, 124, 136, 150 and 161 I need `$78` **at the moment
each one runs**. Two attempts failed:

- ⛔ **Static tracing of `$92`/`$95` does not converge.** Both are general-purpose
  zero-page temporaries reused across many banks — `$95` alone has 60+ readers,
  most of them unrelated. There is no single message-fetch site to disassemble.
- ⛔ **Reading the rendered text off the screen did not work** — but §22 shows the
  reason I gave here was WRONG. The nametable was never the problem.

### The next thing to try

Find which nametable the message box actually writes to, then re-run the §21
capture: patch the opening tail to `F1 <operand> FF`, render, read the text back,
and compare against `decodeString(rom, op)` versus `decodeString(rom, 0x200+op)`.
That calibrates the rule per context without needing to reach the real events.

⛔ **Until then the other seven vehicles stay unnamed.** The `$86` readings for
scripts 83 and 84 mention an airship and a canoe and are tempting; picking them
because they mention vehicles is the same circular reasoning retracted in §19.

## 22. Which nametable? `$2000` — and that was never the blocker

Hooking `ppu.vramWrite` and bucketing every VRAM write while the patched script
tail runs:

    $2000 : 7551 writes
    $2400 : 1532 writes

**The message box writes to nametable `$2000`** — which is exactly where the §21
screen reader was already looking. Text extraction works too: the hook recovered
`"Guard"`, `"Item"`, `"Goblin"`, `"xHit"`, `"Enemy defeated"`, `"received"`,
`"Cap"` by decoding written values through the ROM's own glyph table.

⛔ **So §21's diagnosis was wrong.** I said the dialogue box "does not appear in
nametable 0". It does. The real problem is that **no dialogue renders at all** in
this harness run — every captured string is battle text. The opening script's own
messages (6, 7, 8) never appear either, with the tail patched to
`fc 40 f1 <op> ff` (mirroring script 51's own `$fc.40 $f1.f` shape, so the box
setup is not the missing piece).

The party is cycling through encounters and the field dialogue state is never
reached, even though the tail itself demonstrably executes — §16-§18 triggered
sequences from that exact patch point and they ran.

### What that means for the naming

The blocker is **not** decoding and **not** the nametable. It is that the harness
never puts the game in a state where a message displays. Options, in order of
promise:

1. **Hook the string-pointer read instead of the screen.** The pointer table is at
   file `0x30010` = bank 24, CPU `$8000`, so string id N's pointer is at
   `$8000 + N*2`. Hook `cpu.load`, confirm bank 24 is mapped by comparing memory
   against ROM, and recover **the id directly** — no banking math, no rendering
   required. This sidesteps the display problem entirely.
2. Reach a real field state (suppress encounters outright rather than making them
   1-HP) so dialogue can actually run.

⛔ Still unnamed: `$600B` 1, 3, 4, 5, 6, 7, 8.

## 23. The string-pointer hook works — one direction measured, naming still short

### The instrument

`tools/monscan/string-id-hook.cjs` (NEW). The global 2-byte string-pointer table
is at file `0x30010` = bank 24, CPU `$8000`, so id N's pointer sits at
`$8000 + N*2`. Hook `cpu.load`, confirm bank 24 is genuinely mapped there by
comparing live memory against the ROM at several offsets, and **the address is the
id**. No banking arithmetic, no `$78`, no rendering.

With the opening script's tail patched to `fc 40 f1 0f ff` it reports exactly what
the game resolved:

    0x000  The Gulgan spoke faintly...        <- the opening's own messages
    0x006  We've fallen down a hole...
    0x007  Is everyone okay...
    0x008  Those monsters!...
    0x121-0x123  New Game / Battle Speed      <- title screen
    0x00f  Cid: ...You'll make great use of my airship.   <- OUR OPERAND

**`0x00F` read, `0x20F` never.** So for `$78` == 0 the id is the operand
unchanged — measured, not inferred. `$600B` = 2 = **Cid's airship** now rests on
three independent legs: the Kazus map reference, the dialogue, and this.

### What is still missing

⚠ **The `$78` != 0 direction is NOT confirmed.** Pinning `$78` to 1 makes the
script take a different branch — the hook starts reporting map-name strings such
as `0x1BB` "Ancients' Maze" — and the message is never reached, so the test does
not falsify the rule. The rule itself is not in doubt (it is four instructions at
`$B6C6`), but I have observed only half of it firing.

⛔ **And the hook does not by itself name the other seven.** It reports the id a
script resolves *in the context it is run in*. Running a grant script's operands
from the opening gives `$78` == 0 and therefore the bank-`$84` reading — which is
not evidence about what that script resolves to **when the game actually reaches
it**. The open question is unchanged and now precisely stated:

> **What is `$78` at the moment each grant script runs?**

The honest next step is to reach one grant script in its real story position — by
patching the condition records so a reachable event resolves to it *after* the
world has advanced — and read the id off this hook. Coherence arguments are not a
substitute: script 83's operands read as a single Saronia scene under `$84` and as
a mixed Cid/"beautiful face" jumble under `$86`, which argues for `$84`, but that
is the same shape of reasoning already retracted twice in this document.

⛔ Still unnamed: `$600B` 1, 3, 4, 5, 6, 7, 8.

## 24. Running a grant script in an advanced world — DOES NOT WORK by pinning `$78`

### The new instrument

`tools/monscan/run-script.cjs` (NEW) runs **any** script by repointing slot 48 —
the opening, which always runs — at the target's body, then reads the ids off the
§23 hook. No need to reach the real trigger.

### What it measured

**Script 83 under `$78` = 0: operands 50/51/52 resolve to `0x32`/`0x33`/`0x34`** —
the Saronia thug scene, the bank-`$84` reading. NOT the Cid/mythril-ram strings at
`0x232`+. That is a measurement of what the ROM actually resolved, and it is the
opposite of the reading that "mentions an airship" — exactly why the coherence
argument was refused in §20-§23.

### Why the request could not be completed

Pinning the world at boot (rewriting `LDA $6008` at `$C0DE` to an immediate) **does
take effect** — `$78` reads back correctly and map naming changes, with strings
like `0x183` "Amur" and `0x1BB` "Ancients' Maze" appearing. But under `$78` = 1, 2
or 3 the script **never reaches its messages at all**: every operand reports
"neither" candidate.

The world byte alone is not a game state. A save also carries map, position, party
and the story flags the scripts branch on, and with only `$78` moved the boot path
diverges long before the script's dialogue. So **"patch the conditions so a grant
script runs after the world advances" cannot be done by pinning `$78`** — it needs
a coherent late-game save.

### A lead investigated and ruled out

Map property **byte 13** takes exactly `$84` (259 maps), `$85` (201), `$86` (52) —
precisely the message-bank range, which looked like a per-map text bank and would
have settled everything. It is not: `$078C`/`$078D` are loaded as a POINTER pair at
bank 58 `$9356` with `ORA #$20`, giving `$A4xx`/`$A5xx`/`$A6xx`. The numeric
coincidence is just that.

### Where this leaves the naming

⛔ `$600B` 1, 3, 4, 5, 6, 7, 8 still unnamed. What is now needed is concrete and
narrow: **a coherent save state at each grant's story position.** Options, in
order: construct one by setting world + map + position + the flags each grant's
conditions test (all of which §14's decode makes addressable); or obtain a real
late-game save. Neither TAS in `tools/movies/` helps — both stay in Altar Cave.

## 25. Animation coverage — 2 captured, and most vehicles have none

### The sequence census is now COMPLETE (0-14)

§16 tested 0-13; sequence 14 (invoked by script 158) was missed and has now been
run: **static, no vehicle**. So across every sequence the dispatcher can reach:

| sequence | animates | grants a vehicle | captured |
|---|---|---|---|
| **0** | yes — vertical rise + dust plume | vehicle 5 | ✅ `docs/sprites/ff3-cid-airship-sand-launch.png` |
| **9** | yes — diagonal approach | vehicle 7 | ✅ `docs/sprites/ff3-invincible-launch.png` |
| 2,3,4,10,11,12,13 | yes | no | n/a — not vehicle scenes |
| 1,5,6,7,8,14 | static | no | n/a |

**Only two sequences in the game animate a vehicle, and both are captured.**

### But that is 2 launches, not 8 vehicles

There are **eight** vehicles (`$600B` 1-8, §19). Their grant scripts — 120, 51,
124, 136, 150, 83, 84, 161 — were each checked and **not one contains a sequence
opcode**. So most vehicles are handed over with dialogue and music only:
**they have no launch animation to capture.** Nothing is missing for them.

⚠ And of the two that exist, sequence 0's is **orphaned** (§19): no script invokes
it, so the sand launch does not play in the shipped game even though the animation
is intact.

### What is genuinely NOT captured

- ✅ **Parked art — ripped in §26. But the premise here was wrong**: there is no
  per-VEHICLE sprite set. See §26.
- ⚠ **`vehicle-art.png` is per-MOVEMENT-MODE, not per-vehicle.** It captured modes
  0, 2, 3, 5, 6, 7; modes 1 and 4 normalise away (1 -> 0, 4 -> 3) so they have no
  distinct capture. Since §19 established identity lives in `$600B`, that sheet is
  a mode sheet — useful, but it is not "the eight vehicles".

## 26. Parked vehicle art — ripped, and `$DC1A` is not what I said

### The correction

`$DC1A` is **not a sprite table**. It is 16 bytes of LAYOUT/facing offsets —
`00 00 10 00 30 00 10 00 20 00 10 00 30 00 10 00` — indexed by `$A7`, OR'd into
`$80`, and used as an offset into the metasprite tables at `$DC6A`/`$DCAA`
(`$DA07`/`$DA19` build the pointer: `$80 + $AA`/`$6A`, high byte `$DC`).

**The tile base is hard-coded per DRAW BLOCK, not per vehicle**, and `$600B` only
selects a layout when it equals 4 (`$DB73`). So there are **two** distinct parked
craft, not eight. My §25 claim of "a per-VEHICLE sprite set, none of it ripped"
was wrong on the first half.

### The rip

`docs/sprites/ff3-parked-vehicles.png`, via
`tools/monscan/parked-vehicle-art.cjs` (NEW). Two craft, measured:

| block | gates | craft tiles |
|---|---|---|
| `$DAD8` | `$6000`, `$6003`==`$78`, `$42` not in {3,4} | `$60-$63` — a small angled sailing vessel, white sails, gold hull |
| `$DB2F` | `$6020` bit 6, `$6003`==`$78`, `$42` != 6 | `$78-$7b` — a larger front-on ship, white with a gold deck |

`$600B` = 4 swaps a secondary element from `$18-$1b` to `$10-$13`, consistent with
the `$30` layout offset, but does not change the craft.

### Traps that cost two runs

- ⚠ **`$6020` = `$FF` fires every draw block at once.** The blocks then overlap and
  every `$600B` value renders identically — which is what "all eight are the same"
  actually meant the first time.
- ⚠ **`$DAD8` cannot be isolated by flags** — it has no flag gate and draws
  whenever `$6000` != 0. `$DB2F` does not check `$6000`, so clearing `$6000` is the
  way to leave only it.
- ⚠ The world map SCROLLS, so the party is not at a fixed screen position; select
  the craft by clustering OAM and dropping the party's walk tiles (`$00-$03`),
  not by a screen-x threshold.

## 27. Ship -> airship transformation — ⛔ THIS SECTION'S HEADLINE IS RETRACTED, see §28

## 27 (retracted). Ship -> airship transformation: there is no animation, and mode 4 looks unreachable

### No transformation animation exists

Three facts already established close this without new work:

1. **`$A4FA` has exactly ONE caller** — the `$EF` opcode handler (§16). No native
   code can start a sequence, so a transformation triggered by a button press
   cannot play one.
2. **The sequence census 0-14 is complete** (§25) and only sequences **0** and
   **9** animate a vehicle. Neither is a transformation — 0 is the vertical sand
   launch, 9 the Invincible's diagonal approach.
3. **No grant script contains a sequence opcode** (§19).

The one transformation that demonstrably exists in code, `$C5F6` (`if $42 == 3 and
the tile's bit 1 is clear -> $42 = 2`), is an instant state change. It calls
nothing.

So **there is no ship-to-airship transformation animation to capture.** Nothing is
missing; the game does not have one.

### And mode 4 appears unreachable

Searching every immediate store to `$42`/`$46` across the ROM: **no instruction
ever writes the value 4 to either.** Mode 4 can therefore only arrive via
`$600F` at boot (`$C0D7`) — and `$600F` is written FROM `$42` by the save routine
(bank 61 `$8E61`), so it is the same circular path that rules out mode 6 (§15).

⚠ **This undermines §13's "mode 4 = the Enterprise flying".** That rested on two
observations: the parked-draw at `$DAD8` suppressing on `$42` being 3 **or** 4, and
booting `vehicle` = 4 yielding `$42` = 3. The second is now better explained as
mode 4 not being a valid runtime state at all — it normalises away, exactly like a
mode nothing sets. The `$DAD8` suppression shows the code ANTICIPATES mode 4, not
that the game enters it.

§19 already retracted mode-based vehicle naming; this is a second, independent
reason not to trust "mode 4 = the Enterprise". Whatever the Enterprise's airship
form is, it is not demonstrably mode 4.

### What that leaves

The dialogue at `0x08c` is unambiguous that the Enterprise transforms
(*"Press the A Button to turn the Enterprise into an airship"*), so the capability
exists in the fiction. What is NOT established is which runtime state it produces,
and there is no animation attached to it either way.

## 28. RETRACTION — "there is no transformation animation" was bad reasoning

Joel: *"yes there is one.... wtf?"* He is right and §27 is wrong.

### The error

§27 argued: `$A4FA` has one caller, so no native code can start a **sequence**;
the sequence census is complete; therefore **no animation exists**.

That last step does not follow. **A sequence is one animation mechanism, not the
only one.** The two launches happen to use `$EF` sequences, and I generalised from
that to "animation == sequence" without ever checking for animation code that does
not go through the dispatcher.

Native animation code plainly exists. Bank 59 has counter-driven loops of exactly
the shape the launches use, e.g. at `$8683`:

    8683  STA $BC                              ; counter = 0
    8685  JSR $A870 / $A734 / $A7E2 / $C021    ; per-frame work
    8691  LDA $F0 / AND #$03 / BNE $8685       ; advance every 4th frame
    8697  INC $BC
    869B  CMP #$40 / BCC $8685                 ; 64 steps
    86A3  LDA #$07 / STA $42 / STA $46         ; then the vehicle changes

and `$86AF` picks a draw frame from `$BC >> 3 & 7` — eight frames. Another loop of
the same shape sits at `$866A`.

### What I checked afterwards, and what it does not settle

- `$866A` is sequence 9's dispatch target (`$A66A`), so that particular loop is
  the Invincible approach already captured in §17. It is not a second animation.
- The one transform I can find in code, `$C5DE`, is gated on `$602E` bit 0 and on
  the tile's bit 1 being CLEAR (shallow water). Tested both on open ocean and,
  after re-boarding in memory, on shallow water with `$602E` = `$FF`: **`$42` stayed
  3 and no transform fired**. So either its trigger needs more state than I set, or
  it is not the ship->airship transform.

### Standing position

⛔ **I have not located or captured the ship->airship transformation.** I should not
have claimed it does not exist — that claim rested on the sequence/animation
conflation above, and it is withdrawn. `$602E` bits are vehicle UPGRADE flags (set
by sequences 6/7/8 via `ORA #$04`/`#$08`/`#$10` at `$A54B`/`$A561`/`$A577`), which
is very likely the gating for the transform, and is where I would look next.

⚠ §27's other claim — that no instruction stores the immediate 4 to `$42`/`$46` —
is a separate measurement and still stands on its own. But it should not be read as
evidence about the transformation, given the reasoning error above.

## 29. The transformation animation FOUND — script 180, the Time Wheel remodel

Joel: *"it's when Cid remodels the Enterprise with the Time Wheel."* That located it.

### It is script 180

Messages `0x08b` and `0x08c` are the remodel, and exactly one script shows them:

    $e7.9c  $f1.8b  $59 $68 $60 $62 $62 $61 $62 $fe.3 $fc.10 $69 $fc.80
    $f8.32  $fc.80 $f8.7e  $68 $63 $fe.3 $61 $63 $63 $60 $fc.10 $69 $58
    $f1.8c  $f8.17 $fc.c0 $f8.7e  $f2.4  $ff

- `$e7.9c` — **consume item `$9C`, the Time Wheel** (`$E7` -> `$B673`, which
  decrements `$60E0,X` and clears `$60C0,X`). Without it in the bag the script
  aborts on its first opcode.
- `$f1.8b` — *"Cid: The Time Wheel. I can remodel the Enterprise now."*
- **the run of single-byte opcodes `$58`-`$69` interleaved with `$fe` waits IS the
  animation** — scripted inline, frame by frame.
- `$f1.8c` — *"Done. Press the A Button to turn the Enterprise into an airship."*
- `$f2.4` — sets flag 4, the capability the A-press then checks.

⭐ **This is the mechanism §28 said I had missed.** Opcodes below `$C0` do not go
through the `$B617` jump table at all — bank 59 `$812B` sends them to **`$ACD1`**,
a dispatcher I had never looked at. So FF3 has (at least) three animation
mechanisms: `$EF` sequences, native counter loops, and inline low-opcode
choreography. I had only ever examined the first.

### Confirmed running, and where it stops

Repointing slot 48 at script 180 and granting the Time Wheel, the string-pointer
hook shows **operand 139 resolving to `0x08b`** — the script really executes. But
**operand 140 never resolves**: it halts between the two messages, i.e. *inside the
animation*.

That is the expected failure. The `$58`-`$69` opcodes choreograph actors — Cid, the
Enterprise — that exist on the remodel's own map and not in Altar Cave, so the
animation blocks waiting for something that is not there. Same class of problem as
the launch captures needing the world map loaded (§17).

### What capturing it needs

Script 180 is **not referenced by any map event tile** — it is reached by the NPC
path (talking to Cid), the same unmapped route as scripts 162/163 (§20). So the
capture needs either:

1. the NPC -> script path decoded (how talking to an NPC selects a script), or
2. script 180 run on its own map, with the actors present — reachable by patching a
   condition record on that map once the map is identified.

⛔ Not captured yet. But it exists, it is located, and the reason my harness stalls
is understood.

## 30. Vehicle SFX — six exist, NONE captured. Plus a music-table correction.

### Correction to §12: the music table is FOUR rows, not five

`$A027` and `$A047` are read with the SAME index X, so the music table cannot be
more than 32 bytes or the two would overlap. It is **4 rows of 8**
(`$A027`-`$A046`), and `$A047` begins the SFX table. The row §12 printed as
"`$78`=4" — `$ff $ff $ff $04 $26 $25 $27 $28` — is **SFX row 0, not music**.

Read correctly:

| table | mode 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| music `$A027` | `$1e` | `$08` | `$1e` | `$22` | `$0a` | `$0a` | `$0a` | `$23` |
| **SFX `$A047`** | `$ff` | `$ff` | `$ff` | `$04` | `$26` | `$25` | `$27` | `$28` |

(row 3 of the SFX table has `$2b` in the mode-6 slot instead of `$27`.)

`$ff` = silent, so boarding on foot / canoe makes no sound; every powered craft has
its own transition cue. These fire from `$C93A`, which maps bank 59 and jumps to
`$A006` — the routine writes the music to `$7F43` **and** `$A047,X | $80` to
`$7F49`. `$C93A` is called on every vehicle state change: boarding (`$C64A`),
disembarking (`$C5D4`) and the shallow-water transform (`$C5F3`).

### Coverage: zero of six

Checking every `wrote:` value in `src/data/world-sfx-captured.js` and
`spell-sfx-captured.js` against the writes these produce (`$80 | id`):

| sfx id | writes | captured |
|---|---|---|
| `$04` | `$84` | ⛔ |
| `$25` | `$a5` | ⛔ |
| `$26` | `$a6` | ⛔ |
| `$27` | `$a7` | ⛔ |
| `$28` | `$a8` | ⛔ |
| `$2b` | `$ab` | ⛔ |

**None of the six vehicle transition SFX are captured.** That is not a failure of
the earlier sound work — the world/battle/spell sweeps predate any vehicle
investigation and never had a vehicle to board. It is a genuine, newly-identified
gap.

### Capturing them is straightforward

Unlike the transformation animation, these need no story state. `$C93A` fires on
boarding, and `world-harness.cjs` can already boot aboard any vehicle on the
appropriate terrain (§10). Hook `onBatteryRamWrite` for `$7F49` — the mechanism
`world-sfx-sweep.cjs` already uses — board each craft, and record the write. The
`$ff` entries predict SILENCE for modes 0-2, which is a falsifiable check worth
running alongside.

## 31. Vehicle SFX capture — attempted, and it CONTRADICTS §30

### What was run

Booted aboard every vehicle 0-7 on open ocean with land one tile east, hooked
`onBatteryRamWrite` for `$7F49` (the sound port) and `$7F43` (music), then: idled,
sailed back and forth, and drove east until the auto-disembark fired.

### Result

| vehicle | `$42` | sounds observed | music writes |
|---|---|---|---|
| 0, 1 | 0 | none | 0 |
| 2 | 2 | none | 0 |
| **3, 4** | 3 -> 0 (disembarked) | **`$05` `$06` `$15` `$18`** | 1 (value `$20`) |
| 5, 6, 7 | unchanged | none | 0 |

⛔ **None of the six `$A047` values fired** — not `$04`, `$25`, `$26`, `$27`, `$28`
or `$2b`, in any run.

⛔ **And `$A006` never executed.** That routine writes music, `$7F42` and the SFX
together. Vehicles 0-2 and 5-7 produced **zero** music writes, and the single write
in the 3/4 runs was value `$20`, which matches neither `$A027` index 0 (`$1e`) nor
index 3 (`$22`) — so it came from some other routine, not `$A006`.

### What that means

§30 stated the `$A047` table is the vehicle SFX table and fires from `$C93A` on
every vehicle state change. **That is read from code but NOT verified, and this
test points against it.** A disembark demonstrably occurred (vehicles 3/4 went
`$42` 3 -> 0) and `$C5D4` should have called `$C93A` on that path, yet no `$A006`
music write appeared. Either the disembark takes a different path than `$C5B5`, or
`$C93A`'s `JSR $FF09` / `JMP $A006` does not land where I assumed.

⚠ **So §30's SFX table description is downgraded to unverified.** The table bytes
are real; that they are vehicle sounds fired by `$C93A` is not established.

### What WAS captured

Four sounds do fire while a mode-3 craft moves and disembarks: **`$05`, `$06`,
`$15`, `$18`** (writes `$85`, `$86`, `$95`, `$98`). They are not in
`world-sfx-captured.js` either. What they correspond to is not attributed — by the
standard that file sets, hearing a value does not identify the event.

⛔ **Not captured: propeller/sail loops.** Modes 2, 5, 6 and 7 produced NO sound at
all across idle and movement, so either those craft are silent in motion or the
harness never reaches the state where their loops run.

### Next

Confirm whether `$C93A` executes at all — hook the PC or breakpoint `$A006`
directly — before trusting any of §30's table reading. That is one measurement and
it decides whether the six values mean anything.

## 32. vehicle-test.cjs — and §31's retraction was itself WRONG

### The tool

`tools/monscan/vehicle-test.cjs` (NEW). One command, every vehicle. Each row
proves, in order: the vehicle **sticks** (`$42` read back), the vehicle **moves**
(party coords actually change, distance reported), and only then what it sounds
like, plays, and looks like. It tries several terrains per vehicle and keeps the
one where the craft both sticks and moves.

That ordering exists because §31 concluded "modes 5/6/7 make no sound" **without
ever checking the party moved**. A propeller loop only plays while flying, so a
silent result from a vehicle that never moved is not evidence of silence — it is a
broken test.

### ⛔ §31's retraction is withdrawn — the `$A047` table is CORRECT

§31 reported that none of the predicted SFX fired and that `$A006` never ran, and
downgraded §30's table to "unverified". **That was an artefact of hooking too
late**: `onBatteryRamWrite` was installed after `bootToWorldMap()` returned, and
**boarding happens during that boot**. Every cue was fired before the hook existed.

With the hook wired at CONSTRUCTION (`world-harness.cjs` now accepts
`onBatteryRamWrite` and passes it to `new Nes`), the table predicts reality
exactly:

| `$42` | predicted SFX | observed | predicted music | observed |
|---|---|---|---|---|
| 3 | `$04` | **`$04`** ✅ | `$22` | **`$22`** ✅ |
| 4 | `$26` | **`$26`** ✅ | `$0a` | **`$0a`** ✅ |
| 5 | `$25` | **`$25`** ✅ | `$0a` | **`$0a`** ✅ |
| 6 | `$27` | **`$27`** ✅ | `$0a` | **`$0a`** ✅ |
| 7 | `$28` | **`$28`** ✅ (+ `$2c`) | `$23` | **`$23`** ✅ |

Five of six table SFX confirmed firing, plus all four music values. `$2b` is the
row-3 mode-6 variant and was not reached. Vehicle 7 additionally fires **`$2c`**,
which is NOT in the table — an extra cue worth chasing.

Common to every boot regardless of vehicle: `$05 $18 $14` (and `$7f`) — intro and
menu sounds, not vehicle cues.

### ⛔ Mode 4 IS reachable — §27 was wrong about that too

On **mountain**, vehicle 4 sticks at `$42` = 4 and flew **679 tiles**. §27 claimed
mode 4 unreachable because it normalised to 3 — but that was only ever tested on
ocean and land. Modes 5, 6 and 7 fly as well (48, 570 and 48 tiles measured).

### Sail and propeller sound: it is the MUSIC, not a repeating SFX

Flying vehicles moved **570-679 tiles** with the hook live and produced **zero**
`$7F49` writes while moving. So there is no per-step engine SFX. The continuous
sail/propeller sound is the vehicle MUSIC track — `$22` on the ship, `$0a` on the
airships, `$23` on the Invincible — started once at boarding by `$A006`, with the
one-shot transition cue alongside it.

## 33. Nautilus submerge/surface — machinery found, animation NOT captured

### What was found

**The grant.** Script 86 is Doga's Aquario scene (messages `0xe6`, `0xe7` — *"The
Nautilus can now travel underwater"*). It sets **flag 7** and, like script 180,
carries its animation INLINE: a run of `$d1` opcodes with a decreasing `$fc` ramp
(`$fc.40 $fc.30 $fc.20 $fc.10 $fc.8`) — a speed ramp, not a `$EF` sequence.

**A mode-indexed animation loop.** Bank 59 `$85BE`:

    85BE  LDA #$00 / STA $BC              ; counter
    85C5  LDA $602F / ORA #$40            ; raise the animation flag
    85CD  JSR $A85A / $A842 / $A5E3
    85D6  LDY $42                         ; <- indexed by the VEHICLE MODE
    85DE  INC $BC / BPL $85CD             ; 128 steps

`$85E3` blinks the craft — it rewrites 16 OAM bytes from `$A5F9` on `$BC & $08`,
i.e. a fade/flash cycle. That is what a submerge looks like, and it is per-vehicle.

**The animation flag.** `$602F` bit 6 is "transition in progress": raised by
`$85C5`, `$82BA`, `$847A` and bank 58 `$9ADD`, and consumed in the world render at
`$D8F4`, which advances a counter (`$19 += 4`), toggles the bit back off on carry,
and picks a frame with `$F0 >> 3 & 3`.

**A dead gate.** `$602E` bits `$02`-`$20` are set by sequences 5-8 (`$8537`,
`$854D`, `$8563`, `$8579`, `$85AF`), but **nothing sets `$602E` bit 0** — the exact
bit the transform handler `$C5DE` requires. Same dead-gate shape as mode 6 and
flag 6, and it explains why pressing A aboard a craft never transformed in §31.

### What failed

Capturing sequences 2, 3, 4, 10, 11, 12 and 13 with script 162's exit-to-world
prelude produced **identical output for every one**: one OAM state, mode 0, and the
same boot-noise SFX list. They did not run. The prelude that works for sequence 9
does not reach them, so the §25 census entry "these animate but grant nothing" is
based on the earlier in-cave runs and their identity is still unestablished.

⛔ **The submerge and surface animations are NOT captured.** The machinery is
located — grant script, inline choreography, a mode-indexed 128-step blink loop and
the `$602F` bit-6 flag that drives it — but nothing has been made to play.

### The one blocker, stated plainly

Every uncaptured item now shares a single cause: **a script or sequence that needs
its own map, actors and story state, which the Altar-Cave boot cannot supply.**
That covers the Time Wheel remodel (§29), the submerge/surface here, and the seven
unnamed vehicles (§21). It is one problem, and the fix is one thing — a coherent
save at the relevant story point, or the NPC->script path decoded so those scripts
can be reached where they live.

## 34. NPC -> script path — NOT decoded. What is known, and what blocked it.

### Established

- A map's event data block is **condition records followed by a 32-byte NPC
  table**. Bank 60 `$92F3` walks past the records looking for the `$FF` terminator,
  then `$930D`-`$9317` copies 32 bytes into **`$0740`**.
- **`$6C` is the condition evaluator's RESULT — the script index.** `$931B` stores
  it (`$9325`), so hooking `$6C` reports exactly which script any trigger selects.
- Opcode `$F0` reads `$0740,X` as a MESSAGE id (`$B6BF`), so `$0740` holds
  per-NPC dialogue ids, not script indices. The script must be selected elsewhere.

### Both routes failed

**Static.** The only real writer into the `$7B00` condition buffer is bank 60
`$974C`, and that is inside `$9737` — a *save/restore wrapper* that copies `$7B00`
to `$7BC0`, calls `$A875`, and copies back. Following it means resolving which bank
sits in the `$A000` window at that moment, and the trace spirals. (Two other
apparent writers, bank 48 `$8917` and the `$7B00` hits in data banks, are byte
coincidences, not code.)

**Empirical.** Booting the harness into Kazus (`opts.map` added to
`world-harness.cjs`) puts the party on the map's tiles but **loads no NPCs**: 4
visible sprites (the party alone), `$0740` reads `$01 $00 $00...`, and no `$6C`
write ever occurs. The map-props copy forces tileset, tilemap and graphics subset —
it does not populate the cast. With no NPC present there is nothing to talk to and
the path cannot be observed.

⛔ **So the NPC -> script path is NOT decoded.** `$6C` is the right probe and
`world-harness.cjs` can now force any map; what is missing is a boot that loads a
town's NPCs.

### Why this matters more than it looks

This path is the single shared blocker (§33): the Time Wheel remodel, the Nautilus
submerge/surface, and the naming of `$600B` 1-8 all sit behind scripts reached by
talking to someone. Every instrument needed downstream already exists — the string
hook reports ids, `$6C` reports script indices, `vehicle-test` proves vehicle state,
`seqcap`/`launch-capture` record frames. They are all waiting on one thing: a game
state with NPCs in it.

The realistic fix is not more static tracing. It is **a real save** at the relevant
points, or working out what the map loader does with property byte 4 (`npcIdx`)
that the forced-props boot is skipping.

## 35. npcIdx DECODED and NPCs loading — talk interaction still not firing

### The NPC loader

Bank 59 `$9300`, and map property **byte 4 is the index into it**:

    9307  LDA #$2C / JSR $FF06      ; map bank $2C
    9314  LDA $0784                 ; npcIdx (map property byte 4)
    9317  ASL A / BCC / INC $81     ; idx*2 into a pointer table at $8000/$8100
    931D  LDA ($80),Y -> $8C        ; pointer low
    9322  LDA ($80),Y | $80 -> $8D  ; pointer high, forced into the mapped window
    9338  LDA ($8C),Y / BEQ $934D   ; walk the NPC list; a 0 byte ends it
    933C  JSR $B34E                 ; process one NPC

So: **npcIdx -> pointer table at bank `$2C` `$8000` -> that map's NPC list**,
walked to a zero terminator.

### It works — the earlier failure was a bad map

`$0784` reads `$0a` live during boot with `opts.map` = 10, exactly map 10's
byte 4, and the loader runs (294 reads). ⭐ **And NPCs do load**, measured by max
sprites seen while walking (the party alone is 4):

| map | max sprites |
|---|---|
| 10 | 4 — none in reach |
| **17** | **8** |
| **114** | **12** |

§34 concluded "the harness loads no NPCs" from map 10 alone. That was wrong: map 10
simply has none near the spawn. `world-harness.cjs` populates a town fine.

⚠ Also corrected: `$0780`-`$078F` is NOT a stable mirror of the map properties. It
reads `58 5c 54 58 …` after boot — the region is reused. `$0784` only holds npcIdx
at the moment the loader runs, which is why it must be sampled by hooking the read
rather than inspected afterwards.

### What still does not work

Talking. On map 114 with 8-12 NPCs present, pressing A — including navigating
toward the nearest non-party sprite and facing it from all four sides — produced
**zero `$6C` writes and zero string-pointer reads**. So no dialogue is triggered
and the NPC -> script path still cannot be observed.

⛔ **Not decoded.** But the remaining gap is now much narrower than §34 implied:
the loader is understood, the index is right, the cast is on screen, and `$6C` is
the correct probe. What is missing is whatever makes an A-press register as a talk
— most likely the party must be exactly one tile away and facing, and the sprite
positions I steer by are OAM screen coords, not map tiles.

## 36. NPC map positions FOUND in RAM; navigation blocked on a different problem

### The NPC record table — decoded

The loader (§35) writes each NPC through the `$8E`/`$8F` pointer, which it sets to
**`$7000`**. Bank 59 `$934E` onward gives the layout, and a live dump on map 114
confirms it exactly:

    $7000: 05 c0 0a 1c 0a 1c 00 00 00 00 05 00 00 00 1a b4
    $7010: 06 00 12 18 12 18 00 00 00 00 06 03 00 00 3a b4
    $7020: 08 c0 1c 1c 1c 1c 00 00 00 00 08 00 00 00 2a b4

**Base `$7000`, stride 16.** Fields:

| offset | meaning |
|---|---|
| +0 | NPC id (also mirrored at +10) |
| +1 | flags (`$c0` / `$00`, written as `byte & $F0`) |
| **+2** | **map tile X** |
| **+3** | **map tile Y** |
| +4, +5 | X, Y again (the "home" copy the loader writes twice) |
| +6..+9 | zeroed at load (runtime movement state) |

Map 114 holds 8 populated records; NPC #0 sits at (10,28), #1 at (17,28).

### Navigation could not be exercised — the party does not move

Diffing all of RAM **and SRAM** across a down/up/right walk on map 114, the only
addresses that respond are `$20`, `$33d`, `$7f4a`, `$7f75`, `$7f98` — and the
`$7f4x`/`$7f9x` ones are the SOUND ENGINE (`$7F42`/`$7F43`/`$7F49` are its ports),
not coordinates. **No party tile coordinate changes at all.**

`$27`/`$28` — which are definitely the party's tile coords on the WORLD map, proven
by the `$C681`/`$C689` pointer arithmetic — do not move here. `$68`/`$69` hold the
map ENTRANCE (they read back exactly the `spawnX`/`spawnY` passed in), not a live
position.

So the party is not walking on these forced indoor maps at all, whether spawned at
the map's own entrance or at an override. That is why talking never fired in §35 —
not adjacency, not facing, and not the pixel-vs-tile steering I blamed: **the party
never moves, so it can never reach anyone.**

⛔ Navigation-by-tile is implemented-ready but untestable until that is fixed. The
NPC side is done: positions are at `$7000 + n*16 + 2/+3`, and the party's live tile
coords on an indoor map are the missing half.
