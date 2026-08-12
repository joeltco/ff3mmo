// boot-stage.js — crash-surviving boot progress marker.
//
// A network beacon cannot report a crash that kills the page, and that is the
// failure mode we are chasing: an Android player's tab dies mid-boot with no
// throw and no beacon. localStorage writes are synchronous and survive a
// renderer kill, so we stamp the current step here and report the last stamp on
// the NEXT load (see `_reportPreviousBootCrash` in main.js).
//
// Lives in its own module because both `main.js` and `boot.js` stamp stages,
// and `main.js` already imports `boot.js` — putting the helper in either one
// would make that import cycle load-bearing.

const KEY = 'ff3_boot_stage';
export const BOOT_DONE = 'done';

/** Stamp the step ABOUT to run. Cheap, synchronous, best-effort. */
export function setStage(name) {
  try { localStorage.setItem(KEY, name); } catch (_) { /* private mode / quota */ }
}

/** Mark a clean finish so a healthy boot never reports itself as a crash. */
export function clearStage() {
  try { localStorage.setItem(KEY, BOOT_DONE); } catch (_) { /* ignore */ }
}

/** The previous load's last stamp, or null if there wasn't one. */
export function readStage() {
  try { return localStorage.getItem(KEY); } catch (_) { return null; }
}
