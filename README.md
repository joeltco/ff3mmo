# FF3 MMO

A browser-based NES Final Fantasy III engine that extracts all assets from user-supplied ROM files at runtime. No copyrighted data is stored in the repository.

**Live at [ff3mmo.com](https://ff3mmo.com)**

## Status

v1.4.0 — Full combat system, PVP duels, job system with 22 jobs, status effects, procedural dungeons, online multiplayer roster, and chat. All game data (items, monsters, spells, encounters, jobs) extracted from ROM via Data Crystal offsets.

### Features

- NES-accurate combat with disassembly-verified formulas (damage, hit count, ATK, evade)
- 22 FF3 jobs with per-item equip restrictions, job levels, and Capacity Points
- Dual wield with per-hand independent hit rolling (NES loop at 30/9F6A)
- All 10 status effects wired (poison, blind, paralysis, sleep, confuse, silence, mini, toad, petrify, death)
- 7 status animation sprites from ROM
- Elemental damage, monster special attacks, weapon on-hit status
- PVP duel system with allies
- Procedural dungeons (4 floors + crystal room)
- Town of Ur, world map (floating continent), Altar Cave
- NSF music playback, SFX system
- Online roster, chat with tabs
- Email auth, server saves (IndexedDB + DigitalOcean)
- Title screen with NES fade, CRT filter option

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
| Z | Action / Confirm / Advance battle text |
| X / Enter | Pause menu / Cancel |
| C | Toggle CRT scanline filter |
| J | Toggle jukebox |
| +/- | Cycle tracks (jukebox) |

Mobile: touch controls with virtual D-pad and action buttons.

## Architecture

```
index.html              Entry point, ROM loading, IndexedDB cache, konami debug viewer
server.js               Production server (Express, JWT auth, SQLite saves, HTTPS)
debug-server.js         Dev server (no-cache, boss room debug spawn)
deploy.sh               One-command deploy to production

src/
  game.js               Main loop (2,680L), state machine, battle update, rendering
  input-handler.js      Battle/pause/roster input, target selection, hit calculation
  player-stats.js       Player state, stat recalc, job levels, JP, CP, equip
  battle-math.js        Centralized combat math: calcPotentialHits, rollHits, calcDamage
  battle-turn.js        Turn order, player/ally/enemy dispatch, confused targeting
  battle-ally.js        Ally attack animation (back/fwd swing, multi-hit combo)
  battle-enemy.js       Enemy AI, special attacks (28 mapped), multi-hit, status infliction
  battle-encounter.js   Random encounter spawning, formation selection
  battle-drawing.js     All battle rendering: portrait poses, slash effects, damage numbers,
                        encounter/boss boxes, victory box, battle message strip
  battle-items.js       Battle item use (potions, antidotes, status cures)
  battle-math.js        Damage/hit/crit/evade formulas, elemental multiplier
  battle-layout.js      Encounter grid positioning
  battle-sfx.js         Weapon-specific slash SFX selection
  pvp.js                PVP duel system: AI, hit rolling, combo animation, ally targeting
  pvp-math.js           PVP grid layout calculations
  status-effects.js     All 10 status effects: bitmask, turn processing, infliction
  sprite-init.js        Battle sprite building (3 paths: OK PPU, WR PPU, ROM-based)
                        Returns battlePoses map + effect sprites
  weapon-sprites.js     Blade/fist canvas building from ROM/PPU tiles
  slash-effects.js      Punch/sword/knife slash effect frames
  damage-numbers.js     Bouncing damage number rendering
  south-wind.js         South Wind item multi-target attack
  boss-sprites.js       Boss sprite loading and dissolve
  monster-sprites.js    Per-monster sprite loading from ROM
  flame-sprites.js      Flame effect sprites
  pause-menu.js         Pause menu: inventory, equip, stats, job switch, options
  hud-drawing.js        HUD panel rendering, portrait, HP/level display
  chat.js               Chat system with tabs, console, commands
  roster.js             Online player roster display
  message-box.js        Universal slide-in message box
  save-state.js         Save/load: IndexedDB + server sync
  save.js               IndexedDB operations, save slot parsing
  loading-screen.js     Loading screen with moogle sprite
  title-screen.js       Title screen, player select, name entry
  title-animations.js   Title ocean/sky/underwater animations
  transitions.js        Wipe transitions between areas
  map-loader.js         ROM map loading, tilemap decompression
  map-loading.js        Map transition orchestration
  map-renderer.js       Tile rendering, room clip BFS, pre-render
  map-triggers.js       Map trigger/NPC interaction
  world-map-loader.js   World tileset/tilemap/trigger loading
  world-map-renderer.js Viewport rendering, coordinate wrapping
  dungeon-generator.js  Procedural cave floors, secret paths, chests, traps
  sprite.js             Player overworld sprite (walk frames, direction)
  music.js              NSF playback via libgme, SFX dual emulator
  nsf-builder.js        Builds FF3 NSF blob from ROM banks
  ff1-nsf-builder.js    Builds FF1 NSF blob for title music
  water-animation.js    Two-bank CHR water animation
  rom-parser.js         iNES header parsing, PRG extraction
  ips-patcher.js        Applies IPS patches to ROM data in memory
  text-decoder.js       Reads text strings from patched ROM tables
  text-utils.js         NES text encoding, battle/victory message builders
  font-renderer.js      Draws text using NES font tiles from ROM
  tile-decoder.js       2BPP planar decode, NES system palette
  tile-math.js          Tile plane math, water detection
  palette.js            NES color fade, palette stepping
  canvas-utils.js       Canvas helper utilities

src/data/
  items.js              Weapon/armor stats, per-item job equip bitmasks (ROM-verified)
  monsters.js           Bestiary: stats, drops, elements, special attacks (ROM-verified)
  jobs.js               22 jobs: cpCost, lvReq, weapon/armor/magic bitmasks, 2-letter abbreviations
  spells.js             Spell data from ROM
  encounters.js         Encounter zones by area/floor
  players.js            Fake player pool for roster/PVP allies
  shops.js              Shop inventories
  npcs.js               NPC data
  strings.js            NES-encoded battle/UI text strings
  animation-tables.js   Damage bounce, animation timing tables
  job-sprites.js        Onion Knight PPU-dumped battle poses (all poses + legs)
  warrior-sprites.js    Fighter PPU-dumped battle poses (all poses + legs + death)
  boss-sprites-rom.js   Boss sprite ROM offsets
  monster-sprites-rom.js Monster sprite ROM format data
  monster-sprites.js    Runtime monster sprite cache

patches/
  ff3-english.ips       Chaos Rush v1.3 English translation (applied at runtime)

lib/
  libgme.js             Game Music Emu (Emscripten build) for NSF playback

tools/
  extract-all.js        Master ROM data extractor (jobs, items, monsters, spells)
  gen-items-js.js       Generate items.js from ROM
  gen-monsters-js.js    Generate monsters.js from ROM
  gen-spells-js.js      Generate spells.js from ROM
  gen-encounters-js.js  Generate encounters.js from ROM
  map-viewer.html       Interactive ROM map browser
  sprite-viewer.html    NES tile viewer
  sfx-test.html         SFX/music track browser
  tile-browser.html     Tileset inspection
  text-decode.js        Dump item/monster/spell names from ROM
  floor-compare.js      Compare ROM cave maps vs generated floors
```

### Key design principles

- **No copyrighted assets in the repo.** All graphics, music, maps, and text are extracted from the user-supplied ROM at runtime.
- **IPS patches are applied in memory** -- the original ROM file is never modified.
- **Disassembly-verified formulas.** Combat math cross-referenced against ff3-disasm/ff3j.asm.
- **Single-player economy.** All battle earnings (EXP, Gil, CP, JP) divided by 4 since NES designed for 4 party members. Costs stay at NES values.
- **Modular battle system.** Poses in `battlePoses` map, combat math centralized in `battle-math.js`, all hit rolling through unified `rollHits()`.

## Deploy

```bash
./deploy.sh "commit message"
```

Stages, commits, pushes to GitHub, pulls on production server, and restarts via PM2.

## Legal

- **ROM files are not distributed** -- users supply their own copies
- **All engine code is original** -- JavaScript engine, procedural generation, rendering
- **Translation patch** included with credit to Chaos Rush (see `patches/CREDITS-ff3-translation.txt`)
- This is a personal hobby project, not for commercial use
