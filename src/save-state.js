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
// True only when `ps` currently holds the data for `saveSlots[selectCursor]` —
// i.e., the user is actively playing that slot. Set by _updateTitleMainOutCase
// when a slot is loaded; cleared by returnToTitle. Used by saveSlotsToDB to
// avoid baking stale `ps` state into a freshly-created shell slot during name
// entry (the bug that copied an existing save into "new" games).
export let psAligned = false;
export function setPsAligned(v) { psAligned = !!v; }

// Setters for state that external modules need to write
export function setSelectCursor(v) { selectCursor = v; }
export function setSaveSlots(v) { saveSlots = v; }
export function setNameBuffer(v) { nameBuffer = v; }

// Position getter — set by game.js at init to avoid circular dep
let _getPosition = () => ({});
export function setPositionGetter(fn) { _getPosition = fn; }

// --- Save persistence (IndexedDB + server) ---
//
// Single source of truth for what gets serialized: this function copies every
// live `ps` / `playerInventory` / position field into the active slot. Callers
// just invoke `saveSlotsToDB()` — they MUST NOT also copy fields inline,
// otherwise the schema lives in two places.
export async function saveSlotsToDB() {
  if (!savesLoaded) return;
  const slot = saveSlots[selectCursor];
  // Only bake live `ps` state into the slot when ps is actually aligned with
  // this slot. Without the gate, name-entry's saveSlotsToDB call writes the
  // previously-loaded slot's data into the new shell slot — making "new game"
  // start with the previous slot's level/inventory/gil/etc.
  if (slot && psAligned) {
    slot.playTime = ps.playTime;
  }
  if (slot && psAligned && ps.stats) {
    slot.level = ps.stats.level;
    slot.exp = ps.stats.exp;
    slot.hp = ps.hp;
    slot.mp = ps.mp;
    slot.stats = playerStatsSnapshot();
    slot.inventory = { ...playerInventory };
    slot.gil = ps.gil;
    slot.jobLevels = JSON.parse(JSON.stringify(ps.jobLevels));
    slot.jobIdx = ps.jobIdx;
    slot.unlockedJobs = ps.unlockedJobs;
    slot.cp = ps.cp;
    slot.statusMask = ps.status ? ps.status.mask : 0;
    slot.statusPoisonTick = ps.status ? (ps.status.poisonDmgTick || 0) : 0;
    // Position getter can return null to mean "don't touch position
    // fields this save" — used while a shop panel is open so the
    // counter-tile location doesn't outrank the player's last safe
    // checkpoint (loadMapById on town entry / loadWorldMapAt on gate /
    // battle end). Inventory + gil from the purchase still persist.
    const pos = _getPosition();
    if (pos) {
      slot.worldX = pos.worldX;
      slot.worldY = pos.worldY;
      slot.onWorldMap = pos.onWorldMap;
      slot.currentMapId = pos.currentMapId;
    }
    slot.lastTown = ps.lastTown;
    slot.lastWorldExitX = ps.lastWorldExitX;
    slot.lastWorldExitY = ps.lastWorldExitY;
    slot.knownSpells = ps.knownSpells ? [...ps.knownSpells] : [];
    slot.consumedTiles = ps.consumedTiles ? JSON.parse(JSON.stringify(ps.consumedTiles)) : {};
  }
  try {
    const data = saveSlots.map(s => s ? {
      name: Array.from(s.name),
      level: s.level || (ps.stats ? ps.stats.level : 1),
      exp: s.exp != null ? s.exp : (ps.stats ? ps.stats.exp : 0),
      hp: s.hp != null ? s.hp : (s.stats ? s.stats.hp : null),
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
      worldX: s.worldX != null ? s.worldX : null,
      worldY: s.worldY != null ? s.worldY : null,
      onWorldMap: s.onWorldMap != null ? s.onWorldMap : null,
      currentMapId: s.currentMapId != null ? s.currentMapId : null,
      lastTown: s.lastTown != null ? s.lastTown : 114,
      lastWorldExitX: s.lastWorldExitX != null ? s.lastWorldExitX : null,
      lastWorldExitY: s.lastWorldExitY != null ? s.lastWorldExitY : null,
      playTime: s.playTime || 0,
      knownSpells: Array.isArray(s.knownSpells) ? [...s.knownSpells] : [],
      consumedTiles: s.consumedTiles || {},
    } : null);
    // Local IndexedDB
    const db = await openSaveDB();
    const tx = db.transaction('roms', 'readwrite');
    tx.objectStore('roms').put(data, 'saves');
    // Server sync — push each changed slot
    if (window.ff3Auth) {
      data.forEach((slotData, i) => {
        if (slotData) window.ff3Auth.serverSave(i, slotData).catch(e => console.warn('[save] server sync failed for slot', i, e));
      });
    }
  } catch (e) { console.warn('[save] saveSlotsToDB failed:', e); }
}

export async function loadSlotsFromDB() {
  try {
    // Try server first if logged in
    if (window.ff3Auth) {
      const serverSlots = await window.ff3Auth.serverLoadSaves().catch(e => { console.warn('[save] serverLoadSaves failed:', e); return null; });
      if (serverSlots) {
        // Only accept server state if at least one slot has actual data — don't clobber local with a null response
        const hasData = Array.isArray(serverSlots) && serverSlots.some(s => s != null);
        if (hasData) {
          saveSlots = parseSaveSlots(serverSlots) || saveSlots;
          savesLoaded = true;
          console.log('[save] loaded from server');
          return;
        }
        console.warn('[save] server returned empty slots, falling back to IndexedDB');
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
