# Mobile vs PC audit

Snapshot of every divergence between mobile (touch / `isMobile` / `@media (max-width:520px)`) and desktop in ff3mmo as of v1.7.784. Goal: prove no silent gaps, document each intentional fork, flag latent risk.

**Result:** 18 divergences. All intentional. All gated by a single source. No silent gaps.

## Divergence map

| # | Category | Mechanism | Files |
|---|---|---|---|
| 1 | Mobile detection | OR of `ontouchstart` / `navigator.maxTouchPoints > 0` / `matchMedia('(pointer:coarse)')` / `matchMedia('(hover:none)')` / UA regex (Android/iPhone/iPad/Mobile/Silk/KFRAWI/Tablet). Silk + KFRAWI catch locked-down Fire Kids Tablet where touch events are suppressed. | `src/ui-state.js:37-43` |
| 2 | Touch deck → synthetic key events | `#mobile-controls` buttons carry `[data-key="..."]`; multitouch slide handler tracks per-finger position, dispatches synthetic `KeyboardEvent('keydown'/'keyup', {key})` + toggles `.pressed`. Single code path handles keyboard + touch downstream. | `index.html:326-338, 1269-1349` |
| 3 | Mobile keyboard polling | Hidden `<input id="mobile-input" type="password">` polled @ 80ms via `getMobileInputMode()` (returns `'chat'`/`'name'`/`'none'` based on `chatState.inputActive` + `titleSt.state`). Focuses to summon iOS/Android keyboard; converts each char/Backspace/Enter to synthetic key events. | `index.html:1222-1248`, `src/main.js:269-271` |
| 4 | Layout media queries | `@media (max-width:520px)` hides `#controls-hint`, flushes outer gaps, scales canvas to `100vw × calc(100vw * 480/512)`. | `index.html:169-196` |
| 5 | Tablet override | Wider devices (> 520px) still get the touch deck via `body.is-touch` class (set when `isMobile` is true). Decoupled from viewport width so iPads / Fire HD aren't left without buttons. | `index.html:326-338, 752` |
| 6 | Tap-style suppression | `touch-action: manipulation` on canvas (kills double-tap zoom + 300ms tap delay, preserves pinch-zoom), `touch-action: none` on buttons, `-webkit-tap-highlight-color: transparent` on every mobile button, `-webkit-touch-callout: none` on canvas (suppresses iOS long-press magnifier), `user-select: none` on deck. | `index.html:48-49, 151, 203-204, 253-255, 281, 318-320` |
| 7 | Audio gesture unlock | `unlockAudio()` (creates + resumes shared `AudioContext`) is wired once to `pointerdown` / `touchend` / `keydown`. Mobile autoplay policy blocks audio until first gesture; desktop policy varies but the same wiring is harmless. | `src/music.js:172`, `src/main.js:243-251` |
| 8 | Storage persistence request | `_requestPersistentStorage()` calls `navigator.storage.persist()` on first `pointerdown` / `touchstart` / `keydown`. Posts result to `/api/storage-beacon` for telemetry. Mobile Firefox requires explicit gesture to upgrade origin from session-only to durable. | `index.html:1039-1072` |
| 9 | Tap-to-enter splash (LOAD-BEARING) | `#pw-gate` overlay shown even when `GATE_PASSWORD=""`. Tap-to-start splash gates IndexedDB access behind a user gesture — without it, mobile Firefox classifies the origin as session-only and ROMs evaporate on tab close. See `[[ff3mmo-storage-gesture-rule]]`. | `index.html:980-1002` |
| 10 | iOS PWA hint | "Add to Home Screen" hint surfaces only when `/iPhone|iPad|iPod/.test(UA) && !navigator.standalone`. iOS Safari denies persistent storage unless installed as PWA. | `index.html:1021-1027` |
| 11 | iOS file picker (HARD RULE) | ROM `<input type="file">` elements (`#rom-file`, `#rom-file-ff1`, `#rom-file-ff2`) have NO `accept=` attribute. iOS Safari uses UTI filtering; `.nes` has no registered UTI → setting `accept=".nes,..."` silently hides every ROM file. See `[[ff3mmo-ios-file-accept]]`. | `index.html:555-570` |
| 12 | Yes/no labels | `yesNoLabels()` returns `'A=ok B=no'` on mobile, `'Z=ok X=no'` on desktop. Single source for every `showMsgBoxPrompt` caller. Underlying key codes don't change — mobile deck maps button-A to `data-key="z"` and button-B to `data-key="x"`. | `src/message-box.js:47-49` |
| 13 | Title screen prompt | `pressZ` label set at startup to `'Tap to play'` on mobile, `'Press Z'` on desktop. | `src/main.js:290` |
| 14 | Loading screen prompt | Mobile-specific prompt bytes selected from `isMobile` branch. | `src/loading-screen.js:129` |
| 15 | Chat-close cooldown | `_chatClosedAt` timestamp stamped on Enter/Escape close. `chatJustClosedRecently()` (250ms window) lets the pause-menu Enter handler suppress itself so the auto-repeat keydown after sending a chat message doesn't pop the pause menu. Mobile-specific because mobile keyboards generate repeat events on commit. | `src/chat.js:744-780` |
| 16 | Game-loop tick strategy | rAF when tab visible (caps at ~60Hz to throttle 120Hz mobile displays — S23 / Pixel 8 / iPhone Pro all run 120Hz natively, NES targets ~60Hz). Web Worker `setInterval` when tab hidden (mobile Safari suspends rAF when backgrounded; required for MP sync). | `src/game-loop.js:293-317` |
| 17 | iOS auto-zoom guard | `#mobile-input` has `font-size: 16px` — iOS Safari auto-zooms inputs with font-size < 16px on focus. | `index.html:529` |
| 18 | Mobile viewport meta | `<meta name="viewport" content="width=device-width, initial-scale=1.0">` | `index.html:5` |

## Sanity-check passes

These spot-checks were run during the audit to confirm no silent drift. Re-run if you suspect regression.

- **Prompt callers single-sourced.** Every `showMsgBoxPrompt` consumer routes through `yesNoLabels()`: `movement.js:302` (MagicKey), `trade.js:237` (incoming offer), `battle-fenix-revive.js:50` (FenixDown), `party-invite.js:286` (party invite), `pause-menu.js:1065/1091` (inventory delete — two paths). Grep: `grep -rn "showMsgBoxPrompt" src/`.
- **Mobile deck keys cover gameplay.** `[data-key]` set: `Arrow{Up,Down,Left,Right}` + `Enter` + `s` (SELECT) + `t`/`T` (chat) + `z` (A) + `x` (B). `Escape` aliased to `x` in `movement.js`/`input-handler.js` so B button cancels. Chat-only keys (`Tab`, `Backspace`) come for free when the mobile keyboard is focused. Grep: `grep -oP 'data-key="[^"]+"' index.html | sort -u`.
- **No mouse-only paths.** No `addEventListener('click')` or `onclick` in `src/` outside `src/debug/`. Debug tabs separately wire both `mousedown`/`mouseup`/`mouseleave` and `touchstart`/`touchend`/`touchcancel` for multi-device support. Grep: `grep -rn "addEventListener.*click\|onclick" src/ --include="*.js"`.

## Minor inconsistencies (cosmetic, not bugs)

- **`src/shop.js:768`** uses its own inline `isMobile ? 'A=Yes  B=No' : 'Z=Yes  X=No'` instead of `yesNoLabels()`. Different vocabulary by design (shop says "Yes/No", system prompts say "ok/no"), so this is a deliberate fork — but it's the only consumer outside the single source. Could be promoted to `yesNoLabels({yes:'Yes',no:'No'})` overload if you want one canonical helper.

## Latent risk

- **`isMobile` is captured once at module load** in `src/ui-state.js` and never re-evaluated. Switching modes mid-session (plug in Bluetooth keyboard, rotate tablet, OS-level pointer mode change) would not flip labels. No current user flow hits this — flagged here only so a future feature that depends on live mode-switching knows it'd need a re-detect path.

- **`src/main.js:292`** hardcodes a "Press Z" Uint8Array fallback for the desktop branch. Coupled to #18 above; same caveat.

## Pairs with

- `[[ff3mmo-storage-gesture-rule]]` — why the tap-to-enter splash is load-bearing
- `[[ff3mmo-ios-file-accept]]` — HARD RULE on file picker `accept=`
- `[[ff3mmo-msgbox-modal-input]]` — why msgbox Z/X must flow through movement.js
- `[[ff3mmo-engine-worker-tick]]` — Web Worker tick when tab hidden
