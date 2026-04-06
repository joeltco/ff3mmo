// input-handler.js — battle, roster, and pause menu input handlers

import { playSFX, SFX, pauseMusic, playFF1Track, FF1_TRACKS } from './music.js';
import { pauseSt } from './pause-menu.js';
import { transSt } from './transitions.js';
import { msgState, showMsgBox } from './message-box.js';
import { chatState, CHAT_TABS, activeTab, tabSelectMode, setActiveTab, setTabSelectMode, chatScrollOffset, setChatScrollOffset } from './chat.js';
import { ps, recalcCombatStats, changeJob, getEquipSlotId, setEquipSlotId, EQUIP_SLOT_SUBTYPE,
         getProfHits, getProfLevel, getHitWeapon, WEAPON_PROF_CATEGORY } from './player-stats.js';
import { ITEMS, isHandEquippable, isWeapon, weaponSubtype, isBladedWeapon } from './data/items.js';
import { selectCursor, saveSlots, saveSlotsToDB } from './save-state.js';
import { BASE_HIT_RATE, rollHits } from './battle-math.js';
import { _nameToBytes } from './text-utils.js';
import { MONSTERS } from './data/monsters.js';
import { JOBS, canJobEquip } from './data/jobs.js';

// Local constants (must match game.js)
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const BOSS_DEF = (MONSTERS.get(0xCC) || { def: 1 }).def;
const INV_SLOTS = 3;
const ROSTER_VISIBLE = 3;
const ROSTER_MENU_ITEMS = ['Party', 'Battle', 'Trade', 'Message', 'Inspect'];

// ── Mutable state (imported by game.js draw/update code) ───────────────────

export const inputSt = {
  // Battle menu + targeting
  battleCursor:       0,
  targetIndex:        0,
  hitResults:         [],
  playerActionPending: null,
  // Item management
  itemSelectList:     [],
  itemPage:           0,
  itemPageCursor:     0,
  itemSlideDir:       0,
  itemSlideCursor:    0,
  itemHeldIdx:        -1,
  itemTargetType:     'player',
  itemTargetIndex:    0,
  itemTargetAllyIndex: -1,
  itemTargetMode:     'single',
  // Proficiency tracking (applied on battle victory)
  battleProfHits:     {},
  // Roster browse/menu
  rosterState:        'none',
  rosterCursor:       0,
  rosterScroll:       0,
  rosterMenuCursor:   0,
  rosterMenuTimer:    0,
};

// Module-level shared context — set by each exported handler before delegating
// to private helpers, so helpers can access it without explicit parameter threading.
let _s = null;

// ── Key helpers ────────────────────────────────────────────────────────────

function _zPressed() {
  const k = _s.keys;
  if (!k['z'] && !k['Z']) return false;
  k['z'] = false; k['Z'] = false; return true;
}
function _xPressed() {
  const k = _s.keys;
  if (!k['x'] && !k['X']) return false;
  k['x'] = false; k['X'] = false; return true;
}

// ── Battle input ───────────────────────────────────────────────────────────

// Switch PVP target — just change the index; enemyHP getter/setter reads authoritative source
function _switchPVPTarget(newIdx) {
  _s.pvpPlayerTargetIdx = newIdx;
}

function _battleTargetNav() {
  const k = _s.keys;
  if (_s.isPVPBattle) {
    // Build list of alive PVP target indices: -1=main opp, 0,1,...=allies
    // Use authoritative HP: pvpOpponentStats.hp for main, pvpEnemyAllies[i].hp for allies
    const aliveTargets = [];
    if (_s.pvpOpponentStats && _s.pvpOpponentStats.hp > 0) aliveTargets.push(-1);
    (_s.pvpEnemyAllies || []).forEach((a, i) => { if (a.hp > 0) aliveTargets.push(i); });
    if (aliveTargets.length <= 1) return;
    const cur = _s.pvpPlayerTargetIdx;
    const ci = aliveTargets.indexOf(cur);
    if (k['ArrowRight'] || k['ArrowDown']) {
      k['ArrowRight'] = false; k['ArrowDown'] = false;
      _switchPVPTarget(aliveTargets[(ci + 1) % aliveTargets.length]);
      playSFX(SFX.CURSOR);
    }
    if (k['ArrowLeft'] || k['ArrowUp']) {
      k['ArrowLeft'] = false; k['ArrowUp'] = false;
      _switchPVPTarget(aliveTargets[(ci - 1 + aliveTargets.length) % aliveTargets.length]);
      playSFX(SFX.CURSOR);
    }
    return;
  }
  const enc = _s.encounterMonsters;
  if (!_s.isRandomEncounter || !enc) return;
  const aliveIdx = enc.reduce((a, m, i) => (m.hp > 0 ? [...a, i] : a), []);
  if (k['ArrowRight'] || k['ArrowDown']) {
    k['ArrowRight'] = false; k['ArrowDown'] = false;
    inputSt.targetIndex = aliveIdx[(aliveIdx.indexOf(inputSt.targetIndex) + 1) % aliveIdx.length];
    playSFX(SFX.CURSOR);
  }
  if (k['ArrowLeft'] || k['ArrowUp']) {
    k['ArrowLeft'] = false; k['ArrowUp'] = false;
    inputSt.targetIndex = aliveIdx[(aliveIdx.indexOf(inputSt.targetIndex) - 1 + aliveIdx.length) % aliveIdx.length];
    playSFX(SFX.CURSOR);
  }
}

function _battleTargetConfirm() {
  const k = _s.keys;
  if (!k['z'] && !k['Z']) return;
  k['z'] = false; k['Z'] = false;
  playSFX(SFX.CONFIRM);
  const rIsWeapon = isWeapon(ps.weaponR);
  const lIsWeapon = isWeapon(ps.weaponL);
  const dualWield = rIsWeapon && lIsWeapon;
  const unarmed = !rIsWeapon && !lIsWeapon;
  const baseHits = Math.max(1, Math.floor((ps.stats ? ps.stats.agi : 5) / 10));
  const wpnSubtype = weaponSubtype(ps.weaponR) || weaponSubtype(ps.weaponL) || 'unarmed';
  const profBonus = getProfHits(wpnSubtype);
  const potentialHits = (dualWield || unarmed) ? Math.max(2, baseHits) + profBonus : Math.max(1, baseHits) + profBonus;
  const wpn = (rIsWeapon ? ITEMS.get(ps.weaponR) : null) || (lIsWeapon ? ITEMS.get(ps.weaponL) : null);
  const hitRate = wpn ? wpn.hit : BASE_HIT_RATE;
  const profCat = WEAPON_PROF_CATEGORY[wpnSubtype] || wpnSubtype;
  const profLv = getProfLevel(profCat);
  if (_s.isRandomEncounter && _s.encounterMonsters) {
    inputSt.hitResults = rollHits(ps.atk, _s.encounterMonsters[inputSt.targetIndex].def, hitRate, potentialHits, profLv);
  } else {
    const targetDef = _s.isPVPBattle && _s.pvpOpponentStats
      ? (_s.pvpPlayerTargetIdx >= 0
          ? (_s.pvpEnemyAllies[_s.pvpPlayerTargetIdx] || _s.pvpOpponentStats).def
          : _s.pvpOpponentStats.def)
      : BOSS_DEF;
    inputSt.hitResults = rollHits(ps.atk, targetDef, hitRate, potentialHits, profLv);
  }
  const hitsLanded = inputSt.hitResults.filter(h => h > 0).length;
  if (hitsLanded > 0) inputSt.battleProfHits[wpnSubtype] = (inputSt.battleProfHits[wpnSubtype] || 0) + hitsLanded;
  const firstHandR = isWeapon(ps.weaponR) || !isWeapon(ps.weaponL);
  const firstWpnId = firstHandR ? ps.weaponR : ps.weaponL;
  const pendingSlashFrames = _s.getSlashFramesForWeapon(firstWpnId, firstHandR);
  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
  const firstWeapon0 = getHitWeapon(0);
  const pendingOffX = isBladedWeapon(firstWeapon0) ? 8 : Math.floor(Math.random() * 40) - 20;
  const pendingOffY = isBladedWeapon(firstWeapon0) ? -8 : Math.floor(Math.random() * 40) - 20;
  inputSt.playerActionPending = {
    command: 'fight', targetIndex: inputSt.targetIndex, hitResults: inputSt.hitResults,
    slashFrames: pendingSlashFrames, slashOffX: pendingOffX, slashOffY: pendingOffY,
    slashX: centerX, slashY: centerY
  };
  _s.battleState = 'confirm-pause';
  _s.battleTimer = 0;
}

function _battleInputTargetSelect() {
  _battleTargetNav();
  _battleTargetConfirm();
  if (_xPressed()) {
    playSFX(SFX.CONFIRM);
    _s.battleState = 'menu-open';
    _s.battleTimer = 0;
  }
}

function _itemSelectNav(isEquipPage, totalPages, pageRows) {
  const k = _s.keys;
  if (k['ArrowDown']) {
    k['ArrowDown'] = false;
    if (inputSt.itemPageCursor < pageRows - 1) inputSt.itemPageCursor++;
    else if (inputSt.itemPage < totalPages - 1) { inputSt.itemSlideDir = -1; inputSt.itemSlideCursor = 0; _s.battleState = 'item-slide'; _s.battleTimer = 0; }
    playSFX(SFX.CURSOR);
  }
  if (k['ArrowUp']) {
    k['ArrowUp'] = false;
    if (inputSt.itemPageCursor > 0) inputSt.itemPageCursor--;
    else if (inputSt.itemPage > 0) { inputSt.itemSlideDir = 1; inputSt.itemSlideCursor = (inputSt.itemPage - 1) === 0 ? 1 : INV_SLOTS - 1; _s.battleState = 'item-slide'; _s.battleTimer = 0; }
    playSFX(SFX.CURSOR);
  }
  if (k['ArrowLeft'] && inputSt.itemPage > 0) {
    k['ArrowLeft'] = false; playSFX(SFX.CURSOR);
    inputSt.itemSlideDir = 1; inputSt.itemSlideCursor = 0; _s.battleState = 'item-slide'; _s.battleTimer = 0;
  }
  if (k['ArrowRight'] && inputSt.itemPage < totalPages - 1) {
    k['ArrowRight'] = false; playSFX(SFX.CURSOR);
    inputSt.itemSlideDir = -1; inputSt.itemSlideCursor = 0; _s.battleState = 'item-slide'; _s.battleTimer = 0;
  }
}

function _itemSelectSwap(isEquipPage, gIdx) {
  const srcEquip = inputSt.itemHeldIdx <= -100;
  const dstEquip = isEquipPage;
  if (!srcEquip && !dstEquip) {
    const dstIdx = (inputSt.itemPage - 1) * INV_SLOTS + inputSt.itemPageCursor;
    const tmp = inputSt.itemSelectList[inputSt.itemHeldIdx];
    inputSt.itemSelectList[inputSt.itemHeldIdx] = inputSt.itemSelectList[dstIdx];
    inputSt.itemSelectList[dstIdx] = tmp;
    inputSt.itemHeldIdx = -1; playSFX(SFX.CONFIRM);
  } else if (!srcEquip && dstEquip) {
    const item = inputSt.itemSelectList[inputSt.itemHeldIdx];
    const handIdx = inputSt.itemPageCursor;
    if (item && isHandEquippable(ITEMS.get(item.id)) && canJobEquip(ps.jobIdx, item.id, ITEMS)) {
      const oldWeapon = handIdx === 0 ? ps.weaponR : ps.weaponL;
      if (handIdx === 0) ps.weaponR = item.id; else ps.weaponL = item.id;
      _s.removeItem(item.id);
      if (oldWeapon !== 0) _s.addItem(oldWeapon, 1);
      inputSt.itemSelectList[inputSt.itemHeldIdx] = oldWeapon !== 0 ? { id: oldWeapon, count: 1 } : null;
      recalcCombatStats(); inputSt.itemHeldIdx = -1; playSFX(SFX.CONFIRM);
    } else { playSFX(SFX.ERROR); inputSt.itemHeldIdx = -1; }
  } else if (srcEquip && !dstEquip) {
    const srcHand = -(inputSt.itemHeldIdx + 100);
    const handWeaponId = srcHand === 0 ? ps.weaponR : ps.weaponL;
    const dstIdx = (inputSt.itemPage - 1) * INV_SLOTS + inputSt.itemPageCursor;
    const invItem = inputSt.itemSelectList[dstIdx];
    if (invItem && isHandEquippable(ITEMS.get(invItem.id)) && canJobEquip(ps.jobIdx, invItem.id, ITEMS)) {
      if (srcHand === 0) ps.weaponR = invItem.id; else ps.weaponL = invItem.id;
      _s.removeItem(invItem.id); _s.addItem(handWeaponId, 1);
      inputSt.itemSelectList[dstIdx] = { id: handWeaponId, count: 1 };
      recalcCombatStats(); inputSt.itemHeldIdx = -1; playSFX(SFX.CONFIRM);
    } else if (!invItem) {
      if (srcHand === 0) ps.weaponR = 0; else ps.weaponL = 0;
      _s.addItem(handWeaponId, 1);
      inputSt.itemSelectList[dstIdx] = { id: handWeaponId, count: 1 };
      recalcCombatStats(); inputSt.itemHeldIdx = -1; playSFX(SFX.CONFIRM);
    } else { playSFX(SFX.ERROR); inputSt.itemHeldIdx = -1; }
  } else {
    const tmp = ps.weaponR; ps.weaponR = ps.weaponL; ps.weaponL = tmp;
    recalcCombatStats(); inputSt.itemHeldIdx = -1; playSFX(SFX.CONFIRM);
  }
}

function _itemSelectZ(isEquipPage, gIdx) {
  if (inputSt.itemHeldIdx === -1) {
    if (isEquipPage) {
      const weaponId = inputSt.itemPageCursor === 0 ? ps.weaponR : ps.weaponL;
      if (weaponId !== 0) { inputSt.itemHeldIdx = gIdx; playSFX(SFX.CONFIRM); } else playSFX(SFX.ERROR);
    } else {
      const invIdx = (inputSt.itemPage - 1) * INV_SLOTS + inputSt.itemPageCursor;
      if (inputSt.itemSelectList[invIdx] !== null) { inputSt.itemHeldIdx = gIdx; playSFX(SFX.CONFIRM); } else playSFX(SFX.ERROR);
    }
  } else if (inputSt.itemHeldIdx === gIdx) {
    if (!isEquipPage) {
      const invIdx = (inputSt.itemPage - 1) * INV_SLOTS + inputSt.itemPageCursor;
      const item = inputSt.itemSelectList[invIdx];
      const itemDat = ITEMS.get(item.id);
      if (itemDat?.type === 'consumable' || itemDat?.type === 'battle_item') {
        playSFX(SFX.CONFIRM); inputSt.itemHeldIdx = -1; inputSt.itemTargetMode = 'single';
        if (itemDat.type === 'battle_item' && _s.isRandomEncounter && _s.encounterMonsters) {
          inputSt.itemTargetType = 'enemy';
          const ecnt = _s.encounterMonsters.length;
          const ealive = (i) => i < _s.encounterMonsters.length && _s.encounterMonsters[i].hp > 0;
          const rightCandidates = ecnt === 1 ? [0] : ecnt === 2 ? [1] : ecnt === 3 ? [1] : [1,3];
          const leftCandidates  = ecnt === 1 ? [0] : ecnt === 2 ? [0] : ecnt === 3 ? [0,2] : [0,2];
          const first = [...rightCandidates,...leftCandidates].find(i => ealive(i));
          inputSt.itemTargetIndex = first !== undefined ? first : 0;
        } else if (itemDat.type === 'battle_item' && !_s.isRandomEncounter) {
          inputSt.itemTargetType = 'enemy';
          // Default to first alive PVP target (grid index)
          const cnt = 1 + (_s.pvpEnemyAllies ? _s.pvpEnemyAllies.length : 0);
          let first = 0;
          for (let ii = 0; ii < cnt; ii++) { if (_itemTargetAlive(ii)) { first = ii; break; } }
          inputSt.itemTargetIndex = first;
        } else {
          inputSt.itemTargetType = 'player'; inputSt.itemTargetIndex = 0;
        }
        inputSt.itemTargetAllyIndex = -1; _s.battleState = 'item-target-select'; _s.battleTimer = 0;
        inputSt.playerActionPending = { command: 'item', itemId: item.id };
      } else { inputSt.itemHeldIdx = -1; playSFX(SFX.CONFIRM); }
    } else { inputSt.itemHeldIdx = -1; playSFX(SFX.CONFIRM); }
  } else {
    _itemSelectSwap(isEquipPage, gIdx);
  }
}

function _battleInputItemSelect() {
  const isEquipPage = inputSt.itemPage === 0;
  const pageRows = isEquipPage ? 2 : INV_SLOTS;
  const totalPages = 1 + Math.max(1, Math.ceil(inputSt.itemSelectList.length / INV_SLOTS));
  _itemSelectNav(isEquipPage, totalPages, pageRows);
  if (_zPressed()) {
    const gIdx = isEquipPage ? -100 - inputSt.itemPageCursor : (inputSt.itemPage - 1) * INV_SLOTS + inputSt.itemPageCursor;
    _itemSelectZ(isEquipPage, gIdx);
  }
  if (_xPressed()) {
    if (inputSt.itemHeldIdx !== -1) { inputSt.itemHeldIdx = -1; playSFX(SFX.CONFIRM); }
    else { playSFX(SFX.CONFIRM); _s.battleState = 'item-cancel-out'; _s.battleTimer = 0; }
  }
}

function _itemTargetCnt() {
  if (_s.isPVPBattle) return 1 + (_s.pvpEnemyAllies ? _s.pvpEnemyAllies.length : 0);
  return _s.isRandomEncounter && _s.encounterMonsters ? _s.encounterMonsters.length : (_s.isRandomEncounter ? 0 : 1);
}
function _itemTargetAlive(i) {
  if (_s.isPVPBattle) {
    if (i === 0) return _s.pvpOpponentStats && _s.pvpOpponentStats.hp > 0;
    const a = _s.pvpEnemyAllies && _s.pvpEnemyAllies[i - 1];
    return !!(a && a.hp > 0);
  }
  return _s.isRandomEncounter && _s.encounterMonsters && i < _s.encounterMonsters.length && _s.encounterMonsters[i].hp > 0;
}
// PVP grid: right col = indices 0,2 (gc=cols-1). Encounter grid: right col = indices 1,3.
function _itemTargetIsRightCol(i) {
  if (_s.isPVPBattle) return _itemTargetCnt() <= 1 || i === 0 || i === 2;
  const cnt = _itemTargetCnt();
  return cnt === 1 || (cnt === 2 && i === 1) || (cnt >= 3 && (i === 1 || i === 3));
}
function _itemTargetIsLeftCol(i) { return _itemTargetCnt() >= 2 && !_itemTargetIsRightCol(i); }

function _itemTargetNavLeft(isBattleItem) {
  const cnt = _itemTargetCnt();
  if (isBattleItem && inputSt.itemTargetMode !== 'single') {
    // col/all mode → back to single. Left-col candidates differ per mode.
    const leftCandidates = _s.isPVPBattle
      ? (cnt <= 1 ? [0] : cnt === 2 ? [1] : [1, 3])      // PVP left col = 1,3
      : (cnt <= 1 ? [0] : cnt === 2 ? [0] : [0, 2]);      // encounter left col = 0,2
    const found = leftCandidates.find(i => _itemTargetAlive(i));
    if (found !== undefined) inputSt.itemTargetIndex = found;
    inputSt.itemTargetMode = 'single'; playSFX(SFX.CURSOR);
  } else if (inputSt.itemTargetType === 'player') {
    if (_s.isPVPBattle) {
      // PVP: player → right col of PVP grid (idx 0)
      const rightCandidates = cnt === 1 ? [0] : cnt === 2 ? [0] : cnt === 3 ? [0] : [0, 2];
      const leftCandidates  = cnt === 2 ? [1] : cnt === 3 ? [1, 3] : cnt >= 4 ? [1, 3] : [];
      let found = rightCandidates.find(i => _itemTargetAlive(i));
      if (found === undefined) found = leftCandidates.find(i => _itemTargetAlive(i));
      if (found !== undefined) {
        inputSt.itemTargetType = 'enemy'; inputSt.itemTargetIndex = found; inputSt.itemTargetMode = 'single'; playSFX(SFX.CURSOR);
      }
    } else if (_s.isRandomEncounter) {
      const rightCandidates = cnt === 1 ? [0] : cnt === 2 ? [1] : cnt === 3 ? [1] : [1, 3];
      const leftCandidates  = cnt === 2 ? [0] : cnt === 3 ? [0, 2] : cnt >= 4 ? [0, 2] : [];
      let found = rightCandidates.find(i => _itemTargetAlive(i));
      if (found === undefined) found = leftCandidates.find(i => _itemTargetAlive(i));
      if (found !== undefined) {
        inputSt.itemTargetType = 'enemy'; inputSt.itemTargetIndex = found; inputSt.itemTargetMode = 'single'; playSFX(SFX.CURSOR);
      }
    } else {
      inputSt.itemTargetType = 'enemy'; inputSt.itemTargetIndex = 0; inputSt.itemTargetMode = 'single'; playSFX(SFX.CURSOR);
    }
  } else if (_itemTargetIsRightCol(inputSt.itemTargetIndex)) {
    // right col → left col
    const idx = inputSt.itemTargetIndex;
    const [leftPeer, leftOther] = _s.isPVPBattle
      ? [idx === 0 ? 1 : idx === 2 ? 3 : -1, idx === 0 ? 3 : idx === 2 ? 1 : -1]   // PVP: 0→1, 2→3
      : [idx === 1 ? 0 : idx === 3 ? 2 : -1, idx === 1 ? 2 : idx === 3 ? 0 : -1];  // encounter: 1→0, 3→2
    if (leftPeer >= 0 && _itemTargetAlive(leftPeer)) { inputSt.itemTargetIndex = leftPeer; playSFX(SFX.CURSOR); }
    else if (leftOther >= 0 && _itemTargetAlive(leftOther)) { inputSt.itemTargetIndex = leftOther; playSFX(SFX.CURSOR); }
    else if (isBattleItem) { inputSt.itemTargetMode = 'all'; playSFX(SFX.CURSOR); }
  } else if (isBattleItem && _itemTargetIsLeftCol(inputSt.itemTargetIndex)) {
    inputSt.itemTargetMode = 'all'; playSFX(SFX.CURSOR);
  }
}

function _itemTargetNavRight() {
  if (inputSt.itemTargetType !== 'enemy') return;
  if (_s.isPVPBattle) {
    if (_itemTargetIsRightCol(inputSt.itemTargetIndex)) {
      inputSt.itemTargetType = 'player'; playSFX(SFX.CURSOR);
    } else {
      // PVP left col (1,3) → right col (0,2)
      const idx = inputSt.itemTargetIndex;
      const rightPeer  = idx === 1 ? 0 : idx === 3 ? 2 : -1;
      const rightOther = idx === 1 ? 2 : idx === 3 ? 0 : -1;
      if (rightPeer >= 0 && _itemTargetAlive(rightPeer)) { inputSt.itemTargetIndex = rightPeer; playSFX(SFX.CURSOR); }
      else if (rightOther >= 0 && _itemTargetAlive(rightOther)) { inputSt.itemTargetIndex = rightOther; playSFX(SFX.CURSOR); }
      else { inputSt.itemTargetType = 'player'; playSFX(SFX.CURSOR); }
    }
    return;
  }
  if (_itemTargetIsRightCol(inputSt.itemTargetIndex) || !_s.isRandomEncounter) {
    inputSt.itemTargetType = 'player'; playSFX(SFX.CURSOR);
  } else {
    const rightPeer = inputSt.itemTargetIndex === 0 ? 1 : inputSt.itemTargetIndex === 2 ? 3 : -1;
    const rightOther = inputSt.itemTargetIndex === 0 ? 3 : inputSt.itemTargetIndex === 2 ? 1 : -1;
    if (rightPeer >= 0 && _itemTargetAlive(rightPeer)) { inputSt.itemTargetIndex = rightPeer; playSFX(SFX.CURSOR); }
    else if (rightOther >= 0 && _itemTargetAlive(rightOther)) { inputSt.itemTargetIndex = rightOther; playSFX(SFX.CURSOR); }
    else { inputSt.itemTargetType = 'player'; playSFX(SFX.CURSOR); }
  }
}

function _itemTargetNavVertical(isBattleItem) {
  const k = _s.keys;
  const goUp = !!k['ArrowUp'];
  k['ArrowUp'] = false; k['ArrowDown'] = false;
  const cnt = _itemTargetCnt();
  if (isBattleItem && inputSt.itemTargetType === 'enemy' && (_s.isPVPBattle || (_s.isRandomEncounter && _s.encounterMonsters))) {
    if (goUp && inputSt.itemTargetMode === 'single') {
      inputSt.itemTargetMode = _itemTargetIsLeftCol(inputSt.itemTargetIndex) ? 'col-left' : 'col-right';
      playSFX(SFX.CURSOR);
    } else if (!goUp && inputSt.itemTargetMode !== 'single') {
      inputSt.itemTargetMode = 'single'; playSFX(SFX.CURSOR);
    }
  } else if (inputSt.itemTargetType === 'enemy' && (_s.isPVPBattle || (_s.isRandomEncounter && _s.encounterMonsters))) {
    const vertMap = cnt >= 4 ? { 0: 2, 2: 0, 1: 3, 3: 1 } :
                    cnt === 3 ? { 0: 2, 2: 0, 1: 1 } : {};
    const next = vertMap[inputSt.itemTargetIndex];
    if (next !== undefined && next !== inputSt.itemTargetIndex && _itemTargetAlive(next)) {
      inputSt.itemTargetIndex = next; playSFX(SFX.CURSOR);
    }
  } else if (inputSt.itemTargetType === 'player') {
    const livingAllies = _s.battleAllies.filter(a => a.hp > 0);
    if (!goUp && inputSt.itemTargetAllyIndex < livingAllies.length - 1) {
      inputSt.itemTargetAllyIndex++; playSFX(SFX.CURSOR);
    } else if (goUp && inputSt.itemTargetAllyIndex >= 0) {
      inputSt.itemTargetAllyIndex--; playSFX(SFX.CURSOR);
    }
  }
}

function _battleInputItemTargetSelect() {
  const isBattleItem = inputSt.playerActionPending && ITEMS.get(inputSt.playerActionPending.itemId)?.type === 'battle_item';
  const k = _s.keys;
  if (k['ArrowLeft']) { k['ArrowLeft'] = false; _itemTargetNavLeft(isBattleItem); }
  if (k['ArrowRight']) { k['ArrowRight'] = false; _itemTargetNavRight(); }
  if (k['ArrowUp'] || k['ArrowDown']) _itemTargetNavVertical(isBattleItem);
  if (_zPressed()) {
    inputSt.playerActionPending.target = inputSt.itemTargetType === 'player' ? 'player' : inputSt.itemTargetIndex;
    inputSt.playerActionPending.allyIndex = inputSt.itemTargetType === 'player' ? inputSt.itemTargetAllyIndex : -1;
    inputSt.playerActionPending.targetMode = inputSt.itemTargetMode;
    playSFX(SFX.CONFIRM); _s.battleState = 'item-list-out'; _s.battleTimer = 0;
  }
  if (_xPressed()) {
    inputSt.playerActionPending = null; playSFX(SFX.CONFIRM); _s.battleState = 'item-select'; _s.battleTimer = 0;
  }
}

function _battleInputHoldStates() {
  const k = _s.keys;
  const z = k['z'] || k['Z'];
  const clearZ = () => { k['z'] = false; k['Z'] = false; };
  if (_s.battleState === 'roar-hold') {
    if (msgState.state === 'hold' && z) { clearZ(); msgState.state = 'slide-out'; msgState.timer = 0; }
  } else if (_s.battleState === 'defeat-text') {
    if (z) { clearZ(); _s.battleState = 'defeat-close'; _s.battleTimer = 0; }
  } else if (_s.battleState === 'victory-hold') {
    if (z) { clearZ(); _s.battleState = 'victory-fade-out'; _s.battleTimer = 0; }
  } else if (_s.battleState === 'exp-hold') {
    if (z) { clearZ(); _s.battleState = 'exp-fade-out'; _s.battleTimer = 0; }
  } else if (_s.battleState === 'gil-hold') {
    if (z) { clearZ(); _s.battleState = (ps.leveledUp || _s.encounterDropItem !== null) ? 'gil-fade-out' : _s.encounterProfLevelUps.length > 0 ? 'prof-levelup-text-in' : 'victory-text-out'; _s.battleTimer = 0; }
  } else if (_s.battleState === 'item-hold') {
    if (z) { clearZ(); _s.battleState = ps.leveledUp ? 'item-fade-out' : _s.encounterProfLevelUps.length > 0 ? 'prof-levelup-text-in' : 'victory-text-out'; _s.battleTimer = 0; }
  } else if (_s.battleState === 'levelup-hold') {
    if (z) { clearZ(); _s.battleState = _s.encounterProfLevelUps.length > 0 ? 'prof-levelup-text-in' : 'victory-text-out'; _s.battleTimer = 0; }
  } else if (_s.battleState === 'prof-levelup-hold') {
    if (z) {
      clearZ();
      if (_s.profLevelUpIdx + 1 < _s.encounterProfLevelUps.length) { _s.profLevelUpIdx++; _s.battleState = 'prof-levelup-text-in'; }
      else { _s.battleState = 'victory-text-out'; }
      _s.battleTimer = 0;
    }
  } else { return false; }
  return true;
}

// shared = { keys, battleAllies, encounterMonsters, encounterDropItem, encounterProfLevelUps,
//            profLevelUpIdx (get/set), isRandomEncounter, isPVPBattle, pvpOpponentStats,
//            get/set battleState, get/set battleTimer,
//            executeBattleCommand, getSlashFramesForWeapon,
//            addItem, removeItem }
export function handleBattleInput(shared) {
  _s = shared;
  if (_s.battleState === 'none') return false;
  if (_battleInputHoldStates()) return true;
  const k = _s.keys;
  if (_s.battleState === 'menu-open') {
    if (k['ArrowDown'])  { k['ArrowDown'] = false;  inputSt.battleCursor ^= 2; playSFX(SFX.CURSOR); }
    if (k['ArrowUp'])    { k['ArrowUp'] = false;    inputSt.battleCursor ^= 2; playSFX(SFX.CURSOR); }
    if (k['ArrowRight']) { k['ArrowRight'] = false; inputSt.battleCursor ^= 1; playSFX(SFX.CURSOR); }
    if (k['ArrowLeft'])  { k['ArrowLeft'] = false;  inputSt.battleCursor ^= 1; playSFX(SFX.CURSOR); }
    if (k['z'] || k['Z']) { k['z'] = false; k['Z'] = false; _s.executeBattleCommand(inputSt.battleCursor); }
  } else if (_s.battleState === 'target-select') { _battleInputTargetSelect();
  } else if (_s.battleState === 'item-select') { _battleInputItemSelect();
  } else if (_s.battleState === 'item-target-select') { _battleInputItemTargetSelect();
  }
  return true;
}

// ── Roster input ───────────────────────────────────────────────────────────

function _rosterInputBrowse() {
  const rp = _s.getRosterVisible();
  const k = _s.keys;
  if (k['ArrowDown']) {
    k['ArrowDown'] = false;
    if (inputSt.rosterCursor < rp.length - 1) {
      inputSt.rosterCursor++;
      if (inputSt.rosterCursor - inputSt.rosterScroll >= ROSTER_VISIBLE) inputSt.rosterScroll++;
      playSFX(SFX.CURSOR);
    }
  }
  if (k['ArrowUp']) {
    k['ArrowUp'] = false;
    if (inputSt.rosterCursor > 0) {
      inputSt.rosterCursor--;
      if (inputSt.rosterCursor < inputSt.rosterScroll) inputSt.rosterScroll--;
      playSFX(SFX.CURSOR);
    }
  }
  if (_zPressed()) {
    inputSt.rosterState = 'menu-in';
    inputSt.rosterMenuTimer = 0;
    inputSt.rosterMenuCursor = 0;
    playSFX(SFX.CONFIRM);
  }
  if (_xPressed()) {
    inputSt.rosterState = 'none';
    playSFX(SFX.CONFIRM);
  }
}

function _rosterMenuDuelAction(target) {
  const challenged = _nameToBytes('Challenged ');
  const nameBytes = _nameToBytes(target.name);
  const exclam = new Uint8Array([0xC4]);
  const challengeMsg = new Uint8Array(challenged.length + nameBytes.length + 1);
  challengeMsg.set(challenged, 0); challengeMsg.set(nameBytes, challenged.length); challengeMsg.set(exclam, challenged.length + nameBytes.length);
  showMsgBox(challengeMsg, () => {
    setTimeout(() => showMsgBox(_nameToBytes(target.name + ' accepted!'), () => _s.startPVPBattle(target)),
      1500 + Math.floor(Math.random() * 2500));
  });
}

function _rosterInputMenu() {
  const k = _s.keys;
  if (k['ArrowDown']) {
    k['ArrowDown'] = false;
    inputSt.rosterMenuCursor = (inputSt.rosterMenuCursor + 1) % ROSTER_MENU_ITEMS.length;
    playSFX(SFX.CURSOR);
  }
  if (k['ArrowUp']) {
    k['ArrowUp'] = false;
    inputSt.rosterMenuCursor = (inputSt.rosterMenuCursor + ROSTER_MENU_ITEMS.length - 1) % ROSTER_MENU_ITEMS.length;
    playSFX(SFX.CURSOR);
  }
  if (_zPressed()) {
    const action = ROSTER_MENU_ITEMS[inputSt.rosterMenuCursor];
    const target = _s.getRosterVisible()[inputSt.rosterCursor];
    inputSt.rosterState = 'menu-out';
    inputSt.rosterMenuTimer = 0;
    playSFX(SFX.CONFIRM);
    if (action === 'Battle' && (_s.onWorldMap || _s.dungeonFloor >= 0)) {
      _rosterMenuDuelAction(target);
    } else {
      const actionBytes = _nameToBytes(action), nameBytes = _nameToBytes(target.name);
      const sep = new Uint8Array([0xFF]);
      const msg = new Uint8Array(actionBytes.length + 1 + nameBytes.length);
      msg.set(actionBytes, 0); msg.set(sep, actionBytes.length); msg.set(nameBytes, actionBytes.length + 1);
      showMsgBox(msg);
    }
  }
  if (_xPressed()) {
    inputSt.rosterState = 'menu-out';
    inputSt.rosterMenuTimer = 0;
    playSFX(SFX.CONFIRM);
  }
}

// shared = { keys, get/set battleState, get shakeActive, get starEffect, get moving,
//            get onWorldMap, get dungeonFloor,
//            getRosterVisible, startPVPBattle }
export function handleRosterInput(shared) {
  _s = shared;
  const k = _s.keys;
  if (k['s'] || k['S']) {
    k['s'] = false; k['S'] = false;
    if (tabSelectMode) {
      // S from tab select → exit tabs and roster
      setTabSelectMode(false);
      inputSt.rosterState = 'none';
      playSFX(SFX.CONFIRM);
    } else if (inputSt.rosterState === 'none' && _s.battleState === 'none' && pauseSt.state === 'none' && transSt.state === 'none' && !_s.shakeActive && !_s.starEffect && !_s.moving && msgState.state === 'none') {
      inputSt.rosterState = 'browse';
      inputSt.rosterCursor = 0;
      inputSt.rosterScroll = 0;
      playSFX(SFX.CONFIRM);
    } else if (inputSt.rosterState === 'browse') {
      // S from roster browse → tab select
      inputSt.rosterState = 'none';
      setTabSelectMode(true);
      playSFX(SFX.CONFIRM);
    }
    return true;
  }
  if (tabSelectMode) { _tabSelectInput(); return true; }
  if (inputSt.rosterState === 'browse') { _rosterInputBrowse(); return true; }
  if (inputSt.rosterState === 'menu')   { _rosterInputMenu();   return true; }
  if ((inputSt.rosterState === 'menu-in' || inputSt.rosterState === 'menu-out') && msgState.state === 'none') return true;
  return false;
}

// ── Tab select input ──────────────────────────────────────────────────────

function _tabSelectInput() {
  const k = _s.keys;
  if (k['ArrowLeft']) {
    k['ArrowLeft'] = false;
    setActiveTab((activeTab - 1 + CHAT_TABS.length) % CHAT_TABS.length);
    playSFX(SFX.CURSOR);
  }
  if (k['ArrowRight']) {
    k['ArrowRight'] = false;
    setActiveTab((activeTab + 1) % CHAT_TABS.length);
    playSFX(SFX.CURSOR);
  }
  // Up/down scrolls chat history on Private tab
  if (CHAT_TABS[activeTab] === 'Private') {
    if (k['ArrowUp']) {
      k['ArrowUp'] = false;
      setChatScrollOffset(chatScrollOffset + 1);
      playSFX(SFX.CURSOR);
    }
    if (k['ArrowDown']) {
      k['ArrowDown'] = false;
      setChatScrollOffset(Math.max(0, chatScrollOffset - 1));
      playSFX(SFX.CURSOR);
    }
  }
  if (k['x'] || k['X'] || k['Escape']) {
    k['x'] = false; k['X'] = false; k['Escape'] = false;
    setTabSelectMode(false);
    playSFX(SFX.CONFIRM);
  }
  if (k['z'] || k['Z'] || k['Enter']) {
    k['z'] = false; k['Z'] = false; k['Enter'] = false;
    setTabSelectMode(false);
    playSFX(SFX.CONFIRM);
  }
}

// ── Pause input ────────────────────────────────────────────────────────────

function _pauseInputOpenClose() {
  const k = _s.keys;
  if (k['Enter']) {
    k['Enter'] = false;
    if (pauseSt.state === 'none' && _s.battleState === 'none' && transSt.state === 'none' && !_s.shakeActive && !_s.starEffect && !_s.moving && msgState.state === 'none') {
      playSFX(SFX.CONFIRM);
      pauseMusic();
      playFF1Track(FF1_TRACKS.MENU_SCREEN);
      pauseSt.state = 'scroll-in'; pauseSt.timer = 0; pauseSt.cursor = 0;
    }
    return true;
  }
  if (k['x'] || k['X']) {
    if (pauseSt.state === 'open') {
      k['x'] = false; k['X'] = false;
      playSFX(SFX.CONFIRM);
      pauseSt.state = 'text-out'; pauseSt.timer = 0;
      return true;
    }
  }
  return false;
}

function _pauseInputMainMenu() {
  if (pauseSt.state !== 'open') return false;
  const k = _s.keys;
  if (k['ArrowDown']) { k['ArrowDown'] = false; pauseSt.cursor = (pauseSt.cursor + 1) % 7; playSFX(SFX.CURSOR); }
  if (k['ArrowUp'])   { k['ArrowUp'] = false;   pauseSt.cursor = (pauseSt.cursor + 6) % 7; playSFX(SFX.CURSOR); }
  if (_zPressed()) {
    if (pauseSt.cursor === 0) {
      playSFX(SFX.CONFIRM);
      pauseSt.state = 'inv-text-out'; pauseSt.timer = 0; pauseSt.invScroll = 0;
    } else if (pauseSt.cursor === 2) {
      playSFX(SFX.CONFIRM);
      pauseSt.state = 'eq-text-out'; pauseSt.timer = 0; pauseSt.eqCursor = 0;
    } else if (pauseSt.cursor === 3) {
      playSFX(SFX.CONFIRM);
      pauseSt.state = 'stats-text-out'; pauseSt.timer = 0;
    } else if (pauseSt.cursor === 4) {
      playSFX(SFX.CONFIRM);
      pauseSt.jobList = [];
      for (let i = 0; i < 22; i++) { if ((ps.unlockedJobs >> i) & 1) pauseSt.jobList.push(i); }
      pauseSt.jobCursor = Math.max(0, pauseSt.jobList.indexOf(ps.jobIdx));
      pauseSt.state = 'job-text-out'; pauseSt.timer = 0;
    } else if (pauseSt.cursor === 5) {
      playSFX(SFX.CONFIRM);
      pauseSt.state = 'options-text-out'; pauseSt.timer = 0; pauseSt.optCursor = 0;
    } else if (pauseSt.cursor === 6) {
      playSFX(SFX.CONFIRM);
      _s.returnToTitle();
    }
  }
  return true;
}

function _pauseInvZPress(entries) {
  if (pauseSt.heldItem === -1) {
    if (entries.length > 0 && entries[pauseSt.invScroll]) { pauseSt.heldItem = pauseSt.invScroll; playSFX(SFX.CONFIRM); }
    else playSFX(SFX.ERROR);
  } else if (pauseSt.heldItem === pauseSt.invScroll) {
    const [id] = entries[pauseSt.heldItem]; const item = ITEMS.get(Number(id));
    if (item && item.type === 'consumable') {
      playSFX(SFX.CONFIRM); pauseSt.heldItem = -1;
      pauseSt.state = 'inv-target'; pauseSt.timer = 0; pauseSt.useItemId = Number(id); pauseSt.invAllyTarget = -1;
    } else { pauseSt.heldItem = -1; playSFX(SFX.CONFIRM); }
  } else {
    if (entries[pauseSt.invScroll]) { pauseSt.heldItem = pauseSt.invScroll; playSFX(SFX.CONFIRM); }
    else { pauseSt.heldItem = -1; playSFX(SFX.ERROR); }
  }
}

function _pauseInputInventory() {
  if (pauseSt.state !== 'inventory') return false;
  const entries = Object.entries(_s.playerInventory).filter(([,c]) => c > 0);
  const k = _s.keys;
  if (k['ArrowDown']) {
    k['ArrowDown'] = false;
    if (pauseSt.invScroll < entries.length - 1) { pauseSt.invScroll++; playSFX(SFX.CURSOR); }
  }
  if (k['ArrowUp']) {
    k['ArrowUp'] = false;
    if (pauseSt.invScroll > 0) { pauseSt.invScroll--; playSFX(SFX.CURSOR); }
  }
  if (k['z'] || k['Z']) { k['z'] = false; k['Z'] = false; _pauseInvZPress(entries); }
  if (_xPressed()) {
    if (pauseSt.heldItem !== -1) { pauseSt.heldItem = -1; playSFX(SFX.CONFIRM); }
    else { playSFX(SFX.CONFIRM); pauseSt.state = 'inv-items-out'; pauseSt.timer = 0; }
  }
  return true;
}

function _applyPauseItemUse(item, rosterTargets) {
  if (!item || item.effect !== 'restore_hp') { playSFX(SFX.ERROR); return; }
  if (pauseSt.invAllyTarget >= 0) {
    const rp = rosterTargets[pauseSt.invAllyTarget];
    if (!rp) { playSFX(SFX.ERROR); return; }
    const heal = Math.min(item.value, rp.maxHP - rp.hp);
    rp.hp += heal; _s.removeItem(pauseSt.useItemId); playSFX(SFX.CURE);
    pauseSt.healNum = { value: heal, timer: 0, rosterIdx: pauseSt.invAllyTarget };
    pauseSt.state = 'inv-heal'; pauseSt.timer = 0;
    if (selectCursor >= 0 && saveSlots[selectCursor]) { saveSlots[selectCursor].inventory = { ..._s.playerInventory }; saveSlotsToDB(); }
  } else {
    const heal = Math.min(item.value, ps.stats.maxHP - ps.hp);
    ps.hp += heal; _s.removeItem(pauseSt.useItemId); playSFX(SFX.CURE);
    pauseSt.healNum = { value: heal, timer: 0 };
    pauseSt.state = 'inv-heal'; pauseSt.timer = 0;
    if (selectCursor >= 0 && saveSlots[selectCursor]) { saveSlots[selectCursor].hp = ps.hp; saveSlots[selectCursor].inventory = { ..._s.playerInventory }; saveSlotsToDB(); }
  }
}

function _pauseInputInvTarget() {
  if (pauseSt.state !== 'inv-target') return false;
  const rosterTargets = _s.getRosterVisible();
  const k = _s.keys;
  if (k['ArrowDown']) {
    k['ArrowDown'] = false;
    if (pauseSt.invAllyTarget < rosterTargets.length - 1) { pauseSt.invAllyTarget++; playSFX(SFX.CURSOR); }
  }
  if (k['ArrowUp']) {
    k['ArrowUp'] = false;
    if (pauseSt.invAllyTarget > -1) { pauseSt.invAllyTarget--; playSFX(SFX.CURSOR); }
  }
  if (_zPressed()) {
    _applyPauseItemUse(ITEMS.get(pauseSt.useItemId), rosterTargets);
  }
  if (_xPressed()) {
    pauseSt.state = 'inventory'; pauseSt.timer = 0;
    pauseSt.heldItem = -1;
    playSFX(SFX.CONFIRM);
  }
  return true;
}

function _enforceEquipRestrictions(jobIdx) {
  const slots = [-100, -101, -102, -103, -104];
  for (const eq of slots) {
    const id = getEquipSlotId(eq);
    if (id && !canJobEquip(jobIdx, id, ITEMS)) {
      setEquipSlotId(eq, 0);
      _s.addItem(id, 1);
    }
  }
  recalcCombatStats();
  if (selectCursor >= 0 && saveSlots[selectCursor]) { saveSlots[selectCursor].inventory = { ..._s.playerInventory }; saveSlotsToDB(); }
}

function _equipBestMainSlots() {
  const SLOT_DEFS = [
    { eq: -100, type: 'hand', stat: 'atk' },
    { eq: -102, type: 'armor', subtype: 'helmet', stat: 'def' },
    { eq: -103, type: 'armor', subtype: 'body',   stat: 'def' },
    { eq: -104, type: 'armor', subtype: 'arms',   stat: 'def' },
  ];
  for (const sd of SLOT_DEFS) {
    const curId = getEquipSlotId(sd.eq); const curItem = ITEMS.get(curId);
    let bestId = curId, bestVal = curItem ? (curItem[sd.stat] || 0) : 0;
    for (const [idStr, count] of Object.entries(_s.playerInventory)) {
      if (count <= 0) continue;
      const id = Number(idStr); const item = ITEMS.get(id); if (!item) continue;
      if (sd.type === 'hand' && !isHandEquippable(item)) continue;
      if (sd.type === 'armor' && (item.type !== 'armor' || item.subtype !== sd.subtype)) continue;
      if (!canJobEquip(ps.jobIdx, id, ITEMS)) continue;
      const val = item[sd.stat] || 0; if (val > bestVal) { bestVal = val; bestId = id; }
    }
    if (bestId !== curId) {
      if (curId !== 0) _s.addItem(curId, 1);
      if (bestId !== 0) { setEquipSlotId(sd.eq, bestId); _s.removeItem(bestId); } else setEquipSlotId(sd.eq, 0);
    }
  }
}

function _equipBestLeftHand() {
  const curId = getEquipSlotId(-101); const curItem = ITEMS.get(curId);
  let bestWepId = 0, bestWepAtk = 0, bestShieldId = 0, bestShieldDef = 0;
  if (curItem?.type === 'weapon') { bestWepAtk = curItem.atk || 0; bestWepId = curId; }
  else if (curItem?.subtype === 'shield') { bestShieldDef = curItem.def || 0; bestShieldId = curId; }
  for (const [idStr, count] of Object.entries(_s.playerInventory)) {
    if (count <= 0) continue;
    const id = Number(idStr); const item = ITEMS.get(id);
    if (!item || !isHandEquippable(item)) continue;
    if (!canJobEquip(ps.jobIdx, id, ITEMS)) continue;
    if (item.type === 'weapon') { const v = item.atk || 0; if (v > bestWepAtk) { bestWepAtk = v; bestWepId = id; } }
    else if (item.subtype === 'shield') { const v = item.def || 0; if (v > bestShieldDef) { bestShieldDef = v; bestShieldId = id; } }
  }
  const bestId = bestShieldId !== 0 ? bestShieldId : bestWepId;
  if (bestId !== curId) {
    if (curId !== 0) _s.addItem(curId, 1);
    if (bestId !== 0) { setEquipSlotId(-101, bestId); _s.removeItem(bestId); } else setEquipSlotId(-101, 0);
  }
}

function _equipOptimum() {
  _equipBestMainSlots();
  _equipBestLeftHand();
  recalcCombatStats();
  if (selectCursor >= 0 && saveSlots[selectCursor]) { saveSlots[selectCursor].inventory = { ..._s.playerInventory }; saveSlotsToDB(); }
  playSFX(SFX.CONFIRM);
}

function _pauseInputEquip() {
  if (pauseSt.state !== 'equip') return false;
  const k = _s.keys;
  if (k['ArrowDown']) { k['ArrowDown'] = false; pauseSt.eqCursor = (pauseSt.eqCursor + 1) % 6; playSFX(SFX.CURSOR); }
  if (k['ArrowUp'])   { k['ArrowUp'] = false;   pauseSt.eqCursor = (pauseSt.eqCursor + 5) % 6; playSFX(SFX.CURSOR); }
  if (_zPressed()) {
    if (pauseSt.eqCursor === 5) {
      _equipOptimum();
    } else {
      playSFX(SFX.CONFIRM);
      pauseSt.eqSlotIdx = -100 - pauseSt.eqCursor;
      const isWeaponSlot = pauseSt.eqSlotIdx >= -101;
      const slotSubtype = EQUIP_SLOT_SUBTYPE[String(pauseSt.eqSlotIdx)];
      pauseSt.eqItemList = [];
      const currentId = getEquipSlotId(pauseSt.eqSlotIdx);
      if (currentId !== 0) pauseSt.eqItemList.push({ id: 0, label: 'remove' });
      for (const [idStr, count] of Object.entries(_s.playerInventory)) {
        if (count <= 0) continue;
        const id = Number(idStr);
        const item = ITEMS.get(id);
        if (!item) continue;
        if (!canJobEquip(ps.jobIdx, id, ITEMS)) continue;
        if (isWeaponSlot && isHandEquippable(item)) pauseSt.eqItemList.push({ id, count });
        else if (!isWeaponSlot && item.type === 'armor' && item.subtype === slotSubtype) pauseSt.eqItemList.push({ id, count });
      }
      pauseSt.eqItemCursor = 0;
      pauseSt.state = 'eq-items-in'; pauseSt.timer = 0;
    }
  }
  if (_xPressed()) {
    playSFX(SFX.CONFIRM);
    pauseSt.state = 'eq-slots-out'; pauseSt.timer = 0;
  }
  return true;
}

function _pauseInputEquipItemSelect() {
  if (pauseSt.state !== 'eq-item-select') return false;
  const k = _s.keys;
  if (k['ArrowDown']) { k['ArrowDown'] = false; if (pauseSt.eqItemCursor < pauseSt.eqItemList.length - 1) { pauseSt.eqItemCursor++; playSFX(SFX.CURSOR); } }
  if (k['ArrowUp'])   { k['ArrowUp'] = false;   if (pauseSt.eqItemCursor > 0) { pauseSt.eqItemCursor--; playSFX(SFX.CURSOR); } }
  if (_zPressed()) {
    const pick = pauseSt.eqItemList[pauseSt.eqItemCursor];
    if (pick) {
      const oldId = getEquipSlotId(pauseSt.eqSlotIdx);
      if (pick.label === 'remove') {
        setEquipSlotId(pauseSt.eqSlotIdx, 0);
        if (oldId !== 0) _s.addItem(oldId, 1);
      } else {
        setEquipSlotId(pauseSt.eqSlotIdx, pick.id);
        _s.removeItem(pick.id);
        if (oldId !== 0) _s.addItem(oldId, 1);
      }
      recalcCombatStats();
      if (selectCursor >= 0 && saveSlots[selectCursor]) {
        saveSlots[selectCursor].inventory = { ..._s.playerInventory };
        saveSlotsToDB();
      }
      playSFX(SFX.CONFIRM);
    }
    pauseSt.state = 'eq-items-out'; pauseSt.timer = 0;
  }
  if (_xPressed()) {
    playSFX(SFX.CONFIRM);
    pauseSt.state = 'eq-items-out'; pauseSt.timer = 0;
  }
  return true;
}

function _pauseInputStats() {
  if (pauseSt.state !== 'stats') return false;
  if (_xPressed()) { playSFX(SFX.CONFIRM); pauseSt.state = 'stats-out'; pauseSt.timer = 0; }
  return true;
}

function _pauseInputJob() {
  if (pauseSt.state !== 'job') return false;
  const k = _s.keys;
  if (k['ArrowDown']) { k['ArrowDown'] = false; pauseSt.jobCursor = (pauseSt.jobCursor + 1) % pauseSt.jobList.length; playSFX(SFX.CURSOR); }
  if (k['ArrowUp'])   { k['ArrowUp'] = false;   pauseSt.jobCursor = (pauseSt.jobCursor + pauseSt.jobList.length - 1) % pauseSt.jobList.length; playSFX(SFX.CURSOR); }
  if (_zPressed()) {
    const newJobIdx = pauseSt.jobList[pauseSt.jobCursor];
    if (newJobIdx === ps.jobIdx) {
      playSFX(SFX.CONFIRM);
      pauseSt.state = 'job-out'; pauseSt.timer = 0;
    } else {
      const cost = JOBS[newJobIdx].cpCost;
      if (ps.cp >= cost) {
        ps.cp -= cost;
        changeJob(newJobIdx);
        _enforceEquipRestrictions(newJobIdx);
        _s.swapBattleSprites(newJobIdx);
        playSFX(SFX.CONFIRM);
        pauseSt.state = 'job-out'; pauseSt.timer = 0;
      } else {
        playSFX(SFX.ERROR);
      }
    }
  }
  if (_xPressed()) { playSFX(SFX.CONFIRM); pauseSt.state = 'job-out'; pauseSt.timer = 0; }
  return true;
}

function _pauseInputOptions() {
  if (pauseSt.state !== 'options') return false;
  const k = _s.keys;
  if (_zPressed()) {
    if (pauseSt.optCursor === 0) { _s.toggleCrt(); playSFX(SFX.CONFIRM); }
  }
  if (_xPressed()) { playSFX(SFX.CONFIRM); pauseSt.state = 'options-out'; pauseSt.timer = 0; }
  return true;
}

// shared = { keys, playerInventory, saveSlots, get selectCursor, get battleState,
//            get shakeActive, get starEffect, get moving,
//            saveSlotsToDB, addItem, removeItem, getRosterVisible }
export function handlePauseInput(shared) {
  _s = shared;
  if (_pauseInputOpenClose()) return true;
  if (_pauseInputMainMenu()) return true;
  if (_pauseInputInventory()) return true;
  if (_pauseInputInvTarget()) return true;
  if (pauseSt.state === 'inv-heal') return true;
  if (pauseSt.state.startsWith('inv-')) return true;
  if (_pauseInputEquip()) return true;
  if (_pauseInputEquipItemSelect()) return true;
  if (pauseSt.state.startsWith('eq-')) return true;
  if (_pauseInputStats()) return true;
  if (pauseSt.state.startsWith('stats-')) return true;
  if (_pauseInputJob()) return true;
  if (pauseSt.state.startsWith('job-')) return true;
  if (_pauseInputOptions()) return true;
  if (pauseSt.state.startsWith('options-')) return true;
  if (pauseSt.state !== 'none') return true;
  return false;
}
