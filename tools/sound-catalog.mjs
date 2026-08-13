#!/usr/bin/env node
// sound-catalog.mjs — pull EVERY sound out of EVERY ROM, measure it, label it.
//
// One catalogue of all 249 tracks across FF1 / FF2 / FF3: what each one is,
// whether it actually makes a sound, how long it lasts, whether it loops, and
// which part of ff3mmo (if any) uses it. Rendered through the REAL libgme — the
// same decoder the browser uses — so "this track exists" and "this track plays"
// are answered separately. Those are different questions and the second is the
// one a player hears.
//
//   node tools/sound-catalog.mjs                  # full catalogue
//   node tools/sound-catalog.mjs --game ff2       # one game
//   node tools/sound-catalog.mjs --seconds 4      # longer render window
//
// Writes docs/SOUND-CATALOG.md and tools/monscan/sound-catalog.json.
//
// Skips cleanly when a ROM or libgme is missing, so it never blocks a deploy.

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const ONLY = flag('game', null);
const SECONDS = parseFloat(flag('seconds', '4'));
const RATE = 48000;

await import('./lib/browser-shim.mjs');

// ── libgme, the real one the browser loads ───────────────────────────────
const src = fs.readFileSync(new URL('../lib/libgme.js', import.meta.url).pathname, 'utf8');
const sandbox = { console, process, setTimeout, clearTimeout, Date, Math, JSON, TextDecoder, TextEncoder };
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox, { filename: 'libgme.js' }); }
catch (e) { console.error('sound-catalog: SKIP — libgme failed to load: ' + e.message); process.exit(0); }
const Module = sandbox.Module;
if (!Module) { console.error('sound-catalog: SKIP — libgme exposed no Module'); process.exit(0); }
await (async () => {
  if (Module.calledRun) return;
  await new Promise((res) => {
    const prev = Module.onRuntimeInitialized;
    Module.onRuntimeInitialized = () => { if (prev) prev(); res(); };
    setTimeout(res, 8000);
  });
})();
if (!Module.ccall) { console.error('sound-catalog: SKIP — libgme did not initialise'); process.exit(0); }

// ── labels: what does ff3mmo use each track FOR ──────────────────────────
const { SFX, TRACKS, FF1_TRACKS, FF2_TRACKS } = await import('../src/music.js');
const { CAPTURED_SPELL_SFX } = await import('../src/data/spell-sfx-captured.js');
const { SPELL_NAMES_SHRINES: SPELL_NAMES } = await import('../src/data/spells.js');
const { MAP_SONGS } = await import('../src/data/map-songs.js');
const { FF2_SFX } = await import('../src/ff2-nsf-builder.js');

function ff3Labels(track) {
  const out = [];
  for (const [k, v] of Object.entries(TRACKS)) if (v === track) out.push('TRACKS.' + k);
  for (const [k, v] of Object.entries(SFX)) if (v === track) out.push('SFX.' + k);
  const spells = [];
  for (const [id, t] of CAPTURED_SPELL_SFX) if (t === track) spells.push(SPELL_NAMES.get(id) || ('0x' + id.toString(16).padStart(2, '0')));
  if (spells.length) out.push('spell impact: ' + spells.slice(0, 6).join(', ') + (spells.length > 6 ? ` (+${spells.length - 6})` : ''));
  const maps = [];
  for (const [m, s] of MAP_SONGS) if (s === track) maps.push(m);
  if (maps.length) out.push(`map music: ${maps.length} map${maps.length > 1 ? 's' : ''} (e.g. ${maps.slice(0, 4).join(', ')})`);
  return out;
}
function ff1Labels(track) {
  return Object.entries(FF1_TRACKS).filter(([, v]) => v === track).map(([k]) => 'FF1_TRACKS.' + k);
}
function ff2Labels(track) {
  const out = Object.entries(FF2_TRACKS).filter(([, v]) => v === track).map(([k]) => 'FF2_TRACKS.' + k);
  const sfxIdx = track - 39;
  if (sfxIdx >= 0 && sfxIdx < FF2_SFX.length) {
    const s = FF2_SFX[sfxIdx];
    out.push(`ripped blip "${s.name}" (ROM routine $${s.at.toString(16)}, ${s.dur}f)`);
  }
  return out;
}

// ── measurement ──────────────────────────────────────────────────────────
/**
 * Render a track and describe it.
 *
 * `endedAt` uses libgme's own track-ended signal, which is how a ONE-SHOT is
 * told from a LOOP — duration alone cannot, because a looping track and a long
 * jingle both fill the window. `audibleMs` is measured per 2048-sample chunk so
 * a sound that starts with a click and then goes quiet is not scored as long.
 */
function measure(nsf, track, seconds) {
  const ref = Module.allocate(1, 'i32', Module.ALLOC_STATIC);
  if (Module.ccall('gme_open_data', 'number', ['array', 'number', 'number', 'number'],
      [nsf, nsf.length, ref, RATE]) !== 0) return { err: 'open failed' };
  const emu = Module.getValue(ref, 'i32');
  if (Module.ccall('gme_start_track', 'number', ['number', 'number'], [emu, track]) !== 0) {
    Module.ccall('gme_delete', 'number', ['number'], [emu]);
    return { err: 'start failed' };
  }
  const N = 2048;
  const buf = Module._malloc(N * 2 * 2);
  const total = Math.ceil(RATE * seconds);
  let peak = 0, sumSq = 0, count = 0, audible = 0, endedAt = null, lastLoud = 0;
  // Fingerprint of the actual PCM. Peak and duration cannot tell a REAL track
  // from a pointer HOLE: FF2's $FFFF entries (ids 31/32/33/36) each render
  // something, with identical peak and length, because they all fall through to
  // the same fallback. Only comparing the samples shows they are one track
  // wearing four numbers — and that is the difference between cataloguing 39
  // songs and cataloguing 35 songs plus 4 illusions.
  let fp = 2166136261;
  for (let done = 0; done < total; done += N) {
    if (endedAt === null && Module.ccall('gme_track_ended', 'number', ['number'], [emu]) === 1) {
      endedAt = Math.round((done / RATE) * 1000);
      break;
    }
    Module.ccall('gme_play', 'number', ['number', 'number', 'number'], [emu, N * 2, buf]);
    const base = buf >> 1;
    let chunkPeak = 0;
    for (let i = 0; i < N * 2; i++) {
      const v = Module.HEAP16[base + i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      if (a > chunkPeak) chunkPeak = a;
      sumSq += v * v; count++;
    }
    for (let i = 0; i < N * 2; i += 16) { fp ^= Module.HEAP16[base + i] & 0xFFFF; fp = Math.imul(fp, 16777619); }
    if (chunkPeak > 300) { audible += (N / RATE) * 1000; lastLoud = Math.round((done / RATE) * 1000); }
  }
  Module._free(buf);
  Module.ccall('gme_delete', 'number', ['number'], [emu]);
  const rms = Math.sqrt(sumSq / Math.max(1, count));
  let kind;
  if (peak < 500) kind = 'SILENT';
  else if (endedAt !== null) kind = endedAt < 1200 ? 'one-shot SFX' : 'jingle (ends)';
  else if (lastLoud < seconds * 1000 * 0.5) kind = 'one-shot SFX';
  else kind = 'music (loops)';
  return { peak, rms: +rms.toFixed(1), audibleMs: Math.round(audible), endedAt, kind,
           fp: (fp >>> 0).toString(16) };
}

// ── games ────────────────────────────────────────────────────────────────
const { buildNSF } = await import('../src/nsf-builder.js');
const { buildFF1NSF } = await import('../src/ff1-nsf-builder.js');
const { buildFF2NSF } = await import('../src/ff2-nsf-builder.js');

const GAMES = [
  { key: 'ff3', name: 'Final Fantasy III',
    rom: process.env.FF3_ROM || new URL('../FF3-English.nes', import.meta.url).pathname,
    build: buildNSF, count: 192, labels: ff3Labels,
    note: 'Track = ROM song id for songs ($00-$40); SFX are ROM sfx id + $41. The engine requests songs at $7F43 and SFX at $7F49.' },
  { key: 'ff1', name: 'Final Fantasy I',
    rom: process.env.FF1_ROM || '/home/joeltco/roms/ff1-usa.nes',
    build: buildFF1NSF, count: 23, labels: ff1Labels,
    note: '23 tracks, 0-based into the FF1 song table.' },
  { key: 'ff2', name: 'Final Fantasy II',
    rom: process.env.FF2_ROM || '/home/joeltco/roms/ff2-jp.nes',
    build: buildFF2NSF, count: 42, labels: ff2Labels,
    note: 'Song pointer table at $9E0D, bank $0D. MEASURED: ids 0-30 are real, ' +
          'ids 31/32/33/36/39 are $FFFF HOLES (they all render the same fallback audio ' +
          '- proven by PCM fingerprint, not by peak), and ids 34/35/37/38 are REAL songs ' +
          'the builder exposed for the first time in v1.7.999 (34 renders silent; 35/37/38 ' +
          'are three genuinely new pieces of music). Tracks 39+ are the pulse-2 blips ' +
          'ripped from fixed-bank ROM routines and appended by our builder.' },
];

const catalog = [];
for (const g of GAMES) {
  if (ONLY && ONLY !== g.key) continue;
  let rom;
  try { rom = new Uint8Array(fs.readFileSync(g.rom)); }
  catch { console.error(`  ${g.key}: SKIP — no ROM at ${g.rom}`); continue; }
  const nsf = g.build(rom);
  process.stderr.write(`rendering ${g.name}: ${g.count} tracks...\n`);
  const rows = [];
  for (let t = 0; t < g.count; t++) {
    const m = measure(nsf, t, SECONDS);
    rows.push({ track: t, hex: '$' + t.toString(16).padStart(2, '0'), ...m, labels: g.labels(t) });
    if (t % 32 === 31) process.stderr.write(`  ...${t + 1}/${g.count}\n`);
  }
  // Group by fingerprint: any track sharing PCM with an earlier one is not a
  // distinct sound, whatever its number says.
  const firstSeen = new Map();
  for (const r of rows) {
    if (!r.fp || r.kind === 'SILENT') continue;
    if (firstSeen.has(r.fp)) r.duplicateOf = firstSeen.get(r.fp);
    else firstSeen.set(r.fp, r.track);
  }
  const dupes = rows.filter(r => r.duplicateOf !== undefined).length;
  const distinct = rows.filter(r => r.kind !== 'SILENT' && r.duplicateOf === undefined).length;
  catalog.push({ game: g.key, name: g.name, rom: path.basename(g.rom), note: g.note,
                 distinctSounds: distinct, duplicates: dupes, tracks: rows });
}

// ── output ───────────────────────────────────────────────────────────────
const jsonPath = new URL('./monscan/sound-catalog.json', import.meta.url).pathname;
fs.writeFileSync(jsonPath, JSON.stringify(catalog, null, 2));

let md = `# Sound catalogue — every track in every ROM

Generated by \`tools/sound-catalog.mjs\`. Every track in FF1, FF2 and FF3 is
started and rendered through the REAL \`lib/libgme.js\` — the decoder the browser
uses — then measured. "The track exists" and "the track makes a sound" are
answered separately, because they are different questions and only the second
one is what a player hears.

Columns:

- **kind** — \`music (loops)\` never signals end-of-track; \`one-shot SFX\` /
  \`jingle (ends)\` do (or fall silent early); \`SILENT\` produced no audible PCM.
- **peak / rms** — 16-bit sample amplitude over a ${SECONDS}s window.
- **audible** — milliseconds where the signal rose above the noise floor.
- **used by** — where ff3mmo references this track. Blank means the track is in
  the ROM and we do not currently use it.

`;
for (const g of catalog) {
  const used = g.tracks.filter(t => t.labels.length).length;
  const silent = g.tracks.filter(t => t.kind === 'SILENT').length;
  const music = g.tracks.filter(t => t.kind === 'music (loops)').length;
  const sfx = g.tracks.filter(t => t.kind === 'one-shot SFX' || t.kind === 'jingle (ends)').length;
  md += `\n## ${g.name} — \`${g.rom}\`\n\n${g.note}\n\n`;
  md += `**${g.tracks.length} tracks**: ${music} looping music, ${sfx} one-shot / jingle, ${silent} silent, ` +
        `${g.duplicates} duplicate. **${g.distinctSounds} distinct sounds.** ${used} referenced by ff3mmo.\n\n`;
  md += '| track | kind | peak | rms | audible | used by |\n|---|---|---|---|---|---|\n';
  for (const t of g.tracks) {
    const note = t.duplicateOf !== undefined ? `_same audio as track ${t.duplicateOf}_` : (t.labels.join('<br>') || '');
    md += `| ${t.track} (${t.hex}) | ${t.kind} | ${t.peak ?? '-'} | ${t.rms ?? '-'} | ${t.audibleMs ?? '-'}ms | ${note} |\n`;
  }
}
const mdPath = new URL('../docs/SOUND-CATALOG.md', import.meta.url).pathname;
fs.writeFileSync(mdPath, md);

console.log('\nwrote ' + mdPath);
console.log('wrote ' + jsonPath);
for (const g of catalog) {
  const silent = g.tracks.filter(t => t.kind === 'SILENT').length;
  const used = g.tracks.filter(t => t.labels.length).length;
  console.log(`  ${g.name}: ${g.tracks.length} tracks, ${silent} silent, ${used} used by ff3mmo`);
}
