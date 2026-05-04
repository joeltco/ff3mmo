# EMU debugger — improvement plan

Tracks the audit findings from `docs/design-notes.md` discussion. Phase 0 is mobile-quality-of-life; Phases 1–3 are the high-leverage trio (named scenes, diff-against-file, multi-frame capture); Phases 4+ are polish/harden.

Each phase is mergeable on its own. Bumps `package.json` + a CHANGELOG entry per release per the deploy convention.

## Status (as of v1.7.4)

| Phase | Status | Released |
|---|---|---|
| 0 — mobile QoL + capture race | ✅ shipped | v1.6.96 |
| 1.1 — multi-slot savestates | ✅ shipped | v1.6.97 (+ aliasing fix v1.6.98) |
| 1.2 — scene library framework | ✅ shipped | v1.6.99 |
| 1.3 — scene capture flow (`EXPORT SCENE`) | ✅ shipped | v1.6.99 |
| 1.4 — initial committed scenes | ⚪ pending | — |
| 2 — DIFF-AGAINST-FILE | ⚪ pending | — |
| 3 — REC N FRAMES (multi-frame OAM/BG) | ✅ shipped | v1.7.0 |
| 4 — polish & harden | ⚪ partial — auto-pause on capture done in v1.6.96; rest pending | — |
| 5 — nice-to-haves | ⚪ deferred | — |

Adjacent work driven by REC N FRAMES captures:
- v1.7.1 — per-weapon slash scatter table (PPU-derived); pattern + helpers in `slash-effects.js`
- v1.7.2 / 1.7.3 — slash skip on miss across PVP / player / ally paths
- v1.7.4 — slash logic consolidated (`SLASH_FRAME_MS`, `shouldDrawSlash`, `getSlashHoldMs` single-sourced)

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
