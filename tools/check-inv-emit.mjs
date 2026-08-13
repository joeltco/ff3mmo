#!/usr/bin/env node
// check-inv-emit.mjs — every path that changes the BAG or GIL must reach the
// server somehow.
//
// Sibling of check-equip-emit.mjs, and the same failure mode: the mirror
// (`inv_inventories`, `inv_economies`) is authoritative, so a local mutation
// the server never hears about silently reverts on the next `inv-state` push
// and shows up as `[mirror divergence]` in prod.
//
// This one cannot just look for `sendNetInvEvent`, because several paths are
// deliberately SILENT — the server is the sole writer for them and a client
// emit would double-count:
//
//   SERVER_ECONOMY   shop buy/sell, chest opens, vase searches
//                    -> routed via sendNetShopTransaction / chest-open / vase
//   PVE_ARBITER      battle rewards -> applied from the pve-battle-end claim
//
// So a mutation is satisfied by ANY of: an inv-event, one of the dedicated
// wire calls, or a visible server-authoritative gate in the same function. What
// is NOT satisfied is a mutation with none of those anywhere near it.
//
//   node tools/check-inv-emit.mjs          findings only
//   node tools/check-inv-emit.mjs --all    every mutation and why it passed

import { readFileSync, readdirSync } from 'node:fs';

const SRC = new URL('../src/', import.meta.url).pathname;
const SHOW_ALL = process.argv.includes('--all');

const MUTATE = /\b(?:addItem|removeItem|grantGil|setPlayerInventory)\s*\(|ps\.gil\s*=(?!=)/;

// Anything here means "the server will find out about this".
const NOTIFIES = [
  /sendNetInvEvent/, /sendNetShopTransaction/, /sendNetGiveItem/,
  /sendNetTradeOffer/, /sendNetTradeResponse/, /sendNetEquipFromInv/,
  /sendNetEquipSwapHands/,
  // Server-authoritative gates: the mutation is applied server-side from a
  // different message, and emitting as well would double-count.
  /SERVER_ECONOMY/, /PVE_ARBITER/, /pveCurrentBattleId/,
  /sendNetChestOpen/, /sendNetVaseSearch/,
];

const ALLOWED = new Map([
  ['title-screen.js', 'load path — restores the bag from a save the server already holds'],
  ['main.js',         "applies the server's own inv-state push; emitting bounces it back"],
  ['save-state.js',   'serialiser — reads state, does not originate a change'],
  ['inventory.js',    'the mutators themselves; their CALL SITES are what this checks'],
  ['chat.js',         'dev-only console commands (registerCommand ... { dev: true })'],
]);

const files = readdirSync(SRC).filter(f => f.endsWith('.js'));
const findings = [];
const okPaths = [];

for (const file of files) {
  const src = readFileSync(SRC + file, 'utf8');
  const lines = src.split('\n');

  const fnStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:export\s+)?(?:async\s+)?function\s+[A-Za-z0-9_$]+/.test(lines[i]) ||
        /^\s*(?:export\s+)?const\s+[A-Za-z0-9_$]+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/.test(lines[i])) {
      fnStarts.push(i);
    }
  }
  const fnAt = (line) => { let b = -1; for (const s of fnStarts) { if (s <= line) b = s; else break; } return b; };
  const fnEnd = (start) => {
    let depth = 0, seen = false;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) { if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--; }
      if (seen && depth <= 0) return i;
    }
    return lines.length - 1;
  };
  const fnName = (s) => (lines[s].match(/(?:function|const)\s+([A-Za-z0-9_$]+)/) || [])[1] || '(top level)';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!MUTATE.test(line)) continue;
    if (/^\s*(?:\/\/|\*)/.test(line)) continue;
    if (/^\s*(?:export\s+)?function\s+(?:addItem|removeItem|grantGil|setPlayerInventory)/.test(line)) continue;
    if (/^import|from '\.\//.test(line)) continue;

    const start = fnAt(i);
    const end = start < 0 ? lines.length - 1 : fnEnd(start);
    // A window AND the enclosing function, same as the equip scanner: the brace
    // walk is a heuristic and mis-scopes short helpers.
    const scope = lines.slice(i, i + 5).join('\n') + '\n' + lines.slice(Math.max(0, start), end + 1).join('\n');
    const why = NOTIFIES.find(re => re.test(scope));
    const entry = {
      file, line: i + 1, fn: start < 0 ? '(top level)' : fnName(start),
      code: line.trim().slice(0, 76),
      why: why ? String(why).replace(/^\/|\/$/g, '') : null,
    };
    if (why || ALLOWED.has(file)) okPaths.push(entry);
    else findings.push(entry);
  }
}

const pad = (s, n) => String(s).padEnd(n);
if (SHOW_ALL) {
  console.log('bag / gil mutations that DO reach the server:\n');
  for (const e of okPaths) {
    const allow = ALLOWED.get(e.file);
    console.log(`  ok  ${pad(e.file + ':' + e.line, 24)} ${pad(e.fn, 26)} ${allow ? 'allowed: ' + allow.slice(0, 38) : 'via ' + e.why}`);
  }
  console.log('');
}
for (const e of findings) {
  console.log(`  ✗   ${pad(e.file + ':' + e.line, 24)} ${pad(e.fn, 26)} NO SERVER NOTIFICATION`);
  console.log(`      ${e.code}`);
}

console.log(`\n${okPaths.length} mutation(s) reach the server or are allow-listed, ${findings.length} do not.`);
if (findings.length) {
  console.log('\nEach one changes the bag or gil locally with nothing telling the server,');
  console.log("so the mirror keeps the old value and the next inv-state push reverts it.");
  process.exit(1);
}
console.log('check-inv-emit: OK — every bag/gil mutation reaches the server');
