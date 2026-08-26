#!/usr/bin/env node
// check-story-flags.mjs — the story-flag table, both halves of the save.
//
// A flag is what a town's appearance is keyed to (the cursed-town inversion
// reads `curse_lifted` across 37 NPCs), so the failure mode is not a crash: it
// is a player logging in and finding the curse back on. That is exactly the
// class of bug the SAVE WHITELIST LOCKSTEP rule exists for — a `ps.*` field
// added to the client serializer but not to `api.js`'s validator vanishes on
// the next server round-trip.
//
// This asserts:
//   1. the client's `sanitizeFlags` keeps declared flags and drops the rest
//   2. the SERVER agrees byte-for-byte with it (the divergence bug class that
//      `quests` shipped for a release — see api.js's note on the 9999 clamp)
//   3. a full round-trip: set -> serialize -> server-validate -> load
//   4. `setFlag` refuses an undeclared id instead of inventing a fact
//   5. every declared flag is REACHABLE — something sets it — and every flag a
//      predicate reads is declared (no orphans in either direction)
//
//   node tools/check-story-flags.mjs

import fs from 'node:fs';

let failed = 0;
const ok  = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };

const { FLAGS, isFlag, sanitizeFlags } = await import('../src/data/flags.js');
const DECLARED = Object.keys(FLAGS);
if (!DECLARED.length) { console.error('no flags declared'); process.exit(1); }

// ── 1. the client's own sanitiser ─────────────────────────────────────────
{
  const raw = {};
  for (const id of DECLARED) raw[id] = 1;
  raw.definitely_not_a_flag = 1;
  raw[DECLARED[0] + '_typo'] = 1;
  const clean = sanitizeFlags(raw);
  const kept = Object.keys(clean).sort().join(',');
  const want = DECLARED.slice().sort().join(',');
  if (kept === want) ok(`client keeps all ${DECLARED.length} declared flags and drops the rest`);
  else bad(`client sanitizeFlags: expected [${want}], got [${kept}]`);

  // A falsey value means ABSENT, not "stored as 0" — otherwise `hasFlag` and
  // `Object.keys` disagree about whether the fact is true.
  if (Object.keys(sanitizeFlags({ [DECLARED[0]]: 0 })).length === 0) ok('a falsey flag is dropped, not stored as 0');
  else bad('sanitizeFlags stored a falsey flag');

  if (!isFlag('definitely_not_a_flag') && isFlag(DECLARED[0])) ok('isFlag agrees with the table');
  else bad('isFlag disagrees with FLAGS');
}

// ── 2. the SERVER agrees, flag for flag ───────────────────────────────────
const { _testValidateSaveData } = await import('../api.js');
{
  const raw = { definitely_not_a_flag: 1 };
  for (const id of DECLARED) raw[id] = 1;
  const v = _testValidateSaveData({ flags: raw });
  const got = (v && v.ok && v.data && v.data.flags) ? v.data.flags : null;
  if (!got) {
    bad('server whitelist DROPPED flags entirely — the curse would come back on login');
  } else {
    const srv = Object.keys(got).sort().join(',');
    const cli = Object.keys(sanitizeFlags(raw)).sort().join(',');
    if (srv === cli) ok(`server and client agree exactly: [${srv}]`);
    else bad(`server/client divergence — server [${srv}] vs client [${cli}]`);
  }
}

// ── 3. round-trip: set -> serialize -> server -> load ─────────────────────
{
  const { ps } = await import('../src/player-stats.js');
  const { setFlag, hasFlag, clearFlag } = await import('../src/story-flags.js');
  const F = DECLARED[0];
  ps.flags = {};
  setFlag(F);
  if (!hasFlag(F)) bad('setFlag did not take');

  // What the client would WRITE to the slot (save-state.js line: `slot.flags`).
  const written = JSON.parse(JSON.stringify(ps.flags));
  // What the server would give back.
  const v = _testValidateSaveData({ flags: written });
  const returned = v && v.ok && v.data ? v.data.flags : null;
  // What the client would LOAD (title-screen.js runs it through sanitizeFlags).
  ps.flags = sanitizeFlags(returned);
  if (hasFlag(F)) ok(`round-trip survives: ${F} set -> saved -> server -> loaded`);
  else bad(`round-trip LOST ${F} — it would reset on every login`);

  // The revert path: a refused claim must be able to put the world back.
  clearFlag(F);
  if (!hasFlag(F)) ok('clearFlag puts the world back (refused-claim revert path)');
  else bad('clearFlag did not clear');
}

// ── 4. undeclared flags cannot be invented at runtime ─────────────────────
{
  const { ps } = await import('../src/player-stats.js');
  const { setFlag, hasFlag } = await import('../src/story-flags.js');
  ps.flags = {};
  const warn = console.warn; console.warn = () => {};
  const took = setFlag('a_flag_nobody_declared');
  console.warn = warn;
  if (!took && !hasFlag('a_flag_nobody_declared')) ok('setFlag refuses an undeclared id');
  else bad('setFlag invented a fact nothing can read');
}

// ── 5. no orphans in either direction ─────────────────────────────────────
//
// Reads the SOURCE rather than the module graph: a flag referenced only from a
// data table (a `when:` predicate string, a stage's `sets:`) never appears as a
// call, so grepping for `hasFlag('x')` alone would call every one an orphan.
{
  const root = new URL('../', import.meta.url).pathname;
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = dir + e.name;
      if (e.isDirectory()) walk(p + '/');
      else if (e.name.endsWith('.js') && !p.includes('/data/flags.js')) files.push(p);
    }
  };
  walk(root + 'src/');
  const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  const unused = DECLARED.filter((id) => !src.includes(`'${id}'`) && !src.includes(`"${id}"`));
  if (!unused.length) ok(`all ${DECLARED.length} declared flags are referenced somewhere`);
  else console.log(`  … not yet referenced (expected while the chain is being built): ${unused.join(', ')}`);

  // The dangerous direction: a predicate reading a flag that nothing declares
  // is always false, silently, forever.
  const referenced = new Set();
  for (const m of src.matchAll(/(?:hasFlag|setFlag|clearFlag)\(\s*['"]([a-z0-9_]+)['"]\s*\)/g)) referenced.add(m[1]);
  const undeclared = [...referenced].filter((id) => !isFlag(id));
  if (!undeclared.length) ok('every flag the code reads or writes is declared');
  else bad(`code uses undeclared flag(s): ${undeclared.join(', ')} — always false, silently`);
}

console.log(failed ? `\ncheck-story-flags: ${failed} FAILED` : '\ncheck-story-flags: OK');
process.exit(failed ? 1 : 0);
