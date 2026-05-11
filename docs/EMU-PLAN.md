# EMU debugger — improvement plan

Tracks the audit findings from `docs/design-notes.md` discussion. Phase 0 is mobile-quality-of-life; Phases 1–3 are the high-leverage trio (named scenes, diff-against-file, multi-frame capture); Phases 4+ are polish/harden.

Each phase is mergeable on its own. Bumps `package.json` + a CHANGELOG entry per release per the deploy convention.

## Status (as of v1.7.219)

| Phase | Status | Released |
|---|---|---|
| 0 — mobile QoL + capture race | ✅ shipped | v1.6.96 |
| 1.1 — multi-slot savestates | ✅ shipped | v1.6.97 (+ aliasing fix v1.6.98) |
| 1.2 — scene library framework | ✅ shipped | v1.6.99 |
| 1.3 — scene capture flow (`EXPORT SCENE`) | ✅ shipped | v1.6.99 |
| 1.4 — initial committed scenes | ⚪ still pending as of v1.7.219 — `src/debug/scenes/index.json` ships `[]`; `SCENES` panel renders empty | — |
| 2 — DIFF-AGAINST-FILE | ⚪ still pending as of v1.7.219 — no diff panel landed | — |
| 3 — REC N FRAMES (multi-frame OAM/BG) | ✅ shipped | v1.7.0 (cap raised 60→240 in v1.7.9) |
| 4 — polish & harden | ⚪ partial — auto-pause on capture done in v1.6.96; rest pending | — |
| 5 — nice-to-haves | ⚪ deferred | — |

**Plan status:** The high-leverage core (REC N FRAMES + multi-slot savestates + scene framework) shipped and unblocked all subsequent sprite/anim/spell capture work — see "Adjacent work" below for the cascade. The remaining EMU-internal items (initial scene commits, DIFF-AGAINST-FILE, polish bag) have been deprioritized while v1.7.5x–v1.7.21x focused on actually consuming the capture pipeline (Cure/Poisona/Fire/Blizzard/etc. spell animations, parity harness `tools/parity-check-spell.js`, modularization passes, audit work). Pull individual remaining items forward when a specific session needs them.

SRAM-preset extension (out-of-plan, drove the magic-capture phase):
- v1.7.6 — `WM SPELLS` / `BM SPELLS` / `CALL SPELLS` preset buttons on the PARTY/INVENTORY editor; pokes job + level + MP + spell-list bytes for a one-tap "ready to cast" loadout
- v1.7.7 — fix: spell-list bytes are a per-level bitfield (`bits 0-2 = black, 3-5 = white, 6 = summon`), not raw spell IDs
- v1.7.8 — `CALL SPELLS` replaced with `ALL SPELLS` (`0x7F` mask + Sage job); `WM` / `BM` bit assignments unswapped

Adjacent work driven by REC N FRAMES captures:
- v1.7.1 — per-weapon slash scatter table (PPU-derived); pattern + helpers in `slash-effects.js`
- v1.7.2 / 1.7.3 — slash skip on miss across PVP / player / ally paths
- v1.7.4 — slash logic consolidated (`SLASH_FRAME_MS`, `shouldDrawSlash`, `getSlashHoldMs` single-sourced)
- v1.7.10–1.7.20 — full PPU-captured Cure animation. `src/cure-anim.js` owns tile bytes, decode, frame builders, and phase boundaries (build-up 800 ms → lunge 200 ms → cast 217 ms → heal 283 ms → return 167 ms; total 1667 ms). 1.7.13 corrected the 8-sparkle ring to a static body-relative position. 1.7.14 / 1.7.16 wired a real cast SFX — `MAGIC_CAST = 0x62`, verified against `everything8215/ff3` disasm at 33/B0D8 (black) and 33/B0FF (white). 1.7.17 derived ring spin rate (~5°/NES-frame → 1200 ms/turn) from inter-frame OAM angles. 1.7.20 pinned naming: rotating tiles are **stars**, the pulsing thing left of the caster is a **flame**. v1.7.54–v1.7.56 extended the module with per-school target frames (`poisonaTargetFrames` for cure_status spells, captured 2026-05-06 from REC OAM band `$49–$50`); see the v1.7.49 entry below for the failed registry rewrite that almost cost us the working Cure animation.
- v1.7.21 — every OAM/BG snap now leads with a `_dumpPpuctrl()` block (sprite size, sprite bank, BG bank, base NT — annotated against the snapshot's hardcoded $1000/$0000/$2000 reads) and a `_dumpSfxStrip()` block reading FF3J's `$7F49` SFX queue (translates a non-zero high-bit byte to its `music.js` NSF track number, `byte − 0x3F`). Closes the last "leave the EMU tab to read disasm" step in the magic-cast pipeline — future spell SFX numbers come from REC OAM headers instead of `LDA #$XX / STA $7F49` searches. Also fixed a latent grouping merge-bug in `_oamSnapshotText` (`groups[merged]` after splice resolved to the wrong element when `g < merged`); now tracks the merged group by reference.
- v1.7.47–1.7.50 — REC OAM-driven cleanup pass:
  - **1.7.47** — death tiles are at `jobBase + 0x240` for all 22 jobs (verified byte-for-byte against captured OK/WR/MO_DEATH); `_genericBundle` reads them from ROM. Fixes the "WM ally death pose shows mirrored idle" bug.
  - **1.7.48** — slash hit-gate folded inside `drawSlashOverlay` (`opts.hit` short-circuits via `shouldDrawSlash`; caller-side wraps no longer required). Fixes "missed PVP swing flashes slash on user portrait".
  - **1.7.49 (REVERTED in 1.7.53)** — attempted to replace `src/cure-anim.js` with a `src/spell-anim.js` registry keyed by spell ID. Theory: REC OAM showed Cure and Poisona using entirely different tile bytes, so the shared "flame + palette swap" model in `cure-anim.js` was wrong. Reality: the captured Poisona tiles were the on-target effect frames, not caster frames; v1.7.49 wired them to the caster phase, replacing the working flame+stars build-up with a static overlay. The 1.7.10–1.7.20 "Cure animation" entry above is the canonical model; v1.7.49 is the cautionary tale. v1.7.54 brought the captured Poisona target tiles back into `cure-anim.js` as `poisonaTargetFrames`, wired to the *target* during the heal phase — the architecture is now per-school palette swap on the caster + per-school target frames.
  - **1.7.50** — removed the now-redundant `OK_DEATH` / `WR_DEATH` / `MO_DEATH` byte constants and the 295-line dead legacy sprite-init branch (`_initFakePosePortraits`, `_buildIdleFullBodies`, etc.). All 22 jobs flow through `_buildFakePlayerSet` → `getJobPoseTileBundle`.

Capture pipeline downstream (v1.7.54–v1.7.219), summarized — see CHANGELOG.md for the per-version detail:
- v1.7.54–v1.7.56 — Poisona target frames re-landed in the right phase + ally-cast paths fixed + canvas dimensions corrected.
- v1.7.87–v1.7.94 — Fire spell disasters (v1.7.87 / v1.7.88 / v1.7.90) followed by the **OAM parity harness** (`tools/render-oam-dump.js` + `classify-spell-phases.js` + `parity-check-spell.js`), which is now the canonical path from REC OAM capture → spell-anim tile bytes. Don't hand-author from a dump; run the harness.
- v1.7.100 — Fire shipped via harness; architecture (cast=per-job, projectile=shared, on-target=registry) became the per-spell template.
- v1.7.150–v1.7.181 — spell pipeline unified across player / ally / PVP-enemy via `src/combatant-cast.js` (`drawCastWindup`, `drawSpellThrow`, `applySpell`, `applyMagicDamage/Status/Heal/CureStatus/Sight/Drain/Recovery/AllStatus/Instakill/Erase`, `getSpellImpactSFX`).
- v1.7.18x–v1.7.20x — battle-sim CLI (`tools/battle-sim.js`, 4 shipped phases) + modularization passes (single-source helpers for physical hits, heal clamping, initiative, slash timing, status flags, message-text steps).
- v1.7.21x — multiplayer-prep audit series (save-state, inventory + economy, job-EXP, status, buffs, death animations, balance) closing out non-EMU surface.

User feedback (v1.7.0 retro): **REC N FRAMES is the highest-leverage feature in the EMU debugger.** Future EMU work should weight ideas by how much they extend the capture pipeline. The DEDUPE toggle (Phase 4.6 below) is the obvious next-leverage move on REC itself — NES holds anim states 2–4 frames per pose, so a 20-frame REC produces ~4–6 actually distinct states. DEDUPE collapses identical consecutive frames into one block with a `// frames 0..3 (4× same)` header, cutting textarea length 60–70 % and making transitions jump out.

**Constraints baked into every phase:**

- Test target is **mobile browser over SSH**. No keyboard-only paths; tap targets ≥ 34 px; new panels collapsible (`<details>`) so they don't crowd the viewport.
- Output stays paste-ready (`new Uint8Array([...])`) — never invent a new export format that breaks the existing copy-paste workflow.
- Capture must be **deterministic** — auto-pause emulator during a snap so a frame-tick mid-read can't corrupt bytes.
- New buttons go in the existing capture row or under collapsible `<details>` — the always-visible UI stays compact.

---

## Phase 0 — Mobile polish + capture race fix

Cheap wins that make the rest of the work usable on a phone. ~1 hr.

### 0.1 `COPY OUTPUT` button
- Add a single tap-to-copy button above the output textarea. Uses `navigator.clipboard.writeText(dom.output.value)` with a fallback to selecting + `execCommand('copy')` for older WebViews.
- Status flash: button text `COPY` → `COPIED ✓` for 800 ms.
- **Why mobile-critical:** selecting a 50-line textarea on touch is painful; this is the difference between "usable" and "not".

### 0.2 `SAVE FILE` button
- Generates a data-URL `text/plain` blob with the current output, filename `emu-snap-f${frameCount}.txt`. Triggers download via `<a download>` click.
- Useful when copy is flaky (some mobile browsers refuse clipboard for non-HTTPS contexts).

### 0.3 Mute button visual state
- When sound is on, button border turns `#3a8a3a` (green). When muted, default grey. Button text already toggles `SOUND` / `MUTE` — color makes it scannable at a glance.

### 0.4 Capture auto-pauses emulator
- `_snapshotOAM`, `_snapshotBG`, `_dumpWeaponTiles`, `_dumpTileByIndex` set `wasRunning = running`, call `_stop()`, do the read, then `if (wasRunning) _start()`.
- Eliminates the half-old / half-new tile race. Inserts a single dropped frame, which is fine — captures are intentional.

### 0.5 ESC scoped to overlay chrome
- `panel.js` `keydown` ESC closes only when `document.activeElement` is not inside an `<input>` / `<textarea>`. Prevents losing typed write-bytes when ESC sneaks through.

**Files:** `src/debug/tabs/emu.js`, `src/debug/panel.js`.
**DoD:** All five bullets shipped, mobile-tested by the user, single CHANGELOG entry.

---

## Phase 1 — Named savestate scenes

Replace single-slot localStorage savestate with a committed scene library. Highest leverage feature for SSH-pair work — lets me load any captured moment without asking the user to navigate there.

### 1.1 Multi-slot savestates (UI only)
- 4 numbered slots: `S1 / S2 / S3 / S4`. Each slot is its own SAVE / LOAD pair with a mini status line showing `frame N` or `empty`.
- Persisted at `localStorage[ff3_emu_savestate_slot_${i}_v1]`.
- Existing single-slot key migrates to slot 1 on first load.

### 1.2 Scene library directory
- New dir `src/debug/scenes/` with one JSON file per canonical moment. Each file is the slim savestate (no `romData`) plus a metadata header:
  ```json
  {
    "name": "ur-magic-shop",
    "description": "Standing at counter, magic catalog hovered on Cure",
    "captured": "2026-05-04",
    "frame": 12345,
    "state": { /* slim jsnes.toJSON output */ }
  }
  ```
- New tab section "SCENES" (collapsed `<details>`) lists every scene as a tappable button. Tap → loads the state into the running emulator.

### 1.3 Scene capture flow
- New `EXPORT SCENE` button next to the slot row: prompts for a name + description, writes the JSON to the output textarea (paste-ready for committing into `src/debug/scenes/`).
- Loader is async-imported via `import.meta.glob('./scenes/*.json')` (Vite-style) or a manifest file `src/debug/scenes/index.json` listing all entries — depends on bundler. Fall back to manifest if `import.meta.glob` is unsupported.

### 1.4 Initial scene set
- Capture 4–6 canonical scenes during this phase (target: ones the followups list needs):
  - `wm-l-back-swing.json` — White Mage staff L-hand back-swing mid-frame
  - `bm-cast-pose.json` — Black Mage spell-cast wind-up
  - `monk-fist-strike.json` — unarmed R-hand impact frame
  - `ur-magic-shop.json` — counter open, Cure hovered
  - `landturtle-roar.json` — boss intro for grayscale strobe verification
  - `crystal-room-warp.json` — star spiral effect

**Files:** `src/debug/tabs/emu.js`, new `src/debug/scenes/*.json`, possibly new `src/debug/scenes/index.json`.
**Mobile note:** scene buttons use the same wrap-flex pattern as the capture row; descriptions render as title attributes (long-press preview on iOS, ignored elsewhere).
**DoD:** can load any committed scene in one tap; a fresh user with no savestate sees the curated list.

---

## Phase 2 — DIFF-AGAINST-FILE

The killer feature for catching hand-typed byte drift (root cause of 1.6.11, 1.6.41, 1.6.54, 1.6.57).

### 2.1 Diff panel
- New collapsible `<details>` section "TILE DIFF" below the editor. Inside:
  - A textarea to paste an existing `Uint8Array([0x00, ...])` literal (or just hex bytes).
  - Buttons: `DIFF VS PPU TILE` (asks for a tile index), `DIFF VS LAST OAM SNAP` (uses cached snap), `DIFF VS BG SNAP`.
- Output renders as a 16-byte aligned table:
  ```
  byte  file    PPU    diff
  [00]  0x00    0x00
  [01]  0x06    0x07   ← off by 1
  [02]  0x0A    0x0A
  ...
  ```
- Mismatches highlighted in red; matches in dim grey; identical = "✓ match" line at top.

### 2.2 Bytes parser
- Accepts:
  - `new Uint8Array([0x00,0x06,...])` paste
  - `0x00 0x06 ...` whitespace-separated
  - `00 06 ...` raw hex
- Strips JS comments, trailing commas, surrounding `]),`. Errors are explicit ("expected 16 bytes, got 14").

### 2.3 File picker (stretch)
- "PICK FROM `src/data/*-sprites.js`" — fetches the file via the dev server, parses out all `Uint8Array([...])` literals, presents a searchable list. Tap a literal → diffs against current PPU state.
- Stretch because parsing JS source in the browser is fiddly. Acceptable v1: just paste.

**Files:** `src/debug/tabs/emu.js`. Possibly a small `src/debug/byte-parser.js` module if it grows past ~30 lines.
**Mobile note:** the byte table uses `font-size: 10px; font-family: monospace` and wraps at 4 bytes per row on `< 480 px` viewports.
**DoD:** user can paste any existing tile bytes from `src/data/*` and immediately see whether the running ROM matches.

---

## Phase 3 — Multi-frame capture (`REC N FRAMES`)

Solves the 3-frame staff slash, spell anims, and any future N-frame animation work.

### 3.1 REC button
- Inputs: `frames=3` (default), `gap=1` (default — record every Nth frame). Both numeric inputs in a single row beside the button.
- Behaviour: on click, pause if running → loop `frames` times: capture meta-sprite groups (re-using `_snapshotOAM` internals), advance `gap` frames, capture again. Output is a single textarea dump with each frame's groups labelled `// ── frame 0 (snap @ f12345) ──`.

### 3.2 Per-frame output format
- Each frame block contains:
  - The frame's OAM palette (in case it changed mid-anim)
  - All groups with origin + dimensions
  - Each tile as `new Uint8Array([...]),`
- Identical tiles across frames are still emitted (don't dedupe — consumer code may want them per-frame addressable).

### 3.3 Cancel / progress
- During REC, button text → `REC 1/3 …`. Tap again to cancel mid-record. Status line shows progress.

### 3.4 BG variant
- `REC N FRAMES (BG)` companion button does the same loop but calls `_bgSnapshotText`. Useful for monster intro animations (they're BG tiles).

**Files:** `src/debug/tabs/emu.js`. Refactor: extract the OAM/BG dump bodies into pure `_oamSnapshotText()` / `_bgSnapshotText()` helpers (BG already has one) so the REC loop calls them in a tight loop.
**Mobile note:** REC button takes one row; frames + gap inputs share a row below.
**DoD:** capturing a 3-frame staff slash produces one paste-ready block ready to drop into `src/slash-effects.js`.

---

## Phase 4 — Polish & harden

Each item is small enough to land in any single release; group as it makes sense.

### 4.1 Audio sample rate fix
- Initialise `audioCtx` *before* `nes` ctor. Pass `audioCtx.sampleRate` as `sampleRate` to `jsnes.NES({...})`. Eliminates the 9 % pitch shift.
- If audio is starting muted (which it does), defer ctx creation until first `_toggleSound()` — at which point we know the rate. Reset jsnes sampleRate via `nes.opts.sampleRate = ...` if it exposes one; otherwise rebuild jsnes (since muted-boot rarely matters for ear-checks).

### 4.2 Audio dropout counter
- `audioWrite === audioRead` lap drops a sample. Increment a counter; render `drops: N` in the status row. When N > 0 and growing, you know audio's lagging.

### 4.3 Reset recovery
- Wrap the `nes.reset() + mmap.loadROM() + ppu.setMirroring()` in a try/catch that calls `_initEmulator(romBuffer)` from scratch on failure. Eliminates the "stuck dead" state where running stays false and the user has to refresh.

### 4.4 Transactional memory writes
- `_applyWrites` parses *all* lines first into an `edits` array; only commits if the entire parse succeeds. No partial writes on a typo at line 4.
- Address-bound check: `(addr + k) <= 0xFFFF`, else status error "address out of range".

### 4.5 OAM grouping constants
- Lift `8`, `24`, `0xF0` to named constants at the top of the snapshot section with a one-line comment each.

### 4.6 Capture history (3-deep)
- Toggle `APPEND` on the output textarea. When on, new captures `\n\n// ── capture N ──\n` separator + append. Off (default) replaces.

### 4.7 IPS toggle
- Checkbox `USE IPS` (default on). When off, `_patchAndInit` skips the fetch + apply and boots the raw ROM. Useful for verifying patched-only behaviour.

### 4.8 Frame `[` `]` stepping (desktop bonus)
- `[` = back 1 frame (no-op for now since jsnes doesn't support reverse), `]` = step forward 1.
- v1: just `]`. Add `[` later if rewind ever lands.
- Mobile parallel: existing STEP button is unchanged.

**Files:** all `src/debug/tabs/emu.js`.
**DoD:** ship as 4–6 small CHANGELOG entries; no single one rewrites the file structure.

---

## Phase 5 — Nice-to-haves (deferred)

Lower priority. Pull forward if a specific debugging session needs them.

- **Address watchlist** — pinned `$ADDR` cells, live values per frame, in the editor `<details>`.
- **OAM diff-since-last-snap** — visual highlight of changed sprites between two snaps.
- **Auto-pause condition** — dropdown of common triggers ("on next OAM at y < N", "on PPU palette write to $3F11") — implemented as a per-frame check after `nes.frame()` returns.
- **CHR bank inspector + dump-all-banks** — read MMC3 bank registers, dump all 8 sprite banks at one click.
- **OAM / VRAM editor** — text-input writes to PPU memory the same way the SRAM editor writes to CPU memory.
- **AudioWorkletNode migration** — replace the deprecated ScriptProcessorNode. Non-trivial; do when it actually breaks.

---

## Companion docs (separate from EMU code)

These are touchpoints with the rest of the docs system, not EMU work proper. List here so they don't get lost.

- **`src/debug/README.md`** — describes each tab, button, and the FF3J SRAM layout. Discoverability for fresh-start sessions.
- **`docs/chr-bank-map.md`** — per-scene CHR bank notes ("Ur magic shop = MON $24 + FX $30"). Lets capture campaigns be planned, not guessed.
- **`tools/audit-sprites.js`** — out-of-EMU script that walks every `Uint8Array([...])` literal in `src/data/`, compares against canonical reference (ROM or curated capture), flags drift. Built on the EMU tab's `_encodeTile` primitive.

---

## Order of operations

1. Phase 0 — ship as one release (mobile QoL).
2. Phase 1 — ship multi-slot first; then scene library; then commit initial scenes one per release.
3. Phase 2 — diff panel as one release; file picker as a follow-up release.
4. Phase 3 — REC N FRAMES as one release.
5. Phase 4 — pull individual items into any spare release; no single Phase-4 release needed.
6. Phase 5 — opportunistic.

Companion docs land whenever the corresponding code does (e.g. `src/debug/README.md` lands at end of Phase 1 once the tab is meaningfully bigger than today).
