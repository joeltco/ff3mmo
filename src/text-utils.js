import { getItemNameShrines } from './text-decoder.js';
import { drawText, measureText } from './font-renderer.js';
import { nesColorFade } from './palette.js';
// `_nameToBytes` is `data/strings.js#encodeName`, re-exported under the name
// every call site already uses. The body used to live here, which put the only
// string->font-byte encoder behind a module that imports the renderer, so data
// modules could not reach it without pulling canvas code into node tooling.
// Imported (not bare re-exported) because this module calls it itself, and a
// bare `export ... from` creates no local binding — eslint caught that.
import { encodeName as _nameToBytes } from './data/strings.js';
export { _nameToBytes };


// Convert NES-encoded bytes back to JS string (AWJ encoding)
export function _nesNameToString(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xA4 && b <= 0xBD) s += String.fromCharCode(b - 0xA4 + 97);
    else if (b >= 0x8A && b <= 0xA3) s += String.fromCharCode(b - 0x8A + 65);
    else if (b >= 0x80 && b <= 0x89) s += String.fromCharCode(b - 0x80 + 48);
  }
  return s;
}

// "Got N <suffix>" — shared core for EXP/Gil text. "Got " = G(0x90) o(0xB2) t(0xB7) space(0xFF)
export function _makeGotNText(amount, suffix) {
  const arr = [0x90, 0xB2, 0xB7, 0xFF]; // "Got "
  for (const d of String(amount)) arr.push(0x80 + parseInt(d));
  arr.push(...suffix);
  return new Uint8Array(arr);
}

export function makeExpText(amount) { return _makeGotNText(amount, [0xFF, 0x8E, 0xA1, 0x99, 0xC4]); } // " EXP!"
export function makeGilText(amount) { return _makeGotNText(amount, [0xFF, 0x90, 0xAC, 0xAF, 0xC4]); } // " Gil!"
export function makeCpText(amount) { return _makeGotNText(amount, [0xFF, 0x8C, 0x99, 0xC4]); } // " CP!"

// Draw "Lv##" left-aligned + colored HP right-aligned on the same row
// leftX/rightX = content edges (inside border), y = text baseline, fadeStep = NES color fade steps
export function drawLvHpRow(ctx, leftX, rightX, y, level, hp, maxHP, fadeStep) {
  const lvLabel = _nameToBytes('Lv' + String(level));
  const lvPal = [0x0F, 0x0F, 0x0F, 0x10];
  for (let s = 0; s < fadeStep; s++) lvPal[3] = nesColorFade(lvPal[3]);
  drawText(ctx, leftX, y, lvLabel, lvPal);
  const hpNes = hp <= Math.floor(maxHP / 4) ? 0x16
              : hp <= Math.floor(maxHP / 2) ? 0x28 : 0x2A;
  const hpPal = [0x0F, 0x0F, 0x0F, hpNes];
  for (let s = 0; s < fadeStep; s++) hpPal[3] = nesColorFade(hpPal[3]);
  const hpLabel = _nameToBytes(String(hp));
  drawText(ctx, rightX - measureText(hpLabel), y, hpLabel, hpPal);
}

// "[icon] [name]!" — for 2-line drop display paired with BATTLE_FOUND on top
// row. v1.7.732 — switched from getItemNameClean (which strips the leading
// icon byte) to getItemNameShrines so the drop message gets the class glyph
// (staff $EA, sword $EF, etc.) the same way chest treasures + inventory rows
// do. Pre-fix: "Found Staff!" rendered with no icon; chests already had it
// via map-triggers.js#getItemNameShrines.
export function makeItemDropText(itemId) {
  const name = getItemNameShrines(itemId);
  const arr = new Uint8Array(name.length + 1);
  arr.set(name, 0);
  arr[name.length] = 0xC4; // "!"
  return arr;
}
