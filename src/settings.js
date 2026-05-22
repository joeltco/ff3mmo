// settings.js — device-local player preferences (per browser, NOT per save
// slot). These are tuning knobs set in the pause-menu Options screen: audio
// volumes and text/battle pacing. Persisted to localStorage so they survive
// reloads. Kept dependency-free so the very-early audio module can import it.
//
// (The player's sprite COLOR is deliberately NOT here — that's per-character
//  state and lives in `ps.palIdx` / the save slot, see job-sprites.js.)

const KEY = 'ff3_settings';

// musicVol / sfxVol: 0-10 integer steps → gain 0.0-1.0 (×0.1).
// textSpeed / battleSpeed: 0 = slow, 1 = normal, 2 = fast.
const DEFAULTS = { musicVol: 10, sfxVol: 10, textSpeed: 1, battleSpeed: 1 };

export const VOL_MAX = 10;

let _s = null;

function _load() {
  if (_s) return _s;
  _s = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      for (const k in DEFAULTS) if (typeof p[k] === 'number') _s[k] = p[k];
    }
  } catch { /* localStorage unavailable / corrupt — fall back to defaults */ }
  return _s;
}

function _save() {
  try { localStorage.setItem(KEY, JSON.stringify(_load())); } catch { /* ignore */ }
}

export function getSetting(k) { return _load()[k]; }

export function setSetting(k, v) { _load()[k] = v; _save(); }

// Volume helpers — clamp to [0, VOL_MAX] and return the 0.0-1.0 gain.
export function volGain(step) {
  const s = Math.max(0, Math.min(VOL_MAX, step | 0));
  return s / VOL_MAX;
}

// Battle speed — scales the battle update dt. >1 = faster (timers/messages/
// animations all reach their thresholds sooner). Index by battleSpeed setting
// (0=slow, 1=normal, 2=fast). Normal is 1.0 so default play is unchanged.
export const BATTLE_SPEED_LABELS = ['Slow', 'Norm', 'Fast'];
const BATTLE_SPEED_MULT = [0.65, 1.0, 1.6];

export function battleSpeedMult() {
  return BATTLE_SPEED_MULT[getSetting('battleSpeed')] ?? 1.0;
}
