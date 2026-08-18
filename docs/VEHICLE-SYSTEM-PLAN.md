# Vehicle system — plan

Status: **PROPOSED**. Nothing under `src/` yet. Scoped 2026-08-18.
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

**This is one of the launch animations** (§6) located in code: an object rises 16
pixels at a fixed X, one pixel every four frames, and the party is then aboard
mode 5 — whose sprite is the masted sailing ship. Which story vehicle that is
(Cid's airship out of the sand, or a ship) is **not yet established** — the
animation is identified, the name is not.

Capturing it still needs the scene reached. With `world-harness.cjs` the party
can be put anywhere on the world map in any vehicle, but this sequence runs from
an event, so the remaining work is to trigger it — either by condition-patching
the script that calls it or by jumping the routine directly.
