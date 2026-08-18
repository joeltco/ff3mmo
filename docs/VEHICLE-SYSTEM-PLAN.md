# Vehicle system — plan

Status: **PROPOSED**. Nothing under `src/` yet. Scoped 2026-08-18.
Phase 0 **ATTEMPTED AND NOT LANDED** — see §8 for exactly where it stalled.

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
