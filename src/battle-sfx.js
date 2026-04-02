// Battle SFX helpers — shared between game.js and pvp.js

import { playSFX, stopSFX, SFX } from './music.js';
import { isBladedWeapon } from './data/items.js';

let _sfxCutTimerId = null;

export function playSlashSFX(weaponId, isCrit) {
  const bladed = isBladedWeapon(weaponId);
  playSFX(bladed ? SFX.KNIFE_HIT : SFX.ATTACK_HIT);
  if (bladed && !isCrit) {
    if (_sfxCutTimerId) clearTimeout(_sfxCutTimerId);
    _sfxCutTimerId = setTimeout(() => { stopSFX(); _sfxCutTimerId = null; }, 133);
  }
}
