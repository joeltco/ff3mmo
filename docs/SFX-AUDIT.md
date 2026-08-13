# SFX / music audit — v1.7.997-999

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
| `tools/monscan/spell-sweep.cjs` | Re-run four ways; now records the `$7F43` SONG channel too, and keeps the raw traces. |
| `tools/monscan/build-capture-rom.cjs` | HEX PATCHES the ROM: unkillable/harmless goblin + unlocks a spell's castability byte so level-8 spells can actually be cast. |
| `tools/monscan/meteo-probe.cjs` | Casts one spell and SCREENSHOTS every menu step, so a refused pick is visible instead of silently mis-recorded. |
| `tools/monscan/refusal-trace.cjs` | Ring-buffers executed PCs and dumps the path into the refusal buzz. |
| `tools/check-spell-sfx-drift.mjs` | Deploy gate: a level-8 spell must not wear the level-7 spell's sound. |
| `tools/sound-catalog.mjs` | Renders EVERY track in all three ROMs, measures it, fingerprints the PCM, and labels what ff3mmo uses it for. |
| `tools/ff2-name-escape.mjs` | Brute-forces every input combination out of FF2's name grid. |
| `tools/ff2-name-trace.mjs` | RAM-diff + PC-trace of FF2's name-entry scene. |

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

## 2. Spell impact SFX — Meteo WAS wrong. Found and fixed (v1.7.998)

**Meteo was playing Drain's sound.** Joel was right, and my first pass was
wrong in the most instructive way: I re-measured the whole table, got "48 of 48
reproduce exactly", and reported the table vindicated. That reproduction was
worthless — the re-run repeated the original's mistake.

The cause is written at the top of `spell-sweep.cjs`:

> *"Black/White Mage both cap at maxMagicLv 7, so level 8 is rejected outright
> — the pick is refused, the list stays open, and **later presses drift the
> cursor onto a lower spell**."*

Every level-8 spell was swept with a job that cannot cast level 8. The cursor
drifted one row down, the **level-7 spell in the same column** was cast, and its
sound was filed under the level-8 id. The evidence was in the shipped table all
along — each L8 value equalled the L7 value directly beneath it:

| col | level 8 | sfx | level 7 below | sfx | |
|---|---|---|---|---|---|
| 0 | 0x00 Flare | 131 | 0x07 Quake | 131 | identical |
| 1 | 0x01 Death | 91 | 0x08 Brak2 | 91 | identical |
| 2 | **0x02 Meteo** | **73** | **0x09 Drain** | **73** | identical |

### The fix: hex patch the ROM

Byte 7 of a spell's 8-byte record (`SPELL_DATA 0x0618D0`) is its castability
gate — level-8 spells carry `0x3d` (black) / `0x3e` (white), level-1 carries
`0x2f`. Rewriting **that one byte** to `0x2f` leaves the spell at its own id, in
its own menu slot, with its own animation and its own sound lookup, and simply
lets a Black Mage cast it. `tools/monscan/build-capture-rom.cjs` builds the
patched ROM (also applying the sweep's unkillable/harmless-goblin patch so no
death cue or victory fanfare can be mistaken for the impact).

Copying the whole record into a level-1 slot does **not** work — the sound is
looked up by spell **id**, so that route returns the level-1 spell's sound. That
dead end is what proved the lookup is id-keyed.

### Corrected, each reproduced on a second independent run

| spell | was | **is** | |
|---|---|---|---|
| 0x00 Flare | 131 | **125** (`$bc`) | was Quake's |
| 0x01 Death | 91 | **82** (`$91`) | was Brak2's |
| **0x02 Meteo** | 73 | **67** (`$82`) | **was Drain's** |

Track 67 renders **2219 ms** of audible PCM against 73's 896 ms — consistent
with Meteo being a long screen sweep.

The three **white** level-8 spells were re-cast the same way: 0x03 (74) and
0x05 (90) came back **unchanged** — they genuinely share a sound with the L7
spell below, which is why value-matching alone could never have separated drift
from truth. 0x04 Life2 is a revive and stayed silent with no dead target.

Gate: `tools/check-spell-sfx-drift.mjs`, proven by reverting Meteo to 73 (2
checks fail) and restoring.

## 3. Levels 1–7 — re-measured and unchanged

Levels 1–7 are castable by Black/White Mage, so the drift in section 2 does not
touch them. They were re-swept from scratch anyway, keeping the raw `$7F49`
traces this time — the original run persisted only the derived numbers, so
nothing in `spell-sfx-captured.js` had been checkable after the fact.

**All levels 1–7 reproduce their shipped values. Zero differ.**

Two intermediate runs looked like table bugs and were the harness:

1. Default run — 5 silent (`Life2`, `Heal`, `Soft`, `Wash`, `Pure`). `AFFLICT`
   is opt-in; the party was healthy so the cure spells no-opped. **I briefly
   concluded these five were never captured and began deleting them.** The
   `[afflict:poison]` tags on the rows are what caught it.
2. `AFFLICT=1` — only `Wash` silent, because it cures BLIND and the default
   mask is poison. `AFFLICT_MASK=4` reproduces it.

Every one of the 56 player-castable spells has a real capture. The 16 spells
sitting on the picked `SW_HIT` fallback are catalogue entries above `0x37` that
no player can cast.

## 4. Playback — VERIFIED

Every SFX constant (26) and music track (9) renders audible PCM. Nothing is
silent, nothing is a click. This is the check that did not exist before, and the
one that would have caught the FF2 blips shipping silent.

## 5. Every sound in every ROM — catalogued

`tools/sound-catalog.mjs` renders **every track in FF1, FF2 and FF3** through the
real libgme and measures it: peak, RMS, audible duration, loops-or-ends, and a
**PCM fingerprint**. Output: `docs/SOUND-CATALOG.md` (human) and
`tools/monscan/sound-catalog.json` (machine).

| ROM | tracks | distinct | duplicates | silent | used by ff3mmo |
|---|---|---|---|---|---|
| Final Fantasy III | 192 | 162 | 1 | 29 | 65 |
| Final Fantasy I | 23 | 22 | 1 | 0 | 2 |
| Final Fantasy II | 42 | 35 | 5 | 2 | 5 |
| **total** | **257** | **219** | | | |

The fingerprint is what makes this a catalogue rather than a track list. Peak and
duration cannot tell a real track from a pointer hole — FF2's `$FFFF` entries
render *something*, with identical peak and length, because they all fall through
to one fallback. Only comparing samples shows they are one sound wearing four
numbers.

**Three previously unreachable FF2 songs recovered.** The song pointer table at
`$9E0D` was read straight from the ROM: ids 0–30 real, ids **31/32/33/36/39 are
`$FFFF` holes**, and ids **34/35/37/38 are real songs** our builder never
exposed (`TOTAL_SONGS` was 31). Raising it to 39 exposes them — 34 renders
silent, and **35, 37 and 38 are three genuinely new pieces of music**. FF2's 35
distinct sounds now match the 35 real pointers counted in the table, from two
independent directions.

Moving the song count shifted the appended blips from tracks 31–33 to 39–41.
Everything reads `ff2SfxTrack()` rather than a literal, so they followed — but
`check-ff2-sfx` had a hardcoded `31` and failed on correct code. It now checks
the thing that actually matters (the header must cover the highest sfx track, or
libgme refuses it and the blip is silent), proven by undercounting the header.

## Unresolved — read this part

- ~~Meteo~~ — **FIXED**, see section 2. It was playing Drain's sound. The
  lesson worth keeping: "48 of 48 reproduce" proved only that the harness was
  deterministic, not that it was correct. A reproduction that repeats the
  original's mistake is not evidence.
- **FF2 learn SFX — NOT FIXED, and now bounded.** Reaching FF2 gameplay is
  blocked at the kana name grid, and that is no longer a guess:
  `tools/ff2-name-escape.mjs` brute-forced **all 36 single and two-button
  combinations** with the name filled — **zero escape the grid**. A disassembly
  of the live mapped bank shows the scene tests only the direction bits and A/B;
  there is no `AND #$10` (START) anywhere in it. `B` advances between party
  members (the memory said no button confirmed — B had never been tried), all
  four names fill, then it cycles back to the first. The exit is not reachable
  by input, so the next move is a ROM patch or a RAM poke into the post-intro
  scene, not more button-pressing. Savestates parked at `ff2-name.state` /
  `ff2-play.state`; `tools/ff2-name-trace.mjs` does RAM-diff and PC-trace.
- **FF2 learn SFX — original question.** The word menu plays FF2's `confirm` blip for
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
