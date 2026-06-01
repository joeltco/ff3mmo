// Game Client — boot wiring, ROM loading, composition root

import { parseROM } from './rom-parser.js';
import { Sprite } from './sprite.js';
import { loadWorldMap } from './world-map-loader.js';
import { WorldMapRenderer } from './world-map-renderer.js';
import { clearDungeonCache } from './dungeon-generator.js';
import { playTrack, TRACKS, fadeOutFF1Music, clearMusicStash, unlockAudio } from './music.js';
import { applyIPS } from './ips-patcher.js';
import { initTextDecoder } from './text-decoder.js';
import { initFont } from './font-renderer.js';
import { PLAYER_POOL } from './data/players.js';
import { VERSION } from './data/strings.js';
import { saveSlotsToDB, loadSlotsFromDB, setPositionGetter, setPsAligned } from './save-state.js';
import { resetWorldWaterCache } from './water-animation.js';
import { hudSt, HUD_INFO_FADE_STEPS, HUD_INFO_FADE_STEP_MS } from './hud-state.js';
import { mapSt } from './map-state.js';
import { ui, isMobile } from './ui-state.js';
import { battleSt } from './battle-state.js';
import { chatState, consoleLog, setCommandContext, isDev } from './chat.js';
import { setLocationGetter, getPlayerLocation } from './roster.js';
import { titleSt } from './title-screen.js';
import { pauseSt, initPauseMenuInput } from './pause-menu.js';
import { transSt } from './transitions.js';
import { initInputHandler, initKeyboardListeners } from './input-handler.js';
import { initGamepadListeners } from './gamepad.js';
import { initPVPSearch } from './pvp-search.js';
import { shopSt } from './shop.js';
import { setPlayerSprite } from './player-sprite.js';
import { startPVPBattle } from './pvp.js';
// v1.7.752 P-6 — server-arbitrated PvP viewer module. Importing it
// registers the wire handlers (pvp-battle-start / pvp-turn /
// pvp-cancel / pvp-state-resync) at module load. Behavior is inert
// until PVP_ARBITER flips on (P-9): without an arbiter-managed battle
// in play, none of these frames arrive.
import './pvp-arb-viewer.js';
// v1.7.753 P-6b — render integration adapter. Registers as the viewer's
// post-update callback; mirrors arbViewSt into the legacy pvpSt/ps/
// battleAllies bags so the existing PvP draw code reads them unchanged.
// Inert until PVP_ARBITER on.
import './pvp-arb-adapter.js';
import { initMapLoading, loadMapById } from './map-loading.js';
import { initBattleAlly } from './battle-ally.js';
import { initBattleEnemy } from './battle-enemy.js';
import { buildTurnOrder, processNextTurn } from './battle-turn.js';
import { initBattleEncounter } from './battle-encounter.js';
import { initSpellCast } from './spell-cast.js';
import { addItem, setPlayerInventory } from './inventory.js';
import { saveSlots } from './save-state.js';
import { _nesNameToString } from './text-utils.js';
import { resetBattleVars, isTeamWiped, executeBattleCommand, tryJoinPlayerAlly } from './battle-update.js';
import { startGameLoop } from './game-loop.js';
import { connectNet, setNetInvStateHandler } from './net.js';   // v1.7.742 Phase 1b prep
import { ps, getEffectiveStats, getShieldEvade, getJobLevel } from './player-stats.js';
import { selectCursor } from './save-state.js';
import { initSpriteAssets, initTitleAssets } from './boot.js';
import { SPRITE_PAL_TOP, SPRITE_PAL_BTM } from './job-sprites.js';
export { loadFF1ROM, loadFF2ROM } from './boot.js';

const CANVAS_W = 256;          // 16 metatiles wide (NES resolution)
const CANVAS_H = 240;          // 15 metatiles tall (NES resolution)

export function init() {
  // Only persist position when the player is actually on the overworld.
  // Walking around towns / dungeons / shop counters does NOT move the
  // respawn point — the last `loadWorldMapAt` (overworld entry from a
  // gate) or battle-end on overworld is the checkpoint. This keeps
  // tab-close `beforeunload` saves from stamping "you respawn on the
  // weapon shop door tile" or similar.
  //
  // Returning `null` is honored by `saveSlotsToDB`: it still writes
  // inventory / gil / HP / stats, just skips `worldX / worldY /
  // onWorldMap / currentMapId`.
  setPositionGetter(() => {
    if (shopSt.state !== 'closed') return null;
    if (!mapSt.onWorldMap) return null;
    return { worldX: mapSt.worldX, worldY: mapSt.worldY, onWorldMap: mapSt.onWorldMap, currentMapId: mapSt.currentMapId };
  });
  setLocationGetter(() => ({ onWorldMap: mapSt.onWorldMap, currentMapId: mapSt.currentMapId }));

  // Multiplayer presence — opens WebSocket to /api/ws if the user is
  // authenticated. The profile getter returns null until the save slot is
  // loaded; the poll loop in net.js handles late readiness and re-hellos
  // automatically. No-op when there's no JWT (single-player demo path).
  connectNet(
    () => {
      const slot = saveSlots[selectCursor];
      if (!slot || !ps.stats) return null;
      // slot.name is a Uint8Array of FF3-encoded text bytes. JSON.stringify on
      // a Uint8Array serializes as `{"0":N,"1":N,…}` (object shape, not array),
      // which the server then coerces to "[object Object]" via String()/slice.
      // Decode to a JS string so the wire carries the readable name.
      const eff = getEffectiveStats();
      return {
        name:    slot.name ? _nesNameToString(slot.name) : 'Player',
        jobIdx:  ps.jobIdx | 0,
        level:   ps.stats.level | 0 || 1,
        palIdx:  ps.palIdx | 0,
        // v1.7.741 Phase 1a — active save slot. Server stashes on
        // entry.slot so inv-event frames know which (userId, slot) of
        // the mirror to mutate. selectCursor is the currently-loaded
        // slot (0-2). NOT broadcast to peers — server pulls it off
        // entry.slot, doesn't include in player-update fanouts.
        slot:    selectCursor | 0,
        hp:      ps.hp | 0,
        maxHP:   ps.stats.maxHP | 0,
        mp:      ps.mp | 0,
        maxMP:   ps.stats.maxMP | 0,
        // In-battle presence flag — drives the roster row "⚔" badge so
        // other overworld players can see you're currently fighting.
        // Auto-pushed by the existing 500ms profile-diff poll in `net.js`
        // whenever this transitions. Cleared by `battleState === 'none'`.
        // (Pure presence as of v1.7.500; the Battle-Assist action it once
        //  fed was removed — this flag is the foundation the assist/party-
        //  battle rebuild reattaches to. See the ff3mmo-coop-rebuild memory.)
        inBattle: battleSt.battleState && battleSt.battleState !== 'none' ? 1 : 0,
        // Status mask for the roster row to display status icons + for the
        // pause-menu item-use to know when a partymate is poisoned /
        // blinded / etc. Server-validated in ws-presence.js#`statusMask`
        // case. The net.js diff-poll picks up the change automatically.
        // v1.7.715.
        statusMask: (ps.status && (ps.status.mask | 0)) | 0,
        // PvP hook chance is AGI-differential + Thief/Ranger bonus (see
        // `pvp-search.js#getHookChance`). Server uses the same formula on
        // `pvp-encounter` rolls, so AGI has to travel with the profile.
        // Ship effective agi (base + jpBonus + equipment bonuses) so the
        // receiver's ally view matches the sender's ps for initiative
        // rolls; server's hook chance now uses effective agi too.
        agi:     eff.agi,
        weaponR: ps.weaponR | 0,
        weaponL: ps.weaponL | 0,
        armorId: ps.body | 0,
        helmId:  ps.head | 0,
        // Realized combat stats — without these, the receiver's
        // `generateAllyStats(profile)` re-derives different values than
        // the sender's local `recalcCombatStats` (missing equipment stat
        // bonuses, missing accessory slot, missing jobLevel). Every
        // monster attack against this player then resolves to different
        // damage on different phones. See tools/wire-stats-diag.js.
        atk:           ps.atk | 0,
        def:           ps.def | 0,
        evade:         ps.evade | 0,
        mdef:          ps.mdef | 0,
        hitRate:       ps.hitRate | 0,
        shieldEvade:   getShieldEvade() | 0,
        statusResist:  ps.statusResist | 0,
        elemResist:    Array.isArray(ps.elemResist) ? [...ps.elemResist] : [],
        // Effective magic-damage stats (base + jpBonus + equipment bonuses).
        intStat:       eff.int,
        mndStat:       eff.mnd,
        // jobLevel for AI healer chooser + UI display on the receiver
        jobLevel:      getJobLevel() | 0,
        // knownSpells so wire-driven ally turns can dispatch magic
        knownSpells:   Array.isArray(ps.knownSpells) ? [...ps.knownSpells] : [],
        // MP party-PvP — full ally roster so the opponent's client can
        // populate `pvpEnemyAllies` from this client's actual party instead
        // of fake-rostering from its local PLAYER_POOL. Each entry is the
        // already-derived battleAllies shape (post-`generateAllyStats`) so
        // the receiver can drop it straight in. `status` is omitted; the
        // receiver inits a fresh status mask on use.
        allies: (battleSt.battleAllies || []).filter(Boolean).map(a => ({
          name: a.name, jobIdx: a.jobIdx | 0, level: a.level | 0, palIdx: a.palIdx | 0,
          hp: a.hp | 0, maxHP: a.maxHP | 0,
          atk: a.atk | 0, def: a.def | 0, agi: a.agi | 0,
          int: a.int | 0, mnd: a.mnd | 0,
          evade: a.evade | 0, mdef: a.mdef | 0, shieldEvade: a.shieldEvade | 0,
          statusResist: a.statusResist | 0, hitRate: a.hitRate | 0,
          weaponId: a.weaponId, weaponL: a.weaponL,
          knownSpells: Array.isArray(a.knownSpells) ? a.knownSpells.slice() : [],
          jobLevel: a.jobLevel | 0,
        })),
      };
    },
    () => getPlayerLocation(),
  );

  // v1.7.742 Phase 1b prep — server-pushed mirror state. Used by
  // `inv-state-request` now (defensive resync hook); Phase 1b will
  // fire this on every rejected `inv-event` so the client's local
  // state wholesale-replaces from the server's authoritative copy.
  // Touches every wire-managed field. NOTE: this handler is currently
  // ONLY safe to call when the user explicitly requests state (e.g.
  // via /inv-resync debug command) — full Phase 1b enforcement
  // requires Phase 4 (save sync must stop overwriting wire-managed
  // fields first). See `docs/INVENTORY-MIRROR-PLAN.md`.
  setNetInvStateHandler((msg) => {
    if (!msg || msg.slot == null) return;
    // Inventory wholesale-replace. Server inventory is { itemId: qty } shape.
    const inv = {};
    const order = [];
    if (msg.inventory && typeof msg.inventory === 'object') {
      for (const [k, v] of Object.entries(msg.inventory)) {
        const id = parseInt(k, 10);
        if (!Number.isFinite(id) || id < 0 || id > 255) continue;
        const qty = Number(v) | 0;
        if (qty <= 0) continue;
        inv[id] = qty;
        order.push(id);
      }
    }
    setPlayerInventory(inv, order);
    // Economy.
    if (typeof msg.gil === 'number') ps.gil = msg.gil | 0;
    // Equipment.
    if (msg.equipped && typeof msg.equipped === 'object') {
      if (typeof msg.equipped.weaponR === 'number') ps.weaponR = msg.equipped.weaponR | 0;
      if (typeof msg.equipped.weaponL === 'number') ps.weaponL = msg.equipped.weaponL | 0;
      if (typeof msg.equipped.head === 'number')    ps.head    = msg.equipped.head    | 0;
      if (typeof msg.equipped.body === 'number')    ps.body    = msg.equipped.body    | 0;
      if (typeof msg.equipped.arms === 'number')    ps.arms    = msg.equipped.arms    | 0;
    }
    // v1.7.796 — cp / exp / unlockedJobs / knownSpells / jobLevels are NOT
    // wire-managed; the mirror only snapshots them at /api/save time. If a
    // pre-fix server (or future divergence) sends them here, ignore — the
    // local `ps` value is canonical until the next save round-trip.
    saveSlotsToDB();
  });

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx.imageSmoothingEnabled = false;
  ui.canvas = canvas; ui.ctx = ctx;

  initKeyboardListeners();
  initGamepadListeners();
  window.addEventListener('beforeunload', () => { saveSlotsToDB(); });

  // Unlock audio on the first user gesture (mobile autoplay policy). One-shot:
  // the handlers remove themselves once the context is resumed. Covers touch,
  // mouse, and key so it fires whether the player taps the gate, clicks, or
  // presses a key first.
  const _unlock = () => {
    unlockAudio();
    window.removeEventListener('pointerdown', _unlock);
    window.removeEventListener('touchend', _unlock);
    window.removeEventListener('keydown', _unlock);
  };
  window.addEventListener('pointerdown', _unlock, { passive: true });
  window.addEventListener('touchend', _unlock, { passive: true });
  window.addEventListener('keydown', _unlock);
}

function returnToTitle() {
  saveSlotsToDB();
  // ps no longer represents the active slot — gate future saves until a slot
  // is loaded again via _updateTitleMainOutCase. Without this flip, the next
  // saveSlotsToDB during name entry would bake the previous slot's data into
  // the new shell.
  setPsAligned(false);
  pauseSt.state = 'none';
  fadeOutFF1Music((HUD_INFO_FADE_STEPS + 1) * HUD_INFO_FADE_STEP_MS);
  clearMusicStash();
  transSt.state = 'hud-fade-out';
  transSt.timer = 0;
  transSt.pendingAction = () => { battleSt.battleState = 'none'; hudSt.hudInfoFadeTimer = HUD_INFO_FADE_STEPS * HUD_INFO_FADE_STEP_MS; _startTitleScreen(); };
}

export function getMobileInputMode() {
  if (chatState.inputActive) return 'chat';
  if (titleSt.state === 'name-entry') return 'name';
  return 'none';
}

function _startDebugMode() {
  titleSt.state = 'done';
  mapSt.dungeonSeed = 1;
  clearDungeonCache();
  loadMapById(1004);
  playTrack(TRACKS.CRYSTAL_ROOM);
  setPlayerInventory({});
  addItem(0x54, 5);
  startGameLoop();
}
function _startTitleScreen() {
  titleSt.state = 'credit-wait';
  titleSt.timer = 0;
  titleSt.waterScroll = 0;
  titleSt.shipTimer = 0;
  titleSt.pressZ = isMobile
    ? new Uint8Array([0x99,0xB5,0xA8,0xB6,0xB6,0xFF,0x8A])  // "Press A"
    : new Uint8Array([0x99,0xB5,0xA8,0xB6,0xB6,0xFF,0xA3]); // "Press Z"
  playTrack(TRACKS.TITLE_SCREEN);
  startGameLoop();
}
export async function loadROM(arrayBuffer) {
  const _bootStart = performance.now();
  const romBytes = new Uint8Array(arrayBuffer);
  try {
    const ipsResp = await fetch('patches/ff3-awj.ips');
    if (ipsResp.ok) {
      const ipsData = new Uint8Array(await ipsResp.arrayBuffer());
      applyIPS(romBytes, ipsData);
    }
  } catch (_) { /* no patch file — continue with unpatched ROM */ }

  const rom = parseROM(romBytes.buffer);
  document.getElementById('rom-info').textContent =
    `PRG: ${rom.prgBanks} banks (${rom.prgSize / 1024}KB), ` +
    `CHR: ${rom.chrBanks} banks, Mapper: ${rom.mapper}`;
  const rawBytes = rom.raw;
  initTextDecoder(rawBytes);
  initFont(rawBytes);
  initSpriteAssets(rawBytes);
  setPlayerSprite(new Sprite(rawBytes, SPRITE_PAL_TOP, SPRITE_PAL_BTM));
  mapSt.worldMapData = loadWorldMap(rawBytes, 0);
  mapSt.worldMapRenderer = new WorldMapRenderer(mapSt.worldMapData);
  resetWorldWaterCache();
  initTitleAssets(rawBytes);
  initMapLoading(rawBytes);
  initSpellCast({ processNextTurn });
  initBattleEncounter({ resetBattleVars, tryJoinPlayerAlly });
  initBattleAlly({ buildTurnOrder, processNextTurn, isTeamWiped });
  initBattleEnemy({ processNextTurn, isTeamWiped });
  initInputHandler({ executeBattleCommand, startPVPBattle });
  initPVPSearch({ startPVPBattle });
  initPauseMenuInput({ returnToTitle });

  await loadSlotsFromDB();

  if (window.DEBUG_BOSS) { _startDebugMode(); return; }
  _startTitleScreen();

  // Wire console command context — APIs that commands consume but can't
  // import directly (circular dep risk).
  setCommandContext({
    getRosterNames: () => PLAYER_POOL.filter(p => p.loc === getPlayerLocation()).map(p => p.name),
    loadMapById,
  });

  // Startup console log — every line is real data pulled from the running
  // session. No fake metrics, no decorative numbers. Values:
  //   - VERSION: from data/strings.js (matches package.json on deploy)
  //   - rom.*: parsed iNES header counts + size formula (16k PRG, 8k CHR)
  //   - saveSlots: array of [name|null, name|null, name|null]; populated count
  //   - email + dev: from localStorage + DEV_EMAILS whitelist (chat.js)
  //   - boot: performance.now() delta from loadROM start
  const email = localStorage.getItem('ff3_email');
  const dev = isDev();
  const slotsUsed = saveSlots.filter(s => s != null).length;
  const prgKB = rom.prgSize / 1024;
  const chrKB = (rom.chrBanks * 8);
  const bootMs = Math.round(performance.now() - _bootStart);
  const startupMsgs = [
    'FF3 MMO v' + VERSION,
    'ROM ok  PRG=' + rom.prgBanks + 'x16k (' + prgKB + 'k)  CHR=' + rom.chrBanks + 'x8k (' + chrKB + 'k)  mapper=' + rom.mapper,
    'Save slots: ' + slotsUsed + '/3 used',
    'Auth: ' + (email || 'guest') + (dev ? ' [dev]' : ''),
    'Boot: ' + bootMs + 'ms',
    dev ? 'Type /help or /devhelp' : 'Type /help for commands',
    'Found a bug? Report it with /bug <description>',
  ];
  // First-run tips — fired once per browser-localStorage. Pushed AFTER the
  // boot lines so the user reads the system metadata first, then the
  // welcome. `ff3_first_run` is the sentinel; deleting it from localStorage
  // re-shows the tips on next load (useful for testing).
  let firstRun = false;
  try { firstRun = !localStorage.getItem('ff3_first_run'); } catch (_) {}
  if (firstRun) {
    startupMsgs.push(
      '',
      'Welcome! A few quick pointers:',
      '  Press T to open chat. Tab through World/Party/PM/System.',
      '  Cross grass tiles on the overworld to find monsters.',
      '  Roster panel shows real players online (green dot).',
      '  Roster: pick Party / Trade / Message / Inspect to interact.',
      '  /help lists commands (try /who, /block, /report).',
    );
    try { localStorage.setItem('ff3_first_run', '1'); } catch (_) {}
  }
  startupMsgs.forEach((msg, i) => setTimeout(() => consoleLog(msg), i * 350));
}


