# FF3 MMO

A browser-based NES Final Fantasy III engine that extracts all assets from user-supplied ROM files at runtime. No copyrighted data is stored in the repository.

**Live at [ff3mmo.com](https://ff3mmo.com)**

## Status

v1.6.9 — Full combat system, PVP duels, job system with 22 jobs, status effects, procedural dungeons, simulated roster, and local chat. All game data (items, monsters, spells, encounters, jobs) extracted from ROM via Data Crystal offsets with NES-verified combat formulas (damage, multi-hit, per-job crit, job-alignment switch cost, magic damage with caster INT, per-side status immunity). On defeat, players respawn at the last town they visited with full HP/MP.

Networked multiplayer (WebSocket presence, real chat, real PVP) is planned — see [MULTIPLAYER.md](MULTIPLAYER.md). The current roster is populated from a fake player pool.

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
- Simulated roster (fake player pool), local chat with tabs
- Email auth, server saves (IndexedDB + DigitalOcean)
- Title screen with NES fade, airship chase-drift physics, CRT filter option

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

Top-level:

```
index.html        Entry point, ROM loading, IndexedDB cache, konami debug viewer
server.js         Production server (Express, JWT auth, SQLite saves, HTTPS)
debug-server.js   Dev server (no-cache, boss room debug spawn)
deploy.sh         One-command deploy to production
src/              ~70 ES modules — see below
src/data/         ROM-extracted game data (items, monsters, jobs, spells, encounters)
patches/          ff3-english.ips (Chaos Rush v1.3, applied at runtime)
lib/              libgme.js (Emscripten NSF playback)
tools/            ROM extractors, map/sprite viewers, debug utilities
```

`src/main.js` is the composition root — imports and wires subsystems, ~150 lines. Everything else lives in one of these concerns:

- **Battle** — `battle-math`, `battle-turn`, `battle-ally`, `battle-enemy`, `battle-encounter`, `battle-drawing`, `battle-items`, `battle-update`, `battle-state`, `status-effects`, `pvp`
- **Sprites** — `sprite-init`, `weapon-sprites`, `slash-effects`, `damage-numbers`, `boss-sprites`, `monster-sprites`, `flame-sprites`, `job-sprites`, `fake-player-sprites`
- **Rendering** — `render`, `hud-drawing`, `hud-init`, `map-renderer`, `world-map-renderer`, `loading-screen`, `title-screen`, `transitions`, `water-animation`
- **State** — `ui-state`, `hud-state`, `map-state`, `battle-state`, `inventory`, `player-stats`, `player-sprite`, `save-state`
- **World** — `map-loader`, `map-loading`, `map-triggers`, `world-map-loader`, `dungeon-generator`, `movement`
- **Audio** — `music`, `nsf-builder`, `ff1-nsf-builder`
- **Social** — `chat`, `roster`, `message-box`
- **ROM/text** — `rom-parser`, `ips-patcher`, `text-decoder`, `text-utils`, `font-renderer`, `tile-decoder`, `tile-math`, `palette`

See `docs/history/REFACTOR.md` for the history of how the monolithic `game.js` was decomposed into these modules, and `src/*.js` files for current details.

### Key design principles

- **No copyrighted assets in the repo.** All graphics, music, maps, and text are extracted from the user-supplied ROM at runtime.
- **IPS patches are applied in memory** -- the original ROM file is never modified.
- **Disassembly-verified formulas.** Combat math cross-referenced against ff3-disasm/ff3j.asm.
- **Single-player economy.** All battle earnings (EXP, Gil, CP, JP) divided by 4 since NES designed for 4 party members. Costs stay at NES values.
- **Modular battle system.** Poses in `battlePoses` map, combat math centralized in `battle-math.js`, all hit rolling through unified `rollHits()`.

## Legal

- **ROM files are not distributed** -- users supply their own copies
- **All engine code is original** -- JavaScript engine, procedural generation, rendering
- **Translation patch** included with credit to Chaos Rush (see `patches/CREDITS-ff3-translation.txt`)
- This is a personal hobby project, not for commercial use
