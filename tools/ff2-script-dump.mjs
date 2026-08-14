#!/usr/bin/env node
// ff2-script-dump.mjs — FF2 (JP)'s script, as far as it decodes.
//
// The kana tables are measured (see tools/lib/ff2-text.mjs). What is NOT
// decoded is the sub-0x8A dictionary, so roughly a fifth of each line comes
// back as {xx}. Those are printed, never guessed.
//
//   node tools/ff2-script-dump.mjs            # strings with >=60% kana
//   node tools/ff2-script-dump.mjs --all
//   node tools/ff2-script-dump.mjs --json

import { loadRom, decodeString, literalRatio } from './lib/ff2-text.mjs';

const rom = loadRom();
const ALL = process.argv.includes('--all');
const rows = [];
for (let id = 0; id < 800; id++) {
  const t = decodeString(rom, id);
  if (!t) continue;
  const r = literalRatio(rom, id);
  if (!ALL && r < 0.6) continue;
  rows.push({ id, kanaRatio: +r.toFixed(2), text: t });
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ note: 'sub-0x8A dictionary undecoded; {xx} = unknown code', strings: rows }, null, 2));
} else {
  console.log(`FF2 script — ${rows.length} strings (kana tables measured; {xx} = undecoded dictionary code)\n`);
  for (const r of rows) console.log(`0x${r.id.toString(16).padStart(3, '0')} [${r.kanaRatio}]  ${r.text}`);
}
