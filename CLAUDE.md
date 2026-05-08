# Project Rules

## CLAUDE CANNOT READ OAM LOGS — HARD PROHIBITION

**Do not author spell, sprite, or animation code derived from REC OAM dumps. The output will be wrong every single time, regardless of how complete the dump is.**

Track record:
- **v1.7.87** — used $59/$5C tiles (damage-number digits) instead of the impact group. Claimed correct. Wrong.
- **v1.7.88** — used WM cast bytes recolored, palette wrong per phase. Claimed correct. Wrong.
- **v1.7.90** — BM cast halo geometry inferred (drew over the player portrait), Fire on-target burst garbled, enemy death wipe broken. Claimed correct. Wrong.

The user has supplied complete frame-by-frame REC OAM captures (origins, palettes, tile IDs, timings) every time. Reading the dump is not the failure point. The failure is mapping group → phase, picking the right tile slot, getting the canvas layout right, and matching frame timing. **Every attempt has been broken.** Past-Claude's confidence ("I see the data, it's all in the dump") is worth zero.

**What to do instead:**
1. **Don't propose tile-byte / frame-timing implementations from OAM dumps.** Even with the entire dump in hand.
2. **Don't refactor working magic / animation code.** v1.7.49 and v1.7.90 are the same failure mode — rewrite working code, ship broken, force a revert.
3. **If asked to add a new spell or animation, surface this rule and ask what the user wants done instead.** Acceptable paths: revert to last-known-good, defer entirely, or restrict Claude's role to plumbing (state machines, dispatch sites, save schemas, item routing, audio cues, message strips).
4. **The plumbing is fine to do.** Just not the pixel data or frame timing from a REC OAM capture.

## Spell-animation hard rules (lessons from the v1.7.49 disaster)

The v1.7.49 spell-anim rewrite was reverted in v1.7.53; the captured Poisona target tiles were re-landed correctly in v1.7.54–v1.7.56. Don't repeat the failure modes that got us there:

- **Don't "improve" or "rewrite" working animation code.** Touch `cure-anim.js` only when the user has reported a specific visual bug.
- **Don't interpret a REC OAM capture as a specific phase** (cast / heal / target effect) unless the user has confirmed which phase the captured frames are from. v1.7.49 wired the on-target Poisona frames to the caster phase because nobody verified.
- **Don't delete imports or constants without grepping every usage in the same file first.** v1.7.50 dropped `OK_*` imports while module-scope `_FP_*` aliases still referenced them; the page wouldn't load past the dev-password gate.
- **Headless-load the live site after every deploy** and grep the console for `ReferenceError|TypeError|SyntaxError|Uncaught` before declaring success. `node --check` doesn't catch orphaned references that fire at module evaluation.
- **When adding a per-spell visual to a magic system, audit ALL render paths** — player-self, player-ally-target, ally-on-player, ally-on-ally, PVP-on-player, PVP-on-ally — and verify each pulls the spell ID from the right source (`getCurrentSpellId()` is the player's cast only; ally-cast paths use `battleSt.allyMagicSpellId`; PVP-cast uses `pvpSt.pvpMagicSpellId`). v1.7.54 missed the ally-cast paths and v1.7.55 had to follow up.

If the user reports a visual bug, believe them and fix or revert — don't argue or re-analyze.

## STOP WASTING TOKENS — Hard Limits

### When the user says something LOOKS wrong visually:
1. **DO NOT trace ROM disassembly.** DO NOT analyze hex offsets. DO NOT read bank data.
2. **Find or ask for a reference image IMMEDIATELY.** Download it. Analyze pixels with python/PIL.
3. **Compare reference pixels against our rendering.** Derive the correct values from the image.
4. **Apply the fix. Done.** Maximum 3 tool calls from "it looks wrong" to fix applied.

### The 3-strike rule:
- If you have made 3 tool calls trying to verify/prove something and still don't have the answer: **STOP.**
- Do NOT make a 4th attempt with a slightly different approach.
- Instead: ask the user, find a reference image, or try the simplest possible fix.

### NEVER do these:
- Spend more than 3 tool calls tracing ROM disassembly for a visual issue
- Launch research agents to "verify" data when the user already told you the answer
- Argue with the user about what something should look like — THEY KNOW, YOU DON'T
- Web search for sprite references when you can just download the actual sprite and analyze it
- Re-verify data you already verified — if it was wrong the first time, your METHOD is wrong
- **NEVER guess ROM offsets for sprite data** — ROM bytes ≠ PPU bytes due to CHR bank switching
- **NEVER use raw ROM offsets (BATTLE_SPRITE_ROM + N) for new sprite frames** — existing frames were mapped by previous devs, new frames MUST be captured from a running PPU (use the EMU tab — see below)

### NEVER GUESS GAME DATA — LOOK IT UP FIRST
- **NEVER state item effects, stats, drop locations, or game mechanics from memory.** Always fetch a primary source first.
- When asked about FF3 NES item/enemy/spell data: **immediately WebFetch a known reference** (shrines.rpgclassics.com/nes/ff3/, guides.gamercorner.net/ffiii/, strategywiki.org, gamefaqs.gamespot.com).
- If you are not 100% certain of a fact, **do not say it** — look it up first.
- One wrong guess wastes more time than fetching the source. **Fetch first, answer second. Always.**

### The user is the source of truth for visual correctness. The ROM is not.

### Where things live — common task starting points

Before writing new code, read the relevant `docs/design-notes.md` section. Each one captures the *why* behind the existing design and surfaces non-obvious invariants.

| Want to add / change… | Read first | Relevant code |
|---|---|---|
| A new spell | `design-notes#magic` | `src/spell-cast.js`, `src/data/spells.js` (`SPELL_MP_COST`, `SPELL_BUY_PRICE`), `src/player-stats.js` (`STARTING_SPELLS`, `grantStartingSpells`) |
| A new spell animation | `design-notes#magic` + PPU capture process below | `src/spell-anim.js` — per-spell registry keyed by spell ID. Drop in tile bytes + phase render functions; render sites dispatch via `drawSpellCasterEffect` / `drawSpellTargetEffect` (no render-site changes needed). |
| A new shop or shop catalog | `design-notes#shops` | `src/data/shops.js` (counter coords + `mapId`), `src/shop.js`, `src/movement.js` (`handleAction` counter lookup) |
| A new battle sprite / job pose | `design-notes#battle-sprite-pattern` + PPU capture process below | `src/sprite-init.js`, `src/combatant-sprites.js` (`getJobPoseTileBundle`, `_genericBundle`), `src/data/<job>-sprites.js` |
| A new monster or fix monster stats | `design-notes#monster-data` | Run `node tools/gen-monsters-js.js > src/data/monsters.js` — **do not hand-edit `monsters.js`** |
| A chest loot pool / item drop | `design-notes#loot-drops` | `LOOT_POOLS` in `src/map-triggers.js`, keyed by `mapId` |
| A status effect or immunity | (see status section in `data/items.js` `sResist`, `data/monsters.js` `statusResist`) | `src/status-effects.js`, `src/battle-enemy.js` (`tryInflictStatus` call sites) |
| A save schema field | `design-notes#saves` | `saveSlotsToDB()` in `src/save-state.js` is the single source of truth — every persisted field flows through there |
| A new attack/slash animation timing | `design-notes#battle-attack-animation` | `src/slash-effects.js` is the single source — `SLASH_FRAME_MS`, `getSlashPattern(weaponId)`, `setSlashOffsetForFrame`, `shouldDrawSlash`, `getSlashHoldMs`, `drawSlashOverlay(ctx, frame, frameIdx, x, y, opts)` (opts: `mirror`, `weaponId`, `hit` — passing `hit` opts into internal miss/shield-block gating; 1.7.48). Player slash machine lives in `src/battle-update.js` (`_updatePlayerSlash`); ally / PVP-opponent paths in `src/battle-ally.js` / `src/pvp.js` consume the same predicate + helpers. |
| Damage / heal number color or bounce | `design-notes#damage--heal-numbers` | `src/damage-numbers.js` — `BATTLE_DIGIT_TILES` (10 8x8 sprites for digits 0-9, ROM `0x1B170` = sprite slots `$56-$5F`), `DMG_NUM_PAL` / `HEAL_NUM_PAL` / `CRIT_NUM_PAL` (slot 2 = fill color), `drawBattleNum`. `DMG_BOUNCE_TABLE` lives in `src/data/animation-tables.js` (33-frame REC OAM trace). |

Deferred work and known followups live in `design-notes.md#followups`. Check there before assuming something is missing — it may be intentionally not yet shipped.

### PPU tile capture — use the EMU tab in the Konami debugger

The Konami code (↑↑↓↓←→←→ X Z Start) opens a tabbed debug panel. The **EMU tab** (`src/debug/tabs/emu.js`) is a jsnes-backed in-browser FF3 emulator with live OAM/BG/CHR capture — it replaces the old FCEUX Lua workflow for any new sprite, monster tile, weapon frame, or palette work.

1. **NES sprites use CHR bank switching (MMC3).** ROM bytes do NOT map 1:1 to PPU tile data — always capture from a running PPU, never hand-translate ROM offsets for new frames.
2. **PPU $0000 = background tiles. PPU $1000 = sprite tiles.** FF3 draws battle monsters as BG tiles (use SNAP BG); player/ally portraits, weapon overlays, slash effects, status anim sprites are OAM sprites at $1000 (use SNAP OAM).
3. **Workflow:** open Konami debugger → EMU tab → play the ROM to the moment you want → PAUSE → click the right capture button. Output lands in the textarea as paste-ready `new Uint8Array([...]),` literals plus PPU palette + origin coords.
   - **SNAP OAM** — groups visible sprites by XY adjacency into clean meta-sprite clusters. Use for portraits, weapon overlays, slash effects, status sprites.
   - **SNAP BG** — dumps nametable + attribute table + unique BG tile patterns with an ASCII grid showing `TT/p` (tile / palette) per cell. Use for monster sprites.
   - **REC OAM / REC BG** — multi-frame capture. Auto-pauses, drives `nes.frame()` forward N times, snaps each frame, dumps a single concatenated block with `// ═══ frame N` dividers. Inputs: `frames` (default 3, max 60), `gap` (frames advanced between snaps; default 1 = consecutive). Tap the active REC button mid-run to cancel. **Use this whenever you need an N-frame animation** (slash anim, spell cast, sprite shake) — single-frame SNAP OAM is too coarse for animations because NES holds each anim state 2–4 frames per pose. v1.7.0+; this is the highest-leverage tool in the EMU tab.
   - **WPN TILES** — dumps PPU $1490–$1600 (sprite-bank slots $49–$60 where battle weapon CHR is decompressed mid-swing). Pause mid-swing, hit the button.
   - **Tile-by-index** — enter `$NN` or decimal in the input field to dump one specific tile.
4. **4 numbered savestate slots (`S1` / `S2` / `S3` / `S4`)** persist to localStorage so you can park multiple captured moments side by side without overwriting. Tap a slot to select; gold border = selected, green text + `•` = populated. SAVE / LOAD always operate on the selected slot.
5. **`SCENES` panel** (collapsed by default) lists curated savestates committed at `src/debug/scenes/*.json` — tap a row's `LOAD` button to jump the emulator to that frame in one tap. **The committed scene set currently ships empty** (`index.json` is `[]`); the panel + commit flow are wired but no canonical moments have been landed yet. To add a scene: pause at the right moment → fill `name` + `description` → tap `EXPORT SCENE` → output textarea fills with the full JSON → `SAVE FILE` (or `COPY` to chat) → commit to `src/debug/scenes/<name>.json` + add metadata to `src/debug/scenes/index.json`. Schema in `src/debug/scenes/README.md`.
6. **Output toolbar** has `COPY` (clipboard with `execCommand` fallback for older WebViews) and `SAVE FILE` (downloads `emu-snap-fNNNN.txt`). Important on mobile where selecting a 50-line textarea is painful.
7. Land the captured `new Uint8Array([...])` blocks in the file that owns that subsystem's tile data — typically `src/data/<job>-sprites.js`, `src/weapon-sprites.js`, `src/slash-effects.js`, or `src/data/monster-sprites.js`. Match the surrounding pattern; don't invent new locations.
8. **Portrait sprites use the top 4 tiles (16×16) of a 2×3 (16×24) body.** Same as idle/hit/victory.

### EMU tab — also has live SRAM read/write

Beyond sprite capture, the same EMU tab exposes the running ROM's FF3J SRAM for testing and verification:

- **STATE** — dumps party (4 chars × 64 bytes at `$6100`/`$6200` — job/level/name/HP/equip) + inventory (32 slots at `$60C0`/`$60E0`). Read-only inspection.
- **Write input** — pokes bytes via `$ADDR=VAL`, `$ADDR: v v v` (block write), or comma-separated. Strips `// comments`. Useful for forcing party state to reproduce a bug.
- **Presets** — `full-HP`, `clear-inv`. Note: SRAM-only writes; values cached at battle start won't update mid-battle.

When in doubt about FF3J SRAM offsets, `src/debug/tabs/emu.js` constants (`SRAM_BASE`, `CHARS_A_OFF`, `CHARS_B_OFF`, `INV_IDS_OFF`, `INV_QTY_OFF`) are the canonical reference.
