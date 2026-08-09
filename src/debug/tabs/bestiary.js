// BESTIARY tab — every monster in the game, in color, with its stats.
//
// Sprites come from getMonsterCanvas(), the same canvas the battle screen
// draws. That is deliberate: this tab is for looking at what the game actually
// renders, so a second decode path here would be able to disagree with the
// real one and hide exactly the problem you opened the tab to find. The cost is
// that sprites only exist after initMonsterSprites() has run at boot — before
// that the tab still lists every monster and its stats, just without art.
//
// Covers all 231 entries in MONSTERS, not the 195 in MONSTER_REGISTRY, so the
// boss block (0xC3-0xE6) shows up as "no sprite" rather than silently missing.

import { MONSTERS, MONSTER_NAMES_SHRINES } from '../../data/monsters.js';
import { ITEM_NAMES_SHRINES } from '../../data/items.js';
import { getMonsterCanvas, hasMonsterSprites } from '../../monster-sprites.js';

const CARD_W = 92;      // sprite box inside a grid card
const CARD_H = 76;
const DETAIL_MAX = 240; // sprite box in the detail pane

let dom = null;
let state = null;

export async function mount(root, _context) {
  state = {
    names: new Map(),
    search: '',
    sort: 'id',
    selected: null,
  };
  await _loadNames();
  dom = _buildDOM(root);
  _renderGrid();
  _renderDetail(null);
}

export function unmount() {
  if (dom?.root) dom.root.remove();
  dom = null;
  state = null;
}

// MONSTER_NAMES_SHRINES only covers 114 of 231. Every row in monsters.js also
// carries its name as a trailing comment, so parse those for the rest — same
// source the FORMATION tab uses, kept identical so the two tabs agree.
async function _loadNames() {
  for (const [id, name] of MONSTER_NAMES_SHRINES) state.names.set(id, name);
  try {
    const res = await fetch('src/data/monsters.js');
    if (!res.ok) return;
    const text = await res.text();
    // Match per LINE, and require at least one non-space character after the
    // `//`. Some rows (0xBE among them) end in a bare `//` with no name; a
    // multiline `[^}]*` regex walks straight past that into the NEXT entry and
    // adopts its whole source line as the "name", which is how 0xBE ended up
    // captioned with a wall of stat literals.
    for (const line of text.split('\n')) {
      const m = /^\s*\[(0x[0-9a-fA-F]+),.*\],\s*\/\/\s*(\S.*?)\s*$/.exec(line);
      if (!m) continue;
      const id = parseInt(m[1], 16);
      if (!state.names.has(id)) state.names.set(id, m[2]);
    }
  } catch (e) {
    console.warn('[bestiary] name load failed', e);
  }
}

const hx = (n, w = 2) => `$${n.toString(16).toUpperCase().padStart(w, '0')}`;
const nameOf = (id) => state.names.get(id) || '(unnamed)';
const itemName = (id) => ITEM_NAMES_SHRINES.get(id) || hx(id);

/**
 * Draw a monster onto a fixed-size box at the largest whole-number zoom that
 * fits. Integer scaling only — a fractional zoom on 8x8 pixel art resamples
 * some rows and not others, which reads as the sprite being subtly malformed.
 */
function _spriteBox(monId, boxW, boxH) {
  const c = document.createElement('canvas');
  c.width = boxW; c.height = boxH;
  c.style.cssText = `width:${boxW}px;height:${boxH}px;image-rendering:pixelated;`;
  const src = getMonsterCanvas(monId, null);
  if (!src) return { canvas: c, ok: false };
  const zoom = Math.max(1, Math.floor(Math.min(boxW / src.width, boxH / src.height)));
  const w = src.width * zoom, h = src.height * zoom;
  const cctx = c.getContext('2d');
  cctx.imageSmoothingEnabled = false;
  cctx.drawImage(src, ((boxW - w) / 2) | 0, ((boxH - h) / 2) | 0, w, h);
  return { canvas: c, ok: true, zoom, srcW: src.width, srcH: src.height };
}

function _visibleIds() {
  const q = state.search.trim().toLowerCase();
  let ids = [...MONSTERS.keys()];
  if (q) {
    ids = ids.filter((id) => {
      if (nameOf(id).toLowerCase().includes(q)) return true;
      const hex = id.toString(16).padStart(2, '0');
      return hex === q.replace(/^(0x|\$)/, '') || String(id) === q;
    });
  }
  const m = (id) => MONSTERS.get(id);
  const cmp = {
    id: (a, b) => a - b,
    level: (a, b) => (m(b).level || 0) - (m(a).level || 0) || a - b,
    hp: (a, b) => (m(b).hp || 0) - (m(a).hp || 0) || a - b,
    exp: (a, b) => (m(b).exp || 0) - (m(a).exp || 0) || a - b,
  }[state.sort];
  return ids.sort(cmp);
}

function _renderGrid() {
  const ids = _visibleIds();
  dom.grid.innerHTML = '';

  let missing = 0;
  for (const id of ids) {
    const mon = MONSTERS.get(id);
    const card = document.createElement('div');
    const isSel = state.selected === id;
    card.style.cssText = `background:#141420;border:1px solid ${isSel ? '#c8a832' : '#333'};border-radius:3px;` +
      `padding:4px;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;`;

    const { canvas, ok } = _spriteBox(id, CARD_W, CARD_H);
    if (!ok) {
      missing++;
      const ph = document.createElement('div');
      ph.style.cssText = `width:${CARD_W}px;height:${CARD_H}px;display:flex;align-items:center;justify-content:center;` +
        `color:#555;font-size:9px;font-family:monospace;border:1px dashed #333;box-sizing:border-box;`;
      ph.textContent = 'no sprite';
      card.appendChild(ph);
    } else {
      card.appendChild(canvas);
    }

    const label = document.createElement('div');
    label.style.cssText = 'color:#c8a832;font-size:9px;font-family:monospace;text-align:center;line-height:1.25;';
    label.innerHTML = `${hx(id)} ${nameOf(id)}` +
      `<br><span style="color:#888">Lv${mon.level ?? '?'} HP${mon.hp ?? '?'}</span>` +
      (mon.boss ? '<br><span style="color:#c86">BOSS</span>' : '');
    card.appendChild(label);

    card.addEventListener('click', () => { state.selected = id; _renderGrid(); _renderDetail(id); });
    dom.grid.appendChild(card);
  }

  dom.count.textContent = `${ids.length} of ${MONSTERS.size} shown` +
    (missing ? ` — ${missing} without sprites` : '');
}

function _statRows(mon) {
  const rows = [];
  const push = (label, value) => { if (value !== undefined && value !== null && value !== '') rows.push([label, value]); };

  push('Level', mon.level);
  push('HP', mon.hp);
  push('Attack', mon.atk);
  push('Attack roll', mon.attackRoll);
  push('Hit rate', mon.hitRate != null ? `${mon.hitRate}%` : undefined);
  push('Defense', mon.def);
  push('Evade', mon.evade);
  push('M.Defense', mon.mdef);
  push('M.Evade', mon.mevade);
  push('Spirit/Int', mon.spiritInt);
  push('Sp.atk rate', mon.spAtkRate);
  push('EXP', mon.exp);
  push('Gil', mon.gil);
  push('CP', mon.cp);
  push('Attacks', mon.attacks?.join(', '));
  push('Resists', mon.resist);
  push('Weak to', Array.isArray(mon.weakness) ? mon.weakness.join(', ') : mon.weakness);
  push('Attack element', Array.isArray(mon.atkElem) ? mon.atkElem.join(', ') : mon.atkElem);
  push('Status resist', Array.isArray(mon.statusResist) ? mon.statusResist.join(', ') : mon.statusResist);
  push('Inflicts', Array.isArray(mon.statusAtk) ? mon.statusAtk.join(', ') : mon.statusAtk);
  push('Steal', mon.steal != null ? `${itemName(mon.steal)} (${hx(mon.steal)})` : undefined);
  push('Drops', mon.drops?.map((d) => `${itemName(d)} (${hx(d)})`).join(', '));
  push('Found in', mon.location?.join(', '));
  return rows;
}

function _renderDetail(id) {
  dom.detail.innerHTML = '';
  if (id == null) {
    dom.detail.innerHTML = '<div style="color:#666;font-size:11px;font-family:monospace;padding:10px">' +
      'Pick a monster to see its stats.</div>';
    return;
  }
  const mon = MONSTERS.get(id);

  const head = document.createElement('div');
  head.style.cssText = 'color:#c8a832;font-size:13px;font-family:monospace;margin-bottom:6px;';
  head.textContent = `${hx(id)} ${nameOf(id)}${mon.boss ? '  [BOSS]' : ''}`;
  dom.detail.appendChild(head);

  const { canvas, ok, zoom, srcW, srcH } = _spriteBox(id, DETAIL_MAX, DETAIL_MAX);
  if (ok) {
    canvas.style.cssText += 'background:#000;border:1px solid #333;';
    dom.detail.appendChild(canvas);
    const dims = document.createElement('div');
    dims.style.cssText = 'color:#666;font-size:9px;font-family:monospace;margin:2px 0 8px;';
    dims.textContent = `${srcW}x${srcH}px @ ${zoom}x`;
    dom.detail.appendChild(dims);
  } else {
    const note = document.createElement('div');
    note.style.cssText = 'color:#a66;font-size:10px;font-family:monospace;margin-bottom:8px;';
    note.textContent = hasMonsterSprites()
      ? 'No sprite: this id has no MONSTER_REGISTRY entry.'
      : 'No sprite: monster sprites are not initialized yet — boot into the game first.';
    dom.detail.appendChild(note);
  }

  const table = document.createElement('div');
  table.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:10px;font-family:monospace;';
  for (const [label, value] of _statRows(mon)) {
    const k = document.createElement('div');
    k.style.cssText = 'color:#888;white-space:nowrap;';
    k.textContent = label;
    const v = document.createElement('div');
    v.style.cssText = 'color:#e0e0e0;word-break:break-word;';
    v.textContent = String(value);
    table.append(k, v);
  }
  dom.detail.appendChild(table);
}

function _buildDOM(root) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0;gap:6px;';

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex-shrink:0;';

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'name or id (e.g. wolf, 05, $05)';
  search.style.cssText = 'flex:1;min-width:150px;padding:4px 6px;background:#1e1e2e;border:1px solid #444;' +
    'border-radius:3px;color:#e0e0e0;font-family:monospace;font-size:11px;';
  search.addEventListener('input', () => { state.search = search.value; _renderGrid(); });
  bar.appendChild(search);

  const sort = document.createElement('select');
  sort.style.cssText = 'padding:4px 6px;background:#1e1e2e;border:1px solid #444;border-radius:3px;' +
    'color:#e0e0e0;font-family:monospace;font-size:11px;';
  for (const [val, text] of [['id', 'by id'], ['level', 'by level'], ['hp', 'by HP'], ['exp', 'by EXP']]) {
    sort.appendChild(Object.assign(document.createElement('option'), { value: val, textContent: text }));
  }
  sort.addEventListener('change', () => { state.sort = sort.value; _renderGrid(); });
  bar.appendChild(sort);

  const count = document.createElement('div');
  count.style.cssText = 'color:#888;font-size:10px;font-family:monospace;';
  bar.appendChild(count);

  wrap.appendChild(bar);

  if (!hasMonsterSprites()) {
    const warn = document.createElement('div');
    warn.style.cssText = 'color:#c86;font-size:10px;font-family:monospace;flex-shrink:0;';
    warn.textContent = 'Monster sprites are not initialized — load the ROM and boot into the game to see art.';
    wrap.appendChild(warn);
  }

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;display:flex;gap:8px;min-height:0;';

  const grid = document.createElement('div');
  grid.style.cssText = `flex:1;overflow-y:auto;display:grid;` +
    `grid-template-columns:repeat(auto-fill,minmax(${CARD_W + 10}px,1fr));gap:4px;align-content:start;`;
  body.appendChild(grid);

  const detail = document.createElement('div');
  detail.style.cssText = 'width:270px;flex-shrink:0;overflow-y:auto;background:#141420;border:1px solid #333;' +
    'border-radius:3px;padding:8px;';
  body.appendChild(detail);

  wrap.appendChild(body);
  root.appendChild(wrap);
  return { root: wrap, grid, detail, count, search, sort };
}
