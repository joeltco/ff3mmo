// input-handler.js — battle, roster, and pause menu input handlers

import { battleSt, getEnemyHP, setEnemyHP } from './battle-state.js';
import { playSFX, SFX } from './music.js';
import { pauseSt } from './pause-menu.js';
import { transSt } from './transitions.js';
import { msgState, showMsgBox, dismissMsgBox } from './message-box.js';
import { chatState, CHAT_TABS, activeTab, tabSelectMode, setActiveTab, setTabSelectMode, chatScrollOffset, setChatScrollOffset, onChatKeyDown } from './chat.js';
import { titleSt, onNameEntryKeyDown } from './title-screen.js';
import { ps, recalcCombatStats, getHitWeapon, getJobLevelStatBonus } from './player-stats.js';
import { ITEMS, isHandEquippable, isWeapon, weaponSubtype } from './data/items.js';
import { SPELLS, getSpellMPCost, isMultiTargetSpell } from './data/spells.js';
import { rollHits, calcPotentialHits, elemMultiplier } from './battle-math.js';
import { blindHitPenalty, miniToadAtkMult } from './status-effects.js';
import { _nameToBytes } from './text-utils.js';
import { MONSTERS } from './data/monsters.js';
import { canJobEquip, JOBS } from './data/jobs.js';
import { getSlashFramesForWeapon, setSlashOffsetForFrame } from './battle-sprite-cache.js';
import { mapSt } from './map-state.js';
import { pvpSt } from './pvp.js';
import { getRosterVisible, ROSTER_MENU_ITEMS } from './roster.js';
import { startPVPSearch, cancelPVPSearch, isSearchingFor, isSearchOnCooldown } from './pvp-search.js';
import { startPartyInvite, cancelPartyInvite, isInvitingTarget, isInviteOnCooldown, isInParty, isPartyFull, removeFromParty } from './party-invite.js';
import { openTradePick, cancelTrade, isTradingWith, isTradePicking, isTradeOnCooldown, handleTradePickInput } from './trade.js';
import { openInspect } from './inspect.js';
import { sendNetEncounterAssistRequest } from './net.js';
import { playerInventory, addItem, removeItem, INV_SLOTS } from './inventory.js';

// Keyboard poll map — mutated by window listeners, read throughout the codebase.
export const keys = {};

// Injected at boot — avoids circular import on main.js
let _executeBattleCommand = () => {};
let _startPVPBattle = () => {};
export function initInputHandler(deps) {
  _executeBattleCommand = deps.executeBattleCommand;
  _startPVPBattle = deps.startPVPBattle;
}

const TRACKED_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'z', 'Z', 'x', 'X', 'Enter', 's', 'S'];
function _chatHotkeyAllowed() {
  return titleSt.state === 'done' && battleSt.battleState === 'none' && pauseSt.state === 'none' &&
    inputSt.rosterState === 'none' && transSt.state !== 'loading' && msgState.state === 'none';
}
export function initKeyboardListeners() {
  window.addEventListener('keydown', (e) => {
    if (chatState.inputActive) { onChatKeyDown(e); return; }
    if (titleSt.state === 'name-entry') { onNameEntryKeyDown(e); return; }
    if (TRACKED_KEYS.includes(e.key)) { e.preventDefault(); keys[e.key] = true; }
    if (e.key === 'T' && _chatHotkeyAllowed() && !chatState.inputActive) {
      e.preventDefault();
      chatState.expanded = !chatState.expanded;
      if (!chatState.expanded) setChatScrollOffset(0);
      playSFX(chatState.expanded ? SFX.SCREEN_OPEN : SFX.SCREEN_CLOSE);
    }
    if (e.key === 't' && _chatHotkeyAllowed()) {
      e.preventDefault();
      chatState.inputActive = true; chatState.inputText = ''; chatState.cursorTimer = 0;
      chatState.pendingRecipient = null;  // fresh open — drop any stale PM target
    }
  });
  window.addEventListener('keyup', (e) => { keys[e.key] = false; });
}

// Local constants (must match game.js)
const HUD_VIEW_X = 0, HUD_VIEW_Y = 32, HUD_VIEW_W = 144, HUD_VIEW_H = 144;
const BOSS_DEF = (MONSTERS.get(0xCC) || { def: 1 }).def;
const ROSTER_VISIBLE = 3;
// ROSTER_MENU_ITEMS imported from roster.js (single source, v1.7.221 dedup).

// ── Mutable state (imported by main.js draw/update code) ───────────────────

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
  // Magic menu (piggybacks on item-* states; menuMode toggles list/input/draw branches)
  menuMode:           'item',   // 'item' or 'magic'
  spellSelectList:    [],       // active spell IDs when menuMode === 'magic'
  // Action count for JP (applied on battle victory)
  battleActionCount:  0,
  // Roster browse/menu
  rosterState:        'none',
  rosterCursor:       0,
  rosterScroll:       0,
  rosterMenuCursor:   0,
  rosterMenuTimer:    0,
  rosterMenuTarget:   null,    // stashed at menu-in so a mid-menu fade-out can't redirect the dispatch
  rosterMenuExitTo:   'browse',// 'browse' (default — return to roster) or 'none' (action committed, full close). v1.7.221.
};

// _s bag retired — direct imports + injected callbacks above

// ── Key helpers ────────────────────────────────────────────────────────────

function _zPressed() {
  const k = keys;
  if (!k['z'] && !k['Z']) return false;
  k['z'] = false; k['Z'] = false; return true;
}
function _xPressed() {
  const k = keys;
  if (!k['x'] && !k['X']) return false;
  k['x'] = false; k['X'] = false; return true;
}

// ── Battle input ───────────────────────────────────────────────────────────

// Switch PVP target — just change the index; enemyHP getter/setter reads authoritative source
function _switchPVPTarget(newIdx) {
  pvpSt.pvpPlayerTargetIdx = newIdx;
}

function _battleTargetNav() {
  const k = keys;
  if (pvpSt.isPVPBattle) {
    // Build list of alive PVP target indices: -1=main opp, 0,1,...=allies
    // Use authoritative HP: pvpOpponentStats.hp for main, pvpEnemyAllies[i].hp for allies
    const aliveTargets = [];
    if (pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp > 0) aliveTargets.push(-1);
    (pvpSt.pvpEnemyAllies || []).forEach((a, i) => { if (a.hp > 0) aliveTargets.push(i); });
    if (aliveTargets.length <= 1) return;
    const cur = pvpSt.pvpPlayerTargetIdx;
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
  const enc = battleSt.encounterMonsters;
  if (!battleSt.isRandomEncounter || !enc) return;
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
  const k = keys;
  if (!k['z'] && !k['Z']) return;
  k['z'] = false; k['Z'] = false;
  playSFX(SFX.CONFIRM);
  const rIsWeapon = isWeapon(ps.weaponR);
  const lIsWeapon = isWeapon(ps.weaponL);
  const unarmed = !rIsWeapon && !lIsWeapon;
  // Unarmed = dual fists. Reuses the existing dual-wield code path: 2x hits, R then L, summed damage, single target.
  const dualWield = (rIsWeapon && lIsWeapon) || unarmed;
  const wpnSubtype = weaponSubtype(ps.weaponR) || weaponSubtype(ps.weaponL) || 'unarmed';
  const lv = ps.stats ? ps.stats.level : 1;
  const agi = (ps.stats ? ps.stats.agi : 5) + getJobLevelStatBonus().agi;
  // Haste doubles per-hand hits. Buff is set by Bachus Wine / future Haste cast.
  const hasted = !!(ps.buffs && ps.buffs.haste);
  const hitsPerHand = calcPotentialHits(lv, agi, false, hasted); // base hits per hand
  const blindMult = ps.status ? blindHitPenalty(ps.status) : 1;
  const atkMult = ps.status ? miniToadAtkMult(ps.status) : 1;
  // Per-hand ATK: strip the weapon-ATK component (sum of both hands' weapons) from
  // ps.atk so baseAtk holds just floor(str/2) (or the Monk/BB unarmed formula).
  // Each hand then adds its own weapon ATK below. Must match calcAttackerAtk's
  // display value = rWpnAtk + lWpnAtk + floor(str/2).
  // Mini/Toad reduces effective ATK to 0 (calcDamage clamps result to minimum 1).
  const rWpnAtkRaw = ITEMS.get(ps.weaponR)?.atk || 0;
  const lWpnAtkRaw = ITEMS.get(ps.weaponL)?.atk || 0;
  const wpnAtkComponent = rWpnAtkRaw + lWpnAtkRaw;
  const baseAtk = (ps.atk - wpnAtkComponent) * atkMult;
  const rWpn = rIsWeapon ? ITEMS.get(ps.weaponR) : null;
  const lWpn = lIsWeapon ? ITEMS.get(ps.weaponL) : null;
  const job = JOBS[ps.jobIdx] || {};
  const critOpts = { critPct: job.critPct || 0, critBonus: job.critBonus || 0 };
  // Roll each hand independently (NES loops per hand at 30/9F6A)
  function rollHand(wpn) {
    const handAtk = baseAtk + (wpn ? (wpn.atk || 0) : 0);
    const handHit = (wpn ? (wpn.hit || 80) : 80) * blindMult;
    const handElem = wpn ? (wpn.element || null) : null;
    if (battleSt.isRandomEncounter && battleSt.encounterMonsters) {
      const mon = battleSt.encounterMonsters[inputSt.targetIndex];
      return rollHits(handAtk, mon.def, handHit, hitsPerHand, {
        ...critOpts,
        elemMult: elemMultiplier(handElem, mon.weakness, mon.resist),
        evade: mon.evade || 0,
      });
    } else {
      const tgt = pvpSt.isPVPBattle && pvpSt.pvpOpponentStats
        ? (pvpSt.pvpPlayerTargetIdx >= 0
            ? (pvpSt.pvpEnemyAllies[pvpSt.pvpPlayerTargetIdx] || pvpSt.pvpOpponentStats)
            : pvpSt.pvpOpponentStats)
        : null;
      const targetDef = tgt ? tgt.def : BOSS_DEF;
      // Wire-PvP — when attacking the main opp, halve damage if their wire-
      // delivered 'defend' action set `pvpOpponentIsDefending`. Without this
      // the sender computes the full-damage value while the receiver's
      // `_processEnemyFlash` halves locally — 2× HP divergence across clients
      // any time the defender uses Defend. See
      // docs/MULTIPLAYER-AUDIT-2026-05-15.md #1.
      const oppDefending = tgt === pvpSt.pvpOpponentStats && !!pvpSt.pvpOpponentIsDefending;
      return rollHits(handAtk, targetDef, handHit, hitsPerHand, {
        ...critOpts,
        shieldEvade: tgt ? (tgt.shieldEvade || 0) : 0,
        evade: tgt ? (tgt.evade || 0) : 0,
        defendHalve: oppDefending,
      });
    }
  }
  if (dualWield) {
    // NES: all right hand hits first, then all left hand hits
    const rHits = rollHand(rWpn);
    inputSt.hitResults = [...rHits, ...rollHand(lWpn)];
    inputSt.rHandHitCount = rHits.length; // split point for hand animation
  } else {
    inputSt.hitResults = rollHand(rWpn || lWpn);
    inputSt.rHandHitCount = 0; // not dual wielding
  }
  inputSt.battleActionCount++;
  const firstHandR = isWeapon(ps.weaponR) || !isWeapon(ps.weaponL);
  const firstWpnId = firstHandR ? ps.weaponR : ps.weaponL;
  const pendingSlashFrames = getSlashFramesForWeapon(firstWpnId, firstHandR);
  const centerX = HUD_VIEW_X + Math.floor(HUD_VIEW_W / 2);
  const centerY = HUD_VIEW_Y + Math.floor(HUD_VIEW_H / 2);
  const firstWeapon0 = getHitWeapon(0);
  // First-hit scatter offsets come from the per-weapon pattern (see battle-sprite-cache.js).
  // Cheat-set on a temporary object so we can stash them into playerActionPending.
  const pendingOffsets = { slashOffX: 0, slashOffY: 0 };
  setSlashOffsetForFrame(pendingOffsets, firstWeapon0, 0);
  inputSt.playerActionPending = {
    command: 'fight', targetIndex: inputSt.targetIndex, hitResults: inputSt.hitResults,
    slashFrames: pendingSlashFrames, slashOffX: pendingOffsets.slashOffX, slashOffY: pendingOffsets.slashOffY,
    slashX: centerX, slashY: centerY
  };
  battleSt.battleState = 'confirm-pause';
  battleSt.battleTimer = 0;
}

function _battleInputTargetSelect() {
  _battleTargetNav();
  _battleTargetConfirm();
  if (_xPressed()) {
    playSFX(SFX.CONFIRM);
    battleSt.battleState = 'menu-open';
    battleSt.battleTimer = 0;
  }
}

function _itemSelectNav(isEquipPage, totalPages, pageRows) {
  const k = keys;
  if (k['ArrowDown']) {
    k['ArrowDown'] = false;
    if (inputSt.itemPageCursor < pageRows - 1) inputSt.itemPageCursor++;
    else if (inputSt.itemPage < totalPages - 1) { inputSt.itemSlideDir = -1; inputSt.itemSlideCursor = 0; battleSt.battleState = 'item-slide'; battleSt.battleTimer = 0; }
    playSFX(SFX.CURSOR);
  }
  if (k['ArrowUp']) {
    k['ArrowUp'] = false;
    if (inputSt.itemPageCursor > 0) inputSt.itemPageCursor--;
    else if (inputSt.itemPage > 0) { inputSt.itemSlideDir = 1; inputSt.itemSlideCursor = (inputSt.itemPage - 1) === 0 ? 1 : INV_SLOTS - 1; battleSt.battleState = 'item-slide'; battleSt.battleTimer = 0; }
    playSFX(SFX.CURSOR);
  }
  if (k['ArrowLeft'] && inputSt.itemPage > 0) {
    k['ArrowLeft'] = false; playSFX(SFX.CURSOR);
    inputSt.itemSlideDir = 1; inputSt.itemSlideCursor = 0; battleSt.battleState = 'item-slide'; battleSt.battleTimer = 0;
  }
  if (k['ArrowRight'] && inputSt.itemPage < totalPages - 1) {
    k['ArrowRight'] = false; playSFX(SFX.CURSOR);
    inputSt.itemSlideDir = -1; inputSt.itemSlideCursor = 0; battleSt.battleState = 'item-slide'; battleSt.battleTimer = 0;
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
      removeItem(item.id);
      if (oldWeapon !== 0) addItem(oldWeapon, 1);
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
      removeItem(invItem.id); addItem(handWeaponId, 1);
      inputSt.itemSelectList[dstIdx] = { id: handWeaponId, count: 1 };
      recalcCombatStats(); inputSt.itemHeldIdx = -1; playSFX(SFX.CONFIRM);
    } else if (!invItem) {
      if (srcHand === 0) ps.weaponR = 0; else ps.weaponL = 0;
      addItem(handWeaponId, 1);
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
        if (itemDat.type === 'battle_item' && battleSt.isRandomEncounter && battleSt.encounterMonsters) {
          inputSt.itemTargetType = 'enemy';
          const ecnt = battleSt.encounterMonsters.length;
          const ealive = (i) => i < battleSt.encounterMonsters.length && battleSt.encounterMonsters[i].hp > 0;
          const rightCandidates = ecnt === 1 ? [0] : ecnt === 2 ? [1] : ecnt === 3 ? [1] : [1,3];
          const leftCandidates  = ecnt === 1 ? [0] : ecnt === 2 ? [0] : ecnt === 3 ? [0,2] : [0,2];
          const first = [...rightCandidates,...leftCandidates].find(i => ealive(i));
          inputSt.itemTargetIndex = first !== undefined ? first : 0;
        } else if (itemDat.type === 'battle_item' && !battleSt.isRandomEncounter) {
          inputSt.itemTargetType = 'enemy';
          // Default to first alive PVP target (grid index)
          const cnt = 1 + (pvpSt.pvpEnemyAllies ? pvpSt.pvpEnemyAllies.length : 0);
          let first = 0;
          for (let ii = 0; ii < cnt; ii++) { if (_itemTargetAlive(ii)) { first = ii; break; } }
          inputSt.itemTargetIndex = first;
        } else {
          inputSt.itemTargetType = 'player'; inputSt.itemTargetIndex = 0;
        }
        inputSt.itemTargetAllyIndex = -1; battleSt.battleState = 'item-target-select'; battleSt.battleTimer = 0;
        inputSt.playerActionPending = { command: 'item', itemId: item.id };
      } else { inputSt.itemHeldIdx = -1; playSFX(SFX.CONFIRM); }
    } else { inputSt.itemHeldIdx = -1; playSFX(SFX.CONFIRM); }
  } else {
    _itemSelectSwap(isEquipPage, gIdx);
  }
}

function _battleInputItemSelect() {
  if (inputSt.menuMode === 'magic') { _battleInputMagicSelect(); return; }
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
    else { playSFX(SFX.CONFIRM); battleSt.battleState = 'item-cancel-out'; battleSt.battleTimer = 0; }
  }
}

function _battleInputMagicSelect() {
  const list = inputSt.spellSelectList;
  const k = keys;
  if (k['ArrowDown']) {
    k['ArrowDown'] = false;
    if (inputSt.itemPageCursor < list.length - 1) { inputSt.itemPageCursor++; playSFX(SFX.CURSOR); }
  }
  if (k['ArrowUp']) {
    k['ArrowUp'] = false;
    if (inputSt.itemPageCursor > 0) { inputSt.itemPageCursor--; playSFX(SFX.CURSOR); }
  }
  if (_zPressed()) {
    const spellId = list[inputSt.itemPageCursor];
    const spell = SPELLS.get(spellId);
    if (!spell) { playSFX(SFX.ERROR); return; }
    const cost = getSpellMPCost(spellId);
    if (ps.mp < cost) { playSFX(SFX.ERROR); return; }
    playSFX(SFX.CONFIRM);
    // Default-target side per spell semantics. Heal / status-cure / revive /
    // reflect white magic defaults to player so the common case is one Z-press
    // on self. Sight (scan), damage spells (Fire family), enemy-status spells
    // (Sleep, Confuse, Death, all_status family) default to enemy — RIGHTMOST
    // live cell first (closest to player party), like normal melee targeting
    // feels — fall back to first-live if no right-col alive.
    //
    // NOTE: cannot use `spell.type === 'damage'` to mean "offensive" — Cure +
    // Cura have type='damage' too because that's the dispatch axis for
    // numeric-effect spells (heal counts as "damage" the helper applies). Use
    // the friendly-target set as the inversion criterion instead.
    const defaultsToPlayer = spell.element === 'recovery'
                          || spell.target === 'ally'
                          || spell.target === 'cure_status'
                          || spell.target === 'revive'
                          || spell.target === 'reflect';
    const defaultsToEnemy = !defaultsToPlayer;
    if (defaultsToEnemy) {
      let pick = -1;
      const cnt = _itemTargetCnt();
      for (let i = 0; i < cnt; i++) {
        if (_itemTargetIsRightCol(i) && _itemTargetAlive(i)) { pick = i; break; }
      }
      if (pick < 0) {
        for (let i = 0; i < cnt; i++) {
          if (_itemTargetAlive(i)) { pick = i; break; }
        }
      }
      inputSt.itemTargetType = 'enemy';
      inputSt.itemTargetIndex = Math.max(0, pick);
    } else {
      inputSt.itemTargetType = 'player';
      inputSt.itemTargetIndex = 0;
    }
    inputSt.itemTargetAllyIndex = -1;
    inputSt.itemTargetMode = 'single';
    inputSt.playerActionPending = { command: 'magic', spellId };
    battleSt.battleState = 'item-target-select';
    battleSt.battleTimer = 0;
  }
  if (_xPressed()) {
    playSFX(SFX.CONFIRM);
    battleSt.battleState = 'item-cancel-out';
    battleSt.battleTimer = 0;
  }
}

function _itemTargetCnt() {
  if (pvpSt.isPVPBattle) return 1 + (pvpSt.pvpEnemyAllies ? pvpSt.pvpEnemyAllies.length : 0);
  return battleSt.isRandomEncounter && battleSt.encounterMonsters ? battleSt.encounterMonsters.length : (battleSt.isRandomEncounter ? 0 : 1);
}
function _itemTargetAlive(i) {
  if (pvpSt.isPVPBattle) {
    if (i === 0) return pvpSt.pvpOpponentStats && pvpSt.pvpOpponentStats.hp > 0;
    const a = pvpSt.pvpEnemyAllies && pvpSt.pvpEnemyAllies[i - 1];
    return !!(a && a.hp > 0);
  }
  return battleSt.isRandomEncounter && battleSt.encounterMonsters && i < battleSt.encounterMonsters.length && battleSt.encounterMonsters[i].hp > 0;
}
// PVP grid: right col = indices 0,2 (gc=cols-1). Encounter grid: right col = indices 1,3.
function _itemTargetIsRightCol(i) {
  if (pvpSt.isPVPBattle) return _itemTargetCnt() <= 1 || i === 0 || i === 2;
  const cnt = _itemTargetCnt();
  return cnt === 1 || (cnt === 2 && i === 1) || (cnt >= 3 && (i === 1 || i === 3));
}
function _itemTargetIsLeftCol(i) { return _itemTargetCnt() >= 2 && !_itemTargetIsRightCol(i); }

function _itemTargetNavLeft(allowMulti) {
  const cnt = _itemTargetCnt();
  // Multi-target spells: when in 'all-allies' on the player side, Left returns
  // to single-ally pick. From single-ally, Left then crosses to the enemy side
  // via the existing battle-item path (col-toggle / cross-side) below.
  if (allowMulti && inputSt.itemTargetType === 'player' && inputSt.itemTargetMode !== 'single') {
    inputSt.itemTargetMode = 'single'; inputSt.itemTargetAllyIndex = -1; playSFX(SFX.CURSOR); return;
  }
  if (allowMulti && inputSt.itemTargetMode !== 'single') {
    // col/all mode → back to single. Left-col candidates differ per mode.
    const leftCandidates = pvpSt.isPVPBattle
      ? (cnt <= 1 ? [0] : cnt === 2 ? [1] : [1, 3])      // PVP left col = 1,3
      : (cnt <= 1 ? [0] : cnt === 2 ? [0] : [0, 2]);      // encounter left col = 0,2
    const found = leftCandidates.find(i => _itemTargetAlive(i));
    if (found !== undefined) inputSt.itemTargetIndex = found;
    inputSt.itemTargetMode = 'single'; playSFX(SFX.CURSOR);
  } else if (inputSt.itemTargetType === 'player') {
    if (pvpSt.isPVPBattle) {
      // PVP: player → right col of PVP grid (idx 0)
      const rightCandidates = cnt === 1 ? [0] : cnt === 2 ? [0] : cnt === 3 ? [0] : [0, 2];
      const leftCandidates  = cnt === 2 ? [1] : cnt === 3 ? [1, 3] : cnt >= 4 ? [1, 3] : [];
      let found = rightCandidates.find(i => _itemTargetAlive(i));
      if (found === undefined) found = leftCandidates.find(i => _itemTargetAlive(i));
      if (found !== undefined) {
        inputSt.itemTargetType = 'enemy'; inputSt.itemTargetIndex = found; inputSt.itemTargetMode = 'single'; playSFX(SFX.CURSOR);
      }
    } else if (battleSt.isRandomEncounter) {
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
    const [leftPeer, leftOther] = pvpSt.isPVPBattle
      ? [idx === 0 ? 1 : idx === 2 ? 3 : -1, idx === 0 ? 3 : idx === 2 ? 1 : -1]   // PVP: 0→1, 2→3
      : [idx === 1 ? 0 : idx === 3 ? 2 : -1, idx === 1 ? 2 : idx === 3 ? 0 : -1];  // encounter: 1→0, 3→2
    if (leftPeer >= 0 && _itemTargetAlive(leftPeer)) { inputSt.itemTargetIndex = leftPeer; playSFX(SFX.CURSOR); }
    else if (leftOther >= 0 && _itemTargetAlive(leftOther)) { inputSt.itemTargetIndex = leftOther; playSFX(SFX.CURSOR); }
    else if (allowMulti) { inputSt.itemTargetMode = 'all'; playSFX(SFX.CURSOR); }
  } else if (allowMulti && _itemTargetIsLeftCol(inputSt.itemTargetIndex)) {
    inputSt.itemTargetMode = 'all'; playSFX(SFX.CURSOR);
  }
}

function _itemTargetNavRight(allowMulti) {
  // Multi-target spells: Right from any ally pick (player or roster ally,
  // single mode) flips to 'all-allies'. Right from 'all-allies' is a no-op
  // (the cursor is already at the rightmost picker state on this side).
  if (allowMulti && inputSt.itemTargetType === 'player' && inputSt.itemTargetMode === 'single') {
    inputSt.itemTargetMode = 'all'; playSFX(SFX.CURSOR); return;
  }
  if (inputSt.itemTargetType !== 'enemy') return;
  if (pvpSt.isPVPBattle) {
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
  if (_itemTargetIsRightCol(inputSt.itemTargetIndex) || !battleSt.isRandomEncounter) {
    inputSt.itemTargetType = 'player'; playSFX(SFX.CURSOR);
  } else {
    const rightPeer = inputSt.itemTargetIndex === 0 ? 1 : inputSt.itemTargetIndex === 2 ? 3 : -1;
    const rightOther = inputSt.itemTargetIndex === 0 ? 3 : inputSt.itemTargetIndex === 2 ? 1 : -1;
    if (rightPeer >= 0 && _itemTargetAlive(rightPeer)) { inputSt.itemTargetIndex = rightPeer; playSFX(SFX.CURSOR); }
    else if (rightOther >= 0 && _itemTargetAlive(rightOther)) { inputSt.itemTargetIndex = rightOther; playSFX(SFX.CURSOR); }
    else { inputSt.itemTargetType = 'player'; playSFX(SFX.CURSOR); }
  }
}

function _itemTargetNavVertical(allowMulti) {
  const k = keys;
  const goUp = !!k['ArrowUp'];
  k['ArrowUp'] = false; k['ArrowDown'] = false;
  const cnt = _itemTargetCnt();
  if (allowMulti && inputSt.itemTargetType === 'enemy' && (pvpSt.isPVPBattle || (battleSt.isRandomEncounter && battleSt.encounterMonsters))) {
    if (goUp && inputSt.itemTargetMode === 'single') {
      inputSt.itemTargetMode = _itemTargetIsLeftCol(inputSt.itemTargetIndex) ? 'col-left' : 'col-right';
      playSFX(SFX.CURSOR);
    } else if (!goUp && inputSt.itemTargetMode !== 'single') {
      inputSt.itemTargetMode = 'single'; playSFX(SFX.CURSOR);
    }
  } else if (inputSt.itemTargetType === 'enemy' && (pvpSt.isPVPBattle || (battleSt.isRandomEncounter && battleSt.encounterMonsters))) {
    const vertMap = cnt >= 4 ? { 0: 2, 2: 0, 1: 3, 3: 1 } :
                    cnt === 3 ? { 0: 2, 2: 0, 1: 1 } : {};
    const next = vertMap[inputSt.itemTargetIndex];
    if (next !== undefined && next !== inputSt.itemTargetIndex && _itemTargetAlive(next)) {
      inputSt.itemTargetIndex = next; playSFX(SFX.CURSOR);
    }
  } else if (inputSt.itemTargetType === 'player') {
    // Up/Down only cycles allies on the player side — never toggles 'all'.
    // Multi-target 'all-allies' is reached via Right (see _itemTargetNavRight).
    if (allowMulti && inputSt.itemTargetMode !== 'single') return; // freeze cycle while in all-mode
    const livingAllies = battleSt.battleAllies.filter(a => a.hp > 0);
    if (!goUp && inputSt.itemTargetAllyIndex < livingAllies.length - 1) {
      inputSt.itemTargetAllyIndex++; playSFX(SFX.CURSOR);
    } else if (goUp && inputSt.itemTargetAllyIndex >= 0) {
      inputSt.itemTargetAllyIndex--; playSFX(SFX.CURSOR);
    }
  }
}

function _battleInputItemTargetSelect() {
  const isMagic = inputSt.playerActionPending?.command === 'magic';
  const isBattleItem = inputSt.playerActionPending && !isMagic && ITEMS.get(inputSt.playerActionPending.itemId)?.type === 'battle_item';
  // Multi-target spells (Cure family) get the same all/column picker as
  // battle-items. Other spells stay single-target — and item-use stays single
  // even for items whose animSpellId points at a multi-target spell, since the
  // user is choosing one consumable, not casting.
  const isMultiSpell = isMagic && isMultiTargetSpell(inputSt.playerActionPending.spellId);
  const allowMulti = isBattleItem || isMultiSpell;
  const k = keys;
  // Navigation is symmetric for items and spells — left/right reaches enemies, up/down cycles allies.
  if (k['ArrowLeft']) { k['ArrowLeft'] = false; _itemTargetNavLeft(allowMulti); }
  if (k['ArrowRight']) { k['ArrowRight'] = false; _itemTargetNavRight(allowMulti); }
  if (k['ArrowUp'] || k['ArrowDown']) _itemTargetNavVertical(allowMulti);
  if (_zPressed()) {
    inputSt.playerActionPending.target = inputSt.itemTargetType === 'player' ? 'player' : inputSt.itemTargetIndex;
    inputSt.playerActionPending.allyIndex = inputSt.itemTargetType === 'player' ? inputSt.itemTargetAllyIndex : -1;
    inputSt.playerActionPending.targetMode = inputSt.itemTargetMode;
    playSFX(SFX.CONFIRM); battleSt.battleState = 'item-list-out'; battleSt.battleTimer = 0;
  }
  if (_xPressed()) {
    inputSt.playerActionPending = null; playSFX(SFX.CONFIRM); battleSt.battleState = 'item-select'; battleSt.battleTimer = 0;
  }
}

function _battleInputHoldStates() {
  const k = keys;
  const z = k['z'] || k['Z'];
  const clearZ = () => { k['z'] = false; k['Z'] = false; };
  if (battleSt.battleState === 'roar-hold') {
    if (msgState.state === 'hold' && z) { clearZ(); dismissMsgBox(); }
  } else if (battleSt.battleState === 'exp-hold') {
    if (z) { clearZ(); battleSt.battleState = 'exp-fade-out'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'gil-hold') {
    if (z) { clearZ(); battleSt.battleState = 'gil-fade-out'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'cp-hold') {
    if (z) { clearZ(); battleSt.battleState = 'cp-fade-out'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'item-hold') {
    if (z) { clearZ(); battleSt.battleState = 'item-fade-out'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'levelup-hold') {
    if (z) { clearZ(); battleSt.battleState = 'levelup-fade-out'; battleSt.battleTimer = 0; }
  } else if (battleSt.battleState === 'joblv-hold') {
    if (z) { clearZ(); battleSt.battleState = 'joblv-fade-out'; battleSt.battleTimer = 0; }
  } else { return false; }
  return true;
}

export function handleBattleInput() {
  if (battleSt.battleState === 'none') return false;
  if (_battleInputHoldStates()) return true;
  const k = keys;
  if (battleSt.battleState === 'menu-open') {
    if (k['ArrowDown'])  { k['ArrowDown'] = false;  inputSt.battleCursor ^= 2; playSFX(SFX.CURSOR); }
    if (k['ArrowUp'])    { k['ArrowUp'] = false;    inputSt.battleCursor ^= 2; playSFX(SFX.CURSOR); }
    if (k['ArrowRight']) { k['ArrowRight'] = false; inputSt.battleCursor ^= 1; playSFX(SFX.CURSOR); }
    if (k['ArrowLeft'])  { k['ArrowLeft'] = false;  inputSt.battleCursor ^= 1; playSFX(SFX.CURSOR); }
    if (k['z'] || k['Z']) { k['z'] = false; k['Z'] = false; _executeBattleCommand(inputSt.battleCursor); }
  } else if (battleSt.battleState === 'target-select') { _battleInputTargetSelect();
  } else if (battleSt.battleState === 'item-select') { _battleInputItemSelect();
  } else if (battleSt.battleState === 'item-target-select') { _battleInputItemTargetSelect();
  }
  return true;
}

// ── Roster input ───────────────────────────────────────────────────────────

function _rosterInputBrowse() {
  const rp = getRosterVisible();
  const k = keys;
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
    const target = getRosterVisible()[inputSt.rosterCursor];
    if (!target) return;  // empty/stale row — refuse silently. v1.7.221.
    inputSt.rosterMenuTarget = target;
    inputSt.rosterMenuExitTo = 'browse';
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

// Battle action: starts a *search* (or cancels the active one if the
// player picks the same target again — menu label flips to 'Cancel').
// The search-and-hook flow itself lives in `pvp-search.js`. v1.7.222.
function _rosterMenuBattleAction(target) {
  if (isSearchingFor(target)) {
    cancelPVPSearch('user');
    return;
  }
  if (isSearchOnCooldown(target.name)) {
    showMsgBox(_nameToBytes(target.name + ' on cooldown'));
    return;
  }
  if (!startPVPSearch(target)) {
    showMsgBox(_nameToBytes('Already searching'));
  }
}

// Inspect action: opens the read-only stat panel for the target.
// Flow lives in `inspect.js`. UI-only — no state machine, no
// accept-roll. v1.7.239.
function _rosterMenuInspectAction(target) {
  openInspect(target);
}

// Message action: switches active chat tab to Private + opens the
// chat input + stashes the target as the next message's recipient.
// No state machine, no accept-roll — Message is fire-and-forget.
// Websocket relay (Step 1 in MULTIPLAYER.md) will deliver to the
// target client; today the message renders locally in the Private
// tab tagged with `to: <target.name>`. v1.7.238.
function _rosterMenuMessageAction(target) {
  setActiveTab(2);  // Private
  chatState.inputActive = true;
  chatState.inputText = '';
  chatState.cursorTimer = 0;
  chatState.pendingRecipient = target.name;
}

// Trade action: opens the inline item-pick panel for a give-only offer
// to the target. Flow lives in `trade.js`. Mid-offer pick reopens to
// 'Cancel' the same target. v1.7.237.
function _rosterMenuTradeAction(target) {
  if (isTradingWith(target)) {
    cancelTrade('user');
    return;
  }
  if (isTradeOnCooldown(target.name)) {
    showMsgBox(_nameToBytes(target.name + ' on cooldown'));
    return;
  }
  const result = openTradePick(target);
  if (result === 'busy')    showMsgBox(_nameToBytes('Already trading'));
  else if (result === 'empty') showMsgBox(_nameToBytes('No items'));
  // 'ok' — panel is now open; item-pick handler takes the next input.
}

// Assist action: joiner picks an in-battle roster target to assist.
// Server validates target.inBattle + same-loc; target's client auto-
// accepts and emits the snapshot. Both gates are also enforced here
// for fast user feedback (no need to round-trip for the rejection).
// v1.7.422.
function _rosterMenuAssistAction(target) {
  if (!target || !target.userId) {
    showMsgBox(_nameToBytes('Cannot assist'));
    return;
  }
  if (!target.inBattle) {
    showMsgBox(_nameToBytes(target.name + ' not in battle'));
    return;
  }
  // Same-loc check uses the local snapshot's `loc` field — server
  // re-validates against authoritative loc.
  if (!sendNetEncounterAssistRequest(target.userId)) {
    showMsgBox(_nameToBytes('Not connected'));
  }
}

// Party action: starts an *invite* (or cancels the active one / dismisses
// an existing party member on the same target — menu label flips to
// 'Cancel' / 'Dismiss' respectively). Invite-and-accept flow lives in
// `party-invite.js`. v1.7.235.
function _rosterMenuPartyAction(target) {
  if (isInvitingTarget(target)) {
    cancelPartyInvite('user');
    return;
  }
  if (isInParty(target)) {
    removeFromParty(target.name);
    showMsgBox(_nameToBytes(target.name + ' left party'));
    return;
  }
  if (isPartyFull()) {
    showMsgBox(_nameToBytes('Party full'));
    return;
  }
  if (isInviteOnCooldown(target.name)) {
    showMsgBox(_nameToBytes(target.name + ' on cooldown'));
    return;
  }
  if (!startPartyInvite(target)) {
    showMsgBox(_nameToBytes('Already inviting'));
  }
}

function _rosterInputMenu() {
  const k = keys;
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
    const target = inputSt.rosterMenuTarget;  // stashed at menu-in; immune to mid-menu fade-out. v1.7.221.
    inputSt.rosterState = 'menu-out';
    inputSt.rosterMenuTimer = 0;
    if (!target) return;  // defensive — should be unreachable since menu-in guards it
    playSFX(SFX.CONFIRM);
    // Battle: starts a search (or cancels if same target). Search can
    // be cancelled from town, but starting it gates on a PVP location.
    // The search itself persists across map changes — only hook
    // *resolution* re-checks the gate (in pvp-search.js).
    if (action === 'Battle' && (isSearchingFor(target) || mapSt.onWorldMap || mapSt.dungeonFloor >= 0)) {
      inputSt.rosterMenuExitTo = 'none';  // commit menu — search owns next state. v1.7.221+.
      _rosterMenuBattleAction(target);
    } else if (action === 'Party') {
      // Invite / Cancel-invite / Dismiss-member all route through one
      // helper. Exit-to none so the invite owns the next state (same
      // pattern as Battle). v1.7.235.
      inputSt.rosterMenuExitTo = 'none';
      _rosterMenuPartyAction(target);
    } else if (action === 'Assist') {
      // Battle Assist (v1.7.422+) — wire-request to the in-battle target;
      // target's auto-accept emits the snapshot back. Fire-and-forget;
      // the snapshot handler in battle-encounter.js owns the next state.
      inputSt.rosterMenuExitTo = 'none';
      _rosterMenuAssistAction(target);
    } else if (action === 'Trade') {
      // Item-pick panel owns the next state. v1.7.237.
      inputSt.rosterMenuExitTo = 'none';
      _rosterMenuTradeAction(target);
    } else if (action === 'Message') {
      // Chat input owns the next state. v1.7.238.
      inputSt.rosterMenuExitTo = 'none';
      _rosterMenuMessageAction(target);
    } else if (action === 'Inspect') {
      // Stat panel owns the next state. v1.7.239.
      inputSt.rosterMenuExitTo = 'none';
      _rosterMenuInspectAction(target);
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
export function handleRosterInput() {
  const k = keys;
  if (k['s'] || k['S']) {
    k['s'] = false; k['S'] = false;
    if (tabSelectMode) {
      // S from tab select → exit tabs and roster
      setTabSelectMode(false);
      inputSt.rosterState = 'none';
      playSFX(SFX.CONFIRM);
    } else if (inputSt.rosterState === 'none' && battleSt.battleState === 'none' && pauseSt.state === 'none' && transSt.state === 'none' && !mapSt.shakeActive && !mapSt.starEffect && !mapSt.moving && msgState.state === 'none' && getRosterVisible().length > 0) {
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
  const k = keys;
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

