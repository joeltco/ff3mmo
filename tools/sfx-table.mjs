#!/usr/bin/env node
// sfx-table.mjs — every sound the game can play, labelled, with provenance.
//
// "Pull them all and label them." Three catalogues in one place:
//   1. spells  — what each castable spell's impact resolves to, THROUGH the
//                real rule table (getSpellImpactSFX), never re-derived here.
//   2. world   — the named SFX constants and where each is used.
//   3. music   — the track constants and their call sites.
//
// Provenance is printed per row, because a picked sound wearing a capture's
// citation is the specific failure this project keeps repeating
// (docs/SWEEP-DISCIPLINE.md).
//
//   node tools/sfx-table.mjs             # everything
//   node tools/sfx-table.mjs --spells    # just the spell impacts
//   node tools/sfx-table.mjs --dupes     # only rows sharing a sound
//
// READ THE DUPES. v1.7.847 shipped Meteo and Fire on the same number and the
// sweep table printed them on adjacent rows with nobody looking.

const args = process.argv.slice(2);
const only = (n) => args.includes('--' + n);
const ALL = !only('spells') && !only('world') && !only('music') && !only('dupes');

await import('./lib/browser-shim.mjs');   // must precede every ../src import

const { SPELLS, SPELL_NAMES_SHRINES: SPELL_NAMES } = await import('../src/data/spells.js');
const { SPELL_SFX_RULES, getSpellImpactSFX, spellSfxRule } = await import('../src/combatant-cast.js');
const { SFX, TRACKS, FF1_TRACKS, FF2_TRACKS } = await import('../src/music.js');
const { FF2_SFX } = await import('../src/ff2-nsf-builder.js');

// Reverse map: NSF track number -> the SFX constant name(s) that use it.
const SFX_NAME = new Map();
for (const [k, v] of Object.entries(SFX)) {
  if (!SFX_NAME.has(v)) SFX_NAME.set(v, []);
  SFX_NAME.get(v).push(k);
}
const label = (n) => (n == null ? '(silent)' : (SFX_NAME.get(n) || []).join('/') || '—');

const rows = [];
for (const [id, spell] of SPELLS) {
  const rule = spellSfxRule(spell);
  const sfx = getSpellImpactSFX(spell);
  rows.push({
    id,
    name: SPELL_NAMES.get(id) || '?',
    type: spell.type || '',
    element: Array.isArray(spell.element) ? spell.element.join('+') : (spell.element || ''),
    target: spell.target || '',
    sfx,
    sfxName: label(sfx),
    rule: rule ? rule.id : '(none)',
    src: rule ? rule.src : '',
    ref: rule ? (rule.ref || '') : '',
  });
}

function printSpells() {
  console.log('\n══ SPELL IMPACT SFX ' + '═'.repeat(60));
  console.log('id    name        type      element     sfx  constant           rule              src');
  console.log('----  ----------  --------  ----------  ---  -----------------  ----------------  --------');
  for (const r of rows) {
    console.log(
      ('0x' + r.id.toString(16).padStart(2, '0')).padEnd(6) +
      r.name.padEnd(12) +
      r.type.padEnd(10) +
      r.element.padEnd(12) +
      String(r.sfx == null ? '-' : r.sfx).padStart(3) + '  ' +
      r.sfxName.padEnd(19) +
      r.rule.padEnd(18) +
      r.src);
  }
  const captured = rows.filter(r => r.src === 'captured').length;
  const picked = rows.filter(r => r.src === 'picked').length;
  console.log(`\n${rows.length} castable spells: ${captured} captured, ${picked} picked, ` +
    `${rows.length - captured - picked} unresolved`);
}

function printDupes() {
  console.log('\n══ SPELLS SHARING A SOUND ' + '═'.repeat(54));
  const by = new Map();
  for (const r of rows) {
    if (r.sfx == null) continue;
    if (!by.has(r.sfx)) by.set(r.sfx, []);
    by.get(r.sfx).push(r);
  }
  const shared = [...by.entries()].filter(([, v]) => v.length > 1)
    .sort((a, b) => b[1].length - a[1].length);
  if (!shared.length) { console.log('none'); return; }
  for (const [sfx, list] of shared) {
    console.log('\n  track ' + sfx + '  ' + label(sfx) + '   ×' + list.length);
    for (const r of list) {
      console.log('    0x' + r.id.toString(16).padStart(2, '0') + '  ' +
        r.name.padEnd(12) + r.element.padEnd(12) + r.src + (r.ref ? '  ' + r.ref : ''));
    }
  }
  console.log('\nSharing is not automatically wrong — Fire/Fire2/Fire3 SHOULD share.');
  console.log('It is wrong when spells with nothing in common sit on one number.');
}

function printWorld() {
  console.log('\n══ WORLD / UI SFX CONSTANTS ' + '═'.repeat(52));
  console.log('constant           track  hex    provenance');
  console.log('-----------------  -----  -----  ------------------------------');
  for (const [k, v] of Object.entries(SFX)) {
    console.log(k.padEnd(19) + String(v).padStart(5) + '  $' +
      v.toString(16).padStart(2, '0').padEnd(5) + '  (see src/music.js note)');
  }
  console.log('\n══ FF2 RIPPED BLIPS ' + '═'.repeat(60));
  for (const s of FF2_SFX) {
    console.log('  ' + s.name.padEnd(14) + ' $' + s.at.toString(16) +
      '  regs ' + s.r.map(x => '$' + x.toString(16).padStart(2, '0')).join(' ') +
      '  ' + s.dur + 'f');
  }
}

function printMusic() {
  console.log('\n══ MUSIC TRACK CONSTANTS ' + '═'.repeat(55));
  for (const [k, v] of Object.entries(TRACKS)) {
    console.log('  FF3  ' + k.padEnd(16) + String(v).padStart(4) + '  $' + v.toString(16).padStart(2, '0'));
  }
  for (const [k, v] of Object.entries(FF1_TRACKS)) console.log('  FF1  ' + k.padEnd(16) + String(v).padStart(4));
  for (const [k, v] of Object.entries(FF2_TRACKS)) console.log('  FF2  ' + k.padEnd(16) + String(v).padStart(4));
}

if (ALL || only('spells')) printSpells();
if (ALL || only('dupes')) printDupes();
if (ALL || only('world')) printWorld();
if (ALL || only('music')) printMusic();
