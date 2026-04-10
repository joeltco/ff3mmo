// Random encounter spawning — extracted from game.js

import { MONSTERS } from './data/monsters.js';
import { ENCOUNTERS } from './data/encounters.js';
import { GOBLIN_HIT_RATE } from './battle-math.js';
import { SFX, playSFX } from './music.js';
import { TRACKS } from './music.js';
import { createStatusState } from './status-effects.js';

let _s = null;

// ── Random encounter step counter ──────────────────────────────────────────
export function tickRandomEncounter(shared) {
  _s = shared;
  if (_s.battleState !== 'none') return false;
  const inDungeon = _s.dungeonFloor >= 0 && _s.dungeonFloor < 4;
  const onGrass = _s.onWorldMap && _s.worldMapRenderer && (() => {
    const tileX = Math.floor(_s.worldX / _s.TILE_SIZE);
    const tileY = Math.floor(_s.worldY / _s.TILE_SIZE);
    return !_s.worldMapRenderer.getTriggerAt(tileX, tileY);
  })();
  if (!inDungeon && !onGrass) return false;
  _s.encounterSteps++;
  const threshold = onGrass
    ? 20 + Math.floor(Math.random() * 20)
    : 15 + Math.floor(Math.random() * 15);
  if (_s.encounterSteps >= threshold) {
    _s.encounterSteps = 0;
    startRandomEncounter(_s);
    return true;
  }
  return false;
}

// ── Spawn encounter monsters ───────────────────────────────────────────────
export function startRandomEncounter(shared) {
  _s = shared;
  _s.isRandomEncounter = true;
  _s.inputSt.battleActionCount = 0;

  const zoneKey = _s.onWorldMap
    ? 'grasslands'
    : (['altar_cave_f1','altar_cave_f2','altar_cave_f3','altar_cave_f4'][_s.dungeonFloor] || 'altar_cave_f1');
  const zone = ENCOUNTERS.get(zoneKey);
  const formations = zone ? zone.formations : [[{ id: 0x00, min: 1, max: 3 }]];
  const formation = formations[Math.floor(Math.random() * formations.length)];

  _s.encounterMonsters = [];
  for (const group of formation) {
    const count = group.min + Math.floor(Math.random() * (group.max - group.min + 1));
    for (let i = 0; i < count; i++) {
      if (_s.encounterMonsters.length >= 4) break;
      const mData = MONSTERS.get(group.id) || MONSTERS.get(0x00);
      _s.encounterMonsters.push({
        monsterId: group.id,
        hp: mData.hp, maxHP: mData.hp,
        atk: mData.atk, attackRoll: mData.attackRoll || 1,
        def: mData.def, evade: mData.evade || 0,
        mdef: mData.mdef || 0,
        exp: mData.exp, gil: mData.gil || 0,
        hitRate: mData.hitRate || GOBLIN_HIT_RATE,
        spAtkRate: mData.spAtkRate || 0,
        attacks: mData.attacks || null,
        level: mData.level || 1,
        agi: mData.level || 1,
        statusAtk: mData.statusAtk || null,
        atkElem: mData.atkElem || null,
        weakness: mData.weakness || null,
        resist: mData.resist || null,
        status: createStatusState(),
      });
    }
    if (_s.encounterMonsters.length >= 4) break;
  }
  // Sort tallest first for top-row grid placement
  _s.encounterMonsters.sort((a, b) => {
    const ha = _s.getMonsterCanvas(a.monsterId)?.height || 32;
    const hb = _s.getMonsterCanvas(b.monsterId)?.height || 32;
    return hb - ha;
  });
  _s.preBattleTrack = TRACKS.CRYSTAL_CAVE;
  _s.resetBattleVars();
  _s.battleState = 'flash-strobe';
  _s.battleTimer = 0;
  playSFX(SFX.BATTLE_SWIPE);
}
