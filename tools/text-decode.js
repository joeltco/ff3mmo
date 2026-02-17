#!/usr/bin/env node
// Text decode tool — reads text strings from the Chaos Rush patched FF3 ROM
// Usage: node tools/text-decode.js [items|monsters|spells|jobs|all|raw 0xNNNN count]

import { readFileSync } from 'fs';

const ROM_PATH = 'Final Fantasy III (Japan).nes';
const IPS_PATH = 'patches/ff3-english.ips';

// Load ROM + apply IPS patch
const romData = new Uint8Array(readFileSync(ROM_PATH));
const ipsData = new Uint8Array(readFileSync(IPS_PATH));
let pi = 5;
while (pi + 3 <= ipsData.length) {
  if (ipsData[pi] === 0x45 && ipsData[pi+1] === 0x4F && ipsData[pi+2] === 0x46) break;
  const offset = (ipsData[pi] << 16) | (ipsData[pi+1] << 8) | ipsData[pi+2]; pi += 3;
  const size = (ipsData[pi] << 8) | ipsData[pi+1]; pi += 2;
  if (size === 0) {
    const rl = (ipsData[pi] << 8) | ipsData[pi+1]; const v = ipsData[pi+2]; pi += 3;
    for (let j = 0; j < rl; j++) if (offset+j < romData.length) romData[offset+j] = v;
  } else {
    for (let j = 0; j < size; j++) if (offset+j < romData.length) romData[offset+j] = ipsData[pi+j];
    pi += size;
  }
}

// Text encoding for Chaos Rush patch:
// Uppercase A-Z: 0x8A-0xA3  (0x8A + letter_index)
// Lowercase a-z: 0xCA-0xE3  (0xCA + letter_index)
// Space: 0xFF
// Null: 0x00
// Digits: need to find
// Symbols: need to find

const charTable = {};

// Uppercase A-Z
for (let i = 0; i < 26; i++) charTable[0x8A + i] = String.fromCharCode(65 + i);
// Lowercase a-z
for (let i = 0; i < 26; i++) charTable[0xCA + i] = String.fromCharCode(97 + i);
// Space
charTable[0xFF] = ' ';

// Digits — try range starting at $7E (between symbol tiles and uppercase)
// Will verify from actual strings
for (let i = 0; i < 10; i++) charTable[0x7E + i] = String.fromCharCode(48 + i); // 0-9

// Common symbols (guesses, will verify)
charTable[0xC4] = '.';   // period
charTable[0xC5] = ',';   // comma
charTable[0xC6] = '-';   // might be -
charTable[0xC7] = '/';   // from disasm
charTable[0xC8] = ':';   // from disasm
charTable[0xC9] = '!';   // might be !
charTable[0xC2] = '-';   // seen in Hi-Potion

// Item type icons (map to descriptive strings)
const iconTable = {
  0x5C: '[CP]',
  0x60: '[claw]', 0x61: '[nun]', 0x62: '[rod]', 0x63: '[staff]',
  0x64: '[hammer]', 0x65: '[axe]', 0x66: '[spear]', 0x67: '[spear]',
  0x68: '[knife]', 0x69: '[knife]', 0x6A: '[sword]', 0x6B: '[dsword]',
  0x6C: '[book]', 0x6D: '[boom]', 0x6E: '[shur]', 0x6F: '[bell]',
  0x70: '[harp]', 0x71: '[bow]', 0x72: '[arrow]', 0x73: '[X]',
  0x74: '[shield]', 0x75: '[helm]', 0x76: '[armor]', 0x77: '[glove]',
  0x78: '[ring]', 0x79: '[ring]', 0x7A: '[key]', 0x7B: '[item]',
  0x7C: '[?1]', 0x7D: '[?2]',
};

function decodeChar(b) {
  if (charTable[b]) return charTable[b];
  if (iconTable[b]) return iconTable[b];
  if (b < 0x28) return `\\x${b.toString(16).padStart(2,'0')}`;
  return `{${b.toString(16)}}`;
}

// Text pointer table
const PTR_TABLE = 0x030010;

function getStringOffset(stringId) {
  const ptrOff = PTR_TABLE + stringId * 2;
  const lo = romData[ptrOff];
  const hi = romData[ptrOff + 1];
  const bankOffset = (hi >> 5) & 0x07;
  const addrHi = (hi & 0x1F) | 0x80;
  const nesAddr = (addrHi << 8) | lo;
  const nesBank = 0x18 + bankOffset;
  return nesBank * 0x2000 + (nesAddr - 0x8000) + 0x10;
}

function readString(stringId, maxLen = 64) {
  const off = getStringOffset(stringId);
  const bytes = [];
  for (let i = 0; i < maxLen; i++) {
    const b = romData[off + i];
    if (b === 0x00) break;
    bytes.push(b);
  }
  return bytes;
}

function decodeString(bytes) {
  return bytes.map(decodeChar).join('');
}

// --- Ranges ---
const RANGES = {
  items:    { start: 0x0400, count: 200, label: 'Item' },
  monsters: { start: 0x0520, count: 231, label: 'Monster' },
  spells:   { start: 0x04C8, count: 88,  label: 'Spell' },
  jobs:     { start: 0x01E2, count: 22,  label: 'Job' },
};

const mode = process.argv[2] || 'all';

function dumpRange(name) {
  const r = RANGES[name];
  console.log(`\n=== ${r.label}s ($${r.start.toString(16)} - $${(r.start+r.count-1).toString(16)}) ===`);
  for (let i = 0; i < r.count; i++) {
    const id = r.start + i;
    const bytes = readString(id);
    const decoded = decodeString(bytes);
    const hex = bytes.map(b => b.toString(16).padStart(2,'0')).join(' ');
    const idx = i.toString(16).padStart(2, '0').toUpperCase();
    console.log(`  #${idx}: ${decoded.padEnd(24)} [${hex}]`);
  }
}

if (mode === 'raw') {
  const start = parseInt(process.argv[3], 16);
  const count = parseInt(process.argv[4] || '20', 10);
  console.log(`\n=== Raw strings $${start.toString(16)} - $${(start+count-1).toString(16)} ===`);
  for (let i = 0; i < count; i++) {
    const id = start + i;
    const bytes = readString(id);
    const decoded = decodeString(bytes);
    const hex = bytes.map(b => b.toString(16).padStart(2,'0')).join(' ');
    console.log(`  $${id.toString(16).padStart(4,'0')}: ${decoded.padEnd(30)} [${hex}]`);
  }
} else if (RANGES[mode]) {
  dumpRange(mode);
} else {
  // all
  for (const name of Object.keys(RANGES)) dumpRange(name);
}
