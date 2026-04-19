// Status effect system — tracks and applies NES FF3 status conditions
// NES status bitmask: bit 0=paralysis, 1=poison, 2=blind, 3=mini,
//                     4=silence, 5=toad, 6=petrify, 7=death
// Only combat-relevant statuses implemented for now.

export const STATUS = {
  PARALYSIS: 0x01,
  POISON:    0x02,
  BLIND:     0x04,
  MINI:      0x08,
  SILENCE:   0x10,
  TOAD:      0x20,
  PETRIFY:   0x40,
  DEATH:     0x80,
  // NES stores sleep/confuse in a separate byte; we extend the mask
  SLEEP:     0x100,
  CONFUSE:   0x200,
};

export const STATUS_NAMES = {
  [STATUS.PARALYSIS]: 'Paralysis',
  [STATUS.POISON]:    'Poison',
  [STATUS.BLIND]:     'Blind',
  [STATUS.MINI]:      'Mini',
  [STATUS.SILENCE]:   'Silence',
  [STATUS.TOAD]:      'Toad',
  [STATUS.PETRIFY]:   'Petrify',
  [STATUS.DEATH]:     'Death',
  [STATUS.SLEEP]:     'Sleep',
  [STATUS.CONFUSE]:   'Confuse',
};

// NES-encoded name bytes for battle console display
export const STATUS_NAME_BYTES = {
  [STATUS.PARALYSIS]: new Uint8Array([0x99,0xCA,0xDB,0xCA,0xD5,0xE2,0xE5,0xCE,0xCD]), // Paralyzed
  [STATUS.POISON]:    new Uint8Array([0x99,0xD8,0xD2,0xDC,0xD8,0xD7,0xCE,0xCD]),       // Poisoned
  [STATUS.BLIND]:     new Uint8Array([0x8B,0xD5,0xD2,0xD7,0xCD,0xCE,0xCD]),             // Blinded
  [STATUS.SILENCE]:   new Uint8Array([0x9C,0xD2,0xD5,0xCE,0xD7,0xCC,0xCE,0xCD]),       // Silenced
  [STATUS.PETRIFY]:   new Uint8Array([0x99,0xCE,0xDD,0xDB,0xD2,0xCF,0xD2,0xCE,0xCD]), // Petrified
  [STATUS.SLEEP]:     new Uint8Array([0x8A,0xDC,0xD5,0xCE,0xCE,0xDA]),                 // Asleep
  [STATUS.CONFUSE]:   new Uint8Array([0x8C,0xD8,0xD7,0xCF,0xDE,0xDC,0xCE,0xCD]),       // Confused
};

// --- Per-target status state ---
// Each combatant (player, ally, monster) can have a statusMask (bitmask of active statuses)
// and per-status turn counters.

export function createStatusState() {
  return { mask: 0, poisonDmgTick: 0 };
}

export function hasStatus(state, flag) {
  return !!(state.mask & flag);
}

export function addStatus(state, flag) {
  state.mask |= flag;
}

export function removeStatus(state, flag) {
  state.mask &= ~flag;
}

export function clearAll(state) {
  state.mask = 0;
  state.poisonDmgTick = 0;
}

// --- Status application (hit check) ---
// attackStatus: string or array from monster/weapon data ('poison', 'blind', etc.)
// hitChance: 0-100 (for weapon statuses, NES uses the weapon's hit%; for spells, spell hit%)
// Returns the status flag that was applied, or 0 if missed/resisted.

const NAME_TO_FLAG = {
  paralysis: STATUS.PARALYSIS,
  poison:    STATUS.POISON,
  blind:     STATUS.BLIND,
  mini:      STATUS.MINI,
  silence:   STATUS.SILENCE,
  toad:      STATUS.TOAD,
  petrify:   STATUS.PETRIFY,
  death:     STATUS.DEATH,
  sleep:     STATUS.SLEEP,
  confuse:   STATUS.CONFUSE,
};

// resist: optional — status name, array of names, or bitmask of NAME_TO_FLAG.
// If the incoming status matches any resisted flag, inflict auto-fails (NES immunity check).
export function tryInflictStatus(targetState, statusName, hitChance = 50, resist = null) {
  const flag = NAME_TO_FLAG[statusName];
  if (!flag) return 0;
  if (hasStatus(targetState, flag)) return 0; // already afflicted
  if (resist) {
    let resistMask = 0;
    if (typeof resist === 'number') resistMask = resist;
    else if (typeof resist === 'string') resistMask = NAME_TO_FLAG[resist] || 0;
    else if (Array.isArray(resist)) { for (const r of resist) resistMask |= NAME_TO_FLAG[r] || 0; }
    if (resistMask & flag) return 0; // immune
  }
  if (Math.random() * 100 < hitChance) {
    addStatus(targetState, flag);
    return flag;
  }
  return 0;
}

// Try inflicting from a raw NES status byte (bitmask of multiple possible statuses)
// Each bit is rolled independently against hitChance
export function tryInflictStatusByte(targetState, statusByte, hitChance = 50) {
  let applied = 0;
  for (const [name, flag] of Object.entries(NAME_TO_FLAG)) {
    if (statusByte & flag) {
      const result = tryInflictStatus(targetState, name, hitChance);
      applied |= result;
    }
  }
  return applied;
}

// --- Per-turn effects ---
// Called at start of a combatant's turn. Returns { canAct, poisonDmg }

export function processTurnStart(state, maxHP) {
  let canAct = true;
  let poisonDmg = 0;
  let confused = false;

  // Petrify/death = can't act (should already be handled as KO)
  if (hasStatus(state, STATUS.PETRIFY) || hasStatus(state, STATUS.DEATH)) {
    canAct = false;
  }

  // Paralysis = skip turn, then remove (NES: lasts 1-3 turns, simplified to 1)
  if (hasStatus(state, STATUS.PARALYSIS)) {
    canAct = false;
    removeStatus(state, STATUS.PARALYSIS);
  }

  // Sleep = skip turn (NES: wakes on physical hit, or 25% chance per turn)
  if (hasStatus(state, STATUS.SLEEP)) {
    if (Math.random() < 0.25) {
      removeStatus(state, STATUS.SLEEP);
    } else {
      canAct = false;
    }
  }

  // Confuse = acts but attacks random target (caller handles targeting)
  if (hasStatus(state, STATUS.CONFUSE)) {
    confused = true;
    // NES: 25% chance to snap out per turn
    if (Math.random() < 0.25) {
      removeStatus(state, STATUS.CONFUSE);
      confused = false;
    }
  }

  // Poison = take damage equal to floor(maxHP / 16) per turn (NES 35/BADC-BB1E).
  // No minimum clamp: at maxHP < 16, tick is 0 (matches NES).
  if (hasStatus(state, STATUS.POISON)) {
    poisonDmg = Math.floor(maxHP / 16);
  }

  // Silence = can't cast magic (checked by caller, not here)
  // Blind = reduced hit rate (checked by caller)
  // Mini = reduced attack (checked by caller)
  // Toad = reduced to basic attack (checked by caller)

  return { canAct, poisonDmg, confused };
}

// Wake from sleep when hit by physical attack
export function wakeOnHit(state) {
  if (hasStatus(state, STATUS.SLEEP)) {
    removeStatus(state, STATUS.SLEEP);
  }
}

// --- Combat modifiers ---
// Returns hit rate multiplier for a blinded attacker (NES: halved accuracy)
export function blindHitPenalty(state) {
  return hasStatus(state, STATUS.BLIND) ? 0.5 : 1.0;
}

// Returns attack multiplier for mini/toad (NES: attack reduced to 1)
export function miniToadAtkMult(state) {
  return (hasStatus(state, STATUS.MINI) || hasStatus(state, STATUS.TOAD)) ? 0 : 1;
}

// Check if target can cast magic (silence blocks it)
export function canCastMagic(state) {
  return !hasStatus(state, STATUS.SILENCE);
}
