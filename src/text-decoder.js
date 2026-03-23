// Text Decoder — reads text strings from the patched FF3 ROM
//
// The ROM text system uses a pointer table at $188000 (ROM 0x030010)
// with 1712 entries. Each 2-byte pointer encodes bank + address.
// Strings are null-terminated ($00) and use tile IDs as characters.
//
// After applying the Chaos Rush English IPS patch, the tile IDs
// map to English letters:
//   Uppercase A-Z: $8A-$A3
//   Lowercase a-z: $CA-$E3
//   Digits 0-9:    $7E-$87
//   Space:          $FF
//
// String ID ranges:
//   $0000-$01FF  Event dialogue + menu text
//   $01E2-$01F7  Job names (22 entries)
//   $01F8-$01FF  Character names
//   $0200-$03FF  NPC dialogue
//   $0400-$04C7  Item names (200 entries)
//   $04C8-$051F  Spell names (88 entries)
//   $0520-$0606  Monster names (231 entries)
//   $0607-$061F  Summon names
//   $0620-$06AF  Battle messages

// --- ROM offsets ---
const PTR_TABLE = 0x030010;   // 1712 × 2-byte pointers
const BANK_BASE = 0x18;       // NES text banks start at $18

// --- String ID offsets for each category ---
const STRING_ITEMS    = 0x0400;
const STRING_SPELLS   = 0x04C8;
const STRING_MONSTERS = 0x0520;
const STRING_JOBS     = 0x01E2;
const STRING_SUMMONS  = 0x0607;

// --- Character encoding (Chaos Rush English patch) ---
// Byte → ASCII for debugging. Not needed for game rendering (tiles are direct).
const CHAR_MAP = {};

// A-Z
for (let i = 0; i < 26; i++) CHAR_MAP[0x8A + i] = String.fromCharCode(65 + i);
// a-z
for (let i = 0; i < 26; i++) CHAR_MAP[0xCA + i] = String.fromCharCode(97 + i);
// 0-9
for (let i = 0; i < 10; i++) CHAR_MAP[0x80 + i] = String.fromCharCode(48 + i);
// Space
CHAR_MAP[0xFF] = ' ';
// Common symbols
CHAR_MAP[0xA5] = ',';  // comma
CHAR_MAP[0xA9] = "'";  // apostrophe (confirmed: Zeus' Wrath)
CHAR_MAP[0xC1] = '.';  // period
CHAR_MAP[0xC2] = '-';  // hyphen (confirmed: Hi-Potion)
CHAR_MAP[0xC3] = '…';  // ellipsis
CHAR_MAP[0xC4] = '!';  // exclamation
CHAR_MAP[0xC5] = '?';  // question mark
CHAR_MAP[0xC6] = '%';  // percent
CHAR_MAP[0xC7] = '/';  // slash
CHAR_MAP[0xC8] = ':';  // colon
CHAR_MAP[0xC9] = '"';  // double quote
CHAR_MAP[0xE4] = '"';  // double quote (variant)
CHAR_MAP[0xE6] = '+';  // plus

// Item type icon tiles ($5C-$7B range) — first byte in item/spell names
const ICON_TILES = new Set();
for (let b = 0x5C; b <= 0x7B; b++) ICON_TILES.add(b);

let _romData = null;

/**
 * Initialize the text decoder with ROM data.
 * Must be called after applying the IPS translation patch.
 * @param {Uint8Array} romData — full ROM bytes (with iNES header)
 */
export function initTextDecoder(romData) {
  _romData = romData;
}

/**
 * Read raw string bytes for a given string ID.
 * @param {number} stringId — text table index
 * @param {number} [maxLen=64] — safety limit
 * @returns {Uint8Array} tile bytes (no null terminator)
 */
export function getStringBytes(stringId) {
  if (!_romData) throw new Error('Text decoder not initialized');

  const ptrOff = PTR_TABLE + stringId * 2;
  const lo = _romData[ptrOff];
  const hi = _romData[ptrOff + 1];

  // Pointer encoding: lo = address low byte
  // hi bits 0-4 = address high byte (OR'd with $80)
  // hi bits 5-7 = bank offset (added to $18)
  const bankOffset = (hi >> 5) & 0x07;
  const addrHi = (hi & 0x1F) | 0x80;
  const nesAddr = (addrHi << 8) | lo;
  const nesBank = BANK_BASE + bankOffset;

  // Convert NES bank:address to ROM file offset
  const romOffset = nesBank * 0x2000 + (nesAddr - 0x8000) + 0x10;

  // Read until null terminator
  const bytes = [];
  for (let i = 0; i < 64; i++) {
    const b = _romData[romOffset + i];
    if (b === 0x00) break;
    bytes.push(b);
  }
  return new Uint8Array(bytes);
}

/**
 * Get item name bytes. First byte may be a type icon tile.
 * @param {number} itemId — ROM item index (0x00-0xC7)
 * @returns {Uint8Array}
 */
export function getItemName(itemId) {
  return getStringBytes(STRING_ITEMS + itemId);
}

/**
 * Get item name bytes with icon stripped.
 * @param {number} itemId
 * @returns {Uint8Array}
 */
export function getItemNameClean(itemId) {
  const bytes = getItemName(itemId);
  let start = 0;
  if (bytes.length > 0 && ICON_TILES.has(bytes[0])) start = 1;
  // Strip leading spaces (0xFF) — consumables/battle items have no icon but start with a space
  while (start < bytes.length && bytes[start] === 0xFF) start++;
  return start > 0 ? bytes.slice(start) : bytes;
}

/**
 * Get monster name bytes.
 * @param {number} monsterId — ROM bestiary index (0x00-0xE6)
 * @returns {Uint8Array}
 */
export function getMonsterName(monsterId) {
  return getStringBytes(STRING_MONSTERS + monsterId);
}

/**
 * Get spell name bytes. First byte may be a magic type icon.
 * @param {number} spellId — spell index (0x00-0x57)
 * @returns {Uint8Array}
 */
export function getSpellName(spellId) {
  return getStringBytes(STRING_SPELLS + spellId);
}

/**
 * Get job name bytes.
 * @param {number} jobId — job index (0x00-0x15)
 * @returns {Uint8Array}
 */
export function getJobName(jobId) {
  return getStringBytes(STRING_JOBS + jobId);
}

/**
 * Convert tile bytes to ASCII string (best-effort, for debugging).
 * Unknown tiles shown as '?'. Icon tiles skipped.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToAscii(bytes) {
  let result = '';
  for (const b of bytes) {
    if (ICON_TILES.has(b)) continue;  // skip item type icons
    if (b < 0x28) continue;           // skip control codes
    result += CHAR_MAP[b] || '?';
  }
  return result.trim();
}
