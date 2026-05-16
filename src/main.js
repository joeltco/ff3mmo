// Game Client — boot wiring, ROM loading, composition root

import { parseROM } from './rom-parser.js';
import { Sprite } from './sprite.js';
import { loadWorldMap } from './world-map-loader.js';
import { WorldMapRenderer } from './world-map-renderer.js';
import { clearDungeonCache } from './dungeon-generator.js';
import { playTrack, TRACKS, fadeOutFF1Music, clearMusicStash } from './music.js';
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
import { initPVPSearch } from './pvp-search.js';
import { shopSt } from './shop.js';
import { setPlayerSprite } from './player-sprite.js';
import { startPVPBattle } from './pvp.js';
import { initMapLoading, loadMapById } from './map-loading.js';
import { initBattleAlly } from './battle-ally.js';
import { initBattleEnemy } from './battle-enemy.js';
import { buildTurnOrder, processNextTurn } from './battle-turn.js';
import { initBattleEncounter } from './battle-encounter.js';
import { initSpellCast } from './spell-cast.js';
import { addItem, setPlayerInventory } from './inventory.js';
import { saveSlots } from './save-state.js';
import { resetBattleVars, isTeamWiped, executeBattleCommand } from './battle-update.js';
import { startGameLoop } from './game-loop.js';
import { connectNet } from './net.js';
import { ps } from './player-stats.js';
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
      return {
        name:    slot.name || 'Player',
        jobIdx:  ps.jobIdx | 0,
        level:   ps.stats.level | 0 || 1,
        palIdx:  0,
        hp:      ps.hp | 0,
        maxHP:   ps.stats.maxHP | 0,
        // PvP hook chance is AGI-differential + Thief/Ranger bonus (see
        // `pvp-search.js#getHookChance`). Server uses the same formula on
        // `pvp-encounter` rolls, so AGI has to travel with the profile.
        agi:     ps.stats.agi | 0,
        weaponR: ps.weaponR | 0,
        weaponL: ps.weaponL | 0,
        armorId: ps.body | 0,
        helmId:  ps.head | 0,
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
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx.imageSmoothingEnabled = false;
  ui.canvas = canvas; ui.ctx = ctx;

  initKeyboardListeners();
  window.addEventListener('beforeunload', () => { saveSlotsToDB(); });
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
  initBattleEncounter({ resetBattleVars });
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
      '  Pick Battle on a roster row to issue a PvP challenge.',
      '  /help lists commands (try /who, /block, /report).',
    );
    try { localStorage.setItem('ff3_first_run', '1'); } catch (_) {}
  }
  startupMsgs.forEach((msg, i) => setTimeout(() => consoleLog(msg), i * 350));
}


