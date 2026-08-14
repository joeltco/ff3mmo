# Kazus — measured facts

Everything here was read off the ROM or the running game, not inferred. Written
during the v1.8.12 buildout; keep it updated as the town lands.

## The map block — CONFIRMED

**Kazus is map 10. Its interiors are maps 11–17. The world entrance is (93,59).**

Not inferred: warping to map 10 in the real ROM makes the game print its own name
banner, **"Kazus"** (`tools/monscan/map-bundles.cjs`, screenshot `map-10.png`).

| map | what it is | entrance | shop marker NPC |
|---|---|---|---|
| 10 | **Kazus town** | (7,30) | — |
| 11 | interior | (3,11) | — |
| 12 | **inn / tavern** (beds upstairs, tables, barrels) | (14,31) | id250 |
| 13 | interior | (3,11) | — |
| 14 | interior | (7,12) | — |
| 15 | **magic shop** | (4,8) | id244 |
| 16 | **weapon shop** | (3,26) | id232 |
| 17 | **armor shop** | (3,8) | id239 |

⛔ `data/map-songs.js` labels map 17 "Kazus — inn". **That label is wrong** — 17 is
the armor shop. The song value (12) is measured and correct; only the comment is
wrong. Left in place until the whole block is labelled.

**Shop marker ids encode (type, town).** Ur: inn 227, weapon 231, armor 238,
magic 243. Kazus is each of those **+1**: weapon 232, armor 239, magic 244. And
Kazus's shop rooms are the SAME layouts as Ur's — map 16 has Ur map 5's exact
entrance (3,26) and marker position (3,23); 17 matches Ur's 4; 15 matches Ur's 3.

## Reachability — CONFIRMED

(93,59) is **reachable from Ur today**, with the choke boulder at (81,54) in
place. Flood-fill from Ur's entrance (95,41) through the real
`WorldMapRenderer.isPassable` reaches 267 tiles, including Kazus, Sasune Castle
(75,48) and the Altar Cave (95,34). **No world-map change is needed.**

## NPC placement budget — MEASURED off the PPU

FF3 is CHR-RAM, so a map holds only the walk bundles it decompresses, and two
NPCs on one bundle render as the same person (`check-npc-placement` gates this).
Measured with `MAPS=10,11,12,13,14,15,16,17 node tools/monscan/map-bundles.cjs`,
converted to the header-inclusive offsets `data/town-npcs.js` uses:

| map | bundles loaded | NPCs placeable |
|---|---|---|
| 10 town | `0x1D910` `0x1DF10` `0x1E010` `0x1E210` | **4** |
| 12 inn | `0x1DF10` `0x1E010` `0x1E410` `0x1ED10` | **4** |
| 15 magic | `0x1C410` `0x1ED10` | **2** |
| 16 weapon | `0x1DF10` `0x1ED10` | **2** |
| 17 armor | `0x1DF10` `0x1ED10` | **2** |
| 11 | (none in NPC range) | 0 |
| 13 | `0x1E010` | 1 |
| 14 | `0x1E210` | 1 |

First drop (town + inn + shops) = **14 NPCs**, against Ur's 18.

The ROM lists more people per map than there are bundles (map 10 lists 7
townsfolk for 4 bundles) — same as Ur, where the inn lists three guests it has
no sprites for. Place one per bundle; the rest stay unplaced rather than
shipping as twins.

Palettes need no per-NPC work: `data/npc-palette.js` repaints every spec with
the map's own SP2/SP3 at placement time (v1.8.10).

## Shop inventories — read from the running game

FF3's shop table is not decoded and guessing a ROM offset for it is exactly the
mistake this project has a standing rule against. `tools/monscan/shop-probe.cjs`
warps into the shop, walks to the counter, opens it and screenshots the stock —
what is on screen IS the inventory, prices included.

**Ur weapon (map 5)** — Knife 20, Dagger 60, Longsword 100, Staff 40, Nunchuck 60.
*(Our catalog drops the Knife and adds a Bow + three arrow types.)*

**Ur armor (map 4)** — Vest 50, LeatherArmor 95, LeatherShield 40, LeatherCap 15,
BrnzeBracer 80. *(Our catalog drops the Vest.)*

Both Ur reads validate the method against a shop we already ship.

⛔ **Kazus catalogs CANNOT be read from a fresh game, and that is the game
refusing, not the probe missing.** The probe reaches the counter on maps 15/16/17
(screenshots show the party standing at it) and nothing opens. The screenshots
also show why: **a ghost is standing behind the counter** — a small dark-green
figure beside the player on `shops2/shop-16-step2.png`. Kazus is cursed until
the Djinn is beaten, and canon says the shops only trade once the curse lifts.

Tried and ruled out: `STEPS=6` (walks past), `STEPS=4` (stands at the counter,
still nothing). The blocker is story state, not geometry.

### The curse flag is `$609D`

Found with `tools/monscan/shop-flag.cjs`, not guessed. Ur's weapon shop (map 5)
and Kazus's (map 16) are the same room with the same counter position and one
opens while the other does not, so: hook every CPU read in both and the
addresses read ONLY in Kazus are where the extra check lives.

**Set `$609D` before the map loads and Kazus is a living town** — the ghost
behind the counter is gone and the shop opens. `$609D` sits in the save-data
region (`$6000-$60BF`), which is where story progress lives.

    POKE=0x609d node tools/monscan/shop-probe.cjs 16

⛔ **It must be set BEFORE the warp and held across the load.** A cursed town
decides ghosts-or-people while the map loads; a value set once the player is
standing in the room changes nothing, because the ghosts are already there.

Three things made correct addresses look like dead ends, all worth knowing
before running this on the next town:

1. **A blue-fraction "is the shop open" test calls a MESSAGE BOX a shop.** The
   ghost says *"The Djinn's curse has left me in this state..."* and the
   detector scored it as an open shop. Measured discriminator: the strip
   between the two top boxes is dark in a shop's two-box header (0.25) and blue
   in a single wide message box (0.69).
2. **Tracing the counter press finds nothing.** The check runs at MAP LOAD. A
   counter-window trace returned six addresses, none of which did anything.
3. **Poking after the warp finds nothing either** — same reason as the ⛔ above.

The sweep verifies every poke reads back before believing a negative: a write
that never landed is indistinguishable from "not the flag".

Which BIT of `$609D` matters is not yet narrowed — 0xFF is what has been tested.

### Kazus catalogs — CAPTURED (with `POKE=0x609d`)

Read off the screen from the living town, prices included.

**Kazus weapon (map 16)**

| item | gil |
|---|---|
| MythrilRod | 400 |
| MythrilKnife | 500 |
| MythrilSwrd | 500 |

**Kazus armor (map 17)**

| item | gil |
|---|---|
| MythrilArmor | 350 |
| MythrilShield | 180 |
| MythrilHelm | 180 |
| MythrilGlv | 120 |
| MythrilBrc | 120 |

Exactly the Mythril tier canon describes, and a clean step up from Ur (whose
dearest item is a 100 gil Longsword).

⚠ **Kazus magic (map 15) not captured.** Not a curse problem and not a step
count — tried 5 and 9, and the town is live (`POKE=0x609d`). The room is a
ROUND CHAMBER with four spell orbs on pedestals, which is how FF3 sells magic:
you walk up to an ORB and buy that one spell, so there is no single counter to
walk north to and `shop-probe.cjs`'s approach cannot reach a trigger that does
not exist.

Capturing it needs a different move — walk to each orb in turn and press A,
reading one spell per orb. Note Ur's magic shop (map 3) DOES open with the
north walk, so the two rooms are not the same interaction despite sharing an
entrance coordinate and a marker position; do not assume from the ROM metadata
that they behave alike.

## Canon (searched, for the dialogue)

Kazus is cursed by the Djinn and its people are ghosts; **Cid** is a ghost in
the inn and lends his airship if the curse lifts; the **Mythril Ring** (120 gil)
is central; **Takka** the blacksmith is absent until the curse breaks, then fits
a mythril ram to the airship. Shops only open once the curse is lifted.

**Our build is the LIVING town** — the curse mechanic is deliberately not
implemented (decided 2026-08-14). One ghost NPC remains as a quest hook.
