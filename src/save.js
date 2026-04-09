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
    if (Array.isArray(s)) return { name: new Uint8Array(s), level: 1, exp: 0, hp: null, stats: null, inventory: {}, gil: 0, jobLevels: {}, jobIdx: 0, unlockedJobs: 0x01, cp: 0, playTime: 0 };
    return { name: new Uint8Array(s.name), level: s.level || 1, exp: s.exp || 0, hp: s.hp != null ? s.hp : null, stats: s.stats || null, inventory: s.inventory || {}, gil: s.gil || 0, jobLevels: s.jobLevels || {}, jobIdx: s.jobIdx || 0, unlockedJobs: s.unlockedJobs != null ? s.unlockedJobs : 0x01, cp: s.cp || 0, playTime: s.playTime || 0, worldX: s.worldX != null ? s.worldX : null, worldY: s.worldY != null ? s.worldY : null, onWorldMap: s.onWorldMap != null ? s.onWorldMap : null, currentMapId: s.currentMapId != null ? s.currentMapId : null };
  });
}
