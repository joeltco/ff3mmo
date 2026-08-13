# SFX / music audit — v1.7.997

Joel: *"lots of sfx are wrong. meteo sfx, the ff2 learn sfx, and im sure many
others. kazus and the castle arent playing the right music... pull them all and
label them."*

This is the labelled result. Read the **Unresolved** section at the bottom
before believing the audit is finished.

## Tools built or extended

| tool | answers |
|---|---|
| `tools/music-probe.mjs` | Warps the REAL ROM into every map slot and records the song request at `$7F43`. Ground truth for map music. |
| `tools/music-audit.mjs` | Reads map property byte 10 (the *interpretation* the code used to trust). Kept because the disagreement with the probe is the finding. |
| `tools/sfx-table.mjs` | Every spell → its impact sound, resolved through the REAL rule table, with provenance per row. `--dupes` lists sounds shared by more than one spell. |
| `tools/check-sfx-audio.mjs` | Renders every SFX constant and music track through the real libgme and measures peak / RMS / audible duration. Catches "right number, no sound". |
| `tools/check-map-music.mjs` | Deploy gate: the measured table AND the wiring. |
| `tools/lib/browser-shim.mjs` | Extracted from `encounter-sim.js` so Node tools stop hand-copying DOM stubs. |
| `tools/monscan/spell-sweep.cjs` | Unchanged, but re-run three ways; the raw `$7F49` traces are now kept. |

## 1. Map music — FIXED

**The bug.** `_loadRegularMap` started music for exactly one map:

```js
if (mapId === 114 && transSt.pendingTrack == null) playTrack(TRACKS.TOWN_UR);
```

Every other map inherited whatever the previous map left playing. Kazus, Castle
Sasune and the mountain town ran on Ur's town theme. `title-screen.js` made it
worse: loading any save queued `TOWN_UR` under a comment claiming
`_loadRegularMap` would take over for non-Ur maps — it never did.

**The measurement.** 256 of 256 map slots probed on the real ROM, zero failures,
Ur self-check reproduced 31. Byte 10 of the map property record is the song id
*for most maps* but reads `0x81` for exactly the maps Joel named:

| map | byte 10 | measured | |
|---|---|---|---|
| Ur + interiors | `0x1f` | **31** | agrees |
| Altar 1F / 2–4F / crystal | `0x02` / `0x1d` / `0x36` | **2 / 29 / 54** | agrees |
| Kazus inn (17), Castle Sasune (18), mountain town (10) | `0x81` | **12** | **byte 10 is wrong here** |

Taking byte 10 at face value is what would have shipped a second wrong answer.

**The fix.** `src/data/map-songs.js` (generated, 256 rows) + `src/map-music.js`,
a pure `mapEntryMusic(mapId, opts)` returning a plan (`ff2` / `ff3` / `deferred`
/ `none`). `map-loading.js` and `title-screen.js` both consume it. The elder
house keeps its FF2 theme — that is a deliberate design choice, not a ROM value,
and it sits above the measured table so a re-measure can't silently revert it.

**Gate.** `check-map-music.mjs`, proven by reverting three separate ways:

| revert | result |
|---|---|
| `map-loading` back to the `mapId === 114` branch | 2 checks FAIL |
| map 17 back to Ur's song in the table | 2 checks FAIL |
| `title-screen` back to `TRACKS.TOWN_UR` | 1 check FAILS |

Each revert was verified to have actually landed before the gate was run, and
the gate is green again after restore.

## 2. Spell impact SFX — VERIFIED, no change needed

Meteo was re-measured from scratch, then the whole table with it. The original
run persisted only the derived numbers, so **nothing in
`spell-sfx-captured.js` was checkable after the fact** — the raw traces are now
kept.

**48 of 48 non-summon castable spells reproduce their shipped value exactly.
Zero differ.**

It took three runs, and both intermediate failures were the harness:

1. Default run — 43 agree, 5 silent (`Life2`, `Heal`, `Soft`, `Wash`, `Pure`).
   `AFFLICT` is opt-in; the party was healthy so the cure spells no-opped.
   **I briefly concluded these five were never captured and began deleting
   them.** The `[afflict:poison]` tags on the rows are what caught it.
2. `AFFLICT=1` — 47 agree; only `Wash` silent, because it cures BLIND and the
   default mask is poison.
3. `AFFLICT=1 AFFLICT_MASK=4` — `Wash` reproduces 74. **48/48.**

On Meteo specifically: `0x02 → $88 → track 73`, reproduced independently, lands
65f after its own CHR block goes live (the elemental spells sit at 78f, and
Meteo's block starts 112f later — self-consistent), and renders **896 ms of
audible PCM** through libgme. By every measurement available it is what the ROM
plays. See Unresolved.

Every one of the 56 player-castable spells has a real capture — the 16 spells
sitting on the picked `SW_HIT` fallback are all catalogue entries above `0x37`
that no player can cast.

## 3. Playback — VERIFIED

Every SFX constant (26) and music track (9) renders audible PCM. Nothing is
silent, nothing is a click. This is the check that did not exist before, and the
one that would have caught the FF2 blips shipping silent.

## Unresolved — read this part

- **Meteo.** Joel says it is wrong; every measurement says the number is right
  and it plays. I cannot judge how a sound *sounds*. The unanswered question is
  what he expects to hear instead — if it is "Meteo should not share a family
  with X" or "it should be the big crash", that is a design call, not a capture,
  and I am not going to invent one.
- **FF2 learn SFX — NOT FIXED.** The word menu plays FF2's `confirm` blip for
  every choice including LEARN, so learning a word sounds identical to moving
  through a menu. Whether FF2 plays something distinct there is unverified:
  reaching FF2 gameplay headlessly is still blocked. **Progress: `B` advances
  between characters in the kana name grid** (the memory said no button
  confirmed — A fills, START/SELECT do nothing; B was never tried). All four
  names can now be filled, but after the fourth it cycles back to Firion and
  nothing finalises. Savestates at
  `scratchpad/ff2-name.state` / `ff2-play.state`.
- **The 8 summons** are captured, but from the earlier separate summon run —
  they were NOT part of tonight's 48/48 re-verification.
- **Altar Cave floors 2–4** measure song 29 in the ROM; our generated dungeon
  plays the cave theme (2) on every floor. Left alone deliberately — our dungeon
  is not the ROM's, and Joel did not report it.
- **`encounter-sim.js` still carries its own copy** of the browser shim now in
  `tools/lib/browser-shim.mjs`. Not migrated tonight because it is a deploy
  gate and I did not want to destabilise it unattended.
