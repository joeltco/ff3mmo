import { getItemNameClean } from './text-decoder.js';
import { drawText, measureText } from './font-renderer.js';
import { nesColorFade } from './palette.js';

// Convert JS string to NES-encoded Uint8Array (A-Z, a-z, 0-9, space→0xFF)
export function _nameToBytes(name) {
  const bytes = [];
  for (let i = 0; i < name.length; i++) {
    const ch = name.charCodeAt(i);
    if (ch >= 65 && ch <= 90) bytes.push(0x8A + (ch - 65));       // A-Z
    else if (ch >= 97 && ch <= 122) bytes.push(0xCA + (ch - 97)); // a-z
    else if (ch >= 48 && ch <= 57) bytes.push(0x80 + (ch - 48));  // 0-9
    else if (ch === 44)  bytes.push(0xA5); // ,
    else if (ch === 39)  bytes.push(0xA9); // '
    else if (ch === 46)  bytes.push(0xC1); // .
    else if (ch === 45)  bytes.push(0xC2); // -
    else if (ch === 33)  bytes.push(0xC4); // !
    else if (ch === 63)  bytes.push(0xC5); // ?
    else if (ch === 37)  bytes.push(0xC6); // %
    else if (ch === 47)  bytes.push(0xC7); // /
    else if (ch === 58)  bytes.push(0xC8); // :
    else if (ch === 34)  bytes.push(0xC9); // "
    else if (ch === 43)  bytes.push(0xE6); // +
    else bytes.push(0xFF); // space (unknown chars)
  }
  return new Uint8Array(bytes);
}

// Convert NES-encoded bytes back to JS string
export function _nesNameToString(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b >= 0xCA) s += String.fromCharCode(b - 0xCA + 97);
    else if (b >= 0x8A) s += String.fromCharCode(b - 0x8A + 65);
    else if (b >= 0x80) s += String.fromCharCode(b - 0x80 + 48);
  }
  return s;
}

// Build inventory row: "ItemName ×N" as NES bytes
export function _buildItemRowBytes(nameBytes, countStr) {
  const rowBytes = new Uint8Array(nameBytes.length + 2 + countStr.length);
  rowBytes.set(nameBytes, 0);
  rowBytes[nameBytes.length] = 0xFF; rowBytes[nameBytes.length + 1] = 0xE1;
  for (let d = 0; d < countStr.length; d++) rowBytes[nameBytes.length + 2 + d] = 0x80 + parseInt(countStr[d]);
  return rowBytes;
}

// "Got N <suffix>" — shared core for EXP/Gil text
export function _makeGotNText(amount, suffix) {
  const arr = [0x90, 0xD8, 0xDD, 0xFF]; // "Got "
  for (const d of String(amount)) arr.push(0x80 + parseInt(d));
  arr.push(...suffix);
  return new Uint8Array(arr);
}

export function makeExpText(amount) { return _makeGotNText(amount, [0xFF, 0x8E, 0xA1, 0x99, 0xC4]); } // " EXP!"
export function makeGilText(amount) { return _makeGotNText(amount, [0xFF, 0x90, 0xD2, 0xD5, 0xC4]); } // " Gil!"
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

// "[name]!" — for 2-line drop display paired with BATTLE_FOUND on top row
export function makeItemDropText(itemId) {
  const name = getItemNameClean(itemId);
  const arr = new Uint8Array(name.length + 1);
  arr.set(name, 0);
  arr[name.length] = 0xC4; // "!"
  return arr;
}
