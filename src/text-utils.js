import { getItemNameClean } from './text-decoder.js';

// Convert JS string to NES-encoded Uint8Array (A-Z, a-z, 0-9, space→0xFF)
export function _nameToBytes(name) {
  const bytes = [];
  for (let i = 0; i < name.length; i++) {
    const ch = name.charCodeAt(i);
    if (ch >= 65 && ch <= 90) bytes.push(0x8A + (ch - 65));       // A-Z
    else if (ch >= 97 && ch <= 122) bytes.push(0xCA + (ch - 97)); // a-z
    else if (ch >= 48 && ch <= 57) bytes.push(0x80 + (ch - 48));  // 0-9
    else bytes.push(0xFF); // space
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

// "Found [name]!"
export function makeFoundItemText(itemId) {
  const found = [0x8F, 0xD8, 0xDE, 0xD7, 0xCD, 0xFF]; // "Found "
  const name = getItemNameClean(itemId);
  const arr = new Uint8Array(found.length + name.length + 1);
  arr.set(found, 0);
  arr.set(name, found.length);
  arr[found.length + name.length] = 0xC4; // "!"
  return arr;
}
