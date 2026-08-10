// Emit every captured spell animation for the MAGIC debug tab.
//
//   node spell-captures-debug.cjs
//
// Distinct from src/data/spell-anim-captured.js, and deliberately so. That file
// feeds the LIVE registry and only contains spells that cleared every gate. This
// one is debug-only: it carries the WHOLE capture for all 48 spells — cast halo,
// projectile and impact — including the ones tools/classify-spell-phases.js
// could not classify. Nothing imports it except the debug tab, so an unvetted
// capture can never reach the battle screen by accident.
//
// The point is adjudication: the classifier's impact rule is "static, multi-tile,
// enemy-side, under 8px of origin drift", which fits Fire and misses moving,
// expanding, screen-wide and ally-targeted effects. Rather than invent a wider
// rule, show the frames and let the user say which group is the impact.
//
// Sprite positions are SCREEN coordinates, so the tab can draw a 256x240 canvas
// that reproduces what the PPU actually showed.

const { readFileSync, writeFileSync, readdirSync } = require('fs');

const REPO = '/home/joeltco/projects/ff3mmo';
const DUMPS = process.env.DUMPS || '/tmp/spelldumps';
const PHASES = process.env.PHASES || '/tmp/spellphases';
const OUT = REPO + '/src/debug/spell-captures.json';
const NES_FRAME_MS = 1000 / 60.0988;

function parseDump(text) {
  const frames = [];
  let cur = null, group = null, pending = null;
  for (const ln of text.split('\n')) {
    let m = ln.match(/^\/\/ ═══ frame (\d+)/);
    if (m) { cur = { idx: Number(m[1]), sp: [[], [], [], []], groups: [] }; frames.push(cur); group = null; continue; }
    if (!cur) continue;
    m = ln.match(/^\/\/\s+SP([0-3]):\s*\[([^\]]+)\]/);
    if (m) { cur.sp[Number(m[1])] = m[2].split(',').map((v) => parseInt(v.trim(), 16)); continue; }
    m = ln.match(/^\/\/ ── group (\d+) \(\d+ tiles, origin (-?\d+),(-?\d+)\) ──/);
    if (m) { group = { ox: Number(m[2]), oy: Number(m[3]), tiles: [] }; cur.groups.push(group); continue; }
    if (!group) continue;
    m = ln.match(/^\/\/\s+\[(-?\d+),(-?\d+)\] tile=\$([0-9A-Fa-f]+) pal(\d)( VFLIP)?( HFLIP)?/);
    if (m) { pending = { dx: Number(m[1]), dy: Number(m[2]), pal: Number(m[4]), v: !!m[5], h: !!m[6] }; continue; }
    m = ln.match(/new Uint8Array\(\[([^\]]+)\]\)/);
    if (m && pending) {
      pending.hex = m[1].split(',').map((v) => parseInt(v.trim(), 16).toString(16).padStart(2, '0')).join('');
      group.tiles.push(pending); pending = null;
    }
  }
  return frames;
}

// One tile table shared by every spell. The cast halo is the same 16 tiles for
// all black magic (and the same again for all white), so per-spell tables would
// store it ~24 times over.
const tileTable = [];
const tileIdx = new Map();
const tileId = (hex) => {
  if (!tileIdx.has(hex)) { tileIdx.set(hex, tileTable.length); tileTable.push(hex); }
  return tileIdx.get(hex);
};

// Whole STATES are shared too, not just tiles: every black spell opens with the
// same BM cast halo, so ~24 spells carry identical opening states. Deduping the
// layouts globally is what takes this file from 808KB to something sane. Same
// for palettes, which are near-constant within a spell.
const stateTable = [];
const stateIdx = new Map();
const stateId = (spr, palRef) => {
  const key = palRef + ';' + spr.map((x) => x.join(',')).join('|');
  if (!stateIdx.has(key)) { stateIdx.set(key, stateTable.length); stateTable.push({ spr, sp: palRef }); }
  return stateIdx.get(key);
};
const palTable = [];
const palIdxMap = new Map();
const palId = (sp) => {
  const key = sp.map((row) => row.join(',')).join(';');
  if (!palIdxMap.has(key)) { palIdxMap.set(key, palTable.length); palTable.push(sp); }
  return palIdxMap.get(key);
};

const SPELL_NAMES = (() => {
  const src = readFileSync(REPO + '/src/data/spells.js', 'utf8');
  const out = {};
  for (const m of src.matchAll(/\[0x([0-9a-fA-F]{2}),\s*\{[^}]*\}\],\s*\/\/\s*(.+)/g)) out[parseInt(m[1], 16)] = m[2].trim();
  return out;
})();

const spells = {};
for (const file of readdirSync(DUMPS).sort()) {
  if (!file.endsWith('.txt')) continue;
  const id = parseInt(file.slice(0, -4), 16);
  const frames = parseDump(readFileSync(`${DUMPS}/${file}`, 'utf8'));
  let phases = null;
  try { phases = JSON.parse(readFileSync(`${PHASES}/${file.replace('.txt', '.json')}`, 'utf8')); } catch { /* optional */ }

  // Collapse consecutive frames whose whole-screen sprite set is identical.
  // The NES holds each animation state for several frames; without this a
  // capture is ~450 near-duplicate frames and unreadable in a scrubber.
  const states = [];
  for (const f of frames) {
    const spr = [];
    for (const g of f.groups) {
      for (const t of g.tiles) {
        spr.push([tileId(t.hex), g.ox + t.dx, g.oy + t.dy, t.pal, t.h ? 1 : 0, t.v ? 1 : 0]);
      }
    }
    if (!spr.length) continue;
    const key = spr.map((s) => s.join(',')).join('|');
    const last = states[states.length - 1];
    if (last && last.key === key) { last.hold++; continue; }
    states.push({ key, hold: 1, spr, sp: f.sp, srcFrame: f.idx });
  }
  if (!states.length) continue;

  spells[id] = {
    name: SPELL_NAMES[id] || '?',
    states: states.map((s) => [stateId(s.spr, palId(s.sp)), s.hold, s.srcFrame]),
    // What the classifier made of it — shown in the tab so its verdict and the
    // frames are side by side, which is the whole point of the tab.
    phases: phases ? {
      cast: phases.cast ? { frames: phases.cast.frames, origin: phases.cast.casterOrigin } : null,
      projectile: phases.projectile && phases.projectile.detectedInOam ? { frames: phases.projectile.frameRange } : null,
      impact: phases.impact ? { frames: phases.impact.frames, origin: phases.impact.origin, tiles: phases.impact.tileCount } : null,
      scorch: (phases.scorch || []).map((s) => ({ frames: s.frames, origin: s.origin, tiles: s.tileCount })),
    } : null,
  };
}

const out = { frameMs: Math.round(NES_FRAME_MS * 100) / 100, tiles: tileTable, pals: palTable, states: stateTable, spells };
writeFileSync(OUT, JSON.stringify(out));
const kb = (JSON.stringify(out).length / 1024).toFixed(0);
console.log(`${Object.keys(spells).length} spells, ${tileTable.length} unique tiles, ${stateTable.length} unique states, ${palTable.length} palettes, ${kb}KB -> ${OUT}`);
const counts = Object.entries(spells).map(([id, s]) => `$${(+id).toString(16).padStart(2, '0')}:${s.states.length}`);
console.log('states per spell: ' + counts.join(' '));
