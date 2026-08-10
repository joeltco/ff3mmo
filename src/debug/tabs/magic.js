// MAGIC tab — every spell's captured animation, played back frame by frame.
//
// Two things live side by side here, and the distinction is the whole point:
//
//   LIVE      the spell has a registered on-target bundle and the battle screen
//             actually draws it. Shown from getSpellAnim(), the same function
//             the battle screen calls — a second render path here could
//             disagree with the real one and hide the bug you opened the tab
//             to find (same reasoning as the BESTIARY tab's sprites).
//   CANDIDATE captured off the PPU but NOT registered, because
//             tools/classify-spell-phases.js could not identify an impact
//             phase. Its rule is "static, multi-tile, enemy-side, under 8px of
//             origin drift", which fits Fire and misses moving, expanding,
//             screen-wide and ally-targeted effects.
//
// Candidates are read from src/debug/spell-captures.json, fetched only when this
// tab opens. Nothing else imports it, so an unvetted capture cannot reach the
// battle screen by accident — which matters, because CLAUDE.md is explicit that
// guessing at spell phases is how v1.7.87/.88/.90 shipped broken.
//
// The capture is the FULL cast: caster halo, projectile, impact and whatever
// follows. Phase markers show what the classifier decided, next to the frames,
// so its verdict can be checked against what actually happened.

import { SPELLS, SPELL_NAMES_SHRINES } from '../../data/spells.js';
import { NES_SYSTEM_PALETTE } from '../../tile-decoder.js';
import { getSpellAnim, getSpellAnimFrame, initSpellAnim } from '../../spell-anim.js';

const SCREEN_W = 256;
const SCREEN_H = 240;
const CAPTURE_URL = 'src/debug/spell-captures.json';

let dom = null;
let state = null;
let timer = null;

export async function mount(root, _context) {
  state = {
    caps: null,
    names: new Map(),
    search: '',
    filter: 'all',
    selected: null,
    stateIdx: 0,
    playing: true,
    error: null,
  };
  // The battle screen builds its bundles on boot. Opening this tab from the
  // title screen would otherwise show every LIVE spell as empty — the same
  // trap the BESTIARY tab hit before it built sprites on demand.
  try { if (!getSpellAnim(0x31)) initSpellAnim(); } catch (e) { state.error = 'initSpellAnim: ' + e.message; }
  await _loadNames();
  dom = _buildDOM(root);
  _renderList();
  _renderDetail();
  await _loadCaptures();
  _renderList();
  _renderDetail();
}

export function unmount() {
  if (timer) { clearInterval(timer); timer = null; }
  if (dom?.root) dom.root.remove();
  dom = null;
  state = null;
}

/** Names: the shrines override where there is one, else the trailing comment
 *  on each row of spells.js — the same source the BESTIARY tab parses for
 *  monsters, so the two tabs cannot disagree. */
async function _loadNames() {
  for (const [id, name] of SPELL_NAMES_SHRINES) state.names.set(id, name);
  try {
    const res = await fetch('src/data/spells.js');
    if (!res.ok) return;
    for (const line of (await res.text()).split('\n')) {
      const m = line.match(/^\s*\[0x([0-9a-fA-F]{2}),\s*\{.*\}\],\s*\/\/\s*(\S.*)$/);
      if (m) {
        const id = parseInt(m[1], 16);
        if (!state.names.has(id)) state.names.set(id, m[2].trim());
      }
    }
  } catch { /* names are a nicety; ids still render */ }
}

async function _loadCaptures() {
  try {
    const res = await fetch(CAPTURE_URL);
    if (!res.ok) { state.error = `${CAPTURE_URL} → HTTP ${res.status}`; return; }
    state.caps = await res.json();
  } catch (e) {
    state.error = 'capture load failed: ' + e.message;
  }
}

// ── status per spell ──────────────────────────────────────────────
function _status(id) {
  if (getSpellAnim(id)) return 'live';
  if (state.caps && state.caps.spells[id]) return 'candidate';
  return 'none';
}
function _reason(id) {
  const cap = state.caps && state.caps.spells[id];
  if (!cap) return 'not captured — monster-only ability, or no menu path';
  if (!cap.phases) return 'captured; classifier produced no phase file';
  if (!cap.phases.impact) return 'captured; classifier found no impact phase';
  return 'captured; impact classified but not registered';
}

// ── rendering a captured state onto the NES screen ────────────────
function _drawState(ctx, stateRef) {
  ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
  ctx.fillStyle = '#101018';
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  if (!stateRef) return;
  const st = state.caps.states[stateRef];
  const pal = state.caps.pals[st.sp];
  const img = ctx.createImageData(SCREEN_W, SCREEN_H);
  // Start from the flat background so untouched pixels stay visible.
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = 0x10; img.data[i + 1] = 0x10; img.data[i + 2] = 0x18; img.data[i + 3] = 255;
  }
  for (const [tid, x, y, palIdx, hf, vf] of st.spr) {
    const hex = state.caps.tiles[tid];
    const sub = pal[palIdx] || pal[0] || [0x0f, 0x0f, 0x0f, 0x0f];
    for (let row = 0; row < 8; row++) {
      const lo = parseInt(hex.slice(row * 2, row * 2 + 2), 16);
      const hi = parseInt(hex.slice((row + 8) * 2, (row + 8) * 2 + 2), 16);
      for (let col = 0; col < 8; col++) {
        const bit = 7 - col;
        const v = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        if (!v) continue;                       // colour 0 is transparent for sprites
        const rgb = NES_SYSTEM_PALETTE[sub[v] & 0x3F] || [0, 0, 0];
        const px = x + (hf ? 7 - col : col);
        const py = y + (vf ? 7 - row : row);
        if (px < 0 || py < 0 || px >= SCREEN_W || py >= SCREEN_H) continue;
        const o = (py * SCREEN_W + px) * 4;
        img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Which phase the classifier assigned to the source frame of a state. */
function _phaseAt(cap, srcFrame) {
  const p = cap.phases;
  if (!p) return '—';
  const within = (r) => r && srcFrame >= r[0] && srcFrame <= r[1];
  const out = [];
  if (within(p.cast && p.cast.frames)) out.push('cast');
  if (within(p.projectile && p.projectile.frames)) out.push('projectile');
  if (within(p.impact && p.impact.frames)) out.push('IMPACT');
  for (const s of p.scorch || []) if (within(s.frames)) out.push('scorch');
  return out.length ? out.join(' + ') : 'unclassified';
}

// ── DOM ───────────────────────────────────────────────────────────
const BTN = 'min-width:36px;min-height:34px;padding:4px 8px;background:#252538;border:1px solid #555;' +
  'border-radius:3px;color:#e0e0e0;font-family:monospace;font-size:12px;cursor:pointer;';

function _buildDOM(root) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0;gap:6px;';

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex-shrink:0;';

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'name or id (e.g. fire, 31, $31)';
  search.style.cssText = 'flex:1;min-width:140px;padding:6px;background:#1e1e2e;border:1px solid #444;' +
    'border-radius:3px;color:#e0e0e0;font-family:monospace;font-size:12px;';
  search.addEventListener('input', () => { state.search = search.value; _renderList(); });
  bar.appendChild(search);

  const filter = document.createElement('select');
  filter.style.cssText = 'padding:6px;background:#1e1e2e;border:1px solid #444;border-radius:3px;' +
    'color:#e0e0e0;font-family:monospace;font-size:12px;min-height:34px;';
  for (const [v, t] of [['all', 'all'], ['live', 'live only'], ['candidate', 'candidates'], ['none', 'no capture']]) {
    filter.appendChild(Object.assign(document.createElement('option'), { value: v, textContent: t }));
  }
  filter.addEventListener('change', () => { state.filter = filter.value; _renderList(); });
  bar.appendChild(filter);

  const count = document.createElement('div');
  count.style.cssText = 'color:#888;font-size:10px;font-family:monospace;';
  bar.appendChild(count);
  wrap.appendChild(bar);

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;display:flex;gap:8px;min-height:0;flex-wrap:wrap;';

  const list = document.createElement('div');
  list.style.cssText = 'flex:1;min-width:190px;overflow-y:auto;background:#141420;border:1px solid #333;' +
    'border-radius:3px;';
  body.appendChild(list);

  const detail = document.createElement('div');
  detail.style.cssText = 'flex:2;min-width:270px;overflow-y:auto;background:#141420;border:1px solid #333;' +
    'border-radius:3px;padding:8px;';
  body.appendChild(detail);

  wrap.appendChild(body);
  root.appendChild(wrap);
  return { root: wrap, search, filter, count, list, detail };
}

function _matches(id) {
  const q = state.search.trim().toLowerCase().replace(/^\$/, '');
  if (q) {
    const name = (state.names.get(id) || '').toLowerCase();
    const hex = id.toString(16).padStart(2, '0');
    if (!name.includes(q) && hex !== q && String(id) !== q) return false;
  }
  return state.filter === 'all' || _status(id) === state.filter;
}

function _renderList() {
  if (!dom) return;
  dom.list.textContent = '';
  const ids = [...SPELLS.keys()].sort((a, b) => a - b).filter(_matches);
  let live = 0, cand = 0;
  for (const id of [...SPELLS.keys()]) {
    const s = _status(id);
    if (s === 'live') live++; else if (s === 'candidate') cand++;
  }
  dom.count.textContent = `${ids.length}/${SPELLS.size} shown · ${live} live · ${cand} candidates` +
    (state.error ? ` · ${state.error}` : '');

  for (const id of ids) {
    const st = _status(id);
    const row = document.createElement('div');
    const sel = state.selected === id;
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:7px 8px;min-height:34px;' +
      'font-family:monospace;font-size:11px;cursor:pointer;border-bottom:1px solid #222;' +
      (sel ? 'background:#2a2a44;' : '');
    const dot = st === 'live' ? '<span style="color:#5c5">●</span>'
      : st === 'candidate' ? '<span style="color:#cc5">○</span>'
      : '<span style="color:#555">·</span>';
    const cap = state.caps && state.caps.spells[id];
    row.innerHTML = `${dot} <span style="color:#89f">$${id.toString(16).padStart(2, '0')}</span> ` +
      `<span style="flex:1;color:#ddd">${state.names.get(id) || '?'}</span>` +
      `<span style="color:#777">${cap ? cap.states.length + ' st' : ''}</span>`;
    row.addEventListener('click', () => {
      state.selected = id; state.stateIdx = 0; state.playing = true;
      _renderList(); _renderDetail();
    });
    dom.list.appendChild(row);
  }
  if (!ids.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:10px;color:#777;font-family:monospace;font-size:11px;';
    empty.textContent = 'nothing matches';
    dom.list.appendChild(empty);
  }
}

function _renderDetail() {
  if (!dom) return;
  if (timer) { clearInterval(timer); timer = null; }
  dom.detail.textContent = '';
  const id = state.selected;
  if (id == null) {
    dom.detail.innerHTML = '<div style="color:#777;font-family:monospace;font-size:11px;">' +
      'Pick a spell.<br><br><span style="color:#5c5">●</span> live — the battle screen draws it' +
      '<br><span style="color:#cc5">○</span> candidate — captured, not registered' +
      '<br><span style="color:#555">·</span> no capture</div>';
    return;
  }
  const cap = state.caps && state.caps.spells[id];
  const st = _status(id);
  const head = document.createElement('div');
  head.style.cssText = 'font-family:monospace;font-size:12px;color:#ddd;margin-bottom:6px;';
  head.innerHTML = `<b style="color:#89f">$${id.toString(16).padStart(2, '0')}</b> ${state.names.get(id) || '?'} ` +
    `<span style="color:${st === 'live' ? '#5c5' : st === 'candidate' ? '#cc5' : '#777'}">[${st}]</span>` +
    `<div style="color:#888;font-size:10px;margin-top:3px;">${_reason(id)}</div>`;
  dom.detail.appendChild(head);

  if (!cap) return;

  const canvas = document.createElement('canvas');
  canvas.width = SCREEN_W; canvas.height = SCREEN_H;
  canvas.style.cssText = 'width:100%;max-width:512px;image-rendering:pixelated;background:#101018;' +
    'border:1px solid #333;border-radius:3px;display:block;';
  dom.detail.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const info = document.createElement('div');
  info.style.cssText = 'font-family:monospace;font-size:11px;color:#bbb;margin:6px 0;';
  dom.detail.appendChild(info);

  const ctrl = document.createElement('div');
  ctrl.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;';
  const playBtn = Object.assign(document.createElement('button'), { textContent: '❚❚' });
  playBtn.style.cssText = BTN;
  const prev = Object.assign(document.createElement('button'), { textContent: '◀' });
  prev.style.cssText = BTN;
  const next = Object.assign(document.createElement('button'), { textContent: '▶' });
  next.style.cssText = BTN;
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = '0'; slider.max = String(cap.states.length - 1); slider.value = '0';
  slider.style.cssText = 'flex:1;min-width:120px;min-height:34px;';
  ctrl.append(playBtn, prev, next, slider);
  dom.detail.appendChild(ctrl);

  const draw = () => {
    const idx = Math.max(0, Math.min(cap.states.length - 1, state.stateIdx));
    const [ref, hold, srcFrame] = cap.states[idx];
    _drawState(ctx, ref);
    slider.value = String(idx);
    const ms = Math.round(hold * (state.caps.frameMs || 16.64));
    info.innerHTML = `state <b>${idx + 1}</b>/${cap.states.length} · held ${hold}f (~${ms}ms) · ` +
      `src frame ${srcFrame}<br>phase: <b style="color:#cc5">${_phaseAt(cap, srcFrame)}</b>`;
  };
  const step = (d) => {
    state.stateIdx = (state.stateIdx + d + cap.states.length) % cap.states.length;
    draw();
  };
  const startTimer = () => {
    if (timer) clearInterval(timer);
    // One tick per NES frame; each state advances when its measured hold is up.
    let held = 0;
    timer = setInterval(() => {
      if (!state.playing || !dom) return;
      const [, hold] = cap.states[state.stateIdx];
      if (++held >= hold) { held = 0; step(1); }
    }, state.caps.frameMs || 16.64);
  };
  playBtn.addEventListener('click', () => {
    state.playing = !state.playing;
    playBtn.textContent = state.playing ? '❚❚' : '▶';
  });
  prev.addEventListener('click', () => { state.playing = false; playBtn.textContent = '▶'; step(-1); });
  next.addEventListener('click', () => { state.playing = false; playBtn.textContent = '▶'; step(1); });
  slider.addEventListener('input', () => {
    state.playing = false; playBtn.textContent = '▶';
    state.stateIdx = Number(slider.value); draw();
  });

  // Phase summary — the classifier's verdict, in full, next to the frames.
  const ph = document.createElement('div');
  ph.style.cssText = 'font-family:monospace;font-size:10px;color:#999;border-top:1px solid #333;padding-top:6px;';
  const p = cap.phases;
  ph.innerHTML = '<b style="color:#bbb">classifier</b><br>' + (p ? [
    `cast: ${p.cast ? `frames ${p.cast.frames.join('-')} @ ${p.cast.origin}` : 'none'}`,
    `projectile: ${p.projectile ? `frames ${p.projectile.frames.join('-')}` : 'none in OAM'}`,
    `impact: ${p.impact ? `frames ${p.impact.frames.join('-')} @ ${p.impact.origin}, ${p.impact.tiles} tiles` : '<span style="color:#c66">none</span>'}`,
    `scorch: ${p.scorch.length ? p.scorch.map((s) => `${s.frames.join('-')} @ ${s.origin}`).join('; ') : 'none'}`,
  ].join('<br>') : 'no phase file');
  dom.detail.appendChild(ph);

  // What the game actually draws, for spells that have a registered bundle.
  const bundle = getSpellAnim(id);
  if (bundle) {
    const liveBox = document.createElement('div');
    liveBox.style.cssText = 'margin-top:8px;border-top:1px solid #333;padding-top:6px;' +
      'font-family:monospace;font-size:10px;color:#999;';
    liveBox.innerHTML = `<b style="color:#5c5">registered bundle</b><br>kind ${bundle.kind} · ` +
      `${bundle.frames.length} frames · ${bundle.width}x${bundle.height} · ` +
      `${bundle.toggleMs || bundle.phaseDurMs}ms · anchor ${bundle.anchor}`;
    const strip = document.createElement('div');
    strip.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;';
    bundle.frames.forEach((f, i) => {
      const c = document.createElement('canvas');
      c.width = bundle.width; c.height = bundle.height;
      c.style.cssText = 'image-rendering:pixelated;background:#101018;border:1px solid #333;' +
        `height:${Math.min(72, bundle.height * 2)}px;`;
      const cx = c.getContext('2d');
      const frame = getSpellAnimFrame(bundle, i * (bundle.toggleMs || bundle.phaseDurMs || 67));
      if (frame) cx.drawImage(frame, 0, 0);
      strip.appendChild(c);
    });
    liveBox.appendChild(strip);
    dom.detail.appendChild(liveBox);
  }

  draw();
  startTimer();
}
