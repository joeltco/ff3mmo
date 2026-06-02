# FF3 MMO

A browser-based NES Final Fantasy III engine that extracts all assets from user-supplied ROM files at runtime. No copyrighted data is stored in the repository.

**Live at [ff3mmo.com](https://ff3mmo.com)**

## Status

> **Current status (v1.7.805):** PvE solo combat is **fully server-validated** — encounter rewards (exp/gil/cp/drop) + shops + chests + vases + **chest mimics** all flow through the PvE arbiter + economy arbiter (`docs/PVE-REWRITE-PLAN.md`, shipped + LIVE v1.7.771-783, hardened v1.7.787-794, extended v1.7.796-805 — chest mimic via `createMimicBattle`, `inv-state` non-wire-field strip, mirror seed gap closure, server-atomic trade). Server picks monsters + RNG seed; client runs the battle locally for native-speed UX; server outcome-validates at battle-end via shared monster pools. Backed by the **inventory mirror** (v1.7.740-746) — all 5 original dup vectors closed; V-A trade dup was a partial close in v1.7.745, fully closed v1.7.802 after a 2026-06-01 audit. **PvP duels** server-arbitrated rewrite shipped v1.7.747-757, flags went LIVE v1.7.758, **DISABLED again v1.7.770** pending P-6d anim polish + P-4c magic/items (3-edit re-enable; see `docs/PVP-REWRITE-PLAN.md`). **Co-op party battles** never returned — battle allies are now local AI built from real roster players' stats (`tryJoinPlayerAlly`, v1.7.559), avoiding the cross-phone determinism problem that killed the three prior co-op architectures. **Social MP** (presence, chat, party invites, give-item, Roster Trade with audit log, party persistence across restart) all wire-driven and working. The historical narrative below (1.7.398-1.7.456) describes co-op + PvP combat as they were when first built.

v1.7.456 — **Combat is FF3-style round-based** (the FF4 ATB rewrite that shipped in v1.7.428-v1.7.455 was reverted at user request; play didn't feel right). Round-queue built from initiative rolls at the start of each round, 10-second decision auto-skip per player turn. Real WebSocket presence, real chat over the wire (world by location / party by membership / pm by userId — no spoofing), real PvP duels with server-relayed action sync (seed + action relay + per-turn rand resync + canonical actor-push order; 1v1 and party-PvP), real party invites with bidirectional local mirror (invitee + inviter both auto-pull each other in as ally), mid-battle ally joins synced across clients, graceful flee + disconnect + mismatch recovery, mid-session profile sync. Engine runs on a hybrid `requestAnimationFrame` / Web Worker tick driver — rAF when visible (vsync-aligned, no Chrome-Android stutter), Worker `setInterval` when hidden so the engine stays alive in background tabs for MP sync. Fake `PLAYER_POOL` is empty by default — the world is real-player-only; archived as `_FAKE_POOL` for one-line re-enable. **Co-op layer (1.7.398-1.7.417):** PvP wire emit was previously dead code (`_emitWirePVPAction` unreachable in `updatePVPBattle`) — now wired and `hitResults` rides the wire alongside `damageRoll` / `healAmount` so attacks match across clients; rand resyncs from `seed + turnIndex` at every turn boundary; preflash timer resets on wire arrival so opponent back-swing actually renders; stale `encounterDropItem` is nulled at PvP victory; party-invite invitee mirror; roster row shows kneel pose + sweat overlay when a real player drops below 25% HP; `give-item` wire (heal / cure items used from the pause menu on a real-player roster target apply the same effect on their `ps`, with the existing `_drawCureSparkle` overlay firing on the receiver's portrait + a chat line). **Party co-op random encounters (1.7.418-1.7.421):** party members are actually multiplayer in random monster fights instead of AI-simulated. New `encounter-start` / `-invite` / `-action` / `-end` wire types + `_encounterGroups` server map. Both clients drive the same battle deterministically (seed + canonical actor-push + per-turn rand reseed). All actions (attack / defend / magic / item / run / skip) replay across the wire; wire-driven ally turns wait for the remote player's `encounter-action` via the `ally-wire-wait` state with a 45 s timeout watchdog that flips to AI-fallback on drop. v1.7.421 critical fix: blanket `Math.random → rand()` conversion in `battle-enemy.js` (monster damage/hit/evade rolls were per-client and would've desync'd HP turn one). **Battle Assist (1.7.422-1.7.425):** new red dot on roster rows showing who's currently in combat (`inBattle: 0|1` on the wire profile). New "Assist" roster menu entry — gated on `target.inBattle && same loc`, sends `encounter-assist-request`. Target auto-accepts, ships a full battle-state snapshot (current monster HPs + status mask, peers, seed, turnIndex) over the wire; joiner spawns the same battle locally, mid-flight. Solo target converts to host-of-co-op on the fly. Side-channel `fadeInStartMs` animation drives the new-ally fade-in mid-battle (the classic state-machine `ally-fade-in` pause doesn't fit mid-flight). v1.7.424 audit-driven double-tap dedup on both server (`_encounterGroups` membership check) and target (`battleAllies` userId check), wire-queue defensive clear in `resetBattleVars`, timeout bump 30 → 45 s. **Pre-beta hardening (1.7.387-1.7.397):** WSS payload cap + per-connection rate limit + per-IP connection cap, profile field clamping at the protocol boundary, server-side save schema validation, `/api/login` rate limit + bcrypt-timing-equalization, `/block` + `/report` moderation surface backed by a `reports` SQLite table, JWT revocation via per-user `token_iat_min` watermark + sliding `/api/refresh` (7-day re-issue, 21-day hard cap) + `/api/logout-all` ("Log out other devices" button in the user bar), mobile multi-touch D-pad slide-tracking + `is-touch` class for tablets, first-time-UX auth screen description + ROM picker hint + 6-line in-game tip strip, version-gate cache-bust on stale module mismatch. **Post-launch hostile-client hardening (1.7.426-1.7.427):** per-kind WS rate-limit buckets (`chat` 20/5, `encounter-assist-request` / `encounter-start` / `give-item` / `party-invite` 6/1; global 60/20 stays as backstop) so spamming one kind can't starve others. Identity-pinned peer list in the Battle Assist snapshot — server validates every `peer.userId` against `_connected` + overwrites identity fields with the trusted profile, so a malicious target can't inject ghost identities or impersonate other users. Pure-cleanup defensives: action-key drain on `ally-wire-wait`, dead `isOppVictory` branches deleted from `pvp-drawing.js`, sweat-overlay gated on `fadeStep === 0` so it doesn't float at full opacity during Battle Assist fade-in. Wire regression suite at 49/49 in `tools/pvp-wire-sim.js` (4 PvP + 5 encounter + 4 assist tests added in the v1.7.418-v1.7.425 closeout, +4 hardening tests in v1.7.426). **ATB rewrite reverted (v1.7.456):** the FF4-style ATB system that shipped in v1.7.428-v1.7.455 was reverted in full. Surgical `git checkout` restored the four core battle files (`battle-update.js`, `battle-turn.js`, `battle-ally.js`, `pvp.js`, `battle-encounter.js`) to v1.7.427 state; `src/atb.js` + `src/atb-render.js` + `tools/atb-sim.js` + `tools/atb-fsm-sim.js` deleted; all `atb-sync` / `atb-ready` / `pvp-atb-sync` wire kinds + the server-side `_encounterBattles` tick loop stripped from `ws-presence.js` / `net.js` / `encounter-wire.js`; Battle Speed slider + `SPELL_CAST_TIME` + `setSpeedMod` Haste wire all removed. Non-ATB fixes that landed in the ATB band were preserved: chest msg box (v1.7.446), magic menu opens empty (v1.7.447), chat tab cursor + empty-roster (v1.7.448), enemy x2 glyph (v1.7.449), save validator equipment fields (v1.7.450), staff icon + tab z-order (v1.7.453), boss sprite cleanup + chest-flicker incremental redraw (v1.7.454). Full multiplayer architecture in [MULTIPLAYER.md](MULTIPLAYER.md), audit in [docs/MULTIPLAYER-AUDIT-2026-05-15.md](docs/MULTIPLAYER-AUDIT-2026-05-15.md), per-deploy detail in `CHANGELOG.md` 1.7.366 → 1.7.456.

Full combat system, PVP duels, job system with 22 jobs, status effects, procedural dungeons, simulated roster, local chat, FF1-style town shops (keeper sprite on the left + Buy/Sell/Exit on the right + scrolling item list + quantity selector capped by gil/inventory, NES palette fade transition, FF1 NSF shop music, equip-preview HUD portrait + ATK/DEF delta indicator), and a unified spell pipeline (player / ally / PVP-enemy all route through `combatant-cast.js` — cast windup, spell throw, impact, status / heal / damage apply, SFX). White and Black Mage spells cover Cure, Poisona, Fire, Blizzard (SouthWind = Blizzara), Thunder, Sleep, Sight, Drain, Recovery, AllStatus, Instakill, and status cures; offensive throws use per-school target frames + per-spell palette swaps, heal-style spells use the magic-circle + 8-sparkle ring + heal-phase tile flicker captured from the ROM. All game data (items, monsters, spells, encounters, jobs) is extracted from ROM via Data Crystal offsets with NES-verified combat formulas (damage, multi-hit, per-job crit, job-alignment switch cost, magic damage with caster INT/MND, per-side status immunity). Player-facing lists (spells / items / monsters / jobs) render Shrines short-names with the AWJ ROM-baked icon byte preserved. Dual-strike combos resolve **RRLL** (right-hand first half, left-hand second half) via the single `battle-math.js` hand-selection helper. Respawn / save behavior is NES-style: position writes are overworld-only, the entry tile of each town / dungeon is captured as the respawn checkpoint, and procedural-dungeon `consumedTiles` wipe on cave re-entry. On defeat, players respawn at the last town gate or cave entrance they walked through on overworld, with full HP/MP.

The 1.7.35x band tightened the **map-loader state surface** and unwound a long-standing **shared-UI-palette mistake**. The four map loaders (`_loadRegularMap`, `_loadDungeonFloor`, `loadWorldMapAt`, `loadWorldMapAtPosition`) each maintained a duplicated list of per-map state resets; v1.7.341 added `encounterPatch` / `encounterPatchZone` to the regular-map loader and forgot the dungeon loader, so descending from Ur into the altar cave kept the leftover patch state and spawned overworld monsters underground (`startRandomEncounter`'s patch branch runs before the `altar_cave_fN` branch). v1.7.350 fixed it; v1.7.351 factored every loader through a single `_resetPerMapState()` helper so adding a new per-map field is one line in one place from here forward. v1.7.352–355 restored the canonical NES `$02` dark-blue interior on `drawBorderedBox(blue=true)` — v1.7.309 had flipped `ui.borderBlueTileCanvases` from `[0x02, 0x00, 0x02, 0x30]` to `[0x0F, 0x00, 0x0F, 0x30]` while trying to recolor the roster panel, silently turning every blue-box caller (message-box, shop, trade, inspect) black; v1.7.310 followed up by dropping the matching blue fillRect. Restored the palette + the blue fillRect (with proper `x+8, y+8` inset so rounded corners survive). Shop's confirm box opted out via `(blue=false, transparentEdge=true)` so its existing black look survives — only message-box / trade / inspect went back to blue. The 1.7.34x band reshaped the **new-player onboarding flow**, made **magic a tradable item class**, and added the first **town-interior encounter zone**. New-game spawn is map 7 (the elder's house upstairs) with the elder + 2 attendants, and `mapSt.mapStack` is pre-seeded with the natural ROM door chain `[Ur@(9,26), elder-ground@(12,13)]` so walking out of map 7 lands in the elder's ground floor (map 6) at the stair tile, and walking out of map 6 lands in Ur at the elder's house door — same shape the engine would have pushed if the player had entered from Ur naturally. `topBoxSt` is pre-set to `isTown=true` + Ur name at new-game so the elder house interior inherits the "Ur" top-strip the way Ur's shops already do. Death in Ur respawns at the opening-scene spawn (map 7, 4, 4) with the same chain seed — the elder house is the early-game safe haven. **Starting spells removed** — White / Black / Red Mages no longer receive Cure / Poisona / Sight / Fire / Bzzard / Sleep on job entry. All magic now drops or is bought as a **spell-scroll item** (IDs `0xE0–0xE6`, one per player-castable spell; `learnedSpell: 0xNN` is the bridge). Use a scroll from the inventory and the spell joins `ps.knownSpells` permanently; already-known scrolls refuse but can be traded; wrong-job scrolls refuse too (school-gated via `canLearnSpell`). Inventory rows render through `getSpellNameShrines` so the scroll reads exactly like the spell entry — magic-school icon + 5-char name. The Ur magic shop sells the Pure scroll, Altar Cave F1-F4 each have a rare tier rolling Cure or Sleep scrolls. Ur (map 114) has a flood-fill encounter zone seeded at tile `(22, 8)` running the `grasslands_wild` formation (Werewolves + Bees) — adding tiles to the same patch in ROM extends the zone automatically. Antidote + Eye Drops removed from altar loot pools. The Chaos Rush → AWJ migration was finally purged: `save.js#_migrateNameToAWJ` was treating bytes `$A5` / `$A9` (legit AWJ lowercase 'b' / 'f') as CR sentinels and silently rewriting names with those letters to comma / apostrophe on every load; deleted entirely. `title-screen.js#onNameEntryKeyDown` was still emitting pre-AWJ lowercase bytes (`$CA + ch - 97`); switched to `$A4 + ch - 97`. `npc.js` got a polish pass that collapsed three sprite getters + three NPC record builders + three render branches into one resolver, one factory, and one sprite-class path (boss kept separate — canvas frames not Sprite class).

The 1.7.33x band consolidated all NPC-style sprite rendering through one module. **One single source of truth** (`src/npc.js`) now owns: moogle (Altar Cave wanderer), magic-shop black mage (Ur counter), opening-scene elder + 2 attendants (new map 7 spawn for new players), Land Turtle (boss on altar floor + loading screen), and loading-screen moogle. All NPC sprite assets (`_landTurtleFrames`, `_landTurtleFadeFrames`, `_loadingMoogleFadeFrames`) live behind getters in `npc.js` — boot.js calls setters, consumers (`loading-screen.js`, `map-loading.js`, `render.js`) read via getters. Boss-on-map render moved into `drawNpcs` via `addBossNpc(6, 8)` — `render.js` no longer has a parallel `mapSt.bossSprite` draw block. Opening-scene NPCs render from real FF3 ROM offsets (elder `0x01EC10`, left att `0x01E010`, right att `0x01E210`) — all 16-tile bundles populated, so all 4 directions + 2 walk frames are available. Land Turtle only renders the [normal, flipped] pair (FF3 NES boss is south-only). New `addSceneNpc(key, x, y, spec)` helper unified the cutscene render through the same Sprite class the moogle + BM use. The 1.7.32x band before that fixed dual-wield ATK display + shop/msg-box residual blue. Dual-wield ATK was averaging both weapon ATKs in the equip-screen display (`avg(rWpn, lWpn) + str/2`), which had two visible failure modes: equipping a weaker offhand visibly **lowered** ATK, and swapping that offhand for a shield made ATK go **up**. Switched the display to canon NES: `rWpnAtk + lWpnAtk + floor(str/2)` (sum of both weapons). Combat damage now splits per-hand (RRLL) across player, ally, and PVP-enemy paths via new `rollHits` opts `lAtk` + `splitRH` — each hand rolls at its own weapon ATK + str/2, no more 2× canon stacking. Same band also stripped lingering NES `$02` blue from the shop spell-confirm popup + universal message box (text-shadow palette `[0x02, 0x02, 0x02, 0x30]` → AWJ canonical `[0x0F, 0x10, 0x0F, 0x30]`), and made X / B / Escape dismiss single-page msg boxes (multi-page NPC dialogue still advances on Z only).

The 1.7.29x-1.7.31x band swapped the IPS translation patch from **Chaos Rush → A.W. Jackson** (`patches/ff3-awj.ips`). AWJ ships dedicated per-class item icons inline (`$E0-$F5` for shield / robe / mail / helm / gauntlet / bracer / claw / nunchuck / book / rod / staff / hammer / spear / knife / axe / sword / katana / harp / bow / arrow / bell / boomerang / shuriken), so the seven hand-extracted `*_TILE_BYTES` overrides + matching `*_ITEM_IDS` sets from v1.7.278-285 are gone. Encoding shifted: lowercase a-z $A4-$BD (was $CA-$E3), comma $C0, apostrophe $BF. AWJ encodes 2-tone icons with foreground on color index 1 (icon body) + color index 3 (highlight) — all text palettes (`TEXT_WHITE` etc.) and `_makeFadedPal` now use `[0x0F, 0x10, 0x0F, 0x30]` (light grey body + white accents). Bonus fixes: respawn correctly snapshots the town/dungeon entrance tile (was previously skipping the save), DS-exclusive items' icon bytes remapped to AWJ slots, party chat strictly party-only (system messages excluded), roster inspect overlay redesigned as a compact 120×80 slide-in anchored to the right edge of the HUD viewport showing only equipment, equip-screen typo fixed ("R!Hand" → "R. Hand").

The 1.7.28x band consolidated the **battle message strip** to a single non-blocking surface (animations never wait on text — old gates `msg-wait` / `message-hold` deleted, queue collapsed to one slot with cut-in semantics; strip displays Shrines short-names like `Ice` / `Ice2` instead of raw ROM `Bzzard` / `Bzzra`), and shipped the first **walking NPC** — a moogle on Altar Cave floor 1 routed through the shared `Sprite` class (ROM bank 42, 4-direction walk via `WALK_FRAMES`), FF-style wander loop in `src/npc.js`, and a new multi-page overworld dialogue surface in `src/message-box.js` that scrolls page-to-page through a single persistent box (`showMsgBoxPages`).

The 1.7.x line shipped an in-browser **EMU debugger tab** (jsnes-backed; opens via Konami code) with multi-frame OAM/BG capture, 4-slot savestates, a scene-library scaffold (panel + commit flow live; the committed scene set still ships empty), live SRAM read/write, and one-tap magic-grant SRAM presets (`WM SPELLS` / `BM SPELLS` / `ALL SPELLS`) for jumping the running ROM into spell-cast captures. The capture pipeline drove per-weapon slash scatter (bladed deterministic UR→LL, impact RNG-per-hit), the slash-flash hit-gate folded inside `drawSlashOverlay` (single-source miss/shield-block suppression across player / ally / PVP paths, 1.7.48), and the per-spell animation registry in `src/spell-anim.js`, keyed by spell ID with distinct tile bytes per spell. REC OAM cap was raised to 240 frames so multi-second spell anims fit in one capture. The 1.7.18x–1.7.21x band layered a battle-sim CLI (`tools/battle-sim.js`, four shipped phases covering physical / spells / encounters / monster specials), a modularization pass (single-source helpers for physical hits, heal clamping, initiative, slash timing, status flags, message-text steps), and a multiplayer-prep audit series (save-state, inventory + economy, job-EXP, status effects, buffs, death animations, balance) that tightened every mutation seam in advance of the websocket layer. The 1.7.22x band added the **roster Battle search-and-hook flow** (`src/pvp-search.js` — replaces the old instant-accept duel with an AGI-differential hook check + Thief / Ranger job bonus, persistent "Searching..." message with marquee row indicator and X-to-forfeit), modularized the **roster fade** to sync with every map-screen wipe via `_rosterTransFade` (drops the `rosterLocChanged` gate, matches HUD top-box pattern for `'hud-fade-in'` + `topBoxAlreadyBright`), and consolidated the **PVP-enemy turn end** through a single `_advancePVPTurnOrEnd` helper in `pvp.js` so spell / SW / physical paths can't drift on team-wipe detection.

Networked multiplayer (WebSocket presence, real chat, real PVP, party-ally PvP, party invites) is live — see [MULTIPLAYER.md](MULTIPLAYER.md). Fake `PLAYER_POOL` is exported empty by default; the archived 30-entry roster lives behind `_FAKE_POOL` in `src/data/players.js` for one-line re-enable.

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
- Walking NPCs with FF-style wander (1-3 tile bursts, idle pauses), face the player on Z-talk, multi-page dialogue that scrolls UP between pages through one persistent box (first NPC: a moogle on Altar Cave floor 1 — ROM-extracted sprite from gfx bank 42, talks about dungeon mechanics)
- NSF music playback, SFX system
- Real-multiplayer presence (WebSocket), chat (world / party / pm), PvP (1v1 + party-ally with full action relay and outcome sync), party invites with Z/X accept prompt
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

## Dev tools

Two terminal simulators run the production code paths in Node — no browser, no canvas — so combat math and the multiplayer wire layer can be exercised without spinning up the game.

```bash
# Local combat (1v1 duel, party vs encounter, spell pipelines, status, buffs)
node tools/battle-sim.js --p1=RM7 --p2=BM4 --seed=42
node tools/battle-sim.js --party=KN10,WM4 --boss=land_turtle --turns=15
node tools/battle-sim.js --help

# Multiplayer wire regression harness (31 tests across math / server / E2E)
node tools/pvp-wire-sim.js                     # all suites
node tools/pvp-wire-sim.js --suite=math        # one suite (math|server|wire)
node tools/pvp-wire-sim.js --filter=defend     # substring filter

# Multiplayer load test — N clients × duration, real ws-presence.js in-proc
node tools/pvp-load-sim.js --clients=50 --duration=30
node tools/pvp-load-sim.js --clients=200 --chat-per-min=60
```

`tools/battle-sim.js` (`tools/battle-sim.PLAN.md`) covers local combat — it imports the real `battle-math.js`, `combatant-cast.js`, `status-effects.js`, `data/*` so any divergence between the sim and the engine is a sim bug, not a coverage gap. Statistical mode (`--runs=N --json`) gives win-rate and damage distribution.

`tools/pvp-load-sim.js` spins up the real `ws-presence.js` server in-process and drives N simulated clients through realistic chat / update / location traffic. Spoofs `X-Forwarded-For` per client to bypass the per-IP cap during load tests. Useful for right-sizing rate limits + connection caps from data. Baseline run: 200 clients connect in <200 ms, ~86 KB/client RSS, ~13k msgs/s outbound at chat=20/min/client.

`tools/pvp-wire-sim.js` (`tools/pvp-wire-sim.PLAN.md`) covers the multiplayer wire layer — three suites:

- **Math lockstep** — seeds `rng.js`, runs sender's call, re-seeds, runs receiver's call; asserts identical output. Catches RNG-cursor drift that would desync two clients.
- **Server unit** — calls `ws-presence.js` internals via a test-only `_testHooks` export (profile clamps, hook-chance formula, party-membership lookup, rate-limit bucket).
- **End-to-end** — boots `attachWebSocketPresence` on a localhost port and connects two real JWT-authed `ws` clients; drives scripted scenarios (actor relay, mismatch recovery, location cleanup, PM routing, ally-join profile, party-chat scoping, rate-limit burst).

Exit 1 on any failure. `deploy.sh` runs both lint + wire-sim as pre-flight gates before commit. See `docs/MULTIPLAYER-AUDIT-2026-05-15.md` for the audit each test maps back to.

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
patches/          ff3-awj.ips (A.W. Jackson translation, applied at runtime)
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
- **Translation patch** — A.W. Jackson / Neill Corlett / SoM2Freak (1999) shipped at `patches/ff3-awj.ips`, with credit in `patches/CREDITS-awj.txt`. Earlier versions used Chaos Rush v1.3 (`CREDITS-ff3-translation.txt`, retained for historical attribution)
- This is a personal hobby project, not for commercial use
