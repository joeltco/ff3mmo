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

import { SPELL_NAMES_SHRINES } from './data/spells.js';
import { ITEMS, ITEM_NAMES_SHRINES } from './data/items.js';
import { MONSTER_NAMES_SHRINES } from './data/monsters.js';

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

// Arrow items (#4F-#56) — the ROM names them with $6E (bow icon), same as
// the bows themselves. We swap in $77 so the list shows a distinct arrow
// glyph; the tile bytes come from the A.W. Jackson translation and live
// in font-renderer.js#ARROW_TILE_BYTES.
const ARROW_ITEM_IDS = new Set([0x4F, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56]);
const ARROW_ICON_BYTE = 0x77;
// Claw items (#01-#05) — share $64 with nunchaku (#06-#08) in the ROM.
// The shared tile reads as two diagonal sticks (correct for nunchaku),
// so claws are the ones that need a distinct glyph. A.W. Jackson's
// claw tile lands at $76; nunchaku keeps $64.
const CLAW_ITEM_IDS = new Set([0x01, 0x02, 0x03, 0x04, 0x05]);
const CLAW_ICON_BYTE = 0x76;
// Bracer + ring items (#8B, #8E, #91-#93, #95) — share $63 with gauntlets
// and gloves in the ROM. A.W. Jackson splits the arm slot into $E4
// (gauntlet) and $E5 (bracer/ring); we lift the bracer tile to $78 and
// let gauntlets/gloves keep $63 (Chaos Rush's hand shape).
const BRACER_ITEM_IDS = new Set([0x8B, 0x8E, 0x91, 0x92, 0x93, 0x95]);
const BRACER_ICON_BYTE = 0x78;
// Staff items (#0E-#14) — share $66 with rods (#09-#0D). A.W. splits
// into $E9 (rod) and $EA (staff); we lift the staff tile to $79.
const STAFF_ITEM_IDS = new Set([0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14]);
const STAFF_ICON_BYTE = 0x79;
// Mail-style body armor — share $61 with robe-style body armor. A.W.
// splits by armor weight into $E1 (robe/light) and $E2 (mail/heavy);
// we lift the mail tile to $7A. Robes (#72, #73, #79, #7A, #7B, #7D,
// #80-#82, #86, #87) keep $61.
const MAIL_ITEM_IDS = new Set([
  0x74, 0x75, 0x76, 0x77, 0x78,
  0x7C, 0x7E, 0x7F,
  0x83, 0x84, 0x85, 0x88, 0x89, 0x8A,
]);
const MAIL_ICON_BYTE = 0x7A;
// Spear items (#1A-#1D: Thunder / Wind Spear, Blood / Holy Lance) — the
// Chaos Rush $68 tile is a thin diagonal line with no spearhead, reads
// as generic. A.W. Jackson's $EC has an actual triangular head; we lift
// it to slot $73 (unused everywhere across items / spells / monsters /
// jobs in Chaos Rush).
const SPEAR_ITEM_IDS = new Set([0x1A, 0x1B, 0x1C, 0x1D]);
const SPEAR_ICON_BYTE = 0x73;
// Robe-style body armor items — CR's $61 vest silhouette read as generic
// for robe-class items. A.W. Jackson's $E1 (hooded robe) lands at slot
// $7C and overrides Cloth / Leather / Kenpo / DarkSuit / Wizard /
// BlackBelt / Bard / Scholar / Gaia / WhiteRobe / BlackRobe.
const ROBE_ITEM_IDS = new Set([0x72, 0x73, 0x79, 0x7A, 0x7B, 0x7D, 0x80, 0x81, 0x82, 0x86, 0x87]);
const ROBE_ICON_BYTE = 0x7C;

// ASCII → NES tile byte (lowercase / uppercase / digits / space). Anything
// unknown falls through to space. Kept local so text-decoder stays free of
// imports from text-utils.js, which would cycle through font-renderer.
function _asciiToTileByte(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 65 && c <= 90)  return 0x8A + (c - 65);     // A-Z
  if (c >= 97 && c <= 122) return 0xCA + (c - 97);     // a-z
  if (c >= 48 && c <= 57)  return 0x80 + (c - 48);     // 0-9
  return 0xFF;                                          // space / fallback
}

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
  // Synthesized items (DS ultimates at 0xC8+) carry an explicit `icon`
  // field in their ITEMS entry and have no ROM string — return just the
  // icon byte and let the Shrines override path supply the letters.
  const data = ITEMS.get(itemId);
  if (data && data.icon != null) return new Uint8Array([data.icon]);
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
 * Like getItemNameClean, but preserves the item-type icon byte
 * ($60-$6F shield/body/helm/glv/claw/book/rod/etc., $7B for consumables)
 * when it appears as the first byte. The icon tiles live in the font atlas
 * ($60-$6F via v1.7.245 atlas extension, $7B already in range) and render
 * through drawText() like any other glyph. Use in inventory / shop / equip
 * / battle item list / inspect / trade rows; battle-log / chat callers
 * stay on the clean path.
 * @param {number} itemId
 * @returns {Uint8Array}
 */
export function getItemNameWithIcon(itemId) {
  const bytes = getItemName(itemId);
  if (bytes.length === 0) return bytes;
  const hasIcon = ICON_TILES.has(bytes[0]);
  if (hasIcon) {
    let iconByte = bytes[0];
    if (ARROW_ITEM_IDS.has(itemId)) iconByte = ARROW_ICON_BYTE;
    else if (CLAW_ITEM_IDS.has(itemId)) iconByte = CLAW_ICON_BYTE;
    else if (BRACER_ITEM_IDS.has(itemId)) iconByte = BRACER_ICON_BYTE;
    else if (STAFF_ITEM_IDS.has(itemId)) iconByte = STAFF_ICON_BYTE;
    else if (MAIL_ITEM_IDS.has(itemId)) iconByte = MAIL_ICON_BYTE;
    else if (ROBE_ITEM_IDS.has(itemId)) iconByte = ROBE_ICON_BYTE;
    else if (SPEAR_ITEM_IDS.has(itemId)) iconByte = SPEAR_ICON_BYTE;
    // Skip any padding spaces between icon and first letter
    let i = 1;
    while (i < bytes.length && bytes[i] === 0xFF) i++;
    if (i === 1 && iconByte === bytes[0]) return bytes;
    const out = new Uint8Array(1 + (bytes.length - i));
    out[0] = iconByte;
    out.set(bytes.subarray(i), 1);
    return out;
  }
  // No icon — strip leading spaces, same as getItemNameClean
  let s = 0;
  while (s < bytes.length && bytes[s] === 0xFF) s++;
  return s > 0 ? bytes.slice(s) : bytes;
}

/**
 * Returns icon-prefixed Shrines short-name bytes for an item when one is
 * registered in ITEM_NAMES_SHRINES; falls through to getItemNameWithIcon
 * when no override exists (battle items without a clean Shrines pairing,
 * unused IDs, etc.). The icon byte is taken from the ROM so the slot
 * grouping stays correct even if the Shrines table is edited later.
 * @param {number} itemId
 * @returns {Uint8Array}
 */
export function getItemNameShrines(itemId) {
  const override = ITEM_NAMES_SHRINES.get(itemId);
  if (override == null) return getItemNameWithIcon(itemId);
  const romBytes = getItemName(itemId);
  let iconByte = (romBytes.length > 0 && ICON_TILES.has(romBytes[0])) ? romBytes[0] : null;
  if (ARROW_ITEM_IDS.has(itemId)) iconByte = ARROW_ICON_BYTE;
  else if (CLAW_ITEM_IDS.has(itemId)) iconByte = CLAW_ICON_BYTE;
  else if (BRACER_ITEM_IDS.has(itemId)) iconByte = BRACER_ICON_BYTE;
  else if (STAFF_ITEM_IDS.has(itemId)) iconByte = STAFF_ICON_BYTE;
  else if (MAIL_ITEM_IDS.has(itemId)) iconByte = MAIL_ICON_BYTE;
  else if (ROBE_ITEM_IDS.has(itemId)) iconByte = ROBE_ICON_BYTE;
  else if (SPEAR_ITEM_IDS.has(itemId)) iconByte = SPEAR_ICON_BYTE;
  const letters = new Uint8Array(override.length);
  for (let i = 0; i < override.length; i++) letters[i] = _asciiToTileByte(override[i]);
  if (iconByte == null) return letters;
  const out = new Uint8Array(letters.length + 1);
  out[0] = iconByte;
  out.set(letters, 1);
  return out;
}

/**
 * Returns Shrines short-name bytes for a monster when one is registered
 * in MONSTER_NAMES_SHRINES (in-battle name-box surface); falls through
 * to the ROM bytes via getMonsterName when no override exists (unmatched
 * monsters, dummied IDs, "C" placeholders at 0xE5/0xE6). Monsters have
 * no icon byte, so this returns raw ASCII tile bytes.
 * @param {number} monsterId
 * @returns {Uint8Array}
 */
export function getMonsterNameShrines(monsterId) {
  const override = MONSTER_NAMES_SHRINES.get(monsterId);
  if (override == null) return getMonsterName(monsterId);
  const letters = new Uint8Array(override.length);
  for (let i = 0; i < override.length; i++) letters[i] = _asciiToTileByte(override[i]);
  return letters;
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
 * Get spell name bytes with magic-school icon tiles (0x5C-0x7B) and
 * trailing spaces stripped. Use this anywhere we want just the name letters.
 * @param {number} spellId
 * @returns {Uint8Array}
 */
export function getSpellNameClean(spellId) {
  const bytes = getSpellName(spellId);
  const out = [];
  // Allowlist: digits 0x80-0x89, uppercase 0x8A-0xA3, lowercase 0xCA-0xE3,
  // basic punctuation 0xC4/0xC5/0xC8/0xC9, space 0xFF. Drops magic-school
  // icon tiles and any other padding bytes the ROM stores around the name.
  for (const b of bytes) {
    const isLetter = (b >= 0x8A && b <= 0xA3) || (b >= 0xCA && b <= 0xE3);
    const isDigit = b >= 0x80 && b <= 0x89;
    const isPunct = b === 0xC4 || b === 0xC5 || b === 0xC8 || b === 0xC9;
    const isSpace = b === 0xFF;
    if (isLetter || isDigit || isPunct || isSpace) out.push(b);
  }
  while (out.length > 0 && out[out.length - 1] === 0xFF) out.pop();
  return new Uint8Array(out);
}

/**
 * Returns icon-prefixed Shrines short-name bytes for a spell when one is
 * registered in SPELL_NAMES_SHRINES (player-castable spells, 0x00-0x37);
 * falls through to getSpellNameWithIcon for the enemy-only tail. The icon
 * byte is taken from the ROM (so the magic-school grouping stays correct
 * even if a Shrines name is renamed later). Use this at the four player
 * spell-list sites; battle-log / chat keep stripping via getSpellNameClean.
 * @param {number} spellId
 * @returns {Uint8Array}
 */
export function getSpellNameShrines(spellId) {
  const override = SPELL_NAMES_SHRINES.get(spellId);
  if (override == null) return getSpellNameWithIcon(spellId);
  const romBytes = getSpellName(spellId);
  const iconByte = (romBytes.length > 0 && ICON_TILES.has(romBytes[0])) ? romBytes[0] : null;
  const letters = new Uint8Array(override.length);
  for (let i = 0; i < override.length; i++) letters[i] = _asciiToTileByte(override[i]);
  if (iconByte == null) return letters;
  const out = new Uint8Array(letters.length + 1);
  out[0] = iconByte;
  out.set(letters, 1);
  return out;
}

/**
 * Like getSpellNameClean, but preserves the magic-school icon byte
 * ($72 Summon / $74 White / $75 Black) when it appears as the first byte.
 * The icon tile graphics live in the font atlas (ROM 0x1B710 forward) and
 * render through drawText() like any other glyph — see font-renderer.js.
 * Use in spell-list rows; battle-log / chat callers stay on the clean path.
 * @param {number} spellId
 * @returns {Uint8Array}
 */
export function getSpellNameWithIcon(spellId) {
  const bytes = getSpellName(spellId);
  const out = [];
  const isIcon = bytes.length > 0 && ICON_TILES.has(bytes[0]);
  if (isIcon) out.push(bytes[0]);
  for (let i = isIcon ? 1 : 0; i < bytes.length; i++) {
    const b = bytes[i];
    const isLetter = (b >= 0x8A && b <= 0xA3) || (b >= 0xCA && b <= 0xE3);
    const isDigit = b >= 0x80 && b <= 0x89;
    const isPunct = b === 0xC4 || b === 0xC5 || b === 0xC8 || b === 0xC9;
    const isSpace = b === 0xFF;
    if (isLetter || isDigit || isPunct || isSpace) out.push(b);
  }
  while (out.length > 0 && out[out.length - 1] === 0xFF) out.pop();
  return new Uint8Array(out);
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
