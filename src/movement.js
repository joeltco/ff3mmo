// movement.js — player movement, input dispatch, tile collision, action handling

import { DIR_DOWN, DIR_UP, DIR_LEFT, DIR_RIGHT } from './sprite.js';
import { mapSt } from './map-state.js';
import { battleSt } from './battle-state.js';
import { transSt } from './transitions.js';
import { inputSt, handleBattleInput, handleRosterInput, keys } from './input-handler.js';
import { sprite } from './player-sprite.js';
import { pauseSt, handlePauseInput } from './pause-menu.js';
import { msgState, dismissMsgBox, showMsgBox, showMsgBoxPrompt, yesNoLabels } from './message-box.js';
import { _nameToBytes } from './text-utils.js';
import { hasItem, removeItem } from './inventory.js';
import { isSearchActive, isSearchResolving, cancelPVPSearch } from './pvp-search.js';
import { isInviteActive, isInviteResolving, cancelPartyInvite } from './party-invite.js';
import { isTradeOffering, isTradePicking, cancelTrade, handleTradePickInput } from './trade.js';
import { isInspectOpen, handleInspectInput } from './inspect.js';
import { chatState, tabSelectMode, chatScrollOffset, setChatScrollOffset, canChatScrollUp, canChatScrollDown } from './chat.js';
import { ps } from './player-stats.js';
import { saveSlotsToDB } from './save-state.js';
import { playSFX, playTrack, TRACKS, SFX } from './music.js';
import { checkTrigger, openPassage, handleChest, handleSecretWall,
         handleRockPuzzle, handlePondHeal, triggerWipe,
         isHiddenTreasureTile, handleHiddenTreasure } from './map-triggers.js';
import { shopSt, openShop, handleShopInput } from './shop.js';
import { bedSt, handleBedInput } from './bed.js';
import { findShopAtCounter } from './data/shops.js';
import { loadWorldMapAtPosition, loadMapById } from './map-loading.js';
import { tickRandomEncounter, isEncounterCheckPending } from './battle-encounter.js';
import { startBattle } from './battle-update.js';
import { MapRenderer } from './map-renderer.js';
import { resetIndoorWaterCache } from './water-animation.js';
import { findNpcAt, talkToNpc, tryYieldToPlayer } from './npc.js';

const TILE_SIZE = 16;
const WALK_DURATION = 16 * (1000 / 60);  // 16 NES frames at 60fps ≈ 267ms per tile

// ── Movement state ─────────────────────────────────────────────────────────
let moveStartX = 0;
let moveStartY = 0;
let moveTargetX = 0;
let moveTargetY = 0;
let moveTimer = 0;

export let poisonFlashTimer = -1;
export function setPoisonFlashTimer(v) { poisonFlashTimer = v; }

// ── Movement ───────────────────────────────────────────────────────────────

export function startMove(dir) {
  const dx = dir === DIR_RIGHT ? TILE_SIZE : dir === DIR_LEFT ? -TILE_SIZE : 0;
  const dy = dir === DIR_DOWN ? TILE_SIZE : dir === DIR_UP ? -TILE_SIZE : 0;
  const targetX = mapSt.worldX + dx;
  const targetY = mapSt.worldY + dy;

  const tileX = targetX / TILE_SIZE;
  const tileY = targetY / TILE_SIZE;

  // Block walking onto boss sprite tile
  if (mapSt.bossSprite && !battleSt.enemyDefeated && tileX === mapSt.bossSprite.px / TILE_SIZE && tileY === mapSt.bossSprite.py / TILE_SIZE) {
    sprite.setDirection(dir);
    sprite.resetFrame();
    return;
  }

  // Block walking onto an NPC tile (overworld map only — NPCs are solid).
  // When blocked, ask the NPC to yield: it hops one tile out of the way at
  // half walk duration, prefers a perpendicular sidestep, falls back to
  // continuing along the player's heading. Single-tile hop, then resumes
  // its normal pause cycle. v1.7.693.
  if (!mapSt.onWorldMap) {
    const blocker = findNpcAt(tileX, tileY);
    if (blocker) {
      sprite.setDirection(dir);
      sprite.resetFrame();
      tryYieldToPlayer(blocker, dir);
      return;
    }
  }

  // Locked doors — solid like NPCs (silent block). "Locked." message only
  // fires from the A-press handler so it doesn't spam during movement.
  // v1.7.680.
  if (mapSt.lockedDoors && mapSt.lockedDoors.has(`${tileX},${tileY}`)) {
    sprite.setDirection(dir);
    sprite.resetFrame();
    return;
  }

  const renderer = mapSt.onWorldMap ? mapSt.worldMapRenderer : mapSt.mapRenderer;
  if (renderer && !renderer.isPassable(tileX, tileY)) {
    sprite.setDirection(dir);
    sprite.resetFrame();
    // (95,44) south of Ur is now physically blocked by a boulder overlay
    // (world-map-renderer.js) — no "Coming Soon!" popup needed. v1.7.505.
    return;
  }

  sprite.setDirection(dir);
  mapSt.moving = true;
  moveStartX = mapSt.worldX;
  moveStartY = mapSt.worldY;
  moveTimer = 0;
  moveTargetX = targetX;
  moveTargetY = targetY;

  // Close open door when player walks off it
  if (mapSt.openDoor) {
    mapSt.mapRenderer.updateTileAt(mapSt.openDoor.x, mapSt.openDoor.y, mapSt.openDoor.tileId);
    mapSt.openDoor = null;
  }
}

export function updateMovement(dt) {
  if (!mapSt.moving) return;

  moveTimer += dt;
  const t = Math.min(moveTimer / WALK_DURATION, 1);

  mapSt.worldX = moveStartX + (moveTargetX - moveStartX) * t;
  mapSt.worldY = moveStartY + (moveTargetY - moveStartY) * t;

  sprite.setWalkProgress(t);

  if (t >= 1) _onMoveComplete();
}

// ── Input dispatch ─────────────────────────────────────────────────────────

export function handleInput() {
  if (!sprite) return;
  // Bed rest scene owns all input while active (fade / sleep / wake).
  if (bedSt.state !== 'closed' && handleBedInput(keys)) return;
  // Shop has top priority — block all other input while open. Message box can
  // open over a shop (e.g. "Bought X!") and is handled below.
  if (shopSt.state !== 'closed' && msgState.state === 'none' && handleShopInput(keys)) return;

  // Universal message box is MODAL — runs before every battle / trade /
  // inspect / roster / pause handler so those can't pre-consume Enter / S
  // / Z / X before the msgbox sees them. v1.7.643 (was line ~133; downstream
  // handlers had their own msgState===none gates but the dispatch order
  // still let them eat keys destined for the msgbox). PVP search, party
  // invite, trade offering, and yes/no prompts all share this single path.
  // v1.7.222 added X-back-out; v1.7.223 tightened to "any close = forfeit".
  if (msgState.state !== 'none') {
    if (msgState.state === 'hold') {
      if (isSearchActive() && !isSearchResolving()) {
        // Only X (B / back) forfeits. Z is inert while searching —
        // the message is the search; you can't A-confirm it away.
        // v1.7.224.
        if (keys['x'] || keys['X']) {
          keys['x'] = false; keys['X'] = false;
          cancelPVPSearch('user');  // replaces "Searching..." with "Cancelled"
        } else if (keys['z'] || keys['Z']) {
          keys['z'] = false; keys['Z'] = false;  // eat the press, no-op
        }
      } else if (isInviteActive() && !isInviteResolving()) {
        // Same hand-off rules as the search — message IS the invite,
        // X forfeits, Z is inert. v1.7.235.
        if (keys['x'] || keys['X']) {
          keys['x'] = false; keys['X'] = false;
          cancelPartyInvite('user');
        } else if (keys['z'] || keys['Z']) {
          keys['z'] = false; keys['Z'] = false;
        }
      } else if (isTradeOffering()) {
        // Same hand-off rules as search/invite — X forfeits, Z inert.
        // v1.7.237.
        if (keys['x'] || keys['X']) {
          keys['x'] = false; keys['X'] = false;
          cancelTrade('user');
        } else if (keys['z'] || keys['Z']) {
          keys['z'] = false; keys['Z'] = false;
        }
      } else if (msgState.isPrompt) {
        // Yes/no prompt (v1.7.379) — Z = accept, X = decline. Each fires the
        // matching callback and slides the box out. Used by party-invite
        // incoming, reusable for any future yes/no UI.
        if (keys['z'] || keys['Z']) {
          keys['z'] = false; keys['Z'] = false;
          const cb = msgState.onAccept;
          msgState.isPrompt = false; msgState.onAccept = null; msgState.onDecline = null;
          dismissMsgBox();
          if (cb) cb();
        } else if (keys['x'] || keys['X'] || keys['Escape']) {
          keys['x'] = false; keys['X'] = false; keys['Escape'] = false;
          const cb = msgState.onDecline;
          msgState.isPrompt = false; msgState.onAccept = null; msgState.onDecline = null;
          dismissMsgBox();
          if (cb) cb();
        }
      } else if (keys['z'] || keys['Z']) {
        keys['z'] = false; keys['Z'] = false;
        if (msgState.onAdvance) msgState.onAdvance();
        else dismissMsgBox();
      } else if (!msgState.onAdvance && (keys['x'] || keys['X'] || keys['Escape'])) {
        keys['x'] = false; keys['X'] = false; keys['Escape'] = false;
        dismissMsgBox();
      }
    }
    return;
  }

  // Below this point msgState.state === 'none'; dispatch the rest of the
  // overworld input chain (battle / trade / inspect / roster / pause).
  if (handleBattleInput()) return;
  // Trade item-pick panel takes priority over roster — opened from the
  // roster menu but owns its own input loop. v1.7.237.
  if (isTradePicking() && handleTradePickInput(keys)) return;
  // Inspect stat panel — same pattern, owns its own input loop. v1.7.239.
  if (isInspectOpen() && handleInspectInput(keys)) return;
  if (handleRosterInput()) return;
  if (handlePauseInput()) return;

  if (mapSt.moving) return;
  if (transSt.state !== 'none') return;
  if (mapSt.shakeActive) return;
  if (mapSt.starEffect) return;
  if (mapSt.pondStrobeTimer > 0) return;
  if (chatState.expanded) {
    // Up/down scrolls the chat log; gate SFX on whether scrolling actually
    // happens (no sound if the buffer fits or we're already pinned at the
    // top/bottom). setChatScrollOffset clamps regardless.
    if (keys['ArrowUp']) {
      keys['ArrowUp'] = false;
      if (canChatScrollUp()) {
        setChatScrollOffset(chatScrollOffset + 1);
        playSFX(SFX.CURSOR);
      }
    } else if (keys['ArrowDown']) {
      keys['ArrowDown'] = false;
      if (canChatScrollDown()) {
        setChatScrollOffset(chatScrollOffset - 1);
        playSFX(SFX.CURSOR);
      }
    }
    return;
  }
  if (tabSelectMode) return;

  if (keys['z'] || keys['Z']) {
    keys['z'] = false;
    keys['Z'] = false;
    handleAction();
    return;
  }

  startMoveFromKeys();
}

// ── Tile action (Z press) ──────────────────────────────────────────────────

function handleAction() {
  if (mapSt.onWorldMap || !mapSt.mapRenderer || !mapSt.mapData) return;

  const dir = sprite.getDirection();
  const tileX = mapSt.worldX / TILE_SIZE;
  const tileY = mapSt.worldY / TILE_SIZE;
  const dx = dir === DIR_RIGHT ? 1 : dir === DIR_LEFT ? -1 : 0;
  const dy = dir === DIR_DOWN ? 1 : dir === DIR_UP ? -1 : 0;
  const facedX = tileX + dx;
  const facedY = tileY + dy;

  if (facedX < 0 || facedX >= 32 || facedY < 0 || facedY >= 32) return;

  // Boss fight trigger
  if (mapSt.bossSprite && !battleSt.enemyDefeated && facedX === 6 && facedY === 8) {
    startBattle();
    return;
  }

  // NPC dialogue
  const npc = findNpcAt(facedX, facedY);
  if (npc) { talkToNpc(npc); return; }

  const facedTile = mapSt.mapData.tilemap[facedY * 32 + facedX];

  // Third torch opens hidden passage
  if (facedTile === 0x32 && facedX === 8 && facedY === 16) {
    openPassage();
    return;
  }

  // Shop counter — open buy menu
  const shopId = findShopAtCounter(mapSt.currentMapId, facedX, facedY);
  if (shopId && openShop(shopId)) return;

  // Locked door — if player has a Magic Key (0x98), prompt "Use MagicKey?
  // A=Yes B=No" via the standard yes/no prompt. Accept → consume one key
  // + remove coord from lockedDoors (door is now unlocked, next bump
  // triggers the normal warp). Decline → cancel, door stays locked.
  // No key in inventory → fall back to the v1.7.669 "Locked." message.
  // v1.7.671.
  if (mapSt.lockedDoors && mapSt.lockedDoors.has(`${facedX},${facedY}`)) {
    if (msgState.state !== 'none') return;
    const doorKey = `${facedX},${facedY}`;
    if (hasItem(0x98)) {
      showMsgBoxPrompt(
        _nameToBytes('Use MagicKey? ' + yesNoLabels()),
        () => {
          removeItem(0x98, 1);
          mapSt.lockedDoors.delete(doorKey);
          // Persist unlock — write the (unchanged) door tile id 0x70 to
          // ps.consumedTiles so `_replayConsumedTiles` removes the coord
          // from lockedDoors on next chamber re-entry. Door stays
          // unlocked across save / reload. v1.7.672.
          const mapId = mapSt.currentMapId;
          if (!ps.consumedTiles) ps.consumedTiles = {};
          if (!ps.consumedTiles[mapId]) ps.consumedTiles[mapId] = {};
          ps.consumedTiles[mapId][doorKey] = 0x70;
          saveSlotsToDB();
          showMsgBox(_nameToBytes('Unlocked!'));
        },
        null,  // decline = silent cancel; box just slides out
      );
    } else {
      showMsgBox(_nameToBytes('Locked.'));
    }
    return;
  }
  if (facedTile === 0x7C)                                         { handleChest(facedX, facedY); return; }
  // Hidden-treasure tiles (0x78-0x7B) — ROM-flagged "search here" markers.
  // Render as vases / grass / etc. Z attempts a search with a small hit
  // chance; loot pulls from the map's regular chest pool. Falls through
  // silently on miss or 24h cooldown so the tile reads as decoration.
  if (isHiddenTreasureTile(facedTile) && handleHiddenTreasure(facedX, facedY)) return;
  if (mapSt.secretWalls && mapSt.secretWalls.has(`${facedX},${facedY}`))      { handleSecretWall(facedX, facedY); return; }
  if (mapSt.rockSwitch && mapSt.rockSwitch.rocks.some(r => facedX === r.x && facedY === r.y)) { handleRockPuzzle(); return; }
  if (mapSt.pondTiles && mapSt.pondTiles.has(`${facedX},${facedY}`))          { handlePondHeal(); return; }
}

// ── Move complete ──────────────────────────────────────────────────────────

function _onMoveComplete() {
  mapSt.worldX = moveTargetX;
  mapSt.worldY = moveTargetY;
  mapSt.moving = false;

  // Wrap world coordinates on world map
  if (mapSt.onWorldMap) {
    const mapPx = mapSt.worldMapData.mapWidth * TILE_SIZE;
    mapSt.worldX = ((mapSt.worldX % mapPx) + mapPx) % mapPx;
    mapSt.worldY = ((mapSt.worldY % mapPx) + mapPx) % mapPx;
  }

  // Clear disabled trigger once player moves off it
  if (mapSt.disabledTrigger) {
    const curTX = mapSt.worldX / TILE_SIZE;
    const curTY = mapSt.worldY / TILE_SIZE;
    if (curTX !== mapSt.disabledTrigger.x || curTY !== mapSt.disabledTrigger.y) {
      mapSt.disabledTrigger = null;
    }
  }

  // NES poison step damage: -1 HP per step, min 1, SFX + flash
  if (ps.status && ps.status.mask & 0x02 && ps.hp > 1) {
    ps.hp -= 1;
    playSFX(SFX.ATTACK_HIT);
    poisonFlashTimer = 0;
  }

  if (_checkFalseWall()) return;
  if (_checkWarpTile()) return;

  if (checkTrigger()) return;
  if (tickRandomEncounter()) return;

  startMoveFromKeys(true);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _checkFalseWall() {
  if (!mapSt.falseWalls || mapSt.falseWalls.size === 0) return false;
  const key = `${mapSt.worldX / TILE_SIZE},${mapSt.worldY / TILE_SIZE}`;
  if (!mapSt.falseWalls.has(key)) return false;
  const dest = mapSt.falseWalls.get(key);
  // Three destination shapes:
  //   `{ mapId }`         — separate-map warp (push current map onto stack
  //                         then loadMapById). v1.7.665.
  //   `{ goBack: true }`  — pop the mapStack to return to the chamber map
  //                         at the saved position. v1.7.665.
  //   `{ destX, destY }`  — legacy in-map warp (existing behavior).
  if (dest.mapId !== undefined) {
    const savedX = mapSt.worldX, savedY = mapSt.worldY;
    triggerWipe(() => {
      mapSt.mapStack.push({ mapId: mapSt.currentMapId, x: savedX, y: savedY });
      loadMapById(dest.mapId);
    }, dest.mapId);
  } else if (dest.goBack) {
    const prevMapId = mapSt.mapStack.length > 0 ? mapSt.mapStack[mapSt.mapStack.length - 1].mapId : null;
    triggerWipe(() => {
      if (mapSt.mapStack.length > 0) {
        const prev = mapSt.mapStack.pop();
        loadMapById(prev.mapId, prev.x / TILE_SIZE, prev.y / TILE_SIZE);
      }
    }, prevMapId);
  } else {
    triggerWipe(() => {
      mapSt.worldX = dest.destX * TILE_SIZE;
      mapSt.worldY = dest.destY * TILE_SIZE;
      sprite.setDirection(DIR_DOWN);
      mapSt.mapRenderer = new MapRenderer(mapSt.mapData, dest.destX, dest.destY); resetIndoorWaterCache();
    });
  }
  return true;
}

function _checkWarpTile() {
  if (!mapSt.warpTile) return false;
  const tx = mapSt.worldX / TILE_SIZE;
  const ty = mapSt.worldY / TILE_SIZE;
  if (tx !== mapSt.warpTile.x || ty !== mapSt.warpTile.y) return false;
  sprite.setDirection(DIR_DOWN);
  playSFX(SFX.WARP);
  mapSt.starEffect = {
    frame: 0, radius: 60, angle: 0, spin: true,
    onComplete: () => {
      triggerWipe(() => {
        while (mapSt.mapStack.length > 0) {
          const entry = mapSt.mapStack.pop();
          if (entry.mapId === 'world') {
            playTrack(TRACKS.WORLD_MAP);
            loadWorldMapAtPosition(entry.x, entry.y);
            return;
          }
        }
      }, 'world');
    }
  };
  return true;
}

export function startMoveFromKeys(resetOnIdle) {
  if (isEncounterCheckPending()) { if (resetOnIdle) sprite.resetFrame(); return; }
  if (keys['ArrowDown']) startMove(DIR_DOWN);
  else if (keys['ArrowUp']) startMove(DIR_UP);
  else if (keys['ArrowLeft']) startMove(DIR_LEFT);
  else if (keys['ArrowRight']) startMove(DIR_RIGHT);
  else if (resetOnIdle) sprite.resetFrame();
}
