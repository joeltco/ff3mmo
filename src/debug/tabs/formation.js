// FORMATION tab — scroll through FF3 battle formations from ROM.
// Each formation in ROM specifies its own pal0Idx + pal1Idx + 4 monster slots.
// We render each monster with the formation's real palettes so you can see
// the same monster under every palette it appears with, and pick the right one.
// Clicking "use this palette" rewrites the in-memory MONSTER_REGISTRY entry
// and emits a paste-ready patch line to the output box.

import { NES_SYSTEM_PALETTE, decodeTile } from '../../tile-decoder.js';
import { MONSTER_REGISTRY, PALETTE_TABLE } from '../../data/monster-sprites-rom.js';

// ROM offsets — must match tools/extract-monsters.js.
// romOff(bank, addr) = bank*$2000 + 0x10 (header) + (addr - windowBase).
const MON_SET_OFF = 0x2E * 0x2000 + 0x10 + (0x8400 - 0x8000); // 0x5C410
const PAL_TABLE   = 0x2E * 0x2000 + 0x10 + (0x8C00 - 0x8000); // 0x5CC10

const FORMATION_COUNT = 256;
const SPRITE_SCALE = 2;

let ctx = null;
let rom = null;
let dom = null;
let state = null;

export async function mount(root, context) {
  ctx = context;
  const buf = ctx.getFF3Buffer();
  if (!buf) {
    root.innerHTML = '<div style="color:#f66;padding:12px">No ROM — load FF3 at the title screen first.</div>';
    return;
  }
  rom = new Uint8Array(buf);
  state = {
    mode: 'atlas', // 'atlas' | 'formation'
    formationIdx: 0,
    names: new Map(),
    overrides: new Map(),
    tilePalEdits: new Map(),
    presetIdx: new Map(), // monId → which preset is currently applied
    // Cached "some formation that contains this monster" so the atlas can pick
    // reasonable pal0Idx/pal1Idx values without running the full ROM scan each render.
    monsterPalette: new Map(),
  };
  _indexMonsterPalettes();
  await _loadNames();
  dom = _buildDOM(root);
  _setMode('atlas');
}

export function unmount() {
  if (dom?.root) dom.root.remove();
  ctx = null; rom = null; dom = null; state = null;
}

// Pull monster names from monsters.js trailing comments: `[0x05, { ... }], // Werewolf`
async function _loadNames() {
  try {
    const res = await fetch('src/data/monsters.js');
    if (!res.ok) return;
    const text = await res.text();
    const re = /\[(0x[0-9a-fA-F]+),\s*\{[^}]*\}\],\s*\/\/\s*(.+)$/gm;
    for (const m of text.matchAll(re)) {
      state.names.set(parseInt(m[1], 16), m[2].trim());
    }
  } catch (e) {
    console.warn('[formation] name load failed', e);
  }
}

function _readFormation(idx) {
  const base = MON_SET_OFF + idx * 6;
  return {
    pal0Idx: rom[base],
    pal1Idx: rom[base + 1],
    mons: [rom[base + 2], rom[base + 3], rom[base + 4], rom[base + 5]],
  };
}

// ROM palette entry is 3 bytes; color 0 is always $0F (black) and not stored.
function _readPalette(idx) {
  const off = PAL_TABLE + idx * 3;
  return [0x0F, rom[off] & 0x3F, rom[off + 1] & 0x3F, rom[off + 2] & 0x3F];
}

function _drawTile(cctx, pix, palBytes, x, y) {
  const img = cctx.createImageData(8, 8);
  for (let i = 0; i < 64; i++) {
    const ci = pix[i];
    if (ci === 0) { img.data[i * 4 + 3] = 0; continue; }
    const [r, g, b] = NES_SYSTEM_PALETTE[palBytes[ci]] || [0, 0, 0];
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  }
  cctx.putImageData(img, x, y);
}

// Returns the effective per-tile palette map for monId — the user's edits
// if any, otherwise the ROM-extracted `tilePal`, otherwise the MMO's default
// (top 2 rows = pal0, rest = pal1). The default MUST match src/monster-sprites.js
// so the FORMATION tab shows what the MMO renders, not what it would render
// under an all-pal0 assumption.
function _getTilePal(monId) {
  if (state.tilePalEdits.has(monId)) return state.tilePalEdits.get(monId);
  const entry = MONSTER_REGISTRY.get(monId);
  if (!entry) return null;
  const { cols, rows, tilePal } = entry;
  if (tilePal) return tilePal.slice(0, cols * rows);
  const out = new Array(cols * rows);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      out[ty * cols + tx] = ty < 2 ? 0 : 1;
    }
  }
  return out;
}

function _toggleTilePal(monId, tileIdx) {
  const current = _getTilePal(monId);
  if (!current) return;
  const next = current.slice();
  next[tileIdx] = next[tileIdx] ? 0 : 1;
  state.tilePalEdits.set(monId, next);
  _renderFormation();
  _renderOverrides();
}

// Build a clickable grid of per-tile canvases so the user can toggle each
// tile between pal0 and pal1. A single canvas wouldn't give us per-tile
// hit-testing cheaply; tiny-canvas-per-tile keeps it simple.
function _renderMonster(monId, pal0Bytes, pal1Bytes) {
  const entry = MONSTER_REGISTRY.get(monId);
  if (!entry) return null;
  const { raw, cols, rows } = entry;
  const tilePal = _getTilePal(monId);

  const grid = document.createElement('div');
  grid.style.cssText = `display:grid;grid-template-columns:repeat(${cols},${8 * SPRITE_SCALE}px);grid-template-rows:repeat(${rows},${8 * SPRITE_SCALE}px);gap:0;background:#000;line-height:0;`;

  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const tileIdx = ty * cols + tx;
      const pix = decodeTile(raw, tileIdx * 16);
      const usingPal1 = tilePal[tileIdx] === 1;
      const pal = usingPal1 ? pal1Bytes : pal0Bytes;

      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      // Outline shows which palette each tile is currently using — cyan=pal0, magenta=pal1.
      c.style.cssText = `width:${8 * SPRITE_SCALE}px;height:${8 * SPRITE_SCALE}px;image-rendering:pixelated;cursor:pointer;outline:1px solid ${usingPal1 ? '#c857c8' : '#4898c8'};outline-offset:-1px;`;
      c.title = `tile ${tileIdx} — click to toggle (${usingPal1 ? 'pal1→pal0' : 'pal0→pal1'})`;
      const cctx = c.getContext('2d');
      _drawTile(cctx, pix, pal, 0, 0);
      c.addEventListener('click', () => _toggleTilePal(monId, tileIdx));
      grid.appendChild(c);
    }
  }
  return grid;
}

function _palSwatch(palBytes) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:2px;';
  for (const ci of palBytes) {
    const sw = document.createElement('div');
    const [r, g, b] = NES_SYSTEM_PALETTE[ci] || [0, 0, 0];
    sw.style.cssText = `width:14px;height:14px;background:rgb(${r},${g},${b});border:1px solid #444;`;
    sw.title = `$${ci.toString(16).toUpperCase().padStart(2, '0')}`;
    wrap.appendChild(sw);
  }
  return wrap;
}

function _useOverride(monId, pal0Idx, pal1Idx, formationIdx) {
  const entry = MONSTER_REGISTRY.get(monId);
  if (!entry) return;
  // Live patch the registry so subsequent renders + the running game use it.
  entry.pal0 = pal0Idx;
  entry.pal1 = pal1Idx;
  state.overrides.set(monId, { pal0Idx, pal1Idx, formationIdx });
  _renderFormation();
  _renderOverrides();
}

function _renderOverrides() {
  // Any monster that has EITHER a palette override OR a tilePal edit goes in the dump.
  const ids = new Set([...state.overrides.keys(), ...state.tilePalEdits.keys()]);
  if (ids.size === 0) { dom.output.value = ''; return; }
  const lines = ['// paste into src/data/monster-sprites-rom.js (update MONSTER_REGISTRY entries)'];
  for (const monId of [...ids].sort((a, b) => a - b)) {
    const entry = MONSTER_REGISTRY.get(monId);
    if (!entry) continue;
    const name = state.names.get(monId) || '?';
    const ov = state.overrides.get(monId);
    const pal0 = ov ? ov.pal0Idx : entry.pal0;
    const pal1 = ov ? ov.pal1Idx : entry.pal1;
    const tilePal = state.tilePalEdits.get(monId);
    const parts = [`pal0: ${pal0}`, `pal1: ${pal1}`];
    if (tilePal) parts.push(`tilePal: [${tilePal.join(',')}]`);
    const source = ov ? ` (formation $${ov.formationIdx.toString(16).toUpperCase().padStart(2, '0')})` : '';
    lines.push(`// ${name}${source}`);
    lines.push(`[0x${monId.toString(16).padStart(2, '0')}, { ..., ${parts.join(', ')} }],`);
  }
  dom.output.value = lines.join('\n');
}

function _renderFormation() {
  const f = _readFormation(state.formationIdx);
  const pal0 = _readPalette(f.pal0Idx);
  const pal1 = _readPalette(f.pal1Idx);

  dom.formLabel.textContent = `Formation $${state.formationIdx.toString(16).toUpperCase().padStart(2, '0')} (${state.formationIdx}/${FORMATION_COUNT - 1})`;
  dom.palInfo.innerHTML = '';
  const p0Row = document.createElement('div');
  p0Row.style.cssText = 'display:flex;align-items:center;gap:6px;';
  p0Row.append(Object.assign(document.createElement('span'), { textContent: `pal0 #${f.pal0Idx}:`, style: 'color:#888;font-size:10px;font-family:monospace;min-width:60px' }));
  p0Row.append(_palSwatch(pal0));
  const p1Row = document.createElement('div');
  p1Row.style.cssText = 'display:flex;align-items:center;gap:6px;';
  p1Row.append(Object.assign(document.createElement('span'), { textContent: `pal1 #${f.pal1Idx}:`, style: 'color:#888;font-size:10px;font-family:monospace;min-width:60px' }));
  p1Row.append(_palSwatch(pal1));
  dom.palInfo.append(p0Row, p1Row);

  dom.slots.innerHTML = '';
  dom.slots.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
  for (let slot = 0; slot < 4; slot++) {
    const monId = f.mons[slot];
    const cell = document.createElement('div');
    cell.style.cssText = 'flex:1;min-width:120px;background:#141420;border:1px solid #333;border-radius:3px;padding:8px;display:flex;flex-direction:column;gap:6px;align-items:center;';
    if (monId === 0xFF) {
      cell.innerHTML = '<div style="color:#555;font-size:10px;font-family:monospace">— empty —</div>';
      dom.slots.appendChild(cell);
      continue;
    }
    const name = state.names.get(monId) || '?';
    const header = document.createElement('div');
    header.style.cssText = 'color:#c8a832;font-size:11px;font-family:monospace;text-align:center;';
    header.innerHTML = `$${monId.toString(16).toUpperCase().padStart(2, '0')} <b>${name}</b>`;
    cell.appendChild(header);

    const sprite = _renderMonster(monId, pal0, pal1);
    if (sprite) cell.appendChild(sprite);
    else cell.appendChild(Object.assign(document.createElement('div'), { textContent: 'no sprite data', style: 'color:#666;font-size:10px;font-family:monospace' }));

    const override = state.overrides.get(monId);
    const current = MONSTER_REGISTRY.get(monId);
    if (current) {
      const info = document.createElement('div');
      info.style.cssText = 'color:#888;font-size:9px;font-family:monospace;text-align:center;';
      const tag = override ? `overridden → pal0 #${current.pal0} pal1 #${current.pal1}` : `current: pal0 #${current.pal0} pal1 #${current.pal1}`;
      info.textContent = tag;
      cell.appendChild(info);
    }

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;justify-content:center;';
    const btn = document.createElement('button');
    btn.textContent = `use this palette`;
    btn.style.cssText = 'padding:4px 8px;background:#1e1e2e;border:1px solid #c8a832;border-radius:3px;color:#c8a832;font-family:monospace;font-size:10px;cursor:pointer;';
    btn.addEventListener('click', () => _useOverride(monId, f.pal0Idx, f.pal1Idx, state.formationIdx));
    btnRow.appendChild(btn);
    if (state.tilePalEdits.has(monId)) {
      const reset = document.createElement('button');
      reset.textContent = 'reset tiles';
      reset.style.cssText = 'padding:4px 8px;background:#1e1e2e;border:1px solid #666;border-radius:3px;color:#aaa;font-family:monospace;font-size:10px;cursor:pointer;';
      reset.addEventListener('click', () => {
        state.tilePalEdits.delete(monId);
        _renderFormation();
        _renderOverrides();
      });
      btnRow.appendChild(reset);
    }
    cell.appendChild(btnRow);

    dom.slots.appendChild(cell);
  }
}

// ── tilePal presets ─────────────────────────────────────────────────────────
// `default` = the current MMO fallback (top 2 rows pal0, rest pal1). Cycling
// goes: default → all-p0 → all-p1 → top-1 → top-3 → bot-half → border.
// A user picking a preset means "paste this as the tilePal" — explicit.
const PRESETS = [
  { name: 'default',   fn: (c, r) => _gen(c, r, (x, y) => y < 2 ? 0 : 1) },
  { name: 'all-p0',    fn: (c, r) => _gen(c, r, () => 0) },
  { name: 'all-p1',    fn: (c, r) => _gen(c, r, () => 1) },
  { name: 'top-1-p0',  fn: (c, r) => _gen(c, r, (x, y) => y < 1 ? 0 : 1) },
  { name: 'top-3-p0',  fn: (c, r) => _gen(c, r, (x, y) => y < 3 ? 0 : 1) },
  { name: 'bot-p0',    fn: (c, r) => _gen(c, r, (x, y) => y < Math.ceil(r / 2) ? 1 : 0) },
  { name: 'border-p0', fn: (c, r) => _gen(c, r, (x, y) => (x === 0 || y === 0 || x === c - 1 || y === r - 1) ? 0 : 1) },
];

function _gen(cols, rows, fn) {
  const out = new Array(cols * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) out[y * cols + x] = fn(x, y);
  return out;
}

function _cyclePreset(monId) {
  const entry = MONSTER_REGISTRY.get(monId);
  if (!entry) return;
  const cur = state.presetIdx.get(monId) ?? 0;
  const nextIdx = (cur + 1) % PRESETS.length;
  const preset = PRESETS[nextIdx];
  state.presetIdx.set(monId, nextIdx);
  if (nextIdx === 0) {
    // Going back to "default" means "no override" — drop the edit.
    state.tilePalEdits.delete(monId);
  } else {
    state.tilePalEdits.set(monId, preset.fn(entry.cols, entry.rows));
  }
  _renderCurrent();
  _renderOverrides();
}

// Scan formations once and note one (pal0Idx, pal1Idx) pair for each monster ID —
// used by the atlas to render every monster with some valid palette even outside
// the formation-scrolling view.
function _indexMonsterPalettes() {
  for (let i = 0; i < FORMATION_COUNT; i++) {
    const f = _readFormation(i);
    for (const monId of f.mons) {
      if (monId === 0xFF) continue;
      if (!state.monsterPalette.has(monId)) {
        state.monsterPalette.set(monId, { pal0Idx: f.pal0Idx, pal1Idx: f.pal1Idx });
      }
    }
  }
}

function _renderAtlas() {
  dom.palInfo.innerHTML = '';
  dom.slots.innerHTML = '';
  dom.slots.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:4px;';

  const ids = Array.from(MONSTER_REGISTRY.keys()).sort((a, b) => a - b);
  for (const monId of ids) {
    const entry = MONSTER_REGISTRY.get(monId);
    const palInfo = state.monsterPalette.get(monId);
    if (!entry || !palInfo) continue;
    const pal0 = _readPalette(palInfo.pal0Idx);
    const pal1 = _readPalette(palInfo.pal1Idx);

    const cell = document.createElement('div');
    cell.style.cssText = 'background:#141420;border:1px solid #333;border-radius:3px;padding:4px;display:flex;flex-direction:column;gap:2px;align-items:center;cursor:pointer;';
    cell.title = 'click to cycle through tilePal presets';

    const sprite = _renderMonster(monId, pal0, pal1);
    if (sprite) cell.appendChild(sprite);

    const name = state.names.get(monId) || '?';
    const header = document.createElement('div');
    header.style.cssText = 'color:#c8a832;font-size:9px;font-family:monospace;text-align:center;line-height:1.2;';
    const presetName = PRESETS[state.presetIdx.get(monId) ?? 0].name;
    header.innerHTML = `$${monId.toString(16).toUpperCase().padStart(2, '0')} ${name}<br><span style="color:#888">${presetName}</span>`;
    cell.appendChild(header);

    cell.addEventListener('click', () => _cyclePreset(monId));
    dom.slots.appendChild(cell);
  }
}

function _renderCurrent() {
  if (state.mode === 'atlas') _renderAtlas();
  else _renderFormation();
}

function _setMode(mode) {
  state.mode = mode;
  dom.btnAtlas.style.borderColor = mode === 'atlas' ? '#c8a832' : '#444';
  dom.btnForm.style.borderColor = mode === 'formation' ? '#c8a832' : '#444';
  dom.formationControls.style.display = mode === 'formation' ? '' : 'none';
  dom.legend.textContent = mode === 'atlas'
    ? 'Click a monster to cycle presets: default → all-p0 → all-p1 → top-1-p0 → top-3-p0 → bot-p0 → border-p0.'
    : 'Click a tile to toggle pal0↔pal1.';
  _renderCurrent();
}

function _go(delta) {
  state.formationIdx = (state.formationIdx + delta + FORMATION_COUNT) % FORMATION_COUNT;
  _renderFormation();
}

function _goto(n) {
  if (!Number.isFinite(n) || n < 0 || n >= FORMATION_COUNT) return;
  state.formationIdx = n;
  _renderFormation();
}

// Scan all formations and jump to the next one that contains `monId`.
function _findNext(monId, delta) {
  for (let step = 1; step <= FORMATION_COUNT; step++) {
    const idx = (state.formationIdx + delta * step + FORMATION_COUNT) % FORMATION_COUNT;
    const f = _readFormation(idx);
    if (f.mons.includes(monId)) { state.formationIdx = idx; _renderFormation(); return; }
  }
}

function _buildDOM(parent) {
  const root = document.createElement('div');
  root.style.cssText = 'display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;overflow:auto;padding:6px;';

  // Mode switcher + formation nav.
  const nav = document.createElement('div');
  nav.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';

  const mkBtn = (label, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:6px 10px;background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#c8a832;font-family:monospace;font-size:11px;cursor:pointer;';
    b.addEventListener('click', onClick);
    return b;
  };
  const btnAtlas = mkBtn('ATLAS', () => _setMode('atlas'));
  const btnForm = mkBtn('FORMATION', () => _setMode('formation'));
  nav.append(btnAtlas, btnForm);

  // Formation-only controls (hidden in atlas mode).
  const formationControls = document.createElement('div');
  formationControls.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';
  const prev = mkBtn('◀', () => _go(-1));
  const next = mkBtn('▶', () => _go(1));

  const formLabel = document.createElement('div');
  formLabel.style.cssText = 'color:#c8a832;font-size:12px;font-family:monospace;min-width:200px;';

  const jumpInput = document.createElement('input');
  jumpInput.placeholder = 'idx or $hex';
  jumpInput.style.cssText = 'width:90px;background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#e0e0e0;font-family:monospace;font-size:11px;padding:4px 6px;';
  jumpInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = jumpInput.value.trim();
    const n = v.startsWith('$') ? parseInt(v.slice(1), 16) : parseInt(v, v.startsWith('0x') ? 16 : 10);
    _goto(n);
  });

  const findInput = document.createElement('input');
  findInput.placeholder = 'find monster $id';
  findInput.style.cssText = 'width:110px;background:#1e1e2e;border:1px solid #444;border-radius:3px;color:#e0e0e0;font-family:monospace;font-size:11px;padding:4px 6px;';
  const findNext = mkBtn('find ▶', () => {
    const v = findInput.value.trim();
    const id = v.startsWith('$') ? parseInt(v.slice(1), 16) : parseInt(v, v.startsWith('0x') ? 16 : 10);
    if (Number.isFinite(id)) _findNext(id, 1);
  });
  const findPrev = mkBtn('◀ find', () => {
    const v = findInput.value.trim();
    const id = v.startsWith('$') ? parseInt(v.slice(1), 16) : parseInt(v, v.startsWith('0x') ? 16 : 10);
    if (Number.isFinite(id)) _findNext(id, -1);
  });

  formationControls.append(prev, formLabel, next, jumpInput, findPrev, findInput, findNext);
  nav.appendChild(formationControls);
  root.appendChild(nav);

  const palInfo = document.createElement('div');
  palInfo.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding:4px 0;';
  root.appendChild(palInfo);

  const slots = document.createElement('div');
  slots.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
  root.appendChild(slots);

  const legend = document.createElement('div');
  legend.style.cssText = 'color:#888;font-size:10px;font-family:monospace;';
  root.appendChild(legend);

  const outputLabel = document.createElement('div');
  outputLabel.style.cssText = 'color:#888;font-size:10px;font-family:monospace;margin-top:8px;';
  outputLabel.textContent = 'Overrides (paste into monster-sprites-rom.js):';
  root.appendChild(outputLabel);

  const output = document.createElement('textarea');
  output.readOnly = true;
  output.style.cssText = 'min-height:120px;background:#0f0f18;color:#ccc;font-family:monospace;font-size:10px;border:1px solid #333;border-radius:3px;padding:6px;resize:vertical;';
  root.appendChild(output);

  parent.appendChild(root);
  return { root, formLabel, palInfo, slots, output, btnAtlas, btnForm, formationControls, legend };
}
