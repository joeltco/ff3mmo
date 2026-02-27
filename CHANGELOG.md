# Changelog

All notable changes to this project are documented here.

## [Unreleased]

_No unreleased changes._

## 2026-02-20

### M28–M31: Loading screen, title screen, pause menu, NES fades

- **M28**: Loading screen overhaul — moogle sprite, boss in menu border, chat bubble, NES fade in/out, generation deferred to piano intermission
- **M29**: Pause menu — bordered panel, hand cursor, 6 menu items, NES text fade, Enter/X toggle
- **M30**: Area name NES fades — discrete palette stepping, simultaneous with wipe transitions
- **M31**: Title screen — credit text, sky+ocean background in top box, ship sprite, NES fades, "Press Z" prompt
- Floor 2 tuning — chamber 9–13×9–13, traps 3–5, chests 4–6
- Floor 4 tuning — 2–3 bones in boss door room

## 2026-02-16

### M18–M27: Text system, HUD, boss sprite, ROM cache

- **M18**: IPS patcher — applies English translation patch (Chaos Rush v1.3) at runtime
- **M19**: Text decoder — reads item/monster/spell names from patched ROM text tables
- **M20**: Data catalogs — monsters, items, shops, encounters, NPCs (no copyrighted strings in source)
- **M21**: Font renderer — ROM font tiles to canvas, loading screen uses ROM font
- **M22**: HUD top box — battle background scene (non-town) or blue banner with area name (town)
- **M23**: FF1&2 ROM loading — dual ROM file picker, Adamantoise sprite extraction
- **M24**: Boss sprite — Adamantoise in crystal room center stage, Land Turtle palette, h-flip animation
- **M25**: NES palette fade — authentic FF3 $FA87 algorithm on battle scene box (discrete color steps toward $0F)
- **M26**: Area name scroll — blue banner scrolls down on entry, up on exit (150ms timing, loading screen too)
- **M27**: ROM cache — IndexedDB stores both ROMs, Start button on reload (audio context needs user gesture)

## 2026-02-14

### M7–M17: Dungeon floors, music, world map, crystal room

- **M7**: Music system — NSF built from ROM banks + libgme, SFX dual emulator
- **M8**: Water tile animation — per-row cascade effect
- **M9**: Flame sprites + passage earthquake + Town of Ur 100% complete
- **M10**: Altar Cave floor 2 — corridor+chamber layout, trap holes, chests, bones
- **M11**: Dungeon loading screen — generation deferred to piano intermission (floor 1 entry)
- **M12**: Door open delay — 400ms pause after creak SFX before wipe
- **M13**: HUD system — 6-panel layout with real FF3 border tiles, FF1 black interior
- **M14**: Altar Cave floor 3 — rock puzzle, Z-shaped layout, false wall, chests, bones
- **M15**: Altar Cave floor 4 — T-shape corridor, organic rooms, branch alcoves, pond room, boss door
- **M16**: Crystal room (floor 5) — tileset 2 blue palettes, ROM map 148 diamond layout, song $36
- **M17**: Star spiral effect — crystal room warp teleport + pond healing trigger
- Altar Cave layout 100% complete (4 floors + crystal room, all triggers/doors/music working)
- Repo cleanup — untracked ROM, removed dead code and debug artifacts

## 2026-02-12

### Initial commit

- Repo cleanup — removed generated assets, added .gitignore for ROM/output files

## 2026-02-07

### M1–M6: Core engine, Town of Ur, world map, Altar Cave floor 1

- **M1**: Walking sprite, animation, keyboard input
- **M2**: Town of Ur (map 114) rendering, collision, player at entrance
- **M3**: Room transitions — door triggers, exit_prev, map stack
- **M4**: World map — floating continent 128×128, exit/enter towns
- **M5**: Action button (Z key), vase house secret passage
- **M6**: Altar Cave dungeon generator — 3 floors + boss room, secret paths
