// gamepad.js — Web Gamepad API → keys map shim.
//
// Polled once per tick from game-loop.js. Writes into the shared `keys` map
// exported by input-handler.js, so every existing consumer (battle menu,
// roster, pause, movement, chat tabs) just works without code changes.
//
// Standard Gamepad layout (button index → NES action):
//   0  bottom-action  (Xbox A / PS X / Switch B) → NES A   → `z`
//   1  right-action   (Xbox B / PS O / Switch A) → NES B   → `x`
//   8  Select/Back/View/-                        → roster  → `s`
//   9  Start/Menu/Options/+                      → confirm → `Enter`
//   12-15 D-pad up/down/left/right               → ArrowUp/Down/Left/Right
//   Left stick axes 0,1 (deadzone 0.5)           → ArrowKeys
//
// Auto-repeat for held directions matches keyboard feel: 280ms initial
// delay, then 90ms repeat. Action buttons (A/B/Start/Select) are edge-only
// — no auto-repeat (matches NES behavior + prevents menu skipping).
//
// v1.7.681.

import { keys } from './input-handler.js';

const DEADZONE = 0.5;
const REPEAT_INITIAL_MS = 280;
const REPEAT_TICK_MS    = 90;

// button-index → keys-map slot. Edge-detected (no auto-repeat) — these are
// confirm / cancel / menu actions where holding shouldn't double-fire.
const EDGE_BUTTON_MAP = {
  0: 'z',       // A
  1: 'x',       // B
  8: 's',       // Select → roster
  9: 'Enter',   // Start
};

// Directional inputs — get auto-repeat so menu hold-to-scroll works the same
// as keyboard. Keys are the synthetic "direction slots" we track; values are
// the keys-map slots written.
const DIR_KEYS = ['up', 'down', 'left', 'right'];
const DIR_TO_KEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

// Per-button prev-state for edge detection. Indexed by button index.
const _prevBtn = {};
// Per-direction repeat timer. value = ms remaining until next pulse; -1 = not held.
const _dirRepeat = { up: -1, down: -1, left: -1, right: -1 };
// Did a gamepad ever connect this session? Skipping `navigator.getGamepads()`
// when false saves 60 syscalls/sec on devices that don't have a pad — the
// API does an IPC round-trip on some engines (Silk on Fire tablets stalled
// in a tight poll loop pre-v1.7.683 freeze report). Chrome's lazy-enable
// also means `getGamepads()` returns all-null until first input fires
// `gamepadconnected` anyway — there's nothing to find until the listener
// has fired at least once.
let _gamepadEverSeen = false;
// Hard-disable the poll if `navigator.getGamepads()` ever throws (Silk
// parental-controls / permissions-policy denial). Set once, never reset.
let _gamepadPollDisabled = false;

export function isGamepadActive() { return _gamepadEverSeen; }

function _activeGamepad() {
  if (_gamepadPollDisabled) return null;
  // navigator.getGamepads() returns a sparse array — some slots null. First
  // connected pad wins. (Multi-pad would be a separate routing decision.)
  // Wrapped in try/catch — Silk on Fire HD Kids tablets can throw if the
  // permissions policy blocks the API.
  let pads;
  try { pads = navigator.getGamepads ? navigator.getGamepads() : []; }
  catch { _gamepadPollDisabled = true; return null; }
  if (!pads) return null;
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (p && p.connected) return p;
  }
  return null;
}

function _dirState(pad) {
  // D-pad first (buttons 12-15), then left stick fallback. D-pad wins if
  // both register (player intent is clearer).
  const dp = {
    up:    pad.buttons[12]?.pressed || false,
    down:  pad.buttons[13]?.pressed || false,
    left:  pad.buttons[14]?.pressed || false,
    right: pad.buttons[15]?.pressed || false,
  };
  if (dp.up || dp.down || dp.left || dp.right) return dp;
  const ax = pad.axes[0] || 0;
  const ay = pad.axes[1] || 0;
  return {
    up:    ay < -DEADZONE,
    down:  ay >  DEADZONE,
    left:  ax < -DEADZONE,
    right: ax >  DEADZONE,
  };
}

export function pollGamepad(dt) {
  // Fast path: if no gamepad has ever connected this session, skip the
  // `navigator.getGamepads()` syscall entirely. The `gamepadconnected`
  // listener flips `_gamepadEverSeen` to true on first input — at that
  // point we start polling. This keeps the per-tick hot path empty for
  // the ~95% of players without a controller (Fire HD Kids freeze
  // report — Silk's getGamepads round-trips through an IPC permission
  // check that stalled the tick worker).
  if (!_gamepadEverSeen) return;
  const pad = _activeGamepad();
  if (!pad) {
    // No pad — clear any sticky direction repeats so a disconnect mid-hold
    // doesn't leave a key stuck true. Action buttons get their `false` from
    // edge-down-then-up; nothing to clear if no edge ever fired.
    for (const d of DIR_KEYS) {
      if (_dirRepeat[d] !== -1) { keys[DIR_TO_KEY[d]] = false; _dirRepeat[d] = -1; }
    }
    return;
  }

  // ── Action buttons: edge-detect press, write into keys map ──────────────
  // We don't clear on release — match keyboard semantics where the consumer
  // clears (`if (k['z']) { k['z'] = false; ... }`). Holding the button does
  // NOT re-fire because we only set on the rising edge.
  for (const idxStr of Object.keys(EDGE_BUTTON_MAP)) {
    const idx = +idxStr;
    const pressed = pad.buttons[idx]?.pressed || false;
    const prev = _prevBtn[idx] || false;
    if (pressed && !prev) keys[EDGE_BUTTON_MAP[idx]] = true;
    _prevBtn[idx] = pressed;
  }

  // ── Directions: edge + auto-repeat ──────────────────────────────────────
  const dirs = _dirState(pad);
  for (const d of DIR_KEYS) {
    const keyName = DIR_TO_KEY[d];
    if (dirs[d]) {
      if (_dirRepeat[d] === -1) {
        // Rising edge — fire immediately, start initial-delay countdown.
        keys[keyName] = true;
        _dirRepeat[d] = REPEAT_INITIAL_MS;
      } else {
        _dirRepeat[d] -= dt;
        if (_dirRepeat[d] <= 0) {
          keys[keyName] = true;
          _dirRepeat[d] = REPEAT_TICK_MS;
        }
      }
    } else if (_dirRepeat[d] !== -1) {
      // Released — clear the slot in case the consumer hadn't yet, and reset
      // the repeat timer so the next press fires immediately.
      keys[keyName] = false;
      _dirRepeat[d] = -1;
    }
  }
}

export function initGamepadListeners() {
  // The Gamepad API only starts reporting connected pads AFTER a button is
  // pressed (Chrome) or after `gamepadconnected` (everywhere). The listener
  // is informational — polling in pollGamepad() handles the actual reads.
  window.addEventListener('gamepadconnected', (e) => {
    _gamepadEverSeen = true;
    // eslint-disable-next-line no-console
    console.log('[gamepad] connected:', e.gamepad.id, 'idx=' + e.gamepad.index);
  });
  window.addEventListener('gamepaddisconnected', (e) => {
    // eslint-disable-next-line no-console
    console.log('[gamepad] disconnected:', e.gamepad.id);
  });
}
