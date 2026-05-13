# FF3 MMO

A browser-based NES Final Fantasy III engine that extracts all assets from user-supplied ROM files at runtime. No copyrighted data is stored in the repository.

**Live at [ff3mmo.com](https://ff3mmo.com)**

## Status

v1.7.288 — Full combat system, PVP duels, job system with 22 jobs, status effects, procedural dungeons, simulated roster, local chat, FF1-style town shops (keeper sprite on the left + Buy/Sell/Exit on the right + scrolling item list + quantity selector capped by gil/inventory, NES palette fade transition, FF1 NSF shop music, equip-preview HUD portrait + ATK/DEF delta indicator), and a unified spell pipeline (player / ally / PVP-enemy all route through `combatant-cast.js` — cast windup, spell throw, impact, status / heal / damage apply, SFX). White and Black Mage spells cover Cure, Poisona, Fire, Blizzard (SouthWind = Blizzara), Thunder, Sleep, Sight, Drain, Recovery, AllStatus, Instakill, and status cures; offensive throws use per-school target frames + per-spell palette swaps, heal-style spells use the magic-circle + 8-sparkle ring + heal-phase tile flicker captured from the ROM. All game data (items, monsters, spells, encounters, jobs) is extracted from ROM via Data Crystal offsets with NES-verified combat formulas (damage, multi-hit, per-job crit, job-alignment switch cost, magic damage with caster INT/MND, per-side status immunity). Player-facing lists (spells / items / monsters / jobs) render Shrines short-names with the ROM icon byte preserved. Dual-strike combos resolve **RRLL** (right-hand first half, left-hand second half) via the single `battle-math.js` hand-selection helper. Respawn / save behavior is NES-style: position writes are overworld-only, the entry tile of each town / dungeon is captured as the respawn checkpoint, and procedural-dungeon `consumedTiles` wipe on cave re-entry. On defeat, players respawn at the last town gate or cave entrance they walked through on overworld, with full HP/MP.

The 1.7.x line shipped an in-browser **EMU debugger tab** (jsnes-backed; opens via Konami code) with multi-frame OAM/BG capture, 4-slot savestates, a scene-library scaffold (panel + commit flow live; the committed scene set still ships empty), live SRAM read/write, and one-tap magic-grant SRAM presets (`WM SPELLS` / `BM SPELLS` / `ALL SPELLS`) for jumping the running ROM into spell-cast captures. The capture pipeline drove per-weapon slash scatter (bladed deterministic UR→LL, impact RNG-per-hit), the slash-flash hit-gate folded inside `drawSlashOverlay` (single-source miss/shield-block suppression across player / ally / PVP paths, 1.7.48), and the per-spell animation registry in `src/spell-anim.js`, keyed by spell ID with distinct tile bytes per spell. REC OAM cap was raised to 240 frames so multi-second spell anims fit in one capture. The 1.7.18x–1.7.21x band layered a battle-sim CLI (`tools/battle-sim.js`, four shipped phases covering physical / spells / encounters / monster specials), a modularization pass (single-source helpers for physical hits, heal clamping, initiative, slash timing, status flags, message-text steps), and a multiplayer-prep audit series (save-state, inventory + economy, job-EXP, status effects, buffs, death animations, balance) that tightened every mutation seam in advance of the websocket layer. The 1.7.22x band added the **roster Battle search-and-hook flow** (`src/pvp-search.js` — replaces the old instant-accept duel with an AGI-differential hook check + Thief / Ranger job bonus, persistent "Searching..." message with marquee row indicator and X-to-forfeit), modularized the **roster fade** to sync with every map-screen wipe via `_rosterTransFade` (drops the `rosterLocChanged` gate, matches HUD top-box pattern for `'hud-fade-in'` + `topBoxAlreadyBright`), and consolidated the **PVP-enemy turn end** through a single `_advancePVPTurnOrEnd` helper in `pvp.js` so spell / SW / physical paths can't drift on team-wipe detection.

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
- Three ROM files (not included):
  - `Final Fantasy III (Japan).nes` — 524,304 bytes, Mapper 4 (MMC3) — primary game ROM
  - `Final Fantasy (USA).nes` — 262,160 bytes, Mapper 1 (MMC1) — FF1 NSF battle/shop music
  - `Final Fantasy II (Japan).nes` — 262,160 bytes, Mapper 1 (MMC1) — Adamantoise sprite at `0xBF10`

(Prior to v1.7.256 the FF1+II Famicom compilation cart was used in place of the latter two. It was SUROM — extended MMC1 — and jsnes can't bank-switch its upper 256 KB, so the split standalones replaced it.)

## Setup

```bash
npm start
```

Opens `http://localhost:3000`. Load all three ROM files via the file pickers (or click **Start** if they're cached from a previous session).

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
- **Shops** — `shop`, `nes-fade`, `data/shops`
- **Magic** — `spell-cast`, `data/spells`
- **Debug** — `debug/panel`, `debug/bus`, `debug/tabs/{emu,sprites,formation,data,state,log,perf}`, `debug/scenes/*` (Konami / `?debug=1` / `~` to open; jsnes-backed EMU tab with REC N FRAMES + scene library + SRAM editor)
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
