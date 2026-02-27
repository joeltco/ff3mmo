# FF3 MMO

A browser-based NES RPG engine that extracts all assets from user-supplied ROM files at runtime. No copyrighted data is stored in the repository — graphics, music, maps, and text are read directly from the ROM.

## Status

Early development (v0.1.0). Single-player exploration of the opening area is functional: Town of Ur, the world map (floating continent), and Altar Cave (4 procedural dungeon floors + crystal room). Title screen, pause menu, HUD, and music playback are all working.

## Requirements

- A modern browser (tested in Firefox and Chrome)
- Node.js (for the dev server)
- Two ROM files (not included):
  - `Final Fantasy III (Japan).nes` — 524,304 bytes, Mapper 4 (MMC3)
  - `Final Fantasy I, II (Japan).nes` — 524,304 bytes, Mapper 1 (MMC1)

## Setup

```bash
npm start
```

Opens `http://localhost:3000`. Load both ROM files via the file pickers (or click **Start** if they're cached from a previous session).

### ROM caching

ROMs are stored in IndexedDB after the first load. On revisit the page shows a **Start** button instead of file pickers (a user click is required to satisfy the browser's audio-context policy).

## Controls

| Key | Action |
|-----|--------|
| Arrow keys | Move |
| Z | Action / Confirm |
| X / Enter | Pause menu |
| C | Toggle CRT scanline filter |
| J | Toggle jukebox |
| +/- | Cycle tracks (jukebox) |

## Architecture

```
index.html          Entry point, ROM loading, IndexedDB cache
server.js           Dev server (static files, no-cache headers)

src/
  game.js           Main loop, state machine, input, transitions, sprites,
                    loading screen, title screen, pause menu
  map-loader.js     ROM map loading, tilemap decompression, triggers, NPCs
  map-renderer.js   Tile rendering, room clip BFS, pre-render, overlay
  world-map-loader.js   World tileset/tilemap/trigger loading
  world-map-renderer.js Viewport rendering, coordinate wrapping
  dungeon-generator.js  Procedural cave floors, secret paths/rooms
  tile-decoder.js   2BPP planar decode, NES system palette
  sprite.js         Player sprite (walk frames, direction, compositing)
  music.js          NSF playback via libgme, SFX dual emulator
  nsf-builder.js    Builds NSF blob from ROM banks at runtime
  rom-parser.js     iNES header parsing, PRG extraction
  ips-patcher.js    Applies IPS patches to ROM data in memory
  text-decoder.js   Reads text strings from patched ROM tables
  font-renderer.js  Draws text using NES font tiles from ROM

src/data/
  monsters.js       Bestiary stats (ROM ID keyed, names from ROM)
  items.js          Item/weapon/armor stats (ROM ID keyed)
  shops.js          Shop inventories by ROM item ID
  encounters.js     Encounter zones by monster ROM ID
  npcs.js           NPC roles (names resolved from ROM at runtime)

patches/
  ff3-english.ips   Chaos Rush v1.3 English translation (applied at runtime)
  ff3-ff6font.ips   Optional FF6-style font patch (not currently applied)

lib/
  libgme.js         Game Music Emu (Emscripten build) for NSF playback

tools/              Debug/analysis utilities (map viewer, sprite viewer, etc.)
```

### Key design principles

- **No copyrighted assets in the repo.** All graphics, music, maps, and text are extracted from the user-supplied ROM at runtime.
- **IPS patches are applied in memory** — the original ROM file is never modified.
- **Planar tile format:** `TL=data[m], TR=data[m+128], BL=data[m+256], BR=data[m+384]`
- **Z-level collision:** z=1 ground, z=2 water, z=3 wall. Blocked when `(tile_z | player_z) == 3`.
- **Procedural dungeons** generate layouts per floor with secret paths, trap holes, chests, and bones.

## Dev tools

Several browser-based debug tools live in `tools/`:

- `map-viewer.html` — interactive ROM map browser
- `tile-browser.html` / `tile-id.html` — tileset inspection
- `sprite-viewer.html` — NES tile viewer (works with any ROM)
- `sfx-test.html` — SFX/music track browser
- `shop-compare.html` — shop inventory comparison

CLI tools:

- `node tools/map-debug.js` — dump map data from ROM
- `node tools/room-data.js` — room clip simulation, NPC/trigger extraction
- `node tools/text-decode.js` — dump item/monster/spell names from patched ROM
- `node tools/floor-compare.js` — ASCII dump of ROM cave maps vs. generated floors

## Legal

- **ROM files are not distributed** — users supply their own copies
- **All engine code is original** — JavaScript engine, procedural generation, rendering
- **Translation patch** included with credit to Chaos Rush (see `patches/CREDITS-ff3-translation.txt`)
- This is a personal hobby project, not for commercial use
