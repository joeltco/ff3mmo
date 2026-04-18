// Save state — owns selectCursor, saveSlots, name entry, and DB persistence.
// Extracted from game.js so any module can import save state directly.

import { openSaveDB, serverDeleteSlot, parseSaveSlots } from './save.js';
import { ps, playerStatsSnapshot } from './player-stats.js';
import { playerInventory } from './inventory.js';

// --- State ---
export let selectCursor = 0;             // 0-2 (which slot)
export let saveSlots = [null, null, null]; // null = empty, or Uint8Array of name bytes
export let savesLoaded = false;            // guard: don't write to DB until loaded from DB first
export let nameBuffer = [];                // bytes being typed
export const NAME_MAX_LEN = 7;

// Setters for state that external modules need to write
export function setSelectCursor(v) { selectCursor = v; }
export function setSaveSlots(v) { saveSlots = v; }
export function setNameBuffer(v) { nameBuffer = v; }

// Position getter — set by game.js at init to avoid circular dep
let _getPosition = () => ({});
export function setPositionGetter(fn) { _getPosition = fn; }

// --- Save persistence (IndexedDB + server) ---
export async function saveSlotsToDB() {
  if (!savesLoaded) return;
  // Sync live player state into the active save slot before persisting
  // Skip if slot has no stats yet (fresh new game, not yet loaded)
  if (saveSlots[selectCursor]) {
    saveSlots[selectCursor].playTime = ps.playTime;
  }
  if (saveSlots[selectCursor] && ps.stats) {
    saveSlots[selectCursor].level = ps.stats.level;
    saveSlots[selectCursor].exp = ps.stats.exp;
    saveSlots[selectCursor].hp = ps.hp;
    saveSlots[selectCursor].stats = playerStatsSnapshot();
    saveSlots[selectCursor].inventory = { ...playerInventory };
    saveSlots[selectCursor].gil = ps.gil;
    saveSlots[selectCursor].jobLevels = JSON.parse(JSON.stringify(ps.jobLevels));
    saveSlots[selectCursor].jobIdx = ps.jobIdx;
    saveSlots[selectCursor].unlockedJobs = ps.unlockedJobs;
    saveSlots[selectCursor].cp = ps.cp;
    saveSlots[selectCursor].statusMask = ps.status ? ps.status.mask : 0;
    const pos = _getPosition();
    saveSlots[selectCursor].worldX = pos.worldX;
    saveSlots[selectCursor].worldY = pos.worldY;
    saveSlots[selectCursor].onWorldMap = pos.onWorldMap;
    saveSlots[selectCursor].currentMapId = pos.currentMapId;
  }
  try {
    const data = saveSlots.map(s => s ? {
      name: Array.from(s.name),
      level: s.level || (ps.stats ? ps.stats.level : 1),
      exp: s.exp != null ? s.exp : (ps.stats ? ps.stats.exp : 0),
      hp: s.hp != null ? s.hp : (s.stats ? s.stats.hp : null),
      stats: s.stats || null,
      inventory: s.inventory || {},
      gil: s.gil || 0,
      jobLevels: s.jobLevels || {},
      jobIdx: s.jobIdx || 0,
      unlockedJobs: s.unlockedJobs != null ? s.unlockedJobs : 0x01,
      cp: s.cp || 0,
      statusMask: s.statusMask || 0,
      worldX: s.worldX != null ? s.worldX : null,
      worldY: s.worldY != null ? s.worldY : null,
      onWorldMap: s.onWorldMap != null ? s.onWorldMap : null,
      currentMapId: s.currentMapId != null ? s.currentMapId : null,
      playTime: s.playTime || 0,
    } : null);
    // Local IndexedDB
    const db = await openSaveDB();
    const tx = db.transaction('roms', 'readwrite');
    tx.objectStore('roms').put(data, 'saves');
    // Server sync — push each changed slot
    if (window.ff3Auth) {
      data.forEach((slotData, i) => {
        if (slotData) window.ff3Auth.serverSave(i, slotData).catch(() => {});
      });
    }
  } catch (e) { /* silent fail */ }
}

export async function loadSlotsFromDB() {
  try {
    // Try server first if logged in
    if (window.ff3Auth) {
      const serverSlots = await window.ff3Auth.serverLoadSaves().catch(() => null);
      if (serverSlots) {
        saveSlots = parseSaveSlots(serverSlots) || saveSlots;
        savesLoaded = true;
        return;
      }
    }
    // Fall back to IndexedDB
    const db = await openSaveDB();
    const tx = db.transaction('roms', 'readonly');
    const req = tx.objectStore('roms').get('saves');
    return new Promise((resolve) => {
      req.onsuccess = () => {
        saveSlots = parseSaveSlots(req.result) || saveSlots;
        savesLoaded = true;
        resolve();
      };
      req.onerror = () => { savesLoaded = true; resolve(); };
    });
  } catch (e) { savesLoaded = true; }
}
