# monscan — measuring sprite data off a running PPU

Headless jsnes harness for capturing what FF3 **actually draws**, rather than
reading ROM offsets. ROM bytes are not PPU bytes: MMC3 swaps CHR banks mid-frame,
which is why the registry's large-monster artwork was garbage for years and why
`CLAUDE.md` bans authoring sprite data from ROM offsets.

Everything here is a measurement tool. Outputs (`*.json`, `*.log`) are
regenerable and gitignored — none of them are inputs to the game.

## Current tools

| tool | what it measures |
|---|---|
| `nes.cjs` | the harness itself — boot, input, savestates, PPU/RAM views, PNG out |
| `capture.cjs` | catalog lookup + tile/palette decode helpers used by the others |
| `tilepal.cjs` | per-tile palette split, by spawning exactly ONE monster and reading the attribute table |
| `art.cjs` | real tile bytes, resolving each cell against the CHR bank live on **that cell's scanline** |
| `weapon.cjs` | verifies shipped weapon CHR against slots `$49-$60` mid-swing |
| `weapon-extract.cjs` | isolates one weapon's overlay: CHR provenance + differential render |
| `weapon-emit.cjs` | converts extracted pixels into the tile format `weapon-sprites.js` uses |
| `weapon-diff.cjs` | differential render alone, unfiltered — useful when you need every sprite in range |
| `spell-chr-region.cjs` | renders the battle-effect CHR region out of the ROM and maps known constants into it |
| `spell-sweep.cjs` | every castable spell: which ROM CHR block its animation loads, plus palette + OAM per frame |
| `spell-runs.cjs` | groups a sweep's blocks into contiguous runs and gates them against the shipped captures |
| `spell-dump.cjs` | emits a captured spell as a REC OAM dump for `tools/render-oam-dump.js` + `parity-check-spell.js` |
| `spell-capture.cjs` | one spell, cast round vs control round — the bring-up case for the sweep |
| `spell-cast.cjs` | boot + SRAM magic loadout + battle entry, on its own |
| `spell-verify.cjs` | Fire-only check used to bring the capture path up |
| `palette-from-image.py` | recovers pal0/pal1 from a reference screenshot (for monsters that cannot be spawned) |

## The two techniques worth knowing

**Single-spawn.** Patch a throwaway ROM so an encounter's monster list is
`[id, FF, FF, FF]` and its structure spawns one of group 0. With a single monster
on screen, every BG palette-0/1 cell belongs to it — nothing has to be inferred.
This also reaches monsters no encounter spawns, since the structure is overwritten
anyway.

**Differential render.** Draw the frame twice, once with the target's sprites
parked in the OAM shadow at `$0200`, and subtract. The changed pixels ARE the
sprite, composited by the PPU with priority, palette and flips already applied —
so none of that has to be re-implemented. Park in the shadow, not in the PPU's
OAM: the game re-uploads the whole page by DMA every frame.

## Traps that produced plausible-but-wrong results

Each of these passed structural checks while being wrong:

- **Reading CHR or palette RAM after `frame()`** returns whatever was mapped last
  (usually the UI bank), not what was live on the sprite's scanline.
- **Frame skew** — choosing sprite indices before advancing a frame and reading
  their attributes after. An index can be reused by then; strays show up as tile
  `$0` sprites far off screen.
- **Snapping framebuffer RGB to `NES_SYSTEM_PALETTE`** picks the wrong index for
  ~62% of pixels, because jsnes renders through its own table. Take colors from
  palette RAM instead; never match on RGB.
- **OAM y is one scanline above where the sprite draws.**
- **Spell capture: never sequence characters 2-4's command menus.** Their menu is
  already open when their turn arrives, so a leading `a` picks ATTACK rather
  than Guard; three fighters then kill the goblin before the caster acts and the
  spell never fires. That is indistinguishable from "this spell has no
  animation" — it produced 8 false negatives and an entire wrong theory that
  those spells were background-drawn. Kill characters 2-4 instead (HP 0 at
  `+$0C`/`+$0E` of each 64-byte SRAM block). A caster's menu is
  Attack/Magic/Run/Item, with no Guard on it at all.
- **`sweep.cjs` is SUPERSEDED** — its `captureByPalette` prefers a window using
  both palettes, which for a single-palette monster beside a differently-colored
  one invents a 50/50 split belonging to neither. It reported exactly the buggy
  default for CursdCopper and Larva, confirming the bug instead of catching it.
  Use `tilepal.cjs`. Kept only because the surrounding drive logic is shared history.

## Spell art lives in the ROM, uncompressed

All 66 verified animation tiles in `spell-anim.js` / `cast-anim.js` /
`cure-anim.js` were found verbatim between `$55400` and `$57000`, 16 bytes per
tile, one animation per 16-tile row, identical in the English and Japan ROMs.
Casting copies **24 consecutive tiles** from an animation's base offset into
sprite slots `$49-$60`. There is no dedicated spell SLOT range — that window is
shared with weapons, the fist and the damage digits — so the ROM region is the
discriminator. A capture therefore only has to identify which block loaded, an
exact 16-byte lookup, and the bytes come from the ROM afterwards.

## Exploration leftovers

`spike.cjs`, `find-intro.cjs`, `find-formation.cjs`, `reach-battle.cjs`,
`diag.cjs`, `timeline.cjs`, `weapon-oam.cjs` are earlier probes kept for
reference. `weapon-oam.cjs` in particular never reached an exact verification
(30/190 pixels off) and was replaced by the differential approach — do not build
on it.
