// One-time migration: saves created pre-v1.7.298 used Chaos Rush byte layout
// (lowercase $CA-$E3, comma $A5, apostrophe $A9). v1.7.298 swapped to A.W.
// Jackson font where lowercase is $A4-$BD. Translate legacy name bytes so the
// player's own name doesn't render as ligature/icon garbage after migration.
function _migrateNameToAWJ(bytes) {
  if (!bytes || !bytes.length) return bytes;
  // Only translate if we detect CR-era bytes. AWJ-native names never contain
  // $CA-$E3 (those are ligature tiles; name-entry can't produce them).
  let needsMigration = false;
  for (const b of bytes) {
    if ((b >= 0xCA && b <= 0xE3) || b === 0xA5 || b === 0xA9) {
      needsMigration = true; break;
    }
  }
  if (!needsMigration) return bytes;
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 0xCA && b <= 0xE3) out[i] = b - 0x26;
    else if (b === 0xA5) out[i] = 0xBE;
    else if (b === 0xA9) out[i] = 0xBF;
    else out[i] = b;
  }
  return out;
}

export function openSaveDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ff3mmo-roms', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function serverDeleteSlot(slot) {
  if (window.ff3Auth) window.ff3Auth.serverDeleteSave(slot).catch(() => {});
}

export function parseSaveSlots(data) {
  if (!Array.isArray(data)) return null;
  return data.map(s => {
    if (!s) return null;
    if (Array.isArray(s)) return { name: _migrateNameToAWJ(new Uint8Array(s)), level: 1, exp: 0, hp: null, mp: null, stats: null, inventory: {}, gil: 0, jobLevels: {}, jobIdx: 0, unlockedJobs: 0x01, cp: 0, statusMask: 0, statusPoisonTick: 0, lastTown: 114, playTime: 0, knownSpells: [] };
    return {
      name: _migrateNameToAWJ(new Uint8Array(s.name)),
      level: s.level || 1,
      exp: s.exp || 0,
      hp: s.hp != null ? s.hp : null,
      mp: s.mp != null ? s.mp : null,
      stats: s.stats || null,
      inventory: s.inventory || {},
      gil: s.gil || 0,
      jobLevels: s.jobLevels || {},
      jobIdx: s.jobIdx || 0,
      unlockedJobs: s.unlockedJobs != null ? s.unlockedJobs : 0x01,
      cp: s.cp || 0,
      statusMask: s.statusMask || 0,
      statusPoisonTick: s.statusPoisonTick || 0,
      lastTown: s.lastTown != null ? s.lastTown : 114,
      lastWorldExitX: s.lastWorldExitX != null ? s.lastWorldExitX : null,
      lastWorldExitY: s.lastWorldExitY != null ? s.lastWorldExitY : null,
      playTime: s.playTime || 0,
      worldX: s.worldX != null ? s.worldX : null,
      worldY: s.worldY != null ? s.worldY : null,
      onWorldMap: s.onWorldMap != null ? s.onWorldMap : null,
      currentMapId: s.currentMapId != null ? s.currentMapId : null,
      knownSpells: Array.isArray(s.knownSpells) ? [...s.knownSpells] : [],
      consumedTiles: (s.consumedTiles && typeof s.consumedTiles === 'object') ? s.consumedTiles : {},
    };
  });
}
