#!/usr/bin/env node
// ff1-script-dump.mjs — FF1's script, decoded.
//
// The TEXT decoding is verified against the running game: string 49 is exactly
// the box a Coneria Castle guard displayed. What is NOT known is which map
// object speaks which string — see tools/lib/ff1-text.mjs.
//
//   node tools/ff1-script-dump.mjs
//   node tools/ff1-script-dump.mjs --names
//   node tools/ff1-script-dump.mjs --json

import { loadRom, decodeString } from './lib/ff1-text.mjs';

const rom = loadRom();
const args = process.argv.slice(2);

/** A name only counts when a line identifies its own speaker. */
export function selfName(text) {
  let m = /^I am ([A-Z][A-Za-z]+)/.exec(text);
  if (m) return m[1];
  m = /^I,? ([A-Z][A-Za-z]+),/.exec(text);
  if (m) return m[1];
  m = /^My name is ([A-Z][A-Za-z]+)/.exec(text);
  if (m) return m[1];
  // ⛔ NO "^Name:" rule. FF1 writes ellipsis as "::", so "Oh:: My sister::"
  // matches it and invents a character called "Oh".
  return null;
}

const rows = [];
for (let id = 0; id < 400; id++) {
  const t = decodeString(rom, id);
  if (t) rows.push({ id, name: selfName(t), text: t });
}

if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else if (args.includes('--names')) {
  const n = rows.filter(r => r.name);
  console.log(`FF1 — ${n.length} strings whose speaker names themselves\n`);
  for (const r of n) console.log(`0x${r.id.toString(16).padStart(3, '0')}  «${r.name}»  "${r.text}"`);
  console.log(`\ndistinct: ${[...new Set(n.map(r => r.name))].join(', ')}`);
} else {
  console.log(`FF1 script — ${rows.length} strings\n`);
  for (const r of rows) console.log(`0x${r.id.toString(16).padStart(3, '0')}${r.name ? '  «' + r.name + '»' : ''}  ${r.text}`);
}
