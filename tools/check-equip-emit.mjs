#!/usr/bin/env node
// check-equip-emit.mjs — every code path that changes equipped gear must TELL
// THE SERVER.
//
// The mirror in `inv_equipped` is authoritative for what other players see. A
// path that mutates `ps.weaponR/weaponL/head/body/arms` without emitting
// `sendNetEquipFromInv` (or `sendNetEquipSwapHands` for the R<->L permute)
// leaves the mirror behind, and ws-presence then overwrites the broadcast with
// the stale value — so the player looks correct to themselves and wrong to
// everyone else. That is the `[update divergence]` line in prod.
//
// Equipment moves two ways and BOTH have to be found:
//   1. through `setEquipSlotId(eqIdx, id)`
//   2. by assigning `ps.weaponR` / `ps.weaponL` / `ps.head` / `ps.body` /
//      `ps.arms` directly, which bypasses the helper completely
// Grepping only for (1) misses the interesting ones — the quiver-empty clear
// and `releaseOffhandForTwoHanded` are both (2).
//
//   node tools/check-equip-emit.mjs          list every mutation + verdict
//   node tools/check-equip-emit.mjs --all    include the allow-listed ones

import { readFileSync, readdirSync } from 'node:fs';

const SRC = new URL('../src/', import.meta.url).pathname;
const EMIT = /sendNetEquipFromInv|sendNetEquipSwapHands/;
const MUTATE = /(?:setEquipSlotId\s*\(|ps\.(?:weaponR|weaponL|head|body|arms)\s*=(?!=))/;
const SHOW_ALL = process.argv.includes('--all');

// Paths that legitimately do NOT emit, with the reason. Anything not on this
// list and not emitting is a finding.
const ALLOWED = new Map([
  ['title-screen.js', 'load path — restores ps from a save the server already has; ' +
                      'emitting would echo the mirror back at itself every boot'],
  ['main.js', "applies the server's own inv-state push; emitting would bounce it " +
              'straight back at the sender'],
  ['inventory.js', 'releaseOffhandForTwoHanded is a helper — its CALL SITES emit for ' +
                   'the freed hand, which is checked separately below'],
]);

const files = readdirSync(SRC).filter(f => f.endsWith('.js'));
const findings = [];
const okPaths = [];

for (const file of files) {
  if (file === 'player-stats.js') continue;          // defines the setter itself
  const src = readFileSync(SRC + file, 'utf8');
  const lines = src.split('\n');

  // Walk functions by brace depth so a mutation is judged against the body it
  // actually lives in, not the whole file. A file-wide grep would call
  // inventory.js "fine" because some OTHER function in it emits.
  const fnStarts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.test(lines[i]) ||
        /^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/.test(lines[i])) {
      fnStarts.push(i);
    }
  }
  const fnAt = (line) => {
    let best = -1;
    for (const s of fnStarts) { if (s <= line) best = s; else break; }
    return best;
  };
  const fnEnd = (start) => {
    let depth = 0, seen = false;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') { depth++; seen = true; }
        else if (ch === '}') { depth--; }
      }
      if (seen && depth <= 0) return i;
    }
    return lines.length - 1;
  };
  const fnName = (start) => (lines[start].match(/(?:function|const)\s+([A-Za-z0-9_$]+)/) || [])[1] || '(top level)';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!MUTATE.test(line)) continue;
    if (/^\s*(\/\/|\*)/.test(line)) continue;         // a comment mentioning it

    const start = fnAt(i);
    const end = start < 0 ? lines.length - 1 : fnEnd(start);
    const body = lines.slice(Math.max(0, start), end + 1).join('\n');
    // Check a tight window around the mutation FIRST. The brace walk above is
    // a heuristic, not a parser: it mis-scoped `rollHand` and reported a line
    // that emits ON ITSELF as missing. The window has no such failure mode; the
    // function body stays as a fallback for an emit further down.
    const near = lines.slice(i, i + 4).join('\n');
    // Slot-aware for a DIRECT assignment. `ps.weaponR = 0` followed four lines
    // later by an emit for weaponL is not covered — but a plain "is there an
    // emit nearby" test says it is, which is how the quiver fix's first
    // revert-check passed while the right hand was silent. Each slot has to see
    // its OWN eqIdx (or the R<->L swap, which moves both at once).
    const EQ_IDX = { weaponR: '-100', weaponL: '-101', head: '-102', body: '-103', arms: '-104' };
    const direct = line.match(/ps\.(weaponR|weaponL|head|body|arms)\s*=(?!=)/);
    let emits;
    if (direct) {
      const idx = EQ_IDX[direct[1]];
      const slotEmit = new RegExp('sendNetEquipFromInv\\s*\\(\\s*' + idx + '\\b|sendNetEquipSwapHands');
      emits = slotEmit.test(near) || slotEmit.test(body);
    } else {
      emits = EMIT.test(near) || EMIT.test(body);
    }
    const entry = {
      file, line: i + 1, fn: start < 0 ? '(top level)' : fnName(start),
      code: line.trim().slice(0, 78), emits,
    };
    if (emits || ALLOWED.has(file)) okPaths.push(entry);
    else findings.push(entry);
  }
}

// ── every releaseOffhandForTwoHanded CALL SITE must emit for the freed hand ──
// The helper clears the other hand and hands the item back; only the caller
// knows which slot that was. Three of the four callers captured the return and
// emitted; `_equipOptimum` ignored it, so the Optimum button could clear the
// left hand locally and leave the mirror wearing the old offhand. Checking the
// helper's own body would never have found it — the bug is at the call.
for (const file of files) {
  const src = readFileSync(SRC + file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/releaseOffhandForTwoHanded\s*\(/.test(lines[i])) continue;
    if (/^\s*(?:\/\/|\*)/.test(lines[i]) || /^import|from '\.\/inventory/.test(lines[i])) continue;
    if (/export function releaseOffhandForTwoHanded/.test(lines[i])) continue;
    const near = lines.slice(i, i + 4).join('\n');
    if (!EMIT.test(near)) {
      findings.push({ file, line: i + 1, fn: 'call site', emits: false,
        code: lines[i].trim().slice(0, 78) + '   <- freed hand never emitted' });
    } else {
      okPaths.push({ file, line: i + 1, fn: 'call site', emits: true, code: '' });
    }
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log('equipment mutations, by enclosing function:\n');
if (SHOW_ALL) {
  for (const e of okPaths) {
    const why = ALLOWED.get(e.file);
    console.log(`  ok   ${pad(e.file + ':' + e.line, 26)} ${pad(e.fn, 28)} ${why ? '[allowed: ' + why.slice(0, 40) + '...]' : 'emits'}`);
  }
  console.log('');
}
for (const e of findings) {
  console.log(`  ✗    ${pad(e.file + ':' + e.line, 26)} ${pad(e.fn, 28)} NO EMIT`);
  console.log(`       ${e.code}`);
}

console.log('');
console.log(`${okPaths.length} mutation(s) emit or are allow-listed, ${findings.length} do not.`);
if (findings.length) {
  console.log('\nEach one above changes what the player is wearing without telling the');
  console.log('server, so the mirror keeps the old value and every OTHER player sees');
  console.log('the old gear. Run with --all to see the paths that are fine.');
  process.exit(1);
}
console.log('check-equip-emit: OK — every equipment mutation reaches the server');
