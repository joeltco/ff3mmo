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

// The stamp carries the build that wrote it. Without this, a `DIED-AT` report
// names the build doing the REPORTING, not the one that crashed — a stale stamp
// from an old build looks like a fresh crash on the current one. That nearly
// caused a wrong call: a `sa:monsterSprites` stamp left over from v1.7.937 was
// reported on a v1.7.939 load, on which that stage is a no-op and cannot fail.
let _build = '?';
export function setBuildTag(b) { if (b) _build = String(b); }

/** Stamp the step ABOUT to run. Cheap, synchronous, best-effort. */
export function setStage(name) {
  try { localStorage.setItem(KEY, name + '@' + _build); } catch (_) { /* private mode / quota */ }
}

/** Split a stored stamp into its step and the build that wrote it. */
export function parseStage(raw) {
  if (!raw || raw === BOOT_DONE) return null;
  const at = raw.lastIndexOf('@');
  return at < 0
    ? { stage: raw, crashBuild: '?' }            // pre-v1.7.940 stamp
    : { stage: raw.slice(0, at), crashBuild: raw.slice(at + 1) };
}

/** Mark a clean finish so a healthy boot never reports itself as a crash. */
export function clearStage() {
  try { localStorage.setItem(KEY, BOOT_DONE); } catch (_) { /* ignore */ }
}

/** The previous load's last stamp, or null if there wasn't one. */
export function readStage() {
  try { return localStorage.getItem(KEY); } catch (_) { return null; }
}
