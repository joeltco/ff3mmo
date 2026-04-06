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
    if (Array.isArray(s)) return { name: new Uint8Array(s), level: 1, exp: 0, stats: null, inventory: {}, gil: 0, proficiency: {}, jobIdx: 0, unlockedJobs: 0x01 };
    return { name: new Uint8Array(s.name), level: s.level || 1, exp: s.exp || 0, stats: s.stats || null, inventory: s.inventory || {}, gil: s.gil || 0, proficiency: s.proficiency || {}, jobIdx: s.jobIdx || 0, unlockedJobs: s.unlockedJobs != null ? s.unlockedJobs : 0x01 };
  });
}
